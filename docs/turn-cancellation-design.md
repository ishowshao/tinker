# Esc 中断当前 Turn 设计方案

## 文档状态

- 日期：2026-07-10
- 状态：已实施（2026-07-10）

本文保留实施前的问题分析与阶段边界；“实施前实现基线”一节描述的是功能落地前的代码，
不代表当前 runtime。

## 背景

Tinker 的 `ShellTaskManager` 负责 Bash 进程组、后台任务状态、主动停止和 runner
退出清理，`TaskList`、`TaskOutput`、`TaskStop` 以及后台任务 TUI 面板也已经落地。

实施前缺少 turn 级运行控制：TUI、agent loop、`ModelClient` 和 `ToolRuntime` 之间没有
贯通取消信号，模型请求或前台 Bash 卡住时只能等待调用结束或退出整个 Tinker。现在这些
边界已通过 `AbortSignal`、`TurnCancelledError`、协议安全的 tool completion 和
`ShellTaskManager.cancelForegroundTask()` 落地。

本文第一版只实现 TUI 中按 `Esc` 取消当前 turn，不退出 TUI，不撤销已经发生的副作用，
也不提前实现 session 持久化、context 统计或 compaction。

## 目标

- TUI 正在执行 turn 时，`Esc` 可以取消当前模型请求。
- 前台 Bash 正在执行时，取消会终止 Bash 进程组并等待输出收尾。
- Grep、Web、MCP 等可中断工具接入同一个取消信号。
- 文件工具等不适合在任意时刻强制打断的操作，在一致性安全边界响应取消。
- 取消与普通失败使用不同的 result 和 `run.cancelled` 事件。
- 取消后的模型消息历史仍满足 tool call / tool result 配对要求。
- 已完成的工具结果、文件修改和已进入后台的任务继续保留。
- 取消收尾完成后重新启用输入框，可以立即提交下一条请求。
- 同一次 turn 重复按 `Esc` 是幂等操作，不重复停止进程或发送事件。

## 非目标

- 不撤销 Write、Edit、Bash 或 MCP 已经产生的外部副作用。
- 不因为取消 turn 而停止已经进入后台的 Bash；仍使用 `TaskStop` 显式停止。
- 不支持取消后恢复同一个模型流或从中断位置继续执行。
- 不在第一版增加 one-shot CLI 的 `Ctrl-C` 取消协议。
- 不实现同时运行多个前台 turn，也不引入子 agent 或并行 tool call。
- 不强制打断任意同步 JavaScript、JSON 解析或已经进入文件写入临界区的代码。
- 不持久化取消状态；session 恢复属于阶段三。
- 不新增取消超时环境变量；前台 Bash 继续复用 task manager 的停止宽限期。

## 实施前实现基线

阶段二需要基于已经落地的代码接口实施，而不是重新实现阶段一：

1. `src/tui/app.tsx` 用 `isRunning` 防止重复提交，并在运行期间把
   `PromptInput` 整体禁用。当前 `Esc` 只在输入可用时用于关闭 slash command
   建议列表。
2. `src/agent/loop.ts` 顺序执行 model step 和 tool calls。模型异常被直接转换成普通
   `RunAgentResult` 失败；工具执行没有取消分支。
3. `ModelClient.step()` 和 `ToolExecutor.execute()` 都没有 execution context。
   `ToolRuntime` 会把所有 executor 异常转换成 `ok: false` raw result，因此如果直接让
   `AbortError` 穿过工具，它也会被误记为普通工具失败。
4. `OpenAIChatModelClient` 使用的本地 OpenAI SDK 已支持在
   `chat.completions.create()` 的 request options 中传入 `signal`。
5. 当前 MCP SDK 的 `callTool()` request options 同样支持 `signal`，可以向支持取消的
   MCP server 发送协议级取消。
6. `ShellTaskManager` 已使用独立 POSIX 进程组，`StopTaskReason` 也已经预留
   `turn_cancelled`，SIGTERM、SIGKILL 升级和日志 flush 可以直接复用。
7. `Bash` 的前台等待目前只有 `completed` 和 `timeout` 两种结果。timeout 后任务会被
   标记为后台任务，之后不应再被 turn 取消。
