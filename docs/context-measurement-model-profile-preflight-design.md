# F2：Context 计量、模型配置与请求预检技术方案

## 文档状态

- 状态：已实施
- 日期：2026-07-11
- 实施日期：2026-07-11
- 对应路线图：[`agent-runtime-roadmap.md`](agent-runtime-roadmap.md) 的 F2
- 前置阶段：[`long-session-memory-ownership-design.md`](long-session-memory-ownership-design.md)
  已实施
- 上位设计：
  [`infinite-context-technical-design-a.md`](infinite-context-technical-design-a.md)

## 实施与验证记录

F2 已按本文契约落地。实现包含强制模型 profile、派生输入预算、prepared request、provider
usage 强校验、本地 estimator 与 rolling calibration、measured anchor、admission/iteration
preflight、context event、Prompt Input 状态栏和 `/status`。本阶段没有引入 message 删除、重排、摘要或
compaction。

自动化门禁：

```text
bun run check
309 pass, 0 fail
```

真实 DeepSeek 验证使用本文示例 profile：

```text
TINKER_CONTEXT_WINDOW_TOKENS=1048576
TINKER_MAX_SUPPORTED_OUTPUT_TOKENS=393216
requestMaxOutputTokens=131072
inputBudgetTokens=917504
```

- 短请求：raw full `7782`，guarded `9728`，provider prompt `6244`、completion
  `13`、total `6257`；cache hit/miss 为 `384/5860`，reasoning 为 `11`。
- `Glob` 两 iteration 请求：第二次 preflight 使用
  `measured_plus_estimated_delta`；raw delta `70`，guarded delta `77`，projected
  input `6396`，provider prompt `6363`；cache hit/miss 为 `6272/91`。
- 两组样本的 guarded estimate 均未低于 provider `prompt_tokens`；真实 provider 接受了
  `max_tokens=131072`。
- 真实 PTY 已确认 Prompt Input 状态栏显示
  `deepseek-v4-flash · ~/htdocs/tinker · main · context 9.5K / 896K (1% used)`；`/status`
  显示 profile、trigger、raw breakdown、factor、sample count 和 prefix hash；`/quit`
  正常退出。

## 一、结论先行

F2 建立 Tinker 对模型请求的预算真相，但不执行 compaction，不删除、换出或摘要任何
message。

本阶段采用严格、简洁的产品契约：

1. 每个可运行模型必须显式配置 `contextWindowTokens` 和
   `maxSupportedOutputTokens`；缺少或非法时，Tinker 在启动阶段 fast-fail。
2. Tinker 的产品级单次输出上限固定为 `128K`，实际请求上限取模型能力与产品上限的
   较小值，并由 adapter 真正发送给 provider。
3. Prompt Input 状态栏中 context 使用的分母不是 provider 原始总窗口，而是 Tinker 派生的输入预算：

   ```text
   inputBudgetTokens
   = contextWindowTokens
   - requestMaxOutputTokens
   ```

4. 成功的 provider 响应必须包含合法的 `prompt_tokens`、`completion_tokens` 和
   `total_tokens`；缺失、非法或彼此不一致都按 provider 协议错误处理。
5. 上一次 provider `total_tokens` 是 append-only context 的 measured anchor；下一请求只
   估算 anchor 之后新增的 delta。
6. 本地估值使用确定性的字符估算，再用最近 provider `prompt_tokens` 持续校准；不要求
   第一版接入模型专用 tokenizer。
7. 每次模型请求先 prepare、计量和 preflight，通过后才发出
   `model.request.started` 并访问网络。
8. `context.usage.updated` 只携带数量、来源、压力状态和哈希，不把完整 prompt、tool
   schema 或 provider raw response 长期放进 TUI projection。

F2 完成后，Tinker 能准确回答：

```text
当前模型总窗口和最大输出能力是多少？
本次请求真正预留多少输出？
Tinker 当前可使用多少输入窗口？
上一请求 provider 实测了多少 token？
下一请求预计会占用多少输入？
当前是否已经达到未来自动 compaction 的触发线？
下一请求是否必须在访问 provider 前拒绝？
```

## 二、已确认的产品决策

### 2.1 Token 单位

Tinker 内部统一使用整数 token。所有文档和 UI 中的 `K`、`M` 按 1024 计算：

```text
1K   = 1,024 tokens
128K = 131,072 tokens
1M   = 1,048,576 tokens
```

配置只接受十进制整数 token，不接受 `1M`、`128K` 等带单位字符串，避免解析歧义。

### 2.2 模型 Profile 是启动硬门禁

```ts
type ModelContextProfile = {
  contextWindowTokens: number;
  maxSupportedOutputTokens: number;
};
```

这两个字段都是必填项。Tinker 不支持：

- 没有 profile 时继续运行；
- 按 model name 猜窗口；
- 只显示 usage、把上限标成 unknown；
- adapter 无法限制输出时降级成 advisory mode；
- 由 provider 第一次报错后再反推能力。

若某个 OpenAI-compatible 模型不能提供这两个值，或 adapter 不能真正发送输出上限，
该模型不属于 Tinker 支持范围。

`contextWindowTokens` 在 Tinker 契约里始终表示：

```text
最大输入 token + 本次最大生成 token
```

如果某个 provider 文档使用其他口径，接入配置必须先换算成这个统一含义。

### 2.3 产品级输出策略

```ts
const TOKEN_K = 1_024;
const PRODUCT_MAX_OUTPUT_TOKENS = 128 * TOKEN_K;

const requestMaxOutputTokens = Math.min(
  PRODUCT_MAX_OUTPUT_TOKENS,
  profile.maxSupportedOutputTokens,
);
```

`maxSupportedOutputTokens` 是模型能力；`requestMaxOutputTokens` 是 Tinker 本次真正发送的
请求参数。两者不能使用同一个字段。

第一版不把 `PRODUCT_MAX_OUTPUT_TOKENS` 暴露成环境变量。调整它属于 Tinker 产品策略
变更，不属于模型接入配置。

