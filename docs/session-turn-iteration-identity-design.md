# Session、Turn、Iteration 身份模型设计

## 背景

Tinker 当前使用一个 `runId` 表示 TUI 生命周期、对话 session、单次用户请求、日志
文件和后台任务所属范围。agent loop 内部再使用从 1 开始的 `step` 表示循环次数，
tool call 则直接复用 provider 返回的 ID，并只在 provider 没有返回 ID 时补充 UUIDv7。

这些概念在单次运行阶段可以工作，但不能准确表达多 turn session：

- TUI 中多个用户请求共享一个 `runId`，无法通过 ID 区分单次请求。
- 每个用户请求都从 `step=1` 开始，事件只有 step number，没有稳定身份。
- provider tool call ID 同时被当作 runtime 内部身份，内部状态依赖外部协议字段。
- 后续 SessionStore、`/resume`、context 统计和 compaction 缺少稳定的关联键。

本设计将运行身份统一为以下层级：

```text
Session
  -> Turn
       -> Iteration
            -> Model invocation
            -> ToolCall(s)
```

其中 `runId` 正式进化为 `sessionId`，现有 `step` 概念改名为更准确的
`iteration`。

## 目标

- 为 Session、Turn、Iteration 和 ToolCall 建立互不混用的内部身份。
- 所有内部身份统一使用 UUIDv7。
- 使用独立的 number 和 event sequence 表达确定顺序，不依赖 UUID 排序。
- 分离内部 `toolCallId` 与 provider 协议中的 `providerToolCallId`。
- 让事件、日志、TUI、后台任务和未来 SessionStore 使用同一套身份模型。
- 在最接近错误来源的位置校验身份和父子关系，发现非法状态时 fast-fail。

## 非目标

- 本阶段不实现 SessionStore 和 `/resume`。
- 本阶段不实现 context window 统计或 compaction。
- 本阶段不引入 session 分支、并行 turn 或多 agent。
- 本阶段不为模型请求重试增加 `modelRequestId`。
- 本阶段不迁移或兼容旧的本地运行数据和事件格式。

## 术语决定

### Session

Session 表示一段可恢复的完整对话。TUI 从启动新对话到退出或切换 session 期间，
`sessionId` 保持不变。未来通过 `/resume` 恢复后，继续使用原来的 `sessionId`。

one-shot CLI 同样创建 session，只是该 session 通常只有一个 turn。

### Turn

Turn 表示一次用户输入触发的完整 agent 执行，从接受 prompt 开始，到以下任一状态结束：

- `completed`
- `failed`
- `cancelled`

Turn 包含本次请求产生的所有 model invocation、tool call 和 observation。

保留 `turn` 而不使用其他候选词：

- `request` 容易和 HTTP 或 provider request 混淆。
- `run` 已经承担过多种含义，不再作为领域身份使用。
- `task` 会和后台 Bash task 冲突。
- `interaction` 含义接近，但比 agent 领域常用的 `turn` 更冗长。

正式命名为 `AgentTurn` 和 `turnId`。

### Iteration

Iteration 表示 agent loop 的一次完整迭代：

```text
构造模型上下文
  -> 调用模型
  -> 接收 assistant message
  -> 执行该 message 中的 tool calls
  -> 追加 tool observations
```

如果 assistant message 没有 tool call，该 iteration 以最终回答结束；否则在所有 tool
observations 追加完成后结束，并进入下一个 iteration。

现有 `step` 不只是模型调用，也包含其产生的工具执行，因此不再使用 `step` 作为正式
领域术语。`modelStep` 同样不准确；`cycle` 可以表达循环，但 `iteration` 与实际 agent
loop 结构更一致。

正式命名为 `AgentIteration`、`iterationId` 和 `iterationNumber`。

### ToolCall

ToolCall 表示 assistant message 请求的一次工具调用。每个 tool call 都有 Tinker 自己
生成的内部 ID，并保留 provider 返回的协议 ID。

