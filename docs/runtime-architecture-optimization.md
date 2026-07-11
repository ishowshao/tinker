# Runtime 架构优化建议

## 背景

Tinker 已经具备完整的 coding agent 基础闭环，包括 agent loop、文件与搜索工具、
Bash 和后台任务管理、Web、MCP、事件日志、TUI 以及 turn cancellation。当前模块
划分清楚，测试覆盖也较完整，不需要重写运行时。

下一阶段计划继续实现 SessionStore、`/resume`、context window 统计和 compaction。
这些能力会把当前主要面向单次运行的状态模型扩展成长生命周期 session，因此在进入
功能开发前，建议先收紧运行身份、资源生命周期、provider 边界和事件契约。

本文记录这轮架构评审发现的优化项及建议实施顺序。本文不替代具体功能设计；每一阶段
仍应在实现前补充必要的数据结构、迁移行为和测试计划。

## 总体判断

当前架构方向正确，以下边界值得保留：

- `AgentMessage` 与 `ModelClient` 隔离 agent runtime 和具体 provider SDK。
- `ToolRegistry`、`ToolRuntime` 与 `ObservationBuilder` 分离工具执行、原始结果和
  模型可见 observation。
- `EventSink` fan-out 同时支持 JSONL、可读日志、stdout 和 TUI。
- `AbortSignal` 贯穿模型请求、工具执行和前台 Bash，取消语义明确。
- `ShellTaskManager` 集中管理后台进程，避免后台任务游离在 runtime 之外。

优化重点不是增加新的框架层，而是让上述边界能够安全承载多 turn、可恢复 session
和长上下文。

## 一、明确 Session、Turn 和 Step 身份

本项已经通过
[Session、Turn、Iteration 身份模型设计](./session-turn-iteration-identity-design.md) 完成
细化和实现。以下内容保留为最初的架构评审摘要。

### 当前问题

TUI 启动时生成一个 `runId`，后续每次用户提交都复用该 ID；与此同时，agent loop
在每个 turn 内重新从 `step=1` 开始。后台任务和日志也使用同一个 `runId`。

因此，当前 `runId` 实际同时承担了以下几种含义：

- 一次 TUI 生命周期。
- 多轮对话 session。
- 单次用户请求。
- 后台任务所属运行范围。
- JSONL 和 observation 日志文件身份。

单次运行时这不会产生明显问题，但 `/resume`、context 统计和 compaction 需要准确
区分整个 session 与其中的单次 turn。继续复用一个概念会使事件关联、失败恢复和状态
持久化变得含糊。

### 建议模型

```text
sessionId   一段可恢复的对话，跨多个 turn 保持不变
turnId      每次用户提交生成一个新 ID
step        turn 内的模型调用序号，从 1 开始
toolCallId  provider 返回或 runtime 补充的工具调用 ID
taskId      ShellTaskManager 管理的后台任务 ID
```

所有运行事件建议携带统一元数据：

```ts
type EventMetadata = {
  sessionId: string;
  turnId?: string;
  sequence: number;
  timestamp: string;
};
```

Session 级事件可以省略 `turnId`；模型步骤、工具调用和 turn 结束事件必须包含
`turnId`。`sequence` 在单个 session 内单调递增，用于稳定重放和检测损坏或缺失事件。

### 验收标准

- 连续提交两个 prompt 时共享 `sessionId`，但拥有不同的 `turnId`。
- 两个 turn 都可以从 `step=1` 开始，并能通过 `turnId` 准确关联事件。
- 后台任务明确归属 session，并记录创建它的 turn。
- JSONL、TUI 和未来 SessionStore 使用同一套身份定义。

## 二、统一 Runtime Session 生命周期

本节的可实施设计已经细化为
[Runtime Session 生命周期设计](./runtime-session-lifecycle-design.md)。以下内容保留为架构
评审摘要，具体 API、资源所有权、失败回滚、状态机和测试计划以细化文档为准。

### 当前问题

one-shot runner 和 TUI runner 都负责创建事件 sinks、默认工具、MCP manager、
ObservationBuilder，并分别处理运行结束事件和资源释放。这导致两条入口的初始化与清理
行为容易漂移。

两条 runner 目前已经各自用 `try/finally` 覆盖大部分初始化和退出路径，但资源所有权仍
散落在 runner 中。factory 在返回完整资源前失败、某个 dispose 抛错或 active turn 期间
退出时，仍缺少统一的回滚和终止契约。

### 建议边界

增加一个轻量的 `RuntimeSession`，只负责运行时资源和 turn 执行，不负责 TUI 展示：

```ts
type RuntimeSession = {
  sessionId: string;
  executeTurn(input: {
    userPrompt: string;
    signal: AbortSignal;
  }): Promise<RunAgentResult>;
  dispose(reason: SessionDisposeReason): Promise<void>;
};
```

对应创建入口负责：

