# F3：协议安全的会话账本技术方案

## 文档状态

- 日期：2026-07-11
- 状态：已实施（2026-07-12，与 F4 同批完成）
- 前置阶段：F1、F2 已完成
- 后续阶段：F4 [`SessionStore v1` 与 `/resume`](session-store-resume-design.md)

## 实施结果（2026-07-12）

F3 已按本文完成一次性切换：生产代码已删除
`src/agent/session-conversation.ts`，不再保留 conversation alias 或第二套 message
source of truth。

实际落点如下：

- `src/context/protocol-frame.ts` 定义 canonical message、protocol frame、tool result、hash、
  synthetic completion 和 interrupted completion helper；
- `src/context/context-protocol-validator.ts` 实现 normal/full-integrity 两种线性校验；
- `src/agent/session-ledger.ts` 实现 `SessionLedger`、staged mutation、不可变 snapshot 与
  `InMemorySessionLedger` 测试实现；
- `src/agent/context-builder.ts` 只接受 `ProtocolContextView`，所有 initial、admission 和
  iteration 请求都在 adapter 前经过 validator；
- `src/agent/loop.ts` 已把 returned/cancelled/failed completion 统一到同一原子写屏障，
  completion commit 失败时不会执行 batch 中的下一个工具；
- `src/agent/runtime-session.ts` 已取消整 turn message rollback，terminal 只结束 turn，
  required event sink 失败不会删除已接受的 canonical facts。

F3 与 F4 同批落地，因此生产实现直接使用 `SqliteSessionLedger`；
`InMemorySessionLedger` 只保留为共享领域核心与纯单元测试 fixture，不存在运行时配置回退。
专项测试覆盖 canonical immutability、single/multi-tool、open frame、缺失/重复/错序/错配、
hash corruption、cancel/failure/interruption，以及 completion 写失败后的 side-effect barrier。

## 一、结论先行

F3 不实现 SQLite，也不实现 `/resume`。它先把当前的
`InMemorySessionConversation` 升级为一个协议安全的内存会话账本，冻结以后需要写入
SQLite 的领域契约。

这一阶段的核心不是给 `AgentMessage` 多加几个字段，而是建立四个不能绕过的边界：

1. canonical message、tool result 和 protocol frame 都由 `RuntimeSession` 拥有的
   `SessionLedger` 统一追加，调用方不能直接修改底层数组。
2. assistant 一旦声明 tool calls，就打开一个 `tool_exchange` frame；只有每个 call 都有
   严格配对的 tool message 后，frame 才能关闭。
3. 每次 `model.prepare()` 前，都先由 `ContextProtocolValidator` 校验 provider-neutral
   视图；open、缺失、重复、错序或错配一律在 adapter 和 provider 之前 fast-fail。
4. tool raw result、模型可见 observation 和 tool message 作为一个原子 completion 提交；
   提交失败后绝不继续下一个可能有副作用的工具。

F3 还需要有意调整 F1 的一个过渡语义：不再等 turn terminal event 成功后才把整个 turn
delta 一次性放入 canonical history。user、assistant 和 tool completion 在各自写屏障处
进入账本；turn terminal 只结束 turn，不回滚已经接受的事实。这样 F4 才能在进程中断后
区分“已经持久化的结果”和“执行状态未知的第一个缺口”。

完成 F3 后，正常请求发送给 provider 的消息内容和顺序不应改变；改变的是这些消息在
进入请求前已经具备稳定身份、不可变记录、完整 frame 和可验证的协议关系。

## 二、当前实现基线与具体缺口

### 2.1 F1、F2 已经提供的接缝

当前代码已经具备以下基础：

- `RuntimeSession` 是 conversation、turn、iteration、tool call 和资源生命周期的唯一
  session owner。
- `SessionConversation` 隔离了 agent loop 与完整历史，`runAgent()` 不能直接 commit 或
  discard session。
- `ContextBuilder` 是正常模型请求的统一 provider-neutral 构建入口。
- `ModelClient.prepare()` 已经把“实际发送的 payload”和 F2 preflight 绑定在一起。
- provider adapter 已校验 assistant 输出、tool call 基本字段和 usage。
- `ToolRawResult` 是判别联合，`ObservationBuilder` 再确定性生成模型可见文本。
- 受控取消和未分类工具异常已经会为剩余 tool calls 补充 tool messages。

F3 应复用这些边界，不重新设计 RuntimeSession、ContextMeter 或工具生命周期。

### 2.2 `SessionConversation` 仍只是可变消息数组

`src/agent/session-conversation.ts` 当前内部保存：

```ts
private readonly committed: AgentMessage[];
private pending?: InMemoryPendingTurn;
```

它只能保证一个 open turn 和一次性 commit/discard，不能回答：

- 一条 message 的稳定 ID、ordinal 和内容 hash 是什么；
- 一条 tool message 属于哪个 protocol frame；
- assistant 声明的 N 个 tool calls 是否已完整配对；
- raw result、observation 与 tool message 是否来自同一次提交；
- snapshot 中的对象后来是否被外部引用修改过。

`appendAssistant()` 和 `appendTool()` 目前只是 `Array.push()`，任何角色顺序和关联都能进入
下一次模型请求。

### 2.3 tool 协议完整性依赖 agent loop 的局部约定

`src/agent/loop.ts` 当前按以下顺序工作：

```text
append assistant message
  -> 逐个执行 tool
  -> 写 raw-result events
  -> ObservationBuilder.build()
  -> append tool message
```

取消和异常路径会补齐 placeholder，但“补齐了几条、是否错序、是否重复”没有独立领域对象
校验。只要未来另一条代码路径忘记调用 helper，悬空 tool call 就会进入下一次请求。

此外，raw result event、observation event 和 conversation tool message 是三次独立动作。
工具副作用已经发生后，如果中间一步失败，当前内存模型只能 discard 整个 turn，无法诚实
保存已经发生的事实。