### 2.4 Context 压力触发线

F2 固定记录未来自动 compaction 使用的压力触发线：

```ts
const CONTEXT_PRESSURE_TRIGGER_RATIO = 0.8;
const triggerTokens = Math.floor(
  inputBudgetTokens * CONTEXT_PRESSURE_TRIGGER_RATIO,
);
```

第一版不开放用户配置，不定义 compaction target。target 应在真正实施 compaction 时根据
换出策略另行确定。

压力判断：

```text
projectedInputTokens > inputBudgetTokens
  -> blocked，模型请求前 fast-fail

projectedInputTokens >= triggerTokens
  -> triggered，记录压力；F2 仍允许请求

projectedInputTokens < triggerTokens
  -> normal
```

F2 本身不调用 compactor。后续阶段只需在 `triggered` 的安全边界插入 compaction，复用
同一套计量和预检公式。

### 2.5 对路线图占位描述的收紧

路线图 F2 的高层描述已在实施后回填。以下结论取代路线图中的早期占位假设：

- 不再支持“没有可信 profile 时只展示 usage”；缺少 profile 直接无法启动。
- 不增加用户可配置的 `safetyMarginTokens`；保守性由 guarded estimator 和 80% trigger
  提供安全余量。
- F2 只固定 trigger，不提前定义 compaction target。
- provider 三个基础 usage 字段由可选观测收紧为成功响应的强制协议。

## 三、预算公式与示例

### 3.1 派生配置

```ts
type ModelContextBudget = ModelContextProfile & {
  requestMaxOutputTokens: number;
  inputBudgetTokens: number;
  triggerRatio: 0.8;
  triggerTokens: number;
};
```

计算顺序：

```text
requestMaxOutputTokens
= min(128K, maxSupportedOutputTokens)

inputBudgetTokens
= contextWindowTokens - requestMaxOutputTokens

triggerTokens
= floor(inputBudgetTokens * 0.8)
```

### 3.2 DeepSeek-V4-Flash 示例

```text
contextWindowTokens       = 1024K
maxSupportedOutputTokens  = 384K
requestMaxOutputTokens    = min(128K, 384K) = 128K
inputBudgetTokens         = 1024K - 128K = 896K
triggerTokens             = floor(896K * 0.8) = 734003 tokens ≈ 716.8K
```

若当前 measured anchor 为 `700K`，pending delta 的 guarded estimate 为 `50K`：

```text
projectedInputTokens = 700K + 50K = 750K
750K >= 716.8K
pressure = triggered
```

F2 记录 pressure 并继续请求，因为 `750K <= 896K`。后续自动 compaction 阶段会在这里先
压缩，再重新 prepare 和 preflight。

### 3.3 256K / 64K 模型示例

```text
contextWindowTokens       = 256K
maxSupportedOutputTokens  = 64K
requestMaxOutputTokens    = min(128K, 64K) = 64K
inputBudgetTokens         = 256K - 64K = 192K
triggerTokens             = floor(192K * 0.8) = 157286 tokens ≈ 153.6K
```

当前 used 为 `150K` 时，Prompt Input 状态栏：

```text
context 150K / 192K (78% used)
```

若准备新增 `8K`：

```text
projectedInputTokens = 158K
pressure = triggered
```

## 四、实施前实现基线

### 4.1 已有接缝

- `RuntimeSession` 已是 session lifecycle 和 conversation 的唯一 owner。
- `InMemorySessionConversation` 已区分 committed history 与当前 turn delta。
- 所有正常 agent 请求都经过 `ContextBuilder`。
- `OpenAIChatModelClient` 已集中负责 OpenAI-compatible payload 映射和响应解析。
- `ModelRequestOutput` 已包含基础 `ModelUsage` 和 provider raw response。
- `TuiProjectionStore` 已是有界 presentation snapshot，可承接 context 最新状态。
- agent loop 已在每个 iteration 重新构建模型请求。

### 4.2 当前缺口

1. `RunnerConfig` 没有模型窗口与最大输出能力。
2. `OpenAIChatModelClient` 没有发送 `max_tokens`。
3. `ModelUsage` 三个基础字段仍是可选，整个 `usage` 也可缺失。
4. mapper 不解析 cache hit/miss 和 reasoning token。
5. `ContextBuilder` 只透传 messages/tools，没有语义分项。
6. `model.request.started` 早于 request build 和 preflight，事件语义不准确。
7. 没有本地 estimator、校准状态、measured anchor 或压力状态。
8. Prompt Input 状态栏、`/status` 和 TUI projection 没有 context 数据。
9. WebFetch refiner 会创建独立模型请求，不能绕过输出上限与 usage 契约。

## 五、目标与非目标

### 5.1 目标

1. 缺少模型 profile 时，one-shot 与 TUI 都在创建 RuntimeSession 前失败。
2. adapter 发送的输出上限与预算公式使用的值严格一致。
3. 每次成功 provider 请求都有完整、内部一致的 measured usage。
4. 每次请求前都能生成确定性的 raw estimate、guarded estimate 和语义分项。
5. append-only 时使用 provider total 作为 anchor，只估算新增 delta。
6. context 重建或配置变化时自动放弃 anchor，改为完整估值。
7. 超过输入硬预算时不发出 provider 请求。
8. `context.usage.updated` 能驱动有界 Prompt Input 状态栏和 `/status`。
9. prefix fingerprint 能证明 Tinker 自己是否保持 append-only。
10. 真实 provider smoke test 能对比 raw/guarded estimate、measured usage 和 cache usage。

### 5.2 非目标

- 不实现 swap、checkpoint、自动 compaction 或 `/compact`。
- 不删除、截断、重排或摘要任何模型 message。
- 不实现 SessionStore、`/resume`、MessageId 或 ContextRevision。
- 不在 F2 建立完整 Tool ProtocolFrame validator；该项属于 F3。
- 不要求接入 DeepSeek、OpenAI 或其他模型的专用 tokenizer。
- 不承诺本地估值等于 provider tokenization；只要求其确定、可校准且用于保守预检。
- 不统计价格、美元成本或 rate limit。
- 不把 WebFetch refiner usage 混入主 session context 状态栏。
- 不在本阶段重新设计 thinking/reasoning 产品策略。
- 不支持主模型与 WebFetch refiner 使用不同模型但共用一个未区分的 profile。

