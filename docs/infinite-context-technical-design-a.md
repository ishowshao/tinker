# Tinker「无限上下文」技术方案

## 文档状态

- 状态：设计稿，尚未实施
- 日期：2026-07-11
- 讨论基础：
  - [`context-research.md`](context-research.md)
  - [`context-research-commentary.md`](context-research-commentary.md)
- 相关既有设计：
  - [`agent-runtime-roadmap.md`](agent-runtime-roadmap.md)
  - [`runtime-architecture-optimization.md`](runtime-architecture-optimization.md)
  - [`runtime-session-lifecycle-design.md`](runtime-session-lifecycle-design.md)
  - [`session-turn-iteration-identity-design.md`](session-turn-iteration-identity-design.md)

## 一、结论先行

Tinker 不应该把「无限上下文」实现成更激进的摘要，也不应该在每次模型请求前临时
拼装一套不断变化的 prompt。更合适的定义是：

> Tinker 为每个 session 提供一个逻辑上持续增长、可精确寻址的历史空间；模型每次只
> 看到其中一个有界、协议合法、带来源指针的工作集。

这套系统的产品主张可以是：

> **Tinker 不因 compaction 丢弃已经进入 session 的信息，只会把它从活动上下文换出；
> 换出的原文始终保留确定性的找回路径。**

这里刻意不承诺「模型永远不会忘记」。模型仍可能没有意识到需要检索，也可能用错
信息。Tinker 能够做出并测试的承诺分为四层：

1. **保存保证**：进入 session 的用户、assistant、tool message 及其结构化来源不会因
   compact 被覆盖或删除。
2. **寻址保证**：每条原始记录都有稳定 ID，可以按 ID 精确取回原文和哈希。
3. **视图保证**：发给 provider 的上下文不包含断裂的 tool-call 协议帧，且换出占位符
   明确指向原始记录。
4. **行为边界**：关键词检索和模型是否主动调用 Recall 只能通过提示和评测改善，不能
   宣称为形式化保证。

因此，本方案吸收两份讨论文档的共同核心，但收紧实施范围：

- 接受「完整历史是外部状态、上下文只是临时视图」；
- 接受「确定性换出优先于模型摘要」；
- 接受「两次 checkpoint 之间保持 append-only」；
- 不把当前诊断 event log 直接升级为恢复数据库；
- 不在第一版引入向量库、AST 图、因果图、置信度分数或跨 session 记忆；
- 只有在确定性换出仍不足时，才生成带来源校验的结构化 checkpoint。

## 二、目标、非目标与不变量

### 2.1 目标

1. 长 session 的原始历史可以持续增长，不受单次模型 context window 限制。
2. 当前模型输入保持在配置预算内，并能说明 token 主要消耗在哪里。
3. 旧的大体积 tool observation 可以无模型调用地换出。
4. 模型可以通过一个 `Recall` 工具搜索或精确取回当前 session 的历史。
5. `/compact` 与自动 compaction 使用同一条实现路径，失败时保留原活动视图。
6. Tinker 退出后可以 `/resume`，恢复的不是一段自由文本摘要，而是同一份原始历史、
   当前 context revision 和结构化 checkpoint。
7. compaction 前后保持 OpenAI-compatible Chat Completions 的 tool-call 协议合法。
8. context revision 的变化频率足够低，避免无意义地破坏 provider 的 prefix cache。
9. 所有损坏、超预算、协议断裂和不支持的 schema 都在模型请求前 fast-fail。

### 2.2 非目标

- 不提供字面意义上的无限 token。
- 不保证模型一定能意识到它缺少某条历史。
- 不保存整个文件系统的所有历史版本；只保证保存真正进入 session 存储的内容。
- 不把当前 workspace 的文件内容和历史 Read observation 混为一谈。
- 不做跨 workspace、跨 session 的自动长期记忆。
- 不在第一版做 embedding、reranker、调用图、AST/LSP 索引或因果图。
- 不在第一版做 session 分支、Git worktree memory namespace 或多 agent capsule。
- 不为旧的本地实验数据设计复杂迁移；不支持的 schema 直接给出明确错误。

### 2.3 必须长期成立的不变量

```text
原始历史不可变
活动上下文可替换
summary 不是 source of truth
完整 tool frame 是最小协议单元
安全边界之间只追加，不改前缀
历史内容与当前工作区状态必须可区分
检索空结果只代表当前检索范围没有命中
活动视图无法在预算内合法构造时必须停止请求
```

## 三、Tinker 当前状态核对

两份研究文档对方向的判断基本成立，但技术方案必须以当前代码为准。

### 3.1 已经存在的地基

#### RuntimeSession 已经拥有稳定身份和串行事件

`src/agent/runtime-session.ts` 已经统一管理 session、turn、iteration 和 tool call 身份，
并通过 `eventTail` 串行提交带单调 `eventSequence` 的事件。required sink 写入失败会使
session 进入 `faulted`，这符合后续持久化的 fast-fail 要求。

#### raw result 与 observation 已经分离

`src/tools/types.ts` 中的 `ToolRawResult` 是带 `kind` 的判别联合；
`src/observation/observation-builder.ts` 再把 raw result 确定性渲染成模型可见文本。
这使「用较短占位符替换旧 observation」不需要模型参与。

#### ContextBuilder 是现成的模型输入边界

`src/agent/context-builder.ts` 当前只是透传，但所有正常模型请求都会经过它。后续的
token 统计和活动视图渲染可以落在这个边界，不需要把 provider 细节放进 agent loop。

#### 当前消息协议已经保留两套 tool call ID

Tinker 用内部 `toolCallId` 关联事件和状态，用 `providerToolCallId` 重建 provider 的
assistant/tool 消息关系。取消或工具失败时，agent loop 还会补齐剩余 tool message，
避免留下悬空的 assistant tool call。

#### Bash 已经展示了外部存储和按需读取模式

Bash 完整输出保存在 `.tinker/bash/<task-id>.log`，普通 observation 只放 preview 和
`outputFilePath`。这已经是一个可工作的「冷存储 + Read page-in」案例。

### 3.2 当前仍缺少的能力

1. `RuntimeSession.sessionMessages` 只在内存中，进程退出后无法恢复。
2. `ContextBuilder` 没有预算、统计、revision 或换出概念。
3. `RunAgentResult` 每个 turn 都返回完整 `messages` 数组，历史越长，复制和提交成本越高。
4. 当前没有稳定 message ID，也没有可搜索的 session history store。
5. TUI 只支持 `/quit`，还没有 `/resume`、`/status`、`/compact`。
6. `ModelUsage` 只规范化 prompt/completion/total tokens，没有缓存命中与未命中统计。
7. `TuiEventStream` 和 timeline 会随完整事件历史持续增长。