正式命名为 `ToolCall`、`toolCallId` 和 `providerToolCallId`。

## 身份与顺序分离

所有领域对象同时区分“身份”和“顺序”：

```text
UUIDv7 ID       唯一标识一个领域对象
Number          表示对象在直接父级中的稳定顺序
Event sequence  表示事件在 session 内的确定顺序
```

不要用 UUIDv7 的时间有序特性替代 number 或 event sequence。UUID 解决身份，
number/sequence 解决确定顺序。

推荐字段如下：

| 对象 | 身份字段 | 顺序字段 | 顺序范围 |
| --- | --- | --- | --- |
| Session | `sessionId` | 无 | 无父级 |
| Turn | `turnId` | `turnNumber` | session 内从 1 开始 |
| Iteration | `iterationId` | `iterationNumber` | turn 内从 1 开始 |
| ToolCall | `toolCallId` | `toolCallNumber` | iteration 内从 1 开始 |
| Event | 无独立领域 ID | `eventSequence` | session 内从 1 开始 |

`turnNumber`、`iterationNumber` 和 `toolCallNumber` 都是 1-based number，不使用
`index` 命名，避免和通常从 0 开始的数组下标混淆。

`eventSequence` 必须由 session runtime 串行分配并单调递增。事件持久化和展示仍保持
现有的确定顺序，不为了 fan-out 改成无序并发。

## ID 类型与生成

所有内部领域 ID 都通过同一个 runtime ID factory 创建 UUIDv7：

```ts
type RuntimeIdFactory = {
  createSessionId(): SessionId;
  createTurnId(): TurnId;
  createIterationId(): IterationId;
  createToolCallId(): ToolCallId;
};
```

生产实现统一调用现有的 `createUuidV7()`。测试可以注入确定性的 factory，避免测试通过
解析或猜测 UUID 建立断言。

建议为不同 ID 使用 opaque string type，防止把 `turnId` 误传给需要 `sessionId` 的
接口：

```ts
type RuntimeId<Name extends string> = string & {
  readonly __runtimeId: Name;
};

type SessionId = RuntimeId<"session">;
type TurnId = RuntimeId<"turn">;
type IterationId = RuntimeId<"iteration">;
type ToolCallId = RuntimeId<"tool-call">;
```

序列化到 JSON 时仍然是普通字符串，不在持久化格式中写入 TypeScript brand 信息。

## 建议数据模型

### Session identity

```ts
type SessionIdentity = {
  sessionId: SessionId;
};
```

`sessionId` 在创建 RuntimeSession 时生成。所有 turn、后台任务、事件和日志都继承该
identity，不允许调用方在 session 存续期间替换。

### Turn identity

```ts
type TurnIdentity = {
  sessionId: SessionId;
  turnId: TurnId;
  turnNumber: number;
};
```

每次接受非空用户 prompt 时，由 RuntimeSession 原子分配新的 `turnId` 和
`turnNumber`。被 TUI 拦截处理的 slash command 不创建 AgentTurn；真正进入 agent
runtime 的命令才创建 turn。

取消、失败和无文本最终回答都不会回收 turn number。身份一旦对外产生事件，就不能
重新使用。

### Iteration identity

```ts
type IterationIdentity = TurnIdentity & {
  iterationId: IterationId;
  iterationNumber: number;
};
```

`runAgent` 每次进入 agent loop body 前创建新的 iteration identity。该 identity 贯穿
本轮模型调用、assistant progress、所有 tool calls 和 observations。

达到 `maxIterations` 时，错误信息同时包含 `turnId`、最后的 `iterationId` 和
`maxIterations`。原有 `maxSteps` 配置和字段同步重命名为 `maxIterations`。

### Tool call identity

```ts
type ToolCall = IterationIdentity & {
  toolCallId: ToolCallId;
  toolCallNumber: number;
  providerToolCallId: string;
  name: string;
  args: unknown;
  rawArgs?: string;
  argsParseError?: string;
};
```