## 六、配置与启动门禁

### 6.1 环境变量

当前 CLI 以环境变量为配置入口，F2 增加：

```text
TINKER_CONTEXT_WINDOW_TOKENS
TINKER_MAX_SUPPORTED_OUTPUT_TOKENS
```

DeepSeek 示例：

```text
TINKER_CONTEXT_WINDOW_TOKENS=1048576
TINKER_MAX_SUPPORTED_OUTPUT_TOKENS=393216
```

不提供 model-name 内置表。切换 `TINKER_MODEL` 时，用户必须同时保证这两个值与所选模型
匹配。

### 6.2 Fast-fail 校验

`readRunnerConfig()` 必须在创建 model client、event sink、MCP 或 TUI 前校验：

- 两个变量都存在且非空；
- 都能解析为正的 safe integer；
- `maxSupportedOutputTokens <= contextWindowTokens`；
- 派生的 `requestMaxOutputTokens < contextWindowTokens`；
- `inputBudgetTokens > 0`；
- `triggerTokens > 0` 且 `< inputBudgetTokens`。

错误必须同时指出变量名和收到的值，不回退默认窗口。

### 6.3 WebFetch Refiner 边界

F2 第一版要求 `TINKER_WEBFETCH_REFINE_MODEL`：

- 未设置；或
- 与主 `TINKER_MODEL` 完全相同。

若指定不同模型，启动时 fast-fail。独立 refiner model profile 可以以后增加，但不能让
内部模型请求绕过 F2 的强制配置。

refiner 请求使用同一个 profile 和 `requestMaxOutputTokens`，执行完整估值与硬预算检查，
并要求完整 provider usage；但其 usage 只进入诊断，不更新主 session 的 measured anchor、
Prompt Input 状态栏或校准窗口。

### 6.4 测试注入

测试可以通过 `RunnerConfig` override 注入 profile，但 fake model 不享有“无需 profile”的
例外。所有生产和测试 RuntimeSession 使用同一配置契约。

## 七、Provider Usage 强契约

### 7.1 类型

```ts
type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  reasoningTokens?: number;
};

type ModelRequestOutput = {
  message: AssistantMessage;
  finishReason?: string;
  usage: ModelUsage;
  rawResponse?: unknown;
};
```

`usage` 和三个基础字段都不再可选，`source` 不再放在 `ModelUsage` 中。Provider measured
usage 与 local estimate 使用两个不同类型，避免把过去实测和下一请求估值混在一起。

### 7.2 基础字段校验

成功响应必须满足：

```text
promptTokens     是非负 safe integer
completionTokens 是非负 safe integer
totalTokens      是非负 safe integer
totalTokens      = promptTokens + completionTokens
```

任一条件不满足，adapter 抛出包含 provider、model 和字段路径的协议错误。assistant message
不能进入 conversation，不能产生 `model.request.finished`。

usage 必须在解析 tool calls、分配 runtime tool call identity 之前完成校验。无效 usage 不能
只阻止 message append，却已经推进 iteration 内的 tool call 计数器。

### 7.3 Cache 字段

OpenAI-compatible mapper 按以下顺序规范化：

1. 优先读取 DeepSeek 风格的 `prompt_cache_hit_tokens` 与
   `prompt_cache_miss_tokens`；两者必须同时存在。
2. 若直接字段不存在，但有 `prompt_tokens_details.cached_tokens`，则：

   ```text
   hit  = cached_tokens
   miss = prompt_tokens - cached_tokens
   ```

3. 若两种格式同时存在，值必须一致。
4. 有 hit/miss 时必须满足：

   ```text
   hit + miss = promptTokens
   ```

Cache 字段对其他 provider 可以缺失；缺失不影响基础 usage 合法性。

### 7.4 Reasoning 字段

若 provider 返回 `completion_tokens_details.reasoning_tokens`，规范化为
`reasoningTokens`，并校验：

```text
0 <= reasoningTokens <= completionTokens
```

F2 只记录该值，不改变 reasoning replay 策略。

### 7.5 Fake 与测试 ModelClient

所有 fake/capturing model 都必须返回合法 usage。测试 fixture 可以使用确定性小整数，但
不能继续依赖 `usage: undefined`，否则生产强契约无法被完整覆盖。

## 八、请求 Prepare 边界

### 8.1 原则

预检必须针对真正会发送的 payload：

```text
estimate what will be sent
send exactly what was estimated
```

不能让 preflight 和网络请求分别调用两套映射逻辑。否则 message、tool schema、reasoning
或 JSON 序列化变化后，检查对象与发送对象可能不同。

### 8.2 ModelClient 接口方向

建议把当前单步 `request(input)` 拆成：

```ts
type PreparedModelRequest = {
  provider: string;
  model: string;
  payload: unknown;
  promptSegments: PreparedPromptSegment[];
  requestConfigHash: string;
  toolSchemaHash: string;
};

type ModelClient = {
  prepare(input: ModelRequestInput): PreparedModelRequest;
  request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput>;
};
```

`payload` 对 runtime 保持 opaque，由创建它的 adapter 发送。adapter 必须拒绝其他 adapter
或其他 model 产生的 prepared request。

OpenAI Chat adapter 在 prepare 时一次性确定：

- `model`；
- mapped `messages`；
- mapped `tools`；
- `tool_choice`；
- `max_tokens = requestMaxOutputTokens`；
- 当前已有的 reasoning mapping 选项；
- 所有会影响 prompt 的 provider 参数。

### 8.3 Prompt Segments

`PreparedPromptSegment` 只用于计量和哈希，不保存第二份长期 prompt：

