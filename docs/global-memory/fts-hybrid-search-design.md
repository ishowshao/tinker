# 全局记忆：FTS5 混合检索设计

## 文档状态

- 日期：2026-08-29
- 状态：已实施（`bun run check` 全量通过；既有 v2 库打开时自动创建并回填 FTS 索引）
- 上位文档：
  [`high-level-decisions.md`](high-level-decisions.md)
- 修订对象：[`history-summary-memory-design.md`](history-summary-memory-design.md)
- 目标：为 `MemorySearch` 增加 FTS5 关键词召回路径，与既有向量召回按 RRF 融合；
  不修改 `memories` 主表 schema，FTS 表以可重建派生索引的形式引入

本文冻结混合检索的输入契约、FTS5 索引结构、召回融合算法、降级语义和派生索引的
生命周期。凡本文未提及的既有行为（提取链路、权限契约、诊断日志、embedding
identity 校验、one-shot 边界等）保持 v2 文档的定义不变。

## 一、背景与动机

v2 已落地 `text`（一句话索引行）+ `summary`（2-4KB 详细摘要）两层结构，并在设计时
明确"FTS5 关键词检索本次不实现，但 `summary` 列的引入和 `text` 的检索把手要求都是
为它铺路"。本方案兑现这一预留。

纯向量召回存在结构性弱项：精确术语、标识符、错误码、文件路径、短专有名词这类
"字面必须命中"的信号，embedding 对它们不敏感。同时模型侧只有 `query` 一个参数，
无法表达"我要精确命中这些词"的意图。

上位文档早已选定方向：5.2 节确定以 FTS5 提供关键词搜索，6.1 节冻结了
`MemorySearch { query, keywords }` 的双参数形状。本方案把这些既定决策落到 v2 的
`text` + `summary` 结构上，并补上第十一条所引用、但从未落盘的聚合排序设计。

## 二、核心决策

### 2.1 输入契约：`query` 走向量，`keywords` 走 FTS

```ts
MemorySearch {
  query?: string    // 语义描述，生成 embedding 后做向量召回
  keywords?: string[] // 精确关键词列表，构造 FTS5 MATCH 做关键词召回
}
```

- 两个参数各自可选，但至少提供一个；都为空是参数错误。
- **系统不从 `query` 中自动提取关键词**（上位文档 6.1 既定）。只给 `query` 时 FTS
  路完全不走，这是契约纯净的有意代价，由工具描述引导模型把精确术语放进
  `keywords`。
- `keywords` 上限：数量 ≤ 8，单个 trim 后 1–128 UTF-8 字节。
- trigram 分词器对短于 3 字符的 keyword 无法匹配：构造 MATCH 时静默丢弃；全部
  keyword 都被丢弃时该路视为无输入，诊断记录原因，不向模型报错（模型给出
  "DB" 这类短词是合理输入，不应惩罚）。

### 2.2 FTS5 索引结构

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
  text,
  summary,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram'
);
```

- external content 模式，索引数据与主表不重复存储；查询经 `rowid` 关联
  `memories` 主表。
- **分词器选 `trigram`**：记忆内容是中英混合，默认 `unicode61` 对无空格分词的
  中文整段成一个 token，关键词检索对中文失效；trigram 支持任意 ≥3 字符子串
  匹配，中英文通吃。记忆库量级（百至千级条数、summary ≤ 4KB）下索引体积代价
  可忽略。
- **列权重**：`bm25(memories_fts, 10.0, 1.0)`。`text` 是提取 prompt 强制装满检索
  把手的索引行，权重显著高于自由形态的 `summary`；这兑现 v2 文档"`text` 承担
  召回职责"的意图。
- **MATCH 构造**：每个 keyword 双引号包裹为短语（内部 `"` 转义为 `""`），以 `OR`
  连接。选 OR 是召回优先：记忆库小，精度交给 bm25 排序和 RRF 融合，漏召回比
  噪声排名更伤。

