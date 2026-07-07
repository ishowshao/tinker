# Bash Tool 设计方案

## 背景

`tinker` 当前已经有一个最小 ReAct loop、`Read` / `Write` 工具、JSONL event log、TUI event stream 和 `tinker run` 非交互入口。下一阶段需要加入一个模型可调用的 `Bash` 工具，让 agent 能执行命令、运行测试、观察输出，并把命令结果稳定记录下来。

本方案参考成熟 coding agent 的 Bash 设计，但只保留当前需要的行为：

- 公开 tool 名固定为 `Bash`。
- 只暴露 `command`、`timeout`、`description`、`run_in_background` 四个参数。
- 不做 deny / ask / allow 权限规则。
- 不做复杂安全检测。
- 不做 `sed -i` 特殊解析和模拟编辑。
- 暂不涉及 tool 并发执行。

## 目标

- 模型可以通过 `Bash` 执行本地命令。
- 长短命令都走统一的任务和输出持久化路径。
- 命令输出无论大小都落盘，模型只接收摘要和输出文件路径。
- 长任务可以显式后台运行，也可以在超过前台等待阈值后自动交还控制权。
- 后续模型可以通过 `Read` 读取输出文件，或通过可选的任务输出工具查询任务状态。
- `grep` / `rg` / `find` / `diff` / `test` / `[` 的 exit code 按命令语义解释，不把信息性非零码误判为错误。
- cwd 变化在前台命令成功完成时持久化，后续 Bash 继承新的 cwd。

## 非目标

- 不做权限审批、人类确认或规则持久化。
- 不做 shell AST 安全解析。
- 不尝试判断命令是否只读。
- 不做 tool call 并发调度。
- 不把 stdout/stderr 大段内容直接塞进模型上下文。
- 不实现复杂终端交互，比如伪终端、交互式 prompt 自动回答。
- 不保证后台命令的 `cd` 会改变后续 Bash 的 cwd。

## Tool Schema

模型可见 schema：

```ts
{
  name: "Bash",
  description: "Run a shell command in the local workspace.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute."
      },
      timeout: {
        type: "integer",
        minimum: 1,
        description: "Optional foreground timeout in milliseconds."
      },
      description: {
        type: "string",
        description: "Clear 5-10 word description of what this command does."
      },
      run_in_background: {
        type: "boolean",
        description: "Run the command in the background and return immediately."
      }
    },
    required: ["command"]
  }
}
```

参数语义：

- `command`: 必填。完整 shell 命令字符串。
- `timeout`: 可选。控制前台等待时间，默认建议 `120_000` ms。
- `description`: 可选。用于 TUI、日志和后台任务列表展示；缺省使用 `command`。
- `run_in_background`: 可选。为 `true` 时命令启动后立即转后台，模型通过输出文件或任务查询观察后续结果。

## 系统提示约束

加入 Bash 后，`SYSTEM_PROMPT` 需要更新：

- 可以使用 `Bash` 运行测试、格式化、lint、git 只读检查和项目命令。
- 读文件仍优先使用 `Read`，不要用 `cat` 读取大文件。
- 写文件仍优先使用 `Write`。
- 长时间运行的 dev server、watch、构建、测试服务应使用 `run_in_background: true`。
- 不需要在 command 末尾添加 `&`；后台化由 runtime 处理。
- Bash 输出会持久化到文件，后续需要完整输出时读取返回的 `outputFilePath`。

## 执行模型

第一版使用 Node/Bun 的 `child_process.spawn` 实现，不使用 `execSync`。

核心原则：**每一次 Bash 调用都创建一个 ShellTask**。所谓前台执行，只是 runtime 在同一个 task 上等待一段时间；所谓后台执行，是 runtime 停止等待但让同一个 task 继续运行。

建议结构：

