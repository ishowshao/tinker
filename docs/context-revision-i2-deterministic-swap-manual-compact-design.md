# I2：温层确定性换出与手动 `/compact` 技术方案

## 文档状态

- 日期：2026-07-17
- 状态：设计稿，尚未实施
- 前置阶段：
  [`context-revision-i1-shadow-planning-design.md`](context-revision-i1-shadow-planning-design.md)
- 对应路线图：[`agent-runtime-roadmap.md`](agent-runtime-roadmap.md) 的 I2
- 当前实现基线：SessionStore schema v4、`initial_full` 唯一活动 revision、I1 shadow
  planner
- 本阶段目标 schema：SessionStore schema v5
- 后继阶段：I3 Recall-first 冷前缀退休

## 一、结论

I2 只把 I1 已经证明合法、确定且能严格缩小请求的 swap plan，升级成一个可持久化、可
恢复、可原子切换的活动 Context Revision，并在 TUI 暴露空闲态手动 `/compact`。

本阶段采用以下方案：

1. SessionStore 一次性切换到 **schema v5**；不迁移、不兼容读取 v4 session。
2. `context_revisions` 从单行 `initial_full` 扩展为不可变、线性、单调递增的 revision 链。
3. 新增不可变 `context_overrides`；每条 tool observation 的 placeholder 只在首次换出它的
   revision 中保存一次，后继 revision 继承已有 override，不重复复制完整 override 集合。
4. I2 的所有 revision 仍固定 `keep_from_ordinal = 1`；活动视图继续保留全部 frame，只把
   被选中的 tool message `content` 替换为 I1 已冻结的 `swap-observation-v1`。
5. `ContextManager.compact()` 是唯一活动换出入口；`/compact` 调用它，未来自动路径也必须
   调用同一个入口。
6. planner、compiler 和 `ModelClient.prepare()` 先在事务外构造并验证完整候选视图；
   SessionStore 再在一个 `BEGIN IMMEDIATE` transaction 中写 revision、写新增 overrides、
   清除旧 measured anchor，最后更新 `active_revision_id`。
7. transaction 任一步失败都回滚，旧 revision 继续活动；COMMIT 成功后不做补偿性
   “切回旧 revision”。
8. revision 切换后，ContextMeter 丢弃旧 provider anchor，下一次 usage 必须从
   `estimated_full` 重新开始；CommittedPrefixAuditor 以新 revision 建立新前缀 anchor。
9. `/compact` 不调用模型、不生成摘要、不执行工具；原始 message、tool result 和 Recall
   索引完全不变。
10. `target_reached` 和“候选耗尽但仍严格缩小”的 `insufficient_candidates` 都可以提交；
    below-target、无候选或没有新增候选时不创建空 revision。

I2 不是“自动 compaction”。运行时 pressure path 仍只允许 shadow planning；只有用户在
session 没有 active turn 时显式执行 `/compact`，才允许切换活动 revision。

## 二、I1 交付基线与当前缺口

### 2.1 I1 已经冻结的契约

I2 直接依赖以下已实施事实，不重新设计：

- `ContextRevisionCompiler` 是 canonical history 到模型输入的唯一渲染路径。
- `CompiledContextEntry` 与 canonical record 是不同类型；placeholder 不能冒充原始事实。
- active `initial_full` 编译与 I1 之前的 provider payload、prompt segments 逐字节一致。
- closed frame、candidate eligibility、排序、renderer 和 plan hash 都是确定的。
- `swap-observation-v1` 只从已验证 `ToolRawResult` 的 allowlisted metadata 机械生成。
- 每个 placeholder 都包含 `ctx://message/<message-id>` 和 canonical content SHA-256。
- prospective view 保留 frame/message/tool-call 骨架并严格减少 raw、guarded token。
- `assertPlanBaseCurrent()` 能发现 revision、canonical tail、request config、tool schema 或
  prompt prefix 漂移。
- shadow plan 不调用 `ModelClient.request()`，也不修改 ContextMeter。
- Recall 从 canonical SessionStore 取原文，不从活动 placeholder 或 event log 反推历史。

I1 正式基准中，3 条 observation 从 42,762 bytes 降到 1,665 bytes，完整请求 raw/guarded
token 都下降 28.2%。这个结果证明 I2 有明确收益，但不证明自动换出已经安全。

### 2.2 当前代码不能直接提交 shadow plan

| 当前实现 | I2 缺口 |
| --- | --- |
| `StoredInitialContextRevisionV4` 只表达 revision 1 | 需要能表达 `initial_full` 和后续 `swap_only` |
| `context_revisions` CHECK 强制只有 revision 1 | 需要不可变线性 revision 链和 parent 关系 |
| `session_meta_monotonic_update` 禁止 active ID 变化 | 需要只允许从当前 revision 原子前进到直接子 revision |
| 没有 `context_overrides` | 需要保存 byte-stable placeholder 和 canonical 身份 |
| `compileActive()` 总是传空 overrides | 需要加载并验证当前 revision 继承的 active overrides |
| `compileProspective()` 从 canonical 加本次 selected | 需要保留已换出项，再叠加本次新增项，不能把旧项换回原文 |
| `ShadowSwapPlanner` 会重新扫描 canonical 全部 tool message | 需要排除当前 active revision 已换出的 message |
| `ContextMeter.invalidate()` 的 revision 语义未落地 | 需要清除旧 measured anchor，并明确 calibration 是否保留 |
| `RuntimeSession` 没有 compact 状态/API | 需要防止 compact 与 turn/session operation 并发 |
| TUI 没有 `/compact` | 需要命令解析、串行调用和有界结果提示 |

### 2.3 为什么不能直接复用最近一次 shadow event

`context.shadow.planned` 只保存聚合数值和 `planHash`，不保存 selected message IDs、
placeholder 或完整 base。它是 diagnostic event，不是可提交命令，也不是恢复来源。

`/compact` 每次都必须从当前 SessionStore snapshot 重新规划。即使刚刚因为超预算产生过
shadow plan，也不能从 `events.jsonl` 恢复或提交它。

## 三、目标与非目标

### 3.1 I2 目标

1. 建立 schema v5 的多 revision 与 immutable override 数据契约。
2. 让 active compiler 能从任意合法 v5 `initial_full` / `swap_only` revision 恢复相同视图。
3. 让 planner 在已有 swapped entries 之上只选择新增候选。
4. 在一个 SQLite transaction 中完整提交 swap revision 并切换 active ID。
5. 明确 transaction、进程崩溃、event sink 失败和 resume 的结果状态。
6. 建立 RuntimeSession 所有的 `ContextManager` 和 `compacting` 生命周期。
7. 实现空闲态 `/compact`，包括 no-op、成功和失败提示。
8. revision 切换后正确失效 provider measurement/prefix anchor。
9. 证明 compact 前后 canonical history、Recall、tool protocol 和 side effect 次数不变。
10. 用 I1/G0 workload 验证真实 token 降幅、数据库增量、恢复和 cache 行为。

### 3.2 I2 明确不做

- 自动提交 runtime pressure 产生的 plan；
- `keepFromOrdinal > 1` 或任何冷前缀退休；
- checkpoint、summary、capsule 或其他模型生成内容；
- 模型辅助候选选择、probe 或 joint audit；
- 修改 I1 candidate allowlist、8 KiB 阈值、最近 8 turns 保护区；
- 换出 user、assistant、system、Write/Edit、Recall 或 synthetic tool message；
- 删除 canonical message、tool result、FTS row、旧 revision 或旧 override；
- 把 Recall 原文写回旧 ordinal；Recall 仍只在尾部 page-in；
- `/compact --force`、按 message 指定换出或用户可编辑 policy；
- revision rollback、branch、export/import 或 v4 -> v5 migration；
- one-shot CLI 的新子命令；I2 只提供 TUI slash command 和内部 RuntimeSession API；
- 把 token 下降解释成 runtime RSS 必然下降；I2 仍会读取完整 canonical history。

## 四、核心不变量

I2 的 schema、代码和测试必须共同守住：

```text
Canonical messages and tool results remain immutable
Recall and FTS continue to read canonical content only
Every durable revision belongs to one linear chain
The active revision is always the latest committed revision
I2 keepFromOrdinal is always 1
Only closed-frame tool message content may be represented as swapped
An override is introduced once and inherited monotonically
An active revision never silently loses a previously active override
Stored placeholder bytes are deterministic and validated against canonical raw data
Every committed candidate is protocol-valid and strictly smaller than its base request
No model request or tool execution occurs during compact
The measured anchor always belongs to the active revision or is absent
A failed transaction leaves the old active revision unchanged
A committed revision is the source of truth even if later event or UI reporting fails
No active compiler fallback to full canonical history is allowed
Diagnostic events never contain observation bodies, placeholders, paths, URLs, queries, or commands
```

