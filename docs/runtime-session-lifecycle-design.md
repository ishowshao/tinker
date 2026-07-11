# Runtime Session 生命周期设计

## 背景

Tinker 已经完成 Session、Turn、Iteration 和 ToolCall 身份模型。当前
`RuntimeSession` 负责分配这些身份、校验父子关系以及串行写入事件，但 session 级资源
仍由 `runOneShot()` 和 `runTui()` 分别组装：

- 两条 runner 分别创建持久化日志和展示 sink。
- 两条 runner 分别创建默认工具、`ShellTaskManager`、MCP manager、model client 和
  `ObservationBuilder`。
- 两条 runner 分别创建 turn、调用 `runAgent()`、发送 turn terminal event。
- TUI runner 自己保存跨 turn 的 `sessionMessages`。
- 两条 runner 分别决定资源释放顺序和 `session.finished` 的发送时机。

身份已经统一，但资源所有权和 turn 执行入口仍然重复。继续在这个结构上增加
SessionStore、`/resume` 和 compaction，会让 session 状态分散在 runner、agent loop 和
未来持久化组件之间。

本设计把现有 `RuntimeSession` 扩展为 session 级运行边界，并增加唯一的异步创建入口。
它不引入依赖注入容器，也不改变 agent loop、工具和 MCP 的领域边界。

## 目标

- one-shot 和 TUI 通过同一个 factory 创建完整的 runtime session。
- one-shot 和 TUI 通过同一个 `executeTurn()` 执行 turn 和发送 terminal event。
- session 级模型消息只由 `RuntimeSession` 保存和更新。
- 明确每项资源的 owner、创建顺序、释放顺序和初始化失败回滚行为。
- 普通退出、runner 初始化失败和 active turn 期间退出都能完成清理。
- `dispose()` 可以重复调用，只执行一次清理并返回同一个结果。
- 生命周期非法调用在入口处 fast-fail，不让半初始化或已释放的 session 继续运行。

## 非目标

- 本阶段不实现 SessionStore、`/resume`、context 统计或 compaction。
- 本阶段不修改 event sink 的可靠性分级和 fan-out 策略。
- 本阶段不实现多 turn 并发、session 分支或多 agent。
- 本阶段不增加 provider retry、model request identity 或模型 client 连接池。
- 本阶段不迁移旧 `.tinker` 数据，也不保留旧 runner 生命周期入口的兼容包装。
- 本阶段不承诺在 `SIGKILL`、宿主进程崩溃或断电后执行异步清理。

## 当前实现的具体问题

### 组装逻辑重复

`src/cli/run-runner.ts` 和 `src/cli/tui-runner.tsx` 都知道默认工具、MCP 和日志的完整
组装细节。新增一个 session 级组件时，需要同步修改两条入口，测试也无法通过一个公共
边界证明两种模式行为一致。

### Turn 所有权仍在 runner

两个 runner 都直接调用：

```text
createTurn
  -> turn.started
  -> runAgent
  -> turn.finished / turn.failed / turn.cancelled
```

TUI 还在 closure 中维护 `sessionMessages`。这使得 `RuntimeSession` 虽然拥有 turn identity，
却不拥有 turn 的完整生命周期和跨 turn 上下文。

### 初始化和释放不是一个事务

资源通过多个局部变量逐步创建。虽然当前 runner 已经覆盖了部分 `finally` 路径，但仍有
以下脆弱点：

- factory 在返回完整 manager 前抛错时，runner 无法释放 factory 内部已经创建的资源。
- 当前释放顺序是 tooling 后 MCP，不是创建顺序的严格逆序。
- 当前 MCP dispose 会静默吞掉 connection close 错误；如果改为按本设计上报错误，runner
  现有的顺序 `finally` 又会在 MCP dispose 抛错时跳过 `session.finished`。
- `RuntimeSession` 自身没有 idempotent dispose，也没有阻止 dispose 后继续创建 turn。
- TUI 和 one-shot 对 model client 的创建时机不同。

### 退出与 active turn 的关系未定义

当前常规 UI 会阻止运行中再次提交，但 lifecycle API 没有规定 session 在 active turn
期间被释放时应等待、报错还是直接终止资源。runner 不能依赖 UI 行为保证资源安全。

## 核心决定

### RuntimeSession 是唯一 session owner

`RuntimeSession` 同时拥有以下职责：

- Session、Turn、Iteration 和 ToolCall 身份分配与校验。
- session 内 event sequence 和事件串行提交。
- session 级 model messages。
- 单 turn 串行执行与 terminal event。
- 默认 tooling、`ShellTaskManager` 和 MCP manager 的生命周期。
- model client 和 `ObservationBuilder` 的 session 级复用。
- session 初始化回滚和最终释放。

