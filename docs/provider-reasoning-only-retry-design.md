# Provider Reasoning-only 异常观测与有界重试设计

## 状态

已于 2026-07-22 按本文契约完成实现。确定性注入测试覆盖 reasoning-only 后成功、连续
reasoning-only、第二次普通失败和 cancellation；进程内 provider 集成测试同时验证 JSONL
脱敏、Observation 隔离与 canonical history 不污染。真实 `deepseek-v4-flash` Docker
cache-miss smoke 正常完成；该样本未概率性复现 reasoning-only。

## 背景

Tinker 通过 OpenAI-compatible Chat Completions 协议调用模型。对于正常 assistant
响应，provider 必须至少返回以下一种有效结果：

- 非空文本 `content`；
- 一个或多个 `tool_calls`。

`reasoning_content` 是部分 provider 在思考模式下额外返回的推理字段。它不是最终
assistant 正文，也不能单独成为 Tinker canonical history 中的 assistant 消息。

2026-07-22，在刚安装 Tinker 的远端环境中，`deepseek-v4-flash` 首次对话出现：

```text
model=deepseek-v4-flash
workspace=/root/test
session=019f8762-5e06-70eb-98b0-cf1dbffc01ac

prompt: 你好
error: Invalid provider response (provider=openai-compatible,
       model=deepseek-v4-flash): choices[0].message has neither
       non-empty text nor tool calls.
```

在同一 session 中再次输入 `你好` 后，模型正常返回正文。该现象此前也在另一轮刚安装
后的首次对话中出现过。

### 远端会话证据

失败请求只留下了 `model.request.started` 和 `turn.failed`。由于当前 mapper 在解析并
持久化 `finish_reason`、usage 和 `reasoning_content` 摘要之前就对空正文 fast-fail，
失败响应的关键诊断信息没有进入 `events.jsonl`。

第二次成功请求的数据为：

```text
prompt_tokens=3328
prompt_cache_hit_tokens=3200
prompt_cache_miss_tokens=128
completion_tokens=87
reasoning_tokens=21
finish_reason=stop
```

这说明第一次请求已经使大部分公共前缀进入 provider cache，但仅凭第二次成功响应，
仍无法确定第一次是资源不足、流中断、reasoning-only，还是其他 provider 异常。

### 本地 Docker 复现

为补齐证据，使用隔离的临时 Tinker 版本在本地 Docker 中进行了两层实验。临时版本
只提前解析脱敏诊断字段，不接受空 assistant，不增加重试，也没有修改正式工作树。
实验代码基线为 commit `ae2019a85952d9c598977a1cc57a29724f94d9f3`。

第一层使用 mock OpenAI-compatible streaming provider，固定返回：

```text
reasoning_content: 非空
content: 空
tool_calls: 无
finish_reason: insufficient_system_resource
prompt_cache_hit_tokens: 0
prompt_cache_miss_tokens: 3328
reasoning_tokens: 21
```

临时版本能够把 finish reason、reasoning 字符数和 usage 写入失败记录，同时没有记录
reasoning 原文、prompt、API key 或完整 raw response。这证明拟议的脱敏观测字段足以
穿过 streaming 聚合、provider mapping、agent loop 和 event log。

第二层使用工作区 `.env.deepseek` 中的真实 provider 配置。每个 cache-miss 样本在
system prompt 开头加入唯一实验 nonce，避免复用此前的 provider prefix cache。共执行
6 个独立 cache-miss 样本，其中 5 个成功，1 个真实复现同类失败：

```text
finish_reason=stop
content_chars=0
reasoning_chars=53
tool_call_count=0
prompt_tokens=3349
completion_tokens=29
reasoning_tokens=29
prompt_cache_hit_tokens=0
prompt_cache_miss_tokens=3349
```

随后使用完全相同的 system prompt、工具 schema、workspace 和 user prompt 再次请求，
请求成功：

```text
finish_reason=stop
prompt_tokens=3349
prompt_cache_hit_tokens=3328
prompt_cache_miss_tokens=21
reasoning_tokens=33
content: 非空
```

### 结论边界

