# 交互式终端任务设计

## 1. 文档状态

- 状态：方案已认可，待实现。
- 日期：2026-08-01。
- 范围：在现有 Bash 后台任务体系中增加模型可操作的 PTY 任务。
- 目标平台：macOS 和 Linux，延续当前 Bash runtime 的 POSIX 边界。

本文是 `docs/bash-tool-design.md` 和
`docs/background-task-management-design.md` 的增量设计。它不建立第二套进程管理系统，
而是在现有 `ShellTaskManager`、`Bash`、`TaskList`、`TaskOutput`、`TaskStop` 之上增加
PTY 启动与输入能力。

本文明确修订 `docs/bash-tool-design.md` 中“暂不实现伪终端和交互式 prompt”的旧边界。
其余 Bash 与后台任务合同保持不变。

## 2. 结论

Tinker 不复制 Codex Unified Exec 的 `exec_command` / `write_stdin` 协议，也不增加新的
process store 或 session ID。第一版只做两项模型可见变更：

1. `Bash` 增加可选参数 `tty`。
2. 新增 `TaskInput`，使用现有 `taskId` 向 PTY 写入字符并取得当前终端画面。

内部仍由 session 级 `ShellTaskManager` 统一持有进程。普通命令继续使用当前 pipe 路径；
只有 `tty: true` 才使用 Bun PTY。任务的后台化、停止、退出 watcher、进程组清理、
turn cancellation 和 session dispose 全部复用现有语义。

```text
Bash({ command, tty })
        │
        ▼
ShellTaskManager.start(mode)
        │
        ├─ mode=pipe ──> 当前 child_process.spawn 路径
        │
        └─ mode=pty  ──> Bun.spawn + Bun.Terminal
                              │
                              ├─ 原始字节 ──> .tinker/bash/<taskId>.log
                              └─ 原始字节 ──> headless VT screen
                                                   ▲
                                                   │
TaskInput({ task_id, chars, wait_ms }) ─────────────┘
```

## 3. 设计目标

第一版必须做到：

- Agent 可以启动需要 controlling terminal 的程序。
- Agent 可以跨 model iteration、跨 user turn 向该程序写入文本、回车和控制字符。
- Agent 可以可靠读取终端当前画面，而不是直接接收难以理解的 ANSI/VT 原始流。
- 交互式任务继续使用现有 task ID、后台任务列表、停止和 shutdown 能力。
- 普通非 PTY Bash 的行为和实现路径尽量不变。
- turn cancellation 只取消当前等待，不错误终止已经后台化的 PTY 任务。
- `/quit`、one-shot 完成和 runtime failure 都不会遗留 PTY 进程或后代进程。
- 模型上下文中的终端画面有固定上限，不因后台输出持续增长。

典型目标场景：

- Python、Node 等 REPL。
- `lldb`、`gdb` 等交互式调试器。
- 安装向导、确认提示和命令行登录流程。
- 需要 Ctrl-C、方向键或其他终端按键的命令行程序。
- 交互式 shell。

## 4. 非目标

第一版明确不做：

- 不提供 `/attach`，用户键盘不会直接接管子进程。
- 不把 Tinker TUI 变成嵌入式终端窗口。
- 不增加 app-server、外部 client 或远程终端协议。
- 不增加独立于 task ID 的 terminal/session ID。
- 不支持动态 resize、鼠标事件或用户终端尺寸同步。
- 不提供 base64 或任意二进制输入；输入合同是 UTF-8 字符串。
- 不把每一段 PTY 输出发布为持久化 runtime event。
- 不在 Tinker 重启或 `/resume` 后重新接管旧进程。
- 不承诺完整支持所有 curses/full-screen TUI。
- 不为 PTY 增加单独的权限系统、allowlist 或 feature flag。
- 不尝试解析 `TaskInput.chars` 属于 shell、REPL、debugger 还是其他应用语法。

headless VT screen 会使一部分 full-screen 程序具备可操作性，但第一版的正式产品合同只覆盖
REPL、调试器和普通交互式 prompt。

## 5. 模型可见工具合同

### 5.1 Bash 增加 `tty`

公开 schema 在现有字段基础上增加：