8. `run.started`、`run.finished` 和 `run.failed` 已进入 JSONL、observation log 和 TUI
   event stream，但还没有取消事件。
9. TUI runner 会把每轮 `result.messages` 保存到内存中的 `sessionMessages`。如果取消
   发生在一组 tool calls 中间，必须先补齐消息结构，下一轮才能安全复用这些消息。

## 用户可见语义

### 按键行为

- TUI 空闲时，`Esc` 继续保留现有输入行为，例如关闭 slash command 建议列表。
- turn 运行时，第一个 `Esc` 发起取消；若取消收尾跨过至少一次实际渲染，App 用本地
  瞬态显示 `cancelling`，瞬间完成时允许直接显示 `cancelled`。
- 取消请求发出后再次按 `Esc` 不执行额外动作。
- 输入框在取消收尾完成前保持禁用；完成后 footer 显示 `cancelled` 并重新可用。
- 下一次提交 `run.started` 后，footer 从 `cancelled` 正常回到 `running`。

### “取消完成”的定义

按下 `Esc` 只代表发起取消。满足以下条件后，当前 turn 才算取消完成：

- 当前模型请求已经拒绝或返回，不能再向本轮追加 assistant 输出。
- 当前可中断工具已经停止；如果是前台 Bash，整个进程组已经退出。
- 已经完成的工具事件和 observation 已经写完。
- 当前 assistant tool call batch 已补齐为协议合法的消息序列。
- `run.cancelled` 已经提交到共享 event sink。

满足这些条件后再 resolve `run()`，由 `App` 重新启用输入框。Bash 收到 SIGTERM 后
需要等待阶段一已有的宽限期；如果进程拒绝退出，升级 SIGKILL 后才完成取消。

### 副作用边界

取消是“停止继续执行”，不是事务回滚：

- 已完成的 Read、Grep、Web 等结果保留在 timeline、日志和本轮消息中。
- 已完成的 Write、Edit 和 Bash 副作用保留。
- 正处于文件写入临界区时不强行打断，先完成一次一致的文件和 snapshot 更新，再在
  下一个安全边界结束 turn。
- 显式后台 Bash 已经进入启动提交临界区时，先完成 task 启动、后台标记和结果提交，
  再在下一个安全边界结束 turn。
- 已经标记为 `requested` 或 `foreground_timeout` 的后台 Bash 保持运行。
- 尚未开始的 tool calls 不执行。

## 总体设计

每次 TUI submit 创建一个独立 `AbortController`。signal 作为 turn execution context
从 UI 一直传到模型和工具；Bash 再把取消转换成 task manager 的进程组停止操作。

```text
Ink App useInput(Esc)
  -> AbortController.abort(TurnCancelledError)
       -> TUI runner run(prompt, signal)
          -> runAgent(signal)
             ├─ ModelClient.step(..., { signal })
             └─ ToolRuntime.execute(..., { signal })
                ├─ interruptible tool API
                └─ Bash
                   -> ShellTaskManager.cancelForegroundTask()
                      -> SIGTERM process group
                      -> grace period
                      -> SIGKILL when needed
                      -> wait close and output flush
```

核心约束：

- 一个 turn 只有一个 signal，所有层只观察它，不派生互相独立的用户取消状态。
- `signal.aborted` 是识别用户取消的事实来源，不依赖不同 SDK 的错误名称或文本。
- event sink 不跟随 signal 中断。已经开始提交的事件必须完整写入。
- 工具 raw result、observation 和 tool message 作为一个提交边界；提交后才检查是否停止
  下一项工作。
- `cancelling` 只是 App 对已发出取消请求的本地展示覆盖；持久的 TUI run 状态仍全部
  来自 event store。
- `ShellTaskManager` 仍是 Bash 进程状态和终止动作的唯一事实来源。

## 统一取消契约

### Execution context

建议增加明确且必传的 context，避免每个调用点自行读取全局状态：

