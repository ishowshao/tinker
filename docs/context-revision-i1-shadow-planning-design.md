# I1：Context Revision Compiler 与 Shadow Planning 设计

## 文档状态

- 日期：2026-07-16
- 状态：已实施并通过验收
- 前置阶段：[`context-revision-g0-baseline.md`](context-revision-g0-baseline.md)
- 对应路线图：[`agent-runtime-roadmap.md`](agent-runtime-roadmap.md) 的 I1
- 当前持久化基线：SessionStore schema v4
- 后继阶段：I2 温层确定性换出与手动 `/compact`；更后续为 Recall-first 冷前缀退休

## 一、结论

I1 在 **不升级 schema v4、不切换 `active_revision_id`、不改变任何模型请求内容** 的
前提下，完成两件事：

1. 让 `ContextRevisionCompiler` 成为 canonical history 到模型输入之间唯一的编译入口；
2. 用同一编译器构造纯内存的 prospective swap revision，计算候选、目标视图、token
   收益和协议审计结果，但绝不提交它。

I1 把 placeholder 定义为可测量的温层表示，不把它定义成永久目录。后续 revision
可以在连续的完整已结束 turn 之后前移 `keepFromOrdinal`，让早期 frame 及其 placeholder
整体退出 active context；canonical history 和 Recall 索引仍保留原文。这一能力不在 I1
实施。

schema v4 已经具备 I1 所需的安全外壳：

- `session_meta.active_revision_id` 指向唯一活动 revision；
- `context_revisions` 只允许 `revision_number = 1`、`kind = 'initial_full'`、
  `keep_from_ordinal = 1`；
- `session_meta_monotonic_update` 禁止修改 `active_revision_id`；
- `context_revisions` 有不可更新、不可删除 trigger；
- canonical `messages`、`tool_results` 不可修改；
- `protocol_frames` 只允许从 open 单向关闭；
- `context_measurement_state` 明确绑定当前 revision。

因此 I1 不需要提前创建 v5 空表，也不需要把 shadow plan 伪装成持久化 revision。
真正需要保存 override 并原子切换活动 revision 时，再由 I2 显式设计和切换新 schema。

## 二、为什么 I1 保持 schema v4

### 2.1 当前 v4 已经表达了完整上下文

v4 的活动 revision 虽然只有一种，但语义完整：

```text
active revision = initial_full
keep_from_ordinal = 1
overrides = none
compiled messages = canonical messages in ordinal order
```

I1 的 active compiler 只需把这条隐含规则变成显式、可验证的编译契约。编译结果必须与
当前 `ContextBuilder` 的输出逐项相同。

### 2.2 Shadow plan 不是 durable state

shadow plan 只回答“如果未来执行 swap，会发生什么”，它不参与恢复，也不允许成为模型
输入。把它写进 SessionStore 会产生三个错误信号：

1. 看起来像一个可以 resume 的 revision，实际上没有切换语义；
2. 迫使 v4 提前容纳尚未验证的 override schema；
3. 让诊断数据混入 canonical source of truth。

I1 只把有界的聚合审计结果写入 diagnostic event；完整候选正文、路径、命令和
placeholder 不进入 event log。

### 2.3 v4 的限制是 I1 的硬保护

即使实现误调用了未来的 revision 写入路径，v4 的 CHECK 和 trigger 也必须立即拒绝：

```text
context_revisions row count == 1
active_revision_id remains initial revision
context_measurement_state.revision_id remains initial revision
```

I1 测试必须直接检查这些数据库不变量，而不是只相信调用路径没有执行写入。

## 三、当前代码基线

当前请求路径是：

```text
SessionStore.loadProtocolView()
  -> SqliteSessionLedger
  -> InMemorySessionLedger
  -> ContextBuilder
  -> ModelClient.prepare()
  -> ContextMeter.measure()
  -> provider request
```

这里有三个需要在 I1 收紧的地方：

1. `ContextBuilder` 只知道 canonical `ProtocolContextView`，不知道活动 revision；
2. `SessionStore.validateInitialRevision()` 只做完整性检查，没有向编译器暴露结构化
   revision；
3. shadow planner 如果直接复制一套 message 渲染逻辑，I2 很容易出现 active 与 shadow
   两套语义漂移。

I1 将路径调整为：

```text
SessionStore.loadContextSnapshot()
  -> canonical ProtocolContextView + active revision v4
  -> ContextRevisionCompiler.compileActive()
  -> CompiledRevisionContext
  -> ContextRequestBuilder.build()
  -> ModelClient.prepare()
  -> ContextMeter.measure()
  -> provider request

                                  +-> ShadowSwapPlanner.plan()
                                      （只构造 prospective view）
```

canonical ledger 继续负责追加和协议事实；compiler 只负责投影，不能写 SQLite。

## 四、目标与非目标

### 4.1 I1 目标

1. 为 schema v4 的 `initial_full` 建立显式 active revision 类型和读取 API。
2. 建立 canonical history 到 provider-neutral message view 的纯编译器。
3. 证明新 active compiler 与当前请求在 message、tool schema、prepared segment 和 payload
   上完全等价。