本次实验确认：

- provider 返回了结构完整且带 usage 的 Chat Completions 响应；
- streaming 请求收到了明确的 `finish_reason=stop`；
- provider 生成了非空 reasoning，但没有生成最终正文或工具调用；
- 该失败不是 `length`、`content_filter` 或 `insufficient_system_resource`；
- 相同前缀的下一次 cache-hit 请求正常完成；
- cache-miss 与异常在已观察样本中相关，但当前证据不能证明 cache-miss 是异常的充分
  原因；
- 6 个 cache-miss 样本中只有 1 个失败，因此不应把它描述为每次首次请求必现。

本文把该响应称为 **reasoning-only provider 异常**。Tinker 仍将它视为无效 assistant
响应，不把 reasoning 当作最终答案。

## 目标

- 失败的 provider dispatch 必须在 `events.jsonl` 中留下结构化、脱敏的诊断记录。
- 精确识别 `stop + reasoning-only` 响应，不通过模型名推断 provider 行为。
- 对该异常在同一 iteration 内静默重试一次。
- 重试使用完全相同的请求，不污染 canonical history 或后续模型上下文。
- TUI 在重试期间复用当前 model timeline item，不创建第二个同 iteration item。
- 第二次仍失败时保持现有 fast-fail 行为，明确结束当前 turn。
- 为重试次数、事件顺序、usage 和 cancellation 建立确定性契约。

## 非目标

- 不把 reasoning-only 响应转换成成功 assistant 消息。
- 不向用户展示或保存完整 reasoning 内容。
- 不为所有 provider 错误增加通用重试。
- 不重试 `length`、`content_filter`、资源不足、无终止 chunk 或普通空响应。
- 不为本期增加 stream diagnostics 返回类型或 stream-to-mapper 旁路参数。
- 不增加可配置重试次数、退避、抖动或 provider/model 白名单。
- 不改变 SDK 现有的 HTTP、连接或限流错误重试行为。
- 不把 provider attempt 写入 SQLite canonical history。
- 不把失败诊断作为 observation 发送给模型。

## 核心术语

- **iteration**：agent loop 中一次模型决策及其后续工具执行范围。
- **provider dispatch**：对 `ModelClient.request()` 的一次调用。
- **attempt**：同一 iteration 内的一次 provider dispatch。正常情况只有 attempt 1；
  reasoning-only 重试产生 attempt 2。
- **reasoning-only**：正文为空、没有工具调用、reasoning 非空且 provider 明确以
  `stop` 结束的完整响应。
- **silent retry**：不向用户展示失败错误、不产生模型 observation、不结束 turn，但仍在
  `events.jsonl` 记录失败 attempt。TUI 可以把现有 model item 更新为 `retrying`，但不能
  增加第二个 item。

## Reasoning-only 判定契约

只有同时满足以下条件，错误才能被分类为 `reasoning_only_assistant`：

1. `choices[0].message.role === "assistant"`；
2. `content` 为 `null`、空字符串或纯空白；
3. `tool_calls` 缺失或为空数组；
4. `reasoning_content` 是 trim 后非空的字符串；
5. `finish_reason === "stop"`；
6. usage 满足 Tinker 当前 provider usage 合同。

条件 5 已经覆盖 streaming 的完整终止要求：当前 accumulator 只有在 chunk 中实际出现
非空 `finish_reason` 时才会产生 `"stop"`。条件 6 也已经覆盖 usage chunk：usage 缺失时
现有 `parseUsage()` 会直接 fast-fail。本期不再为这两个事实增加重复的 stream flags。

判定不绑定 `deepseek-v4-flash`、DeepSeek 域名或 profile 名。DeepSeek 是本次问题背景，
但相同响应形状在任何 OpenAI-compatible provider 上都表示相同协议异常。

以下情况不属于 reasoning-only 重试范围：