### 2.4 adapter 是映射器，不是出站历史 validator

`src/model/openai-chat-mapping.ts` 会把：

- assistant `toolCalls` 映射成 `tool_calls`；
- tool message 的 `providerToolCallId` 映射成 `tool_call_id`。

但它不会检查完整消息序列中是否存在：

- open tool batch；
- 同一 frame 内重复的 provider tool call ID；
- 缺失、重复、错序或属于其他 call 的 tool message；
- tool name、内部 `toolCallId` 与 assistant call 不一致。

F3 必须在调用 adapter 前完成这些检查，不能依赖远端 provider 返回 400 才发现本地历史
已经损坏。

### 2.5 F1 的整 turn commit 不足以支持 F4

当前 `RuntimeSession` 先写 terminal event，再 `pendingConversation.commit()`；required sink
失败则 discard 整个 delta。

这对 F1 的内存所有权目标成立，但不能作为持久化契约：

- 一个 turn 可能运行很久，不能用一个跨网络和工具执行的数据库 transaction 包住它；
- Write、Edit、Bash 或 MCP 副作用发生后，丢弃 tool result 不会撤销真实世界；
- 进程中断时，F4 必须知道哪些 completion 已经稳定落账；
- event log 是诊断记录，不能决定 canonical history 是否存在。

因此 F3 要把“message 写屏障”和“turn terminal”拆开。

## 三、目标与非目标

### 3.1 目标

F3 完成后必须满足：

1. 每条 canonical message 有稳定 `MessageId`、连续 ordinal、frame 归属、内容 hash 和
   客观 origin。
2. message 正文、assistant tool call 骨架和 tool completion 一经提交不可修改。
3. system、user、assistant text 和完整 tool exchange 都有显式 `ProtocolFrame`。
4. 同一个 session 同时最多存在一个 open frame，而且只能位于 canonical tail。
5. 每次 provider 请求只由 closed frames 构建，并在 adapter 前通过完整协议校验。
6. tool completion 的 raw result、observation 与 tool message 原子提交并可相互校验。
7. 受控取消、工具异常、跳过和未来的进程中断都使用同一套 completion/frame 规则。
8. 账本写入或已提交历史校验失败时，session fault；不会执行下一个有副作用的工具，也
   不会访问 provider。
9. 同一份 canonical records 可重复构建出字节稳定的 provider-neutral messages。
10. 对健康历史，F2 的消息选择、token 计量、preflight 和 provider payload 保持不变。

### 3.2 非目标

F3 不做：

- SQLite、schema migration、single-writer lock 或 `/resume`。
- context revision、换出、checkpoint、`/compact` 或自动 compaction。
- Recall、FTS、embedding 或跨 session 搜索。
- event log replay；`events.jsonl` 继续只用于诊断。
- tool 并发执行；当前 batch 继续严格按 provider 顺序串行执行。
- provider raw response 持久化或把 provider-native payload 作为 canonical history。
- 为旧实验数据做兼容层；F3 尚无持久化 schema。
- 把协议 validator 泛化成任意 provider 的通用标准；第一版只覆盖当前
  OpenAI-compatible assistant/tool exchange 语义。

## 四、必须保持的不变量

```text
RuntimeSession 是 SessionLedger 的唯一 owner
同一 session 最多一个 open turn
同一 session 最多一个 open protocol frame
open frame 只能位于 canonical tail
message ordinal 从 1 开始且严格连续
MessageId、ProtocolFrameId、ToolCallId 在 session 内唯一
system message 恰好一条，位于 ordinal=1，并独占 closed system frame
每条 message 恰好属于一个 frame
每条 tool message 恰好对应一个 assistant tool call 和一个 ToolResultRecord
tool_exchange 中 tool messages 与 assistant toolCalls 顺序一致
同一 tool_exchange 内 providerToolCallId 唯一
providerToolCallId 不作为 Tinker 内部主键
canonical 正文和关联一旦提交不可修改
frame 只允许 open -> closed 的单调状态转换
只有 closed frames 可以进入 provider 请求
tool completion 提交成功前不能开始下一个有副作用的 tool
ledger fault 后不能再构建请求、追加消息或开始 tool
event sink 失败不能删除已经进入 canonical ledger 的事实
```

provider tool call ID 的唯一性范围明确为**单个 tool_exchange frame**。内部关联始终使用
session 内唯一的 `ToolCallId`。不要求 provider 在不同 assistant responses 之间永不复用
opaque ID，避免施加当前协议并不需要的全 session 限制。

## 五、领域数据模型

### 5.1 新增身份类型

沿用现有 UUIDv7 opaque ID 体系：

```ts
export type MessageId = RuntimeId<"message">;
export type ProtocolFrameId = RuntimeId<"protocol-frame">;

export type RuntimeIdFactory = {
  createSessionId(): SessionId;
  createTurnId(): TurnId;
  createIterationId(): IterationId;
  createToolCallId(): ToolCallId;
  createMessageId(): MessageId;
  createProtocolFrameId(): ProtocolFrameId;
};
```

规则：

- ID 在 staged mutation 构造时分配；mutation 失败可以消耗 UUID，但不能消耗 ordinal。
- 测试继续注入 deterministic factory，不能从 UUID 文本猜顺序。
- provider ID 只保存在 tool call/tool message 协议字段中，不能替代以上内部 ID。

### 5.2 Canonical message record

不要把持久化元数据继续塞进轻量 `AgentMessage`。账本记录使用独立判别联合，构建请求时
再还原 `AgentMessage`：