4. 对相同 revision 的连续请求执行 append-only prefix audit。
5. 对旧的大体积 tool observation 生成确定性 prospective placeholder。
6. 在 shadow mode 中选择候选并计算严格更小的目标请求。
7. 输出不含正文的聚合审计指标，供 I2 冻结 policy。
8. 用 G0 长会话 workload 验证 resume、取消、Recall 和请求内容均不受影响。

### 4.2 I1 非目标

I1 明确不做：

- schema v5 或任何 schema migration；
- 第二条 `context_revisions` 记录；
- `context_overrides` 表；
- 修改 `session_meta.active_revision_id`；
- 向模型发送 placeholder；
- `/compact`；
- 自动 compaction；
- Recall-first 冷前缀退休或 `keepFromOrdinal > 1`；
- checkpoint 或模型摘要；
- 模型辅助候选选择；
- vector search；
- 删除、更新或归档 canonical message/tool result；
- 把 Recall 原文恢复到历史 ordinal。

## 五、核心不变量

I1 的实现和测试必须共同守住以下不变量：

```text
Canonical history remains immutable
Schema remains exactly v4
The only durable revision remains initial_full
The active revision ID never changes
Active compiled requests remain byte-stable
Shadow compilation never reaches ModelClient.request
Shadow planning never changes ContextMeter state
Every changed representation still preserves its complete protocol frame
Every placeholder points to canonical Recall source and content hash
A shadow target must be strictly smaller than its base request
Planner diagnostics never contain original observation text
```

“byte-stable”在当前 OpenAI-compatible adapter 中指 `PreparedPromptSegment.normalizedText` 和
canonical request payload 的稳定 JSON 表示完全一致。HTTP 库最终写 socket 时的分块方式
不属于 context 语义。

## 六、类型边界

### 6.1 v4 活动 revision

从 SessionStore 暴露的类型必须忠实反映 v4，不能先塞入未来字段：

```ts
type StoredInitialContextRevisionV4 = {
  revisionId: ContextRevisionId;
  sessionId: SessionId;
  revisionNumber: 1;
  kind: "initial_full";
  keepFromOrdinal: 1;
  createdAt: string;
};
```

`SessionStore.loadContextSnapshot()` 返回同一个一致性快照：

```ts
type StoredContextSnapshotV4 = {
  meta: Pick<StoredSessionMetaV4, "sessionId" | "activeRevisionId">;
  revision: StoredInitialContextRevisionV4;
  canonical: ProtocolContextView;
};
```

读取时必须验证：

- revision 恰好一条；
- revision/session ID 正确；
- meta 的 active ID 与 revision ID 相同；
- canonical view 通过 `ContextProtocolValidator` 完整校验；
- system frame/message 仍是 ordinal 1；
- canonical 最大 ordinal 与 message 数一致。

任一条件失败都属于 SessionStore 完整性错误，在模型或工具执行前 fast-fail。

### 6.2 编译结果不能冒充 canonical record

未来 placeholder 的正文与 canonical tool message 不同。如果把它重新包装成
`CanonicalMessageRecord`，就必须伪造 `contentSha256`，并混淆 source of truth。

I1 新增独立的投影类型：

```ts
type CompiledContextEntry = {
  frameId: ProtocolFrameId;
  messageId: MessageId;
  ordinal: number;
  representation: "canonical" | "swapped";
  sourceContentSha256: string;
  message: AgentMessage;
};

type CompiledRevisionContext = {
  sessionId: SessionId;
  revisionId: ContextRevisionId;
  canonicalThroughOrdinal: number;
  entries: readonly CompiledContextEntry[];
  manifest: CompiledContextManifest;
};

type CompiledContextManifest = {
  frameCount: number;
  messageCount: number;
  canonicalSequenceHash: string;
  renderedMessageHash: string;
};
```

其中：

- `sourceContentSha256` 永远来自 canonical message；
- `message` 是唯一进入 `ModelRequestInput` 的投影；
- active v4 编译时所有 entry 都是 `canonical`；
- shadow view 可以含 `swapped`，但只存在于本次规划调用栈；
- manifest 只保存 hash 和计数，不复制正文。

### 6.3 Request builder

`ContextRevisionCompiler` 不知道 tool schema，也不处理尚未提交的 admission prompt。
后续仍由 request builder 组合：

```ts
type BuiltContextRequest = {
  canonical: ProtocolContextView;
  compiled: CompiledRevisionContext;
  request: ModelRequestInput;
  candidateUserPromptIncluded: boolean;
};
```

`canonical` 是 ledger 当前不可变 view 的只读引用，不重新复制正文。它只供 validator 和
shadow candidate/renderer 读取 raw tool completion；active provider path 只消费
`compiled` 与 `request`。

这样 active revision 的选择与 provider request 配置保持分离：