| 响应 | 处理 |
| --- | --- |
| `stop`、reasoning 非空、正文为空、无工具调用 | 静默重试一次 |
| `stop`、reasoning 为空、正文为空、无工具调用 | 无效 provider 响应，直接失败 |
| `length`、reasoning 非空、正文为空 | 直接失败；相同请求重试不能修复输出预算 |
| `content_filter` | 直接失败 |
| `insufficient_system_resource` | 直接失败；不在本设计扩大重试范围 |
| 没有终止 chunk 或没有 usage | 无效/incomplete stream，直接失败 |
| 正文为空但存在合法工具调用 | 有效 assistant 工具调用，不重试 |
| 正文非空 | 有效 assistant 响应，不重试 |

`stop + 空正文 + 空 reasoning` 虽然同样没有 canonical 副作用，但不纳入本期重试。
reasoning-only 已通过真实 provider 实验确认“相同请求立即重试可以恢复”；完全空响应可能
来自另一类 provider/proxy 缺陷、内容遗漏或协议不兼容，目前没有证据证明重复相同请求
能够恢复。Tinker 对未被证据限定的无效响应继续 fast-fail。若后续单独观察到完全空响应
且证明有相同恢复特征，再新增独立分类，而不是扩大本次 predicate。

## Provider 错误类型

当前 provider mapper 和 stream accumulator 抛出普通 `Error`。实现时增加结构化错误，
agent loop 不解析错误字符串：

```ts
type ProviderResponseErrorCode =
  | "reasoning_only_assistant"
  | "invalid_provider_response"
  | "invalid_provider_stream"
  | "provider_request_error";

type ProviderResponseDiagnostics = {
  provider: string;
  model: string;
  path?: string;
  finishReason?: string;
  contentChars?: number;
  reasoningChars?: number;
  toolCallCount?: number;
  usage?: ModelUsage;
};

class ProviderResponseError extends Error {
  readonly code: ProviderResponseErrorCode;
  readonly diagnostics: ProviderResponseDiagnostics;
}
```

`ProviderResponseError` 必须保留现有 provider/model/path 错误语境。`message` 用于人类
阅读，`code` 和 `diagnostics` 用于事件与重试决策。

SDK 或 fetch 抛出的错误继续经过现有敏感数据清理，并归类为
`provider_request_error`。本设计不要求把所有底层异常改造成同一 response error
层级，但 agent loop 必须能为它们生成脱敏的 `model.request.failed` 事件。

## Mapping 与 streaming 观测

### 校验顺序

`fromOpenAIChatCompletion()` 调整为：

1. 校验 completion、choice 和 assistant message 基础结构；
2. 解析 `content` 和 `tool_calls`；
3. 解析 `finish_reason`；
4. 解析 usage；
5. 解析 `reasoning_content`；
6. 生成脱敏 diagnostics；
7. 判定有效正文、工具调用或 reasoning-only；
8. 有效响应继续映射，无效响应携带 diagnostics fast-fail。

不得为了收集诊断而放宽原有结构和 usage 校验。如果 response 本身缺字段或字段类型
错误，应报告对应 invalid response，而不是猜测 reasoning-only。

### 错误优先级

调整校验顺序会改变复合无效响应的错误归类，本文明确接受该变化：

1. response、choice、message 和字段类型等结构错误优先；
2. finish reason 与 usage 合同错误其次；
3. 只有结构、finish reason 和 usage 都合法后，才分类 reasoning-only；
4. 其他正文为空且无工具调用的响应归类为普通 invalid provider response。

因此“空正文 + 非法/缺失 usage”必须报告 usage 错误，而不是现有的
`has neither non-empty text nor tool calls`。当前断言旧错误文案的 mapping 测试需要按
新优先级调整，同时补一条“合法 usage + reasoning-only”的专属分类测试。

### Streaming 边界

本期不修改 `accumulateOpenAIChatCompletionChunks()` 的返回类型，也不新增
stream-to-mapper diagnostics 参数。现有聚合结果已经提供 reasoning、finish reason 和
usage；这些字段足够完成 reasoning-only 判定。若未来出现无法由现有字段解释的 truncated
stream，再单独设计 chunk-level diagnostics。

## `model.request.failed` 事件

新增 iteration 级事件：