### 3.3 两个必须澄清的边界

#### `events.jsonl` 不是新的 SessionStore

当前 event log 很接近 WAL，也能从 `turn.started`、`model.request.finished` 和
`tool.observation` 重建大量消息，但既有设计明确把它定位为诊断记录，而不是恢复源。
直接把它变成恢复数据库会带来几个问题：

- event payload 面向观测演进，不是稳定的 session schema；
- `model.request.finished` 还可能包含 provider `rawResponse`；
- raw result、observation 和展示事件存在有意的重复；
- event log 没有 context revision、checkpoint 和检索索引；
- 从操作事件猜测最终提交状态，会重新引入既有设计想消除的歧义。

所以本方案新增独立 `SessionStore`。event log 继续保留完整诊断价值，SessionStore 负责
恢复、Recall 和上下文编译，两者使用同一套 session/turn/iteration/toolCall 身份。

#### 重新 Read 不等于恢复历史 Read

旧的 Read observation 被换出后，当前文件可能已经被 Edit、Write、Git 或用户修改。
因此占位符必须同时给出两条不同路径：

- `Recall(messageId)`：取回当时真正进入模型上下文的历史 observation；
- `Read(filePath)`：读取当前 workspace 的最新内容。

同理，重新运行 Grep 得到的是当前搜索结果，不是历史 Grep 的精确重放。

## 四、总体架构

```text
                         +-------------------------+
                         |       RuntimeSession    |
                         | identity / lifecycle    |
                         +------------+------------+
                                      |
                  +-------------------+-------------------+
                  |                                       |
                  v                                       v
        +----------------------+                 +--------------------+
        |    SessionStore      |                 |    Event Sinks     |
        | session.sqlite       |                 | events.jsonl       |
        | canonical history    |                 | observations.md    |
        | context revisions    |                 | TUI / stdout       |
        | checkpoint + FTS     |                 +--------------------+
        +----------+-----------+
                   |
        +----------+--------------------------------------+
        |                                                 |
        v                                                 v
+-----------------------+                       +----------------------+
|    ContextManager     |<----------------------|     Recall tool      |
| budget / policy       |     search / get      | append result at tail|
| swap planner          |                       +----------------------+
| checkpoint compiler   |
| active revision       |
+-----------+-----------+
            |
            v
  +---------------------+        +-------------------------+
  |   ContextBuilder    |------->|       ModelClient       |
  | render stable view  |        | provider serialization  |
  | estimate breakdown  |        | usage/cache metrics     |
  +---------------------+        +-------------------------+
```

### 4.1 四类状态必须分开

| 状态 | 作用 | 是否不可变 | 是否进入模型输入 |
| --- | --- | --- | --- |
| Canonical history | 保存原始 message、tool result 和来源 | 是 | 由 revision 选择 |
| Active context revision | 描述本次模型看到的有界视图 | revision 内是 | 是 |
| Event log | 诊断、观测、排障 | append-only | 否 |
| TUI projection | 当前屏幕需要的有界展示状态 | 否 | 否 |

Compaction 只创建新的 active context revision，不修改 canonical history，也不负责清理
TUI 或 event log。

### 4.2 热路径与冷路径

热路径是正常的模型 iteration：

```text
读取当前 revision -> 追加新 user/assistant/tool frame -> 发起下一次请求
```

冷路径只在安全边界运行：

```text
测量压力 -> 批量确定性换出 -> 必要时生成 checkpoint -> 原子切换 revision
```

两次 revision 切换之间，发给 provider 的旧前缀必须逐字节稳定，新内容只能追加在尾部。

## 五、Canonical History 与 SessionStore

### 5.1 存储选择

第一版使用 Bun 自带的 `bun:sqlite`：

- 不增加外部数据库服务和 npm runtime 依赖；
- transaction 适合同时提交 message、frame 和 revision；
- FTS5 足以完成当前 session 的精确/子串检索；
- 当前本机 Bun 1.3.12 已验证可创建 FTS5 `trigram` 表并检索中英文子串；
- 后续需要更多索引时不必重写 JSONL 扫描器。

建议目录：

```text
.tinker/sessions/<session-id>/
  session.sqlite
  events.jsonl
  observations.md
  active.lock

.tinker/bash/
  <task-id>.log
```

SQLite 使用 WAL 模式、外键校验和单写者队列。SessionStore 是 required resource；数据库
无法创建、schema 不支持或完整性检查失败时，在连接 MCP、请求模型和执行工具前失败。

### 5.2 核心表

第一版只需要以下表，不引入原研究中完整的知识图谱：

```text
session_meta
turns
protocol_frames
messages
tool_results
context_revisions
context_overrides
checkpoints
message_fts
```

职责如下：

- `session_meta`：schema、workspace、model、创建/更新时间、活动 revision 和计数器。
- `turns`：turn 状态及其开始、结束和取消信息。
- `protocol_frames`：可独立保留、换出或删除的协议单元。
- `messages`：不可变的 provider-neutral 原始 message。
- `tool_results`：稳定保存 raw result、observation、tool kind 和检索元数据。
- `context_revisions`：活动视图边界、checkpoint、原因和 token 统计。
- `context_overrides`：某一 revision 内被换出 tool message 的预渲染占位符。
- `checkpoints`：结构化 capsule、来源范围和渲染后的合成 message。
- `message_fts`：只索引允许 Recall 的原始内容和扁平化元数据。

`events.jsonl` 不复制进 SQLite 的 `events` 表。两个存储的职责继续分离。

`session_meta` 还应记录当前 kernel/system prompt hash 和 tool schema hash。新 session 使用
创建时的 kernel；显式接受 runtime 变化时创建新的 kernel 记录和 `runtime_change`
revision，旧 kernel 仍留在 canonical history 中。

### 5.3 原始 message 记录

建议增加 `MessageId`，但不把持久化字段全部塞回当前的轻量 `AgentMessage`：

```ts
type StoredMessage = {
  messageId: MessageId;
  sessionId: SessionId;
  ordinal: number;
  frameId: ProtocolFrameId;
  role: "system" | "user" | "assistant" | "tool";
  turnId?: TurnId;
  iterationId?: IterationId;
  toolCallId?: ToolCallId;
  content: string | null;
  contentSha256: string;
  assistant?: {
    reasoningContent?: string | null;
    toolCalls?: ToolCall[];
  };
  tool?: {
    providerToolCallId: string;
    name: string;
  };
  origin: "runtime" | "user" | "model" | "tool";
  createdAt: string;
};
```