```text
src/tools/bash.ts
  createBashToolExecutor()
  parseBashArgs()
  interpretCommandResult()

src/tools/bash-task.ts
  ShellTaskManager
  ShellTask
  task status / background / kill / wait

src/tools/task-output.ts
  output directory
  append / read / build line preview

src/tools/cwd-state.ts
  getCwd()
  setCwd()
```

核心流程：

```text
Bash.execute(args)
  -> parse args
  -> create ShellTask
  -> spawn shell process with cwd = current bash cwd
  -> persist stdout/stderr to output file
  -> if run_in_background: background and return task metadata
  -> else wait until command exits or foreground timeout elapses
      -> exits before timeout: return completed result
      -> exceeds timeout: background task and return task metadata
```

## 后台任务模型

后台不是 shell 的 `&`，而是 runtime 管理已经启动的进程：

```text
ShellTask
  id
  command
  description
  status: running | completed | failed | killed
  exitCode?
  startedAt
  endedAt?
  outputFilePath
  cwd
  process
```

`run_in_background: true` 时：

1. 仍然先正常 `spawn` 子进程。
2. 创建 `ShellTask` 并注册到 `ShellTaskManager`。
3. stdout/stderr 持续写入 `outputFilePath`。
4. Bash tool 立刻返回：

```text
Bash command started in background.
taskId=<id>
status=running
outputFilePath=<path>
Use Read on outputFilePath to inspect output.
```

如果 `run_in_background` 不是 `true`，但命令超过前台等待阈值：

- 不杀进程。
- 将同一个 `ShellTask` 标记为 backgrounded。
- 立刻把控制权交还给模型。
- 返回 `backgroundedDueToTimeout: true`。

这比“timeout 就 kill”更适合 agent loop，因为模型可以继续思考、读取文件或稍后观察任务输出。

## Timeout 语义

建议区分两个概念：

- `foregroundTimeoutMs`: Bash tool 等待命令完成的最长时间。
- `hardKillTimeoutMs`: 可选的后台任务最大生命周期，第一版可以不做。

第一版 `timeout` 只表示前台等待时间：

- 命令在 `timeout` 内退出：返回完整任务摘要。
- 命令超过 `timeout`：转后台并返回 `taskId` / `outputFilePath`。
- 显式 `run_in_background: true`：忽略前台等待，启动后立即返回。

默认值：

- `TINKER_BASH_DEFAULT_TIMEOUT_MS`，默认 `120_000`。
- `TINKER_BASH_MAX_TIMEOUT_MS`，默认 `600_000`。

schema 层建议真正校验最大值，不只是写在 description 里。

## 输出持久化

所有 Bash 输出都统一落盘，不区分长短输出。

建议目录：

```text
<workspaceRoot>/.tinker/bash/<taskId>.log
```

输出策略：

- stdout 和 stderr 都写入同一个文件。优先用同一个文件 fd 作为子进程 stdout/stderr，尽量保留实际出现顺序。
- preview 按行生成，不按字符或 bytes 截断：
  - 如果已捕获输出不超过 `200` 行，preview 使用完整已捕获输出。
  - 如果已捕获输出超过 `200` 行，preview 使用前 `100` 行 + 最后 `100` 行。
  - 中间插入明确省略标记，例如：

    ```text
    ... output omitted: 347 lines omitted. Full output is available at outputFilePath.
    ```

- 内存里只保留生成 preview 所需的小状态：前 `100` 行、最后 `100` 行、行数统计和当前未结束行。
- raw result 和 JSONL event 记录 `outputFilePath`、`outputBytes`、`outputLines`、`preview`、`truncated`、`omittedLines`。
- 模型 observation 不直接包含完整输出，只包含状态、exit code、语义解释、preview 和路径。

建议 raw result：