1. 校验配置和持久化目录。
2. 创建事件基础设施。
3. 创建默认工具和后台任务管理器。
4. 加载并连接 MCP server。
5. 创建模型 client 和 observation builder。
6. 在任一步骤失败时，逆序释放已经创建的资源。

one-shot CLI 只执行一次 `executeTurn`；TUI 可以多次执行同一个 session 的
`executeTurn`。两种入口共享结束事件、session message 更新和清理逻辑。

这里不需要引入依赖注入容器。一个明确拥有资源的 factory 加 `try/finally` 就足够。

### 验收标准

- one-shot 和 TUI 使用同一条 turn 执行路径。
- MCP 连接成功后，即使 prompt history 或 TUI 初始化失败，也会关闭连接。
- 后台任务管理器在所有正常退出和初始化失败路径中都会完成 shutdown。
- 资源释放可以重复调用，不会重复终止进程或抛出无关错误。

## 三、收紧 ModelClient 和 Provider 边界

本项已经实施：`ModelRequestOutput` 只接收 assistant message，并通过 `ModelUsage`
暴露规范化 token usage；OpenAI-compatible adapter 会校验 choice、assistant message、
tool call、content 和 usage 结构，协议错误包含 provider、model 与字段路径。

### 当前问题

`ModelStepOutput.message` 当前使用完整的 `AgentMessage` 类型，但 agent loop 实际只接受
assistant 响应。OpenAI-compatible 响应映射对缺失的 choice、message 或 tool call
字段采用宽松默认值，异常响应可能被转换为空 assistant message，并被 loop 当作成功
结束。

这种容错会让 provider 协议错误远离来源，和项目采用的 fast-fail 风格不一致。

### 建议契约

定义明确的 assistant 输出和 usage：

```ts
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

type ModelUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  source: "provider" | "estimated";
};

type ModelStepOutput = {
  message: AssistantMessage;
  finishReason?: string;
  usage?: ModelUsage;
  rawResponse?: unknown;
};
```

Provider adapter 应在以下情况立即返回清晰错误：

- 响应没有可用的第一条 choice。
- choice 没有 assistant message。
- assistant 同时没有有效文本和工具调用。
- tool call 缺少名称或具有无法识别的结构。
- provider 返回的 usage 字段存在但格式非法。

工具参数 JSON 解析失败仍可以作为 tool error observation 返回模型，因为这是模型可修复
的单次调用错误；缺少完整响应结构则属于 provider 协议错误，不应继续 agent loop。

### 验收标准

- 异常 provider 响应不会生成空的成功结果。
- agent loop 在类型层只能接收到 assistant message。
- provider usage 被规范化，后续 context 统计不需要重新解析 raw response。
- 错误信息包含 provider、model 和缺失或非法字段的位置。

## 四、明确事件可靠性策略

本项已经实施：持久化 sink 作为必需组件在 `session.started` 时完成首次写入，失败会阻止
session 进入工具初始化和模型执行；展示 sink 按确定顺序发送，单个失败后会被隔离，并向
其余健康 sink 发送 `diagnostic.sink_failed`。核心事件 payload 已使用领域类型，展示层
不再重新断言 model output、tool result、observation 和 turn result。

### 当前问题

`CompositeEventSink` 按顺序等待每一个 sink。前面的持久化 sink 写入失败时，后面的
TUI 或 stdout sink 不会收到该事件。工具副作用可能已经完成，但日志错误会中断 turn；
runner 随后再向同一个失败的 sink 写入 `run.failed`，也可能再次失败。

此外，多个事件字段使用 `unknown`，使 observation log、stdout 和 TUI 各自重复解析
相同 payload，展示逻辑容易随事件结构演进而漂移。

### 建议策略

先明确两类事件消费者：

- 必须可用的持久化组件：在 session 启动时预检；无法创建或写入时 fast-fail，避免
  执行任何可能产生副作用的工具。
- 展示和辅助观测组件：某个组件失败不应阻止其他组件接收事件，但失败必须通过明确的
  diagnostics 暴露，不能静默吞掉。

事件 payload 应逐步从 `unknown` 收紧为现有领域类型，例如 `RunStartedInput`、
`ModelStepOutput`、`ToolRawResult`、`ToolObservation` 和 `RunAgentResult`。

事件发送顺序、持久化顺序和展示顺序必须保持确定性。不要为了 fan-out 引入无序并发。

### 验收标准

- `.tinker` 不可写时，在模型请求和工具执行前直接失败。
- 单个展示 sink 抛错时，其他 sink 仍能收到事件，并能看到 sink failure diagnostics。
- 已经完成工具副作用后发生的日志错误不会被错误描述为工具执行失败。
- 事件消费者不再依赖不受约束的类型断言读取核心 payload。

## 五、强化工具结果契约

本项已经实施：所有内建与 MCP raw result 都携带稳定的 `kind`，observation、stdout 和
TUI 展示使用穷尽分发；`ToolRegistry` 对重复名称 fast-fail，并在错误中报告新旧注册
来源。

### 当前问题