```text
revision compiler: canonical -> selected/rendered messages
request builder: compiled messages + tools + optional candidate prompt
model adapter: provider serialization
```

## 七、Active Context 编译

### 7.1 `initial_full` 的唯一规则

I1 的 `compileActive()` 只接受 v4 `initial_full`：

1. 按 `protocol_frames.firstOrdinal` 和 `messages.ordinal` 校验完整 canonical view；
2. 保留所有 frame；
3. 按 ordinal 保留所有 message；
4. 使用现有 `materializeAgentMessages()` 生成 `AgentMessage`；
5. 不读取 workspace、当前时间、后台任务状态或 event log；
6. 不生成额外 system/user/tool message；
7. 不根据 token 压力改变输出。

出现未知 revision kind 时直接报错，不能 fallback 到 full history。

### 7.2 编译必须是纯函数

相同 snapshot 必须得到相同：

- entry 顺序；
- rendered message；
- canonical sequence hash；
- rendered message hash；
- prepared prompt segments；
- plan candidate 顺序。

时钟、随机 ID、当前 cwd 内容、环境变量和数据库 rowid 都不能参与 hash。

### 7.3 Canonical 与 compiled 的双重校验

编译前使用现有 `ContextProtocolValidator` 校验 canonical 事实。编译后新增轻量
`CompiledContextValidator`，校验：

- entry 数和顺序与 manifest 一致；
- frame/message/ordinal 身份没有重复；
- active v4 每个 entry 都保持 canonical 表示；
- shadow view 只允许已批准的 tool entry 改为 `swapped`；
- message role、tool call ID、provider tool call ID、tool name 不得变化；
- frame 内的 message 数、顺序和边界不得变化；
- system/user/assistant 正文不得被 shadow renderer 修改。

这不是第二套 canonical protocol validator。它只验证“投影没有改变协议骨架”。

## 八、Prefix 稳定性

### 8.1 复用现有 prefix hash 算法

`ContextMeter` 当前已有 prompt segment hash chain，但实现是私有函数。I1 将它提取为纯
模块，例如 `src/model/prompt-prefix-hash.ts`：

```ts
type PromptPrefixFingerprint = {
  requestConfigHash: string;
  toolSchemaHash: string;
  segmentCount: number;
  prefixHash: string;
};
```

`ContextMeter`、resume anchor 和 I1 prefix audit 必须调用同一个实现，不能复制 hash
算法。

### 8.2 Append-only 审计

对同一 RuntimeSession、同一 active revision 的连续 **已提交请求**，保存上一次
fingerprint。下一次请求必须满足：

1. request config hash 相同；
2. tool schema hash 相同；
3. 新 segment 数不少于旧 segment 数；
4. 新 hash chain 在旧 `segmentCount` 位置的 hash 等于旧 `prefixHash`。

admission 阶段临时追加、尚未落库的 candidate user prompt 不更新此审计 anchor。真正进入
agent iteration 后，user frame 已经提交，才参与连续前缀审计。

同一 revision 出现非 append-only 变化是 I1 实现错误，必须在 provider request 前
fast-fail。revision 切换后的首个请求会建立新 anchor；这个规则留给 I2。

## 九、Shadow Swap 候选

### 9.1 初始 policy

I1 冻结一个明确但仍属于 audit-only 的 policy：

```ts
const shadowSwapPolicyV1 = {
  version: "shadow-swap-v1",
  minimumObservationBytes: 8 * 1024,
  protectedRecentTurnCount: 8,
  targetInputRatio: 0.6,
} as const;

type ShadowSwapPolicyV1 = typeof shadowSwapPolicyV1;
```

理由：

- 8 KiB 来自 G0 本地聚合的实际分界，当前历史中有 54 条达到该大小；
- G0 确定性 workload 的 tool observation 约 14 KiB，可以稳定覆盖候选路径；
- 最近 8 turns 是保守保护区，不与 TUI policy 共享常量，避免把展示策略误当语义策略；
- 当前 trigger 是 input budget 的 80%，shadow target 先用 60% 形成足够回差；
- 这些值在 I1 是审计版本的一部分，不写入 `ModelContextBudget` 或 runtime contract；
  I2 只有在基线结果稳定后才能把它们升级为活动策略。

### 9.2 Eligible 条件

一个候选必须同时满足：

1. message role 是 `tool`；
2. 所属 `tool_exchange` frame 已关闭；
3. 对应 `tool_results` 是 `completion_kind = 'returned'`；
4. tool name 不是 `Recall`；
5. turn 不在最近 8 个 distinct turn ID 的保护区；
6. observation UTF-8 byte length 至少 8 KiB；
7. raw result kind 在 v1 allowlist；
8. renderer 能生成有效 placeholder；
9. placeholder UTF-8 byte length 严格小于原 observation；
10. `ctx://message/<messageId>` 由当前 session 的 canonical message 构成，content hash 与
    `tool_results.observation_sha256` 一致。

v1 allowlist：

```text
read
glob
grep
bash（status 不是 running）
task_output（task status 不是 running）
web_search
web_fetch
mcp
```