这里的“strictly smaller”同时要求：

```text
rawTokensAfter < rawTokensBefore
guardedTokensAfter < guardedTokensBefore
addedOverrideCount > 0
```

只减少 byte、但完整 prepared request token 不下降的计划不能提交。

## 五、schema v5

### 5.1 一次性 schema cutover

I2 将：

```ts
SESSION_SCHEMA_VERSION = 5;
```

并生成新的完整 schema fingerprint。v5 继续使用当前 `application_id`、WAL、
`synchronous=FULL`、single-writer lease、`quick_check`、foreign-key check 和 Recall FTS
integrity check。

本阶段不提供 migration：

- v4 database 由 `verifySessionSchema()` 返回 `SESSION_SCHEMA_UNSUPPORTED`；
- `SessionCatalog` 将它显示为 unavailable，而不是尝试部分读取；
- 不保留 v4/v5 dual-read、dual-write 或 runtime fallback；
- 开发和 benchmark fixture 直接创建新的 v5 session。

如果未来确实要保留某个 v4 本地 session，应另做离线、一次性、显式验证的导入工具；它
不进入 I2 runtime。

### 5.2 `context_revisions`

相关表建议固定为以下语义；DDL 是实施契约，字段名可在落地时按现有 SQL 风格微调，但
不能削弱约束：

```sql
CREATE TABLE context_revisions (
  revision_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  parent_revision_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('initial_full', 'swap_only')),
  keep_from_ordinal INTEGER NOT NULL CHECK (keep_from_ordinal = 1),
  source_through_ordinal INTEGER NOT NULL CHECK (source_through_ordinal >= 1),
  added_override_count INTEGER NOT NULL CHECK (added_override_count >= 0),
  total_override_count INTEGER NOT NULL CHECK (total_override_count >= 0),
  override_manifest_sha256 TEXT NOT NULL CHECK (length(override_manifest_sha256) = 64),
  canonical_sequence_sha256 TEXT NOT NULL CHECK (length(canonical_sequence_sha256) = 64),
  rendered_message_sha256 TEXT NOT NULL CHECK (length(rendered_message_sha256) = 64),
  policy_version TEXT,
  renderer_format TEXT,
  plan_sha256 TEXT CHECK (plan_sha256 IS NULL OR length(plan_sha256) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (session_id, revision_number),
  FOREIGN KEY (session_id) REFERENCES session_meta(session_id),
  FOREIGN KEY (parent_revision_id) REFERENCES context_revisions(revision_id),
  CHECK (
    (kind = 'initial_full' AND revision_number = 1 AND parent_revision_id IS NULL AND
      source_through_ordinal = 1 AND added_override_count = 0 AND
      total_override_count = 0 AND policy_version IS NULL AND
      renderer_format IS NULL AND plan_sha256 IS NULL) OR
    (kind = 'swap_only' AND revision_number >= 2 AND parent_revision_id IS NOT NULL AND
      added_override_count >= 1 AND total_override_count >= added_override_count AND
      policy_version = 'swap-only-v1' AND
      renderer_format = 'swap-observation-v1' AND plan_sha256 IS NOT NULL)
  )
) STRICT;
```

字段语义：

- `parent_revision_id`：只能指向同 session、前一个 revision number；I2 不允许 branch。
- `source_through_ordinal`：创建 revision 时冻结的 canonical tail。后续新 message 可以继续
  追加，但不能改变该边界之前的 canonical prefix。
- `added_override_count`：本 revision 首次引入的 override 数量。
- `total_override_count`：从 revision 1 到当前 revision 累计生效的 override 数量。
- `override_manifest_sha256`：全部累计 active overrides 的稳定 manifest hash。
- `canonical_sequence_sha256`：创建边界 `1..sourceThroughOrdinal` 的 canonical sequence hash。
- `rendered_message_sha256`：同一边界应用累计 overrides 后的 rendered message hash。
- `policy_version`：活动候选策略身份；I2 只有 `swap-only-v1`。
- `renderer_format`：placeholder byte contract；I2 只有 I1 的
  `swap-observation-v1`。
- `plan_sha256`：I2 plan identity；用于审计计划与 durable revision 的一一对应。

token before/after、duration 和 exclusion counts 不属于恢复活动视图所需事实，不写进
`context_revisions`，只进入有界 diagnostic event。

### 5.3 `context_overrides`

I2 不为每个 revision 复制完整 override 集合。每条 canonical tool message 最多有一条
durable override，并记录它由哪个 revision 首次引入：

```sql
CREATE TABLE context_overrides (
  introduced_revision_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  frame_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  representation TEXT NOT NULL CHECK (representation = 'swapped'),
  renderer_format TEXT NOT NULL CHECK (renderer_format = 'swap-observation-v1'),
  source TEXT NOT NULL,
  original_content_sha256 TEXT NOT NULL CHECK (length(original_content_sha256) = 64),
  rendered_content TEXT NOT NULL CHECK (length(rendered_content) > 0),
  rendered_content_sha256 TEXT NOT NULL CHECK (length(rendered_content_sha256) = 64),
  original_bytes INTEGER NOT NULL CHECK (original_bytes > 0),
  rendered_bytes INTEGER NOT NULL CHECK (rendered_bytes > 0),
  byte_savings INTEGER NOT NULL CHECK (byte_savings > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (introduced_revision_id, message_id),
  UNIQUE (session_id, message_id),
  UNIQUE (introduced_revision_id, ordinal),
  FOREIGN KEY (introduced_revision_id) REFERENCES context_revisions(revision_id),
  FOREIGN KEY (session_id) REFERENCES session_meta(session_id),
  FOREIGN KEY (message_id) REFERENCES messages(message_id),
  FOREIGN KEY (frame_id) REFERENCES protocol_frames(frame_id),
  CHECK (original_bytes = rendered_bytes + byte_savings)
) STRICT;
```

`UNIQUE (session_id, message_id)` 冻结 I2 的单调语义：一个 message 换出后不会在后续 revision
被重新渲染、覆盖或换回 canonical 表示。若未来需要新的 placeholder format，必须升级
schema 和显式设计替换语义，不能在 v5 原地改写。

建议索引：

```sql
CREATE INDEX idx_context_revisions_session_number
  ON context_revisions(session_id, revision_number);

CREATE INDEX idx_context_overrides_revision_ordinal
  ON context_overrides(introduced_revision_id, ordinal);
```

### 5.4 为什么使用“首次引入 + 线性继承”

假设 revision 2 换出 A、B，revision 3 再换出 C：

```text
revision 1: active overrides = []
revision 2: introduced = [A, B]   active = [A, B]
revision 3: introduced = [C]      active = [A, B, C]
```

编译 revision 3 时，SessionStore 读取 `revision_number <= 3` 的全部 introduced overrides。
这样同时保证：

- 不会因只应用本次 selected 而把 A、B 静默换回原文；
- 不会在每个 revision 中重复保存 A、B 的 placeholder；
- revision 仍可独立验证累计 count/manifest；
- I3 前移 `keepFromOrdinal` 时，只需忽略新边界之前的 inherited overrides，不需要重写它们。

v5 不支持 branch，所以不需要递归图解析。`revision_number`、parent 和 active-latest
不变量共同定义唯一线性祖先集合。

### 5.5 DB trigger 约束

除现有 immutable triggers 外，v5 至少需要以下数据库级保护。

#### Revision 与 override 不可变

```text
context_revisions: no UPDATE / no DELETE
context_overrides: no UPDATE / no DELETE
```

#### Override 插入检查

`context_overrides` 的 BEFORE INSERT trigger 必须拒绝：

- introduced revision 不是 `swap_only`；
- revision/session 不一致；
- canonical message 不存在、不是 tool role 或不属于相同 frame/ordinal；
- original hash 不等于 canonical `messages.content_sha256`；
- `source != 'ctx://message/' || message_id`；
- UTF-8 byte length 与 `original_bytes` / `rendered_bytes` 不一致；
- rendered bytes 不小于 original bytes。

SQLite 没有内置 SHA-256；`rendered_content_sha256`、manifest 和 renderer parity 由
SessionStore decoder/validator 复验，不能只依赖 SQL CHECK。

#### Active revision 只能前进一步

`session_meta_monotonic_update` 在允许 active ID 改变时，必须同时证明：

1. NEW revision 的 `parent_revision_id = OLD.active_revision_id`；
2. NEW revision number = OLD revision number + 1；
3. NEW revision 属于同一 session 且 kind = `swap_only`；
4. NEW `added_override_count` 等于本 revision 新插入的 override row count；
5. NEW `total_override_count = OLD.total_override_count + NEW.added_override_count`；
6. 切换时 `context_measurement_state` 已为空；
7. 除 `active_revision_id`、`updated_at` 和现有允许单调变化的字段外，meta 其他身份不变。