它明确不负责：

- Ink render、组件状态、stdin 恢复和 `/quit` 展示行为。
- prompt history 的加载和写入。
- stdout 中最终回答的排版。
- one-shot exit code。
- Git branch 等纯 TUI 信息。

### 只保留一个生产创建入口

生产代码通过异步 factory 创建 session，不再直接 `new RuntimeSession(...)`：

```ts
type CreateRuntimeSessionInput = {
  sessionId: SessionId;
  workspaceRoot: string;
  modelName: string;
  maxIterations: number;
  includeReasoningContent: boolean;
  systemPrompt: string;
  modelClient: ModelClient;
  presentationSinks?: EventSink[];
  persistence?:
    | false
    | {
        eventLogPath?: string;
        observationLogPath?: string;
      };
  webFetchRefiner?: Refiner;
};

async function createRuntimeSession(
  input: CreateRuntimeSessionInput,
  dependencies?: RuntimeSessionFactoryDependencies,
): Promise<RuntimeSession>;
```

`modelClient` 保留为显式输入，避免 agent 层读取 provider 环境变量。CLI 侧用一个共享
helper 完成“测试注入优先，否则从环境创建”的选择，两条 runner 不再各自决定创建时机。

`presentationSinks` 是借用资源。one-shot 传入 `StdoutEventPrinter`，TUI 传入
`TuiEventStream`；session 向它们发送事件，但不负责 dispose。

持久化默认开启。`persistence: false` 只用于专门的单元或集成测试，不作为普通 CLI
配置。自定义 path 继续支持 `runOneShot()` 的测试入口。

测试通过 factory 的 dependency overrides 注入 fake tooling、MCP manager 和 ID factory：

```ts
type RuntimeSessionFactoryDependencies = {
  idFactory: RuntimeIdFactory;
  createTooling: typeof createDefaultTooling;
  loadMcpConfig: typeof loadMcpConfig;
  createMcpManager: typeof createMcpManager;
  createObservationBuilder: () => ObservationBuilder;
};
```

生产调用省略第二个参数并使用模块内默认实现。这个对象只列出 factory 真正需要替换的
构造边界，不提供按名称查找服务的通用 container。

`RuntimeSessionFactoryDependencies` 中需要 session 能力的 factory 只接收
`RuntimeSessionContext`，不能拿到 runner 的 `executeTurn()` 或 `dispose()`。

### Runner 和 runtime internal 使用不同 API 视图

factory 返回给 runner 的 `RuntimeSession` 是窄接口：

```ts
type ExecuteTurnInput = {
  userPrompt: string;
  signal: AbortSignal;
};

type RuntimeSession = {
  readonly sessionId: SessionId;
  executeTurn(input: ExecuteTurnInput): Promise<RunAgentResult>;
  dispose(reason: SessionDisposeReason): Promise<void>;
};
```

agent loop、model adapter、tooling 和 MCP 使用另一个内部视图：

```ts
type RuntimeSessionContext = {
  readonly sessionId: SessionId;
  createIteration(turn: TurnIdentity, iterationNumber: number): IterationIdentity;
  createToolCall(
    iteration: IterationIdentity,
    toolCallNumber: number,
  ): ToolCallIdentity;
  append(input: AgentEventInput): Promise<void>;
};
```

`createRuntimeSession()` 只返回 `RuntimeSession`，不把 `RuntimeSessionContext` 暴露给
runner。`runAgent()`、`ModelRequestOptions`、`createDefaultTooling()` 和
`createMcpManager()` 的参数都改为窄化后的 context 类型。这样 runner 无法在类型层调用
`append()` 伪造 turn event，也无法分配 iteration 或 tool call。

`createTurn()` 仅是实现类的 private method，不属于任一公开视图。turn identity 只能由
`executeTurn()` 在接受有效 prompt 后创建。“runner 不再发送 turn event”由编译器约束，
不只依赖代码约定。

`executeTurn()` 的 Promise 语义保持和 `runAgent()` 一致：

- `completed`、预期 agent failure 和 cancellation 返回结构化 `RunAgentResult`。
- 非法 lifecycle 调用、runtime invariant 和 event infrastructure failure 才 reject。

### 同一 session 最多执行一个 turn

本阶段不实现并行 turn。`executeTurn()` 在另一个 turn 尚未完成时直接抛出清晰错误，
不排队，也不隐式取消旧 turn。

这条约束既由 TUI 禁用输入保证，也由 RuntimeSession 自己校验。不能把 UI 状态当作
runtime invariant。

## 资源所有权