```ts
export type BashRawResult = {
  ok: boolean;
  command: string;
  taskId: string;
  status: "completed" | "failed" | "running" | "killed";
  exitCode?: number;
  signal?: string;
  cwd: string;
  outputFilePath: string;
  outputBytes: number;
  outputLines: number;
  preview: string;
  truncated: boolean;
  omittedLines?: number;
  timedOut?: boolean;
  backgrounded?: boolean;
  backgroundedDueToTimeout?: boolean;
  returnCodeInterpretation?: string;
  error?: string;
};
```

## 复访输出

优先复用已有 `Read`：

- Bash observation 明确告诉模型：完整输出在 `outputFilePath`。
- 因为路径在 workspace 的 `.tinker/bash/...` 下，现有 `Read` 可以读取。
- 大输出可以继续用 `Read.offset` / `Read.limit` 分段读取。

可选第二阶段再加 `TaskOutput` 工具：

```ts
TaskOutput({
  task_id: string,
  block?: boolean,
  timeout?: number
})
```

第一版可以不加，因为 `Read(outputFilePath)` 已经足够。

## cwd 策略

建议保存 cwd 状态，但只让前台完成的命令更新 cwd。

原因：

- 模型自然会期待 `cd packages/app` 后下一次 Bash 在 `packages/app` 下执行。
- 不复用同一个 shell，仍可以通过 cwd state 实现这种体验。
- shell 变量、alias、函数、`set -x` 等不持久化，避免隐式状态过多。

实现方式：

1. `BashToolingState` 保存 `cwd`，初始为 `workspaceRoot`。
2. spawn 时设置 `cwd: state.cwd`。
3. 执行命令时包装：

```bash
eval "<user command>"
exit_code=$?
pwd -P > "<cwdFile>"
exit "$exit_code"
```

4. 命令退出后读取 `cwdFile`。
5. 如果命令是前台完成、不是后台任务，并且 cwd 仍在 workspace 内，则更新 `state.cwd`。
6. 后台任务完成不更新全局 cwd，避免长任务晚完成后覆盖模型当前工作目录。

注意这里不能简单用 `command && pwd -P`，否则命令非零退出时 cwd 不会被捕获。

## Exit Code 语义修正

默认规则：

- exit code `0`: success
- 非 `0`: error

特例：

| 命令 | 非错误 exit code | 含义 |
| --- | --- | --- |
| `grep` | `1` | No matches found |
| `rg` | `1` | No matches found |
| `find` | `1` | Some directories were inaccessible |
| `diff` | `1` | Files differ |
| `test` | `1` | Condition is false |
| `[` | `1` | Condition is false |

实现建议：

- 从 command 中提取最后一个 pipeline segment 的首个命令名。
- 根据命令名解释 exit code。
- `ok` 使用语义结果，而不是简单 `exitCode === 0`。
- observation 里保留 `returnCodeInterpretation`，让模型知道 `grep` 没匹配不是 runtime 失败。

## Observation 格式

完成命令：

```text
Bash completed.
command=<command>
exitCode=<code>
status=<completed|failed>
cwd=<cwd>
outputFilePath=<path>
outputBytes=<n>
outputLines=<n>
truncated=<true|false>
omittedLines=<n, if truncated>
returnCodeInterpretation=<optional>
preview:
<full output if <=200 lines, otherwise first 100 lines, omission marker, last 100 lines>
```

后台命令：

```text
Bash command is running in background.
taskId=<id>
command=<command>
cwd=<cwd>
outputFilePath=<path>
Use Read on outputFilePath to inspect current output.
```

超过前台等待阈值自动后台：

```text
Bash command exceeded foreground timeout and is still running.
taskId=<id>
timeoutMs=<n>
outputFilePath=<path>
Use Read on outputFilePath to inspect current output.
```

## Event Log 设计

在现有事件基础上，`tool.raw_result` 已经能保存 Bash raw result。建议额外增加专门事件，便于 TUI 和后续任务面板展示：