```ts
{
  name: "Bash",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string" },
      timeout: { type: "integer", minimum: 1, maximum: bashMaxTimeoutMs },
      description: { type: "string" },
      run_in_background: { type: "boolean" },
      tty: {
        type: "boolean",
        description: "Run the command in a pseudo-terminal so it can receive interactive input."
      }
    },
    required: ["command"]
  }
}
```

参数语义：

- `tty` 缺省或为 `false`：完全保持当前 pipe 行为。
- `tty: true`：stdin/stdout/stderr 连接到同一个 PTY。
- `tty` 与 `run_in_background` 正交。
- `tty: true` 不隐式后台化，也不改变 `timeout` 的含义。
- `run_in_background: true` 仍然在成功启动后立即返回。
- 未显式后台化的 PTY 命令在 foreground timeout 后，仍按当前合同转为后台任务。
- 命令在 foreground timeout 之前退出，仍返回普通 completed/failed Bash result。

推荐调用：

```json
{
  "command": "python3 -q",
  "tty": true,
  "timeout": 1000,
  "description": "Start Python REPL"
}
```

如果程序在一秒后仍停留在 prompt，`Bash` 返回现有 `running` 结果和 `taskId`。模型随后使用
`TaskOutput` 查看初始画面，并使用 `TaskInput` 继续交互。

`BashRawResult` 和 `ShellTaskSnapshot` 增加：

```ts
tty: boolean;
```

这样 `TaskList`、`TaskOutput`、TUI 和恢复投影都能区分普通后台任务与 PTY 任务。

### 5.2 新增 TaskInput

公开 schema：

```ts
{
  name: "TaskInput",
  description: "Write characters to a PTY shell task and return its current terminal screen.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: {
        type: "string",
        description: "The PTY task ID returned by Bash or TaskList."
      },
      chars: {
        type: "string",
        description: "Characters to write exactly as provided. Use an empty string to poll without writing."
      },
      wait_ms: {
        type: "integer",
        minimum: 0,
        maximum: 30000,
        description: "Milliseconds to wait before returning the current screen. Defaults to 250."
      }
    },
    required: ["task_id", "chars"]
  }
}
```

输入语义：

- `chars` 原样编码为 UTF-8 后写入 PTY。
- 不自动追加 `\n` 或 `\r`。
- 行命令必须显式包含 `\n`。
- Ctrl-C 使用 `\u0003`。
- 方向键等按键使用对应的终端 escape sequence。
- `chars: ""` 不写任何内容，只等待 `wait_ms` 后返回当前画面。
- `wait_ms` 缺省为 250ms。
- 等待在进程退出时可以提前结束。
- 等待不能在收到第一个输出字节时提前结束。readline 会先逐字符回显输入，过早返回会漏掉
  真正的命令结果。

成功 raw result：

```ts
export type TaskInputRawResult = {
  ok: true;
  taskId: string;
  task: ShellTaskSnapshot;
  status: ShellTaskStatus;
  writtenBytes: number;
  waitedMs: number;
  screenRows: number;
  screenColumns: number;
  screen: string;
  outputBytes: number;
  outputLines: number;
  outputFilePath: string;
};
```

失败 raw result：

```ts
export type TaskInputRawResult = {
  ok: false;
  taskId: string;
  task?: ShellTaskSnapshot;
  status?: ShellTaskStatus;
  writtenBytes?: number;
  error: string;
};
```

典型交互：

```json
{
  "task_id": "019...",
  "chars": "print(6 * 7)\n",
  "wait_ms": 250
}
```

模型观察：

```text
Terminal input sent.
taskId=019...
status=running
writtenBytes=15
screen=80x24
current screen:
>>> print(6 * 7)
42
>>>
```

### 5.3 TaskOutput 的 PTY 扩展

`TaskOutput` 保持非阻塞，不增加 `wait_ms`。对于 PTY task，它除了现有 output metadata 和
preview 外，再返回：

```ts
screenRows?: number;
screenColumns?: number;
screen?: string;
```

行为：

- 普通 pipe task 不返回 screen 字段。
- 运行中的 PTY task 返回 flush 后的当前 screen。
- 已退出的 PTY task 返回退出前保存的最终 screen。
- `preview` 继续代表 append-only transcript 的有界预览。
- `screen` 代表当前 VT screen，两者不能混为同一种数据。
- PTY outputFilePath 保存原始终端字节；需要可读画面时优先使用 `TaskOutput.screen`，而不是
  用 `Read` 直接读取原始日志。