| 资源 | 创建者 | Owner | 释放方式 |
| --- | --- | --- | --- |
| JSONL event log | RuntimeSession factory | RuntimeSession | 当前无句柄；未来有 close 时由 session 调用 |
| Observation log | RuntimeSession factory | RuntimeSession | 当前无句柄；未来有 close 时由 session 调用 |
| stdout/TUI sink | runner | runner | RuntimeSession 只借用，不 dispose |
| model client | factory 输入 | RuntimeSession | 当前无 dispose；整个 session 复用 |
| ObservationBuilder | RuntimeSession factory | RuntimeSession | 无 dispose；整个 session 复用 |
| DefaultTooling | RuntimeSession factory | RuntimeSession | `dispose(reason)` |
| ShellTaskManager | DefaultTooling | DefaultTooling | 由 tooling shutdown，不单独释放 |
| MCP manager | RuntimeSession factory | RuntimeSession | `dispose()` |
| session messages | RuntimeSession | RuntimeSession | 内存状态；未来交给 SessionStore 持久化 |
| PromptHistory | TUI runner | TUI runner | 不属于 runtime session |
| Ink instance/stdin | TUI runner | TUI runner | 先退出 UI、恢复 stdin，再 dispose session |

只有 owner 可以主动释放资源。runner 不再直接持有或 dispose tooling 和 MCP manager。

## 生命周期状态机

```text
initializing
    |
    | factory 完整成功
    v
ready <---------------------+
  |                         |
  | executeTurn             | turn terminal event 已写入
  v                         |
executing ------------------+
  |  \
  |   \ dispose: abort active turn，等待其结束
  |    \
  |     v
  +--> disposing --> disposed

event infrastructure fatal error
  -> faulted -> disposing -> disposed
```

状态规则：

- `initializing` 只在 factory 内部可见，半初始化对象不能返回给调用方。
- 只有 `ready` 可以接受 `executeTurn()`。
- `executing` 时再次调用 `executeTurn()` fast-fail。
- `disposing` 后不再接受新 turn 或新 Bash task。
- `disposed` 后调用 `executeTurn()` fast-fail。
- `dispose()` 在任何非 disposed 状态都返回同一个 dispose promise。
- event sink 写入失败会把 session 标为 `faulted`；该 session 不再尝试执行新 turn。

`dispose()` 必须是普通方法而不是每次重新包装 Promise 的 `async` 方法：

```ts
dispose(reason: SessionDisposeReason): Promise<void> {
  this.disposePromise ??= this.performDispose(reason);
  return this.disposePromise;
}
```

第一次调用的 reason 生效。后续调用只返回原 promise，不改变 reason，也不重复发送
`session.finished`。

### 两阶段构造的封装

RuntimeSession 和 tooling 存在有意的构造环：session 拥有 tooling，而 tooling 中的
`ShellTaskManager` 需要 session context 发送事件。实现采用模块内两阶段构造，但不能把
“挂资源”暴露成公共 API：

```ts
class DefaultRuntimeSession implements RuntimeSession {
  private constructor(/* identity、event core 和纯值依赖 */) {}

  static async create(/* input、dependencies */): Promise<RuntimeSession> {
    const session = new DefaultRuntimeSession(/* ... */);
    // 只在本方法内把 session.context 交给 tooling/MCP factory，逐步挂载资源。
    // 全部成功并切到 ready 后，才以 RuntimeSession 窄接口返回。
    return session;
  }

  private readonly context: RuntimeSessionContext = {
    // 委托到 private identity/event methods
  };
}
```

`DefaultRuntimeSession` 不导出，constructor 为 private，资源字段和 attach 操作也保持
private。模块只导出接口与 `createRuntimeSession()`。因此生产代码无法直接 `new`、无法拿到
`initializing` 对象，也无法绕过 factory 构造一个缺少 tooling 或 MCP 状态的 session。

测试不增加 public `createBareRuntimeSession()`；通过 factory dependencies 注入 no-op 或
fake 资源，继续走相同的状态转换。

## 创建流程

### 正常创建

factory 按以下顺序执行：

```text
1. 校验 workspaceRoot、modelName、maxIterations、sessionId 和已传入的 model client
2. 创建 ObservationBuilder 和 event sinks
3. 创建 RuntimeSession identity/event core
4. 写入 session.started
5. 创建 DefaultTooling 和 ShellTaskManager
6. 加载 .mcp.json
7. 创建 MCP manager、连接 server、注册 MCP tools
8. 标记 ready 并返回 RuntimeSession
```

第 4 步同时作为持久化基础设施 preflight。JSONL 和 observation sink 必须排在
presentation sink 之前；`session.started` 无法写入时，不连接 MCP，也不执行任何可能
产生外部副作用的工具。

