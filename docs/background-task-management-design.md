# 后台进程管理设计方案

## 背景

Tinker 的 `Bash` 工具已经使用 `ShellTaskManager` 统一启动命令，并把 stdout、
stderr 持久化到 `.tinker/bash/<taskId>.log`。前台命令超过等待时间后也会保留为
后台任务，因此现有实现已经具备后台执行的基础。

当前缺少的是稳定的后续管理闭环：模型无法直接列出任务、查询任务最新状态或终止
任务；TUI 只能显示 Bash 首次返回的状态，后台进程稍后退出时不会自动更新；Tinker
正常退出时也没有等待并清理仍在运行的子进程。

本文只实现当前 session 内的后台进程管理，不提前引入 Esc 取消、session 恢复或
compaction。

## 目标

- 列出当前 session 中进入过后台的 Bash 任务及其最新状态。
- 按 task ID 获取最新输出摘要和完整输出文件路径。
- 按 task ID 可靠终止任务及其子孙进程。
- 后台任务自然退出后及时更新状态，不残留虚假的 `running`。
- TUI 持续展示任务 ID、命令摘要、状态、启动时间和退出结果。
- Tinker 正常退出时停止仍在运行的任务，并等待输出完成刷新。
- 为阶段二的前台 Bash 取消复用同一套进程终止原语。

## 非目标

- 不让后台进程脱离 Tinker 独立存活。
- 不在 Tinker 重启后恢复或重新接管历史 OS 进程。
- 不从已有 `.tinker/bash/*.log` 反向重建任务列表。
- 不增加后台任务的硬生命周期上限。
- 不实现实时日志流、日志订阅或 PTY 交互。
- 不增加 `/tasks`、`/task stop` 等 slash command。
- 不在本阶段给普通工具或模型请求接入 `AbortSignal`。
- 不实现 Windows 进程树终止兼容层；当前 Bash runtime 继续以 POSIX 为前提。

## 当前实现基线

现有实现可以继续复用的部分：

- `src/tools/bash-task.ts` 中的 `ShellTaskManager`、`ShellTask` 和任务状态。
- `src/tools/task-output.ts` 中的增量输出计数和行级 preview。
- `.tinker/bash/<taskId>.log` 输出文件。
- `BashRawResult` 中的 task ID、状态、输出路径和输出摘要。
- `ObservationBuilder`、JSONL event log 和 TUI event stream。
- `BashResultView` 对命令和尾部输出的展示。

当前需要修正的边界：

1. `ShellTaskManager.tasks` 是公开 `Map`，外层可以直接访问 `ChildProcess`，绕过
   manager 的生命周期约束。
2. manager 只有 `start()`，没有 list、inspect、stop 和 shutdown。
3. 所有 Bash 都会创建 task，但 task 没有记录是否真正进入后台。
4. 状态只在 `close` 事件后更新；进程已经退出、stdio 尚未完全关闭时仍可能短暂显示
   `running`。
5. 后台完成没有独立事件，因此 TUI 在 agent 空闲时不会刷新。
6. TUI `/quit` 当前直接调用 `process.exit(0)`，没有等待任务清理。

## 总体设计

`ShellTaskManager` 升级为 session 级进程主管，成为任务状态和进程控制的唯一事实
来源。三个新工具、TUI 和 runner 都只通过 manager 的公开方法工作。

```text
Bash
  ├─ start()
  └─ markBackgrounded(requested | foreground_timeout)
              │
              ▼
       ShellTaskManager
       ├─ listBackgroundTasks()
       ├─ inspectTask()
       ├─ stopTask()
       ├─ shutdown()
       └─ lifecycle events
          │
          ├─ TaskList / TaskOutput / TaskStop
          ├─ JSONL event log
          └─ TUI BackgroundTasks panel
```

核心约束：

- 只有 `ShellTaskManager` 持有和操作 `ChildProcess`。
- 工具、事件和 TUI 只接收可序列化的 task snapshot。
- TaskStop 与 Tinker 退出清理走同一个进程终止实现。
- 任务状态先落到 manager，再发送事件；TUI 不自行推断进程状态。
- 任务 output 和 completion 在 manager 内统一收尾，不由工具重复处理。

## 任务模型

### 内部记录与公共快照分离

当前 `ShellTask` 同时承担 runtime 内部记录和外部状态对象两个角色。第一版把它拆成：