```ts
type CanonicalMessageBase = {
  messageId: MessageId;
  sessionId: SessionId;
  frameId: ProtocolFrameId;
  ordinal: number;
  contentSha256: string;
  createdAt: string;
};

type CanonicalMessageRecord =
  | (CanonicalMessageBase & {
      role: "system";
      content: string;
      origin: "runtime";
    })
  | (CanonicalMessageBase & {
      role: "user";
      turnId: TurnId;
      content: string;
      origin: "user";
    })
  | (CanonicalMessageBase & {
      role: "assistant";
      turnId: TurnId;
      iterationId: IterationId;
      content: string | null;
      reasoningContent?: string | null;
      toolCalls?: readonly ToolCall[];
      provider: string;
      model: string;
      origin: "model";
    })
  | (CanonicalMessageBase & {
      role: "tool";
      turnId: TurnId;
      iterationId: IterationId;
      toolCallId: ToolCallId;
      providerToolCallId: string;
      name: string;
      content: string;
      origin: "tool" | "runtime";
    });
```

字段约束：

- `content` 是模型可见正文的唯一 source of truth。
- assistant `undefined` content 在入账时规范化为 `null`；零长度 `toolCalls` 规范化为缺失。
- assistant tool calls 必须深拷贝并冻结；`args`、`rawArgs` 和 identity 之后不能被外部引用
  改写。
- assistant 的 `provider`、`model` 只记录模型输出的客观来源，不进入下一次 provider
  message。
- 实际工具 observation 的 tool message 使用 `origin: "tool"`；取消、异常、跳过和中断
  生成的合成 tool message 使用 `origin: "runtime"`。
- `createdAt` 由账本注入的 clock 生成，只用于事实记录，不参与 provider message。
- usage、finish reason、event sequence 和 provider raw response 不属于 message record。

### 5.3 Content hash 的精确定义

统一使用现有 `stableJsonStringify()` 与 `sha256()`，hash 输入固定为：

```ts
sha256(stableJsonStringify({ content }))
```

使用带字段名的 canonical JSON envelope，可以区分 assistant 的 `null` 与空字符串，也避免
调用方各自决定换行、编码或空值规则。

`contentSha256` 只证明模型可见正文。assistant tool call skeleton、reasoning 和 tool result raw
分别通过不可变结构、validator 和 `rawSha256` 保证，不把多个不同语义都伪装成
“content hash”。

### 5.4 Protocol frame

frame 只保存边界和身份，不复制 assistant tool calls；协议骨架的唯一 source of truth 仍是
assistant message record：

```ts
type ProtocolFrame = {
  frameId: ProtocolFrameId;
  sessionId: SessionId;
  turnId?: TurnId;
  iterationId?: IterationId;
  kind: "system" | "user" | "assistant_text" | "tool_exchange";
  state: "open" | "closed";
  firstOrdinal: number;
  lastOrdinal?: number;
};
```

约束：

- `system`、`user`、`assistant_text` 创建时立即 closed，且
  `firstOrdinal === lastOrdinal`。
- `tool_exchange` 的第一条记录必须是带非空 `toolCalls` 的 assistant message。
- open `tool_exchange` 的 `lastOrdinal` 未定义；当前 tail 可从 message records 推导。
- 最后一条所需 tool message 提交时，frame 原子执行 `open -> closed`，并一次性写入
  `lastOrdinal`。
- frame metadata 只允许这一次单调 closure 更新；正文、首 ordinal、kind 和 identity 不可
  修改。

这里对“append-only”的精确定义是：message 和 tool-result records 只追加，已提交字段不可
更新；frame 和未来 turn metadata 只允许预先定义的单调 terminal transition。不能借
`open -> closed` 修改任何已有正文。

### 5.5 Tool completion 与 ToolResultRecord

tool execution 返回结果和 runtime 合成结果使用同一个 completion 联合：

```ts
type SyntheticToolCompletionReason =
  | "cancelled_active"
  | "skipped_after_cancel"
  | "failed_active"
  | "skipped_after_failure"
  | "interrupted_active"
  | "skipped_after_interruption";

type ToolCompletion =
  | {
      kind: "returned";
      raw: ToolRawResult;
      rawSha256: string;
      observationFormat: "tool-observation-v1";
    }
  | {
      kind: "synthetic";
      reason: SyntheticToolCompletionReason;
      detail?: string;
    };

type ToolResultRecord = {
  sessionId: SessionId;
  frameId: ProtocolFrameId;
  toolCallId: ToolCallId;
  toolMessageId: MessageId;
  completion: ToolCompletion;
  observationSha256: string;
  createdAt: string;
};
```

observation 正文只保存在对应 tool message 的 `content`，`ToolResultRecord` 通过
`toolMessageId` 和相同 hash 引用它，避免保存两份可漂移的正文。

对 `returned` completion：

- `raw` 在提交前转成 canonical JSON 深拷贝并冻结；
- `rawSha256 = sha256(stableJsonStringify(raw))`；
- `raw.ok === false` 仍然是完整返回，不是 open frame，也不是 synthetic failure；
- observation 必须先完整构建，之后和 tool message 在同一 mutation 中提交。

对 `synthetic` completion：

- 不伪造 `ToolRawResult`；
- 原因是 runtime 能客观确认的枚举；
- `failed_active` 必须保存规范化后的 error detail，其他 reason 不接受无意义 detail；
- 具体模型可见文案由 reason 与 detail 的确定性 renderer 生成；
- event log 可以额外保存 error 诊断，但不能把 error stack 混入 canonical 协议字段。

`searchableText`、FTS 字段和 swap placeholder metadata 留到 F5/I2，不在 F3 提前加入。

## 六、ProtocolFrame 状态机

### 6.1 单消息 frame

```text
system prompt
  -> append system message
  -> create closed system frame

accepted user prompt
  -> append user message
  -> create closed user frame

assistant without tool calls
  -> validate assistant
  -> append assistant message
  -> create closed assistant_text frame
```

system frame 恰好一个。相邻 user frames 是合法状态：模型请求在产生 assistant 前失败或
取消时，下一 turn 可以再追加 user frame，不伪造 assistant 回复。