Provider adapter 每解析一个合法 tool call，都必须创建新的 `toolCallId`。无论 provider
是否已经返回 ID，都不能直接把 provider ID 当成内部 ID。

`providerToolCallId` 是不透明字符串，只用于 provider message 映射：

- 重新构造 assistant message 中的 `tool_calls[].id`。
- 构造 tool result message 中的 `tool_call_id`。

`toolCallId` 用于：

- runtime 内部关联。
- agent event。
- JSONL 和 observation log。
- TUI timeline。
- 取消信息。
- 后台任务来源信息。
- 未来 SessionStore。

不要在 runtime、事件和 TUI 中使用 `providerToolCallId` 作为主键，也不要把 provider
ID 改写成 UUIDv7 后再假装它仍是 provider 原始 ID。

当前支持的 provider 协议要求 tool call ID。合法 tool call 缺少非空
`providerToolCallId` 时，provider adapter 直接报告协议错误，不生成兼容性 ID，也不
进入 ToolRuntime。

如果未来增加 runtime 主动创建的合成工具调用，应为其设计明确的 origin 类型，而不是
让 `providerToolCallId` 随意变成可选字段。

## AgentMessage 调整

Assistant message 中保存完整 ToolCall identity。Tool message 同时保存内部关联和
provider 协议关联：

```ts
type ToolMessage = {
  role: "tool";
  toolCallId: ToolCallId;
  providerToolCallId: string;
  name: string;
  content: string;
};
```

内部 agent loop、取消补全和 SessionStore 通过 `toolCallId` 关联 assistant tool call；
provider adapter 只在出站映射时读取 `providerToolCallId`。

这样可以保持两条关系同时明确：

```text
Tinker runtime correlation  -> toolCallId
Provider protocol correlation -> providerToolCallId
```

## 生命周期与分配时机

### Session

1. 创建 RuntimeSession。
2. 分配 `sessionId`。
3. 初始化 `eventSequence=0`、`nextTurnNumber=1`。
4. 创建 session 级事件和日志路径。
5. 在 TUI 退出或 one-shot 完成时释放 session 资源。

### Turn

1. RuntimeSession 接受用户 prompt。
2. 分配 `turnId` 和 `turnNumber`。
3. 发出 `turn.started`。
4. 调用 agent loop。
5. 发出且只发出一个 terminal event：`turn.finished`、`turn.failed` 或
   `turn.cancelled`。

### Iteration

1. 进入 loop body 前分配 `iterationId` 和 `iterationNumber`。
2. 发出 `agent.iteration.started`。
3. 发出模型请求事件并调用 ModelClient。
4. 为 assistant message 中的 tool calls 分配内部身份。
5. 顺序执行 tool calls 并追加 observations。
6. 发出 `agent.iteration.finished`，记录本轮是进入下一 iteration 还是产生最终回答。

即使模型请求失败或用户在模型请求期间取消，已经创建的 iteration identity 仍然保留，
并出现在失败或取消事件中。

### ToolCall

1. Provider adapter 校验 provider tool call 结构。
2. 保留非空 `providerToolCallId`。
3. 分配内部 `toolCallId` 和 `toolCallNumber`。
4. 后续 started、raw result、finished、observation 和 cancellation 事件始终使用同一个
  内部 ID。

## 事件模型

所有事件使用统一 envelope：

```ts
type AgentEvent<TType extends string, TData> = {
  type: TType;
  sessionId: SessionId;
  turnId?: TurnId;
  iterationId?: IterationId;
  toolCallId?: ToolCallId;
  eventSequence: number;
  timestamp: string;
  data: TData;
};
```

身份字段必须满足以下父子约束：

- 有 `toolCallId` 时必须同时有 `iterationId` 和 `turnId`。
- 有 `iterationId` 时必须同时有 `turnId`。
- 所有事件必须有 `sessionId`。
- session runtime 拒绝发布属于其他 session 的 turn、iteration 或 tool call。