```ts
type ModelRequestFailureCode =
  | "reasoning_only_assistant"
  | "invalid_provider_response"
  | "invalid_provider_stream"
  | "provider_request_error";

type ModelRequestFailedData = {
  attemptNumber: 1 | 2;
  maxAttempts: 2;
  code: ModelRequestFailureCode;
  retryDisposition: "scheduled" | "not_retryable" | "exhausted";
  provider: string;
  model: string;
  error: string;
  diagnostics?: ProviderResponseDiagnostics;
};
```

`model.request.started` 和 `model.request.finished` 同时增加：

```ts
attemptNumber: 1 | 2;
maxAttempts: 2;
```

即使绝大多数请求只有一次 attempt，也必须显式记录 `attemptNumber=1`，避免失败后成功
的事件序列产生歧义。

### 事件可见性

`model.request.failed` 的职责仅是 runtime diagnostic：

- 写入 `events.jsonl`；
- 不写入 `observations.md`；
- stdout printer 不输出；
- TUI event store 不产生 timeline item 或界面状态；
- 不转换成 tool observation；
- 不加入 agent loop 的下一次模型请求；
- 不写入 SQLite canonical messages、frames 或 tool results。

`model.request.started` 的消费规则按 attempt 区分：

- attempt 1：TUI 创建当前 iteration 唯一的 model timeline item；stdout 按现有格式输出
  started；
- attempt 2：TUI 通过相同的 `model-request-${iterationId}` ref 更新已有 item 为
  `model iteration N · retrying`，保持 `running` 状态；不得 append 新 item；stdout 不
  输出第二行 started；
- `model.request.finished`：无论来自 attempt 1 还是 attempt 2，都更新同一个已有 item；
- `model.request.failed`：TUI、stdout 和 Observation 继续忽略，不承担 retrying 展示。

因此 live TUI 与 resume projection 始终保持“一个 iteration 对应一个 model item”。
retrying 只是 active turn 的瞬时展示状态，不写 SQLite；resume 只按最终 iteration 与
assistant 事实重建一个 model item。

若 attempt 2 最终失败，现有 `turn.failed` 仍按当前行为进入 session/turn/iteration
终态和用户界面。`model.request.failed` 不替代 terminal turn event。

### TUI 等待反馈

retry 不是无反馈的第二段等待。attempt 2 开始时，现有 running item 必须立即改为：

```text
model iteration N · retrying
```

不展示第一次失败的错误详情，不新建 timeline item，也不改变 spinner/running 状态。
attempt 2 成功后，现有 `model.request.finished` 投影覆盖 retrying 文案；attempt 2 失败或
取消后，现有 turn terminal event 负责结束 running 状态。one-shot stdout 保持静默，
只输出 attempt 1 的 started 和最终 finished/failed 结果。

### 脱敏

事件允许记录：

- provider 和 model；
- error code 和校验 path；
- finish reason；
- content/reasoning 字符数；
- tool call 数量；
- token usage 和 cache hit/miss；

事件禁止记录：

- system prompt、user prompt 或序列化 request body；
- assistant 正文或 reasoning 原文；
- tool call arguments；
- API key、Authorization header；
- 图片 data URL；
- 完整 provider raw response 或原始 SSE chunks。

## 静默重试状态机

重试策略属于 agent loop，不属于 `OpenAIChatModelClient`。Model client 负责协议映射和
结构化错误；agent loop 负责 attempt、事件、cancellation 和 turn 结果。

```text
attempt 1 started
  |
  +-- success --------------------------> finished
  |
  +-- reasoning_only_assistant
  |      |
  |      +-- failed(retry=scheduled)
  |      +-- cancellation check
  |      +-- attempt 2 started
  |             |
  |             +-- success -----------> finished
  |             |
  |             +-- any failure
  |                    +-- failed(retry=exhausted/not_retryable)
  |                    +-- turn.failed
  |
  +-- any other failure
         +-- failed(retry=not_retryable)
         +-- turn.failed
```

### Attempt 1

1. 在首次 provider dispatch 前执行一次 `prepareModelDispatch`；
2. 使用当前已 prepare/materialize 的请求发起 dispatch；
3. 成功则保持当前流程；
4. 失败后先写 `model.request.failed`；
5. 只有错误 code 为 `reasoning_only_assistant` 时设置
   `retryDisposition="scheduled"`；