### 6.2 tool exchange frame

```text
validated assistant with N tool calls
  -> append assistant message
  -> create open tool_exchange frame
  -> expected next call = toolCalls[0]

commit completion for toolCalls[i]
  -> append one ToolResultRecord
  -> append exactly one tool message
  -> if i < N - 1: frame remains open
  -> if i = N - 1: frame becomes closed and records lastOrdinal
```

assistant 同时有 progress text 和 tool calls 时，text 仍在这个 assistant message 内，整个
message 属于 `tool_exchange`。不能拆成一个 `assistant_text` frame 加另一个 tool frame，
否则 future compaction 可能只保留其中一半。

### 6.3 顺序约束

F3 保持当前 tool batch 串行语义：

```text
assistant.toolCalls = [A, B, C]
canonical tail      = assistant, tool(A), tool(B), tool(C)
```

账本只接受“从当前缺口开始的一段连续 completions”。不能先提交 B，不能重复提交 A，也
不能把另一个 frame 的 call 填进来。

如果未来允许 tool 并发执行，执行结果也必须先在内存中按 call index 缓冲，再按 provider
顺序提交；不能改变 canonical ordering。并发不属于 F3。

### 6.4 可请求边界

只有以下状态可以构建 provider request：

```text
ledger healthy
AND no open frame
AND all selected frames are closed
AND ContextProtocolValidator passes
```

tool batch 中间调用 `buildModelRequest()` 必须直接抛出带 frame ID 的协议错误，不能自动
忽略 open tail，也不能只发送已经完成的 tool messages。

## 七、SessionLedger API 与所有权

### 7.1 目标接口

F3 用 `SessionLedger` 替换 `SessionConversation`；不保留旧名字的兼容 alias：

```ts
type SessionLedger = {
  beginTurn(input: {
    turn: TurnIdentity;
    userPrompt: string;
  }): PendingLedgerTurn;
  buildCommittedModelRequest(tools: readonly ToolDefinition[]): ModelRequestInput;
  buildCandidateModelRequest(
    userPrompt: string,
    tools: readonly ToolDefinition[],
  ): ModelRequestInput;
  committedMessageCount(): number;
};

type PendingLedgerTurn = {
  readonly agent: AgentTurnLedger;
  projectedMessageCount(): number;
  finish(result: RunAgentResult): void;
  fault(error: unknown): void;
};

type AgentTurnLedger = {
  appendAssistant(input: {
    iteration: IterationIdentity;
    message: AssistantMessage;
    provider: string;
    model: string;
  }): void;
  assertCanExecuteTool(call: ToolCall): void;
  commitToolCompletions(
    completions: readonly ToolCompletionInput[],
  ): void;
  buildModelRequest(tools: readonly ToolDefinition[]): ModelRequestInput;
};
```

`ToolCompletionInput` 包含 call、observation，以及 `returned raw` 或 synthetic reason。它
只是 mutation 输入，不作为已提交记录暴露。

### 7.2 两层权限继续保留

- `runAgent()` 只拿 `AgentTurnLedger`，不能开始/结束 turn、读取完整内部数组或清理历史。
- `RuntimeSession` 持有 `PendingLedgerTurn`，负责 terminal 和 fault。
- model adapter 只拿重建后的 `ModelRequestInput`，不能访问 record/frame/tool-result 元数据。
- TUI 与 event sinks 继续只消费事件投影，不能读取或修改 ledger。

### 7.3 `beginTurn()` 是第一道写屏障

F2 admission preflight 仍然先用 ephemeral candidate user message，不分配 MessageId/ordinal，
也不修改账本。

admission 通过后：

```text
RuntimeSession.createTurn()
  -> ledger.beginTurn(turn, prompt)
     -> atomic append closed user frame + user message
  -> turn.started event
  -> runAgent()
```

如果 `beginTurn()` 追加失败：

- session 进入 faulted；
- 不写 `turn.started`；
- 不请求 provider；
- 不执行工具；
- ordinal 不前进。

### 7.4 F1 commit/discard 的演进

F3 删除控制整段 message delta 的 `commit()` / `discard()`：

- `finish(result)` 只验证当前 turn 没有 open frame，并释放 turn ownership；
- 已经成功追加的 user/assistant/tool records 保持存在；
- unexpected error 若发生在任何 assistant 入账前，保留 user frame；
- unexpected error 若留下 open frame，不能正常 finish，session 必须 fault；
- required event sink 或 terminal event 失败会 fault session，但不能删除已经落账的事实。

这不是允许半截历史继续运行。账本一旦 fault 或留下未恢复的 open frame，所有新请求和
tool side effect 都被禁止。F4 再从持久化 open frame 执行明确的 interrupted recovery。

### 7.5 不暴露可变引用

账本内部在追加前完成：

1. 输入校验；
2. JSON canonical clone；
3. hash；
4. deep freeze；
5. staged mutation 校验；
6. 一次 commit。

构建请求时返回新的 `AgentMessage[]` 和必要的嵌套副本。测试即使修改返回数组、tool call
args 或 raw fixture，也不能改变后续请求。

## 八、Tool completion 的原子写屏障

### 8.1 正常返回

每个工具按以下顺序执行：

```text
ledger.assertCanExecuteTool(call)
  -> tool.started required event
  -> ToolRuntime.execute(call)
  -> ObservationBuilder.build({ call, raw })
  -> ledger.commitToolCompletions([
       { call, kind: "returned", raw, observation }
     ])
  -> tool.raw_result / tool.finished / tool.observation events
  -> 才允许检查并开始下一个 call
```

`commitToolCompletions()` 一次提交：

- canonical raw clone 与 raw hash；
- `ToolResultRecord`；
- tool message record；
- message ordinal；
- 如果是最后一个 call，frame closure。

任何一项 staging 失败都不改变账本；commit infrastructure 失败则 ledger/session fault。