CLI 共享 helper 必须在调用 factory 前完成 model client 的环境配置校验，避免缺少
`API_KEY` 也留下一个看似成功启动的 session。MCP server 的 connected/failed 事件则发生在
`session.started` 之后。

`createDefaultTooling()` 的 `runtimeSession` 参数改为必填，删除当前为测试隐式创建
RuntimeSession 的 fallback。测试需要 runtime 时显式使用测试 factory，避免生产代码
产生两个互不关联的 session identity。

### 初始化失败回滚

factory 把资源创建视为一个小型 acquisition stack。任一步失败时，只释放已经成功创建的
资源，并严格按创建逆序执行：

```text
MCP manager
  -> DefaultTooling / ShellTaskManager
  -> session.finished(reason=initialization_failed，前提是 session.started 已成功)
  -> 持久化资源 close（当前没有长期句柄）
```

每个返回资源的子 factory 也必须具备局部异常安全：

- `createMcpManager()` 在返回 manager 前失败时，自己关闭已连接的所有 client。
- MCP 单个 server 连接失败继续沿用当前降级语义，发送 `mcp.server.failed` 后继续；配置
  解析失败、event 写入失败和 registry 冲突属于整个 session 初始化失败。
- `createDefaultTooling()` 如果未来增加可抛错的资源创建，也要在抛出前回滚自己的局部
  资源。

回滚不能因为前一个 dispose 失败而跳过后续步骤。所有步骤串行执行并收集错误；最终抛出
以原始初始化错误为首项的 `AggregateError`。如果只有原始错误，则直接保留原错误和
stack。

factory 记录 `session.started` 是否已经成功完成。只有 started 成功后才发送对应的
`session.finished`；如果 started 自身失败，不伪造一个从未成功开始的 session。后续持久化
sink 失败时，`session.finished` 可能无法落盘；factory 仍然必须尝试该事件和全部资源
清理，不能为了日志成功而重复初始化或吞掉原始错误。

## executeTurn 流程

### 正常路径

`executeTurn()` 执行以下唯一流程：

```text
1. 校验 state=ready、prompt 非空且没有 active turn
2. 创建内部 AbortController，并和调用方 signal 联动
3. 分配 turnId 和 turnNumber
4. 写入 turn.started
5. 调用 runAgent，传入 session messages、共享资源和 turn identity
6. 根据 RunAgentResult 写入且只写入一个 terminal event
7. terminal event 成功后提交 result.messages 为新的 session messages
8. 清除 active turn；若没有开始 dispose，恢复 ready
9. 返回 RunAgentResult
```

结果与 terminal event 的映射固定为：

| `RunAgentResult.status` | Event |
| --- | --- |
| `completed` | `turn.finished` |
| `failed` | `turn.failed` |
| `cancelled` | `turn.cancelled` |

两条 runner 不再发送这些事件，也不再直接调用 `runAgent()`。

### Session messages 提交规则

首个 turn 调用 `runAgent()` 时不传 `initialMessages`。后续 turn 使用上一个已完成
`executeTurn()` 提交的 `result.messages`。

`completed`、`failed` 和 `cancelled` 都提交 messages。取消时 agent loop 已补齐当前
assistant tool calls 对应的 tool messages；保留它们可以维持 provider 协议上下文完整。

model request 在产生 assistant message 前失败时，提交后的 messages 会以本 turn 的 user
message 结尾。下一个 turn 再追加 user prompt 后，可能出现连续两条 user message。本阶段
明确接受该结构，不插入虚假的 assistant message，也不丢弃失败 turn 的用户输入：

```text
system -> ... -> user(failed turn) -> user(next turn)
```

`AgentMessage` 和当前 OpenAI-compatible 出站映射都允许相邻的同 role message。若未来某个
provider 明确拒绝该结构，应在对应 provider adapter 设计可见的规范化规则，不在
RuntimeSession 中静默改写对话历史。

只有 terminal event 写入成功后才提交 messages。如果 event infrastructure 失败，session
进入 `faulted`，不允许下一个 turn 在“内存已前进、持久化事件未前进”的状态上继续。

本阶段 messages 仍保存在内存。未来 SessionStore 接入时，只替换第 7 步的提交实现，
不改变 runner API。

### 异常与 terminal event

`runAgent()` 应把正常模型失败、工具失败、max iterations 和取消转换成
`RunAgentResult`。如果它因 invariant 或其他未分类错误 reject，`executeTurn()` 发送一次
`turn.failed` 后重新抛出。

事件写入错误必须由 `RuntimeSession.append()` 包装成带 event type 的
`RuntimeEventAppendError`。遇到该错误时：