6. 其他错误设置 `not_retryable` 并结束 turn。

### Attempt 2

1. 重试前再次检查 `AbortSignal`；
2. 复用完全相同的 `PreparedModelRequest` 或 `MaterializedModelRequest` 对象；
3. 使用相同的 session、turn 和 iteration identity；
4. 不再次调用 `prepareModelDispatch`，不重复执行 skill activation dispatched 等
   dispatch 前副作用；
5. 不重新 build context，不新增消息，不回传失败 attempt 的 reasoning；
6. 不做 sleep、指数退避或随机抖动；
7. 成功后只提交 attempt 2 的 assistant 响应；
8. 任意失败都不再重试；reasoning-only 再次失败时标记 `exhausted`，其他错误标记
   `not_retryable`；
9. 按现有失败路径生成 `turn.failed`。

`maxAttempts=2` 是固定运行时合同，不增加配置项。当前真实复现显示相同前缀的立即重试
可以命中 provider cache；即使没有 cache hit，这一规则仍只依赖响应语义，不依赖缓存
实现。

### Dispatch 副作用

`prepareModelDispatch` 当前会把本 iteration 可见的 pending skill activations 标记为
dispatched 并落库。它虽然对第二次调用表现为幂等，但重试合同不能依赖“第二次查询恰好
为空”。agent loop 必须把准备副作用放在 attempt loop 之外，每个 iteration 恰好执行
一次，再在 attempt 1 和 attempt 2 之间只重复纯 provider dispatch。

如果 `prepareModelDispatch` 自身失败，provider dispatch 尚未发生，因此不生成
`model.request.failed`，也不进入 reasoning-only retry；它按现有 runtime/canonical failure
路径结束 turn。

### Retry exhausted 错误

attempt 2 再次得到 reasoning-only 时，不直接把 mapper 的通用空消息错误展示给用户。
agent loop 返回固定的、脱敏的最终错误：

```text
Provider returned reasoning without final text or tool calls in both attempts
(provider=<provider>, model=<model>).
```

该文案不包含 reasoning 原文、usage 或 request 内容。详细 attempt 诊断只留在
`events.jsonl`。attempt 2 若发生其他错误，则保留对应的最终脱敏错误，不错误地改写成
reasoning-only exhausted。

## Canonical history 与模型上下文

reasoning-only attempt 不产生 canonical assistant message。

第一次失败、第二次成功时，SQLite history 保持：

```text
user       原始用户消息
assistant  attempt 2 的有效正文或工具调用
```

其中不存在：

- attempt 1 的空 assistant；
- attempt 1 的 reasoning；
- synthetic retry prompt；
- 重复 user 消息；
- `model.request.failed` 的模型 observation。

因此静默重试与用户手工再次发送同一 prompt 不同。手工再次发送会创建新 turn 和第二条
user 消息；静默重试仍属于原 turn、原 iteration 和原 canonical request。

## Usage 与 context measurement

失败 attempt 的 usage 代表真实 provider 消耗，因此保留在 `model.request.failed` 中，
但不调用 `ContextMeter.recordProviderUsage()`：

- 它没有产生可提交的 assistant 输出；
- 它与 attempt 2 使用相同 input context；
- 用它更新 context correction 会把失败响应当成当前有效上下文测量。

成功 attempt 按现有流程产生 `model.request.finished` 和 measured
`context.usage.updated`。失败 attempt 的 usage 仅用于诊断和成本审计，不改变当前 context
snapshot。

## Cancellation

- attempt 1 执行期间取消：保持当前 model request cancellation 行为，不重试；
- attempt 1 reasoning-only 后、attempt 2 前取消：不发起 attempt 2，产生现有
  `turn.cancelled`；
- attempt 2 执行期间取消：取消 provider request，产生 `turn.cancelled`；
- cancellation 不伪装成 `model.request.failed` provider 故障。

## 与 SDK 重试的关系