### 5.4 TaskList 与 TaskStop

`TaskList` 不增加参数。它通过 `ShellTaskSnapshot.tty` 告诉模型任务是否可接受输入。

`TaskStop` 不增加参数或新的 stop 语义：

- 继续对整个 detached process group 发送 SIGTERM。
- grace period 后仍存活则发送 SIGKILL。
- 返回前等待进程退出、PTY EOF、日志 flush 和最终 screen 固化。

发送 `\u0003` 与调用 `TaskStop` 的语义不同：

- `TaskInput(..., "\u0003")` 把 Ctrl-C 交给 PTY line discipline/前台进程组，应用可以捕获后
  继续运行。
- `TaskStop` 是终止整个 Tinker task，不要求应用返回 prompt。

## 6. Bash Guard 合同

PTY 不引入额外确认。

规则固定为：

1. `Bash.command` 在创建进程前继续经过现有 `classifyBashRisk()`。
2. 初始 command 被现有规则判定为危险时，仍按当前 Bash Guard / YOLO 合同处理。
3. `tty: true` 本身不构成危险条件，不触发额外确认。
4. `TaskInput` 不调用 Bash Guard，不解析或分类 `chars`，也不逐次请求确认。
5. safe initial command 即使在 one-shot 非 YOLO 模式中也可以创建 PTY 并继续交互。

这意味着模型可以先启动交互式 shell 或 REPL，再通过 `TaskInput` 执行不会被
`classifyBashRisk()` 重新检查的操作。这是明确接受的产品边界，不作为 guard bypass bug
处理。理由是交互终端内再次构造毁灭性 command 的场景很窄，而为所有输入建立可靠的
上下文语法分类既复杂，也会显著破坏正常调试和终端操作体验。

实现不得悄悄加入以下行为：

- 不因 `tty: true` 强制弹出一次确认。
- 不在第一次 `TaskInput` 时补做确认。
- 不按换行拆分 `chars` 后调用 shell risk classifier。
- 不根据最初启动的是 `bash`、`python` 或 debugger 改变 guard 行为。

## 7. 进程与任务模型

### 7.1 继续由 ShellTaskManager 持有生命周期

`ShellTaskManager` 仍是唯一任务生命周期 owner：

- 分配 task ID。
- 启动进程。
- 在 map 中保留 running task。
- 记录 foreground/background 状态。
- 提供 TaskList/TaskOutput/TaskInput/TaskStop 所需操作。
- 监听自然退出。
- 在 session shutdown 时终止所有尚未结束的任务。

不新增 `UnifiedExecProcessManager`、`TerminalManager` 或另一个平行 task map。

### 7.2 内部进程适配层

当前 `ManagedShellTask.process` 直接依赖 `ChildProcessWithoutNullStreams`。PTY 路径需要
`Bun.Subprocess` 和 `Bun.Terminal`，但不应让这两个 API 的差异散落到 manager 各个状态
分支。

增加一个只在 tools runtime 内部可见的薄适配层：

```ts
type ShellProcessHandle = {
  readonly pid: number;
  readonly mode: "pipe" | "pty";
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  wait(): Promise<ProcessExitResult>;
  write?(chars: string): Promise<number>;
  close(): void;
};
```

建议实现：

- pipe adapter：包装现有 `child_process.spawn`，保持当前 stdout/stderr listener 和 close
  语义。
- PTY adapter：包装 `Bun.spawn`、`Bun.Terminal`、PTY EOF promise 和写入 backpressure。
- `ShellTaskManager` 继续只保存 process group ID，并继续使用负 PID signaling。
- 只有 adapter 负责不同进程 API 的 exit/close 差异。

第一版不把所有 Bash 迁移到 `Bun.spawn`。保留 pipe 路径可以减少与本功能无关的输出、
cwd、exit race 和测试回归。

### 7.3 ManagedShellTask 增量状态

内部 task 增加：

```ts
type ManagedShellTask = {
  // existing fields
  mode: "pipe" | "pty";
  process: ShellProcessHandle;
  terminalScreen?: TerminalScreen;
  finalScreen?: string;
};
```