```ts
export type ModelStepOptions = {
  signal: AbortSignal;
};

export type ToolExecutionContext = {
  signal: AbortSignal;
};

export interface ModelClient {
  step(
    input: ModelStepInput,
    options: ModelStepOptions,
  ): Promise<ModelStepOutput>;
}

export type ToolExecutor = {
  definition: ToolDefinition;
  execute(
    args: unknown,
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolRawResult>;
};
```

`RunAgentInput` 增加必填 `signal`，`ToolRuntime.execute()` 也要求传入同一个 context。
one-shot runner 和不测试取消的单元测试仍创建普通 `AbortController`，只是不调用
`abort()`。不使用可选 signal 或静默 fallback，漏接调用点应由 TypeScript 立即暴露。

### 取消错误

新增 `src/agent/turn-cancellation.ts`，集中提供：

```ts
export class TurnCancelledError extends Error {}

export function throwIfTurnCancelled(signal: AbortSignal): void;

export function cancellationError(
  signal: AbortSignal,
  cause?: unknown,
): TurnCancelledError;
```

TUI 使用 `controller.abort(new TurnCancelledError(...))`。外部 SDK 可能抛出自己的
`AbortError`，catch 时按以下顺序判断：

1. 如果 turn signal 已 aborted，统一抛出 `TurnCancelledError`。
2. 否则按模型失败或工具失败处理原始异常。

`ToolRuntime` 必须在 executor 调用前 fast-fail；catch 到异常时，如果 signal 已取消，
继续向 `runAgent` 抛出取消错误，不能包装成 `ok: false` raw result。非取消异常维持现有
工具失败行为。

### RunAgentResult

把当前二态 result 改成清楚的三态 discriminated union：

```ts
export type TurnCancellation = {
  source: "user";
  phase: "model_request" | "tool_execution" | "agent_boundary";
  step: number;
  toolCallId?: string;
  toolName?: string;
};

export type RunAgentResult =
  | {
      status: "completed";
      finalText: string;
      messages: AgentMessage[];
    }
  | {
      status: "failed";
      error: string;
      messages: AgentMessage[];
    }
  | {
      status: "cancelled";
      cancellation: TurnCancellation;
      messages: AgentMessage[];
    };
```

这里不把取消编码成带特殊 error 文本的 `ok: false`。runner 和测试必须穷举三种
status，新增状态漏处理时让 TypeScript 报错。

## Agent loop 取消点

`runAgent()` 在以下位置检查 signal：

1. 进入 loop 前。
2. 发送 `model.step.started` 后、调用模型前。
3. 模型 promise 返回后、接纳 model output 前。
4. 每个 tool call 开始前。
5. 一个 tool call 的 raw result、observation 和 tool message 全部提交后。
6. 进入下一 model step 前。

事件提交本身不响应 signal。这样一个已经返回 raw result 的工具不会只写一半事件，
也不会缺少对应的 model-visible observation。

模型调用或工具调用抛出异常时，`runAgent()` 先检查 signal：signal 已取消就返回
`status: "cancelled"`；否则返回普通 `status: "failed"` 或沿用现有工具失败 raw
result 规则。

### 多 tool call 的消息完整性

OpenAI chat 消息要求 assistant 发出的每个 tool call 后面都有对应 tool message。
当前 tool calls 顺序执行，取消可能发生在第二个 tool 执行期间，不能把缺少结果的
assistant message直接存入 `sessionMessages`。

第一版采用“补齐未完成 batch”的策略：

- 已成功提交 observation 的 tool call 保留真实 tool message。
- 正在执行且被 signal 中断的 tool call 补一条内部 tool message：
  `Tool execution was cancelled by the user. Side effects may have partially completed; inspect current state before retrying.`
- 本 batch 中尚未开始的 tool calls 分别补一条内部 tool message：
  `Tool call was skipped because the user cancelled the turn.`
- 这些补齐消息只用于保持后续模型上下文合法，不伪造 raw result，也不发送
  `tool.finished`。
- `run.cancelled` 记录当前 active tool；TUI 用它把仍为 running 的 timeline item
  改成 cancelled。

如果取消发生在模型请求阶段，还没有 assistant tool call，保留本轮 user message，
不生成虚构 assistant 回复。下一轮可以出现连续两条 user message，模型仍能看到用户
取消前的原始目标，例如后续输入“先不要执行，解释一下”。