OpenAI SDK 可能对特定 HTTP 状态或网络错误执行自己的底层重试。本设计不修改该行为。
reasoning-only 是 HTTP 成功且 response 可解析后的语义异常，SDK 不会把它识别为传输
失败。

Tinker attempt 只统计 `ModelClient.request()` 级 dispatch：

- 正常请求最多一个 Tinker attempt；
- reasoning-only 最多两个 Tinker attempts；
- SDK 内部是否为一次 dispatch 发出多个 HTTP 请求，不由本事件合同计数。

## 事件序列

### Attempt 1 成功

```text
model.request.started  attempt=1 maxAttempts=2
model.request.finished attempt=1 maxAttempts=2
```

### Attempt 1 reasoning-only，attempt 2 成功

```text
model.request.started  attempt=1 maxAttempts=2
model.request.failed   attempt=1 retryDisposition=scheduled
model.request.started  attempt=2 maxAttempts=2
model.request.finished attempt=2 maxAttempts=2
```

只产生一个 `agent.iteration.started` 和一个 `agent.iteration.finished`。

### 两次 reasoning-only

```text
model.request.started attempt=1 maxAttempts=2
model.request.failed  attempt=1 retryDisposition=scheduled
model.request.started attempt=2 maxAttempts=2
model.request.failed  attempt=2 retryDisposition=exhausted
turn.failed
```

### Attempt 1 reasoning-only，attempt 2 发生其他错误

```text
model.request.started attempt=1 maxAttempts=2
model.request.failed  attempt=1 retryDisposition=scheduled
model.request.started attempt=2 maxAttempts=2
model.request.failed  attempt=2 retryDisposition=not_retryable
turn.failed
```

## 实现边界

预计涉及：

- `src/model/openai-chat-mapping.ts`
  - 调整解析顺序；
  - 精确识别 reasoning-only；
  - 抛出结构化 provider response error；
- `src/model/openai-chat-model-client.ts`
  - 保持 provider/fetch 错误脱敏；
  - 传递结构化 response error，不丢失 diagnostics；
- `src/model/model-client.ts` 或独立 provider error 模块
  - 定义共享错误和 diagnostics 类型；
- `src/agent/loop.ts`
  - 实现最多两次的 attempt 状态机；
  - 写 failed 事件；
  - 在 retry 前检查 cancellation；
  - 每个 iteration 只执行一次 `prepareModelDispatch`；
- `src/events/types.ts`
  - 定义 attempt metadata 和 `model.request.failed`；
- `src/events/jsonl-event-log.ts`
  - 不需要特殊逻辑，继续序列化结构化事件；
- `src/events/observation-text-log.ts`
  - 显式忽略该事件；
- `src/events/stdout-event-printer.ts`
  - 显式忽略 failed 事件与 attempt 2 started；
- `src/tui/event-store.ts`
  - failed 事件不改变 timeline；
  - attempt 2 started 更新既有 model item 为 retrying，不 append；
- session/event projection 与测试 fixture
  - 接受 attempt metadata，但不把 failed attempt 投影成 canonical history。

不在 mapper、model client 和 agent loop 分别实现不同重试。重试决策只能有一个所有者：
agent loop。

## 测试计划

### Provider mapping

- `stop + reasoning-only` 抛出 `reasoning_only_assistant`；
- reasoning 字符数只记录长度，不进入 error diagnostics 原文；
- `stop + 完全空消息` 是 `invalid_provider_response`；
- `length + reasoning-only` 不分类为可重试错误；
- 有合法 tool calls 时不受 reasoning/content 空值影响；
- finish reason、usage 或 reasoning 类型非法时保持 fast-fail path；
- 空正文同时缺失/破坏 usage 时优先报告 usage 错误；
- 既有空消息错误文案测试按新优先级更新。

### Streaming

- reasoning chunks 能正确累计字符数；
- 缺 terminal chunk 时 `finish_reason` 不能满足 `stop`；
- 缺 usage chunk 时由现有 required usage 校验 fast-fail；
- `insufficient_system_resource + reasoning-only` 保留其 finish reason，但不可重试。

### Agent loop