`content` 是正文的唯一 source of truth；`assistant` 和 `tool` 只保存重建协议所需的
非正文元数据，避免同一正文同时出现在两套 JSON 字段里而发生漂移。

这里不使用主观的 `confidence: number`。`origin`、ID、哈希和时间戳都是系统能够诚实
填写的事实。

`reasoningContent` 按当前配置继续保存，但默认：

- 不进入 FTS；
- 不被 Recall 返回；
- 不进入 checkpoint；
- 只有 `TINKER_INCLUDE_REASONING_CONTENT=true` 时才重新发送给兼容 provider。

### 5.4 Tool result 记录

仅保存最终 observation 文本不足以生成可靠的占位符，因此 SessionStore 同时保存稳定
版本的 `ToolRawResult`：

```ts
type StoredToolResult = {
  toolCallId: ToolCallId;
  toolMessageId: MessageId;
  kind: ToolRawResultKind;
  raw: ToolRawResult;
  observation: string;
  observationSha256: string;
  searchableText: string;
};
```

这不是把 provider `rawResponse` 作为恢复状态。只保存 Tinker 已经验证过的领域结构和
真正发给模型的 observation。

### 5.5 SessionStore 写入规则

1. 所有写操作在 RuntimeSession 内串行，不允许多个写者并发修改一个 session。
2. message 一旦提交，只能追加，不能更新正文。
3. tool result 与对应 tool message 在同一 transaction 中提交。
4. context revision 先完整写入，校验成功后再更新 `session_meta.active_revision_id`。
5. revision 创建失败时，旧 revision 仍然是唯一活动视图。
6. 数据库写失败后 session 进入 `faulted`，不允许继续产生新的工具副作用。
7. `active.lock` 防止两个 Tinker 进程同时 resume 同一 session；冲突时明确报错。

### 5.6 写屏障的最小实现

本方案接受原研究「不能等到 compact 才记忆」的判断，但第一版不让模型替 runtime
自动标注 `DECISION_ACCEPTED`、`ASSUMPTION_INVALIDATED` 等高层事件。最小写屏障是：

- user message 在 turn 开始时持久化；
- assistant message 在模型响应通过协议校验后持久化；
- tool raw result 和 observation 在下一次模型请求前持久化；
- Write/Edit/Bash 等副作用的结构化结果立即进入 tool_results；
- checkpoint 只分类和投影已经存在的记录，不负责第一次保存事实。

这样即使高层分类有遗漏，原始来源仍在。只有长会话评测证明「决策/约束结构化得太晚」
是主要失败来源时，才新增带 provenance 的 ContextNote/decision 表。

## 六、Protocol Frame：换出的最小合法单元

按单条 message 做 compaction 很容易破坏 Chat Completions 的 tool-call 关系。Tinker
需要显式建模协议帧。

### 6.1 Frame 类型

```ts
type ProtocolFrame = {
  frameId: ProtocolFrameId;
  turnId?: TurnId;
  kind: "system" | "user" | "assistant_text" | "tool_exchange";
  state: "open" | "closed";
  firstOrdinal: number;
  lastOrdinal?: number;
};
```

`tool_exchange` 包含：

```text
1 条带 N 个 tool_calls 的 assistant message
+ 恰好 N 条按 providerToolCallId 对应的 tool message
```

assistant 同时包含进度文本和 tool calls 时，文本仍属于这个 frame，不能拆开。

### 6.2 合法性规则

- 只有 `closed` frame 可以参与换出或 checkpoint。
- 确定性换出只能替换 tool message 的 `content`，assistant tool_calls 骨架不变。
- 完整 checkpoint 可以从活动视图删除整个旧 frame，不能留下其中一半。
- 每次调用 provider 前运行 `ContextProtocolValidator`。
- validator 检查 tool call 数量、provider ID 唯一性、顺序和对应 tool message。
- 任一错误都在 `toOpenAIChatMessages()` 前 fast-fail，并报告 revision 和 frame ID。

### 6.3 中断与崩溃恢复

当前受控取消和工具失败已经会补齐 tool message，这个行为继续保留。

如果进程在 tool batch 中间意外退出，resume 时可能发现 `open` frame。恢复逻辑只做一件
确定的事：为尚未得到结果的 tool call 追加 runtime 生成的 interrupted result，说明
「执行状态未知，副作用可能部分发生，继续前必须检查当前状态」，然后关闭 frame。

它不能伪造工具失败，也不能自动重试可能有副作用的调用。

## 七、Active Context Revision

### 7.1 Revision 不是完整历史副本

每次 checkpoint 都复制全部 message 会让存储呈平方增长。revision 只描述如何从原始
历史投影出活动视图：

```ts
type ContextRevision = {
  revisionId: ContextRevisionId;
  reason: "initial" | "pressure" | "manual" | "resume" | "runtime_change";
  checkpointId?: CheckpointId;
  sourceThroughOrdinal: number;
  keepFromOrdinal: number;
  createdAt: string;
  inputTokensBefore?: number;
  inputTokensAfter: number;
  tokenSource: "provider" | "estimated";
};

type ContextOverride = {
  revisionId: ContextRevisionId;
  messageId: MessageId;
  representation: "swapped";
  renderedContent: string;
  originalContentSha256: string;
};
```

活动视图按固定顺序生成：

```text
活动 kernel/system message
+ 当前 checkpoint 的合成 messages（如果存在）
+ ordinal >= keepFromOrdinal 的原始 messages
  - 对命中的 tool message 应用当前 revision 的预渲染 override
+ revision 创建后新追加的原始 messages
```

`keepFromOrdinal` 必须位于合法 frame 边界。override 在 revision 创建时一次性渲染并
存储，不能在每次请求时根据当前时间或 workspace 重新生成。

### 7.2 Append-only 的精确定义

「每轮仍然调用 ContextBuilder」本身不会破坏 cache；真正的要求是序列化后的旧前缀
完全相同。因此：

- revision 不变时，ContextBuilder 可以重复读取或缓存视图；
- 已有 message 的顺序、正文和 tool schema 序列化必须稳定；
- 新 message 只能追加到尾部；
- token 统计、当前时间、后台任务进度等易变信息不能插入旧前缀；
- 一次 revision 应批量完成足够多的换出，不能每个 iteration 换出一条。