这个 trigger 不是 application validation 的替代品；它负责让误用 SQL 也不能跳 revision、
建立 branch 或带着旧 measurement 切换。

#### Measurement 必须绑定 active revision

v5 给 `context_measurement_state` 增加 INSERT/UPDATE trigger：

```text
NEW.revision_id == session_meta.active_revision_id
```

这样旧 revision 的 provider anchor 不能在切换后重新写回 singleton row。

### 5.6 Revision manifest

累计 override manifest 按 canonical ordinal 升序，对以下稳定 JSON 做 SHA-256：

```ts
type ActiveOverrideManifestEntry = {
  messageId: MessageId;
  frameId: ProtocolFrameId;
  ordinal: number;
  originalContentSha256: string;
  renderedContentSha256: string;
  rendererFormat: "swap-observation-v1";
};
```

manifest 不包含 `createdAt`、revision ID、SQLite rowid 或 rendered body。相同有效 override
集合必须得到相同 hash。

`canonical_sequence_sha256` 和 `rendered_message_sha256` 只覆盖 revision 创建时的
`1..sourceThroughOrdinal`。resume 时若 canonical 已追加到更大 ordinal：

- 先复验冻结 prefix 的两个 hash；
- 再把新增 canonical tail 以 canonical 表示追加到 active compiled view；
- 不能要求整个当前 history hash 仍等于旧 revision 的创建时 hash。

### 5.7 v5 完整性验证

`SessionStore.validateAll()` 和 `loadContextSnapshot()` 必须验证：

1. revision 1 恰好是 `initial_full`，parent 为空、count 为 0、boundary 为 1；
2. revision number 从 1 连续到 active number，没有 gap、branch 或 inactive future row；
3. 每个 revision 的 parent 恰好是前一 revision；
4. `session_meta.active_revision_id` 指向最高 revision number；
5. active revision 的累计 override 数等于 `total_override_count`；
6. active override manifest hash 匹配；
7. 每个 override 指向 closed `tool_exchange` frame 中的 tool message；
8. canonical message、tool result、source、original hash 和 byte counts 匹配；
9. 用 `ContextSwapRenderer` 从 canonical raw result 重新渲染，必须与 stored rendered content
   逐字节相同；
10. active revision 的 frozen canonical/rendered prefix hash 匹配；
11. `keep_from_ordinal` 始终为 1；
12. measurement row 不存在，或只属于 active revision。

未知 kind、policy、renderer format 或任何 hash/count 漂移都在模型请求和工具副作用之前
fast-fail；不能 fallback 到 `initial_full`。

## 六、v5 类型边界

### 6.1 Stored revision

```ts
type StoredContextRevisionV5 =
  | {
      revisionId: ContextRevisionId;
      sessionId: SessionId;
      revisionNumber: 1;
      parentRevisionId: null;
      kind: "initial_full";
      keepFromOrdinal: 1;
      sourceThroughOrdinal: 1;
      addedOverrideCount: 0;
      totalOverrideCount: 0;
      overrideManifestSha256: string;
      canonicalSequenceSha256: string;
      renderedMessageSha256: string;
      createdAt: string;
    }
  | {
      revisionId: ContextRevisionId;
      sessionId: SessionId;
      revisionNumber: number;
      parentRevisionId: ContextRevisionId;
      kind: "swap_only";
      keepFromOrdinal: 1;
      sourceThroughOrdinal: number;
      addedOverrideCount: number;
      totalOverrideCount: number;
      overrideManifestSha256: string;
      canonicalSequenceSha256: string;
      renderedMessageSha256: string;
      policyVersion: "swap-only-v1";
      rendererFormat: "swap-observation-v1";
      planSha256: string;
      createdAt: string;
    };
```

decoder 还必须检查 swap revision 的 number >= 2、added count >= 1、source boundary 在
canonical 当前 tail 以内。

### 6.2 Stored override

I1 的 `ProspectiveSwapOverride` 改名为不带 shadow 语义的 `SwapOverride`；durable decoder
返回相同核心结构，再补充 introduced revision：

```ts
type StoredSwapOverrideV5 = SwapOverride & {
  introducedRevisionId: ContextRevisionId;
  rendererFormat: "swap-observation-v1";
  createdAt: string;
};
```

`SwapOverride` 仍保存 rendered body，因为 active view 必须跨进程逐字节稳定；但每次加载
都要以 deterministic renderer 复验，不能把数据库中的任意文本直接信任为 tool content。

### 6.3 Context snapshot

```ts
type StoredContextSnapshotV5 = {
  meta: {
    sessionId: SessionId;
    activeRevisionId: ContextRevisionId;
  };
  revision: StoredContextRevisionV5;
  activeOverrides: readonly StoredSwapOverrideV5[];
  canonical: ProtocolContextView;
};
```

`activeOverrides` 已按 canonical ordinal 排序并包含从 revision 2 到 active revision 继承的
全部条目。compiler 不直接查询 SQLite，也不遍历 parent chain。

### 6.4 Compiled manifest

现有 `CompiledRevisionContext` 保留：

```ts
type CompiledRevisionContext = {
  sessionId: SessionId;
  revisionId: ContextRevisionId;
  canonicalThroughOrdinal: number; // 当前 canonical tail，不是创建 boundary
  entries: readonly CompiledContextEntry[];
  manifest: CompiledContextManifest;
};
```

为避免混淆，stored revision 使用 `sourceThroughOrdinal`，compiled result 使用
`canonicalThroughOrdinal`。前者是 revision provenance，后者是本次请求实际看到的 canonical
tail。

## 七、Active Compiler

### 7.1 唯一编译规则

`compileActive(snapshotV5)` 执行：

1. 完整验证 canonical protocol；
2. 验证 revision chain、active identity 和 active override manifest；
3. 创建 `messageId -> StoredSwapOverrideV5` map；
4. 按 canonical ordinal 遍历全部 messages；
5. 未命中 override 时 materialize canonical message；
6. 命中时只替换 tool message `content`，保留 role、frame ID、tool call ID、provider tool
   call ID、name 和 canonical source hash；
7. 为 revision 创建后新增的 canonical tail 保持 canonical 表示；
8. 生成并验证 compiled manifest；
9. 返回唯一可进入 `ContextBuilder` 的 compiled view。

I2 中所有 frame 都保留，message 数量、顺序和 ordinal 完全不变。

### 7.2 Active validation 不再等于“全部 canonical”

`CompiledContextValidator.validateActive()` 当前隐含 overrides 为空。I2 改为：

```ts
validateActive(
  compiled: CompiledRevisionContext,
  canonical: ProtocolContextView,
  activeOverrides: readonly SwapOverride[],
): void;
```

`initial_full` 传空集合；`swap_only` 传累计 active overrides。`validateProspective()` 也应
消费完整 candidate override 集合，而不是只消费本次新增项。

### 7.3 旧 revision 不会因新 tail 改写

revision 2 在 ordinal N 创建后，下一 turn 追加 N+1...M：

```text
1..N   -> 按 revision 2 的 active overrides 编译
N+1..M -> canonical 表示，按原顺序追加
```

同 revision 的 committed prefix audit 因而继续 append-only。只有 `/compact` 切换到
revision 3 时，旧前缀才允许重写一次，并由新的 revision ID 建立新 anchor。

### 7.4 不允许动态重渲染

compiler 使用 stored rendered content，不在请求时重新生成 placeholder。重新运行 renderer
只用于 load/validate parity；如果结果不同，说明 schema/code contract 漂移，必须
fast-fail，而不是悄悄采用“新格式”。

## 八、I2 Active Swap Policy

### 8.1 Policy 身份

I1 的审计 policy 提升为新的活动策略身份：

```ts
const swapOnlyPolicyV1 = {
  version: "swap-only-v1",
  minimumObservationBytes: 8 * 1_024,
  protectedRecentTurnCount: 8,
  targetInputRatio: 0.6,
} as const;
```

数值与 I1 保持一致，以便结果可比较；版本名改变是因为它现在具备提交权限。实现做一次性
重命名，不保留 `shadow-swap-v1` 的活动兼容别名。placeholder format 仍是已冻结的
`swap-observation-v1`。

### 8.2 手动触发不要求达到 trigger

`/compact` 的 target 始终是：

```text
floor(inputBudgetTokens * 0.60)
```

手动路径不要求当前 pressure 已达到 80% trigger。原因是：

- 用户可能希望在 60%~80% 之间主动建立回差；
- admission request 可能因 candidate prompt 超预算而失败，此时 session 已回到 idle，用户
  必须仍能运行 `/compact`；若 committed view 尚高于 target，它可以先缩小活动前缀；