- `ManagedShellTask`：仅 manager 内部可见，包含 process、output 和 completion。
- `ShellTaskSnapshot`：工具、事件和 TUI 使用的纯数据对象。

建议公共类型：

```ts
export type ShellTaskStatus =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "killed";

export type BackgroundReason = "requested" | "foreground_timeout";

export type ShellTaskSnapshot = {
  taskId: string;
  runId: string;
  command: string;
  description: string;
  status: ShellTaskStatus;
  startedAt: string;
  endedAt?: string;
  backgroundedAt?: string;
  backgroundReason?: BackgroundReason;
  cwd: string;
  outputFilePath: string;
  outputBytes: number;
  outputLines: number;
  exitCode?: number;
  signal?: string;
  error?: string;
};
```

内部 `ManagedShellTask` 在这些字段之外保留：

```ts
type ManagedShellTask = {
  // ShellTaskSnapshot 对应的可变状态
  process: ChildProcessWithoutNullStreams;
  processGroupId: number;
  output: TaskOutput;
  cwdFilePath: string;
  completion: Promise<ShellTaskSnapshot>;
  terminalEventEmitted: boolean;
};
```

外部代码不再获得 `tasks` Map。需要测试内部状态时，也通过 manager 的公开查询方法
验证，不直接修改记录。

### 后台任务标记

每个 Bash 仍然创建一个 task，但只有设置过 `backgroundedAt` 的 task 才属于
TaskList 和 TUI 面板中的“后台任务”。

标记时机：

- `run_in_background: true`：调用
  `markBackgrounded(taskId, "requested")`。
- 前台等待超时：调用
  `markBackgrounded(taskId, "foreground_timeout")`。
- 在 timeout 内完成的前台命令：不标记。

如果一个极短命令在标记前已经退出，仍然允许把它标记为后台任务。此时
`bash.task.backgrounded` 事件直接携带 terminal snapshot，TUI 不会先错误显示为
`running`。

### 状态机

```text
start
  -> running
      -> completed   exit code 0
      -> failed      非零退出、spawn 失败或任务管理失败
      -> stopping    TaskStop 或 shutdown
          -> killed  被 SIGTERM 或 SIGKILL 终止
          -> completed / failed  停止竞争期间自然退出
```

状态语义：

- `running`：进程仍存活，可以调用 TaskStop。
- `stopping`：已经发起终止，正在等待退出或准备升级 SIGKILL。
- `completed`：进程自然退出，exit code 为 0。
- `failed`：进程自然非零退出，或任务启动、输出收尾发生错误。
- `killed`：进程因 manager 发出的信号退出。

`stopping` 是必要的中间状态。它避免 TaskStop 等待期间仍显示 `running`，也可以阻止
对同一任务重复发起多次停止。

### `exit` 与 `close` 分工

进程状态在 `exit` 事件到达时更新：

- 记录 `exitCode` 或 `signal`。
- 设置 `endedAt`。
- 从 `running` / `stopping` 转为最终状态。

任务的 `completion` 在 `close` 事件后才 resolve：

- stdout/stderr 已经关闭。
- `TaskOutput.end()` 已经完成。
- `.cwd` 临时文件已经读取和清理。
- 最终 lifecycle event 已经提交。