### 2.3 召回融合：RRF

```text
rrf_score(memory) = Σ_path 1 / (60 + rank_path(memory))    rank 从 1 起
```

- 两路各自独立召回 top-20 候选（新常量 `MEMORY_RECALL_CANDIDATE_LIMIT = 20`，远大
  于透出上限 `MEMORY_SEARCH_LIMIT = 5`）。
- 只在单路出现的记忆只获得该路的分数；最终按 rrf_score 降序取 top-5。
- tie-break 沿用既有习惯：`created_at` 降序、`memory_id` 字典序。
- **为什么不用线性加权**：cosine 尺度固定，bm25 尺度随库内容漂移，二者直接加权
  必须先归一化 bm25，而归一化方式本身引入新的任意超参且对当批候选集敏感。
  RRF 只吃 rank，天然免疫尺度问题，确定性、无需调参，`k=60` 是广泛验证的默认
  值。丢失分数幅度信息对本场景无害：透出层只需要排序。未来如需给某路加权，
  weighted RRF（各项乘权重）即可扩展，不推翻结构。
- 结果透出 `via` 标记（`vector`、`fts`、二者皆有）：双路命中是更强的可信信号，
  对模型有实际价值，也是混合质量的调试观测手段。

### 2.4 降级语义

严格区分三种情形，执行上位文档 5.2 的硬要求——不得把单路结果伪装成完整混合
召回：

| 情形 | 行为 | 观察标注 |
| ---- | ---- | -------- |
| 只给 `query` 或只给 `keywords` | 正常单路召回 | `via=` 如实标注，不算降级 |
| embedding 不可用但有关键词路输入 | 纯 FTS 召回 | 显式标注 `vector search unavailable` |
| 向量路可用但 FTS 表损坏 | 抛出即重建（见 3.2），重建失败才降级纯向量 | 显式标注 `keyword search unavailable` |
| 两参数都为空 | 参数错误 | 不进入检索 |

## 三、Schema 策略：FTS 表作为派生索引

### 3.1 不动主表，不 bump schema version

`memories` 主表与 `memory_meta` 不变，`MEMORY_SCHEMA_VERSION` 保持 2。v2 库无需
删除重建。

### 3.2 校验分层

现有 `verifySchema` 对全部应用层对象做逐字整段严格校验，FTS 表若加入该校验会让
所有现存 v2 库打开即报错。因此校验分两层：

- `memory_meta` + `memories`：保持逐字严格校验，不匹配仍抛
  `memory_schema_unsupported`；
- `memories_fts`：**派生索引单独处理**——缺失则创建并全量 backfill；存在则校验
  结构，结构不匹配则 `DROP` 后重建再 backfill；backfill 失败只禁用关键词召回
  路径（降级，见 2.4），不阻止主 Session 工作。

数据永远以 `memories` 主表为准，FTS 内容可随时整体重建，不构成迁移。

### 3.3 写入同步

`insertBatch` 现有 `ON CONFLICT(text_sha256) DO NOTHING` 去重语义不变。FTS 写入
挂在同一事务内，只同步实际插入主表的行（按 `changes()` 逐行判断）。当前库没有
update/delete 路径，FTS 侧只处理 insert 与整体重建，不为未来的 mutation 工具
预支复杂度。

## 四、透出与观察

- `MemorySearchRawResult` 的 matches 增加 `via: readonly ("vector" | "fts")[]`。
- 结果元信息行的 `score` 变为 RRF 分数（保留 3 位小数），新增 `via=vector,fts`
  形式的路径标记。
- 观察头部如实说明本次激活的召回路径；发生降级时给出对应 unavailable 标注。
- 工具描述更新：说明双路语义与分工——精确术语、标识符、错误串、路径放
  `keywords`；语义描述放 `query`；两者都给获得混合召回。

## 五、诊断