- 不再尝试补发 `turn.failed`，避免把日志基础设施失败描述为 agent 执行失败。
- 不为同一 turn 尝试第二个 terminal event。
- session 转为 `faulted`，只允许 dispose。

terminal event 在调用 `append()` 前就标记为 attempted。即使 terminal append 自身失败，
catch 路径也不能再选择另一个 terminal event。

## Active turn 与 dispose

`executeTurn()` 为每个 turn 创建内部 `AbortController`，并把调用方 signal 转发给它。
agent loop 和所有工具只接收这个内部 signal。

dispose 在 active turn 期间发生时：

1. 立即切换为 `disposing`，拒绝新 turn。
2. 以 `session_dispose` 原因 abort active turn。
3. 等待 `executeTurn()` 完成 terminal event 和消息提交。
4. 再释放 MCP 和 tooling。

`TurnCancellation.source` 从当前单一的 `"user"` 扩展为：

```ts
type TurnCancellationSource = "user" | "session_dispose";

class TurnCancelledError extends Error {
  readonly source: TurnCancellationSource;

  constructor(
    source: TurnCancellationSource,
    message = source === "user"
      ? "Turn cancelled by the user."
      : "Turn cancelled because the session is disposing.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TurnCancelledError";
    this.source = source;
  }
}
```

用户 Esc 仍为 `user`；session 退出导致的取消使用 `session_dispose`。两者都不回滚已经发生
的工具副作用。

取消来源通过内部 `AbortSignal.reason` 传递，不增加第二条并行状态通道：

```text
external signal abort
  -> internalController.abort(new TurnCancelledError("user", ...))

session dispose
  -> internalController.abort(new TurnCancelledError("session_dispose", ...))

runAgent cancellation boundary
  -> require signal.reason instanceof TurnCancelledError
  -> cancellation.source = signal.reason.source
```

`executeTurn()` 必须把任意外部 abort reason 规范化为 source=`user` 的
`TurnCancelledError`。agent loop 只接收内部 signal，因此在发现 aborted signal 却没有
typed reason 时 fast-fail；不再像当前 `cancellation()` 一样硬编码 `"user"`，也不通过错误
message 猜测来源。

外部 signal 联动遵守以下细节：

- 传入时已经 aborted：立即把 reason 转发给内部 controller；turn 仍按正常入口获得 identity
  和 `turn.started`，随后在第一个 cancellation boundary 返回 `turn.cancelled`。
- 传入时未 aborted：注册 `{ once: true }` listener。
- turn 无论 completed、failed、cancelled 还是 reject，都在 `finally` 中显式移除 listener；
  不能依赖 listener 只有触发后才自动移除。
- 外部取消和 dispose 竞态时以内部 controller 第一次成功 abort 的 reason 为准，后到的
  reason 不覆盖 source。

UI 创建 user cancellation 时也改为 `new TurnCancelledError("user")`。dispose 不伪造用户
Esc，而是直接以 `session_dispose` abort 同一个内部 controller。

dispose 不设置一个独立的短超时。现有模型、网络、MCP 和前台 Bash 已经接受
`AbortSignal`；如果以后发现某个资源不响应取消，应在该资源边界修复，而不是让 session
静默遗留任务。

## dispose 流程

### Dispose reason

```ts
type SessionDisposeReason =
  | { type: "oneshot_complete" }
  | { type: "tui_exit" }
  | { type: "runner_failed"; error: string }
  | { type: "initialization_failed"; error: string };
```

`initialization_failed` 只由 factory 内部使用。TUI prompt history、Ink render 或
`waitUntilExit()` 失败时使用 `runner_failed`。one-shot turn 返回 `failed` 仍属于一次完整
执行，使用 `oneshot_complete`，具体失败由 `turn.failed` 表达。

`session.finished` data 同步扩展为：

```ts
type SessionFinishedData = {
  reason: SessionDisposeReason["type"];
  error?: string;
};
```

### 确定释放顺序

正常和失败退出使用同一条 `performDispose()`：

```text
1. 禁止新 turn，并 abort/等待 active turn
2. dispose MCP manager
3. dispose DefaultTooling，shutdown 所有 Shell tasks
4. 写入 session.finished
5. close session-owned event resources（当前无长期句柄）
6. 标记 disposed
7. 如果有清理错误，抛出 AggregateError
```

MCP 在 tooling 之后创建，因此先释放 MCP。`session.finished` 必须在 tooling shutdown
之后发送，保证由 shutdown 产生的 `bash.task.stopping` 和 `bash.task.finished` 仍属于一个
尚未结束的 session。

每个步骤都必须执行，即使前一步失败。顺序保持串行，不用 `Promise.all()`，从而保证事件
顺序确定并让错误对应到具体释放阶段。