这样 TaskList 不会把已经退出的进程继续显示为 `running`，TaskStop 返回时又能保证
最终日志已经 flush。Node 对 `exit` 和 `close` 的语义区分见
[Child Process 文档](https://nodejs.org/api/child_process.html#event-exit)。

manager 在创建 completion 后必须立即持有并处理 rejection。后台任务没有直接 await
调用方，不能留下未处理的 Promise rejection；任务管理错误应转成 `failed` 状态和
明确的 `error`。

## ShellTaskManager API

建议公开方法：

```ts
class ShellTaskManager {
  start(input: StartShellTaskInput): Promise<ShellTaskHandle>;

  markBackgrounded(
    taskId: string,
    reason: BackgroundReason,
  ): Promise<ShellTaskSnapshot>;

  listBackgroundTasks(): ShellTaskSnapshot[];

  inspectTask(taskId: string): TaskInspection | undefined;

  stopTask(
    taskId: string,
    reason: "tool" | "shutdown" | "turn_cancelled",
  ): Promise<StopTaskResult>;

  shutdown(reason: "tui_exit" | "oneshot_complete"): Promise<ShutdownResult>;
}
```

说明：

- `ShellTaskHandle` 只供 Bash executor 在启动后的本次调用中等待 completion，不暴露
  manager 的任务表。
- `inspectTask()` 返回 snapshot 和 output snapshot，不返回 process。
- `listBackgroundTasks()` 按 `startedAt` 倒序，保留 session 内已结束的后台任务。
- `stopTask()` 的 reason 暂不展示给模型，但为阶段二复用取消路径保留明确来源。
- `shutdown()` 关闭 manager 后，后续 `start()` 必须 fast-fail。

## Tool 设计

### TaskList

模型可见 schema：

```ts
{
  name: "TaskList",
  description: "List background shell tasks in the current session.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {}
  }
}
```

raw result：

```ts
export type TaskListRawResult = {
  ok: true;
  runningCount: number;
  tasks: ShellTaskSnapshot[];
};
```

行为：

- 只返回设置过 `backgroundedAt` 的任务。
- 同时返回运行中和已结束的任务。
- session 内不做自动淘汰。
- 没有任务时返回空数组，不视为错误。

模型 observation 示例：

```text
Background tasks: 2 total, 1 running.

taskId=019...
description=Start development server
status=running
startedAt=2026-07-10T...
outputFilePath=/workspace/.tinker/bash/019....log

taskId=019...
description=Run file watcher
status=killed
startedAt=2026-07-10T...
endedAt=2026-07-10T...
signal=SIGTERM
outputFilePath=/workspace/.tinker/bash/019....log
```

### TaskOutput

模型可见 schema：

```ts
{
  name: "TaskOutput",
  description: "Get the current status and latest output of a shell task.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: {
        type: "string",
        description: "The task ID returned by Bash or TaskList."
      }
    },
    required: ["task_id"]
  }
}
```

raw result：

```ts
export type TaskOutputRawResult = {
  ok: boolean;
  taskId: string;
  task?: ShellTaskSnapshot;
  outputBytes?: number;
  outputLines?: number;
  preview?: string;
  truncated?: boolean;
  omittedLines?: number;
  outputFilePath?: string;
  error?: string;
};
```

行为：

- 参数不是对象、`task_id` 为空或不是字符串时立即失败。
- task ID 不存在时失败，并在错误中包含收到的 ID。
- 运行中任务读取 `TaskOutput.snapshot()`，不等待任务完成。
- 已结束任务返回最终 snapshot。
- 第一版不增加 `block` 和 `timeout`，避免把 TaskOutput 变成另一种前台等待工具。

输出继续复用现有行级 preview：

- `<= 200` 行时返回完整已捕获输出。
- `> 200` 行时返回前 100 行、省略标记和最后 100 行。
- 完整输出始终通过 `outputFilePath` 暴露，模型可以继续使用 `Read` 分页读取。

模型 observation 示例：

```text
Task output retrieved.
taskId=019...
status=running
outputFilePath=/workspace/.tinker/bash/019....log
outputBytes=1250
outputLines=32
truncated=false
preview:
Server listening on http://localhost:3000
```

### TaskStop

模型可见 schema：

```ts
{
  name: "TaskStop",
  description: "Stop a running background shell task.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: {
        type: "string",
        description: "The running task ID to stop."
      }
    },
    required: ["task_id"]
  }
}
```

raw result：

```ts
export type TaskStopRawResult = {
  ok: boolean;
  taskId: string;
  task?: ShellTaskSnapshot;
  requestedSignal?: "SIGTERM";
  escalated?: boolean;
  error?: string;
};
```

行为：

- task ID 不存在时失败。
- 调用开始时任务已经是 terminal 状态时 fast-fail，并指出实际状态。
- `running` 立即转为 `stopping`。
- 先发送 SIGTERM，等待 grace period。
- grace period 内没有完成时发送 SIGKILL，并设置 `escalated=true`。
- 返回前等待 task completion，保证最终状态和输出已经确定。
- 如果发起 stop 后任务先自然退出，保留真实 completed/failed 结果，不强制覆盖为
  killed。

生产默认 grace period 建议为 2 秒。该值作为 `ShellTaskManagerOptions` 注入，测试中
使用 50ms 左右的短值，不新增面向用户的环境变量。

模型 observation 示例：

```text
Task stopped.
taskId=019...
status=killed
signal=SIGTERM
escalated=false
endedAt=2026-07-10T...
outputFilePath=/workspace/.tinker/bash/019....log
```

## 进程树终止

### 为什么不能只调用 `child.kill()`

Bash 通常只是外层进程：

```text
bash -lc wrapper
  -> bun / npm / node
      -> dev server / watcher child
```

只给 bash PID 发信号可能留下子孙进程。Node 官方文档也明确指出，终止 shell
父进程不保证其子进程一并结束。见
[subprocess.kill](https://nodejs.org/api/child_process.html#subprocesskillsignal)。

### POSIX 进程组方案

spawn 时增加：

```ts
const child = spawn("bash", ["-lc", bashWrapperScript], {
  cwd,
  env,
  detached: true,
});
```

在非 Windows 平台，`detached: true` 会让子进程成为新的 process group 和 session
leader。manager 记录 `processGroupId = child.pid`，终止时对负 PID 发信号：

```ts
process.kill(-processGroupId, "SIGTERM");
```

超时后：

```ts
process.kill(-processGroupId, "SIGKILL");
```

不调用 `child.unref()`。Tinker 必须继续持有自己创建的任务，并在正常退出时显式
停止它们。

当前开发环境 macOS、Bun 1.3.12 已用运行探针验证：`detached: true` 配合负 PID
SIGTERM 可以同时结束外层 bash 和其 `sleep` 子进程。由于 Bun 对 Node 内置模块的
兼容仍可能随版本变化，该行为必须保留集成测试。参考
[Bun Node.js Compatibility](https://bun.sh/docs/runtime/nodejs-compat)。

### 停止竞争与 PID 安全

发送信号前必须同时满足：

- task 状态为 `running` 或 `stopping`。
- `child.pid` 存在。
- `child.exitCode` 和 `child.signalCode` 仍为空。

如果发送信号时收到 `ESRCH`，说明进程可能已经自然结束。此时等待已有 completion，
使用真实最终状态，不把错误直接改写为 `killed`。

同一 task 的 stop 操作在 manager 内串行化。第二个 TaskStop 看到 `stopping` 或
terminal 状态时直接返回明确错误，不重复发送信号。

## 输出处理

第一版不改变现有 `.tinker/bash/<taskId>.log` 路径和 preview 算法。

TaskOutput 获取运行中输出时使用内存 snapshot，避免每次查询都重新读取可能很大的
日志文件。任务结束后，completion 保证 write stream 已关闭，因此最终 snapshot 与
文件内容一致。

TaskStop 和 shutdown 都必须在返回前等待 `TaskOutput.end()`，否则用户可能拿到
`killed` 状态，但日志最后几行仍未写入。

stdout 和 stderr 继续合并进入同一个 output。阶段一不修改两路 stream 的相对顺序
策略，也不加入 backpressure 重构；如后续出现高吞吐输出问题，再单独设计输出管道。

## 生命周期事件

新增事件：

```ts
type BashTaskEvent =
  | {
      type: "bash.task.backgrounded";
      task: ShellTaskSnapshot;
    }
  | {
      type: "bash.task.stopping";
      task: ShellTaskSnapshot;
    }
  | {
      type: "bash.task.finished";
      task: ShellTaskSnapshot;
    };
```

事件规则：

- `backgrounded`：任务首次进入后台时发送一次。
- `stopping`：TaskStop 或 shutdown 将其转为 stopping 后发送一次。
- `finished`：已进入后台的任务到达 terminal 状态并完成输出收尾后发送一次。
- 前台完成、从未进入后台的 Bash 不发送这些面板事件；其执行仍由既有 tool events
  记录。
- 如果任务先结束、后被标记为后台，只发送携带 terminal snapshot 的
  `backgrounded`，不补发时间倒置的 `finished`。

后台任务可能在 agent 空闲时结束，因此 TUI runner 中的 event sink 必须提升为
session 级共享实例，并同时交给：

- `runAgent`
- `ShellTaskManager`
- MCP manager
- JSONL event log
- TUI event stream

当前 `CompositeEventSink.append()` 只保证单次调用内按 sink 顺序写入，无法阻止 agent
loop 和后台 monitor 同时 append。共享实例需要维护 promise tail，把所有事件提交
串行化，保证 JSONL 和 TUI 观察到一致顺序。单个事件写入失败仍向原调用方抛出，tail
需要在失败后恢复，避免整个 event sink 永久卡死。

Observation text log 不需要单独渲染 lifecycle event；TaskList、TaskOutput 和 TaskStop
的 tool observation 已经会进入人类可读日志。JSONL 保留完整 lifecycle event，作为
状态排查依据。

## TUI 设计

### 状态存储

`TuiState` 增加：

```ts
type TuiState = {
  // 现有字段
  backgroundTasks: ShellTaskSnapshot[];
};
```

`applyAgentEvent()` 按 task ID upsert：

- `bash.task.backgrounded`：新增或替换 snapshot。
- `bash.task.stopping`：更新状态和停止时间相关信息。
- `bash.task.finished`：更新最终状态、exit code、signal 和 endedAt。

任务按 startedAt 倒序展示。已结束任务保留到当前 TUI session 退出，不自动从面板
删除。

### BackgroundTasks 面板

在 Timeline 和 Footer 之间增加独立面板。没有后台任务时不渲染，避免空界面噪音。

示例：

```text
Background tasks · 1 running / 2 total

… running
  id=019...
  Start development server
  started=2026-07-10T10:20:30.000Z

✘ killed
  id=019...
  Run file watcher
  started=2026-07-10T10:10:00.000Z
  ended=2026-07-10T10:15:00.000Z signal=SIGTERM
```

每项展示：

- 完整 task ID。
- description；为空时使用折叠空白后的 command。
- status。
- startedAt。
- terminal 状态下的 endedAt 和 exit code、signal 或 error。

颜色：

- running：yellow。
- stopping：yellow。
- completed：green。
- failed：red。
- killed：gray 或 red；建议 gray，表示这是预期控制动作而不是任务失败。

### Tool timeline 展示

为三个新工具增加摘要：

```text
TaskList -> 3 tasks, 1 running
TaskOutput 019... -> running, 32 lines
TaskStop 019... -> killed (SIGTERM)
```

TaskOutput raw result 包含 command 和 preview 时，复用 `BashResultView` 的输出清洗和
尾部预览能力。TaskList 不在 timeline 展开所有任务，完整信息由 observation 和常驻
BackgroundTasks 面板承担。

one-shot stdout printer 同步支持三个工具的 task ID 和结果摘要，避免只输出泛化的
`tool.started name=TaskStop`。

## 系统提示更新

在 `SYSTEM_PROMPT` 的 Bash 说明后增加：

- Use TaskList to list background shell tasks in the current session.
- Use TaskOutput to inspect a task's current status and latest output.
- Use TaskStop to stop a background task that is no longer needed.
- Use Read on TaskOutput.outputFilePath when complete or paginated output is needed.
- Do not use shell `&` or ad-hoc `kill` commands to manage tasks created by Bash.

模型仍然可以用 Bash 管理并非 Tinker 创建的外部进程；上述约束只针对具有 task ID 的
manager-owned task。

## Runner 退出清理

### DefaultTooling 生命周期

`createDefaultTooling()` 返回值增加：

```ts
type DefaultTooling = {
  registry: ToolRegistry;
  runtime: ToolRuntime;
  snapshots: FileSnapshotStore;
  bashState: BashToolingState;
  dispose(): Promise<void>;
};
```

`dispose()` 调用 manager shutdown，并保证重复调用返回同一个 shutdown promise，避免
多个退出入口重复发送信号。

### shutdown 行为

```text
shutdown(reason)
  -> 禁止 start 新任务
  -> 找出 running / stopping tasks
  -> 并发发送 SIGTERM
  -> 等待统一 grace period
  -> 对剩余任务发送 SIGKILL
  -> 等待所有 completion
  -> 返回 ShutdownResult
```

shutdown 处理 manager 中所有仍在运行的 task，不只处理已经标记为后台的任务。这样
即使 TUI 在前台 Bash 执行中退出，也不会留下子进程。

`ShutdownResult` 至少包含：

```ts
type ShutdownResult = {
  stoppedTaskIds: string[];
  escalatedTaskIds: string[];
};
```

### TUI runner

`runTui()` 调整为：

```text
create shared event sink
create tooling with event sink
create MCP manager with same event sink
render App
try
  await instance.waitUntilExit()
finally
  unmount if needed
  restore stdin
  await tooling.dispose()
  await mcpManager.dispose()
```

`App` 收到 `/quit` 后调用 Ink 的 `exit()`，让 `waitUntilExit()` 正常完成。runner
随后等待 tooling shutdown 和 MCP dispose。由于 Bun 的 TTY stdin 句柄在 Ink 卸载后
仍可能保持进程存活，`/quit` 路径在全部异步清理完成后调用 `process.exit(0)`；不能在
清理前提前退出。

### One-shot runner

`runOneShot()` 需要把 tooling 提升到 try 外部，并在 finally 中执行：

```text
await tooling?.dispose()
await mcpManager?.dispose()
```

这样 one-shot agent 即使启动后台服务后正常结束，也会在返回 exit code 前清理该
服务。

`SIGKILL`、宿主机断电和 runtime 崩溃无法执行异步清理，不在第一版承诺范围内。
普通 `/quit`、Ink 正常退出和 one-shot 正常完成必须全部覆盖。

## Tool Registry 集成

`createDefaultTooling()` 创建单个 `ShellTaskManager`，并把同一实例传给四个 executor：

```ts
registry.register(createBashToolExecutor({ taskManager, ... }));
registry.register(createTaskListToolExecutor({ taskManager }));
registry.register(createTaskOutputToolExecutor({ taskManager }));
registry.register(createTaskStopToolExecutor({ taskManager }));
```

继续保留 `bashState.cwd` 供现有测试和 cwd 行为使用，但移除
`bashState.tasks`。代码不需要为公开 tasks Map 保留兼容层。

现有 `src/tools/task-output.ts` 是输出缓冲实现，新工具文件使用
`src/tools/task-output-tool.ts`，避免同名职责冲突。

## 文件级实施清单

| 文件 | 主要变更 |
| --- | --- |
| `src/tools/bash-task.ts` | 私有任务表、快照、后台标记、状态机、进程组 stop、shutdown |
| `src/tools/bash.ts` | 显式后台和 timeout 后台标记 |
| `src/tools/task-list.ts` | 新增 TaskList executor |
| `src/tools/task-output-tool.ts` | 新增 TaskOutput executor |
| `src/tools/task-stop.ts` | 新增 TaskStop executor |
| `src/tools/types.ts` | 三种 raw result 和 task snapshot 类型 |
| `src/tools/registry.ts` | 注册工具、注入共享 manager、暴露 dispose |
| `src/observation/observation-builder.ts` | 三种模型 observation |
| `src/cli/config.ts` | 更新系统提示 |
| `src/events/types.ts` | 后台任务 lifecycle events |
| `src/events/composite-event-sink.ts` | session 内事件串行提交 |
| `src/events/stdout-event-printer.ts` | one-shot 任务工具摘要 |
| `src/tui/event-store.ts` | 保存和更新 background task snapshots |
| `src/tui/components/background-tasks.tsx` | 新增后台任务面板 |
| `src/tui/components/timeline.tsx` | TaskList、TaskOutput、TaskStop 展示 |
| `src/tui/app.tsx` | 渲染后台任务面板 |
| `src/cli/run-runner.ts` | finally 中清理任务 |
| `src/cli/tui-runner.tsx` | 共享 sink、异步退出清理、清理完成后结束 `/quit` 进程 |

## 测试计划

### Tool contract

- 三个工具出现在 default registry。
- schema 使用 `additionalProperties: false`。
- TaskList 只接受空对象。
- TaskOutput 和 TaskStop 拒绝缺失、空白或非字符串 task ID。
- 未知 task ID 返回包含该 ID 的明确错误。

### 任务列表与状态

- 显式 `run_in_background: true` 的任务出现在 TaskList。
- 普通前台 Bash 不出现在 TaskList。
- 前台 timeout 后任务以 `foreground_timeout` 出现在列表。
- 运行中任务自然退出后自动变为 completed 或 failed。
- 已退出任务不会继续显示 running。
- TaskList 按 startedAt 倒序。

### 输出查询

- TaskOutput 在任务运行中返回当前 outputBytes、outputLines 和 preview。
- 任务持续输出后，再次查询能看到更新结果。
- 任务完成后返回最终 output snapshot。
- 大于 200 行时沿用前 100 行和后 100 行预览规则。
- outputFilePath 指向真实且可由 Read 读取的日志文件。

### 主动终止

- TaskStop 可以终止简单 `sleep`。
- TaskStop 返回前任务状态已经 terminal，日志已经 flush。
- 重复停止 terminal task 时 fast-fail 并报告当前状态。
- stop 与自然退出竞争时保留真实 exit 结果。
- 捕获 SIGTERM 并拒绝退出的任务在 grace period 后升级 SIGKILL。

### 进程树

增加真实 POSIX 集成测试：

```text
bash task
  -> spawn child sleep
  -> write child PID to temp file
  -> wait
```

TaskStop 后分别用 signal 0 检查 bash PID 和 child PID，二者都必须不存在。测试失败或
超时时必须在 finally 中清理测试进程，避免污染本机。

### TUI 和事件

- backgrounded event 新增任务卡片。
- stopping event 更新为 stopping。
- finished event 更新 exit code、signal 和 endedAt。
- terminal backgrounded snapshot 不先显示 running。
- completed、failed、killed 使用正确颜色和摘要。
- TaskOutput timeline 复用经过 ANSI/control character 清洗的输出预览。
- JSONL 包含完整 lifecycle event。
- agent event 和后台 finished event 同时提交时仍保持合法 JSONL 行和稳定顺序。

### Runner shutdown

- `DefaultTooling.dispose()` 停止一个运行中任务。
- dispose 同时清理多个任务。
- dispose 重复调用不会重复发信号。
- one-shot agent 启动后台任务并结束后不留下进程。
- TUI `/quit` 等待任务终止后再完成退出。

生产 grace period 通过 option 注入，测试使用短值，避免每个 SIGKILL 测试等待 2 秒。

验证命令：

```bash
bun test src/__tests__/bash-tool.test.ts
bun test src/__tests__/task-management.test.ts
bun test src/__tests__/tui-event-store.test.ts
bun test src/__tests__/tui-components.test.tsx
bun run check
```

## 手工验收

1. 启动 TUI，让 agent 使用 `run_in_background: true` 启动开发服务器。
2. 确认 Bash 返回 task ID，BackgroundTasks 面板显示 running。
3. 继续执行 Read、Edit 或其他 Bash，服务器保持运行。
4. 让 agent 调用 TaskOutput，确认能看到最新启动日志和完整日志路径。
5. 让 agent 调用 TaskStop。
6. 确认面板最终显示 killed，端口不再监听，子孙进程均不存在。
7. 启动一个会自行退出的后台任务，确认面板自动从 running 更新为 completed。
8. 再启动一个长任务，不主动停止，执行 `/quit`。
9. 确认 Tinker 完成任务清理后退出，没有遗留进程。

## 建议实施顺序

1. 重构 `ShellTaskManager` 数据边界和状态机，不先接 UI。
2. 加入进程组 stop、SIGTERM/SIGKILL 升级和 shutdown。
3. 接入 Bash 后台标记，实现 TaskList、TaskOutput、TaskStop。
4. 增加 observation、system prompt 和 stdout 展示。
5. 将 event sink 提升到 session scope，增加 lifecycle event。
6. 增加 TUI BackgroundTasks 面板。
7. 接入 TUI 和 one-shot 退出清理。
8. 完成真实进程树测试、runner 测试和 `bun run check`。

每一步都保持现有 Bash 前台执行测试通过。进程控制和退出清理完成前，不应只交付工具
schema，因为那会产生“看起来可停止、实际可能留下孙进程”的不完整能力。

## 关键取舍

- **manager 作为唯一事实来源**：减少工具、TUI 和退出路径各自维护状态的竞争。
- **只列真正后台化的 task**：避免 TaskList 被普通短命令污染。
- **状态在 exit 更新，completion 在 close 完成**：兼顾状态及时性和输出完整性。
- **按 POSIX 进程组终止**：比只 kill 外层 bash 更符合“可靠终止服务器”的验收标准。
- **TaskOutput 第一版非阻塞**：保持工具语义单一，避免与 Bash 前台等待重复。
- **常驻任务面板使用 lifecycle event**：无需轮询，也能在 agent 空闲时更新。
- **正常退出显式 shutdown**：`process.exit()` 只能发生在 shutdown 完成后，不能用它
  代替子进程和输出清理。
- **不持久化 task registry**：与阶段一的 session 内管理边界一致，恢复能力留给后续阶段。