DeepSeek 官方 context caching 以重复前缀为基础，并在 usage 中返回
`prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。Tinker 应把这两个字段加入
`ModelUsage`，用真实数据验证 revision 策略，而不是写死某个成本倍数。

## 八、Context 计量与压力策略

### 8.1 Model profile

新增显式模型配置：

```ts
type ModelContextProfile = {
  contextWindowTokens: number;
  maxOutputTokens: number;
  safetyMarginTokens: number;
  compactTriggerRatio: number;
  compactTargetRatio: number;
};
```

没有可信 context window 配置时，不允许自动 compact；TUI 可以展示 usage，但必须标记
上限未知。不要按 model name 猜一个可能已经变化的值。

`maxOutputTokens` 不能只是本地记账值：provider adapter 必须把对应输出上限真正放进
请求；无法约束输出的 adapter 不能把该 profile 标记为可用于严格 preflight。

有效输入预算：

```text
inputBudget
= contextWindowTokens
- maxOutputTokens
- safetyMarginTokens
```

初始建议延续 roadmap 的 75% 触发点，并把一次 revision 的目标降到约 55%，形成回差，
避免在阈值附近连续重编译。两者都必须可配置，并用真实任务校准。

### 8.2 两种 token 来源

1. **provider measured**：上一请求返回的真实 prompt usage，优先展示。
2. **local estimated**：下一请求的预检估值，用于决定是否能够安全发出。

provider usage 描述已经发生的请求；自动 compaction 需要预测下一请求，所以两者不能
互相替代。

估值必须针对 adapter 最终会发送的 message 和 tool schema，而不是只统计正文字符。
建议定义 `TokenEstimator` 接口：有可信 provider tokenizer 时使用精确实现；否则使用
确定性的本地估值，并用最近一次 `provider promptTokens / local estimate` 校准保守系数。
校准前后都保留 safety margin，且 UI 始终标记 estimated，不能把经验换算冒充精确值。

`ContextEstimator` 第一版允许近似，但必须输出分项和 `estimated` 标记：

```ts
type ContextUsageSnapshot = {
  revisionId: ContextRevisionId;
  estimatedInputTokens: number;
  lastProviderPromptTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  inputBudget?: number;
  breakdown: {
    kernel: number;
    checkpoint: number;
    user: number;
    assistant: number;
    toolFull: number;
    toolSwapped: number;
    toolSchemas: number;
  };
};
```

### 8.3 触发时机

允许创建 revision 的安全边界：

- 一个完整 tool batch 结束、下一 iteration 尚未请求模型；
- turn 结束且 session 空闲；
- 用户在空闲状态执行 `/compact`；
- `/resume` 完成恢复、尚未接受新 prompt。

禁止在以下时间运行：

- assistant tool_calls 已产生但 tool message 尚未补齐；
- Write/Edit/Bash 等工具正在执行；
- SessionStore 或 event sink 已经 faulted；
- TUI 正在同时提交另一个 compact 请求。

### 8.4 压力处理阶梯

```text
下一请求低于 trigger
  -> 不做任何变化

达到 trigger
  -> 批量确定性换出，目标降到 target

换出后仍高于 target
  -> 结构化 checkpoint，删除已覆盖的完整旧 frame

最小合法工作集仍超过 inputBudget
  -> 不请求 provider，明确报告必须拆分任务或减少必要输入
```

任何阶段失败都不能静默截断 message。

## 九、第一层 Compaction：确定性换出

### 9.1 为什么先换出 tool observation

Read、Grep、WebFetch、MCP 和 Bash preview 通常体积大，而且都已经有结构化 raw result。
用规则生成占位符具备以下性质：

- 不调用模型；
- 不产生摘要幻觉；
- 原始 observation 保留在 SessionStore；
- tool message 骨架保持合法；
- Recall 可以在尾部重新 page-in；
- 一次批量 revision 后可以继续 append-only。

### 9.2 候选条件

第一版只换出同时满足以下条件的 tool message：

1. 所属 frame 已关闭；
2. 不属于正在运行的后台任务所需状态；
3. 不在配置的 recent token/turn 保护区；
4. observation 超过最小字节阈值；
5. 原始 message 和 tool result 已成功提交到 SessionStore；
6. 当前 revision 中尚未换出，或新占位符能严格缩小内容。

Write/Edit 结果通常很小且直接描述已经发生的副作用，第一版默认保留。错误 observation
也通常较小并对当前排障重要，默认不优先换出。

### 9.3 完全机械的优先级

不要尝试让模型判断「语义重要性」。候选排序只使用可验证事实：

1. 同一路径存在更晚成功 Read/Edit/Write 的旧 Read；
2. 同一查询或路径的旧 Grep/Glob；
3. 已结束 Bash/TaskOutput 的大 preview；
4. 大体积 WebFetch/WebSearch/MCP 结果；
5. 其余候选按可释放 token 降序，再按 age 排序。

「旧」不表示内容不再有价值，只表示它更适合放入冷存储。历史原文仍可精确 Recall。

### 9.4 占位符契约

占位符必须短、确定、非空、可测试，并使用 JSON 转义插入路径、命令、URL 等外部字段。
例如旧 Read：

```text
[Tinker context swapped]
source=ctx://message/019...
tool=Read
path="src/payment.ts"
observedSha256=abc123...
displayedLines=1-214
historical=Use Recall with source to recover the original observation.
current=Use Read on path to inspect the current workspace version; it may differ.
```

旧 Grep：

```text
[Tinker context swapped]
source=ctx://message/019...
tool=Grep
pattern="processWebhook"
searchPath="src"
mode="content"
historical=Use Recall with source for the original result.
current=Run Grep again for the current workspace result.
```

旧 Bash：

```text
[Tinker context swapped]
source=ctx://message/019...
tool=Bash
status="completed"
exitCode=0
command="bun test"
outputFilePath=".../.tinker/bash/019....log"
historical=Use Recall with source for the original model-visible preview.
fullOutput=Use Read on outputFilePath if the retained log still exists.
```

占位符不复制网页正文、MCP 文本或 shell 输出中的自然语言，避免把历史不可信内容升级成
新的 runtime 指令。

### 9.5 换出算法

```ts
async function createSwapRevision(state: ContextState): Promise<ContextRevision> {
  const before = estimator.estimate(state.activeView);
  const candidates = swapPlanner.rank(state.closedFrames);
  const overrides: ContextOverride[] = [];

  for (const candidate of candidates) {
    overrides.push(swapRenderer.render(candidate));
    const projected = estimator.estimate(state.withOverrides(overrides));
    if (projected.tokens <= state.policy.targetTokens) {
      break;
    }
  }

  if (overrides.length === 0) {
    throw new Error("No eligible context entries can be swapped.");
  }

  return sessionStore.commitRevision({
    reason: state.reason,
    base: state.activeRevision,
    overrides,
    before,
  });
}
```

真实实现必须先构造并校验完整候选 revision，再用一个 transaction 切换 active revision。

## 十、Recall：历史上下文的 page-in 原语

### 10.1 为什么不用独立 `NEED_CONTEXT` 协议

对于代码和当前 workspace，Read/Grep/Glob 已经是成熟的 page-in 工具。真正缺失的是
session 自己的历史，因此只新增一个 `Recall` 工具，不要求模型输出特殊控制 token，也
不要求每个事实都带引用。

更重要的是，Recall 结果作为新的 tool message 追加在上下文尾部：

```text
旧位置仍是短占位符
                    + 新 assistant Recall tool call
                    + 新 tool result（取回的历史原文）