- manual 是显式操作，不需要自动触发门槛替用户做决定。

如果 committed active request 已经 `<= target`，返回 `below_target`，不创建 revision。
`ContextManager` 在规划前只 measure，不调用 `assertWithinBudget()`；因此 committed view
已经超预算时，`/compact` 仍可作为恢复路径。

### 8.3 Candidate 条件

沿用 I1 全部硬规则，并增加一条：

```text
messageId 不在 activeOverrides 中
```

完整条件仍是：closed tool frame、returned completion、非 Recall、非最近 8 turns、至少
8 KiB、raw kind allowlisted、非 running/stopping task、source/hash 一致、renderer 成功且
placeholder 更小。

I2 不扩大 allowlist：

```text
read, glob, grep, completed bash, completed task_output,
web_search, web_fetch, mcp
```

Write/Edit、Recall、generic、synthetic、task list/stop 和 running task 继续排除。

### 8.4 累计 override 规划

planner 输入必须显式包含 active overrides：

```ts
type SwapPlanningInput = {
  active: CompiledRevisionContext;
  activeOverrides: readonly SwapOverride[];
  canonical: ProtocolContextView;
  activePrepared: PreparedModelRequest;
  activeUsage: ContextUsageSnapshot;
  tools: readonly ToolDefinition[];
  policy: SwapOnlyPolicyV1;
  trigger: "manual" | "runtime_pressure" | "benchmark_forced";
  forcedTargetTokens?: number;
};
```

每个 prospective projection 使用：

```text
candidateOverrides = activeOverrides + newlySelectedOverrides
```

不能只传 `newlySelectedOverrides`，否则此前已换出的 message 会在候选视图中恢复为完整
canonical body，既破坏 token 估值，也破坏 revision 单调语义。

### 8.5 排序与选择

新增候选继续按 I1 稳定顺序：

1. byte savings 降序；
2. original bytes 降序；
3. canonical ordinal 升序；
4. message ID 字典序。

继续只选择排序前缀，并用 1、2、4、8... + 二分搜索找到达到 target 的最小新增集合。
token 判断仍针对完整 `ModelClient.prepare()` 结果，before/after 使用同一 correction factor。

### 8.6 结果与是否提交

```ts
type SwapPlanningOutcome =
  | "below_target"
  | "no_eligible_candidates"
  | "target_reached"
  | "insufficient_candidates";
```

提交规则：

| outcome | 新增 override | token 严格下降 | I2 行为 |
| --- | ---: | ---: | --- |
| `below_target` | 0 | 不适用 | no-op success |
| `no_eligible_candidates` | 0 | 不适用 | no-op success |
| `target_reached` | > 0 | 是 | 提交 revision |
| `insufficient_candidates` | > 0 | 是 | 提交可获得的最大确定性收益，并明确报告仍未达到 target |

`insufficient_candidates` 不是失败，也不能在 I2 中自动转入 prefix retirement；它是 I3
的直接输入。

### 8.7 Plan identity 与 stale 检查

`SwapRevisionPlan` 在 I1 字段基础上增加：

```ts
type SwapRevisionPlan = {
  version: 1;
  policyVersion: "swap-only-v1";
  baseRevisionId: ContextRevisionId;
  baseRevisionNumber: number;
  baseCanonicalThroughOrdinal: number;
  baseOverrideManifestSha256: string;
  basePrefixHash: string;
  requestConfigHash: string;
  toolSchemaHash: string;
  addedOverrides: readonly SwapOverride[];
  nextOverrideManifestSha256: string;
  targetTokens: number;
  rawTokensBefore: number;
  rawTokensAfter: number;
  guardedTokensBefore: number;
  guardedTokensAfter: number;
  projectedPrefixHash: string;
  planHash: string;
};
```

plan hash 覆盖 base revision/number/tail/override manifest、request/tool hashes、按稳定顺序的
新增 override identity、target 和 projected hashes。

提交前再次检查 active revision、canonical tail、active override manifest、prepared
prefix、request config 和 tool schema。任何变化都返回 stale error；I2 不自动 replan 一次，
因为 RuntimeSession 已经串行化该操作，stale 表示所有权或完整性不变量被破坏。

## 九、`ContextManager` 所有权

### 9.1 为什么需要独立 owner

I1 的 shadow planning 位于 agent loop，但真正切换 revision 同时涉及：

- RuntimeSession 是否空闲；
- 当前 ledger/compiler snapshot；
- model prepare 与 ContextMeter；
- SessionStore transaction；
- revision ID 分配；
- committed prefix audit；
- diagnostic event 和 TUI result。

这些职责不能散落在 slash command、agent loop 和 SessionStore 中。I2 新增 RuntimeSession
私有拥有的 `ContextManager`：

```ts
type ContextCompactionTrigger =
  | { kind: "manual" }
  | { kind: "runtime_pressure" }
  | { kind: "benchmark_forced"; targetTokens: number };

type ContextCompactionResult =
  | {
      status: "unchanged";
      outcome: "below_target" | "no_eligible_candidates";
      revisionId: ContextRevisionId;
      revisionNumber: number;
      guardedTokensBefore: number;
      targetTokens: number;
    }
  | {
      status: "compacted";
      outcome: "target_reached" | "insufficient_candidates";
      previousRevisionId: ContextRevisionId;
      revisionId: ContextRevisionId;
      revisionNumber: number;
      addedOverrideCount: number;
      totalOverrideCount: number;
      rawTokensBefore: number;
      rawTokensAfter: number;
      guardedTokensBefore: number;
      guardedTokensAfter: number;
      targetTokens: number;
      planHash: string;
    };

class ContextManager {
  compact(trigger: ContextCompactionTrigger): Promise<ContextCompactionResult>;
}
```

I2 production 只传 `{ kind: "manual" }`。`runtime_pressure` 仍只走 shadow plan；保留 trigger
类型是为了未来自动路径调用同一个 `compact()`，不是在 I2 偷开自动开关。

### 9.2 依赖边界

`ContextManager` 依赖：

```text
SessionStore
SessionLedger read/build APIs
ContextRevisionCompiler
SwapPlanner
ModelClient.prepare only
ContextMeter
CommittedPrefixAuditor
RuntimeIdFactory
ToolDefinition provider
```

它不能依赖：

```text
ModelClient.request
ToolRuntime.execute
events.jsonl reads
TUI component state
current workspace reads
wall-clock values except revision createdAt
```

SessionStore 继续是 durable mutation owner；ContextManager 不能直接执行零散 SQL。

### 9.3 RuntimeSession 状态

RuntimeSession 状态增加：

```ts
type RuntimeSessionState =
  | "initializing"
  | "ready"
  | "executing"
  | "compacting"
  | "faulted"
  | "disposing"
  | "disposed";
```

公开 API 增加：

```ts
type RuntimeSession = {
  // existing fields...
  compactContext(): Promise<ContextCompactionResult>;
};
```

`compactContext()` 必须：

1. 只接受 `state === "ready"`；
2. 确认没有 `activeTurn`；
3. 确认 ledger 没有 pending turn，SessionStore 没有 open turn/iteration/frame；
4. 原子地把 state 改为 `compacting`；
5. operation 完成后回到 `ready`，或在 fatal error 后进入 `faulted`；
6. compacting 期间让 `executeTurn()`、session switch、model switch 和另一次 compact
   立即失败。

后台 task 不属于 active agent turn，I2 不要求全部停止后才能 compact。仍在 running 或
stopping 的 Bash/TaskOutput canonical result 已由 candidate hard rule 排除；compact 不停止、
重启或读取后台进程。

### 9.4 一条执行路径

```text
RuntimeSession.compactContext()
  -> state ready -> compacting
  -> append context.revision.started
  -> ContextManager.compact({ kind: "manual" })
       1. load active v5 snapshot
       2. compile and prepare committed active request
       3. ContextMeter.measure() without budget assertion
       4. SwapPlanner.plan() against active overrides
       5. return no-op, or build the complete candidate revision
       6. validate protocol, hashes, token reduction and stale base
       7. SessionStore.commitSwapRevision()
       8. activate the new in-memory measurement/prefix state
  -> append context.revision.finished
  -> state ready
```

Slash command、benchmark 和未来 automatic path 不得各自复制 plan/commit 逻辑。

## 十、候选 revision 的预验证

### 10.1 Transaction 外完成重型纯计算

SQLite write transaction 之前完成：