canonical ledger 先于完成事件写入。event log 是诊断面，不拥有回滚 canonical facts 的
权限。如果 ledger commit 后 required event sink 失败，session 停止，但 tool result 仍然
留在账本。

### 8.2 受控取消

取消发生点分两类：

1. call 尚未开始：所有剩余 calls 使用 `skipped_after_cancel`。
2. call 正在执行且因 abort 抛出：当前 call 使用 `cancelled_active`，后续 calls 使用
   `skipped_after_cancel`。

剩余 completions 在一次 batch mutation 中提交并关闭 frame。当前 call 的文案继续明确：
副作用可能已经部分发生，重试前检查当前状态。

若 cancellation completion commit 失败，不能继续 terminal 正常路径；session fault，open
frame 留给 F4 recovery。

### 8.3 工具执行抛出未分类异常

`ToolRuntime` 正常会把非取消异常转成 `GenericToolRawResult`。如果更底层 transport 或测试
注入仍然抛出：

- 当前 call：`failed_active`；
- 后续 calls：`skipped_after_failure`；
- 一次 batch commit 关闭 frame；
- turn 返回 structured failed。

只有 completion 成功落账后才能把 turn 作为可继续的失败结束。

### 8.4 进程中断恢复规则

F3 不实现 resume，但必须实现并测试一个纯领域 helper，让 F4 直接调用同一规则：

```text
open frame 中已提交的 calls = [A, B]
尚缺 calls                  = [C, D, E]

C -> interrupted_active
D -> skipped_after_interruption
E -> skipped_after_interruption
```

因为工具严格串行，且开始下一个副作用前必须先提交上一个 completion，所以第一个缺口 C
是唯一可能已经开始但未落账的 call；更后的 D/E 可以客观标记为未执行。

恢复 helper：

- 不读取 event log 猜测执行状态；
- 不自动重试任何 call；
- 原子提交所有缺失 synthetic completions；
- 关闭 frame；
- 使用固定文案提醒第一个缺口的副作用状态未知。

F4 在持有 single-writer lock 且数据库 transaction 可写后才调用它。

## 九、ContextProtocolValidator

### 9.1 放置位置

生产请求路径固定为：

```text
SessionLedger 构造 ProtocolContextView
  -> ContextBuilder.build(view, tools)
       -> ContextProtocolValidator.validate(view)
       -> 从 canonical records 稳定重建 AgentMessage[]
  -> ModelClient.prepare(...)
  -> ContextMeter.measure(...)
  -> provider request
```

validator 不依赖 SQLite、OpenAI SDK、ContextMeter 或 event sink。它只读取 provider-neutral
frame/message/tool-result view。

`toOpenAIChatMessages()` 继续是纯映射器，不复制一套历史 validator。生产 session 不能
绕开 `SessionLedger.build*ModelRequest()`。

### 9.2 校验算法

validator 每次请求按 frame ordinal 顺序做一次线性扫描：

1. ledger/view 非 faulted，且没有 open frame。
2. frame ID 唯一；frame 范围连续、无重叠、无空洞。
3. message ordinal 从 1 严格连续，MessageId 唯一，每条 message 的 frameId 与范围一致。
4. 第一帧是唯一 system frame，包含唯一 system message。
5. `user` frame 恰好一条 user message。
6. `assistant_text` frame 恰好一条无 tool calls 的 assistant message，且有非空文本。
7. `tool_exchange` frame：
   - 第一条是 assistant；
   - tool calls 数量 `N >= 1`；
   - call 的 session/turn/iteration identity 与 frame 一致；
   - `toolCallNumber` 在当前 iteration 中为 1..N；
   - `ToolCallId` 在 session 内唯一；
   - `providerToolCallId` 非空，并在当前 frame 内唯一；
   - frame 总 message 数恰好为 `1 + N`；
   - 第 i 条 tool message 的内部 ID、provider ID 和 name 都与第 i 个 call 相同；
   - 每条 tool message 恰好有一个 ToolResultRecord；
   - result 的 frameId、toolCallId、toolMessageId 和 observation hash 全部匹配；
   - returned raw 的 canonical hash 匹配 `rawSha256`。
8. 扫描完成后不能存在未被 frame 覆盖的 message 或未被 tool message 使用的 result。

请求热路径无需每次对超大正文重复计算 content hash。hash 在 append 时计算并冻结，F4 在
load/integrity check 时重算；每次请求的 validator 重点检查 frame 和关联。测试用 corruption
fixture 可以启用 full-integrity 模式重算所有 hash。

### 9.3 错误类型

```ts
class ContextProtocolError extends Error {
  readonly code: ContextProtocolErrorCode;
  readonly frameId?: ProtocolFrameId;
  readonly messageId?: MessageId;
  readonly ordinal?: number;
  readonly toolCallId?: ToolCallId;
}
```

至少需要稳定区分：

- `open_frame`；
- `ordinal_gap` / `frame_range_mismatch`；
- `duplicate_message_id` / `duplicate_tool_call_id`；
- `duplicate_provider_tool_call_id`；
- `missing_tool_message` / `unexpected_tool_message`；
- `tool_message_order_mismatch` / `tool_message_identity_mismatch`；
- `missing_tool_result` / `tool_result_mismatch`；
- `content_hash_mismatch` / `raw_hash_mismatch`。

错误必须包含最接近损坏来源的 frame/message/call 身份，不能只报告“invalid messages”。

### 9.4 失败分类

需要区分两种错误：

- **候选输入非法**：例如刚收到的 assistant 有重复 provider IDs。mutation 前拒绝，账本
  仍健康；本 turn 失败且没有 tool side effect，可以保留 user frame。
- **已提交账本非法或 commit 失败**：说明 canonical state 不再可信；ledger 与
  RuntimeSession 都进入 faulted，禁止下一次 provider/tool 操作。