v1 明确排除：

- `write`、`edit`：修改证据和 patch 暂时完整保留，待 I1 数据证明收益后再单独设计；
- `task_list`、`task_stop`：内容表达短期任务状态，不作为首批历史换出对象；
- `recall`：避免用 Recall 结果递归生成 Recall placeholder；
- `generic`：没有足够结构化事实生成可靠 placeholder；
- synthetic completion：本来很短，而且承担取消、失败、恢复语义；
- running Bash/background task：任务仍可能变化，不冻结为历史占位符。

不满足条件是带 reason code 的普通排除，不是异常。reason code 用于聚合审计，但 event
不记录 message ID 或正文。

### 9.3 排序

候选按以下稳定顺序排序：

1. `byteSavings = originalByteLength - renderedByteLength` 降序；
2. `originalByteLength` 降序；
3. canonical ordinal 升序；
4. message ID 字典序。

planner 只能选择这个排序的前缀集合。这样相同 snapshot 和 policy 不会因 SQLite 查询
顺序或 JS Map 插入顺序产生不同计划。

## 十、Placeholder Renderer

### 10.1 格式

I1 使用未来 I2 也准备采用的 `swap-observation-v1`，否则 shadow token 数据没有意义。
通用结构：

```text
[Tinker historical tool observation swapped]
source=ctx://message/<message-id>
contentSha256=<canonical-content-hash>
tool=<tool-name>
metadata=<stable-json-allowlisted-metadata>
historical=Use Recall get with source to recover the original observation.
current=<static-tool-specific-guidance>
```

所有行顺序固定，以单个 `\n` 连接，结尾不附加当前时间或随机内容。

### 10.2 Metadata 规则

renderer 只能从已验证的 `ToolRawResult` 读取 allowlisted scalar facts：

| raw kind | 允许字段示例 | 明确禁止复制 |
| --- | --- | --- |
| read | filePath、startLine、endLine、sha256、sizeBytes | content |
| glob | pattern、searchPath、matchCount | matches |
| grep | pattern、searchPath、mode、numMatches、truncated | content、filenames |
| bash | status、exitCode、outputFilePath、outputBytes、command 摘要 | preview |
| task_output | taskId、status、outputFilePath、outputBytes | preview |
| web_search | query 摘要、resultCount、requestId | results、highlights |
| web_fetch | url、finalUrl、title 摘要、httpStatusCode | content、highlights |
| mcp | serverName、serverToolName、isError、contentBlockCount | text |

外部字符串必须经过 JSON 转义。每个 scalar 最多保留 256 UTF-8 bytes；超出时保存稳定
prefix、原 byte length 和 SHA-256。metadata 总上限为 1 KiB。renderer 不能把网页正文、
shell preview、MCP text、patch 或搜索结果自然语言复制到 placeholder。

`current` 是按 raw kind 选择的固定模板，不根据 raw content 生成。例如历史 Read 指向
重新 Read 当前文件，历史 Bash 只建议先检查当前状态再决定是否重跑，不能直接鼓励重放
有副作用命令。

### 10.3 Override 类型

```ts
type ProspectiveSwapOverride = {
  frameId: ProtocolFrameId;
  messageId: MessageId;
  ordinal: number;
  source: MessageSource;
  originalContentSha256: string;
  renderedContent: string;
  renderedContentSha256: string;
  originalBytes: number;
  renderedBytes: number;
  byteSavings: number;
};
```

它只存在于内存。event 只允许输出数量、byte/token 聚合和 hash，不能序列化
`renderedContent`。

## 十一、Shadow Planner

### 11.1 输入与输出

```ts
type ShadowPlanningInput = {
  active: CompiledRevisionContext;
  canonical: ProtocolContextView;
  activePrepared: PreparedModelRequest;
  activeUsage: ContextUsageSnapshot;
  tools: readonly ToolDefinition[];
  policy: ShadowSwapPolicyV1;
  trigger: "runtime_pressure" | "benchmark_forced";
  forcedTargetTokens?: number;
};

type ShadowRevisionPlan = {
  version: 1;
  policyVersion: "shadow-swap-v1";
  planHash: string;
  baseRevisionId: ContextRevisionId;
  baseCanonicalThroughOrdinal: number;
  basePrefixHash: string;
  requestConfigHash: string;
  toolSchemaHash: string;
  selected: readonly ProspectiveSwapOverride[];
  targetTokens: number;
  rawTokensBefore: number;
  rawTokensAfter: number;
  guardedTokensBefore: number;
  guardedTokensAfter: number;
  projectedPrefixHash: string;
};
```

普通结果还包括：

```text
below_trigger
no_eligible_candidates
target_reached
insufficient_candidates
unsupported_candidate
```

这些 outcome 都不会修改 session。

### 11.2 Token 口径

shadow revision 会重写旧前缀，因此不能复用当前 provider-measured anchor。I1 使用：