`ShellTaskSnapshot` 只公开 `tty: boolean`，不公开 process、Terminal 或 screen parser。

## 8. PTY 启动

### 8.1 使用 Bun.Terminal

PTY task 使用 Bun 内建 PTY：

```ts
const process = Bun.spawn(["bash", "-lc", bashWrapperScript], {
  cwd,
  detached: true,
  env,
  terminal: {
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    data(_terminal, bytes) {
      // raw log + VT screen
    },
    exit() {
      // resolve PTY EOF
    },
    drain() {
      // resume pending writes
    }
  }
});
```

不引入 `node-pty` 或 Python sidecar。Tinker 已经由 Bun 驱动，内建 PTY 避免新的 native
编译、prebuild 和发布矩阵。

### 8.2 固定终端环境

第一版使用固定参数：

```text
columns=80
rows=24
TERM=xterm-256color
NO_COLOR=1
PAGER=cat
GIT_PAGER=cat
```

固定尺寸保证 TUI、one-shot、测试和不同宿主 terminal 下的模型观察一致。runtime layer
不依赖 Ink window size，也不把 TUI 尺寸反向注入 tools。

不调用 `terminal.setRawMode(true)`。PTY slave 的模式由 shell 和子应用自行管理；manager
只持有 master 并写入字符。

### 8.3 启动提交边界

PTY 进程成功 spawn 后，必须像当前普通 Bash 一样立即进入 `ShellTaskManager.tasks`，然后
`Bash` 才开始 foreground wait。

这样：

- foreground timeout 只改变任务归属，不影响进程存活。
- `run_in_background: true` 可以立即发布同一个 task。
- watcher 与 stop/shutdown 从进程启动后就有稳定 owner。
- 不会因为 tool execution 暂时不再持有局部引用而释放 Terminal。

## 9. 输出与当前终端画面

### 9.1 两种输出视图

PTY 输出同时进入两个互补视图：

```text
PTY data callback
  ├─ raw bytes -> TaskOutput -> .tinker/bash/<taskId>.log
  └─ raw bytes -> TerminalScreen -> current 80x24 screen
```

原始 transcript：

- append-only。
- 继续记录 outputBytes/outputLines。
- 继续使用现有 first/last line preview。
- 保留 ANSI、cursor movement 和应用发出的原始终端控制序列。
- 用于诊断和完整历史，不直接作为 PTY 的主要模型观察。

当前 screen：

- 固定为 80×24。
- 正确解释 CR、LF、backspace、cursor movement、erase、SGR 和宽字符。
- 最多向模型返回 24 行，天然受上下文上限约束。
- 用于 TaskInput 和 PTY TaskOutput 的主要观察。

### 9.2 使用 headless xterm

不能用简单正则 strip ANSI 代替 screen。readline、debugger 和 full-screen 应用会通过
cursor movement 重写已经显示的内容，删除 escape sequence 只能得到历史字符流，不能得到
当前画面。

仓库已有 test-only `PtyTerminalScreen`，使用：

- `@xterm/headless`
- `@xterm/addon-unicode11`

实现时将这两个包移入 production dependencies，并把通用 screen wrapper 放入
`src/tools/terminal-screen.ts`。测试 helper 改为复用 production wrapper 或只保留针对 Tinker
外层 TUI 的适配，不复制第二个 VT parser。

production wrapper 只暴露：

```ts
type TerminalScreen = {
  write(bytes: Uint8Array): Promise<void>;
  flush(): Promise<void>;
  text(): string;
  dispose(): void;
};
```

第一版不暴露 resize、modes、mouse 或 scrollback API。

### 9.3 输出顺序和 flush

PTY data callback 可能在 process exit 附近仍收到最后一批字节。自然退出和停止路径必须：

1. 等待 subprocess exit。
2. 等待 PTY EOF。
3. 结束并 flush 原始 TaskOutput。
4. 等待 TerminalScreen pending writes。
5. 保存 `finalScreen`。
6. dispose headless screen。
7. 关闭 Bun Terminal。
8. 发布 `bash.task.finished`。

不能只等待 subprocess exit 后立即关闭 Terminal，否则可能丢失最后一个 prompt、错误消息或
exit summary。