不能为了“继续聊天”自动删除、排序或补猜损坏记录。

## 十、关键执行流程

### 10.1 普通文本回答

```text
admission candidate validation + F2 preflight
  -> append closed user frame
  -> model request preflight
  -> provider response validation
  -> append closed assistant_text frame
  -> terminal event
  -> PendingLedgerTurn.finish(completed)
```

### 10.2 多工具 batch

```text
append closed user frame
  -> provider returns assistant(text + A/B/C)
  -> validate candidate assistant
  -> append assistant + open tool_exchange
  -> execute A
  -> atomic commit result(A) + tool(A)
  -> execute B
  -> atomic commit result(B) + tool(B)
  -> execute C
  -> atomic commit result(C) + tool(C) + close frame
  -> ContextProtocolValidator
  -> F2 prepare / preflight
  -> next provider request
```

### 10.3 模型请求失败或取消

provider 没有返回可接受 assistant 时，不创建 assistant frame。user frame 已经 canonical：

```text
system, ..., user(failed turn), user(next turn)
```

这是合法历史，不生成虚假 assistant 消息。

### 10.4 tool observation 使下一 iteration 超预算

tool completion 已经提交并关闭 frame；之后 F2 preflight blocked：

- 不访问 provider；
- 不删除或缩短 observation；
- turn structured failed；
- closed frame 保持 canonical；
- F3 validator 仍应通过。

### 10.5 required event sink 失败

按失败时点处理：

| 失败时点 | canonical ledger | 后续动作 |
| --- | --- | --- |
| `turn.started` 前，user append 已成功 | 保留 user frame | session fault，不请求模型 |
| assistant append 后的 model event | 保留 assistant/frame | session fault，不执行 tool |
| tool completion 后的 result event | 保留 result/tool message | session fault，不执行下一个 tool |
| terminal event | 保留整个已追加 turn | session fault，不接受下一 turn |

event log 不再充当 conversation commit 门闩。

### 10.6 ledger append 失败

| 失败写屏障 | 已发生的外部动作 | 必须保证 |
| --- | --- | --- |
| user append | 无 | 不请求 provider |
| assistant append | provider 已返回 | 不执行任何 tool |
| returned completion append | 当前 tool 可能有副作用 | 不执行下一个 tool；保留 open frame |
| synthetic batch append | 当前 tool 可能已部分执行 | 不请求 provider；保留 open frame |

账本实现必须把 mutation staging 与 commit 分开。所有可能抛出的规范化、hash、identity 和
顺序校验先完成；内存 commit 只执行不会再调用外部代码的状态替换。测试通过注入
`beforeCommit` failure 验证零部分写入。F4 用 SQLite transaction 替换这一步。

## 十一、与 F1/F2、RuntimeSession 和事件的衔接

### 11.1 F2 请求顺序保持不变

F3 只在 `model.prepare()` 前增加协议门禁：

```text
ledger.buildModelRequest()
  -> protocol validate
  -> stable AgentMessage materialization
  -> model.prepare()
  -> ContextMeter.measure()
  -> context.usage.updated(preflight)
  -> assertWithinBudget()
  -> model.request.started
  -> model.request()
```

健康历史的 prepared payload、prompt segments、request config hash、tool schema hash 和 token
估值必须与 F3 前逐字节一致。

admission path 同样先验证 committed ledger，再临时追加 candidate user message。candidate
不进入 canonical IDs，也不改变 ContextMeter anchor。

### 11.2 Prefix 稳定性

F3 的 message/frame metadata 不发送给 provider。两次请求之间只追加新的 provider-neutral
messages；旧 message 不重建为不同内容。

测试继续使用 F2 的 normalized prompt segments 验证：

```text
request N prefix hash = H
append closed frame
request N+1 的旧长度 prefix hash仍 = H
```

frame 从 open 变 closed 只修改本地 metadata，不修改已追加 assistant/tool message。

### 11.3 RuntimeSession 状态

RuntimeSession 继续拥有 ready/executing/faulted/dispose 状态。新增规则：

- `SessionLedgerWriteError` 或 committed `ContextProtocolError` 立即映射为 session fault；
- session fault 后 `executeTurn()`、model request 和 `assertCanExecuteTool()` 全部拒绝；
- dispose 仍执行资源清理和 best-effort terminal diagnostics；
- ledger fault 不尝试清空 canonical records。

### 11.4 事件职责

F3 不需要把每条 ledger mutation 再复制成新的大 payload event。现有事件继续服务：

- provider 和工具执行观测；
- TUI projection；
- 人工诊断。

建议新增一个小型 `session.ledger_faulted` 诊断事件，只包含 error code、frame/message/call ID，
不复制正文、raw result 或完整 ledger snapshot。是否新增该事件不影响 canonical correctness。

## 十二、代码落点

### 12.1 新增模块

#### `src/agent/session-ledger.ts`

- `SessionLedger`、`PendingLedgerTurn`、`AgentTurnLedger` 接口。
- `InMemorySessionLedger` 实现。
- 唯一 open turn/open frame 所有权。
- staged mutation、ordinal 分配、不可变 snapshot 和 fault 状态。
- candidate request、committed request 与 current-turn request 构建入口。

#### `src/context/protocol-frame.ts`

- `CanonicalMessageRecord`、`ProtocolFrame`、`ToolResultRecord`。
- content/raw hash helpers。
- canonical clone/freeze 和 `AgentMessage` 重建。
- synthetic completion reason 与确定性文案 renderer。
- interrupted frame completion helper。

#### `src/context/context-protocol-validator.ts`

- 纯 `ContextProtocolValidator`。
- `ContextProtocolError` 与稳定错误 code。
- normal/full-integrity 两种校验模式；生产 request 使用 normal，load/fault tests 使用 full。

#### 测试

