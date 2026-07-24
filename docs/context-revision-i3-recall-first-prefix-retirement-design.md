# Context Revision I3：Recall-first 冷前缀退休技术方案

## 文档状态

- 日期：2026-07-18
- 状态：已实施并通过 I3 门禁
- 所属阶段：[`agent-runtime-roadmap.md`](agent-runtime-roadmap.md) 的 I3
- 前置阶段：I1 Context Revision 影子规划、I2 温层确定性换出与手动 `/compact`
- 当前基线：SessionStore schema v7、immutable `ContextSurface`、线性
  `ContextRevision`、`swap-only-v1`、`recall-first-retirement-v1`、手动 `/compact`、
  手动 `/compact retire`、稳定来源与 `Recall`
- 后继阶段：
  [`context-revision-i4-active-recall-evaluation-automation-gates-design.md`](context-revision-i4-active-recall-evaluation-automation-gates-design.md)
  主动 Recall 评测与自动化门禁
- 相关设计：
  [`context-revision-i1-shadow-planning-design.md`](context-revision-i1-shadow-planning-design.md)、
  [`context-revision-i2-deterministic-swap-manual-compact-design.md`](context-revision-i2-deterministic-swap-manual-compact-design.md)、
  [`stable-source-recall-design.md`](stable-source-recall-design.md)、
  [`runtime-contract-context-surface-refresh-design.md`](runtime-contract-context-surface-refresh-design.md)、
  [`infinite-context-technical-design-a.md`](infinite-context-technical-design-a.md)

## 一、结论

I3 实现 Recall-first 冷前缀退休：当 swap-only 已无法消除 user、assistant、tool-call
骨架和逐条 placeholder 形成的线性 token 地板时，允许一个连续、完整且足够旧的 turn
前缀退出 active context。退出只改变模型请求的活动视图，不删除、改写或摘要 canonical
history；退休历史仍由 `Recall search/get` 从原始消息和 FTS 索引中精确取回。

本阶段采用以下决定：

1. SessionStore 一次性切换到 schema v7；v6 不迁移、不 dual-read，直接 fast-fail。
2. 新增独立的 `prefix_retirement` revision kind，不把退休伪装成 `swap_only`，也不把
   surface refresh 与退休合并成一个 revision。
3. `keepFromOrdinal` 只能单调前移到某个保留 turn 的 user message；ordinal 1 的 active
   system surface 始终单独保留。
4. 退休区间必须是连续前缀，只能包含完整、已结束的 turns；不允许从中间挖洞，不允许
   切开 user、assistant 或 tool exchange frame。
5. active compiler 输出固定 system surface，加上 `keepFromOrdinal` 之后的完整 canonical
   suffix；退休区间内的 canonical message、tool-call 骨架和 swap placeholder 全部不渲染。
6. 退休边界之前的 swap override 继续作为 immutable 审计记录保存在 SQLite，但退出
   active override manifest；不删除、不重写、不复制这些记录。
7. 新增 `recall-first-retirement-v1` 策略：至少保护最近 8 个完整已结束 turns，并优先选择
   能达到 30% input budget target 的最小退休前缀。
8. I3 只提供 benchmark-forced 路径和显式的空闲态 `/compact retire`；现有无参数
   `/compact` 继续严格执行 swap-only。runtime pressure 仍只做 I1 shadow planning，不能
   自动提交任何 revision。
9. 退休过程不调用模型、不执行工具、不生成 checkpoint、不写自由文本摘要；只允许本地
   snapshot、编译、计量、校验和 SQLite transaction。
10. active system surface 的 contract version 必须等于 current version（I3 阶段即
    `recall-retirement-v1`），并包含 `Recall` tool definition；缺少任一条件时退休立即失败。
11. I3 的 Recall 门槛只证明“显式要求查找历史时可以 search -> get 精确恢复原文”。模型能否
    在没有提醒时主动 Recall、任务质量是否足以允许自动退休，全部留给 I4。
12. 任一 COMMIT 前失败都保持旧 active revision 和旧 measurement；COMMIT 后 revision
    就是 durable truth，后续 activation 失败不得假装回滚。

I3 完成后，Tinker 将第一次允许 `keepFromOrdinal > 1`，但仍没有自动 compaction。

## 二、为什么 I2 之后还需要冷前缀退休

### 2.1 swap-only 的收益存在确定性地板

I2 只替换 allowlist 内的大体积 tool observation。即使所有合格 observation 都已变成短
placeholder，active request 仍会保留：

- 每个 turn 的 user message；
- assistant text 和 reasoning 字段；
- assistant tool-call 结构；
- 每个 tool call 对应的 tool message 骨架；
- 每条被换出 observation 的 placeholder；
- 失败、取消和中断产生的协议补齐记录。

这些内容会随 turn 数量继续线性增长。继续缩短 placeholder 只能降低常数，无法消除增长
阶数；把 placeholder 当永久目录最终仍会耗尽输入预算。

### 2.2 默认方案不是摘要

I3 不生成 checkpoint 或自由文本摘要，原因是：

- 摘要会引入新的 derived truth、模型调用、来源验证和漂移风险；
- “swap 后仍高于 target”是活动视图边界问题，不足以证明必须生成摘要；
- canonical history、稳定 message ID、content hash 和 FTS 已经能够保存并精确取回原文；
- 先验证 Recall-only retirement，才能知道 checkpoint 是否真的改善任务连续性。

因此 I3 的默认表示是：

```text
active system surface
+ bounded recent canonical suffix
+ Recall tool available on demand
```

而不是：

```text
active system surface
+ one placeholder per retired item
+ model-generated summary
+ recent suffix
```

### 2.3 “退出 active context”不等于“从 session 删除”

I3 必须继续维持四层事实分离：

| 层 | I3 行为 |
| --- | --- |
| canonical messages / frames / tool results | 只追加，不删除、不改写 |
| Recall FTS 与精确 get | 覆盖全部可 Recall canonical history，不按 active boundary 过滤 |
| ContextRevision | 记录模型请求的活动视图边界 |
| TUI / events | 只展示有界结果和诊断，不充当恢复来源 |

`keepFromOrdinal` 只影响 ContextRevision compiler，不能进入 Recall reader 的查询条件。

## 三、本阶段范围

### 3.1 实施范围

- SessionStore schema v7 与新的 revision/override 语义。
- `prefix_retirement` revision 类型和 `recall-first-retirement-v1` policy。
- `PrefixRetirementPlanner`，只选择连续完整旧前缀。
- 支持退休边界的 active/prospective compiler 和 validator。
- 原子 `commitPrefixRetirementRevision()`。
- `ContextManager.retirePrefix()` 和 RuntimeSession 空闲态串行入口。
- 显式 `/compact retire` 与有界 notice/events。
- retirement revision 的继续追加、再次 swap、surface refresh、再次退休和 `/resume`。
- canonical/FTS 不变、Recall 精确取回、fault matrix、长会话 benchmark、PTY 和 provider
  payload/cache smoke。

### 3.2 明确不做