```

这比「把原文恢复到旧位置」更适合 prefix cache，因为 page-in 不会再次改写旧前缀。

### 10.2 工具接口

第一版使用一个工具支持 search 和 get 两种模式：

```ts
type RecallArgs =
  | {
      mode: "search";
      query: string;
      roles?: Array<"user" | "assistant" | "tool">;
      tool_names?: string[];
      turn_from?: number;
      turn_to?: number;
      limit?: number;
      offset?: number;
    }
  | {
      mode: "get";
      sources: string[];
      offset?: number;
      limit?: number;
    };
```

`search` 返回有界命中：

```text
source
role / tool name
turn / timestamp
content hash
短 excerpt
```

`get` 按 source 精确返回历史正文，支持分页，防止一次把大 observation 全部换回。

### 10.3 检索策略

第一版不需要 embedding：

- message/source ID、tool call ID、文件路径、命令和 URL 使用精确过滤；
- `message_fts` 使用 FTS5 trigram，支持中英文子串、错误字符串和代码符号；
- 少于 3 个字符、无法形成 trigram 的查询使用有界的参数化 substring fallback；
- 排序使用文本匹配分数，时间只作为稳定 tie-break；
- 所有查询严格限制在当前 session；
- raw provider response 和 reasoning content 不进入索引。

`search` 返回空时，observation 必须写成：

```text
No matches were found in the current session for the supplied query and filters.
```

不能写成「该信息不存在」。

### 10.4 来源语义

```text
ctx://message/<message-id>       原始模型消息或 tool observation
ctx://checkpoint/<checkpoint-id> 结构化 checkpoint
ctx://turn/<turn-id>             turn 范围
```

第一版只需要解析 message 和 checkpoint；turn URI 可以先用于搜索过滤。URI 是 Tinker
内部地址，不暴露 SQLite rowid 或文件布局。

## 十一、第二层 Compaction：结构化 Checkpoint

确定性换出无法解决无限增长的 user/assistant 文本和 tool-call 骨架，所以仍需要真正的
checkpoint。但 checkpoint 不是一段自由发挥的「临终遗言」。

### 11.1 运行条件

只有以下条件同时满足才运行 checkpoint：

- 确定性换出后仍无法达到 target；
- 当前没有 open protocol frame；
- 待退休前缀可以按完整 frame 切分；
- summarizer 输入仍在模型预算内；
- SessionStore 和 event sinks 健康。

### 11.2 增量而不是重总结全历史

第 N 个 checkpoint 的输入只包含：

```text
上一个 checkpoint capsule（如果存在）
+ 从上次 sourceThrough 到本次边界的新旧 frame
+ 当前仍保留 suffix 的最小目录
```

它不重新读取从 session 开始到现在的全部历史。这样 checkpoint 工作集本身也是有界的。

### 11.3 Capsule 结构

```ts
type ContextCapsuleV1 = {
  schemaVersion: 1;
  checkpointId: CheckpointId;
  covers: {
    fromOrdinal: number;
    throughOrdinal: number;
  };
  userContext: Array<{
    quote: string;
    source: string;
  }>;
  workingState: {
    objective?: SourcedText;
    completed: SourcedText[];
    inProgress: SourcedText[];
    decisions: SourcedText[];
    openQuestions: SourcedText[];
    nextActions: SourcedText[];
  };
  artifacts: Array<{
    path: string;
    lastObservedSha256?: string;
    lastWrittenSha256?: string;
    source: string;
  }>;
  commands: Array<{
    command: string;
    status: string;
    exitCode?: number;
    source: string;
  }>;
  activeBackgroundTasks: Array<{
    taskId: string;
    command: string;
    status: string;
    outputFilePath: string;
  }>;
};

type SourcedText = {
  text: string;
  sources: string[];
};
```

### 11.4 哪些字段由谁产生

| 字段 | 来源 | 是否允许模型自由生成 |
| --- | --- | --- |
| covers / IDs / hashes | SessionStore | 否 |
| artifacts | Read/Write/Edit raw result | 否 |
| commands / exit code | Bash raw result | 否 |
| active background tasks | ShellTaskManager snapshot | 否 |
| userContext.quote | 原始 user message 的精确子串 | 只允许选择，不能改写 |
| objective / progress / decisions / questions | summarizer | 是，但必须带 source |

这里不声称能够从 Bash 命令名百分之百判断「这是测试」。确定性层只记录 command 和
outcome；「某项测试验证了什么」属于带来源的 derived working state。

### 11.5 校验与失败语义

summarizer 返回 JSON 后必须执行：

1. schema 和长度上限校验；
2. 所有 source URI 必须存在且位于 covers 或上一 capsule；
3. 所有 user quote 必须是对应 user message 的精确子串；
4. artifact、command 和 background task 字段必须与确定性投影一致；
5. capsule 渲染后必须通过 context protocol validator；
6. 新 revision 必须低于 input budget，并且严格小于旧 revision。

source 校验只能证明「这条 derived 结论可回查」，不能证明 source 必然蕴含该结论。
因此 workingState 始终标记为 derived；关键操作仍应 Recall 原文或检查当前 workspace。

任一校验失败，整个 checkpoint 失败；不切换 revision，不自动吞掉字段，也不生成一个
「大概可用」的摘要。手动 `/compact` 直接显示原因；自动 compact 在仍低于硬预算时保留
旧视图，无法发出下一请求时返回明确终止错误。

### 11.6 权限与角色渲染

不能把历史 tool/web/MCP 文本复制进 system message，否则会发生权限升级和 prompt
injection 放大。checkpoint 渲染遵守来源层级：

```text
system:    原始 Tinker kernel/system prompt，始终固定
user:      历史 userContext 的逐字引用和 source，标记为历史而非新请求
assistant: 确定性运行事实 + derived workingState，明确要求关键操作前回查 source
recent:    未被退休的原始 frame
```

原始工具正文只通过 Recall 的 tool result 返回，绝不进入高权限 checkpoint 区域。

### 11.7 Checkpoint 边界

正常情况从完整旧 turn 之后切分，recent suffix 从一条 user message 开始。单个超长 turn
也可能需要在 iteration 边界 checkpoint；此时必须：

- 保留当前 user goal；
- 只退休已经关闭的旧 tool frames；
- 重新生成当前 turn 的 working state；
- 保留尚未完成的 frame 和最近原始结果。

## 十二、RuntimeSession 与 Agent Loop 调整

### 12.1 目标所有权

当前 `runAgent()` 自己复制并持有完整 `messages`，最后把它放进 `RunAgentResult`。这在
逻辑无限历史下不应继续。目标结构是：

```text
RuntimeSession
  owns SessionStore
  owns ContextManager
  owns session/turn lifecycle