```ts
type PreparedPromptSegmentKind =
  | "kernel"
  | "user"
  | "assistant"
  | "tool"
  | "tool_schema"
  | "protocol";

type PreparedPromptSegment = {
  kind: PreparedPromptSegmentKind;
  normalizedText: string;
};
```

需要计量：

- system/kernel 正文；
- user 正文；
- assistant content、实际发送的 reasoning、tool calls 和 arguments；
- tool message content 与 provider tool call ID；
- tool name、description 和完整 JSON Schema；
- role、边界和 adapter 能确定的协议 framing。

不计量：

- API key；
- timeout；
- AbortSignal；
- 本地 iteration/toolCall ID 中未发送给 provider 的字段；
- event metadata；
- provider raw response。

大字符串只在 prepare/estimate 栈上短暂存在。事件和 TUI snapshot 只保留计数与哈希。

### 8.4 ContextBuilder 职责

`ContextBuilder` 继续负责：

- 稳定选择和排序当前 messages/tools；
- 标记 kernel、user、assistant、tool、tool schema 语义来源；
- 返回 provider-neutral `ModelRequestInput`。

adapter 负责 provider-native 序列化。`ContextBuilder` 不读取环境变量，不解析 provider
usage，也不决定 pressure 或 compaction。

## 九、本地 Token Estimator

### 9.1 为什么第一版不依赖专用 Tokenizer

模型 tokenizer 能提高正文估值，但不一定复现托管 API 对 role、tool schema、tool call 和
隐藏 framing 的序列化。Tinker 未来还可能切换到其他 OpenAI-compatible 模型，为每个模型
绑定 tokenizer 会扩大接入与升级成本。

F2 第一版采用：

```text
简单确定性的 raw estimate
+ provider prompt_tokens 校准
+ 80% pressure trigger 留出的产品回差
```

以后可以替换 raw estimator，不改变 measured anchor、preflight、event 或 TUI 契约。

### 9.2 字符估值

按 Unicode code point 遍历，不能直接使用 JavaScript UTF-16 `string.length`：

```text
ASCII code point                 0.3 token
Unicode Script=Han code point    0.6 token
其他 Unicode                     UTF-8 byte length * 0.5 token
每个 message/tool schema frame   8 token 固定协议开销
```

对一个 prepared request：

```ts
rawEstimatedTokens = Math.ceil(
  asciiCount * 0.3 +
    hanCount * 0.6 +
    otherUtf8Bytes * 0.5 +
    frameCount * 8,
);
```

换行在 prepare 时统一为实际发送形式。JSON 使用稳定 key 顺序，不能让同一语义对象因对象
创建顺序不同得到不同估值。

### 9.3 语义分项

```ts
type RawContextBreakdown = {
  kernelTokens: number;
  userTokens: number;
  assistantTokens: number;
  toolTokens: number;
  toolSchemaTokens: number;
  protocolTokens: number;
  totalTokens: number;
};
```

breakdown 保存 raw estimate；correction factor 只应用于总数，不把舍入误差伪装成精确的
逐项 provider token。

### 9.4 校准参数

```ts
const INITIAL_CORRECTION_FACTOR = 1.25;
const MIN_CORRECTION_FACTOR = 1.1;
const OBSERVED_RATIO_PADDING = 1.05;
const CALIBRATION_WINDOW_SIZE = 8;
```

发送请求前保存该 prepared prompt 的 `rawEstimatedTokens`。响应成功后：

```text
observedRatio
= provider.promptTokens / rawEstimatedTokens
```

使用最近 8 次有效比率：

```ts
correctionFactor =
  samples.length === 0
    ? 1.25
    : Math.max(1.1, Math.max(...samples) * 1.05);
```

不设置上限；异常偏高的 ratio 应被保留并通过 `/status` 与诊断暴露，而不是被 clamp 后继续
低估。

最终 guarded estimate：

```ts
guardedEstimatedTokens = Math.ceil(
  rawEstimatedTokens * correctionFactor,
);
```

guarded estimate 是可校准的保守工程估值，不是 provider tokenizer 的数学上界。它用于本地
预检和提前触发压力信号；provider 仍可能因自身隐藏 framing 或 tokenizer 差异拒绝请求。
这类响应按普通 provider 请求失败处理，不能伪造 usage 或回退到不受限请求。80% trigger、
measured anchor 和真实 provider smoke test 共同降低这种情况的发生概率。

### 9.5 校准样本失效

以下变化清空当前校准窗口：

- model/base URL 变化；
- `ModelContextProfile` 变化；
- `requestMaxOutputTokens` 或 reasoning mapping 变化；
- adapter prompt serialization version 变化；
- tool schema 集合发生非 append-only 变化；
- 后续 `/resume` 恢复到不同 runtime 配置。

样本只保存在当前 RuntimeSession 内存中；F2 不持久化它。

## 十、Measured Anchor 与 Delta 估值

### 10.1 Anchor

```ts
type MeasuredContextAnchor = {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  segmentCount: number;
  prefixHash: string;
  requestConfigHash: string;
  toolSchemaHash: string;
};
```

成功响应后，`totalTokens` 成为下一请求输入的 measured base，因为上一次 completion 通常
会作为 assistant history 进入下一请求。

若 provider completion 中包含下一请求不会重放的 reasoning，使用 `totalTokens` 会略微
高估；F2 接受这种保守性，不尝试从 anchor 中扣减。

assistant 作为下一请求 input 时新增的 role/end framing，归入下一次 delta 的
`protocolTokens`。

`recordProviderUsage()` 还要用 adapter 的同一套 mapping 把本次 assistant message 转成
“下一请求会重放的 segment”，把它接到已发送 request 的 hash chain 后，再保存 anchor 的
`segmentCount` 与 `prefixHash`。不能直接把“本次请求输入末尾”的 hash 当作“下一请求
measured base”的 hash。

### 10.2 Append-only 判定

只有同时满足以下条件，才能使用 measured anchor：