- 不按 runtime pressure 自动提交 swap 或 retirement revision。
- 不让无参数 `/compact` 自动从 swap-only 跳到 prefix retirement。
- 不自动判断模型“已经记住”哪些历史，也不做语义重要性选择。
- 不生成 checkpoint、capsule、摘要、关键词目录或每条退休记录的 placeholder。
- 不引入 embedding、reranker、向量数据库、知识图谱或跨 session Recall。
- 不删除 canonical message、protocol frame、tool result、context override 或 FTS row。
- 不退休当前 open turn，不处理单个仍需保留的超长 turn。
- 不承诺模型会主动 Recall，也不对外宣称“模型永不忘记”。
- 不迁移 schema v6 session，不保留 v6/v7 compatibility shim。

## 四、当前代码基线与必须切开的限制

### 4.1 schema v6 把 `keepFromOrdinal = 1` 写死在多层

当前限制不是一个孤立判断：

- `context_revisions.keep_from_ordinal` 的 SQL CHECK 强制等于 1；
- revision kind 只允许 `initial_full`、`swap_only`、`surface_refresh`；
- TypeScript revision types 把三个 kind 的 `keepFromOrdinal` 都收窄为字面量 `1`；
- decoder 遇到非 1 直接拒绝；
- `ContextRevisionCompiler` 遇到非 1 直接报 `Unsupported active context revision`；
- `CompiledContextValidator` 要求 compiled entries 与 canonical messages 数量完全相同；
- `ContextProtocolValidator` 把输入定义为完整 canonical view，要求 message ordinal 从 1 严格
  连续、frame range 从 ordinal 1 连续覆盖，不能直接接收 `{1} U [keep, tail]` 的 active view；
- revision-chain trigger 只允许 swap/surface refresh 成为 active revision。

I3 必须同步改变 schema、类型、decoder、compiler、validator、transaction trigger 和测试，不能
只放宽其中一处。其中 `ContextProtocolValidator` 的 canonical 连续性不放宽：它继续验证完整
ledger；带退休 gap 的活动视图由 retirement-aware `CompiledContextValidator` 对照已验证的
canonical view 单独校验。不能把 active view 直接传给现有 protocol validator，也不能为了退休
而削弱 canonical 的 `ordinal_gap` 检查。

### 4.2 schema v6 的 override count 代表累计继承

I2 中所有历史 override 永远处于 active set，因此 `total_override_count`、manifest 和编译器都
可以按 revision number 累计。I3 之后，退休边界之前的 override 仍然存在，但不再参与 active
request。继续把它们称为 active total 会混淆“已存储审计记录”和“当前渲染覆盖”。

schema v7 因此把 revision 上的计数明确改成：

- `added_override_count`：该 revision 新写入的 override 数；只有 `swap_only` 可大于 0；
- `active_override_count`：当前 `keepFromOrdinal` 范围内参与编译的 override 数；
- `active_override_manifest_sha256`：只哈希当前 active overrides。

`context_overrides` 表本身继续保存全部历史行。是否 active 由 revision number 与
`keepFromOrdinal` 共同派生，不新增可变状态列。

### 4.3 当前 `/compact` 是 swap-only

现有 `/compact`：

```text
TUI -> TuiSessionController.compact()
    -> RuntimeSession.compactContext()
    -> ContextManager.compact()
    -> SwapPlanner
    -> commitSwapRevision()
```

它的结果、events、notice 和 fault 语义全部是 swap-only。I3 不把两种策略塞入同一个隐式
fallback。新增路径为：

```text
/compact retire
  -> TuiSessionController.retire()
  -> RuntimeSession.retireContext()
  -> ContextManager.retirePrefix({ kind: "manual" })
  -> PrefixRetirementPlanner
  -> commitPrefixRetirementRevision()
```

这样用户明确知道模型将不再直接看到一段旧历史，也使每次命令最多提交一个 revision。

### 4.4 当前 Recall 契约还不够强

当前 runtime instructions 已说明 Recall 是历史快照、当前文件应由 Read/Grep 验证、空搜索不
证明信息不存在。冷退休还需要一个更明确且固定成本的契约：模型必须知道 active context
可能故意缺少旧 session 内容，并在否认历史事实或重复旧工作前先 Recall。

该契约必须成为版本化 runtime constant 和 `ContextSurface` 身份的一部分，不能靠 planner
对任意 prompt 做模糊字符串搜索。

## 五、核心不变量

I3 实现必须同时保持以下不变量。

### 5.1 canonical 不变量

1. canonical messages、frames 和 tool results 仍然 append-only。
2. 已提交 content、message ID、ordinal、frame ID、source 和 hash 不变。
3. retirement transaction 不得写入或删除 canonical/FTS 表。
4. `canonical_sequence_sha256` 继续绑定 revision 创建时的完整 canonical prefix，而不是只
   绑定 active suffix。
5. Recall search/get 的结果不受 active revision 和 `keepFromOrdinal` 影响。

### 5.2 revision 不变量

1. revision chain 线性、不可变、无 gap、无 branch。
2. active revision 始终是最高已提交 revision。
3. `keepFromOrdinal` 只能保持或增大，永不减小。
4. `initial_full.keepFromOrdinal = 1`。
5. `swap_only` 与 `surface_refresh` 继承 parent 的 `keepFromOrdinal`。
6. `prefix_retirement.keepFromOrdinal` 必须严格大于 parent，并指向保留 turn 的 user message。
7. retirement revision 不增加 override，不改变 surface。
8. 任一 revision 的 `sourceThroughOrdinal` 都是提交 snapshot 的 closed-frame 尾边界。

### 5.3 active view 不变量

active view 的 canonical ordinal 集合只能是：

```text
{1} U [keepFromOrdinal, canonicalThroughOrdinal]
```

其中 ordinal 1 使用当前 `ContextSurface.systemPrompt` 渲染。不得出现第二个 system message，
不得保留退休区间中的任一 message、tool-call 骨架或 placeholder，也不得从 retained suffix
内部挖洞。

### 5.4 protocol 不变量

1. `keepFromOrdinal` 指向 user frame 的 `firstOrdinal`。
2. 该 user frame 所属 turn 必须是 retained suffix 的第一个 turn。
3. 边界之前的每个非 system frame 都已 closed，并完整属于一个已结束 turn。
4. 边界之后的每个 frame 完整保留；tool exchange 的 assistant calls 和 tool messages 不拆分。
5. 当前 session 必须没有 open turn、iteration 或 frame。
6. 完整 canonical view 必须继续通过严格、ordinal 连续的 `ContextProtocolValidator`。
7. 编译后的 active/provider messages 必须通过 `CompiledContextValidator` 的 active-view 协议
   检查；该检查允许 system 后跳到 `keepFromOrdinal`，但 suffix 内 ordinal/frame 必须连续，
   tool-call pairing 必须完整。

### 5.5 Recall 不变量

1. active surface 的 contract version 必须等于 current version（I3 阶段即
   `recall-retirement-v1`）。
2. active tool definitions 中恰好存在一个内建 `Recall`。
3. Recall reader 仍使用 canonical `messages` / FTS，不读取 compiled entries。
4. `ctx://message/<message-id>` 在退休前后返回相同 content 和 hash。
5. Recall 自身的 tool observation 继续不进入 FTS，避免历史检索自我放大。

### 5.6 失败不变量

1. COMMIT 前任一失败：旧 revision、旧 measurement 和旧 active payload 保持有效。
2. transaction 中任一失败：不得留下 orphan revision 或错误 active switch。
3. COMMIT 后 activation/event 失败：新 revision 保持 durable active，measurement 可以为空，
   下次 activation 从 full estimate 恢复。