`session.finished` 只尝试一次。dispose promise 无论 fulfilled 还是 rejected 都被缓存；
重复调用不会重新关闭 client、重新发送进程信号或补发事件。

`McpManager.dispose()` 自身也改为 idempotent，并返回缓存的 close promise。连接关闭错误
不再逐个静默吞掉；manager 完成全部 close 尝试后把错误交给 RuntimeSession 汇总。

### Faulted session 的终止

`RuntimeSession.append()` 第一次遇到 event infrastructure failure 时，把对应的
`RuntimeEventAppendError` 保存为不可覆盖的 `faultCause`。后续 event failure 不能替换这个
最初原因。

从 `faulted` 进入 dispose 时仍执行完整清理，并仍然尝试一次 `session.finished`。已知 sink
损坏不是跳过 terminal event 的理由：某些瞬时错误可能已经恢复，而且 presentation sink
仍可能收到事件。为了允许这次 best-effort 终止，内部 cleanup append 可以在 `faulted` 或
`disposing` 状态运行；对外仍禁止新 turn。

错误汇总规则为：

1. `faultCause` 始终是最终错误列表第一项。
2. 随后按实际发生顺序追加 MCP、tooling、`session.finished` 和 event close 错误。
3. 只有 `faultCause` 时，dispose 以该原错误 reject。
4. 还有任一清理错误时，dispose 以 `AggregateError` reject，且第一项仍是
   `faultCause`。

因此 `session.finished` 再次 append 失败会被保留为后续 cleanup error，但不得掩盖、替换
或重新包装掉最初导致 session faulted 的错误。runner 汇总 execute 和 dispose 错误时同样
保留最初 runtime error 为第一原因，不能让 finally 中的错误覆盖 try/catch 中的主错误。

## Runner 收敛

### One-shot

`runOneShot()` 只保留 CLI 责任：

```text
read config
create stdout/stderr presentation sink
create RuntimeSession
disposeReason = oneshot_complete
try
  result = await session.executeTurn(...)
  completed 时打印 finalText
  根据 result 决定 exit code
catch error
  primaryError = error
  disposeReason = runner_failed(error)
  向 stderr 输出 runtime/initialization error
  exit code = 1
finally
  await session?.dispose(disposeReason)
  dispose 失败时 exit code = 1
return exit code
```

runner 不再 import `runAgent`、`ObservationBuilder`、`createDefaultTooling`、MCP config 或
MCP manager。

不要在 `try` 中直接 `return` 后依赖 finally 覆盖错误。先保存 exit code、dispose reason 和
primary error，再执行 dispose；这样 cleanup failure 可以稳定地把结果改为失败，且错误
汇总仍以 primary error 为第一项。

### TUI

`runTui()` 保留 UI 责任：

```text
read config
create TuiEventStream
create RuntimeSession
try
  load PromptHistory
  render App(run=session.executeTurn)
  await waitUntilExit
catch
  disposeReason = runner_failed
  rethrow
finally
  unmount/restore stdin
  await session?.dispose(disposeReason)
after successful cleanup, /quit path may process.exit(0)
```

PromptHistory 保持在 session 创建后加载。这样可以通过集成测试明确证明：MCP 已连接后，
即使 prompt history 或 Ink 初始化失败，也会经过同一个 session dispose 路径。

`App` 只拿到绑定后的 `run(prompt, signal)`，不知道 model、tooling、MCP 或 session messages。
`/quit` 触发 Ink exit；不能在 session dispose 完成前调用 `process.exit()`。

## 失败矩阵

| 失败位置 | 是否创建 turn | 必须清理 | 最终行为 |
| --- | --- | --- | --- |
| Runner config/model 校验 | 否 | 无 | runner 直接报告错误 |
| `session.started` 持久化 | 否 | 已创建的 event 资源 | factory reject，不连接 MCP |
| DefaultTooling 创建 | 否 | tooling 局部资源 | initialization rollback |
| MCP config 解析 | 否 | tooling | `session.finished(initialization_failed)` 后 reject |
| MCP manager 返回前失败 | 否 | 已连接 MCP clients、tooling | 子 factory 局部回滚，再 session rollback |
| MCP tool registry 冲突 | 否 | MCP manager、tooling | 逆序 rollback |
| PromptHistory/Ink 初始化 | 否 | 完整 RuntimeSession | `dispose(runner_failed)` |
| Model/tool 预期失败 | 是 | turn 继续完成 terminal event | 返回 `RunAgentResult.failed` |
| 用户取消 | 是 | 当前 turn；session 资源保留 | `turn.cancelled`，session 回到 ready |
| Active turn 时 session 退出 | 是 | active turn、MCP、tooling | abort、等待、完整 dispose |
| Event append 失败 | 可能 | 完整 RuntimeSession | 保存首个 fault；dispose 仍尝试 finished，最终错误以原 fault 为首项 |
| MCP dispose 失败 | 不适用 | 仍继续 tooling 和 session event | dispose reject AggregateError |
| Tooling dispose 失败 | 不适用 | 仍尝试 session event | dispose reject AggregateError |