推荐事件名称：

```text
session.started
session.finished

turn.started
turn.finished
turn.failed
turn.cancelled

agent.iteration.started
model.request.started
model.request.finished
assistant.progress
tool.started
tool.raw_result
tool.finished
tool.observation
agent.iteration.finished

bash.task.backgrounded
bash.task.stopping
bash.task.finished
mcp.server.connected
mcp.server.failed
```

`model.step.started` 和 `model.step.finished` 不再保留。它们当前描述的是模型请求，而不
是完整 iteration，因此分别改为 `model.request.started` 和
`model.request.finished`。这些事件通过 envelope 中的 iteration identity 归属到本轮
agent loop。

本阶段不增加 `modelRequestId`。当前一次 iteration 只有一次模型请求；未来如果实现
provider retry，再增加独立的 request/attempt identity，不复用 `iterationId`。

## 后台任务归属

`ShellTaskSnapshot.runId` 改为以下来源字段：

```ts
type ShellTaskOrigin = {
  sessionId: SessionId;
  turnId: TurnId;
  iterationId: IterationId;
  toolCallId: ToolCallId;
};
```

这些字段记录后台任务由哪一次 Bash tool call 创建。后台任务可以在创建它的 turn 结束
后继续运行，因此任务生命周期归属于 session，不归属于 turn；origin 只用于追踪来源，
不能被解释为 turn 结束时自动停止任务。

## 日志与未来持久化布局

新身份模型不再使用 `.tinker/runs/<runId>.*`。建议直接采用未来 SessionStore 的目录
边界：

```text
.tinker/sessions/<sessionId>/events.jsonl
.tinker/sessions/<sessionId>/observations.md
```

SessionStore 实现后，可以在同一目录增加版本化状态文件，例如：

```text
.tinker/sessions/<sessionId>/session.json
```

JSONL event log 继续用于观测和诊断，不作为 SessionStore 的恢复来源。

## 破坏式本地升级策略

这次架构调整不是在线系统升级，也不需要保留本机历史运行数据。实施时采用一次性、
破坏式切换，不为旧身份结构增加任何兼容性兜底。

明确不做：

- 不继续接受或生成 `runId` 字段。
- 不同时写入 `runId` 和 `sessionId`。
- 不同时发布 `model.step.*` 和新的 iteration/model request 事件。
- 不让 reader 同时识别旧事件和新事件。
- 不迁移 `.tinker/runs/` 下的历史 JSONL 或 observation 文件。
- 不为旧的 ToolCall `id` 字段保留 alias。
- 不通过可选字段、默认值或 fallback 猜测旧数据属于哪个 turn 或 iteration。
- 不保留 `maxSteps` 到 `maxIterations` 的环境变量兼容映射。

实施完成后：

- 新代码只认识新结构。
- 遇到旧结构时直接 fast-fail，并指出非法字段或 schema version。
- 本地旧 `.tinker` 运行数据可以由开发者直接清理，不写迁移脚本。
- 测试 fixtures 一次性更新为新结构，不保留旧 fixtures 验证兼容性。

Prompt history 不属于 runtime identity 数据；只要其文件结构没有因本次设计变化，就不
需要删除或迁移。

## 代码调整范围

实施预计涉及以下模块：

- `src/agent/types.ts`
  - 增加 identity 类型。
  - 调整 ToolCall 和 tool message。
- `src/agent/loop.ts`
  - 接收 turn identity。
  - 分配 iteration identity。
  - 将 `maxSteps` 改为 `maxIterations`。
- `src/model/openai-chat-mapping.ts`
  - 分离内部 tool call ID 和 provider tool call ID。
  - 缺少 provider ID 时 fast-fail。
- `src/events/types.ts`
  - 增加统一 event envelope。
  - 重命名 run、step 相关事件。
- `src/events/*`
  - 使用 session、turn、iteration 和 tool call identity 输出日志与展示事件。