4. planner 无合法边界或必要工作集仍超预算时明确返回/报错，不静默截断。

## 六、schema v7

### 6.1 版本策略

`SESSION_SCHEMA_VERSION` 从 6 升到 7。打开 v6 或其他版本时返回
`SESSION_SCHEMA_UNSUPPORTED`；不实现 migration、dual-read 或自动复制。

这样可以一次性收紧以下语义：

- revision kind 与 `keep_from_ordinal`；
- active override count/manifest；
- Recall contract version；
- revision-chain triggers；
- decoder 和 schema fingerprint。

### 6.2 `context_surfaces`

新增：

```sql
recall_contract_version TEXT NOT NULL
  CHECK (length(recall_contract_version) BETWEEN 1 AND 64)
```

它参与 `surface_sha256`。新 surface 的创建路径必须从同一个 runtime contract renderer 同时
取得 current version 和 system prompt，不能通过 `includes()` 从任意 prompt 反推版本。历史
surface 的 decoder 不用当前 renderer 重放旧 prompt；它验证 stored prompt/hash、surface hash
和 supported version，避免同版本文案微调后误判 immutable 历史 surface。SQL 只保证字段存在
且有界；未知版本在 surface decoder/validator 处 fast-fail。

不把 `'recall-retirement-v1'` 焊进 SQL CHECK。ContextSurface 是 immutable revision history，
未来 contract v2 出现后，loader 仍需解释旧 revision 引用的 v1 surface；因此代码必须区分
“新 surface 使用的当前版本”和“仍可读取的历史版本”，而不是用 schema bump 删除旧版本。

`Recall` tool definition 仍保存在 `tool_definitions_json`；退休 planner 和 transaction readback
都必须验证它存在且 tool schema hash 与 prepared request 一致。

### 6.3 `context_revisions`

允许的 kind：

```text
initial_full
swap_only
surface_refresh
prefix_retirement
```

关键字段语义：

```ts
type StoredContextRevisionV7 = {
  revisionId: ContextRevisionId;
  sessionId: SessionId;
  revisionNumber: number;
  parentRevisionId: ContextRevisionId | null;
  kind: "initial_full" | "swap_only" | "surface_refresh" | "prefix_retirement";
  surfaceId: ContextSurfaceId;
  surfaceSha256: string;
  keepFromOrdinal: number;
  sourceThroughOrdinal: number;
  addedOverrideCount: number;
  activeOverrideCount: number;
  activeOverrideManifestSha256: string;
  canonicalSequenceSha256: string;
  renderedMessageSha256: string;
  createdAt: string;
};
```

`prefix_retirement` 额外保存：

```ts
type StoredPrefixRetirementRevisionV7 = StoredContextRevisionV7 & {
  kind: "prefix_retirement";
  policyVersion: "recall-first-retirement-v1";
  planSha256: string;
  retiredThroughOrdinal: number;
  retiredTurnCount: number;
  retiredFrameCount: number;
  retiredMessageCount: number;
};
```

其中：

```text
retiredThroughOrdinal = keepFromOrdinal - 1
```

ordinal 1 的 system surface 始终 active，不计入退休数量。`retired*Count` 表示相对 parent
revision 在 `[max(parent.keepFromOrdinal, 2), keepFromOrdinal - 1]` 中本次新增退休的数量，
不是从 session 开始的累计数。这些计数只用于审计和有界事件，真正边界仍由
parent/current `keepFromOrdinal` 验证。

### 6.4 kind 约束

| kind | keepFromOrdinal | surface | added overrides | active overrides |
| --- | --- | --- | --- | --- |
| `initial_full` | 1 | 初始 surface | 0 | 0 |
| `swap_only` | 等于 parent | 等于 parent | >= 1 | parent active + added |
| `surface_refresh` | 等于 parent | 新 surface | 0 | 等于 parent active |
| `prefix_retirement` | 大于 parent | 等于 parent | 0 | parent active 中 ordinal >= 新边界的子集 |

`sourceThroughOrdinal` 对三个后继 kind 都必须等于 transaction snapshot 中 canonical 最大
ordinal，并位于 closed frame 边界。

### 6.5 override 的存储与 active 派生

全部 stored overrides 的读取条件保持：

```text
introduced revision number <= target revision number
```

某个 target revision 的 active overrides 增加第二个条件：

```text
override.ordinal >= target.keepFromOrdinal
```

当 `keepFromOrdinal = 1` 时，这与 I2 行为逐字节一致。退休后，旧 override row 继续参与历史
revision 的完整性验证，但不进入新 revision 的 active manifest 和 compiler。

禁止物理删除退休 override，也不增加 `retired` mutable flag。是否 active 必须能从 immutable
revision chain 和 ordinal 纯派生。

### 6.6 trigger 约束

`context_revisions_validate_insert` 增加 `prefix_retirement` 分支，验证：

- parent 是当前 active revision，revision number 恰好 +1；
- surface identity 与 parent 相同；
- 新边界大于 parent，且存在对应 user message；
- user message 的 frame closed，所属 turn 已结束；
- 边界前一 ordinal 是另一个已结束 turn 的最后 closed frame；
- `sourceThroughOrdinal` 等于 canonical tail；
- added override 为 0；
- active count 等于 `ordinal >= NEW.keep_from_ordinal` 的已引入 stored overrides 数量。

SQLite trigger 不负责计算 `active_override_manifest_sha256`。当前数据库没有 SHA-256 SQL
function，且以 `trusted_schema = OFF` 运行；retirement manifest 是 parent override 的过滤子集，
不能像 v6 `surface_refresh` 那样只与 parent hash 做等值比较。manifest 的完整性由
`commitPrefixRetirementRevision()` 在 transaction 内 readback、用 TypeScript 现有稳定 hash
函数复算并比较，随后由 full-chain loader/decoder 再验一次。

`context_overrides_validate_insert` 同步增加：

```sql
NEW.ordinal >= cr.keep_from_ordinal
AND NEW.ordinal <= cr.source_through_ordinal
```

这样 retirement 后的 `swap_only` 即使绕过 planner，也不能向已退休 prefix 插入 override；
原有 closed tool frame、tool result、source/hash 和 byte-savings 检查全部保留。

`session_meta_monotonic_update` 允许 active 前进到 `prefix_retirement`，并验证上述 parent/child
关系、measurement 已清除、无新增 override 和可由 SQL 复核的 active count。active manifest
仍由同一 transaction 的 readback 与 full-chain validation 负责。

## 七、Recall 常驻契约

### 7.1 版本化常量

新增当前版本和历史支持集合：

```ts
export const CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION =
  "recall-retirement-v1" as const;

export const SUPPORTED_RECALL_RETIREMENT_CONTRACT_VERSIONS = [
  CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
] as const;
```

其英文模型指令表达以下稳定语义：

```text
Older session content may be intentionally absent from the active context.
Absence does not mean it never happened or does not exist. Before asserting
that no prior decision, constraint, evidence, failure, or work exists, or before
repeating work that may have happened earlier, use Recall search and then Recall
get for the relevant sources. Recall is historical session state; use Read/Grep
and task tools to verify current workspace and process state.
```

最终代码中的字符串应由一个 renderer 生成并进入 `RUNTIME_INSTRUCTIONS`，测试固定完整文本和
版本，不在多个文件复制。