```text
requestConfigHash 未变化
toolSchemaHash 未变化
anchor segmentCount 对应的 prefixHash 未变化
新 prepared request 只在 anchor 之后追加 segments
```

此时：

```text
projectedInputTokens
= anchor.totalTokens
+ guardedEstimatedDeltaTokens
```

### 10.3 Anchor 失效

以下情况放弃 `last total + delta`，对完整 prepared request 做 guarded estimate：

- session 第一次请求；
- prefix 校验失败；
- tool schema 或 request config 变化；
- context 被重排、删除、替换或压缩；
- 后续 `/resume`；
- 无法证明 anchor segments 是下一请求的完整前缀。

公式：

```text
projectedInputTokens = guardedFullRequestEstimate
```

任何无法证明 append-only 的情况都走完整估值，不猜测 delta。

### 10.4 ContextMeter 所有权

`RuntimeSession` 创建并拥有一个 `ContextMeter`：

```ts
type ContextMeter = {
  measure(prepared: PreparedModelRequest): ContextPreflightSnapshot;
  recordProviderUsage(
    prepared: PreparedModelRequest,
    output: ModelRequestOutput,
  ): ContextUsageSnapshot;
  invalidate(reason: ContextInvalidationReason): void;
};
```

agent loop 不直接维护 ratio、anchor 或 prefix hash。refiner 使用独立的无 session anchor
meter，避免污染主 conversation。

## 十一、Preflight 与执行顺序

### 11.1 每个 Iteration

```text
agent.iteration.started
  -> conversation.buildModelRequest(tools)
  -> model.prepare(input)
  -> ContextMeter.measure(prepared)
  -> context.usage.updated phase=preflight
  -> 若 blocked：不发送 model.request.started，不访问 provider
  -> model.request.started
  -> model.request(prepared)
  -> adapter 校验完整 usage
  -> conversation.appendAssistant(message)
  -> model.request.finished
  -> ContextMeter.recordProviderUsage(prepared, output)
  -> context.usage.updated phase=measured
  -> 继续 tool batch 或结束 turn
```

preflight 必须发生在 `model.request.started` 之前，使事件名继续诚实表示真正的网络请求。

### 11.2 Pressure 行为

| pressure | F2 行为 | 后续 compaction 行为 |
| --- | --- | --- |
| `normal` | 正常请求 | 不压缩 |
| `triggered` | 记录并正常请求 | 安全边界先 compact，再重新 preflight |
| `blocked` | 请求前失败 | compact；仍 blocked 才失败 |

F2 不因达到 80% 就修改消息或停止使用模型，否则会把计量阶段变成半成品 compaction。

### 11.3 Turn Admission

新 user prompt 在 `beginTurn()` 前做一次 admission preflight。conversation 先构造一个不改变
所有权状态的 candidate view，adapter 对它执行正常 `prepare()`，再由 ContextMeter 计量：

```text
committed conversation + candidate user message + current tools
  -> model.prepare(candidate input)
  -> ContextMeter.measure(candidate prepared request)
```

若已经 `blocked`，拒绝该 prompt，不创建 turn，不提交 user message。这样一个明显超大输入
不会把本来可用的 session 永久推进到不可请求状态。

admission 只做硬预算检查；达到 trigger 仍允许创建 turn。通过 admission 后，正式 iteration
仍重新 prepare 和 preflight；两次结果应由确定性测试保证一致，iteration preflight 才是实际
网络请求的最终门禁。

admission 拒绝发生在 turn identity 创建前，因此不伪造 `turn.failed`。one-shot 由 runner
输出错误并返回非零退出码；TUI 由 App 捕获 `ContextBudgetExceededError` 并显示本地 notice，
不能像当前通用 `.catch()` 一样静默丢弃。

### 11.4 Tool Side Effect 后 blocked

若工具已执行并产生 side effect，随后因巨大 tool observation 导致下一 iteration
`blocked`：

- 不再调用 provider；
- 已完成的 assistant/tool protocol delta 继续按当前 RuntimeSession 规则提交；
- `turn.failed` 明确记录 projected input、budget 和最近 tool call；
- 不回滚副作用；
- F2 不静默删除 observation 以恢复请求能力。

这类 session 在 compaction 未实施前可能无法继续模型请求，属于 F2 的已知阶段边界。

### 11.5 错误类型

```ts
class ContextBudgetExceededError extends Error {
  projectedInputTokens: number;
  inputBudgetTokens: number;
  triggerTokens: number;
  source: ContextUsageSource;
}
```

错误文案示例：

```text
Model request blocked before provider call: projected input 930K exceeds
Tinker input budget 896K (model window 1M, reserved output 128K).
```

## 十二、Context 状态与事件

### 12.1 Snapshot

```ts
type ContextUsageSource =
  | "estimated_full"
  | "provider_measured"
  | "measured_plus_estimated_delta";

type ContextPressure = "normal" | "triggered" | "blocked";

type ContextUsageSnapshot = {
  usedInputTokens: number;
  source: ContextUsageSource;
  pressure: ContextPressure;
  inputBudgetTokens: number;
  triggerTokens: number;
  triggerRatio: number;
  requestMaxOutputTokens: number;
  lastProviderUsage?: ModelUsage;
  rawFullEstimate?: RawContextBreakdown;
  rawDeltaTokens?: number;
  guardedDeltaTokens?: number;
  correctionFactor: number;
  calibrationSampleCount: number;
  prefixHash: string;
  requestConfigHash: string;
  toolSchemaHash: string;
};
```

所有 token 数都是整数。`usedInputTokens` 是常驻 context 状态栏的唯一分子。

### 12.2 Event

增加：

```ts
"context.usage.updated": {
  phase: "initial" | "preflight" | "measured" | "invalidated";
  snapshot: ContextUsageSnapshot;
};
```

`initial`/`invalidated` 是 session-level event；`preflight`/`measured` 携带当前 iteration
identity。这样初始基线不需要伪造 iteration，后续更新仍能精确归属模型请求。

静态 profile 与派生预算加入 `session.started`：