1. 加载一个一致的 `StoredContextSnapshotV5`；
2. 编译 active request 并准备 `activePrepared`；
3. 运行 planner，得到 `addedOverrides`；
4. 形成累计 candidate overrides；
5. 使用同一 compiler 编译 candidate view；
6. 使用同一 `ContextBuilder` 和 `ModelClient.prepare()` 生成 candidate prepared request；
7. 运行 canonical protocol validator、compiled validator 和完整 manifest 校验；
8. 复验 candidate raw/guarded token 都严格小于 active；
9. 复验 request config/tool schema/output limit 未变化；
10. 为完整 candidate 计算 canonical/rendered prefix hash 和 override manifest。

这样 transaction 只负责写入和最终 DB base 校验，不在持锁期间反复做 O(log n) 次完整
prepare。

### 10.2 Candidate revision ID

planner 不生成 revision ID。plan 完成并通过验证后，由 RuntimeSession 的
`RuntimeIdFactory.createContextRevisionId()` 分配 UUIDv7；revision number 只能由
SessionStore 在 transaction 中从当前 active revision 推导：

```text
nextRevisionNumber = activeRevisionNumber + 1
```

调用者不能指定或跳过 revision number。

### 10.3 Candidate prefix boundary

I2 手动 compact 只在 turn idle 运行，因此 `sourceThroughOrdinal` 必须：

- 等于 transaction 开始时 canonical 最大 ordinal；
- 落在 closed frame 的 `lastOrdinal`；
- 不存在 open turn、iteration 或 frame；
- 不切开 multi-tool exchange。

如果 idle 检查与数据库事实不一致，属于 fatal integrity/ownership error，不把边界向前
“修正”到某个看似安全的 frame。

## 十一、原子提交协议

### 11.1 `SessionStore.commitSwapRevision()` 输入

```ts
type CommitSwapRevisionInput = {
  revisionId: ContextRevisionId;
  expectedBaseRevisionId: ContextRevisionId;
  expectedBaseRevisionNumber: number;
  expectedCanonicalThroughOrdinal: number;
  expectedBaseOverrideManifestSha256: string;
  policyVersion: "swap-only-v1";
  rendererFormat: "swap-observation-v1";
  planHash: string;
  addedOverrides: readonly SwapOverride[];
  nextOverrideManifestSha256: string;
  canonicalSequenceSha256: string;
  renderedMessageSha256: string;
};
```

SessionStore 不接受 prepared request 或 token estimates；这些属于 ContextManager 的纯规划
结果。Store 只提交恢复活动视图所需事实。

### 11.2 Transaction 顺序

必须使用现有 `BEGIN IMMEDIATE` helper，按固定顺序执行：

```text
BEGIN IMMEDIATE

1. read and validate session_meta + current active revision
2. assert active ID/number match expected base
3. assert canonical max ordinal matches expected base tail
4. assert no open turn / iteration / protocol frame
5. load active overrides and verify expected base manifest
6. validate every added override against canonical message + tool result
7. insert next context_revisions row
8. insert only newly introduced context_overrides rows
9. reload cumulative active override set for the candidate revision
10. verify counts, manifest, canonical prefix hash and rendered prefix hash
11. delete context_measurement_state for the old active revision
12. update session_meta.active_revision_id and updated_at
13. read back meta/revision/measurement invariants

COMMIT
```

`active_revision_id` 是最后一个有语义的 durable mutation。它只能在 revision 和全部新增
overrides 已经存在并通过校验后更新。

第 10 步不调用 provider serializer；ContextManager 已经验证 prepared parity。Store 用纯
compiler/hash helper 验证 provider-neutral canonical/rendered manifest。

### 11.3 为什么删除 measurement row

当前 `context_measurement_state` 是 singleton，只保存最新 measured anchor。revision 切换会
重写旧 prompt prefix，旧 anchor 即使 request config/tool schema 相同也不能继续使用。

transaction 内删除旧 row，而不是只依赖读取时发现 revision ID 不同，能保证：

- COMMIT 后数据库没有歧义 anchor；
- 进程在 in-memory invalidation 前崩溃，resume 仍从 full estimate 开始；
- DB trigger 可以禁止带着旧 anchor 更新 active ID；
- 下一次 provider response 只会给新 active revision 写 anchor。

### 11.4 Transaction 失败

任何 INSERT、trigger、hash、count、readback、COMMIT 错误：

1. 执行 ROLLBACK；
2. 尽可能复验 `active_revision_id` 仍是 expected base；
3. 抛出带 stage/code 的 `SessionError`；
4. 不返回部分成功，不在另一个 transaction 中“补写”缺失 row；
5. required storage failure 使 RuntimeSession faulted。

旧 revision 在 durable 层继续完整有效，但 storage failure 后 runtime 不静默继续执行新的
有副作用 turn。用户可以修复存储问题后 resume 同一旧 revision。

### 11.5 COMMIT 后失败

COMMIT 是语义分界：

- COMMIT 前失败：旧 revision active；
- COMMIT 后失败：新 revision active。

如果 COMMIT 后 ContextMeter reset、diagnostic event 或 TUI notice 失败：

- 不创建“切回旧 revision”的补偿 transaction；
- RuntimeSession faulted；
- 重新 `/resume` 时加载并验证新 revision；
- event log 可能只有 `context.revision.started`，不能据此推断 DB 未提交。

### 11.6 Crash matrix

| 崩溃点 | reopen 后预期 |
| --- | --- |
| plan/prepare 期间 | DB 完全未变化，旧 revision active |
| revision row INSERT 后、override INSERT 中 | transaction rollback，旧 revision active，无孤儿 row |
| overrides 完整、active update 前 | transaction rollback，旧 revision active |
| active update 后、COMMIT 前 | transaction rollback，旧 revision active，旧 measurement 仍在 |
| COMMIT 后、ContextMeter reset 前 | 新 revision active，measurement row 为空，resume full estimate |
| COMMIT 后、finished event 前 | 新 revision active，event log 可能不完整但不参与恢复 |

fault-injection test 必须覆盖每个边界。

## 十二、ContextMeter、Prefix Audit 与 Cache

### 12.1 Revision-aware invalidation

现有 `ContextMeter.invalidate(reason)` 需要落实 reason 语义。I2 建议增加明确入口：

```ts
contextMeter.startRevision({
  reason: "context_rebuilt",
  requestConfigHash,
  toolSchemaHash,
});
```

对同一 request config/tool schema 的 swap revision：

- 清除 measured anchor；
- 清除 `lastProviderUsage`，避免把旧 revision usage 展示成新 revision measurement；
- 丢弃对旧 prepared request 的可记录 measurement；
- 保留 RollingTokenCalibration 和 correction factor；
- 下一次 `measure(newPrepared)` 必须返回 `source = "estimated_full"`；
- 下一次成功 provider usage 才建立并持久化新 revision anchor。

保留 calibration 的理由是 tokenizer/request identity 未改变，而且 I1 before/after 就使用同一
correction factor。若 request config 或 tool schema 不匹配，仍清除 calibration 并
fast-fail runtime contract；不能把它当普通 swap。

### 12.2 Compaction 后立即重新计量

COMMIT 后 ContextManager 使用已经预验证的 new prepared request：

```text
ContextMeter.startRevision(...)
CommittedPrefixAuditor.audit(newRevisionId, newPrepared)
ContextMeter.measure(newPrepared) -> estimated_full
emit context.usage.updated phase=revision
```

这次 measure 不调用 provider，不持久化 measured anchor。TUI footer 随即显示 compact 后的
estimated input，而不是继续显示旧数值。

`ContextUsageUpdatedData.phase` 增加：

```ts
"revision"
```

或将当前未落地的 `invalidated` 明确改名为 `revision`；不保留两个同义 phase。

### 12.3 Prefix audit

`CommittedPrefixAuditor` 已按 revision ID 隔离：

- 同 revision 继续执行 append-only audit；
- new revision ID 的第一次 audit 只建立新 anchor；
- 下一次 turn 追加 canonical tail 后，再验证新 revision prefix 未漂移。

I2 不需要把 auditor anchor 持久化；resume 首次 prepared request 建立新的进程内 anchor。

### 12.4 Provider cache 预期

swap revision 会重写旧前缀，第一次 post-compact request 可能丢失部分 prefix cache，这是
预期成本，不是 correctness failure。之后只要 revision 不变，append-only 前缀应再次稳定。

I2 记录真实 provider 的 cache hit/miss，但不设置跨机器固定命中率门槛。若手动 compact
频繁产生很小 revision，会破坏 cache，因此：

- below target 不创建 revision；
- 一次选到 target 或耗尽全部合格候选；
- 相同 canonical tail 上重复 `/compact` 必须 no-op。

## 十三、`/compact` 命令

### 13.1 解析契约

slash command 增加：

```text
/compact
```

只接受零参数。以下全部返回明确 usage error：

```text
/compact now
/compact --force
/compact 60000
```

`SLASH_COMMANDS` 描述建议为：