### 7.2 与 ContextSurface 的关系

- 新 session 创建时，初始 surface 保存当前 contract version。
- `/resume` 仍按现有 surface refresh 规则加载当前 runtime instructions 和工具面。
- schema v7 不存在没有 contract version 的合法 surface。
- 新建或 surface refresh 后的新 surface 必须使用 current version；revision chain 中的历史
  surface 可以使用 supported allowlist 内的旧版本，未知版本 fast-fail。
- retirement planner 只接受 active surface 的 version、system prompt、Recall definition 和
  prepared tool schema 全部一致的 snapshot。

如果只调整 contract 文案但语义版本仍为 v1，system prompt/surface hash 会变化，现有
`surface_refresh` 会记录新 surface；I4 还会重新匹配当前 contract 文本和 Recall definition hash，
无需升级 session schema。只有 contract 语义或 renderer contract 发生不兼容变化时才发布 v2；
发布时把 v2 设为 current，同时继续保留 v1 decoder，直到没有受支持 revision 再引用它。

### 7.3 安全边界

Recall 返回的历史 tool/web/MCP 正文仍是非可信历史数据，不能提升为 system instruction。
contract 只要求先检索历史事实，不改变现有指令优先级，也不让历史内容覆盖当前 AGENTS.md、
当前文件或当前任务状态。

## 八、合法退休边界

### 8.1 turn 是最小退休单位

I3 不以 message 或单个 frame 为退休单位。planner 从 SessionStore 读取每个 turn 的稳定边界：

```ts
type ClosedTurnBoundary = {
  turnId: TurnId;
  turnNumber: number;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  firstOrdinal: number; // user message ordinal
  lastOrdinal: number;  // turn 最后 closed frame ordinal
  frameCount: number;
  messageCount: number;
};
```

每个 boundary 必须通过数据库记录与 canonical frames 双重校验：

- `firstOrdinal` 对应 closed user frame；
- turn 的全部 frames 连续覆盖 `[firstOrdinal, lastOrdinal]`；
- 不与相邻 turn 重叠或留 gap；
- tool exchange 已完整 closed；
- turn status 不是 open。

failed/cancelled/interrupted turn 只要协议已补齐并结束，也可以作为完整退休单位。它们仍由
Recall 精确取回，不因失败状态永久占据 active context。

### 8.2 retained suffix

`recall-first-retirement-v1` 固定：

```ts
const protectedRecentTurnCount = 8;
const targetInputRatio = 0.3;
```

最近 8 个完整已结束 turns 全量保留。由于 retirement 只在完全 idle 的 session 执行，不存在
另一个 active turn 需要额外拼接。若 session 不足 9 个可见完整 turns，则没有合法退休边界。

“最近 8 turns”按 `turn_number` 计算，不按 frame 数、message 数、字节或时间戳计算。

### 8.3 已退休 session 的再次退休

planner 只考虑当前 `keepFromOrdinal` 之后仍 active 的 turns。新的边界必须大于旧边界，并继续
保护 active suffix 中最近 8 个完整 turns。已经退休的 turns 不重复计数，也不会重新进入
candidate request。

### 8.4 单个必要工作集过大

如果 system surface、tool schemas 和必须保留的 8-turn suffix 本身仍超过 target，planner 可以
选择最大合法退休边界并返回 `retirement_floor`，但新视图必须严格小于旧视图。若它仍超过 hard
input budget，后续模型请求由 preflight 明确拒绝并展示 token 分项；I3 不继续删除受保护 suffix，
也不静默缩短当前 goal。

## 九、PrefixRetirementPlanner

### 9.1 输入

```ts
type PrefixRetirementPlanningInput = {
  active: CompiledRevisionContext;
  revision: StoredContextRevisionV7;
  surface: StoredContextSurfaceV7;
  activeOverrides: readonly StoredSwapOverrideV7[];
  canonical: ProtocolContextView;
  closedTurns: readonly ClosedTurnBoundary[];
  activePrepared: PreparedModelRequest;
  activeUsage: ContextUsageSnapshot;
  tools: readonly ToolDefinition[];
  policy: RecallFirstRetirementPolicyV1;
  trigger: "manual" | "benchmark_forced";
  forcedTargetTokens?: number;
};
```

planner 是纯本地、无副作用组件。它可以调用 `model.prepare()` 生成候选 payload，但不得调用
`model.request()`，不得执行 Recall 或任何工具。

### 9.2 结果

```ts
type PrefixRetirementPlanningResult =
  | { outcome: "below_target"; plan?: never }
  | { outcome: "no_complete_prefix"; plan?: never }
  | { outcome: "target_reached"; plan: PrefixRetirementPlan }
  | { outcome: "retirement_floor"; plan: PrefixRetirementPlan };
```

`below_target` 和 `no_complete_prefix` 不创建 revision。`target_reached` 与
`retirement_floor` 只有在 candidate raw/guarded tokens 都严格下降时才可提交。

### 9.3 选择算法

1. 验证 trigger、active revision、surface、Recall contract、tool schema 和 current snapshot。
2. 从 active turns 中排除最近 8 个，得到按 turn number 升序排列的合法 boundary。
3. target 使用当前 input budget 的 30%；benchmark-forced 可传更小 target，但必须是正安全整数。
4. 每个 candidate boundary 表示“退休它之前的全部 active turns，并从该 turn 开始保留”。
5. candidate 越向后，active messages 必须是前一个 candidate 的严格子集，raw/guarded estimate
   不得增加；违反单调性立即 fast-fail。
6. 使用边界上的确定性二分查找找到第一个 guarded tokens `<= target` 的 candidate，即退休最少
   历史、保留最多 active turns 的方案。
7. 如果最大合法 retirement 仍高于 target，选择最大边界并返回 `retirement_floor`。
8. 对最终 candidate 及相邻边界重新完整编译/prepare，验证选择最小、结果严格缩小且 plan hash
   稳定。

二分查找只减少 prospective prepare 次数，不改变最终完整验证。不得用近似字节比例直接提交。

### 9.4 plan 内容

```ts
type PrefixRetirementPlan = {
  policyVersion: "recall-first-retirement-v1";
  trigger: "manual" | "benchmark_forced";
  baseRevisionId: ContextRevisionId;
  baseRevisionNumber: number;
  baseKeepFromOrdinal: number;
  baseCanonicalThroughOrdinal: number;
  baseSurfaceSha256: string;
  baseActiveOverrideManifestSha256: string;
  basePreparedPrefixHash: string;
  nextKeepFromOrdinal: number;
  retiredThroughOrdinal: number;
  retiredTurnCount: number;
  retiredFrameCount: number;
  retiredMessageCount: number;
  nextActiveOverrideCount: number;
  nextActiveOverrideManifestSha256: string;
  canonicalSequenceSha256: string;
  renderedMessageSha256: string;
  rawTokensBefore: number;
  rawTokensAfter: number;
  guardedTokensBefore: number;
  guardedTokensAfter: number;
  targetTokens: number;
  projectedPrefixHash: string;
  planHash: string;
};
```

`planHash` 使用 stable JSON 覆盖上述全部语义字段，不包含时间戳、绝对路径、prompt 正文、query
或任何退休内容。

### 9.5 stale 检查

COMMIT 前必须重新读取并比较：