```text
rawTokens = estimatePromptSegments(prepared.promptSegments).totalTokens
guardedTokens = ceil(rawTokens * activeUsage.correctionFactor)
```

before/after 使用同一个 correction factor。`activeUsage.usedInputTokens` 继续决定当前请求的
真实 pressure；shadow plan 的 projected after 始终标记为 full estimate，不能冒充
provider measurement。

planner 绝不能调用 `ContextMeter.measure()` 或 `recordProviderUsage()` 处理 hypothetical
request，以免污染 anchor、calibration 或 last provider usage。它只使用纯
`estimatePromptSegments()`。

### 11.3 选择算法

运行时 target：

```text
floor(inputBudgetTokens * 0.60)
```

算法：

1. 冻结 `baseRevisionId`、`baseCanonicalThroughOrdinal` 和 active prefix hash；
2. 提取、渲染并稳定排序 eligible candidates；
3. 只考虑排序前缀 `candidates[0..<k]`；
4. 以 1、2、4、8……的 k 构造 prospective request，调用同一个
   `ModelClient.prepare()`，但绝不调用 `request()`；
5. 第一次达到 target 后，在最后区间二分找到最小 k；
6. 用最终 prepared segments 做一次完整 token、prefix 和 request-config 校验；
7. 若全部候选仍达不到 target，返回 `insufficient_candidates` 和“全选”投影；
8. 若最终 after 不严格小于 before，整个 plan 无效。

候选排序使用 byte savings，真正的 target 与“严格更小”判断只使用上述完整 prepared
request 的 token estimate，不把 byte 数冒充 token。这样最多进行 O(log n) 次完整
prospective prepare，避免逐候选重建完整历史。

### 11.4 Plan hash 与 stale 检查

`planHash` 是以下稳定 JSON 的 SHA-256：

```text
version
policyVersion
baseRevisionId
baseCanonicalThroughOrdinal
basePrefixHash
requestConfigHash
toolSchemaHash
selected messageId + originalContentSha256 + renderedContentSha256
targetTokens
```

I1 不提交 plan，但仍实现 `assertPlanBaseCurrent()`：只要 active revision、canonical tail、
request config、tool schema 或 prefix 任一变化，plan 就是 stale。I2 必须复用该校验，不能
重新发明较弱的版本。

## 十二、运行时调度

### 12.1 正常 runtime

I1 shadow planner 只在 agent iteration 已生成真实 preflight 后运行：

```text
build active request
  -> prepare active request
  -> ContextMeter.measure(active)
  -> emit context.usage.updated(preflight)
  -> if pressure is triggered or blocked: shadow plan
  -> assert active request budget exactly as before
  -> request provider with the original active prepared request
```

此时 user frame 已提交；如果是下一 iteration，上一 tool exchange 也已完整关闭，满足安全
边界。planner 不在 tool 正执行、frame open 或并发 turn 中运行。

当 pressure 为 `normal` 时，生产 runtime 不做重型 planning。G0 benchmark 可以用显式依赖
注入选择 `benchmark_forced` 和 synthetic target，以覆盖低压力 session；该入口不成为用户
配置或环境变量。

### 12.2 模型请求零影响

planner 必须同时持有两个对象：

- `activePrepared`：唯一允许传给 `ModelClient.request()`；
- prospective prepared requests：只允许做序列化和估值。

类型和调用结构应让 prospective request 无法误传给 provider。例如 shadow planner 只返回
plan/report，不返回可由 agent loop 直接 request 的对象。

无论 outcome 是 planned、insufficient、no candidates 还是 planner diagnostic failure，
当前 I1 都继续对原 `activePrepared` 执行既有 budget 规则。blocked 请求仍然 blocked，
不能因为 shadow 证明“理论上可以缩小”就绕过 preflight。

### 12.3 失败语义

错误分两类：

**必须 fault/fast-fail：**

- canonical protocol 或 content hash 损坏；
- active revision 与 schema v4 不一致；
- active compiler 输出不满足协议骨架；
- 相同 revision 的 committed prefix 非 append-only；
- active request 与 compiler parity 不成立。

**只影响本次 shadow audit：**

- 没有 eligible candidate；
- allowlisted renderer 明确拒绝某个 raw shape；
- prospective request 未达到 target；
- shadow-only serializer/estimator 抛出非 canonical 错误。

第二类必须产生有界 `context.shadow.failed` 或 outcome event，不能静默吞掉；随后仍使用原
active request。因为 shadow 没有活动权限，这种隔离不是 context fallback。

## 十三、诊断事件

新增两个 compact event：