```ts
type SessionStartedData = {
  // existing fields
  contextProfile: ModelContextProfile;
  contextBudget: ModelContextBudget;
};
```

### 12.3 初始状态

RuntimeSession 完成 built-in tools 和 MCP 注册后，对：

```text
system/kernel + 当前完整 tool schemas
```

做一次不发送网络的 full estimate，并产生 `phase=initial`。因此 TUI 第一次显示时已经有
真实的本地基线，不显示 `0K` 或 `limit unknown`。

### 12.4 Projection 边界

`TuiProjectionState` 只增加一个可替换字段：

```ts
contextUsage?: ContextUsageSnapshot;
```

每个 `context.usage.updated` 覆盖旧 snapshot，不创建 timeline item，不保留历史 samples、
完整 segments 或 raw payload。完整变化历史仍由 event log 诊断。

`contextUsage` 只允许在 RuntimeSession 初始化期间短暂缺失。TUI runner 在 session 创建完成
后才 mount App，因此生产 Prompt Input 状态栏首次 render 必须已经收到 initial snapshot；组件测试需要
显式覆盖缺失值，不能显示伪造的 `0K`。

## 十三、Prefix Fingerprint

### 13.1 目的

本地 fingerprint 只证明：

- Tinker 是否保持旧 prompt segments 的顺序与内容；
- tool schema 是否稳定；
- measured anchor 是否仍可用于 delta 估值。

它不证明 provider 一定 cache hit。Provider cache 仍是 best-effort，最终以 usage 中的
hit/miss 为准。

### 13.2 Hash Chain

不能只 hash 完整 JSON payload，因为尾部追加 message 后 full hash 必然变化。使用累计
SHA-256：

```text
H0 = sha256(adapter serialization version + request config)
H1 = sha256(H0 + segment kind + canonical bytes(segment 1))
H2 = sha256(H1 + segment kind + canonical bytes(segment 2))
...
```

在 anchor 时保存：

```text
segmentCount = N
prefixHash   = HN
```

下一请求计算到第 N 个 segment 时必须仍得到同一个 `HN`，否则 anchor 失效。

Tool schemas 放在动态 message segments 之前，并另存 `toolSchemaHash`。这样只在尾部追加
message 时，已有 prefix hash 保持稳定。

### 13.3 Request Config Hash

包括：

- provider/base URL 的非秘密标识；
- model；
- adapter serialization version；
- `requestMaxOutputTokens`；
- 实际 reasoning mapping 选项；
- 会改变 provider prompt 的其他参数。

不包括 API key、timeout、request ID、当前时间或 usage。

## 十四、Prompt Input 状态栏与 `/status`

### 14.1 Prompt Input 状态栏

context 追加在 Prompt Input 下方已有的 model/workspace/branch 状态栏中，使用
`usedInputTokens` 和 `inputBudgetTokens`：

```text
deepseek-v4-flash · ~/htdocs/tinker · main · context 700K / 896K (78% used)
```

显示规则：

- `K/M` 按 1024 格式化；
- 非整数 K 最多保留一位小数；
- 百分比四舍五入为整数；
- `normal` 使用 dim/默认颜色；
- `triggered` 使用黄色；
- `blocked` 使用红色并显示 `blocked`；
- running/cancelling/done 状态继续由现有 Footer 展示；context 不占用 Footer 的独立行。

示例：

```text
deepseek-v4-flash · ~/htdocs/tinker · main · context 750K / 896K (84% used)
```

```text
deepseek-v4-flash · ~/htdocs/tinker · main · context 930K / 896K (104% used, blocked)
```

常驻状态栏不显示 raw estimate、factor、cache 和 hash，避免信息过载。

### 14.2 `/status`

新增本地只读 slash command：

```text
/status  Show session and context details
```

它不调用模型、不写 canonical conversation、不创建 AgentEvent。App 读取当前
`TuiProjectionState`，显示一个临时 status panel；提交下一 prompt 或下一 slash command 时
清除。

建议输出：

```text
Session
  id: 019f...
  model: deepseek-v4-flash
  workspace: /Users/.../tinker

Context
  used: 750K / 896K (84%)
  pressure: triggered
  trigger: 716.8K (80%)
  model window: 1M
  request max output: 128K
  model max output: 384K

Measurement
  source: measured + estimated delta
  prompt: 690K
  completion: 10K
  total: 700K
  cache hit: 650K
  cache miss: 40K
  reasoning: 2K

Estimator
  correction factor: 1.18
  samples: 8/8
  raw pending delta: 42K
  guarded pending delta: 50K
  prefix: sha256:abcd1234...
```

可选 usage 字段缺失时整行省略，不显示 `undefined`。若当前 source 是 full estimated，
Measurement 段改为说明尚无 provider anchor，并显示 raw breakdown。

status panel 不展示：

- prompt/message 正文；
- reasoning 正文；
- tool arguments 或 observation；
- API key、完整 base URL query；
- provider raw response。

## 十五、代码落点

### 15.1 新增模块

建议新增：

```text
src/model/model-context-profile.ts
src/model/token-estimator.ts
src/model/model-request-preflight.ts
src/agent/context-meter.ts
src/tui/components/context-status.tsx
```

职责：

- `model-context-profile.ts`
  - profile、产品常量、派生预算和 fast-fail 校验。
- `token-estimator.ts`
  - Unicode 字符估值、breakdown、rolling calibration。
- `model-request-preflight.ts`
  - prepared request、hard budget 检查和错误类型。
- `context-meter.ts`
  - session measured anchor、append-only 判定、prefix hash 和 snapshot。
- `context-status.tsx`
  - `/status` panel 格式化与渲染。

### 15.2 修改模块

- `src/cli/config.ts`
  - 强制读取两个 profile 环境变量；
  - 派生 context budget；
  - 校验 refiner model 边界；
  - 把 profile/budget 传给 model client 与 RuntimeSession。
- `src/model/model-client.ts`
  - `ModelRequestOutput.usage` 改为必填；
  - `ModelUsage` 基础字段改为必填；
  - 增加 prepared request 边界。