TUI runner 对三种 result 都更新 `sessionMessages = result.messages`。取消后的 batch
已经补齐，因此下一次请求不需要丢弃整轮历史，也不会重复已经完成的工具。

## ModelClient 取消

`OpenAIChatModelClient.step()` 把 signal 作为 SDK request option 传入：

```ts
await client.chat.completions.create(body, {
  signal: options.signal,
});
```

模型请求取消后不发送 `model.step.finished`，因为没有可接纳的完整 model output。
最终由 `run.cancelled` 关闭 TUI 中对应的 model timeline item。

`FakeModelClient` 和测试模型也接收 `ModelStepOptions`。涉及取消的 fake model 应等待
signal 并抛出取消错误，不能只用一个永不结束的 Promise，否则测试会泄漏挂起任务。

WebFetch 的 model refiner 同样传递当前工具的 signal，避免主页面已经获取完成但
refine 请求仍阻塞取消。

## ToolRuntime 与普通工具

### 安全边界原则

普通工具分成三类处理：

| 类型 | 第一版取消行为 |
| --- | --- |
| 网络、子进程、MCP 请求 | 把 signal 传给底层 API，尽快中断等待 |
| 只读文件和内存处理 | 操作前后检查 signal，在一致结果边界结束 |
| Write、Edit 等修改操作 | 写入前检查；进入写入和 snapshot 更新临界区后完成本次提交，再取消后续工作 |

不要求每个同步循环内部都插入检查。工具如果已经返回一个一致的 raw result，agent loop
先完整记录该结果，再停止本 turn。

### Grep

`ripGrep()` 和内部 `runRipgrep()` 增加 signal，传给 `execFile`。用户取消导致的
AbortError 重新向上抛出；现有 20 秒 timeout 和 maxBuffer 仍转换成 Grep raw result。
如果第一次执行因为 EAGAIN 准备单线程重试，重试前先检查 signal。

### WebSearch 与 WebFetch

当前网络工具只使用 `AbortSignal.timeout()`。阶段二将 turn signal 与 timeout signal
组合后传给 `fetch`，并明确区分：

- turn signal aborted：抛出取消错误。
- timeout signal aborted：保留现有 timeout raw error。
- 普通网络异常：保留现有失败结果。

`WebFetchBackend.fetch()`、browser backend 和 `Refiner.refine()` 都增加 execution
context。browser backend 在取消时关闭 `Bun.WebView`；重定向、fallback backend 和
refine 之间均检查 signal。被取消的请求不写入 WebFetch cache。

### MCP

`createMcpToolExecutor()` 将 signal 传给：

```ts
client.callTool(params, undefined, {
  timeout: timeoutMs,
  signal: context.signal,
});
```

SDK 会取消本次 request；MCP 连接和 server 进程仍由 session 级 `McpManager` 持有，
不会因为取消一个 turn 而 dispose。signal 已取消时，executor 重新抛出取消，不转换成
普通 `McpToolRawResult` 错误。

### Task 管理工具

- `TaskList` 和 `TaskOutput` 在执行前后检查 signal。
- `TaskStop` 一旦已经向后台任务发出停止请求，就完成已有停止流程并返回最终 snapshot；
  turn 随后在安全边界取消。取消不能“撤销”已经明确发出的 TaskStop。
- `TaskStop` 不因为 signal 而停止其他后台任务。

## 前台 Bash 取消

### 三态等待结果

把当前 `waitForTask()` 的 `snapshot | undefined` 改为明确的三态结果：

```ts
type ForegroundWaitResult =
  | { type: "completed"; task: ShellTaskSnapshot }
  | { type: "timeout" }
  | { type: "cancelled" };
```

等待同时监听 `task.completion`、foreground timeout 和 turn signal，并在结束后清理
timer 与 abort listener。先进入提交分支的一方决定任务归属：