```ts
type ContextShadowPlannedData = {
  policyVersion: "shadow-swap-v1";
  trigger: "runtime_pressure" | "benchmark_forced";
  outcome:
    | "below_trigger"
    | "no_eligible_candidates"
    | "target_reached"
    | "insufficient_candidates";
  canonicalMessageCount: number;
  eligibleCandidateCount: number;
  selectedCandidateCount: number;
  excludedByReason: Record<string, number>;
  selectedByRawKind: Record<string, number>;
  originalObservationBytes: number;
  projectedObservationBytes: number;
  rawTokensBefore: number;
  rawTokensAfter?: number;
  guardedTokensBefore: number;
  guardedTokensAfter?: number;
  targetTokens: number;
  planHash?: string;
  durationMs: number;
};

type ContextShadowFailedData = {
  policyVersion: "shadow-swap-v1";
  stage: "candidate" | "render" | "prepare" | "validate";
  errorCode: string;
  error: string; // 固定、安全、无输入正文的诊断文本
};
```

禁止写入 event 的字段：

- prompt/assistant/tool 正文；
- placeholder 正文；
- file path、URL、query、command；
- message/tool call/source ID 列表；
- raw result；
- candidate ordinal 列表。

`events.jsonl` 继续只是诊断记录。TUI 不新增 timeline item；`/status` 是否展示最近一次
shadow 汇总留到 I1 实现后的独立产品决定，不在本阶段扩 UI。

## 十四、代码组织

建议新增：

```text
src/context/context-revision.ts
src/context/context-revision-compiler.ts
src/context/compiled-context-validator.ts
src/context/context-swap-renderer.ts
src/context/context-shadow-planner.ts
src/model/prompt-prefix-hash.ts
```

建议修改：

```text
src/session/session-store.ts
  - loadContextSnapshot()
  - 把 private initial revision 校验变成结构化 decoder + validator

src/agent/context-builder.ts
  - 只消费 CompiledRevisionContext，不再直接决定 revision 语义

src/agent/session-ledger.ts
src/session/sqlite-session-ledger.ts
  - request build 携带 canonical 只读引用与 compiled manifest
  - ledger mutation 仍只针对 canonical view

src/agent/loop.ts
  - 在真实 preflight 后调用 shadow controller
  - provider 永远收到 activePrepared

src/agent/context-meter.ts
  - 复用抽出的 prefix hash helper
  - 不提供 shadow mutation API

src/events/types.ts
  - context.shadow.planned / context.shadow.failed

scripts/bench-long-session-memory.ts
  - 增加 forced shadow projection 与前后基线
```

不要让 `ContextRevisionCompiler`、renderer 或 planner 直接 import `bun:sqlite`。所有 durable
读取由 SessionStore 完成，所有算法都以不可变 snapshot 为输入。

## 十五、测试设计

### 15.1 Schema v4 不变量

- 新 session 仍是 schema v4 和原 fingerprint。
- `context_revisions` 始终恰好一行。
- revision 仍是 `1 / initial_full / keep_from_ordinal=1`。
- shadow 前后 `active_revision_id` 不变。
- shadow 前后 context revision row count 和内容不变。
- shadow 不写 `context_measurement_state`。
- resume 后仍能恢复同一 measured anchor。

### 15.2 Active compiler parity

对 system、普通文本、多 tool call、取消、失败、interrupted recovery、reasoning content
开关分别断言：

- legacy `ContextBuilder` messages 与新 compiler messages 深度相等；
- `stableJsonStringify(ModelRequestInput)` 相等；
- `PreparedModelRequest.payload` 相等；
- 每个 `promptSegments.kind/normalizedText` 相等；
- request config/tool schema hash 相等；
- provider model request 次数不变。

parity 测试稳定后，删除测试内的 legacy 路径，不在生产保留双实现或 fallback。

### 15.3 Prefix audit

- 同 revision 追加 user frame，旧 prefix 相同。
- 追加 assistant_text frame，旧 prefix 相同。
- 完整追加 multi-tool exchange，旧 prefix 相同。
- resume 后第一次 committed request 与退出前 anchor 相容。
- 修改旧 message、tool schema、request config 或 segment 顺序立即失败。
- admission candidate prompt 不覆盖 committed prefix anchor。

### 15.4 Candidate 与 renderer

- 只有 closed tool frame 可进入候选。
- multi-tool frame 选择其中 observation 时，整个 frame 的 message 骨架仍保留。
- 最近 8 turns、Recall、synthetic、running task、非 allowlist 全部排除并给出 reason。
- 8,191 bytes 排除，8,192 bytes 可候选。
- 每个 allowlisted raw kind 的 placeholder golden test。
- metadata 字符串 JSON 转义、UTF-8 截断和 hash 稳定。
- placeholder 不包含原 content/preview/text/highlights/patch。
- source 可由 `SessionHistoryReader.get()` 找回相同 content hash。
- placeholder 不比原文小时拒绝候选。

### 15.5 Planner

- 相同输入得到相同候选顺序、selected set 和 plan hash。
- 达到 target 时选择最小排序前缀。
- 候选耗尽仍未达到 target 返回 insufficient。
- before/after 使用同 correction factor。
- after 必须严格小于 before。
- hypothetical prepare 不改变 ContextMeter anchor/calibration。
- active tail、revision、tool schema 或 request config 变化后 plan stale。
- planner 从不调用 `ModelClient.request()`。

### 15.6 Runtime 零影响