- active revision ID/number/keep boundary；
- canonical tail ordinal 与 canonical prefix hash；
- surface SHA；
- active override manifest；
- prepared request config/tool schema/prefix hash；
- session idle 状态。

任一变化返回明确 stale error，不重新解释旧 plan。

## 十、compiler 与 validator

### 10.1 编译规则

compiler 不截断 canonical snapshot；它从完整 canonical 生成 active entries：

```ts
const activeRecords =
  keepFromOrdinal === 1
    ? canonical.messages
    : [
        canonical.messages[0],
        ...canonical.messages.slice(keepFromOrdinal - 1),
      ];
```

`keepFromOrdinal === 1` 必须走原完整序列，不能把 ordinal 1 重复两次。实际实现不应先复制完整
数组再 filter，而应通过 ordinal index/slice 构造有界输出。ordinal 1 用 active surface 替换；
suffix 中只对 active override 应用 `swap-observation-v1`。

`CompiledContextEntry.representation` 继续为 `canonical | surface | swapped`。不增加
`retired` entry，因为退休内容根本不属于 compiled context。

### 10.2 manifest

```ts
type CompiledContextManifest = {
  canonicalFrameCount: number;
  canonicalMessageCount: number;
  activeFrameCount: number;
  activeMessageCount: number;
  keepFromOrdinal: number;
  canonicalSequenceHash: string;
  renderedMessageHash: string;
  surfaceSha256: string;
};
```

`canonicalSequenceHash` 仍覆盖完整 canonical snapshot；`renderedMessageHash` 只覆盖实际 active
entries。两个 hash 不能混为一个，否则退休后无法同时证明“原历史没变”和“模型请求确实省略
了前缀”。

### 10.3 active override

compiler/validator 只接收：

```text
introduced revision <= active revision
AND ordinal >= keepFromOrdinal
```

传入退休边界之前的 override 是调用方错误，validator fast-fail。缺少边界之后应当 active 的
override 同样 fast-fail。

### 10.4 validator 规则

`CompiledContextValidator` 不再要求 compiled count 等于 canonical count，而是验证：

- compiled ordinal 恰好是 `{1} U [keepFromOrdinal, tail]`；
- ordinal、message ID、frame ID 和 source hash 与 canonical 对应项一致；
- ordinal 1 是唯一 system entry，并使用 active surface；
- suffix 的第一个 entry 是合法 user boundary；
- suffix frame 全部完整，没有 tool-call 配对被切开；
- compiled active counts/hash 与 manifest 一致；
- active override 全部且只在 suffix 中消费；
- 从 canonical 中投影出的 active frames/messages/tool results 与 compiled entries 一致；
- system 后只允许一次到 `keepFromOrdinal` 的边界跳转，suffix 内 ordinal 和 frame range 严格
  连续，tool-call/tool-result 配对完整。

这里不调用现有 `ContextProtocolValidator.validate(activeView)`。它继续只验证完整 canonical，
因为其 `ordinal_gap`、system frame 和 frame coverage 规则有意从 ordinal 1 开始。active-view
协议规则属于 `CompiledContextValidator`；`ContextRevisionCompiler` 的顺序固定为先验证完整
canonical，再编译并验证 active projection。

### 10.5 prospective 编译

`compileProspective()` 增加可选的 `keepFromOrdinal`，默认继承 active boundary。调用者只能：

- swap：保持 boundary，增加 overrides；
- surface refresh：保持 boundary，更换 surface；
- retirement：增大 boundary，不增加 override，不更换 surface。

一次 prospective compile 同时改变两类状态必须拒绝，防止产生未设计的复合 revision。

## 十一、ContextBuilder、meter 与 prefix audit

### 11.1 ContextBuilder

`ContextBuilder` 继续以 compiled entries 作为唯一模型消息来源。candidate user prompt 只用于真实
turn 请求；手动退休发生在 idle 状态，不允许夹带 candidate prompt。

tools 来自 active `ContextSurface`，并且必须包含 Recall。退休不改变 tool definitions。

### 11.2 token 计量

- planner 比较同一 model、request config、tool schema 和 output reservation 下的 prepared
  payload。
- raw 与 guarded token 都必须严格下降。
- revision COMMIT 时删除 `context_measurement_state`。
- activation 后第一份 measurement 必须是 `estimated_full`。
- 后续 append-only 请求可以重新建立 measured anchor。

### 11.3 prompt prefix

prefix retirement 有意重写 provider prompt prefix，旧 cache anchor 不能沿用：

- COMMIT 前记录 active/candidate prefix fingerprint；
- plan 绑定 candidate prefix hash；
- COMMIT 后 `CommittedPrefixAuditor` 从新 revision 建立 anchor；
- 第一次 post-retirement provider request 允许 cache miss；
- 同一 retirement revision 内继续追加时必须恢复 append-only prefix 稳定性。

## 十二、事务设计

### 12.1 API

```ts
type CommitPrefixRetirementRevisionInput = {
  revisionId: ContextRevisionId;
  expectedBaseRevisionId: ContextRevisionId;
  expectedBaseRevisionNumber: number;
  expectedBaseKeepFromOrdinal: number;
  expectedCanonicalThroughOrdinal: number;
  expectedSurfaceSha256: string;
  expectedBaseActiveOverrideManifestSha256: string;
  policyVersion: "recall-first-retirement-v1";
  planHash: string;
  nextKeepFromOrdinal: number;
  retiredThroughOrdinal: number;
  retiredTurnCount: number;
  retiredFrameCount: number;
  retiredMessageCount: number;
  nextActiveOverrideCount: number;
  nextActiveOverrideManifestSha256: string;
  canonicalSequenceSha256: string;
  renderedMessageSha256: string;
};
```

### 12.2 transaction 顺序

```text
BEGIN IMMEDIATE
  -> load and validate current snapshot
  -> assert active revision/base keep/canonical tail/surface/manifest unchanged
  -> assert session fully idle
  -> rebuild closed-turn boundaries from SQLite
  -> compile current and prospective active views
  -> verify plan hashes/counts/token-independent invariants
  -> INSERT prefix_retirement revision
  -> read back filtered active overrides and manifest
  -> DELETE context_measurement_state
  -> compare-and-swap session_meta.active_revision_id
  -> reload full revision chain and compile new active snapshot
COMMIT
```

transaction 不插入、更新或删除 `context_overrides`、canonical records、tool results、FTS 或
surface。

其中 active override count 可以在 SQLite trigger 中复核；active override manifest 必须由
transaction readback 后的 TypeScript hash 复算。两者均通过后才能清 measurement 和切换 active
revision。

### 12.3 fault injection

至少覆盖：

```text
before_revision_insert
after_revision_insert
after_override_readback
after_measurement_delete
after_active_update
after_snapshot_readback
```

COMMIT 前任一 fault 必须回滚到旧 active revision 和旧 measurement。另做 COMMIT 后 activation
fault：新 revision 保持 active、measurement 为空，close/reopen 后恢复相同 payload。

### 12.4 revision chain 的后续行为

- retirement 后 `swap_only` 只能选择 ordinal >= active keep boundary 的新 observation。
- retirement 后 `surface_refresh` 继承同一 keep boundary 和 active override manifest。
- retirement 后继续追加 canonical history不会改变 boundary。
- 再次 retirement 只能进一步增大 boundary。
- 任何路径都不能让退休 prefix 重新进入 active request；需要原文只能通过 Recall。