```text
completed
  -> 构建正常 Bash raw result

timeout
  -> markBackgrounded(foreground_timeout)
  -> 后续 turn 取消不再停止该任务

cancelled
  -> cancelForegroundTask(taskId)
  -> 等待进程退出、输出 flush 和 cwd 临时文件清理
  -> 向 agent loop 抛出 TurnCancelledError
```

### 复用 ShellTaskManager

建议为 manager 增加内部运行控制 API：

```ts
cancelForegroundTask(taskId: string): Promise<ShellTaskSnapshot>;
```

它使用已经存在的 `beginStop(..., "turn_cancelled")` 和进程组终止实现，但处理取消与
自然退出的竞争：

- `running`：进入 stopping，发送 SIGTERM，必要时升级 SIGKILL。
- `stopping`：等待现有 stop promise 或 completion，不重复发信号。
- terminal：直接等待/返回最终 completion，不把自然完成改写成 killed。

该方法不要求 task 已经 backgrounded，也不会为从未进入后台的前台 Bash 发送
`bash.task.*` 面板事件。TaskStop 继续使用严格 `stopTask(..., "tool")`，对 terminal
task 维持 fast-fail，不为兼容取消竞态而放宽模型工具语义。

### 后台所有权边界

对于 `run_in_background: true`，参数解析与执行前 signal 检查完成后，以下步骤视为
一个不可中断的后台启动提交临界区：

```text
taskManager.start()
  -> markBackgrounded(taskId, "requested")
  -> inspect task and build Bash raw result
  -> agent loop commits raw result, observation and tool message
```

临界区内不再次检查 turn signal，也不把 signal 传给 `start()` 或
`markBackgrounded()`。如果用户在 `start()` 返回后、后台标记完成前按下 `Esc`，仍先
完成后台标记并返回包含 task ID 的一致结果；agent loop 提交该工具结果后，再在统一
安全边界结束 turn。

这样不会产生“进程已经启动，但既不属于前台等待、也没有后台身份”的悬空状态，也
不会丢失后续管理任务所需的 task ID。`markBackgrounded()` 完成后，task 由 session
级 manager 管理，当前 turn 的 signal 不再终止它；任务继续出现在 TaskList 和 TUI
面板中。

foreground timeout 同理。一旦三态等待选择 `timeout` 分支，从 timeout 胜出到
`markBackgrounded(taskId, "foreground_timeout")`、构建并提交 Bash result 也属于
不可中断的所有权提交。即使用户紧接着按下 `Esc`，也只取消 agent 后续步骤，不停止
该任务。

只有三态等待明确选择 `cancelled` 分支时才调用 `cancelForegroundTask()`。因此
`markBackgrounded()` 是后台所有权切换点，而“标记加结果提交”是对外可见的一致性
边界。

## 事件与日志

新增顶层事件：

```ts
type RunCancelledEvent = {
  type: "run.cancelled";
  cancelledAt: string;
  cancellation: TurnCancellation;
};
```

事件规则：

- 每个被取消的 turn 只发送一次。
- 不增加 `run.cancelling`；取消请求到终态之间的展示由 App 本地瞬态负责。
- 不同时发送 `run.failed` 或 `run.finished`。
- 模型或 active tool timeline 的取消由该事件携带的 step、toolCallId 和 toolName 定位。
- 已经完成的 `model.step.finished`、`tool.finished` 和 `tool.observation` 保留原样。
- 后台 task lifecycle event 不受影响，取消完成后仍可以继续进入 TUI event stream。

各 sink 行为：

- `JsonlEventLog` 自动记录完整结构。
- `ObservationTextLog` 增加 `## Cancelled` 段，记录阶段、step 和 active tool。
- `StdoutEventPrinter` 增加稳定的一行摘要，方便复用 runner 测试；第一版 one-shot 不会
  主动生成该事件。
- `TuiEventStream` 沿用共享串行 sink，不增加第二套取消状态源。

取消不是 tool raw failure，因此 active tool 不发送伪造的 `tool.raw_result`，也不发送
`tool.finished ok=false`。消息补齐使用的内部 tool message 与运行观测分离。

## TUI 与 runner

### App

`AppProps.run` 调整为：

```ts
run(prompt: string, signal: AbortSignal): Promise<RunAgentResult>;
```