在 shadow enabled/disabled 对照中验证：

- provider 收到的 payload 完全一致；
- final answer、tool call 和 tool side effect 次数一致；
- cancellation 和 failure 结果一致；
- Recall search/get 结果一致；
- active revision 和 canonical rows 一致；
- blocked preflight 仍然 blocked；
- shadow diagnostic failure 会被记录，但不会替换 active request。

### 15.7 G0 benchmark

扩展现有长会话 benchmark：

- 默认 50-turn workload 继续经过真实 RuntimeSession/SessionStore；
- 在确定性安全边界强制一次 shadow target，覆盖低压力 fixture；
- 输出 eligible/selected 数、before/after token、plan time、plan hash；
- 断言 selected observation 可 Recall；
- 断言 active request、revision row、resume、取消和 Recall 行为不变；
- 继续记录 request build、prepare、RSS 和 session bytes，与 G0 基线比较。

正式基准还必须单独报告 `insufficient_candidates` 的出现频率和全选后的 guarded token
地板。该结果用于判断何时应进入 Recall-first 前缀退休，不用于扩大 placeholder
常驻范围。

本地历史 session 仍只做匿名只读聚合，不成为 CI fixture。

## 十六、性能与内存约束

G0 已证明 TUI 有界，但完整 request 热路径仍随 canonical history 增长。I1 还不能改变这个
事实，不过不能进一步制造长期副本：

- `CompiledRevisionContext` 只活到一次 request build 完成；
- active 与 prospective view 不挂在 TUI/event store；
- event 不含 candidate 列表或正文；
- planner 使用排序索引和 O(log n) 次 prospective prepare；
- 不在 SessionStore 内缓存完整 materialized `AgentMessage[]`；
- 不在 ContextMeter 保存 prospective prepared request；
- benchmark 必须分别记录 active compile 与 shadow plan 成本。

I1 不设跨机器毫秒硬阈值，但合并前必须报告相对 G0 的 request-build p50/p95、RSS delta 和
forced shadow duration。若 active compiler 在未规划时造成显著回退，先修复再进入 I2。

## 十七、实施顺序

### I1.1：读取与类型边界

- 暴露 v4 active revision decoder；
- 新增 `loadContextSnapshot()`；
- 保持 schema/fingerprint 不变；
- 补齐 v4 corruption tests。

### I1.2：Active compiler cutover

- 新增 compiled context 类型和 validator；
- 将 ContextBuilder 改为消费 compiled view；
- 建立 legacy parity tests；
- parity 通过后一次性删除旧直连路径，不保留 runtime flag。

### I1.3：Prefix audit

- 抽取 prefix hash helper；
- ContextMeter 与审计器共用；
- 在 committed request 上启用 append-only fast-fail；
- 验证 resume anchor。

### I1.4：Renderer 与纯 planner

- 实现 allowlist、reason codes、placeholder golden tests；
- 实现 deterministic ranking、geometric search、plan hash 和 stale check；
- 不接 runtime、不写 event。

### I1.5：Runtime shadow wiring

- 在真实 preflight 后接入 planner；
- 新增有界 audit event；
- 保证 activePrepared 是唯一 provider request；
- shadow ordinary failure 显式记录并隔离。

### I1.6：基准与门禁

- 扩展 G0 long-session benchmark；
- `bench:smoke` 覆盖 forced shadow；
- 运行正式 benchmark 与 `bun run check`；
- 将结果写回本文和 roadmap；
- 达到验收门槛后才允许设计 I2 schema。

## 十八、I1 验收门槛

I1 只有同时满足以下条件才算完成：

1. SessionStore 仍是 schema v4，fingerprint 未变化。
2. 唯一 durable revision 仍是 `initial_full`，active ID 从未改变。
3. 新 active compiler 的 prepared payload/segments 与旧路径完全相同。
4. 相同 revision 的 committed prefix append-only 审计通过。
5. shadow planner 只选择 closed、非保护区、可 Recall 的 allowlisted tool observation。
6. prospective view 保留完整 frame 骨架和全部 tool-call 对应关系。
7. 每个有效 plan 的 guarded/raw token 都严格下降。
8. plan hash 在相同 fixture 上稳定，tail/config/schema 变化会判 stale。
9. shadow planner 没有任何 provider request，也不修改 ContextMeter。
10. shadow enabled 前后模型 payload、tool side effect、取消、resume、Recall 行为一致。
11. diagnostic event 不含 prompt、tool body、path、URL、query 或 command。
12. G0 formal benchmark、smoke 和 `bun run check` 全部通过。
13. 路线图记录实际候选分布、收益和性能，再决定 I2 policy。

任一门槛未满足时，不得通过隐藏开关启用换出，也不得提前实现 `/compact`。

### 18.1 实施结果（2026-07-16）

I1 已按上述边界落地；活动请求仍使用 schema v4 的唯一 `initial_full` revision，shadow
只在真实 preflight 后构造并测量 prospective view。正式门禁结果如下：