## 代码调整范围

### `src/agent/runtime-session.ts`

- 保留已经落地的 identity、父子校验和 event sequence 逻辑。
- 增加状态机、session messages、共享 model/tooling/observation 依赖。
- 增加 `executeTurn()` 和 idempotent `dispose()`。
- 导出 runner-facing `RuntimeSession` 和 internal `RuntimeSessionContext` 两个窄接口。
- 使用不导出的 `DefaultRuntimeSession`、private constructor 和同模块 factory 封装两阶段
  构造。
- 将 `createTurn()` 和资源 attach 保持为 private。
- 增加 `RuntimeEventAppendError` 和 event failure 后的 faulted 状态。
- 导出唯一的异步 `createRuntimeSession()` 生产入口。

### `src/agent/loop.ts`

- 保持只负责单个 turn 的 iteration/tool loop。
- 继续接收明确的 turn identity 和 initial messages。
- 不发送 turn/session terminal event，不持有 session messages。
- 从 typed `signal.reason` 读取 cancellation source。

### `src/agent/types.ts`

- 将 `TurnCancellation.source` 扩展为 `user | session_dispose`。
- 其他 identity 和 `RunAgentResult` 结构保持不变。

### `src/agent/turn-cancellation.ts`

- 让 `TurnCancelledError` 强制携带 `TurnCancellationSource`。
- 增加 typed reason 的读取与校验 helper，不再把未知 abort reason 默认解释为 user。
- 外部 signal 的未知 reason 只在 `executeTurn()` 边界规范化一次。

### `src/model/model-client.ts` 与 model adapters

- `ModelRequestOptions.identity.runtimeSession` 改为 `RuntimeSessionContext`。
- 保持相邻同 role message 的现有出站映射，不在 adapter 外静默插入消息。

### `src/events/types.ts`

- 扩展 `session.finished` reason 和可选 error。
- 不在本阶段修改其他 payload 或 sink 可靠性策略。

### `src/tools/registry.ts` 与 `src/tools/bash-task.ts`

- `createDefaultTooling()` 的 `runtimeSession` 改为必填。
- 参数类型改为 `RuntimeSessionContext`，工具层拿不到 `executeTurn()` 或 `dispose()`。
- 删除隐式创建 RuntimeSession 的测试 fallback。
- tooling/shutdown reason 接受完整 `SessionDisposeReason["type"]`。
- 保留 `ShellTaskManager.shutdown()` 当前缓存 promise 的 idempotent 行为。

### `src/mcp/mcp-manager.ts`

- manager 创建过程增加局部 rollback。
- 接收 `RuntimeSessionContext` 而不是 runner-facing session。
- `dispose()` 缓存 promise，并在尝试关闭全部连接后报告错误。
- 保留单 server 连接失败的现有降级策略。

### `src/cli/run-runner.ts` 与 `src/cli/tui-runner.tsx`

- 删除重复的 resource assembly、`runAgent()` 调用、terminal event 和消息维护。
- 只保留各自的展示、exit code、Ink/stdin 和 dispose reason 处理。

### 测试辅助

- `src/__tests__/test-runtime.ts` 通过 factory 创建 deterministic runtime。
- fake dependencies 必须显式传入，不在生产工具 factory 中保留测试 fallback。

## 实施顺序

建议作为一次连续变更完成，避免一条 runner 使用新生命周期、另一条仍使用旧生命周期：

1. 增加两个 API 视图、lifecycle state、dispose reason 和
   `RuntimeEventAppendError`。
2. 让 `createDefaultTooling()` 强制接收 `RuntimeSessionContext`。
3. 让 MCP factory 具备局部 rollback 和 idempotent dispose。
4. 增加 `createRuntimeSession()`，完成资源 acquisition/rollback。
5. 把 turn terminal event 和 session messages 移入 `executeTurn()`。
6. 以 typed `AbortSignal.reason` 接入 user/dispose cancellation，并清理 signal listener。
7. 将 one-shot runner 改成薄入口。
8. 将 TUI runner 改成薄入口。
9. 更新测试 helper、fixtures 和事件断言。
10. 清理 runner 中所有 tooling、MCP、`runAgent()` 和 `sessionMessages` 残留。
11. 运行 `bun run check`，再做真实 one-shot、多 turn TUI 和 active turn `/quit` 验证。