`App` 为每次非 slash command submit 创建 controller，并用 ref 保存当前 controller。
同时维护本地 `isCancelling` 展示态，在 `isRunning` 时启用 App 层 `useInput`：

- 收到 `Esc` 且 signal 未取消：调用 `abort()`，notice 显示
  `Cancelling current turn...`，并把 `isCancelling` 设为 true。
- signal 已取消：忽略重复按键。
- promise settled：只有 ref 仍指向本次 controller 时才清理 ref、`isRunning` 和
  `isCancelling`。runner 必须先提交对应终态事件，再让 promise settle。

`PromptInput` 在运行期间继续禁用，因此 App 层的 Esc handler 不会与建议列表 handler
竞争。空闲时 App handler 不激活，现有输入 Esc 行为不变。

### TUI state 与本地展示态

`TuiState.status` 和 timeline item status 只增加 `cancelled`，不增加 `cancelling`。
`TuiState` 继续完全由 `applyAgentEvent()` 驱动：按下 `Esc` 后、`run.cancelled` 到达前，
event store 中的 run 状态仍是 `running`。

`cancelling` 是 App 本地瞬态，来源只有 `activeController.signal.aborted` 对应的
`isCancelling`。App 给 Footer 传入一个展示覆盖值：

```ts
const footerStatus = isCancelling ? "cancelling" : state.status;
```

Footer 的 props 可以接受 `cancelling`，但 event store、JSONL 和 run lifecycle 都不
保存这个瞬态。runner 先提交 `run.cancelled`，再 resolve `run()`；event store 因此先
接收并把真实状态改为 `cancelled`，App 随后在 promise settled 清除
`isCancelling`，Footer 以 event store 为准显示 cancelled。新 turn 提交时也必须先
清除旧的本地覆盖。

这不是第二套 run 状态机：App 只表达“用户已经按下 Esc、终态事件尚未到达”的短暂
UI 反馈，所有可回放、可记录的终态仍以事件为唯一事实来源。

`run.cancelled` 到达时：

- model request 阶段：把本 step 仍为 running 的 model item 改为 cancelled。
- tool execution 阶段：把指定 tool call item 改为 cancelled。
- agent boundary：只追加 `turn cancelled` info item，不覆盖已完成工具状态。
- 顶层 TUI status 变为 cancelled。

建议 cancelled 使用 gray，表示用户控制动作，不显示为红色错误。

### TUI runner

runner 的 `run(userPrompt, signal)` 将 signal 传给 `runAgent()`，然后按 result.status
提交唯一的终止事件：

```text
completed -> run.finished
failed    -> run.failed
cancelled -> run.cancelled
```

三种结果都更新内存 `sessionMessages`。runner 不在 catch 中把取消重新记录成
`run.failed`。只有 event sink 或其他非取消基础设施异常才继续抛出。

取消当前 turn 不调用 `tooling.dispose()` 或 `mcpManager.dispose()`；这两个 session
级资源仍只在 TUI 退出时清理。

## 文件级实施清单

| 文件 | 主要变更 |
| --- | --- |
| `src/agent/turn-cancellation.ts` | 新增统一取消错误和 signal 检查 |
| `src/agent/types.ts` | 三态 `RunAgentResult` 和 `TurnCancellation` |
| `src/agent/loop.ts` | signal 检查、取消分类、tool batch 消息补齐 |
| `src/model/model-client.ts` | 增加必传 `ModelStepOptions` |
| `src/model/openai-chat-model-client.ts` | OpenAI request option 传 signal |
| `src/model/fake-model-client.ts` | 跟进新接口，支持取消测试 |
| `src/tools/types.ts` | 增加 `ToolExecutionContext` |
| `src/tools/registry.ts` | ToolRuntime 传递 signal 并保留取消异常 |
| `src/tools/bash.ts` | 三态前台等待和取消分支 |
| `src/tools/bash-task.ts` | `cancelForegroundTask()`，复用进程组停止原语 |
| `src/tools/ripgrep.ts`、`src/tools/grep.ts` | 取消 rg 子进程，区分 timeout 与 turn 取消 |
| `src/tools/web-search.ts` | 合并 timeout 和 turn signal |
| `src/tools/web-fetch/*` | backend、browser 和 refiner 贯穿 signal |
| `src/mcp/mcp-tool-executor.ts` | `callTool()` 传 signal，保留取消异常 |
| `src/events/types.ts` | 新增 `run.cancelled` |
| `src/events/observation-text-log.ts` | 人类可读的取消段落 |
| `src/events/stdout-event-printer.ts` | 取消摘要 |
| `src/tui/app.tsx` | controller、运行中 Esc、本地 cancelling 展示覆盖 |
| `src/tui/event-store.ts` | 只保存事件驱动的 cancelled 状态和 active item 收尾 |
| `src/tui/components/footer.tsx` | 接受 App 覆盖的 cancelling 或 event store 的终态 |
| `src/cli/tui-runner.tsx` | 传 signal，按三态提交终止事件和保存消息 |
| `src/cli/run-runner.ts` | 为共享 `runAgent` 接口提供未取消 signal |