- `bun run check` 通过：typecheck、Biome、ESLint、447 项测试和包含 forced shadow 的
  benchmark smoke 全部成功；`bun run bench:recall` 也通过，10,000-message fixture 的
  schema 仍是 v4，稀疏 trigram p50/p95 为 0.19/0.20ms。
- 50-turn formal benchmark 仍落库 52 turns、208 messages、156 frames 和 52 tool
  results；resume、取消与 Recall search -> get 全部通过。provider request 精确为 104
  次，shadow 没有增加任何 provider request。
- benchmark-only 的 `targetTokens = 0` 在第 12 回合强制规划一次，结果为
  `insufficient_candidates`。11 条已结束 observation 中，7 条落在最近 8 turns 保护区，
  1 条小于 8KiB；剩余 3 条全部入选，按 raw kind 分布为 Read 2、Bash 1。
- 入选 observation 从 42,762 bytes 降到 1,665 bytes，缩小 96.1%；完整请求 raw token
  从 43,964 降到 31,577，guarded token 从 48,361 降到 34,735，均下降 28.2%。全选后
  仍高于强制的零目标，因此该 guarded floor 被如实记录，没有扩大候选范围。
- forced shadow 用时 6.56ms；本次 plan hash 为
  `eecc1e541795d94b2b430e223235d62235479f5a48a43d97978516e44b012615`。单元测试同时验证
  同一 snapshot 内重复规划得到相同 selected set/hash，tail、config 或 schema 漂移会判
  stale。
- request build p50/p95 为 1.89/8.97ms，对比 G0 的 1.33/9.44ms：p50 绝对增加
  0.56ms，p95 下降 0.47ms；总 workload 从 2,386.09ms 降到 2,304.30ms。未观察到
  active compiler 的尾延迟回退。
- RSS 增量为 221,315,072 bytes，对比 G0 增加 28,262,400 bytes；heap 增量为
  26,342,774 bytes，对比 G0 减少 18,596,165 bytes。compiled/prospective view 未进入
  SessionStore、ContextMeter、event store 或 TUI 的长期状态，诊断 event 也只保留有界
  聚合字段。
- 数据库仍只有一条 `1 / initial_full / keep_from_ordinal=1` revision；schema
  fingerprint、`active_revision_id` 和 measured revision 全部保持一致。

以上结果满足 I1 门槛，可以开始 I2 的独立 schema/policy 设计；本阶段没有实现 revision
切换、持久化 override 或 `/compact`。

## 十九、交给 I2 的明确契约

I1 完成后，I2 可以依赖：

```text
ContextRevisionCompiler is the only active rendering path
Active initial_full rendering is byte-stable
ProspectiveSwapOverride has a frozen renderer format
Candidate eligibility and ordering are deterministic
Every source/hash resolves to canonical Recall history
Plan base and stale checks are implemented
Projected requests are protocol-valid and strictly smaller
Shadow metrics show the real reduction/performance distribution
```

这些契约只证明 swap 是一个合法且可测量的温层，不要求后续 active revision 永久编译
每条 placeholder。当 swap-only 的全选视图仍无法达到 target 或 placeholder 骨架开始主导
预算时，路线图优先进入 Recall-first 冷前缀退休，而不是直接生成 checkpoint。

I2 才负责：

- 设计并显式切换新的 schema；
- 扩展 `context_revisions` 为多 revision；
- 新增 immutable `context_overrides`；
- 在一个 transaction 中写完整 revision/override 并切 active ID；
- 让 ContextMeter 在 revision 切换后失效旧 anchor；
- 暴露空闲状态手动 `/compact`；
- 保持 canonical history 与 Recall 完全不变。

I2 不得把 shadow event 当恢复来源，也不得跳过 I1 compiler 另写一条活动渲染路径。

## 二十、最终设计决策

1. **I1 保持 schema v4，不预建 v5，也不持久化 shadow plan。**
2. **schema v4 的 `initial_full` revision 从被动完整性记录升级为 active compiler 的显式
   输入。**
3. **compiled entry 与 canonical record 是两个类型，placeholder 不能伪装成原始事实。**
4. **active 与 shadow 共用同一 revision compiler、request builder 和 provider
   serializer。**
5. **相同 revision 的稳定性以 prepared segment hash chain 做 append-only 审计。**
6. **第一批候选只覆盖 closed、旧、大体积、结构化、可 Recall 且属于明确 allowlist 的
   tool observation；placeholder 是温层表示，不是永久索引。**
7. **shadow target 暂定 input budget 的 60%，policy 带版本并由正式基线校准。**
8. **hypothetical revision 只做 full estimate，不复用 provider anchor，不污染
   ContextMeter。**
9. **正常无候选/不足是诊断 outcome；canonical、revision、active prefix 损坏则立即
   fast-fail。**
10. **只有 I1 的零影响、确定性、协议和收益门槛全部通过后，I2 才能升级 schema 并真正
    切换活动上下文；更后续的冷前缀退休必须另立设计与评测门禁。**