- `src/model/openai-chat-model-client.ts`
  - prepare 最终 payload；
  - 发送 `max_tokens`；
  - 只发送 prepared payload。
- `src/model/openai-chat-mapping.ts`
  - 强校验三个基础 usage；
  - 解析 cache 与 reasoning 分项；
  - 校验字段总和。
- `src/model/fake-model-client.ts`
  - 支持 prepared request；
  - 返回合法固定 usage。
- `src/agent/context-builder.ts`
  - 稳定选择和复制 provider-neutral messages/tools；adapter 从最终映射结果输出语义
    segments 和 raw breakdown 输入；
  - 不做 pressure 决策。
- `src/agent/session-conversation.ts`
  - 暴露 admission 所需的只读 candidate view；
  - 保持 committed/pending 所有权边界。
- `src/agent/runtime-session.ts`
  - 创建并拥有 ContextMeter；
  - 工具初始化后发布 initial usage；
  - turn admission hard check。
- `src/agent/loop.ts`
  - 调整 prepare/preflight/request 事件顺序；
  - blocked 时不调用 provider；
  - 响应后更新 measured anchor。
- `src/events/types.ts`
  - 扩展 `session.started`；
  - 增加 `context.usage.updated`。
- `src/tui/event-store.ts`
  - snapshot 保存最新 context usage；
  - context event 不进入 timeline。
- `src/tui/components/prompt-input.tsx`
  - 把 context 追加到 model/workspace/branch 状态栏并保留 pressure 颜色。
- `src/tui/slash-commands.ts`
  - 注册 `/status`。
- `src/tui/app.tsx`
  - 处理 `/status` 本地 panel；
  - 显示 admission 阶段的 context budget 错误；
  - 不把命令提交给 RuntimeSession。
- `src/tools/web-fetch/refiner.ts`
  - 走相同 prepared request、输出上限、usage 校验和 hard preflight；
  - 不更新主 session ContextMeter。

### 15.3 不修改

- tool raw result 与 observation 内容契约；
- Bash task 生命周期；
- MCP 工具执行语义；
- JSONL/observation log 的 required sink 职责；
- turn cancellation signal；
- TUI projection retention policy；
- message 选择、顺序和正文。

## 十六、分步实施顺序

### F2.1：Profile 与 Provider Usage 强契约

1. 增加 profile/budget 类型、常量和环境变量校验。
2. 让 one-shot、TUI、fake/injected model 全部要求 profile。
3. `ModelUsage` 与 `ModelRequestOutput.usage` 改为必填。
4. mapper 校验基础 usage、cache 和 reasoning。
5. adapter 真正发送 `max_tokens`。

完成条件：缺配置无法启动；缺 usage 的成功响应无法进入 conversation；捕获请求可证明
发送值等于派生的 `requestMaxOutputTokens`。

### F2.2：Prepared Request 与 Estimator

1. 引入 prepare/send 边界，删除 preflight 与 request 的双重映射。
2. 输出 prompt segments 和稳定序列化。
3. 实现字符 raw estimator 与 breakdown。
4. 实现 rolling calibration。
5. 实现 request/tool schema/config hash。

完成条件：同一 input 多次 prepare 得到相同 estimate/hash；真正发送的 payload 是已经计量
的同一 prepared payload。

### F2.3：Anchor、Preflight 与 Events

1. RuntimeSession 拥有 ContextMeter。
2. 工具/MCP 初始化后发布 initial snapshot。
3. 实现 measured anchor、append-only prefix check 和 full fallback。
4. 调整 agent loop 事件顺序。
5. 实现 admission 与 iteration hard budget check。
6. 发布 preflight/measured context events。

完成条件：blocked 请求没有 `model.request.started`、没有网络调用；append-only 使用 delta，
任一 hash/config 变化自动完整重估。

### F2.4：Prompt Input 状态栏与 `/status`

1. TUI projection 保存最新 context snapshot。
2. Prompt Input 状态栏显示 used/budget/percentage 和 pressure。
3. 增加 `/status` panel。
4. 确认 raw payload/message/tool content 不进入 projection。

完成条件：late subscriber 立即得到最新 usage；一千次 context event 后 snapshot 大小不增长；
`/status` 不调用 provider。

### F2.5：真实 Provider 校准与文档回填

1. 对 DeepSeek-V4-Flash 执行多轮 smoke test。
2. 比较 raw/guarded estimate 与 provider prompt usage。
3. 验证 cache hit/miss 和 prefix hash。
4. 调整 estimator 常量时记录证据。
5. 评审通过并实施后更新 roadmap F2 状态和实际差异。

## 十七、测试计划

### 17.1 配置测试

- 缺少任一 profile 变量 fast-fail。
- 空字符串、浮点、负数、零、超出 safe integer fast-fail。
- `maxSupportedOutputTokens > contextWindowTokens` fast-fail。
- DeepSeek 示例派生 `128K / 896K / 716.8K`。
- 256K/64K 示例派生 `64K / 192K / 153.6K`。
- refiner model 不同且没有独立 profile 时 fast-fail。
- one-shot/TUI/fake model 使用同一 profile 校验路径。

### 17.2 Usage Mapper 测试

- 三个基础字段完整时规范化成功。
- 缺失任一基础字段 fast-fail。
- 非整数、负数、NaN、Infinity、字符串 fast-fail。
- `total != prompt + completion` fast-fail。
- DeepSeek cache 字段规范化并校验和。
- OpenAI `cached_tokens` fallback 正确派生 miss。
- 两套 cache 字段冲突 fast-fail。
- reasoning token 超过 completion fast-fail。
- 协议错误包含 provider/model/字段路径。
- mapper 失败时 assistant message 未 append。

### 17.3 Adapter Prepare 测试