- `src/__tests__/session-ledger.test.ts`
- `src/__tests__/context-protocol-validator.test.ts`

### 12.2 修改模块

#### `src/ids/runtime-id.ts`

- 新增 `MessageId`、`ProtocolFrameId` 与 factory 方法。
- 更新所有 deterministic test factories。

#### `src/agent/runtime-session.ts`

- factory 从 `createConversation(systemPrompt)` 改为接收 session identity、ID factory、clock
  和 ContextBuilder 的 `createLedger(...)`。
- begin turn 时先写 user frame。
- terminal path 改为 `finish()`，移除 message delta rollback。
- ledger write/protocol integrity error 映射为 session fault。

#### `src/agent/loop.ts`

- 输入从 `AgentTurnConversation` 改为 `AgentTurnLedger`。
- append assistant 时传 iteration、provider 和 model。
- 执行每个 tool 前调用 `assertCanExecuteTool()`。
- observation 构建后调用原子 `commitToolCompletions()`。
- 取消/异常 helper 不再直接 `appendTool()`，改为构造 synthetic completion batch。

#### `src/agent/context-builder.ts`

- 输入改为 protocol context view，而不是裸 `AgentMessage[]`。
- 委托 validator 后稳定重建 messages。
- 继续只负责选择、顺序和 provider-neutral request，不读取 SQLite 或决定 compaction。

#### `src/agent/types.ts`

- `AgentMessage` 保持轻量 provider-neutral transport 类型。
- 根据实现需要把 `toolCalls` 和相关数组收紧为 readonly。
- 不把 ordinal/hash/frame/origin 全部塞进 `AgentMessage`。

#### `src/model/model-client.ts` 与 `src/model/openai-chat-mapping.ts`

- 接受 readonly 输入所需的最小类型调整。
- adapter 映射语义不变，不在这里复制 validator。

#### `src/observation/observation-builder.ts`

- 导出稳定 observation format version。
- 保持 renderer 纯函数；不写 ledger/event。

#### 现有测试

- runtime-session、agent-loop、turn-cancellation、context-measurement 和 OpenAI mapping fixtures
  改用 ledger helper。
- 删除依赖 `snapshot()` 可变 `AgentMessage[]` 的测试写法，改断言 canonical records 或稳定
  request materialization。

### 12.3 删除与不保留

完成迁移后删除 `src/agent/session-conversation.ts`，不保留转发 wrapper。F3 是内部契约的
明确替换，不需要同时维护 conversation 和 ledger 两套 source of truth。

## 十三、分步实施顺序

### F3.1：身份、records 与纯 validator

1. 增加 Message/Frame IDs 和 deterministic factories。
2. 定义 canonical record、frame、tool result、hash 和 immutable clone。
3. 实现纯 `ContextProtocolValidator`。
4. 用手工 fixtures 覆盖正常与损坏 frame，不接 runtime。

完成门槛：单工具、多工具、text+tools 均通过；缺失、重复、错序、错配均产生精确错误。

### F3.2：InMemorySessionLedger 与稳定重建

1. 实现 system/user/assistant frame append。
2. 实现 ordinal、open frame ownership、candidate view 和 request materialization。
3. 实现 tool completion 原子 mutation 与 full-integrity snapshot。
4. 增加外部引用 mutation tests 和 byte-stable golden tests。

完成门槛：账本 API 无法构造非法正常状态；同一 records 多次重建结果完全一致。

### F3.3：Agent loop 写屏障迁移

1. runAgent 改用 `AgentTurnLedger`。
2. 正常 raw/observation/tool message 改为单次 commit。
3. cancellation/failure placeholders 改为 synthetic completions。
4. 每个后续 tool 前增加 ledger side-effect barrier。

完成门槛：任何 completion commit fault 都不会调用 batch 中下一个 executor。

### F3.4：RuntimeSession terminal 语义迁移

1. beginTurn 即追加 user frame。
2. 用 `finish/fault` 替换 `commit/discard`。
3. 明确 event sink failure 与 ledger failure 的组合行为。
4. 更新 RuntimeSession 和 dispose tests。

完成门槛：已落账事实不因 terminal event 失败消失；faulted session 不能继续请求或执行。

### F3.5：中断 helper、回归与文档回填

1. 实现 open frame interrupted recovery helper。
2. 用 F2 prepared segments 做 payload/prefix golden 对比。
3. 运行完整检查并回填实际差异。
4. 更新路线图 F3 状态；只有全部门槛通过后进入 F4。

## 十四、测试计划

### 14.1 Record 与身份

- system message 固定 ordinal=1，且只有一个 system frame。
- MessageId/FrameId 唯一，ordinal 连续；失败 mutation 不消耗 ordinal。
- origin 与 role 组合合法，synthetic tool message 为 runtime origin。
- content 的 null、空字符串、换行和 Unicode hash 稳定。
- 修改原始 assistant args/raw fixture 不会改变 ledger。
- 修改构建出的 request 数组不影响下一次构建。

### 14.2 Frame 正常路径

- assistant text 创建 closed `assistant_text`。
- 单 tool call 在一个 completion 后关闭。
- 多 tool calls 按顺序逐个提交，最后一个才关闭。
- assistant progress text 与 calls 保持在同一 frame。
- `raw.ok=false` 仍生成普通 returned completion 并关闭对应 slot。
- JSON 参数解析失败沿现有 GenericRawResult 路径形成合法 closed frame。

### 14.3 Validator 故障注入

对一份合法 fixture 分别执行：

- 删除一条 tool message；
- 重复一条 tool message；
- 交换两条 tool messages；
- 修改内部 toolCallId；
- 修改 providerToolCallId；
- 修改 tool name；
- 在同一 assistant 中放入重复 provider ID；
- 把 tool message 移到另一个 frame；
- 制造 ordinal gap/overlap；
- 删除 ToolResultRecord；
- 修改 observation/raw hash；
- 把 frame 标为 open。