```ts
| { type: "bash.task.started"; taskId: string; command: string; outputFilePath: string }
| {
    type: "bash.task.progress";
    taskId: string;
    outputBytes: number;
    outputLines: number;
    preview: string;
    truncated: boolean;
    omittedLines?: number;
  }
| { type: "bash.task.finished"; taskId: string; status: string; exitCode?: number }
```

第一版最低要求：

- `tool.raw_result` 必须包含 `taskId`、`outputFilePath`、`status`。
- JSONL 里可以恢复每次 Bash 的执行状态和输出路径。
- TUI 可以先只展示 `Bash <description>` 和最终 ok/failed。

## Tool Registry 集成

`createDefaultTooling()` 增加 Bash tooling state：

```ts
export type BashToolingState = {
  cwd: string;
  tasks: Map<string, ShellTask>;
  runId: string;
  workspaceRoot: string;
};
```

然后注册：

```ts
registry.register(
  createBashToolExecutor({
    workspaceRoot: options.workspaceRoot,
    runId: options.runId,
    state: bashState,
  }),
);
```

这意味着 `createDefaultTooling()` 需要接收 `runId`。当前 runner 已经有 `config.runId`，可以直接传入。

## 实现切分

第一步：Bash 最小前台执行

- 新增 `src/tools/bash.ts`。
- 支持 schema、参数校验、spawn、timeout、输出落盘。
- 加入 exit code 语义修正。
- 注册进 `createDefaultTooling()`。
- ObservationBuilder 支持 Bash raw result。

第二步：统一任务模型和自动后台

- 新增 `ShellTaskManager`。
- 所有 Bash 都创建 task。
- `run_in_background` 立即返回。
- 前台超时自动 background。
- 输出文件持续可读。

第三步：cwd 持久化

- 增加 `BashToolingState.cwd`。
- 包装命令捕获 `pwd -P`。
- 前台完成后更新 cwd。
- 后台完成不更新 cwd。

第四步：TUI / run 展示优化

- stdout printer 展示 `Bash desc=<description> task=<taskId>`。
- TUI timeline 展示 Bash 命令状态。
- 可选增加 background tasks 面板。

第五步：可选 TaskOutput 工具

- 如果 `Read(outputFilePath)` 不够用，再加 `TaskOutput`。
- 支持 `block=false` 查询状态。
- 支持 `block=true` 等待完成。

## 测试计划

聚焦测试：

- `Bash` schema 拒绝缺失 `command` 和非法 `timeout`。
- `echo hello` 生成 output file，observation 返回路径和 preview。
- 非零退出默认 `ok=false`。
- `grep missing existing.txt` 无匹配 exit 1 按 `ok=true` + `No matches found` 处理。
- `diff` exit 1 按 `ok=true` + `Files differ` 处理。
- `run_in_background: true` 立即返回 running task，输出文件稍后出现内容。
- 前台 timeout 后命令转后台而不是被 kill。
- `cd subdir` 后下一次 Bash 的 cwd 变化。
- 后台命令里的 `cd` 不影响全局 cwd。
- 输出不超过 `200` 行时，preview 包含完整已捕获输出。
- 输出超过 `200` 行时，preview 包含前 `100` 行、省略标记和最后 `100` 行，`truncated=true`，`omittedLines` 为中间省略行数。
- 大输出不进入完整 observation，只落盘并提供行级 preview 和完整输出路径。

验证命令：

```bash
bun test src/__tests__/bash-tool.test.ts
bun run typecheck
bun run check
```

## 关键取舍

- 先不做安全和权限：实现简单，但只适合可信本地使用。
- 所有输出落盘：牺牲一点磁盘空间，换来模型上下文稳定和可复访。
- timeout 默认转后台：更适合 agent loop，但需要任务管理和输出文件生命周期。
- 保存 cwd：更符合模型直觉，但只保存 cwd，不保存 shell 变量和 alias。
- 不做 `sed -i` 特殊处理：实现简单，但仍应在 prompt 中鼓励模型使用 `Write` 做文件修改。