## 十三、RuntimeSession 与命令语义

### 13.1 API 分离

保留：

```ts
compactContext(): Promise<ContextCompactionResult>;
```

新增：

```ts
retireContext(): Promise<ContextRetirementResult>;
```

二者由相同 session-operation serializer 串行，但调用不同 ContextManager 方法。不得用一个
宽泛 union 让调用者猜测实际提交了哪类 revision。

### 13.2 状态与并发

`retireContext()` 只在 RuntimeSession `ready` 且无 active turn/compaction/session switch 时
可用。进入现有 `compacting` 状态，完成后回到 `ready`；失败是否 fault session 继续依据
ContextManager 的 fatal/committed 语义。

`compacting` 是 RuntimeSession 内部互斥状态，不作为退休操作的用户文案。TUI 当前只暴露
`isSessionOperation` 来禁用输入；events 和 notice 必须使用 `retire_prefix` / “prefix retired”
区分退休。只有将来确有 UI 需要直接展示 RuntimeSession state 时，才另立状态命名改造；I3
不为内部同类互斥操作增加 `retiring` 状态。

禁止：

- turn executing/cancelling 时退休；
- 与 `/resume`、model switch、session delete、另一个 compact/retire 并发；
- 把 open background Bash task 当作阻塞条件。后台 task 可继续存在；其当前身份和状态的
  source of truth 是 `ShellTaskManager` 与 `TaskList`，不是旧 tool observation。retirement 不
  停止、重启或读取后台进程；历史 start/output 仍可 Recall，当前输出必须用 `TaskOutput`
  读取。一个长时间运行的 task 不保证其创建 turn 永远留在最近 8-turn suffix。

### 13.3 slash command

```text
/compact          # 仅 I2 swap-only
/compact retire   # 仅 I3 prefix retirement
```

其他参数 fast-fail：

```text
Usage: /compact [retire]
```

不增加 `--force`、自动 fallback、picker 或复杂 panel。benchmark-forced 只通过测试/脚本 API，
不暴露给普通 TUI 用户。

推荐人工顺序是先运行 `/compact`，再在仍高于 target 或需要消除线性历史地板时运行
`/compact retire`。先 swap retained suffix 中的大 observation，可能让 retirement 保留更多旧
turn。帮助文案和 `retirement_floor` notice 应提示这个顺序，但 `/compact retire` 不得隐式先
提交 swap revision。

### 13.4 结果

```ts
type ContextRetirementResult =
  | {
      status: "unchanged";
      outcome: "below_target" | "no_complete_prefix";
      revisionId: ContextRevisionId;
      revisionNumber: number;
      keepFromOrdinal: number;
      guardedTokensBefore: number;
      targetTokens: number;
      durationMs: number;
    }
  | {
      status: "retired";
      outcome: "target_reached" | "retirement_floor";
      previousRevisionId: ContextRevisionId;
      revisionId: ContextRevisionId;
      previousRevisionNumber: number;
      revisionNumber: number;
      previousKeepFromOrdinal: number;
      keepFromOrdinal: number;
      retiredTurnCount: number;
      retiredMessageCount: number;
      activeOverrideCount: number;
      guardedTokensBefore: number;
      guardedTokensAfter: number;
      targetTokens: number;
      planHash: string;
      planningDurationMs: number;
      validationDurationMs: number;
      transactionDurationMs: number;
      activationDurationMs: number;
      durationMs: number;
    };
```

notice 示例：

```text
Context prefix retired: revision 3 -> 4, 17 turns removed from the active
request, 86,073 -> 41,220 estimated tokens (-52.1%). Older history remains
available through Recall.
```

`retirement_floor` 必须明确 target 未达到；`no_complete_prefix` 必须说明最近完整 suffix 受
保护。notice 不展示 message ID、query、路径或历史正文。

## 十四、事件与可观测性

扩展 revision events：

```ts
type ContextRevisionStartedData =
  | ExistingKinds
  | {
      strategy: "retire_prefix";
      reason: "manual";
      policyVersion: "recall-first-retirement-v1";
      baseRevisionNumber: number;
    };
```

finished 记录：

- outcome；
- base/new revision number；
- old/new keep ordinal；
- retired turn/frame/message count；
- active override count before/after；
- raw/guarded tokens before/after 与 target；
- plan hash；
- duration 分项。

failed 记录：

- strategy/reason；
- stage：`snapshot | plan | validate | commit | activate`；
- bounded error code；
- committed boolean。

events/notices 禁止包含：prompt、历史正文、placeholder、Recall query、source ID、文件路径、URL、
command 或 provider response。详细异常只留在进程错误链和受控诊断，不进入模型上下文。

I3 不新增 retirement shadow event；benchmark-forced 结果由 benchmark 报告承载，生产 runtime
pressure 仍只产生 I1 swap shadow 事件。

## 十五、Recall 验证边界

### 15.1 I3 必须证明

对一条明确位于退休前缀中的 marker：

1. retirement 前 `Recall search` 命中 source；
2. retirement 后相同 search 仍命中相同 source；
3. `Recall get` 返回相同正文、字节分页和 content hash；
4. 继续追加 turns 后仍相同；
5. close/reopen 与 `/resume` 后仍相同；
6. compiled/provider payload 中不存在 marker、对应 frame、tool skeleton 或 placeholder。

同时使用一个显式告诉模型“请用 Recall 找回早期 marker”的 fake/real provider smoke，证明
search -> get 工具链在退休后可工作。

### 15.2 I3 不声称证明

I3 不以以下结果作为自动化资格：

- 模型在没有提示时是否意识到需要 Recall；
- 隐式早期约束能否稳定恢复；
- 词面改写后能否找到正确 source；
- 是否避免重复旧失败；
- Recall-only 与 full context 的端到端任务成功率差异。

这些是 I4 的主动 Recall benchmark。I3 即使全部通过，也不得打开 automatic retirement。

## 十六、测试方案

### 16.1 schema 与 decoder

- schema version/fingerprint 精确为 v7；v6 fast-fail。
- 四种 revision kind 的 SQL CHECK 和 decoder 正反例。
- contract version SQL 只验证非空/长度；surface decoder 接受 supported 历史版本、拒绝未知版本，
  新 surface 只使用 current version。
- 非 user boundary、倒退 boundary、跳 revision、错误 parent/surface/source tail 被拒绝。
- active override count/manifest 与 boundary 过滤一致。
- override trigger 拒绝 `ordinal < introduced revision.keepFromOrdinal` 的插入。
- retirement 不写 override；swap 不改变 keep；surface refresh 不改变 keep。
- active switch 只允许合法直接子 revision。

### 16.2 planner

- 不足 9 turns 返回 `no_complete_prefix`。
- 已低于 target 返回 `below_target`。
- 选择第一个达到 target 的最小退休边界。
- 最大边界仍不足时返回 `retirement_floor`。
- 最近 8 turns 永远完整保留。
- completed/failed/cancelled/interrupted 的完整 turns 可退休，open turn 不可退休。
- repeated retirement 单调前移。
- benchmark-forced target 校验与 plan hash 确定性。
- candidate token 非单调、Recall contract 缺失、tool schema 漂移、base stale 时 fast-fail。
- planner 的 model request/tool execution count 始终为 0。