运行中的 `TaskOutput` 和 `TaskInput` 在读取 screen 前也必须等待当时已经排队的 screen write
完成。为此可以增加 async inspection API，而不是把当前同步 `inspectTask()` 全面改成 async：

```ts
inspectTask(taskId: string): ShellTaskInspection | undefined;
inspectTaskOutput(taskId: string): Promise<ShellTaskInspection | undefined>;
```

TaskList 和状态判断继续使用同步 inspection；需要 screen 的工具使用 async inspection。

## 10. TaskInput 执行语义

### 10.1 执行顺序

`TaskInput` 固定按以下顺序执行：

```text
validate args
  -> check turn cancellation
  -> resolve task
  -> require tty=true
  -> require running/stopping contract
  -> write all chars when non-empty
  -> wait for wait_ms, process exit, or turn cancellation
  -> flush queued screen writes
  -> inspect task and return screen
```

更精确的状态规则：

- unknown task：失败。
- pipe task：失败，并提示只有 `Bash tty=true` 的任务支持 TaskInput。
- `running` PTY task：可以写入或 poll。
- `stopping` PTY task：拒绝非空写入；允许空 poll 查看最终画面。
- terminal PTY task：拒绝非空写入；允许空 poll 返回 final screen。

### 10.2 写入与 backpressure

`Bun.Terminal.write()` 返回本次接受的字节数。实现不能假定一次 write 总能接受完整字符串。
PTY adapter 负责：

- 将 `chars` 编码为 UTF-8。
- 写入当前可接受的部分。
- 在 partial write 时等待 drain 后继续。
- 返回最终 `writtenBytes`。
- 保持同一个 task 的写入顺序。

当前 agent loop 已串行执行 tool calls，因此第一版不增加通用 tool concurrency scheduler。
adapter 只需要正确处理 Terminal 自身的 backpressure 和 pending write。

### 10.3 等待与取消

`wait_ms` 是固定收集窗口，不是“收到任意输出即完成”：

```text
non-empty chars -> write 完成 -> 等待 wait_ms 或 process exit
empty chars     -> 不写入   -> 等待 wait_ms 或 process exit
```

等待接受当前 turn 的 AbortSignal：

- 写入前已经取消：不写任何字符，按普通 tool cancellation 处理。
- 字符已经写完后取消：输入副作用保留，只取消等待和当前 turn。
- 已后台化 task 不因 TaskInput cancellation 被停止。
- 下一次 `TaskOutput` 或 `TaskInput(chars="")` 可以恢复当前 screen。

写入是一项不可回滚的外部副作用。实现不承诺在 Terminal I/O fault 中撤回已写入的前缀；
错误 raw result 应在可知时报告 `writtenBytes`。

## 11. Foreground、background 与 cwd

PTY 不建立新的任务状态机。继续使用当前状态：

```text
running -> stopping -> killed
running -> completed
running -> failed
```

background 仍是任务元数据，而不是新进程类型：

- `run_in_background: true`：`backgroundReason=requested`。
- foreground timeout：`backgroundReason=foreground_timeout`。
- foreground 内完成：不进入 TaskList。

turn cancellation 边界保持：

- 尚未后台化的 foreground Bash 被取消时，继续由
  `ShellTaskManager.cancelForegroundTask()` 终止。
- 一旦 `bash.task.backgrounded` 已提交，取消当前 turn 不停止任务。
- TaskInput 只会操作模型已经取得 task ID 的任务，因此实际交互对象通常已经后台化。

cwd 继续沿用现有合同：

- foreground Bash 成功完成时可以更新 session `CwdState`。
- 后台 PTY 内执行 `cd` 不改变后续 Tinker Bash 的全局 cwd。
- task 退出后可以更新自身 snapshot 中的 cwd，但不反向修改 session cwd。

## 12. 停止与 session shutdown

PTY task 继续属于 Tinker runtime session，不允许脱离 session 永久运行。

### 12.1 TaskStop

停止顺序：

```text
status=stopping
  -> bash.task.stopping
  -> SIGTERM to detached process group
  -> wait stopGraceMs
  -> if still alive: SIGKILL to process group
  -> await process exit + PTY EOF + output/screen flush
  -> close Terminal
  -> bash.task.finished
```