每个 case 都必须在 adapter 前失败，并报告对应 frame/message/call。

### 14.4 取消、失败与中断

- 模型请求前取消：只有 user frame，无 assistant frame。
- 第一个 tool 前取消：所有 calls 为 skipped，frame closed。
- 第二个 tool 执行中取消：第一个 returned、第二个 cancelled、其余 skipped。
- tool transport throw：当前 failed、其余 skipped，frame closed。
- context preflight 在完成 batch 后 blocked：closed frame 被保留。
- interrupted helper：第一个缺口 unknown，后续 skipped，不重试 executor。

### 14.5 原子性与 side-effect barrier

在以下 commit 点注入失败：

- user message；
- assistant message/open frame；
- returned completion；
- synthetic completion batch；
- frame closure。

断言：

- mutation 前后 snapshot 没有部分记录；
- ordinal 没有空洞；
- ledger/session fault；
- provider 或后续 tool executor 调用次数没有增加；
- 当前工具若已经执行，错误明确说明副作用状态可能未知。

### 14.6 Runtime 与事件组合

- terminal event sink failure 保留 canonical messages 并 fault session。
- tool result event sink failure 不执行下一个 tool。
- presentation sink failure 仍不影响 ledger 或 agent 结果。
- dispose 取消 active turn 后，能关闭的 frame 使用受控 cancellation completions；无法提交则
  fault 并继续资源清理。

### 14.7 F2 与 adapter 回归

- 健康文本历史的 OpenAI payload 与 F3 前 golden 相同。
- 健康多工具历史的 `tool_calls` / `tool_call_id` 顺序相同。
- prepared prompt segments、estimate breakdown 和 prefix hash 相同。
- protocol invalid 时 `model.prepare()`、`model.request.started` 和 provider fetch 调用次数均为
  0。
- initial、admission、iteration 三条 build 路径都经过 validator。

### 14.8 完整门禁

```bash
bun test src/__tests__/session-ledger.test.ts
bun test src/__tests__/context-protocol-validator.test.ts
bun test src/__tests__/agent-loop.test.ts
bun test src/__tests__/runtime-session.test.ts
bun test src/__tests__/turn-cancellation.test.ts
bun test src/__tests__/context-measurement.test.ts
bun run check
git diff --check
```

F3 不需要真实 provider smoke test；其核心是本地 canonical/协议契约。F2 已验证的真实
provider 路径只需在 prepared payload golden 发生有意变化时重新跑。

## 十五、验收标准

只有以下条件全部满足，F3 才能标记完成：

1. `SessionConversation` 已被 `SessionLedger` 完整替换，生产代码没有第二套 message source
   of truth。
2. 所有 canonical messages 都有稳定 MessageId、ordinal、frameId、content hash 和 origin。
3. system/user/assistant_text/tool_exchange 四类 frame 均有明确、测试覆盖的状态机。
4. single tool、multi-tool、progress+tools、raw failure、cancel、throw 和 interrupted recovery
   都产生合法 closed frame。
5. 缺失、重复、错序、错配和 open frame 都在 `model.prepare()` 前被拒绝。
6. raw result、observation、tool message 和 frame closure 使用一个原子 completion boundary。
7. completion 或 ledger commit 失败后，下一个有副作用工具调用次数为 0。
8. canonical records 和已发生副作用不会因 terminal event failure 被逻辑回滚。
9. 相同 records 重建的 provider-neutral stable JSON 与 prepared payload 可重复、字节稳定。
10. 健康历史的 F2 token 计量、preflight、prefix hash 和用户可见行为无回归。
11. `bun run check` 与 `git diff --check` 通过。

## 十六、给 F4 的稳定接入契约

F4 只能替换存储实现，不能重新解释 F3 的领域语义：

```text
F3 InMemorySessionLedger staged mutation
  -> F4 SQLite transaction

F3 in-memory immutable records
  -> F4 messages / protocol_frames / tool_results rows

F3 beginTurn user write barrier
  -> F4 transaction commit before model request

F3 tool completion atomic boundary
  -> F4 tool result + tool message + frame closure transaction

F3 interrupted recovery helper
  -> F4 resume open-frame recovery under single-writer lock

F3 ContextProtocolValidator
  -> F4 load integrity check + every provider request preflight
```

F4 schema 至少需要表达：

- message/frame/tool-result 的稳定 ID 和关联；
- ordinal 唯一且连续；
- frame 单调 open/closed；
- tool result 与 tool message 一对一；
- synthetic completion reason；
- content/raw hash；
- turn/session identity 和计数器。

SQLite 失败、lock 冲突或 open frame recovery 失败时，继续沿用 F3 的 fail-closed 语义。F4
不能为了恢复成功而删除损坏记录、自动重试工具或从 event log 猜 canonical history。

## 十七、最终设计决策

1. **F3 的 source of truth 是 SessionLedger，不是 `AgentMessage[]`、event log 或 TUI。**
2. **message/tool result 只追加；frame 只允许一次 `open -> closed`。**
3. **完整 tool exchange 是最小协议单元，assistant progress text 不从 tool calls 中拆开。**
4. **provider ID 只要求 frame 内唯一；内部关联使用 session 内唯一 ToolCallId。**
5. **tool raw、observation 和 tool message 一次提交，下一副作用受该提交结果阻塞。**
6. **controlled cancel、failure、skip 和 interrupted recovery 都是显式 synthetic completion，
   不伪造 raw result。**
7. **每次 provider 请求前都验证 closed frame 视图，adapter 保持纯映射。**
8. **F1 的整 turn rollback 在 F3 结束：terminal 只结束 turn，不删除已经接受的事实。**
9. **event sink failure 会停止 session，但不能回滚 canonical ledger。**
10. **F3 只验证内存领域契约；SQLite、resume、Recall 和 compaction 分别留给后续阶段。**