`MemorySearchDiagnostic` 扩展字段：`keywordCount`、`vectorReturned`、
`ftsReturned`、`degraded`（`null | "vector" | "fts"`）。不记录 query 文本与
keyword 内容的既有红线不变。

## 六、风险与对策

| 风险 | 对策 |
| ---- | ---- |
| trigram 索引体积膨胀 | 库量级小（条数千级、单行 ≤ 4.5KB），实测可忽略；external content 不重复存正文 |
| bm25 尺度漂移导致融合不公平 | RRF 只吃 rank，不用分数绝对值 |
| 模型只给 query 导致 FTS 路空转 | 契约纯净优先；工具描述引导精确术语进 keywords |
| 短 keyword 在 trigram 下静默无命中 | 构造期丢弃 <3 字符词并记诊断；全丢弃时该路记无输入 |
| FTS 表损坏/结构漂移 | 派生索引语义：DROP 重建 backfill；重建失败仅降级关键词路 |
| 既有 v2 库打开报错 | 校验分层（3.2），FTS 表不进逐字严格校验 |
| 关键词路召回调用大噪声 | OR + bm25 排序 + RRF 融合；透出上限仍为 5 |
| 单路结果被误认为混合召回 | 观察与诊断强制标注激活路径与降级状态（2.4） |

## 七、与既有文档的关系

- 兑现 v2 文档（history-summary-memory-design）第五章"FTS5 后续迭代加，不需要
  再动 schema"的预留：本方案不动主表 schema，以派生索引形式落地。
- 落实上位文档 5.2（FTS5 + 向量共存、降级显式可见）与 6.1（`query`/`keywords`
  双参数、系统不自动提取关键词）到 v2 的 `text`+`summary` 结构；8.2 节所废的
  显式 `keywords` 字段由 FTS 直接索引两列承担，检索侧参数不变。
- 上位文档第十一节引用的 `global-memory-storage-search-design.md` 从未落盘；
  本方案的 2.2/2.3 节即两路召回聚合与排序算法的正式冻结，填补该空缺。

## 八、明确不做

- 不从 `query` 自动提取关键词补充 FTS 路；
- 不引入 ANN、原生向量扩展或独立向量服务（沿用全表精确 cosine）；
- 不为 FTS 表引入版本化迁移框架（派生索引可随时重建）；
- 不做记忆 mutation 工具的 FTS 同步（该工具面尚不存在）；
- 不改变 `MEMORY_SEARCH_LIMIT = 5` 的透出上限；
- 不实现 BM25 线性加权或任何需要归一化 bm25 的融合；
- 不改变 embedding 模型、维度与归一化流程；
- 不向 `tinker run` 注册记忆工具（v2 既定边界不变）。

## 九、实施清单

1. `contracts.ts`：`MEMORY_RECALL_CANDIDATE_LIMIT = 20`、`MAX_MEMORY_KEYWORDS = 8`、
   `MAX_MEMORY_KEYWORD_BYTES = 128`；`MemorySearchMatch` 增加 `via`；诊断类型扩展。
2. `memory-store.ts`：`memories_fts` 幂等创建/结构校验/重建/backfill；
   `insertBatch` 同事务同步；`searchFts(keywords)` 返回 bm25 排序候选。
3. `memory-coordinator.ts`：两路召回 + RRF 融合 + `via` 标记 + 2.4 降级语义 +
   诊断扩展。
4. `memory-search-tool.ts`：`keywords` 参数与校验（数量/字节/trim/短词丢弃）+
   工具描述更新。
5. `observation-builder.ts`：`via=` 透出、激活路径与降级标注。
6. 测试：FTS 表生命周期（创建/backfill/结构漂移重建）、既有 v2 库平滑打开、
   MATCH 构造与转义、短词丢弃、混合排序（双路命中优先、单路召回）、降级三
   情形、参数校验、观察渲染。
7. 质量门：`bun run check` 全量通过后方可视为完成。