不能通过只调用 `terminal.close()` 代替 process-group termination。关闭 PTY 可能产生 SIGHUP，
但不能证明全部后代进程都被回收，也会改变当前稳定的 SIGTERM→SIGKILL 合同。

### 12.2 Runtime dispose

`RuntimeSession.performDispose()` 的顺序不改变：

1. 取消并等待 active turn。
2. dispose MCP。
3. dispose tooling。
4. `ShellTaskManager.shutdown()` 停止所有普通和 PTY task。
5. 记录 `session.finished`。
6. 关闭 session store。

TUI runner 既有退出顺序也不得改变：Ink exit 和 stdin restore 完成后，等待 session cleanup，
最后才显式退出 Bun process。

## 13. Events、canonical history 与 TUI

### 13.1 不增加 PTY output delta event

第一版不增加 `bash.task.output` 或 per-byte event。原因：

- 原始输出已经持续写入 task log。
- current screen 由 manager 内的 headless terminal 维护。
- 每字节持久化会放大 event log、SQLite 和 Ink 更新压力。
- Agent 只有在 TaskInput/TaskOutput 时才需要取得画面。

继续复用现有 lifecycle events：

- `bash.task.backgrounded`
- `bash.task.stopping`
- `bash.task.finished`

`TaskInput` 像其他工具一样产生普通：

- `tool.started`
- `tool.raw_result`
- `tool.finished`
- `tool.observation`

### 13.2 Canonical history

`TaskInput` 的 tool args 和 observation 进入 canonical history：

- `chars` 会作为 assistant tool call 参数持久化。
- current screen 会作为 tool observation 持久化。
- 原始完整 PTY transcript 不进入模型上下文，只保留 output metadata、raw log path 和 screen。

第一版不提供 secret/redacted input。模型和系统提示应明确：不要用 `TaskInput` 输入密码、
token、私钥或其他不应进入 session history 的秘密。

### 13.3 TUI 展示

最小展示变更：

- background task panel 可以在现有两行布局中给 PTY task 增加一个紧凑 `tty` 标记，但不增加
  第三行。
- TaskInput timeline item 显示 task ID、status 和 screen 的末尾若干行。
- PTY TaskOutput timeline 优先显示 screen，不把原始 ANSI preview 直接交给 Ink。
- stdout one-shot printer 使用与 observation 相同的纯文本 screen。

不增加持续刷新的嵌入式终端区域。后台程序自己产生新输出时，TUI 只更新 task 状态；
Agent 调用 TaskInput/TaskOutput 后才展示新的 screen snapshot。

### 13.4 Resume 边界

PTY process 是 runtime-only：

- 正常退出 Tinker 会先终止它。
- `/resume` 只恢复历史 TaskInput/TaskOutput tool exchange 和最终 task snapshot。
- 新的 `ShellTaskManager` 不尝试根据历史 task ID 重新连接进程。
- 对历史 task ID 调用 TaskInput/TaskOutput 会得到 unknown task，而不是伪造 running 状态。

这与当前后台 task 的 session-local ownership 一致。

## 14. 错误合同

预期 tool-level failure：

- `tty` 不是 boolean。
- `task_id` 缺失、空白或不是 string。
- `chars` 不是 string。
- `wait_ms` 不是 0..30000 内的整数。
- unknown task ID。
- 对 pipe task 调用 TaskInput。
- 对 stopping/terminal task 写入非空 chars。
- PTY 已关闭或 write 失败。

这些错误返回 `TaskInputRawResult { ok: false }`，不 fault RuntimeSession。

可能升级为 runtime/task failure：

- Bun PTY 创建失败。
- output log 无法创建或 flush。
- headless screen parser 异常。
- process monitor 或 terminal close 进入不一致状态。

启动阶段失败时不得把半初始化 task 放入 TaskList。进程成功 spawn 之后发生的 monitor/output
错误则由 manager 收敛为 task `failed`，并继续执行进程组清理。

在不支持 Bun PTY 的平台或 runtime 上，只有 `tty: true` 调用 fast-fail；普通 Bash 不受影响。

## 15. 文件级实施范围