```text
Compact eligible historical tool output
```

### 13.2 TUI 调用链

```text
App.onSubmit("/compact")
  -> set isSessionOperation
  -> TuiSessionController.compact()
  -> serialized controller operation
  -> RuntimeSession.compactContext()
  -> render direct result as notice
```

`PromptInput` 在操作期间 disabled。controller 的既有 `serialize()` 同时防止 resume、delete、
model switch 和 compact 并发。

### 13.3 空闲态定义

用户提交命令时 UI 的 `isRunning === false` 只是第一层保护。RuntimeSession 必须再次验证：

```text
state == ready
activeTurn == undefined
no pending ledger turn
no open DB turn/iteration/frame
no other session operation
```

不依赖 TUI flag 证明正确性。测试可直接调用 RuntimeSession API 验证 executing/disposing/
faulted 时失败。

### 13.4 用户反馈

成功示例：

```text
Context compacted: revision 1 -> 2, 3 observations swapped,
48,361 -> 34,735 estimated tokens (-28.2%).
```

候选不足但已提交：

```text
Context compacted: 3 observations swapped, 48,361 -> 34,735 estimated tokens;
target 0 was not reached.
```

无需处理：

```text
Context is already below the compact target (31,200 <= 39,321 estimated tokens).
```

没有新增候选：

```text
No eligible historical tool observations can be compacted.
```

notice 只展示 revision number、数量和 token 聚合，不展示 message/source/path/command。

### 13.5 超预算恢复体验

当前 admission preflight 会在 user frame 写入前拒绝超预算 candidate prompt，session 随后仍
是 ready。用户仍可执行 `/compact`；若 committed view 高于 60% target 且存在候选，它会先
缩小 active view，再由用户重新提交原 prompt。若 committed view 已低于 target，命令明确
no-op，不能保证为一个本身极大的 candidate prompt 腾出足够预算。

I2 不缓存、自动重放或隐式提交被拒绝的 user prompt；prompt history 已独立保存用户输入，
是否重提由用户决定。

## 十四、诊断事件

I2 新增 session-level events：

```text
context.revision.started
context.revision.finished
context.revision.failed
```

### 14.1 Started

```ts
type ContextRevisionStartedData = {
  strategy: "swap";
  reason: "manual";
  policyVersion: "swap-only-v1";
  rendererFormat: "swap-observation-v1";
};
```

### 14.2 Finished

```ts
type ContextRevisionFinishedData = {
  strategy: "swap";
  reason: "manual";
  policyVersion: "swap-only-v1";
  outcome:
    | "below_target"
    | "no_eligible_candidates"
    | "target_reached"
    | "insufficient_candidates";
  baseRevisionNumber: number;
  revisionNumber?: number;
  addedOverrideCount: number;
  totalOverrideCount: number;
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
```

### 14.3 Failed

```ts
type ContextRevisionFailedData = {
  strategy: "swap";
  reason: "manual";
  stage: "snapshot" | "plan" | "validate" | "commit" | "activate";
  errorCode: string;
  error: string; // 固定、有界、不包含输入正文
};
```

事件禁止包含：

- prompt、assistant、tool observation 或 placeholder 正文；
- path、URL、query、command 或 raw result；
- message/source/tool-call ID 列表；
- selected ordinal 列表。

TUI projection reducer 不把这些事件加入 timeline；即时 notice 使用 API result。event log
继续只做诊断，不参与 `/resume` 或 revision 恢复。

## 十五、失败语义

### 15.1 Ordinary no-op

以下是成功返回，不 fault session：

- active view 已低于 target；
- 没有 eligible candidate；
- 所有 eligible message 已经在 active overrides 中。

它们不创建 revision、不清除 measurement、不改变 prefix auditor。

### 15.2 可报告的 compaction failure

以下错误保持旧 revision active，命令失败，但如果 active/canonical/storage 本身仍通过完整
校验，可以回到 ready：

- prospective serializer/estimator 的非 canonical diagnostic error；
- candidate prepare 的本地、非完整性错误。

单个 candidate 的明确 renderer unsupported reason 仍是普通 exclusion；只要 planner 可以
继续形成完整结果，就不让整个手动命令失败。source/hash mismatch 不属于 unsupported，仍是
fatal canonical error。

手动命令不能像 I1 shadow 那样静默继续；必须把错误显示给用户并写 failed event。

### 15.3 Fatal runtime/store failure

以下错误立即 fault RuntimeSession：

- canonical protocol、message hash 或 tool result 损坏；
- active revision chain、override manifest 或 stored renderer parity 损坏；
- same-revision committed prefix 漂移；
- plan stale；
- transaction/COMMIT/readback 失败；
- COMMIT 后无法激活相同 new prepared view；
- required event sink 失败。

fatal 后不 fallback 到 full history，也不继续下一个可能有副作用的 turn。

### 15.4 Planner outcome 仍高于 hard budget

`insufficient_candidates` 可以提交严格更小的新 revision，但 compact 后仍可能超过 target
甚至 input budget。命令必须显示 after/target；之后 admission preflight 仍按正常 hard budget
拒绝 provider request。

I2 不扩大候选、不换出受保护内容、不自动进入 I3，也不生成摘要来“救场”。

## 十六、Recall 与历史/当前语义

### 16.1 Canonical source 不变

`context_overrides.rendered_content` 只属于 active projection。以下数据完全不变：

```text
messages.content
messages.content_sha256
tool_results.raw_json
tool_results.observation_sha256
recall_documents
message_fts
```

因此：

- `Recall get source=ctx://message/...` 返回原 observation 和原 hash；
- `Recall search` 仍搜索原文，不搜索 placeholder；
- `/resume` 恢复 active placeholder，但 Recall 仍指向 canonical body；
- Read/Grep/Bash 继续表示当前 workspace/external state。

### 16.2 Recall page-in 只追加尾部

模型看到 placeholder 后调用 Recall：

```text
old swapped tool message remains unchanged in its old ordinal
Recall assistant tool call is appended at the current tail
Recall result with historical original text is appended as a new tool message
```

Recall tool result本身继续排除在 swap candidate 之外，避免递归 placeholder。

### 16.3 必测版本差异

集成用例必须证明：

1. Read 文件 v1，随后 Edit 为 v2；
2. `/compact` 换出旧 Read observation；
3. Recall 返回历史 v1；
4. 当前 Read 返回 v2；
5. 退出/resume 后仍保持相同 source/hash 和相同结果。

## 十七、安全、隐私与存储增长

### 17.1 Placeholder 的信任边界

stored rendered content 会进入模型输入，因此 load 时必须重新验证：

- 固定 header/line order；
- source 和 canonical message ID；
- original content hash；
- tool name 与 allowlisted metadata；
- JSON escaping、scalar 256-byte limit、metadata 1 KiB limit；
- current/historical 固定 guidance；
- rendered SHA-256 和 byte count。

数据库存在 row 不等于它自动获得 runtime 指令权限。

### 17.2 文件权限

`context_overrides` 可能包含 path、URL、query 或 command 的有界 metadata，但它位于当前
已有的 0600 `session.sqlite` 中；session directory 继续是 0700。event 不复制这些字段。

### 17.3 存储增长

I2 永不删除 canonical history，且每个 swapped message 新增一条短 placeholder row；因此
数据库只增不减。首次引入模型避免后续 revision 重复保存 placeholder，增长近似：

```text
O(number of canonical messages + number of swapped messages + number of revisions)
```

而不是每个 revision 复制完整 override 集合的平方增长。

旧 revisions/overrides 不自动清理；session list/delete 仍是独立运维能力。

## 十八、性能约束

- active compile 继续按当前 canonical message 数 O(n)；I2 不声称解决 canonical load RSS。
- active override lookup 使用一次有序查询和 `Map<MessageId, Override>`，不在每条 message
  上查询 SQLite。
- manual plan 沿用 I1 的 O(n) candidate scan 与 O(log n) prospective prepare。
- transaction 只插入本次新增 override rows，不重复旧 rows。
- compiled/prospective requests 不进入 TUI、event store、ContextMeter 或 SessionStore 长期
  JS cache。
- `/compact` 是显式低频操作，不设跨机器毫秒硬 SLA；正式 benchmark 必须报告 plan、
  transaction、post-activation 和总 duration。

如果 active revision compilation 的常规 request-build p95 相对 I1 显著回退，先修复 query/
validation 路径，不能通过弱化 hash/protocol 校验换性能。

## 十九、测试设计

### 19.1 Schema v5 identity

- 新 session 创建 schema/user version 5 和新的完整 fingerprint。
- v4 session 明确返回 `SESSION_SCHEMA_UNSUPPORTED`，没有 fallback/migration。
- initial revision 恰好一条：number 1、kind `initial_full`、parent null、count 0、boundary 1。
- 新 schema 包含 immutable `context_revisions`、`context_overrides` 和 active/measurement
  triggers。