- attempt 1 成功时只调用 provider 一次；
- attempt 1 reasoning-only、attempt 2 成功时调用两次；
- 两次调用接收同一个 prepared/materialized request；
- 两次调用使用同一个 iteration identity；
- `prepareModelDispatch` 在两个 attempts 之间只调用一次；
- pending skill activation 只执行一次 dispatched 落库副作用；
- attempt 2 可以返回正文或工具调用；
- attempt 2 任意失败后不产生第三次调用；
- 普通 provider response error 不重试；
- retry 前 cancellation 阻止第二次 dispatch；
- attempt 2 执行中的 cancellation 保持当前取消语义。

### Events

- started/failed/started/finished 顺序稳定；
- failed event 携带正确 attempt、retry disposition 和 usage；
- 失败 event 不含 reasoning 原文、prompt、tool arguments、API key 或 raw response；
- `events.jsonl` 能看到失败 attempt；
- `observations.md` 和 stdout 看不到静默失败 attempt；
- attempt 2 started 不产生第二行 stdout；
- TUI retry 前后 model timeline item 数量不变且不存在重复 id/ref；
- attempt 2 started 把唯一 model item 更新为 retrying；
- attempt 2 finished 更新同一个 item，不能遗留永久 running item；
- live 完成投影与 resume 投影都只有一个 model item；
- 最终失败仍产生既有 `turn.failed`。

### Session 与 context

- retry 成功后 SQLite 只有一条 user 和一条有效 assistant；
- reasoning-only 不写 messages、frames 或 tool results；
- retry request 不包含失败 reasoning 或 synthetic message；
- failed attempt usage 不更新 ContextMeter；
- successful attempt usage 正常更新 measured context；
- `/resume` 后只恢复 canonical user/assistant 事实，不显示静默 retry。

### Provider 集成

- 通过 `OpenAIChatModelClient` 已有的 `fetch` 注入，在 `bun test` 进程内固定返回
  reasoning-only 后正常正文，验证静默 retry；
- 注入连续两次 reasoning-only，验证 retry exhausted 和固定最终文案；
- 在临时 session 目录检查 `events.jsonl` 的脱敏字段和事件顺序；
- Docker 只用于真实 DeepSeek profile 的 cache-miss/cache-hit smoke；
- 真实 provider smoke 不要求每次概率性复现，但一旦出现 reasoning-only，必须由 attempt 2
  接管且不污染 canonical history。

## 验收标准

- reasoning-only 判定严格符合本文六项条件。
- 同一 iteration 最多执行两个 Tinker provider attempts。
- retry payload 与 attempt 1 完全相同。
- retry 成功对用户静默，只显示最终有效回答或工具执行。
- retry 期间 TUI 只更新当前 model item 为 retrying，不增加 item；one-shot 不重复输出
  started。
- retry exhausted 时用户看到本文规定的 reasoning-only 最终 provider 错误。
- 每个失败 dispatch 都在 `events.jsonl` 留下脱敏的 `model.request.failed`。
- `model.request.failed` 不进入 Observation、TUI、模型上下文或 SQLite canonical
  history；TUI 只消费 attempt 2 started 的 retrying 状态。
- failed attempt usage 可审计，但不改变 ContextMeter。
- 所有新增测试通过，`bun run check` 通过。
- 注入 fetch 的进程内集成测试验证事件、重试、脱敏和历史不污染。

## 实施顺序

1. 定义 provider structured error 和 diagnostics。
2. 调整 mapping 校验顺序，不改变 stream accumulator 返回合同。
3. 增加 model request attempt metadata 和 failed event。
4. 在 agent loop 实现 reasoning-only 单次静默重试。
5. 让 Observation 和 stdout 忽略静默失败事件；让 TUI attempt 2 started 更新既有 item。
6. 补齐 mapping、stream、loop、event、session 和 cancellation 测试。
7. 运行 `bun run check`。
8. 用注入 fetch 的进程内 provider 集成测试验证确定性异常路径。
9. 在 Docker 中使用真实 DeepSeek profile 完成 provider smoke，并检查
   `events.jsonl`、SQLite 和最终
   用户输出。