Write、Edit、Read、Glob、TaskList、TaskOutput 和 TaskStop 只需按各自安全边界接收
`ToolExecutionContext`，不另建工具专用 cancellation token。

## 测试计划

### 取消契约

- `runAgent` 在进入时 signal 已取消，不调用模型并返回 cancelled。
- `ToolRuntime` 在执行前已取消时不调用 executor。
- executor 抛错且 signal 未取消时仍得到普通 tool failure。
- executor 因 signal 取消时异常不会被包装成 raw failure。
- 同一 controller 重复 abort 只产生一个 `run.cancelled`。

### 模型请求

- 使用等待 signal 的 fake model，Esc/abort 后及时返回 cancelled。
- 取消模型请求不发送 `model.step.finished`、`run.failed` 或 `run.finished`。
- 当前 user message 保留在 result.messages。
- OpenAI client 单元测试验证 request options 收到同一个 signal。

### Tool batch 与消息历史

- 第一个 tool 完成、第二个 tool 被取消、第三个未开始时：第一个保留真实 observation，
  后两个各有正确的内部 tool message。
- 所有 assistant toolCall ID 在 result.messages 中恰好有一个对应 tool message。
- 取消发生在一个工具完成后的 agent boundary 时，该工具仍显示成功。
- 取消结果作为下一轮 initialMessages 时，OpenAI message mapping 可以正常序列化。

### 前台 Bash

- 取消简单 `sleep` 后状态为 killed，取消返回前日志已经 flush。
- 取消包含孙进程的前台 Bash 后，shell 和孙进程都不存在。
- 忽略 SIGTERM 的前台任务会升级 SIGKILL。
- 自然退出与 cancel 竞争时保留真实 terminal snapshot，不重复发信号。
- 取消的前台 Bash 不出现在 TaskList，也不产生后台面板 lifecycle event。
- foreground timeout 先完成所有权切换后再取消，任务继续运行，最后由 TaskStop 清理。
- 在 `run_in_background: true` 的 start 与 markBackgrounded 之间触发取消，仍会完成
  后台标记、提交带 task ID 的 Bash result，且不会调用 `cancelForegroundTask()`。
- foreground timeout 分支胜出后触发取消，同样先完成后台标记和结果提交。

### 其他工具

- Grep 取消会终止 rg 子进程，且不被报告成 timeout。
- WebSearch、WebFetch、browser fallback 和 refiner 都观察同一个 signal。
- 取消 WebFetch 不写 cache；下一次相同请求仍实际执行。
- MCP callTool 收到 signal；取消 call 不 dispose MCP connection。
- Write/Edit 在写入前取消时不修改文件；进入提交临界区后取消时文件与 snapshot 保持
  一致，并在边界后结束 turn。

### TUI 和事件

- 运行中按 Esc 触发一次 abort；若取消收尾仍在进行则显示 cancelling，瞬间完成时可直接
  显示 cancelled，完成后输入重新可用。
- running 状态重复按 Esc 不重复调用 abort。
- 空闲时 Esc 仍关闭 slash command 建议。
- 按 Esc 后、`run.cancelled` 前若存在可渲染间隔，`TuiState.status` 仍为 running，
  Footer 通过 App 本地覆盖显示 cancelling。