## 测试计划

### Factory 与初始化回滚

- 正常创建只产生一个 RuntimeSession、一个 tooling 和一个 MCP manager。
- `session.started` 写入失败时不创建 tooling 或连接 MCP。
- MCP 连接一个 server 后 factory 抛错，会关闭已连接 client 并 shutdown tooling。
- MCP tool 注册冲突会逆序释放 MCP 和 tooling。
- `session.started` 成功后的初始化失败会尝试
  `session.finished(initialization_failed)`；started 自身失败时不发送 finished。
- 多个 rollback 步骤失败时全部步骤都执行，错误顺序确定。
- 生产实现类不能直接构造，factory 返回前不会泄露 `initializing` session。

### Turn 执行

- 连续两个 `executeTurn()` 共用 session，turn number 递增，iteration number 各自从 1
  开始。
- 第二个 turn 收到第一个 turn 提交的 messages。
- model request 在 assistant message 前失败后，下一个 turn 明确收到相邻的两条 user
  message，顺序保持不变。
- completed、failed、cancelled 分别只发送一个正确 terminal event。
- failed 和 cancelled 结果同样提交协议完整的 messages。
- 空 prompt 在创建 turn 和发送事件前 fast-fail。
- 并发调用第二个 `executeTurn()` 立即失败，不分配 turn identity。
- terminal event append 失败时不补发另一个 terminal event，session 进入 faulted。
- runner-facing `RuntimeSession` 不能通过类型检查调用 `append()`、`createIteration()` 或
  `createToolCall()`。

### Cancellation reason

- 外部 signal abort 产生 source=`user` 的 `turn.cancelled`。
- active turn dispose 产生 source=`session_dispose` 的 `turn.cancelled`。
- 传入时已经 aborted 的外部 signal 会立即转发，并在第一个 agent boundary 取消。
- 外部取消和 dispose 竞态时，第一次 abort 的 source 保持不变。
- completed、failed、cancelled 和 reject 路径都会移除外部 signal listener；大量连续 turn
  不累积 listener。
- agent loop 收到 aborted 但没有 typed `TurnCancelledError` 的内部 signal 时 fast-fail。

### Dispose

- 正常 dispose 顺序是 active turn、MCP、tooling、`session.finished`。
- active model request、MCP call 和前台 Bash 期间 dispose 都会取消并等待 turn。
- 后台 Bash 在 `session.finished` 前完成 shutdown 和 terminal event。
- prompt history 或 render 失败后完整 session 被 dispose。
- MCP dispose 失败时仍执行 tooling dispose 和 `session.finished`。
- tooling dispose 失败时仍发送 `session.finished`。
- faulted session 仍尝试一次 `session.finished`；再次写入失败时 AggregateError 第一项保持
  原始 `faultCause`。
- 两次 dispose 返回同一个 promise，只关闭资源和发送 terminal event 一次。
- dispose 完成或 event fault 后不能执行新 turn。

### Runner 集成

- one-shot 与 TUI 都不直接 import `runAgent`、tooling 或 MCP manager。
- one-shot completed 打印 final text 并返回 0。
- one-shot failed/cancelled 或 dispose failure 返回 1。
- TUI 连续两个 prompt 通过同一个 RuntimeSession 执行。
- `/quit` 只在 session 清理完成后退出进程。

## 验收标准

- `runOneShot()` 和 `runTui()` 使用同一个 RuntimeSession factory 和 `executeTurn()`。
- factory 只向 runner 返回窄接口；identity/event context 不暴露给 runner。
- runtime 资源只有一个明确 owner，创建与释放顺序可以从代码直接读出。
- 实现类不可直接构造；factory 不会返回半初始化 session，任一步失败都会逆序清理已创建
  资源。
- Session messages 不再由 TUI runner 持有。
- 每个 turn 有且只有一个 terminal event；event infrastructure failure 不伪装成 agent
  failure。
- active turn 期间 dispose 会先取消并等待 turn，再关闭 session 资源。
- user 和 session dispose cancellation 通过 typed `AbortSignal.reason` 准确进入事件，且
  turn 结束后不遗留外部 signal listener。
- `dispose()` 幂等，所有清理步骤都会尝试，单点失败不会跳过后续资源。
- faulted dispose 不跳过 `session.finished`，最终错误也不会掩盖最初 fault。
- `session.finished` 是 session 的最后一个生命周期事件，所有后台任务 terminal event 都在
  它之前。
- 代码中 runner 不再出现重复的 default tooling、MCP、ObservationBuilder 或
  `runAgent()` 组装逻辑。
- `bun run check` 通过，并完成真实 one-shot、至少两个连续 TUI turn 和 active turn 退出
  的手动验证。