- 任一 table/index/trigger/view SQL 漂移都被 `verifySessionSchema()` 拒绝。
- Recall FTS integrity/rebuild 在 v5 上保持通过。

### 19.2 Revision chain 与 override constraints

- 第一次 compact 创建 revision 2，parent 指向 revision 1。
- 第二次在追加新历史后 compact 创建 revision 3，parent 指向 revision 2。
- revision number gap、branch、非 latest active、跨 session parent 全部失败。
- 同一 message 第二次插入 override 失败。
- override 不能指向 user/assistant/system、open frame 或另一个 frame/ordinal。
- source、original hash、rendered hash、UTF-8 byte count 任一不匹配都失败。
- revision/override UPDATE、DELETE 全部失败。
- active ID 不能跳过一个 revision，也不能回退到旧 revision。
- active switch 时 measurement 未删除会被 trigger 拒绝。

### 19.3 Active compiler

- v5 initial revision 仍与 I1 active payload/segments 完全相同。
- one/multi-tool frame 中只改变 selected tool message content，所有协议 ID 和顺序不变。
- revision 2 的 swapped entries 在追加 canonical tail 后仍逐字节稳定。
- revision 3 继承 revision 2 overrides，并只增加新项；旧项不能恢复 canonical body。
- stored placeholder 与 renderer golden output 不同会 fast-fail。
- unknown kind/policy/renderer format 不 fallback。
- frozen canonical/rendered prefix hash 在 append 后仍验证；修改旧 prefix 失败。

### 19.4 Planner on active revision

- 已 active-swapped message 给出 `already_swapped` exclusion，不再成为 candidate。
- prospective view 使用 active + newly selected overrides。
- 相同 snapshot 得到相同新增集合、manifest 和 plan hash。
- manual 在 pressure normal 但 >60% target 时仍规划。
- <=60% target 返回 `below_target`。
- `target_reached` 选择达到 target 的最小排序前缀。
- 候选耗尽仍严格缩小返回带 plan 的 `insufficient_candidates`。
- 无新增候选不创建空 plan。
- active revision/tail/manifest/prefix/config/schema 任一变化判 stale。
- planner 只调用 `prepare()`，`request()` 次数恒为 0。

### 19.5 Atomic commit 与 fault injection

分别在以下位置注入异常并关闭/reopen database：

1. revision INSERT 前；
2. revision INSERT 后；
3. 第一个 override INSERT 后；
4. 全部 overrides 后、measurement DELETE 前；
5. measurement DELETE 后、active UPDATE 前；
6. active UPDATE 后、COMMIT 前；
7. COMMIT 后、ContextMeter activation 前；
8. COMMIT 后、finished event 前。

前六项必须恢复旧 active revision、无孤儿 rows、旧 measurement 保留；后两项必须恢复新
revision、measurement 为空、active view 可完整编译。

另外验证：

- disk full/read-only/constraint failure 包装成明确 `SessionError`；
- transaction 失败后不执行第二次隐式 commit；
- COMMIT 后 event failure 不切回旧 revision；
- reopen 的 `quick_check`、foreign key、schema、Recall index 均通过。

### 19.6 ContextMeter 与 prefix audit

- compact 前有 exact measured anchor；transaction 后 DB measurement row 消失。
- new revision 第一次 measure 是 `estimated_full`，不是 measured delta。
- last provider usage 不冒充 new revision usage。
- request/tool identity相同时 correction factor 保留。
- identity 漂移时 calibration 清空并由 runtime contract fast-fail。
- new revision 首次 prefix audit 建 anchor；后续 append-only request 通过。
- 同 revision 旧 prefix 被改写立即失败。
- post-compact provider response 将 anchor 写到 new active revision。
- resume 只能恢复与 new prepared request 完全匹配的 new revision anchor。

### 19.7 RuntimeSession lifecycle

- ready/idle 可以 compact。
- executing、compacting、faulted、disposing、disposed 时不能 compact。
- compacting 时不能开始 turn、switch session/model 或启动第二次 compact。
- background task running 不阻塞 compact，但其 running result 不进入 candidate。
- ordinary no-op 后 state 返回 ready，revision/measurement/auditor 不变。
- recoverable plan diagnostic 显式返回错误且旧 revision active。
- canonical/store fatal error 使 session faulted。
- compact 全程 tool side effect count 不变。

### 19.8 `/compact` TUI

使用 `ink-testing-library` 验证：

- slash autocomplete 包含 compact；
- `/compact` 解析为唯一命令，带参数报 usage；
- operation 期间 PromptInput disabled；
- 成功、insufficient、below-target、无候选、失败 notice 文案；
- token 百分比和 count 格式稳定；
- notice 不包含 message/source/path/command；
- 与 resume/model/delete operation 串行；
- Esc 不被误解释为 turn cancellation。

再用真实 PTY 验证一次：使用显式的小预算测试 profile 和 fake model，执行能产生 >8 KiB
observation 的 turn，使 committed view 高于 60% target；回到 idle 后输入 `/compact`，看到
成功 notice，再继续下一 turn 并正常 `/quit`。测试 profile 只存在于测试 harness，不成为
production 隐藏配置。

### 19.9 Recall 集成

- compact 前后 `Recall get` 对 selected source 返回同一 content/hash。
- `Recall search` 命中 canonical body 中只存在于原文、placeholder 不含的字符串。
- Recall result 追加到尾部，不改写旧 ordinal。
- Recall tool result 不成为下一次 compact candidate。
- Read v1 -> Edit v2 -> compact -> Recall v1 -> Read v2。
- `/resume` 后重复 search/get，source/hash/body 相同。
- 不能跨 session/workspace 读取 override 指向的 source。

### 19.10 G0/I1 formal benchmark 扩展

50-turn workload 调整为：

1. 前 12 turns 继续生成 I1 的确定性大 observation；
2. 在 turn idle 边界通过 benchmark-only dependency 注入
   `{ kind: "benchmark_forced", targetTokens: 0 }`，调用同一个
   `ContextManager.compact()` 并真实提交 revision，不再只观察 prospective plan；
3. 验证 revision 2、active override rows、token before/after 和 Recall round-trip；
4. 继续追加 turns，证明 revision 2 prefix append-only；
5. 中点 close/resume，验证相同 active revision、placeholder bytes 和 Recall；
6. 追加新的 eligible observation 后执行第二次 benchmark-only manual compact；
7. 验证 revision 3 继承旧 overrides，只新增 row；
8. 保留受控取消、Recall search -> get 和最终 provider request count 断言。

正式输出至少包括：

```text
revision count / active number
added and total override count
original/projected observation bytes
raw/guarded tokens before and after
plan / transaction / activation / total duration
request-build p50/p95 before and after
provider request count
database/WAL byte delta
RSS/heap delta (observed only, not an I2 success promise)
resume / cancellation / Recall verification
```

以当前 I1 fixture 为最低一致性预期：相同 snapshot 的 first compact 应选择 Read 2、Bash 1，
且完整 prepared request 降幅与 I1 prospective 结果一致；不把特定 plan hash 写成跨实现永久
常量，但相同代码/fixture 重复运行必须稳定。

### 19.11 真实 provider smoke

使用当前显式 model profile 做一次受控 smoke。为了避免为达到 60% target 人为发送巨大
prompt，fixture 通过 benchmark-only trigger 调用同一个 ContextManager commit path；该入口
不暴露为用户 flag 或环境变量：

- compact 本身 provider request count 为 0；
- post-compact request 被 provider 接受，tool protocol 合法；
- 再追加一次 turn，验证同 revision 前缀稳定；
- 记录 compact 前、第一次 post-compact、第二次 append 请求的 prompt/cache hit/cache miss；
- 不把本次 cache 数值写成 SLA，只记录 revision rewrite 的真实成本。

## 二十、诊断事件与 canonical 数据的双写边界

SessionStore 与 event log 不能共享 transaction，沿用当前 required/diagnostic sink 语义：

```text
started event append succeeds
  -> plan and SessionStore transaction
  -> finished event append
```

- started event 失败：不进入 durable compaction；
- plan/transaction 失败：尽力追加 failed event，旧 revision active；
- finished event 失败：new revision 已 durable active，session faulted；
- 不从 started/failed/finished event 推断 active revision；
- `/resume` 只读取 `session_meta + context_revisions + context_overrides + canonical history`。

这不是跨文件原子性，而是明确的 source-of-truth 顺序。

## 二十一、代码组织

### 21.1 建议新增

```text
src/context/context-manager.ts
src/context/context-policy.ts
src/context/swap-planner.ts
```