- 收到 `run.cancelled` 后清除本地覆盖，Footer 显示 event store 的 cancelled。
- event stream 和 JSONL 中不产生 `run.cancelling`。
- `run.cancelled` 将 active model 或 tool timeline item 标为 cancelled。
- cancelled 使用灰色，不进入 failed 状态。
- 取消后可以提交下一条 prompt，且只启动一个新 turn。
- JSONL 与 observation log 都包含取消记录，JSONL 中没有同 turn 的 `run.failed`。
- 后台任务在取消前后继续更新面板状态。

### 建议验证命令

```bash
bun test src/__tests__/agent-loop.test.ts
bun test src/__tests__/turn-cancellation.test.ts
bun test src/__tests__/task-management.test.ts
bun test src/__tests__/mcp-tools.test.ts
bun test src/__tests__/web-search-tool.test.ts
bun test src/__tests__/web-fetch-tool.test.ts
bun test src/__tests__/tui-event-store.test.ts
bun test src/__tests__/tui-components.test.tsx
bun run check
```

## 手工验收

1. 启动 TUI，提交一个会让模型等待较久的请求，在模型响应前按 `Esc`。
2. 确认界面最终显示 cancelled；若取消收尾没有瞬间完成，应先显示 cancelling。整个过程
   没有 failed，输入框恢复可用。
3. 立即提交一个普通问题，确认仍在同一 TUI session 中正常响应。
4. 让 agent 执行前台 `sleep` 并输出自身及子进程 PID，在执行期间按 `Esc`。
5. 确认取消完成后父子进程都不存在，日志文件内容已经落盘。
6. 启动一个 `run_in_background: true` 的开发服务器，再取消后续 turn。
7. 确认服务器仍在 BackgroundTasks 面板中运行，TaskOutput 可查询，TaskStop 可停止。
8. 构造一次包含多个 tool calls 的 turn，在中间取消，再输入“检查当前状态”。
9. 确认模型能继续使用已经完成的结果，不出现缺少 tool result 的 provider 错误。
10. 检查 `.tinker/runs/<runId>.jsonl` 和 observation log，确认取消只记录为
    `run.cancelled`。

## 实际实施顺序

1. 增加取消 primitive、execution context、三态 result 和 `run.cancelled` 类型。
2. 接通 `runAgent` 与 ModelClient signal，先完成模型请求取消测试。
3. 实现 tool batch 安全边界和取消后的消息补齐。
4. 接入 `ShellTaskManager.cancelForegroundTask()` 和 Bash 三态等待，完成真实进程树测试。
5. 依次接入 Grep、Web、refiner 和 MCP 的底层 signal。
6. 在 TUI App 增加 controller 与运行中 Esc，补齐 event store、footer 和日志展示。
7. 更新 runner、现有 fake/test 调用点，运行完整 `bun run check`。
8. 按手工验收流程验证模型请求、前台 Bash、后台任务和取消后续聊。

实现过程中先保持每一层的取消分类明确，再向下一层贯通。不能先交付一个只让输入框
恢复、但底层模型请求或 Bash 仍在运行的 UI 快捷键。

## 关键取舍

- **每 turn 一个 AbortController**：UI 只有一个取消入口，模型和工具观察同一事实。
- **取消是第三种终态**：不依赖 error 文本识别，也不会污染失败统计和红色错误 UI。
- **协作式取消加安全边界**：网络和子进程立即中断，文件修改保持一次提交的一致性。
- **补齐 tool batch 而不是丢弃整轮**：保留已完成结果，同时保证下一次 provider 请求
  的消息协议合法。
- **前台 Bash 复用阶段一 manager**：进程组终止、SIGKILL 升级和输出收尾只有一套
  实现。
- **后台标记是所有权切换点**：进入后台后的任务不再从属于当前 turn。
- **事件写入不随 turn 取消**：取消本身及取消前已完成的动作都有完整审计记录。
- **输入恢复等待真实收尾**：避免用户看似开始下一轮，实际仍与上一个前台进程竞争。