`ToolRawResult` 是多个结构相似但没有判别字段的联合类型。`ObservationBuilder` 根据
tool name 把结果断言成对应类型；TUI 和 stdout 又分别按名称重新解析 raw result。

当前工具数量下可以维护，但新增工具需要同步更新执行、observation、事件展示和多个
测试位置，漏改时 TypeScript 不一定能发现。

`ToolRegistry.register` 还会静默覆盖同名工具。现有 MCP 使用命名空间前缀，冲突风险
较低，但注册层本身应遵循 fast-fail 原则。

### 建议调整

- 为 raw result 增加稳定的 `kind` 判别字段，或者使用统一的结果 envelope。
- `ToolRegistry.register` 遇到重复名称时直接抛出包含名称和来源的错误。
- 保留 `ObservationBuilder` 的独立边界，不把模型 observation 或 TUI 展示逻辑塞入
  工具执行器。
- 为 observation 和展示层增加 exhaustive dispatch，让新增内建工具时编译器能够提示
  未处理分支。

MCP 工具仍可使用统一的 `mcp` kind，并携带 server 和原始 tool name，不需要为每个
动态 MCP 工具生成新的 TypeScript 类型。

### 验收标准

- raw result 可以不依赖 tool call name 完成类型收窄。
- 重复注册工具会在初始化阶段失败。
- 新增一个内建工具时，未更新 observation 或核心展示映射会产生编译错误或明确测试
  失败。

## 六、分离完整状态与 TUI 投影

### 当前问题

TUI 当前同时在 `TuiEventStream.events` 保存完整事件，并在 `TuiState.timeline` 保存
派生展示项。每个新事件都会复制并重新渲染不断增长的 timeline。

短会话下影响不明显，但 `/resume` 和长 session 会持续增加事件、工具输出和 diff，
最终让 TUI 内存和渲染成本随完整历史增长。

### 建议状态分层

```text
SessionStore    完整、可恢复的模型上下文和 session 元数据
EventLog        完整诊断事件，不作为恢复数据源
TUI projection 当前展示所需的有界状态
```

TUI projection 可以保留当前 turn 和最近若干历史 turn；更早内容通过历史查看或分页加载。
后台任务状态应按 task ID 维护最新快照，不需要保留每一次生命周期事件的完整副本。

Compaction 只改变模型上下文和 SessionStore 中的 summary，不应被用作清理 TUI 事件的
手段。这是两个不同的生命周期问题。

### 验收标准

- 长 session 中 TUI 常驻展示状态有明确上限。
- EventLog 仍保留完整诊断信息。
- `/resume` 从 SessionStore 恢复，而不是重放 JSONL 推断模型上下文。
- compaction 前后，TUI 历史和模型上下文可以采用不同保留策略。

## 七、次要结构整理

以下调整不应阻塞 SessionStore，可以在相关模块改动时顺手完成：

- 将 `ShellTaskSnapshot` 等共享运行时类型移出具体工具实现文件，解除
  `bash-task -> event-sink -> event-types -> bash-task` 的 type-only 依赖环。
- 在工具结果判别化后，按工具类别拆分较大的 observation 和 TUI presenter 文件。
- 统一环境变量校验。非法 `TINKER_MAX_STEPS` 应像非法布尔配置一样明确报错，而不是
  静默回退默认值。
- 保持配置解析、provider 映射、工具参数解析和 session 文件加载都遵循 fast-fail：
  在最接近错误来源的位置给出可操作的信息。

## 建议实施顺序

```text
Session / Turn 身份模型与事件元数据
  -> RuntimeSession 生命周期统一
  -> ModelClient 与 usage 契约收紧
  -> 事件可靠性和 typed payload
  -> SessionStore 与 /resume
  -> TUI 有界投影
  -> context 统计与 compaction
```

工具结果判别和次要结构整理可以穿插进行，但不应扩大第一阶段范围。

## 测试重点

除现有工具和 TUI 单元测试外，后续架构调整应优先增加以下跨模块测试：

1. 多 turn 共用 session、分别生成 turn ID，并正确关联 step 和工具事件。
2. provider 返回空 choices、缺失 message、非法 tool call 时 fast-fail。
3. JSONL 路径不可写时，在产生工具副作用前停止。
4. 一个辅助 sink 失败时，其他 sink 仍能收到事件并报告 diagnostics。
5. MCP 连接后发生初始化失败时，所有连接和后台任务资源都会释放。
6. 重复工具注册在启动阶段失败。
7. 大量事件和多轮历史下，TUI projection 保持在配置的上限内。
8. SessionStore 写入中断时保留上一份完整状态，损坏文件恢复时给出明确错误。

## 本轮结论

Tinker 当前没有需要立即重写的架构问题。最重要的工作是在实现 `/resume` 前，把当前
含义混合的 `runId` 拆成稳定的 session 和 turn 身份，并让两个 runner 共享一条可靠的
资源生命周期。完成这两个基础调整后，SessionStore、context usage 和 compaction
都能建立在更清晰的边界上，避免后续再迁移持久化格式和事件协议。