runAgent
  consumes a TurnConversation interface
  appends only this turn's new records
  requests the current bounded ContextView
  returns status/finalText/lastIteration, not the entire session history
```

建议接口：

```ts
type TurnConversation = {
  appendAssistant(message: AssistantMessage): Promise<StoredMessage>;
  appendTool(input: {
    call: ToolCall;
    raw: ToolRawResult;
    observation: ToolObservation;
  }): Promise<StoredMessage>;
  buildModelRequest(tools: ToolDefinition[]): Promise<ModelRequestInput>;
  compactIfNeeded(boundary: "iteration" | "turn"): Promise<void>;
};
```

`ContextBuilder` 负责把已经选定的 view 转成 `AgentMessage[]` 和 token breakdown，不负责
自行决定删哪条记录。策略集中在 `ContextManager`。

### 12.2 目标执行顺序

```text
RuntimeSession.executeTurn(userPrompt)
  1. 校验 session ready、无并发 turn
  2. 在 SessionStore 创建 turn 和原始 user message
  3. 发出 turn.started
  4. runAgent:
       a. 获取并校验当前 ContextView
       b. 预估下一请求；必要时在安全边界 compact
       c. model.request
       d. 持久化 assistant message / 打开 tool frame
       e. 执行 tools，持久化 raw + observation / 关闭 frame
       f. 在下一 iteration 前重新检查压力
  5. 写 turn terminal event
  6. 在 SessionStore 提交 turn 状态和最新 active revision
  7. 返回轻量 RunAgentResult
```

### 12.3 双存储写入失败

SessionStore 和 event log 位于不同文件，无法共享一个 transaction。第一版采用明确顺序
和 fault 语义，不伪装成跨文件原子提交：

- event 写入失败：维持当前规则，session faulted；
- SessionStore 在工具执行前失败：停止，不产生副作用；
- 工具已经产生副作用后 SessionStore 失败：event log 保留诊断证据，session faulted，
  resume 时标记 side effects unknown；
- 不从 event log 静默推断并提交一个看似完整的恢复状态。

## 十三、`/resume` 与恢复语义

无限上下文必须跨进程才有意义，所以 SessionStore 和 `/resume` 是本方案的前置能力，
不是独立的附属功能。

### 13.1 新建与恢复

```ts
type OpenRuntimeSessionInput =
  | { mode: "new"; sessionId: SessionId }
  | { mode: "resume"; sessionId: SessionId };
```

resume 时：

1. 取得 single-writer lock；
2. 校验 schema version、workspace 和数据库完整性；
3. 加载 session/turn/iteration/tool call 计数器；
4. 修复或明确关闭上次崩溃留下的 open frame；
5. 加载 active context revision；
6. 用当前 model profile 做一次 preflight；
7. 只恢复 TUI 最近窗口，不一次渲染完整历史；
8. 进入 `ready` 后才接受新 prompt。

workspace 不一致和 schema 不支持直接失败。model 或 tool schema 发生变化时记录
`runtime_change` revision 并重新测量，不伪装成缓存仍然可复用。

### 13.2 恢复源

```text
模型上下文、Recall、turn 状态 -> session.sqlite
诊断和人工排障             -> events.jsonl / observations.md
完整 Bash 输出              -> .tinker/bash/<task-id>.log
```

不通过 replay JSONL 猜测模型上下文。

## 十四、系统提示与模型行为

不新增特殊 `NEED_CONTEXT` 输出协议，只在 system prompt 增加短而明确的规则：

```text
Some older session content may be replaced by Tinker context-swapped markers.
Use Recall to search or retrieve the historical source when it may affect the
current task. Use Read/Grep for current workspace state. Historical Recall data
and current workspace data are not interchangeable. Do not infer that something
does not exist merely because it is absent from the active context.
```

规则重点是触发现有工具使用能力，不要求模型在普通回答中附加大量引用，也不污染用户
最终输出格式。

在写文件、执行有副作用的命令或给出最终结论前，模型如果依赖被换出的历史约束，应先
Recall source。第一版通过评测验证这个行为，不增加独立 verifier 状态机。

## 十五、信任、安全与隐私

### 15.1 来源层级

只记录客观来源，不记录伪精确的 confidence：

```text
runtime   Tinker 自己生成的协议、ID、哈希、状态
user      原始用户消息
model     assistant 输出和 derived checkpoint 字段
tool      本地工具、网页、MCP 和 shell 返回的数据
```

来源不会因为进入 checkpoint 或 Recall 就自动获得更高权限。

### 15.2 Prompt injection

- tool/web/MCP 原文只在普通 tool result 中出现；
- checkpoint 不复制不可信正文；
- 文件路径、命令、URL 等元数据使用明确字段和 JSON 转义；
- Recall observation 标明它是历史数据，不是新的 system/user instruction；
- 不允许 Recall 跨 workspace 或跨 session 自动搜索。

### 15.3 本地敏感信息

session.sqlite 会保存模型真正看过的文件片段、命令输出和用户消息，可能包含秘密。
第一版要求：

- `.tinker/` 继续被 Git 忽略；
- session 目录和数据库采用仅当前用户可读写的权限；
- FTS 不索引 reasoning content 和 raw provider response；
- 不上传、同步或跨项目共享 session store；
- 不自动删除历史，清理策略作为显式用户操作另行设计。

## 十六、事件、TUI 与可观测性

### 16.1 新事件

避免为每个内部细节创建事件，第一版增加：

```text
context.usage.updated
context.revision.started
context.revision.finished
context.revision.failed
session.resumed
session.interrupted_frame_recovered
```

`context.revision.*` 带：

```ts
type ContextRevisionEventData = {
  revisionId?: ContextRevisionId;
  strategy: "swap" | "checkpoint";
  reason: "pressure" | "manual" | "resume" | "runtime_change";
  inputTokensBefore: number;
  inputTokensAfter?: number;
  swappedMessageCount?: number;
  retiredFrameCount?: number;
  checkpointId?: CheckpointId;
  error?: string;
};
```

Recall 本身继续使用普通 `tool.*` 事件，不增加第二套调用事件。

### 16.2 TUI

Footer 建议展示：

```text
context 61k / 128k (48%, estimated) · revision 3 · cache hit 42k
```

`/status` 展示：

- session/model/workspace；
- active revision/checkpoint；
- context 输入预算和分项；
- provider measured 与 local estimated；
- cache hit/miss；
- compact 次数和最后原因；
- 原始 message 数与活动 message 数；
- 后台任务数。

`/compact` 只在空闲状态执行，和自动 pressure 路径调用同一个 `ContextManager.compact()`。

`/resume` 列出当前 workspace 最近 session。恢复后 TUI 只加载最近若干 turn；更早历史
通过分页 UI 或 Recall 获取。TUI 有界投影和模型 compaction 是两个独立问题。

## 十七、代码落点

### 17.1 新增模块

```text
src/session/session-store.ts
src/session/session-schema.ts
src/session/session-lock.ts