| 文件 | 变更 |
|---|---|
| `package.json` / `bun.lock` | 将 headless xterm 与 Unicode addon 移入 runtime dependencies |
| `src/tools/bash.ts` | 增加 `tty` schema、参数解析、raw result 和启动参数 |
| `src/tools/bash-task.ts` | 支持 pipe/PTY process adapter、screen、输入、EOF/flush/close |
| `src/tools/shell-process.ts` | 新增内部 pipe/PTY process adapter；如果足够短也可留在 bash-task 内 |
| `src/tools/terminal-screen.ts` | 新增生产 headless VT screen wrapper |
| `src/tools/task-input.ts` | 新增 TaskInput executor 与参数校验 |
| `src/tools/task-output-tool.ts` | PTY task 使用 async screen inspection |
| `src/tools/types.ts` | 增加 tty/screen 字段和 TaskInput raw kind |
| `src/tools/registry.ts` | 注册 TaskInput |
| `src/observation/observation-builder.ts` | 生成 TaskInput 和 PTY TaskOutput observation |
| `src/events/bash-result-detail.ts` | 让 presentation 使用 screen，而不是原始 PTY preview |
| `src/events/stdout-event-printer.ts` | 输出 TaskInput/PTY screen 摘要 |
| `src/events/observation-text-log.ts` | 记录有界 TaskInput observation |
| `src/tui/event-store.ts` | 投影 TaskInput tool item 与 tty task 标记 |
| `src/tui/components/background-tasks.tsx` | 在现有两行布局内显示可选 tty 标记 |
| `src/cli/runner-dependencies.ts` | 增加模型使用 tty/TaskInput 的系统提示 |
| `docs/bash-tool-design.md` | 实现时更新旧 non-goal 和公开 schema |
| `README.md` / generated docs | 如公开工具说明涉及该能力，按现有 docs workflow 更新 |

不要为了目录整齐提前拆出大量抽象文件。`shell-process.ts` 只有在 pipe/PTY adapter 让
`bash-task.ts` 职责明显失控时才单独创建。

## 16. 模型使用提示

系统提示增加精简合同：

```text
Use Bash with tty=true for REPLs, debuggers, interactive prompts, and terminal
applications that require a controlling terminal.

Use the returned task ID with TaskOutput to inspect the current terminal screen
and TaskInput to send characters. TaskInput does not append Enter; include \n
explicitly. Use \u0003 for Ctrl-C. Use chars="" to wait without writing.

Do not add & to the shell command. Background ownership is managed by Tinker.
Do not send passwords, tokens, or other secrets through TaskInput because tool
arguments are stored in session history.
```

不要求模型理解 output offset、drain cursor 或另一套 terminal ID。

## 17. 测试方案

### 17.1 参数与工具单测

- Bash 接受缺省/false/true `tty`，拒绝非 boolean。
- TaskInput 拒绝非法 object、额外字段、空 task ID、非 string chars 和越界 wait_ms。
- unknown task 返回 bounded tool error。
- pipe task 明确拒绝 TaskInput。
- terminal task 拒绝非空输入，但允许空 poll 返回 final screen。
- TaskOutput 对 pipe task 不返回 screen，对 PTY task 返回 screen。

### 17.2 Bash Guard 回归

- safe command + `tty: true` 不产生 `tool.confirmation.requested`。
- dangerous initial command + `tty: true` 与 `tty: false` 使用完全相同的现有 guard 行为。
- TaskInput 的普通文本、换行和类似 shell command 的 chars 都不调用 guard。
- one-shot 非 YOLO 可以启动 safe PTY 并交互。
- YOLO 只影响 initial Bash command 的 guard decision，不改变 TaskInput。

### 17.3 PTY 集成测试

使用真实 Bun PTY 启动 Python REPL：

1. 等待 `>>>`。
2. 写入 `print(6 * 7)\n`。
3. screen 包含 `42` 和新的 `>>>`。
4. 写入 `exit()\n`。
5. task 以 exit code 0 完成。
6. final screen 保留最后一次可见内容。

额外覆盖：

- prompt 没有末尾换行仍能出现在 screen。
- ANSI sequence 被 screen 正确解释，不出现在 observation。
- ANSI/UTF-8 sequence 跨 data chunk 时仍正确。
- 中文、emoji、组合字符和宽字符列宽。
- 大量输出滚动后 screen 只返回当前 24 行，raw log 仍完整。
- `chars: ""` 等待后取得异步输出。
- `wait_ms` 不会因首个输入回显字节提前返回。
- Terminal partial write/drain 不丢字符或打乱顺序。