- `src/cli/config.ts`
  - 将 `runId` 改为 `sessionId`。
  - 将 `maxSteps` 改为 `maxIterations`。
- `src/cli/run-runner.ts`
  - one-shot 创建一个 session 和一个 turn。
- `src/cli/tui-runner.tsx`
  - TUI 生命周期持有 session identity，每次提交创建新 turn。
- `src/tools/bash-task.ts`
  - 将 task 的 `runId` 改为 session identity 和完整 origin。
- `src/tui/*`
  - 使用新事件身份关联 timeline item，不再依赖 step number 或 provider tool call ID。

RuntimeSession 生命周期统一可以紧随本次调整实现，但不应反过来阻止身份模型先落地。

## 实施顺序

建议按一次连续变更完成，不在中间提交可运行但新旧身份混用的状态：

1. 增加内部 identity 类型和 RuntimeIdFactory。
2. 修改 ToolCall、ToolMessage 和 provider mapping。
3. 修改 agent loop，使用 turn 和 iteration identity。
4. 修改 event envelope 和事件名称。
5. 修改后台任务 origin。
6. 修改 one-shot 和 TUI runner。
7. 修改 JSONL、observation、stdout 和 TUI projection。
8. 一次性更新全部测试 fixtures 和断言。
9. 清理所有 `runId`、`step`、旧 ToolCall `id` 和 `maxSteps` 残留。
10. 运行完整 `bun run check`，再做真实 one-shot 和多 turn TUI 验证。

## 测试计划

### Identity

- one-shot 创建一个 session、一个 turn 和至少一个 iteration。
- TUI 连续两个 prompt 共享 session ID，但 turn ID 和 turn number 不同。
- 同一 turn 的 iteration ID 唯一，iteration number 从 1 连续递增。
- 同一 iteration 的 tool call ID 唯一，tool call number 与 provider 返回顺序一致。
- 所有内部 ID 都是 UUIDv7。

### Tool call mapping

- provider tool call ID 原样保存在 `providerToolCallId`。
- 每次解析都生成独立的内部 `toolCallId`。
- 出站 assistant 和 tool messages 使用 provider ID 完成协议关联。
- runtime 事件和 TUI 使用内部 ID，不暴露 provider ID 作为展示主键。
- provider 缺少 tool call ID 时 fast-fail，不生成 fallback ID。

### Event ordering

- `eventSequence` 在 session 内从 1 单调递增。
- turn、iteration 和 tool call 事件包含完整父级 identity。
- 两个 turn 都从 `iterationNumber=1` 开始，但 iteration ID 不同。
- 取消和失败事件引用已经创建的 turn 与 iteration identity。
- tool batch 中途取消时，补全的 tool messages 仍关联正确的内部和 provider ID。

### Background tasks

- Bash 后台任务记录完整 ShellTaskOrigin。
- 创建 turn 完成后，后台任务仍归属于 session 并可以查询或停止。
- TaskList、TaskOutput 和 TaskStop 不依赖旧 `runId`。

### Breaking change

- 代码和测试中不存在 `runId`、`maxSteps` 或 `model.step.*` 残留。
- 旧事件结构不会被新 reader 接受。
- 旧 ToolCall `id` 不会被当作内部 tool call ID。
- 不存在双写、双读、alias 或迁移逻辑。

## 验收标准

- 运行时层级明确为 Session、Turn、Iteration 和 ToolCall。
- `sessionId`、`turnId`、`iterationId` 和 `toolCallId` 始终由 Tinker 生成 UUIDv7。
- number 和 event sequence 独立表达确定顺序。
- provider tool call ID 不再承担 runtime 内部身份。
- 所有事件可以不依赖 step number 或 provider ID 完成稳定关联。
- 后台任务可以追溯到创建它的 Bash tool call，同时继续保持 session 级生命周期。
- 新代码没有旧身份结构的 fallback 或兼容分支。
- `bun run check` 通过，并完成真实 one-shot 与至少两个连续 TUI turn 的手动验证。