src/context/context-manager.ts
src/context/context-policy.ts
src/context/context-estimator.ts
src/context/context-protocol-validator.ts
src/context/protocol-frame.ts
src/context/swap-planner.ts
src/context/swap-renderer.ts
src/context/checkpoint-compiler.ts
src/context/types.ts

src/tools/recall.ts
```

### 17.2 修改模块

- `src/agent/runtime-session.ts`
  - 拥有 SessionStore、ContextManager、resume 和持久化生命周期。
  - 不再用单个内存 `sessionMessages` 作为长期 source of truth。
- `src/agent/loop.ts`
  - 通过 TurnConversation 追加本 turn delta。
  - 每次模型请求前取有界 ContextView。
  - 在完整 tool batch 后触发 pressure check。
- `src/agent/context-builder.ts`
  - 接收 revision view，稳定渲染并产出 token breakdown。
  - 不包含 swap/checkpoint 决策。
- `src/agent/types.ts`
  - 增加 MessageId/FrameId 关联；逐步移除 `RunAgentResult.messages`。
- `src/model/model-client.ts`
  - 扩展 cache hit/miss usage；接收 model context profile。
- `src/model/openai-chat-mapping.ts`
  - 解析 provider cache usage；在映射前使用协议 validator 的结果。
- `src/tools/types.ts`
  - 增加 `RecallRawResult`。
- `src/tools/registry.ts`
  - 注入只读 SessionHistoryReader 并注册 Recall。
- `src/observation/observation-builder.ts`
  - 确定性渲染 Recall search/get 结果。
- `src/events/types.ts`
  - 增加 context/session recovery 事件。
- `src/cli/config.ts`
  - 加载显式 model context profile 和 compact policy。
- `src/tui/slash-commands.ts`
  - 增加 `/resume`、`/status`、`/compact`。
- `src/tui/event-store.ts`
  - 增加 context 状态，并把常驻 timeline 改为有界投影。

### 17.3 不应出现的新抽象

- 不引入通用依赖注入容器；
- 不做一个同时负责事件、session、TUI 和模型请求的巨型 Context OS 类；
- 不让 ContextBuilder 直接访问 SQLite；
- 不让 Recall 获得 SessionStore 写权限；
- 不把 SessionStore 实现成 EventSink；
- 不为第一版建立 page relation、confidence、validUntil 等无人能可靠维护的字段。

## 十八、分阶段实施

### 阶段 A：Context 计量，不改变消息行为

实施：

- 扩展 `ModelUsage` 的 cache hit/miss；
- 加入 model context profile 和本地 estimator；
- `ContextBuilder` 产出分项；
- event/TUI `/status` 展示 usage。

验收：真实 usage 可用时优先使用；下一请求始终有预检估值；没有 profile 时不偷偷自动
compact。

### 阶段 B：SessionStore、Message ID 与 `/resume`

实施：

- 建立 session.sqlite、schema 和 single-writer lock；
- 持久化 messages、tool results、turns 和 protocol frames；
- RuntimeSession 从 store 恢复计数器和上下文；
- `/resume` 恢复 session；
- `RunAgentResult` 不再复制完整历史。

验收：多 turn 退出后恢复，模型收到与退出前相同的未压缩上下文；损坏和 schema 不支持
在模型/工具前 fast-fail。

### 阶段 C：Recall

实施：

- FTS5 trigram 索引；
- Recall search/get；
- source URI、分页和 observation；
- system prompt 的换出/检索规则。

验收：中英文、路径、错误字符串和精确 ID 都可检索；历史 Read 与当前 Read 能明确返回
不同版本。

### 阶段 D：确定性换出

实施：

- ContextRevision 和 override；
- protocol validator；
- swap planner/renderer；
- pressure + hysteresis；
- `/compact` 先支持 swap-only。

验收：tool-call 协议始终合法；换出零模型调用；原 observation 可 Recall；revision 之后
再次请求只追加尾部。

### 阶段 E：结构化 Checkpoint

实施：

- 增量 capsule compiler；
- 确定性 ledger；
- derived summary 和来源校验；
- 自动 checkpoint；
- resume checkpoint revision。

验收：摘要失败不改变活动视图；合法 checkpoint 达到 target；早期 user constraint、文件
修改原因和命令结果都能从 source 下钻取回。

### 阶段 F：长会话评测与 TUI 有界化

实施：

- 长会话 benchmark；
- cache hit/miss 和成本/延迟对比；
- TUI timeline 窗口和历史分页；
- 根据真实数据调整阈值和候选优先级。

阶段之间独立交付。不要在阶段 A 就预埋完整知识图谱，也不要在阶段 D 尚未验证前同时
实现向量检索。

## 十九、测试与评测计划

### 19.1 单元测试

#### Protocol frame

- 单 tool call、多 tool call、带 assistant 进度文本的 frame 均能关闭。
- 取消、工具失败和 crash recovery 后每个 providerToolCallId 恰好有一条 tool message。
- 删除或换出半个 frame 会被 validator 拒绝。

#### Swap renderer

- 每个 ToolRawResult kind 生成稳定占位符。
- 占位符包含 source/hash 和正确的历史/当前恢复指引。
- 路径、命令、URL 中的换行和特殊字符不会改变字段结构。
- 同一输入重复渲染逐字节相同。

#### Context revision

- revision 切换 transaction 失败时 active revision 不变。
- `keepFromOrdinal` 不能落在 tool frame 中间。
- 新 message 在 revision 后只追加，不改旧序列化前缀。
- 一次换出必须严格减少估计 token。

#### Recall

- source ID 精确 get；未知或跨 session source fast-fail。
- FTS 中英文、代码符号、路径和错误串命中。
- pagination 不重复、不跳记录。
- 空结果明确限定为当前 query/scope。
- reasoning/raw provider response 不可被默认搜索。

#### Checkpoint

- user quote 不是原文子串时拒绝。
- source 不在覆盖范围时拒绝。
- artifact/command 与 raw result 不一致时拒绝。
- schema 非法或 summary 过长时旧 revision 保持活动。

### 19.2 集成测试

1. Read 文件 v1，Edit 成 v2，换出旧 Read：Recall 返回 v1 observation，Read 返回 v2。
2. assistant 一次调用多个工具，换出部分 tool content，OpenAI-compatible 映射仍合法。
3. turn 中途取消，下一 turn 在 compact 后仍能正常请求 provider。
4. 完成多 turn，退出并 `/resume`，active revision、checkpoint 和计数器一致。
5. 模拟 SQLite 写失败，确认不会继续下一个工具副作用。
6. 模拟 open tool frame 后崩溃，resume 只补 interrupted result，不自动重试工具。
7. 触发阈值后只创建一个批量 revision，直到再次越过 trigger 前不重编译。
8. checkpoint summarizer 返回非法引用，模型输入仍使用旧 revision。

### 19.3 Prefix cache 测试

对 provider 出站 payload 做规范化序列化并记录 prefix hash：

```text
request N prefix hash = H1
append tool frame
request N+1 的旧长度 prefix hash仍 = H1