`context-swap-renderer.ts` 已存在并继续使用。现有
`context-shadow-planner.ts` 的纯 planning 逻辑迁入 `swap-planner.ts`；shadow runtime 和
ContextManager 共用它，不保留两套候选/排序/估值实现。

### 21.2 建议修改

```text
src/context/context-revision.ts
  - StoredContextRevisionV5 / StoredContextSnapshotV5 / StoredSwapOverrideV5
  - ProspectiveSwapOverride -> SwapOverride

src/context/context-revision-compiler.ts
  - compileActive(snapshotV5)
  - compileProspective(active overrides + added overrides)

src/context/compiled-context-validator.ts
  - active validation 接受真实 active override set

src/context/context-shadow-planner.ts
  - 拆出通用 pure planner；保留 shadow wiring/event adapter 或删除后改调用点

src/context/context-swap-renderer.ts
  - 保持 swap-observation-v1 byte contract
  - 暴露 stored parity validator 所需纯 helper

src/session/session-schema.ts
  - schema v5、context_overrides、revision/active/measurement triggers

src/session/session-store.ts
  - v5 decoders、loadContextSnapshot()
  - commitSwapRevision()
  - revision/override integrity validation

src/agent/session-ledger.ts
src/session/sqlite-session-ledger.ts
  - 使用通用 v5 snapshot/revision 类型
  - turn 开始时 pin 当前 active revision

src/agent/context-meter.ts
  - revision-aware start/reset semantics

src/agent/runtime-session.ts
  - ContextManager ownership、compacting state、compactContext()

src/events/types.ts
  - context.revision.started/finished/failed
  - context usage revision phase

src/tui/slash-commands.ts
src/tui/tui-session-controller.ts
src/tui/app.tsx
  - /compact parse、serialized invocation、notice

scripts/bench-long-session-memory.ts
  - durable compact、multi-revision、resume/Recall/cache metrics
```

### 21.3 不允许的依赖方向

- compiler/planner/renderer 不 import `bun:sqlite`；
- SessionStore 不 import TUI；
- slash command 不直接 import SessionStore 或 planner；
- event reducer 不推断 active revision；
- ContextManager 不调用 tool runtime 或 model request；
- Recall 不读取 `context_overrides` 才能返回历史正文。

## 二十二、实施顺序

### I2.1：schema v5 与类型 cutover

- 冻结 v5 DDL、fingerprint、trigger 和 no-migration 边界；
- 更新 meta/revision/snapshot decoders；
- 新 session 创建 initial revision manifest；
- 完成 schema corruption/unsupported tests。

### I2.2：Active multi-revision compiler

- 加载 introduced overrides 的线性继承集合；
- active/prospective validator 接受累计 overrides；
- 实施 renderer stored parity；
- 完成 append-after-swap 与 two-revision compiler tests；
- 此小步仍不提供写 revision API。

### I2.3：通用 SwapPlanner

- 从 shadow-specific owner 抽出纯 planner；
- policy 升级为 `swap-only-v1`；
- 排除 already-swapped entries；
- plan 包含 base/next override manifest；
- shadow runtime 改用相同 planner，继续保持零提交。

### I2.4：SessionStore atomic commit

- 实现 `commitSwapRevision()`；
- active-switch/measurement triggers；
- transaction readback 与 fault injection；
- close/reopen 验证新 revision；
- 仍不接 TUI。

### I2.5：ContextManager 与 RuntimeSession

- 增加 compacting state；
- 接入 manual ContextManager path；
- revision-aware meter/prefix activation；
- 增加 bounded events；
- 验证 provider/tool request count 为 0。

### I2.6：`/compact` 与产品反馈

- slash command/controller/App wiring；
- success/no-op/insufficient/failure notice；
- component tests 与真实 PTY；
- 不新增复杂 panel 或 picker。

### I2.7：门禁与路线图回写

- `bun run check`；
- 50-turn formal benchmark；
- Recall benchmark；
- crash/fault matrix；
- 真实 provider cache/protocol smoke；
- 将实际 schema、收益、latency、DB 增量和失败结果写回本文与 roadmap；
- 达到全部门槛后，才允许设计 I3。

## 二十三、I2 验收门槛

I2 只有同时满足以下条件才算完成：

1. schema v5 是唯一受支持格式；v4 明确 fast-fail，无 dual-read/migration。
2. revision chain 线性、不可变、无 gap/branch，active 始终指向最高已提交 revision。
3. 每条 override 只首次保存一次，后续 revision 单调继承且不能 silently unswap。
4. I2 全部 revision 的 `keepFromOrdinal` 仍为 1。
5. stored placeholder 与 I1 renderer 逐字节一致，source/hash 可 Recall。
6. active compiler 在 initial revision 上保持 I1 byte parity，在 swap revision 上只改变批准的
   tool content。
7. manual planner 不要求 trigger，但 <=target 时不创建 revision。
8. `target_reached` 和 `insufficient_candidates` 的 committed request 都严格减少 raw/guarded
   token。
9. compact 期间没有任何 model request、tool execution 或 side effect。
10. transaction 任一步失败后旧 active revision 和旧 measurement 保持有效，无孤儿 row。
11. COMMIT 后崩溃/resume 恢复 new active revision，measurement 从 full estimate 开始。
12. compact 后同 revision append-only prefix audit 通过，首次 cache rewrite 成本有真实记录。
13. canonical messages/tool results/FTS rows 在 compact 前后逐项不变。
14. Recall search/get 在 compact、继续追加和 resume 后都返回相同原文/hash。
15. `/compact` 只在 idle turn 状态可用，与 session operations 串行，真实 PTY 可继续下一 turn
    和退出。
16. events/notices 不泄露正文、placeholder、path、URL、query、command 或 candidate IDs。
17. G0/I1 formal benchmark、Recall benchmark、fault injection、真实 provider smoke 和
    `bun run check` 全部通过。
18. 路线图记录实际结果后，才宣布 I2 完成。

任一门槛未满足，不得通过隐藏 flag 自动提交 shadow plan，也不得提前允许
`keepFromOrdinal > 1`。

## 二十四、交给 I3 的明确输出

I2 完成后，I3 可以依赖：

```text
Durable active revisions can switch atomically and resume exactly
Swap overrides are immutable, deterministic, Recall-addressable, and monotonic
Manual compaction and future automatic compaction share ContextManager.compact()
Measured/prefix anchors reset correctly at revision boundaries
Swap-only token floor and insufficient-candidate frequency are measured
Canonical history and Recall remain unchanged across multiple revisions
```

I3 才负责：

- 允许 `keepFromOrdinal` 前移；
- 定义完整已结束 turn 的退休边界；
- 让退休前缀及其中 placeholder 完全退出 active request；
- 保留 O(1) system Recall 契约和近期完整 suffix；
- 建立 manual/benchmark-only 冷退休事务与评测。

I3 不能把 I2 的逐条 placeholder 当永久目录，也不能删除它们对应的 canonical history。

## 二十五、最终设计决策

1. **I2 一次性切换 schema v5；不迁移、不兼容读取 v4 session。**
2. **revision 是不可变线性链，active ID 只能在一个 transaction 中前进到直接子
   revision。**
3. **override 采用“首次引入 + 后继继承”，每条 message 只保存一次 placeholder，避免
   revision 间重复复制。**
4. **I2 所有 revision 固定 `keepFromOrdinal = 1`，只替换 closed frame 内 allowlisted tool
   observation 的 content。**
5. **active、prospective 和 resume 共用同一 compiler/validator/renderer contract。**
6. **`swap-only-v1` 沿用 I1 的 8 KiB、最近 8 turns 和 60% target，但获得活动提交权限；
   renderer 仍是 `swap-observation-v1`。**
7. **手动 `/compact` 不要求达到 80% trigger；低于 60% target 时 no-op。**
8. **候选不足但仍严格缩小时提交 `insufficient_candidates` revision，不在 I2 自动进入冷
   退休或摘要。**
9. **重型 planning/prepare 在 transaction 外完成；revision、new overrides、measurement
   invalidation 和 active switch 在一个 transaction 内完成。**
10. **COMMIT 是唯一语义分界；前失败保留旧 revision，后失败以新 revision 为 durable
    truth，不做补偿切回。**
11. **revision 切换清除旧 provider anchor，保留同 request/tool identity 的 calibration，
    下一 usage 从 `estimated_full` 开始。**
12. **`ContextManager.compact()` 是手动和未来自动路径的唯一活动换出入口；I2 production
    只开放 manual。**
13. **canonical history、tool raw result、FTS 和 Recall 永远不因 I2 mutation 改变。**
14. **自动 swap、冷前缀退休和 checkpoint 继续各自受后续独立门禁约束。**