### 16.3 compiler/validator

- `keep=1` 对 I2 active payload 保持 byte parity。
- retired payload 的 ordinals 恰好为 `{1} U [keep, tail]`。
- 退休区间内 canonical/swapped entries 全部缺席。
- suffix 中的 active overrides 正确渲染。
- system surface、tool-call pairing、hash 和 counts 正确。
- 在退休边界切开 user/tool frame、漏掉 suffix override、传入 retired override 均 fast-fail。
- `ContextProtocolValidator` 继续拒绝 canonical ordinal gap；`CompiledContextValidator` 单独接受
  唯一合法的 system-to-keep gap，并拒绝 suffix 内 gap。
- retirement 后 append、swap、surface refresh、再次 retirement 全部稳定。

### 16.4 transaction/fault matrix

- 六个 transaction fault point 全部回滚。
- stale revision/canonical/surface/manifest/idle 状态拒绝提交。
- readback 覆盖全 revision chain 和历史 override manifest。
- COMMIT 后 activation fault 保留新 active revision。
- close/reopen 恢复相同 compiled payload，measurement 从 full estimate 开始。

### 16.5 Recall 与 FTS

- retirement 前后 messages/tool_results/FTS row count 和逐项 hash 不变。
- search/get 对 retired user/assistant/tool messages 返回相同 source/content/hash。
- FTS integrity check 与 rebuild 不受 keep boundary 影响。
- Recall result 追加到 active suffix，不污染 FTS。

### 16.6 TUI/RuntimeSession

- `/compact` 仍只做 swap-only。
- `/compact retire` 只做 prefix retirement。
- 非法参数 fast-fail；executing/cancelling/session operation 中拒绝。
- success/no-op/floor/failure notice 有界且不泄露内容。
- required event failure 的 committed 边界正确。
- retirement 前后 active background task 的 `TaskList`/`TaskOutput` 身份和状态不变。
- 真实 PTY 中退休后可继续下一 turn、使用 Recall、再 `/compact`、再 `/quit`。

## 十七、benchmark 与外部验证

### 17.1 确定性长会话 benchmark

扩展 G0/I1/I2 的 50-turn workload，至少构造：

- 足够多的普通 user/assistant 文本和 tool-call 骨架；
- 已被 swap 的大 observation；
- 退休前缀中的唯一 marker；
- 最近 8 turns 中的保护 marker；
- 多次 retirement 与 retirement 后 append。

报告：

- boundary、retired turns/frames/messages；
- active overrides before/after；
- raw/guarded tokens before/after、target 和地板；
- planning/validation/transaction/activation latency；
- database/WAL 增量；
- request build p50/p95 与 RSS/heap；
- provider request/tool execution count；
- Recall search/get 一致性。

### 17.2 cache/protocol smoke

真实 provider smoke 至少验证：

1. `/compact retire` 自身产生 0 provider request；
2. post-retirement request 通过 provider 协议；
3. payload 不包含退休 marker；
4. 第一次 prefix rewrite 的 cache miss/hit 有实际 usage 记录；
5. 同 revision 继续追加后的 cache prefix 行为稳定；
6. Recall search -> get 后能继续完成 turn。

这些数据是回归事实，不是自动 retirement 资格。自动化资格仍由 I4 按 profile/snapshot、system
prompt hash 和 Recall tool schema hash 单独评估。

### 17.3 性能门槛

- planner 不随 candidate turn 数做线性次完整 prepare；正式实现使用确定性二分查找。
- transaction 不复制 canonical messages 或全部 overrides。
- retirement revision 的数据库增量为 O(1)，不随退休消息数量线性增长。
- active request 大小不再随已经退休的条目数增长。
- Recall 10,000-message benchmark 不得因 retirement revision 明显退化。

## 十八、实施顺序

### I3.1：Recall contract 与 schema v7 类型

- 增加版本化 contract renderer；
- 增加 current/supported contract version，更新 ContextSurface/schema fingerprint；
- 定义 v7 revision types 和 active override 语义；
- v6 fast-fail；
- 此小步仍不允许 `keepFromOrdinal > 1` 的生产提交。

### I3.2：retirement-aware compiler

- compiler 支持 `{1} U [keep, tail]`；
- 保持 `ContextProtocolValidator` 的完整 canonical 连续性，更新
  `CompiledContextValidator`、manifest/hash、ContextBuilder 的 active-view 规则；
- keep=1 parity 与纯 prospective tests；
- 仍无写 revision API。

### I3.3：PrefixRetirementPlanner

- closed-turn boundary reader；
- `recall-first-retirement-v1`；
- target/minimal boundary/retirement floor；
- deterministic plan hash、stale checks、零 provider/tool request tests。

### I3.4：SessionStore atomic commit

- `commitPrefixRetirementRevision()`；
- active override filtering；
- revision/session_meta count triggers、override keep-boundary trigger、transaction manifest
  readback、fault injection；
- retirement 后 swap/surface refresh/re-retirement；
- close/reopen exact resume。

### I3.5：ContextManager 与 RuntimeSession

- `retirePrefix()` / `retireContext()`；
- revision-aware meter/prefix activation；
- bounded events；
- committed/fatal failure semantics。

### I3.6：`/compact retire`

- slash parser/controller/App wiring；
- bounded success/no-op/floor/failure notice；
- 帮助文案说明先 `/compact`、后 `/compact retire` 的推荐顺序；
- component tests 和真实 PTY；
- 保持无参数 `/compact` 的 swap-only 行为。

### I3.7：门禁与路线图回写

- `bun run check`；
- 50-turn formal retirement benchmark；
- Recall benchmark；
- crash/fault matrix；
- 真实 provider cache/protocol/Recall smoke；
- 将实际 schema、token 收益、latency、DB 增量和失败结果写回本文与 roadmap；
- 全部门槛通过后才宣布 I3 完成并开始设计 I4 benchmark。

## 十九、验收门槛

I3 只有同时满足以下条件才算完成：

1. schema v7 是唯一支持格式；v6 明确 fast-fail，无 migration/dual-read。
2. `prefix_retirement` 是独立 immutable revision kind，revision chain 仍线性、连续、原子切换。
3. `keepFromOrdinal` 只在完整已结束 turn 边界单调前移，最近 8 turns 始终完整保留。
4. active ordinals 恰好为 `{1} U [keep, tail]`，退休区间无 message、tool skeleton 或
   placeholder 残留。
5. retirement 前后 canonical messages、frames、tool results 和 FTS 逐项不变。
6. retired history 的 Recall search/get 在 retirement、append、swap、surface refresh、再次
   retirement 和 resume 后返回相同 source/content/hash。
7. 退休 override 留在数据库审计链中，但不进入 active manifest；后续 swap 只作用于 suffix。
8. active surface 使用 current `recall-retirement-v1`；历史 surface version 必须在 supported
   allowlist 内，Recall tool/schema 缺失或漂移时 fast-fail。
9. manual/benchmark planner 不发 model request、不执行工具、不生成摘要或 checkpoint。
10. candidate raw/guarded tokens 都严格下降；选择达到 target 的最小退休前缀，或明确报告
    `retirement_floor`。