create revision R2
request M 首次出现新 prefix hash = H2
append new frame
request M+1 的旧长度 prefix hash仍 = H2
```

真实 DeepSeek smoke test 再比较 `prompt_cache_hit_tokens` 和
`prompt_cache_miss_tokens`，确认本地 hash 假设与 provider 观测一致。

### 19.4 长会话亮点评测

构造至少 50 turn、包含多次 Read/Grep/Bash、两次以上 checkpoint 的任务，在早期埋入：

- 一条用户硬约束；
- 一次失败实验及失败原因；
- 一个后来被修改过的文件版本；
- 一条命令的精确错误；
- 一个被否决的方案。

在后期分别测试：

1. 按 source 精确取回是否逐字一致；
2. 按关键词是否能找到正确 turn；
3. 模型能否在提示下主动 Recall；
4. 模型能否区分历史 observation 和当前 workspace；
5. 活动 context 是否稳定低于 target；
6. 每次 revision 后的 cache miss 是否只发生一次；
7. 和传统自由文本 summary 基线相比，早期事实回答和任务成功率是否更高。

产品宣传只能使用评测真正支持的表述。「精确 ID 可取回」可以是强保证；「任意自然语言
都能找回」和「模型永不忘记」不能作为第一版承诺。

## 二十、主要风险与处理

| 风险 | 处理 |
| --- | --- |
| 模型没有意识到要 Recall | 短 system rule、占位符直接给路径、长会话评测；不虚构形式化保证 |
| checkpoint 摘要漂移 | 结构化 schema、source 校验、确定性 ledger、失败不切 revision |
| prefix cache 被频繁打断 | append-only revision、批量换出、trigger/target 回差、监测 hit/miss |
| tool-call 协议被破坏 | ProtocolFrame + 每次请求前 validator |
| 把旧文件当成当前文件 | 占位符明确区分 Recall historical 与 Read current |
| FTS 找不到语义改写后的内容 | 第一版承认边界；source ID、路径、trigram 和 checkpoint 补足，embedding 延后 |
| session.sqlite 持续增长 | 本地显式保留；未来单独设计 list/delete/export，不在 compact 中删原文 |
| 不可信历史进入高权限 prompt | checkpoint 不复制 tool 正文，来源分层，Recall 作为 tool data |
| 单个必要工作集本身超过窗口 | preflight fast-fail，要求拆分任务；不静默截断 |
| 工具副作用后持久化失败 | session fault、event 诊断证据、resume 标记 unknown，不自动重试 |

## 二十一、明确推迟

以下方向有价值，但不进入第一轮实现：

- embedding 和语义 reranker；
- AST、LSP、调用图和 import graph；
- 自动判断「最小充分上下文」的 dependency closure；
- 独立 decision/constraint/assumption 知识图谱；
- confidence、validUntil 和自动可信度评分；
- 跨 session / 跨 workspace 记忆；
- branch/worktree memory namespace；
- 子 agent capsule 和多 agent 调度；
- 完整文件系统快照或所有 Bash 输出的内容寻址 blob 归档；
- 云同步、多人共享和服务端存储。

只有当 SessionStore、Recall、确定性换出和结构化 checkpoint 的真实评测暴露明确缺口
时，再选择其中一项补充。

## 二十二、最终设计决策摘要

1. **SessionStore 使用 SQLite，event log 继续只做诊断。**
2. **原始 message/tool result 不可变，compaction 只创建活动 context revision。**
3. **完整 protocol frame 是保留和删除的最小单位；确定性换出只替换 tool content。**
4. **两次 revision 之间严格 append-only，并通过 provider cache usage 验证。**
5. **Recall 在尾部追加 page-in 结果，不把原文恢复到旧位置。**
6. **历史 observation 和当前 workspace 各有独立读取路径。**
7. **先做确定性换出，仍不足时才做模型参与的结构化 checkpoint。**
8. **checkpoint 中系统事实机械生成，模型字段必须带可校验 source。**
9. **第一版用 FTS5 trigram，不引入向量数据库。**
10. **任何超预算、协议断裂、数据库损坏或 checkpoint 校验失败都 fast-fail。**

用一句工程定义收束：

```text
Tinker Infinite Context
= Immutable Session History
+ Versioned Active Context View
+ Protocol-Safe Deterministic Swap
+ Tail-Appended Recall
+ Source-Checked Checkpoint
+ Cache-Aware Scheduling
```

这不是把 1M token 伪装成无限，而是把「窗口之外等于丢失」改造成「窗口之外仍然可寻址、
可恢复、可验证」。这才是 Tinker 可以真正做成亮点、并且可以用测试证明的部分。

## 参考协议资料

- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache)：prefix cache 的
  命中规则及 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。
- [DeepSeek Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion)：
  assistant tool calls、tool message 和 `tool_call_id` 的协议字段。