- `max_tokens` 等于派生 request max。
- 无 tools 时不发送 tool choice。
- 有 built-in/MCP tools 时 schema 顺序稳定。
- reasoning mapping 选项进入 config hash。
- prepare 两次得到相同 payload、segments 和 hash。
- request 拒绝其他 adapter/model 的 prepared payload。
- preflight 使用的 payload 与 fetch 捕获 payload 逐字段一致。

### 17.4 Estimator 测试

- ASCII、中文、混合 Unicode、emoji 使用正确分支。
- 使用 code point 而非 UTF-16 code unit。
- 代码、JSON、SHA256、路径和 tool schema 纳入估值。
- raw breakdown 总和稳定。
- 无样本 factor 为 1.25。
- 最近 8 次最大 observed ratio 与 1.05 padding 正确。
- 第 9 个样本淘汰最旧值。
- 高 ratio 不被 clamp。
- invalidation 清空 calibration samples。

### 17.5 Anchor 与 Prefix 测试

- 第一请求使用 full estimate。
- provider response 后建立 measured anchor。
- 追加 assistant/tool/user segments 后只估 delta。
- prefix 正文、顺序或 tool schema 任一变化时 anchor 失效。
- context rebuild 后自动 full estimate。
- provider total 包含不重放 reasoning 时保持保守，不做扣减。
- full JSON hash 变化不影响累计 prefix 的旧 `HN`。

### 17.6 Runtime 集成测试

- 事件顺序是 iteration -> context preflight -> model started -> model finished -> measured。
- admission blocked 时不创建 turn、不提交 user prompt。
- admission blocked 时 one-shot 非零退出，TUI 显示错误 notice。
- iteration blocked 时不调用 model client。
- tool side effect 后 blocked 时保留协议 delta 并明确失败。
- triggered 但未 blocked 时 F2 不修改消息并继续请求。
- completed/failed/cancelled 原有提交语义不回归。
- refiner 请求不改变主 ContextMeter anchor。

### 17.7 TUI 测试

- DeepSeek 示例显示 `700K / 896K (78% used)`。
- 256K/64K 示例显示 `150K / 192K (78% used)`。
- normal/triggered/blocked 颜色和文字正确。
- context 与 running/cancelling/done 同时可见。
- `/status` 不触发 RuntimeSession run。
- optional cache/reasoning 缺失时省略对应行。
- raw prompt、tool schema、observation、reasoning 和 provider raw response 不进入 snapshot。
- 一千次 usage update 后只保留最新 snapshot。

### 17.8 完整门禁

```text
bun run check
真实 DeepSeek smoke test
真实 PTY Prompt Input 状态栏与 /status 验证
```

## 十八、真实 DeepSeek Smoke Test

至少覆盖：

1. 纯英文短 prompt；
2. 中文 prompt；
3. 代码、JSON、路径、UUID 和 SHA256 混合；
4. 一次 tool call + 小 observation；
5. 一次较大 Read/Grep/Bash observation；
6. 同一 session 多个 iterations，观察 append-only delta；
7. 重复前缀请求，观察 cache hit/miss。

每个请求记录：

```text
raw full estimate
raw delta estimate
correction factor
guarded projected input
provider prompt/completion/total
cache hit/miss
reasoning tokens
prefix hash
request latency
```

验收要求：

- adapter 捕获证明确实发送 `max_tokens=131072`；
- provider 三个基础 usage 字段全部通过强校验；
- guarded estimate 在测试样本中不低于实际 `prompt_tokens`；
- 第一次 calibration 后，append-only 请求使用 measured anchor + delta；
- prefix 未变化时本地累计 hash 保持稳定；
- cache miss 与本地 hash 结果不矛盾时，如实记录 provider best-effort 行为；
- estimator 常量若需修改，先更新测试证据和本设计，不静默调参。

## 十九、验收标准

F2 只有在以下条件全部满足时完成：

1. 没有合法 `ModelContextProfile` 时 Tinker 无法启动。
2. 不按 model name 或 provider 名猜 context 能力。
3. 所有模型请求真正发送派生的最大输出限制。
4. 成功响应缺少 prompt/completion/total 任一字段时按 provider 协议错误处理。
5. `total = prompt + completion` 及可选分项不变量得到校验。
6. 每次请求前都有 prepared payload、raw/guarded estimate、breakdown 和 pressure。
7. append-only 时使用 measured total + estimated delta；无法证明时完整重估。
8. 超过 input budget 时不发出 `model.request.started`，不访问 provider。
9. 达到 80% trigger 时只记录压力，不在 F2 修改 message selection。
10. Prompt Input 状态栏中的 context 分母始终是 `context window - request max output`。
11. `/status` 展示配置、预算、measured usage、估值与 hash，但不泄露正文。
12. TUI projection 只保留最新 context snapshot，内存不随 usage event 数增长。
13. refiner 等内部模型请求不能绕过 profile、输出上限、usage 校验和 hard preflight。
14. 真实 DeepSeek smoke test 对估值、usage 和 cache 提供可复查证据。
15. `bun run check` 与真实 PTY 验证全部通过。

## 二十、后续阶段的接入点

F2 输出的稳定边界是：

```text
ContextUsageSnapshot
ContextPressure
MeasuredContextAnchor
PreparedModelRequest
ContextBudgetExceededError
```

后续自动 compaction 不重新设计计量，只在安全边界使用：

```text
preflight pressure = triggered
  -> compact current active view
  -> invalidate measured anchor
  -> prepare rebuilt request
  -> full estimate
  -> 再次 preflight
  -> 通过后请求 provider
```

这保证 F2 是后续 context revision、swap 和 checkpoint 的计量地基，而不是一次性的状态栏
统计功能。

## 二十一、外部依据

- [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)：模型窗口、
  最大输出和计费口径。
- [DeepSeek Token & Token Usage](https://api-docs.deepseek.com/quick_start/token_usage/)：
  字符/token 近似比例、离线 tokenizer 和 provider usage 真值。
- [DeepSeek Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/)：
  `max_tokens`、输入加输出限制、usage/cache/reasoning 字段。
- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)：重复前缀、
  cache hit/miss 与 best-effort 行为。