11. transaction 任一步失败保留旧 active revision 和旧 measurement，无 orphan row。
12. COMMIT 后故障/resume 恢复新 revision，measurement 从 full estimate 开始。
13. retirement 后同 revision append-only prefix audit 通过，首次 cache rewrite 有真实记录。
14. `/compact` 仍为 swap-only；`/compact retire` 只在 idle 状态显式退休，每次最多提交一个
    revision。
15. events/notices 不泄露正文、placeholder、source、path、URL、query、command 或 candidate ID。
16. 明确提示的退休历史问题能经 search -> get 恢复；不把该结果误当主动 Recall 自动化资格。
17. `bun run check`、formal benchmark、Recall benchmark、fault matrix、真实 PTY 和 provider
    smoke 全部通过。
18. 路线图写回真实结果后，才宣布 I3 完成。

任一门槛未满足，`keepFromOrdinal > 1` 不得进入生产提交路径，也不得增加 automatic
retirement flag。

## 二十、实施结果（2026-07-18）

I3 按本文边界交付时，automatic retirement 仍未启用：

- SessionStore 已一次性切换为 schema v7；v6 无 migration、dual-read 或 fallback，直接
  `SESSION_SCHEMA_UNSUPPORTED`。`prefix_retirement`、active override manifest、
  `recall_contract_version`、revision-chain trigger 和 decoder 由同一 schema fingerprint
  固定。
- compiler 的 active ordinals 现在严格为 `{1} U [keep, tail]`；planner 固定保护最近 8 个
  closed turns，以 30% input budget 为生产 target，并用确定性二分查找与相邻 boundary
  复验选择最小达标前缀。退休自身不调用 provider、不执行工具。
- `commitPrefixRetirementRevision()` 在单个 transaction 中校验 boundary、canonical hash、
  active override manifest、measurement 清除和 active CAS；六个 transaction fault point
  全部回滚，COMMIT 后 activation fault 保留新 revision 且 measurement 为空。
- `RuntimeSession.retireContext()`、bounded revision events、`/compact retire`、TUI notice 和
  controller 串行化已接通；无参数 `/compact` 仍只走 swap-only。

50-turn deterministic formal benchmark 先提交两次 swap，再提交两次 retirement：

- revision 2/3 共新增 28 条 override；revision 4 将 `keepFromOrdinal` 从 1 前移到 170，
  退休 42 turns / 126 frames / 168 messages，并将 28 条历史 override 全部退出 active
  manifest、保留数据库审计行。
- 第一次 retirement 的 raw token 从 78,318 降到 32,472，guarded token 从 86,150 降到
  35,720；planning/validation/transaction/activation/total 为
  37.80/21.38/39.20/1.68/100.09ms，database + WAL 增加 32,960 bytes。
- cancellation append 后 revision 5 再退休 1 turn / 3 frames / 4 messages，keep 170 -> 174；
  guarded token 35,746 -> 30,853，database + WAL 再增加 32,960 bytes。
- provider request 保持精确的 104 次；retirement 两次均为零 provider request。最终数据库有
  52 turns、208 messages、156 frames、5 revisions、28 条历史 override 和 0 条 active
  override；resume、取消、退休 payload marker 缺席及 Recall search/get 均通过。
- request build p50/p95 为 2.44/12.40ms；本轮观测 RSS/heap 增量为
  242,106,368/63,061,314 bytes，仅作为回归事实，不作为稳定 SLA。

外部验证结果：

- 10,000-message Recall benchmark 在 schema v7 上的 trigram p50/p95 为 0.24/0.27ms，
  dense trigram p95 为 11.27ms，单 code-point substring p95 为 9.92ms；FTS verify/rebuild、
  精确 get 和 reopen 全部通过。
- `deepseek-v4-flash` 真实 provider smoke 中，retirement 前后 provider request count 保持
  1 -> 1；首个 post-retirement payload 不含退休 marker。pre-retirement、第一次 rewrite、
  同 revision append 的 cache hit/miss 分别为 0/3,322、0/3,267、3,200/91 tokens；随后
  真实模型各执行一次 Recall search/get 并恢复 marker。该可复跑入口为
  `bun run bench:i3-provider-smoke -- deepseek-v4-flash`。
- 真实 TUI PTY 中 `/compact retire` 将 10,103 降到 4,105 estimated tokens（下降 59.4%），
  revision 1 -> 2；随后通过直接 `/resume <UUID>` 恢复同一退休 revision，Recall
  search -> get 取回 9,020-byte 退休消息，继续 `/compact` 并正常 `/quit`。
- 最终 `bun run check` 通过 512 项测试、3,350 个断言，并包含 schema/type/lint/format、
  fault matrix、TUI component 和 I3 deterministic benchmark smoke。

这些结果只证明 deterministic retirement、精确 Recall 和显式 search -> get；不构成模型主动
Recall 或 automatic revision commit 的资格，后者仍属于 I4。

## 二十一、交给 I4 的明确输出

I3 完成后，I4 可以依赖：

```text
Cold prefix retirement is deterministic, manual, atomic, and resumable
Canonical history and Recall remain exact across retirement revisions
Retired frames and placeholders are absent from the provider payload
The active token floor is bounded by system/tools plus a fixed recent suffix
Explicit Recall search -> get works after retirement
Automatic revision commit is still disabled
```

后续 I4 已负责并完成：

- full-history、swap-only、Recall-only retirement 的主动 Recall 对照评测；
- 隐式历史依赖、措辞改写、旧失败防重复和历史/当前版本区分；
- 以 DeepSeek capability floor 绑定冻结 suite/policy/report 与 Recall contract/definition hash；
- 决定 automatic swap-only 和 automatic prefix retirement 是否分别放行；
- 未达门槛时保持手动路径，并判断是否有证据进入 I5 checkpoint 设计。

I4 没有因为 I3 的结构和显式 Recall smoke 通过就默认放行，而是在独立 holdout 达到 29/30
Recall-only task success 后才启用 automatic retirement。

## 二十二、最终设计决策

1. **I3 一次性切换 schema v7；不迁移、不兼容读取 v6 session。**
2. **冷退休使用独立 `prefix_retirement` revision，不与 swap 或 surface refresh 复合提交。**
3. **active view 永远是当前 system surface 加一个完整 canonical suffix；退休区间不保留逐条
   placeholder。**
4. **`keepFromOrdinal` 只能指向保留 turn 的 user message，并跨 revision 单调前移。**
5. **stored override 永不删除；active override 由 revision number 与 keep boundary 纯派生。**
6. **`recall-first-retirement-v1` 固定保护最近 8 turns，以 30% input budget 为 target，选择
   达标所需的最小退休前缀。**
7. **无参数 `/compact` 保持 swap-only；只有显式 `/compact retire` 才执行冷退休。**
8. **I3 retirement 自身零模型调用、零工具执行、零摘要、零 checkpoint。**
9. **COMMIT 是不可逆语义边界；之前失败保留旧视图，之后失败保留新 durable revision。**
10. **I3 只证明结构正确、精确 Recall 和显式 search -> get；主动 Recall 与自动化资格属于
    I4。**
11. **`ContextProtocolValidator` 保持严格 canonical 连续性；退休 gap 只由
    `CompiledContextValidator` 的 active-view 模式接受。**
12. **Recall contract 的 current/supported 版本由代码校验，不把具体版本焊进 SQL CHECK；prompt
    hash 变化仍会使 I4 自动化资格失效。**