### 17.4 Ctrl-C 与取消

- Python REPL 执行长操作时写入 `\u0003`，操作被中断但 REPL task 继续运行并返回 prompt。
- Esc 取消正在等待的 TaskInput，后台 PTY task 继续存活。
- 字符已经写入后取消，下一次 TaskOutput 能看到结果。
- foreground PTY Bash 在后台化之前被取消，仍按当前合同终止进程组。

### 17.5 进程树与 shutdown

- PTY task 启动子进程后，TaskStop 清理 shell、前台程序和后代。
- SIGTERM 无响应时按现有 grace period 升级 SIGKILL。
- natural exit、TaskStop、turn cancellation 和 shutdown 竞态不会重复 close/finish。
- `/quit` 清理 still-running PTY task，不遗留 PID、PTY fd 或 Bun event-loop reference。
- one-shot final answer 前未停止的 PTY task 在 tooling dispose 中被清理。

### 17.6 真实 TUI journey

增加一个 deterministic fake-model journey：

```text
user prompt
  -> Bash tty=true starts Python
  -> TaskOutput sees >>>
  -> TaskInput sends print expression
  -> TaskInput screen sees 42
  -> TaskInput sends exit()
  -> final assistant response
```

断言：

- 用户可见 timeline 能看到 Bash、TaskOutput 和 TaskInput。
- screen 不含会破坏 Ink 布局的 raw control characters。
- SQLite canonical history 中 tool call/result 顺序完整。
- 下一 user turn 可以继续正常工作。
- active PTY task 存在时 `/quit` 仍能在限定时间内退出。

## 18. 实施顺序

### 阶段 A：PTY core

1. 增加 production `TerminalScreen`。
2. 增加 PTY process adapter。
3. 扩展 ShellTaskManager start/monitor/stop/shutdown。
4. 先用 manager integration test 证明 Python REPL、screen 和 process cleanup。

阶段 A 不注册 TaskInput，先证明底层生命周期可靠。

### 阶段 B：工具协议

1. Bash 增加 `tty`。
2. 增加 TaskInput raw kind 和 executor。
3. TaskOutput 增加 async PTY screen inspection。
4. 更新 ObservationBuilder 和 model instructions。
5. 增加 Bash Guard 合同测试，特别证明 `tty: true` 不额外确认。

### 阶段 C：展示与端到端

1. stdout/TUI projection 接入 TaskInput screen。
2. background task 两行布局增加紧凑 tty 标记。
3. 更新 Bash 文档和公开说明。
4. 增加真实 TUI→子 PTY journey。
5. 运行完整质量门禁。

不需要长期 feature flag。实施过程中可以按阶段提交，但阶段 C 完成前不把功能视为可发布。

## 19. 验收清单

- [ ] Bash 公开 schema 支持 `tty`，普通 Bash 行为无回归。
- [ ] `tty: true` 不额外触发 Bash Guard。
- [ ] TaskInput 不调用 Bash Guard，也不自动追加回车。
- [ ] Python REPL 可以启动、输入、观察结果并正常退出。
- [ ] Ctrl-C 可以中断前台操作而不必停止整个 task。
- [ ] current screen 由 headless VT parser 生成，不用正则模拟终端。
- [ ] raw transcript 与 current screen 明确分离。
- [ ] TaskStop 和 shutdown 清理完整 PTY 进程树。
- [ ] turn cancellation 不杀死已后台化 PTY task。
- [ ] `/resume` 不声称恢复旧 PTY 进程。
- [ ] TaskInput args/observations 进入 canonical history，秘密输入限制已写入提示。
- [ ] TUI 不持久化或实时渲染 per-byte PTY output event。
- [ ] `bun run check` 全部通过。

完成这些条件后，Tinker 即具备一个小而可靠的 agent-driven interactive terminal：模型通过
现有 Bash task 启动进程，通过同一个 task ID 读取 screen、发送输入和停止任务；runtime
继续以 session 为边界负责所有进程生命周期。
