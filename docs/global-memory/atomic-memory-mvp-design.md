# 全局记忆：原子记忆 MVP 设计

## 文档状态

- 日期：2026-07-25
- 状态：已实现并验证
- 上位文档：
  [`high-level-decisions.md`](high-level-decisions.md)
- 目标：以最少能力验证“Turn 可以形成跨 Session 记忆，模型以后可以主动找回”这条闭环

本文是一个刻意收缩的可实施方案。上位文档仍描述全量产品方向；凡是本文明确暂缓的能力，
都不属于 MVP，不能为了未来兼容而提前加入字段、抽象或入口。

## 一、结论

MVP 只实现下面一条链路：

```text
TUI completed Turn
  -> 后台提炼 0..4 条原子记忆
  -> 为本 Turn 的安全候选批量生成 embeddings
  -> 在一个 transaction 中整批写入用户级全局 SQLite
  -> 后续 TUI Turn 中由模型调用 MemorySearch
  -> 对 query 做 embedding 并返回最相近的记忆
```

MVP 的基本存储单位是一条原子记忆。它是一句简短、自包含、可被直接检索和使用的陈述。

MVP 不保存 `keywords`，不保存独立的 `content`，也不建立“Memory 下挂多个
semantic cue”的层级。数据库里除来源和完整性所需元数据外，唯一的记忆正文就是
`text`。

`semantic_cue` 在完整方案中表示“用于召回另一份完整正文的语义线索”。MVP 没有这层
间接关系，因此当前不使用 cue 作为数据模型术语。未来引入独立 content 时，再通过 schema
migration 拆分 `text` 和 `semantic_cue`。

模型侧只注册一个工具：

```ts
MemorySearch {
  query: string
}
```

该工具只在 TUI 创建的 RuntimeSession 中存在。`tinker run` 看不到它，也不参与自动提取。

## 二、要验证的产品假设

MVP 只回答三个问题：

1. completed Turn 能否在不阻塞当前对话的情况下稳定形成少量长期记忆；
2. 原子记忆的向量搜索能否让模型在另一个 Session、另一个 workspace 中找回有用信息；
3. 这条能力是否值得继续扩展为关键词、正文、管理和整理系统。

## 三、范围

### 3.1 MVP 包含

- 只从 TUI 的 completed Turn 自动提取；
- 每个 completed Turn 产生 0 到 4 条原子记忆；
- 所有 Turn 固定使用显式配置的 `memory.profile` 提取；
- 记忆文本使用独立的 `memory.embedding` 生成 embedding；
- 所有 workspace 共用一个用户级 SQLite；
- 精确 cosine 搜索；
- TUI 模型可见的 `MemorySearch`；
- 单进程、并发度为 1、最多一个 active 和一个 pending 任务的 best-effort worker；
- 精确重复记忆的幂等写入；
- 必需的敏感信息拒绝和来源标记；
- 一个 JSONL 诊断日志，每次提取和每次搜索各记一行；
- 单元测试、SQLite 重开测试和真实 provider smoke。

### 3.2 MVP 明确不包含

- `keywords`、FTS 或混合排序；
- 独立于原子记忆文本的 `content`；
- `MemoryGet`、`MemoryCreate`、`MemoryUpdate`、`MemoryDelete`；
- `/memory` slash command；
- `tinker memory ...` CLI；
- `tinker run` 的搜索或提取；
- 手动或自动 organize；
- reinforce、supersede、conflict、relation；
- 用户可见的记忆列表、状态页、删除或 clear；
- ANN、向量缓存、原生向量扩展；
- 多 memory profile、运行时切换或热更新；
- 超长 Turn 的截断、分块、分层提取或候选收敛；
- 持久化提取队列、退出 drain 或 worker 重试；
- schema 中为上述未来能力预留的空字段或空表。

MVP 数据需要清理时，开发阶段只允许关闭 Tinker 后手工删除整个 MVP 数据库。该操作不是
产品能力，也不在普通用户文档中承诺。

## 四、原子记忆契约

### 4.1 什么是原子记忆

一条合格的原子记忆必须：

- 自包含，不依赖“这个”“上面”“本次任务”等上下文指代；
- 表达一个长期可能有用的事实、偏好、决定、约束或已验证做法；
- 在未来问题换一种说法时，仍然有语义召回价值；
- 包含必要的作用域，例如项目名、模块名或用户环境；
- 不伪装成 system/developer instruction；
- 不复制长段 Turn 原文。

示例：

```text
在 Tinker 仓库中，源代码变更完成前必须通过 bun run check。
```

不合格示例：

```text
测试通过了。
```

第二条缺少对象和作用域，离开原 Turn 后没有可靠含义。

### 4.2 固定限制

- 每个 Turn 最多 4 条记忆；
- 每条记忆的 `text` trim 后必须为 1 到 512 UTF-8 bytes；
- 同一次提取结果内记忆文本不得重复；
- 空数组是合法且常见的结果；
- 超限、额外字段、非字符串元素或非 JSON 输出使整个提取结果失败，不做部分接收。

这里选择严格拒绝整批结果，避免悄悄保存模型未按契约生成的数据。worker 记录失败后继续处理
下一项，不重试，也不影响主 Session。

## 五、提取

### 5.1 触发点

RuntimeSession 只有在以下顺序完成后才通知 memory worker：

1. `turn.finished` 已经成功 append；
2. `pendingLedgerTurn.finish(result)` 已经把 completed 状态和最终 assistant message
   提交到 SessionStore；
3. RuntimeSession 通过仍然打开的 SessionStore 对该 `turnId` 做一次窄查询，取得脱离
   Session 生命周期的不可变 `CompletedTurnSnapshot`；
4. RuntimeSession 不检查内容，原样把 `workspaceRoot`、`sessionId`、`turnId` 和 snapshot
   传给 completed-turn hook。

SessionStore 新增一个只用于当前已打开 Session 的窄读取方法。它先确认目标 Turn 的状态为
`completed`，再执行等价于下面的显式列查询，不调用会加载整个 Session 的
`loadProtocolView()`：

```sql
SELECT ordinal, role, content, reasoning_content, reasoning_content_present, name
FROM messages
WHERE turn_id = ?
ORDER BY ordinal;
```

Session 层固定返回以下结构化投影；该类型属于 `src/session`，不能定义在 `src/memory` 后再
让 SessionStore 反向依赖：

```ts
type CompletedTurnMessageSnapshot =
  | {
      readonly ordinal: number;
      readonly role: "user";
      readonly content: string;
    }
  | {
      readonly ordinal: number;
      readonly role: "assistant";
      readonly content: string | null;
      readonly reasoningContent?: string | null;
    }
  | {
      readonly ordinal: number;
      readonly role: "tool";
      readonly name: string;
      readonly content: string;
    };

type CompletedTurnSnapshot = {
  readonly messages: readonly CompletedTurnMessageSnapshot[];
};
```

SessionStore 在返回前完成 SQLite snake_case 到 TypeScript camelCase 的映射、
`safeIntegers` 到普通安全整数的转换、角色对应字段校验，以及对象和数组冻结。它不识别
`MemorySearch`，不删除任何 tool row，不拼接提取文本，也不把数据库 row、连接或 BigInt
暴露给调用者。user message 的 canonical `content` 已经在图片 attachment 位置包含
`[Image #N]` 字面量，因此不读取 image attachment 或 image asset 表。

这次同步读取发生在主 Turn 已经提交完成之后，只做一次当前 Turn 范围内的本地 SELECT，不
执行模型或网络工作。snapshot 查询、映射或 hook 调用失败时，RuntimeSession 在本地捕获并
跳过本次提取；同一可选 memory integration 以 best-effort 方式记录
`completed_turn_snapshot_failed` 或 `completed_turn_enqueue_failed`，诊断记录自身失败也被
吞掉，不得使已经 completed 的 Turn 或 RuntimeSession fault。

hook 的实现在 `src/memory`。它接收结构化 snapshot 后同步过滤、拼装
`extractionEvidenceText`，再把文本放入有界 worker 任务。hook 不接收 SessionStore、数据库
连接或延迟读取闭包，也不执行模型、embedding 或全局 memory 数据库工作。

该 hook 是 RuntimeSession 的可选依赖，只由 `runTui` 注入。one-shot runner 不注入，因此
既不会提取，也不会意外启动 worker。RuntimeSession 不导入 memory 模块、memory tool name
或任何 `MemorySearch` 过滤规则。

### 5.2 worker 所有权

`runTui` 为整个交互式进程创建一个 `MemoryCoordinator`：

- 它在 Session 创建、恢复和切换之外；
- 同一 TUI 进程中的所有 RuntimeSession 共用它；
- 同时最多有一个正在处理的 active 任务和一个尚未开始的 pending 任务；
- 没有 active 任务时，新任务立即成为 active；
- 已有 active 任务时，新任务成为 pending；如果 pending 已存在，则用最新任务替换它；
- active 完成后，当前 pending 成为下一个 active；
- TUI 退出时取消 active 并丢弃 pending，不等待 drain；
- Session 切换不会创建第二个 worker。

active 和 pending 任务都只保存已经构造完成的 `extractionEvidenceText` 及
`workspaceRoot + sessionId + turnId`，不保存 SessionStore、RuntimeSession、数据库连接或
`CompletedTurnSnapshot`、图片 asset。任务形成后与来源 Session 的 dispose、恢复和切换时序
完全解耦。

`MemoryCoordinator` 在 TUI 启动时根据固定 `memory.profile` 创建并持有自己的 extraction
client；它不接收、持有或复用任何 RuntimeSession 的 model client。`/model`、`/resume`
和 `/clear` 创建或销毁 Session 时，都不改变 coordinator 的 client，也不改变 active 或
pending 任务的提取模型。

### 5.3 提取输入

completed-turn hook 在 `src/memory` 内把 5.1 的结构化 `CompletedTurnSnapshot` 投影为
`extractionEvidenceText`。最终向提取模型提供该 completed Turn 中模型实际看到的完整文本
证据，按 canonical 顺序包括：

- user message 的 canonical 文本；
- 所有 assistant message 的 content 和 reasoning content；
- 除 `MemorySearch` 外的所有 tool observation；
- 来源 workspace realpath。

被明确过滤掉的 tool 结果只有 `MemorySearch` 的 observation。hook 在把
`extractionEvidenceText` 放入 worker task 前，依据 tool row 的 `name` 与 memory 模块自己的
固定 `MEMORY_SEARCH_TOOL_NAME` 常量完成过滤；RuntimeSession 和 SessionStore 都不知道该
常量。不能只靠提取 prompt 要求模型忽略，这样可以避免搜索得到的旧记忆被下一轮提取直接
复制回记忆库。

提取请求是纯文本的，不携带图片。canonical user message 的 content 本身已经在 attachment
位置包含 `[Image #N]` 字面量，因此文本证据里保留了“此处有一张图片”这一事实，只是不包含
像素。提取器据此可以判断自己看不到什么；这不是静默降级，也不需要读取 image asset。
含图片的 Turn 照常提取，不因 `memory.profile` 缺少 image input 而跳过。

MVP 选择丢弃图片而不是跳过整个 Turn，原因是：图片 Turn 中可沉淀的长期事实（项目约束、
用户偏好、验证过的做法）几乎都在文字和 tool observation 中；真正只存在于像素里的结论
通常依赖指代，本来就会被 4.1 的自包含要求拒绝。跳过整个 Turn 反而会让“配置一个便宜的
text-only 提取模型”这一合理选择静默关闭所有含图 Turn 的提取。

system/developer/project instructions、之前的 Turn 和当前 context 中为了运行 agent 而加入
的其他内容不属于来源 Turn，不额外注入提取请求。工具侧提供的是已经进入 canonical
history、模型实际看到的 observation，不读取只用于内部诊断的 raw result。

完整 Turn 文本让提取器可以利用验证过程、命令结果和中间推理，而不是只能根据最终回答猜测
结论。输入更完整不代表应生成更多记忆；是否写入仍由下一节的宁缺毋滥策略决定。

### 5.4 提取请求与输出

提取是一次无工具的独立模型请求，使用固定 `memory.profile`。它不进入 agent loop，不写入
canonical history，也不发布普通 Turn 事件。

构造完整提取 messages 后，先由固定 extraction client 执行 `prepare({ messages, tools: [] })`，
再只使用现有 model 层的本地静态估算：

```ts
const rawInputTokens = estimatePromptSegments(
  prepared.promptSegments,
).totalTokens;
const estimatedInputTokens = Math.ceil(
  rawInputTokens * INITIAL_CORRECTION_FACTOR,
);
```

`MemoryCoordinator` 持有创建 extraction client 时已经解析好的 `contextBudget`。如果
`estimatedInputTokens > contextBudget.inputBudgetTokens`：

- 跳过整个 Turn 的记忆提取；
- 不截断、不分块，也不只提取其中一部分；
- 不发送 extraction provider request，不生成候选记忆；
- 记录 `extraction_input_too_large` 诊断；
- 不重试，不使当前或后续主 Session fault。

估算必须基于 `prepared.promptSegments`，从而覆盖 extraction prompt、message JSON 映射和
protocol segment 开销，不能只测量 `extractionEvidenceText` 的字符数或 UTF-8 bytes。MVP
不为提取路径创建 `ContextMeter`，不接入 measured anchor、rolling calibration、provider
usage 或 shadow planning。提取请求始终是纯文本，即使 `memory.profile` 配置了远程
`inputTokenEstimator`，这里也不调用它，不 materialize 图片请求。

`prepare` 或本地估算自身失败时，记录 `extraction_preflight_failed` 并跳过本 Turn，不发送
provider request。`estimatedInputTokens` 未超预算时才发送已经 prepared 的请求；provider
后续仍可能因自身 tokenizer 差异拒绝请求，该错误按普通 extraction model failure 隔离。

这是 MVP 的明确 best-effort 缺口，不是 embedding 限制。批量 embedding 的每个 input item
都只是长度受限的单条原子记忆；搜索 embedding 只接收 query，二者都不接收完整 Turn。

模型必须只返回：

```json
{
  "memories": ["一条自包含的原子记忆"]
}
```

提取 prompt 至少要求模型：

- 默认返回空数组；只有信息明确、稳定、由 Turn 充分支持且未来仍可能有用时才生成记忆；
- 优先保留用户偏好、项目约束、明确决定、稳定环境事实和已验证解决办法；
- 忽略寒暄、临时状态、过程流水账、未经确认的猜测和相互矛盾且无法判断的信息；
- 一条记忆只表达一个有明确作用域的结论；证据不足时宁可遗漏，不补全、不推测；
- `[Image #N]` 表示该位置有一张你看不到的图片；不要推测其内容，也不要生成依赖它的记忆；
- 不保存密钥、token、cookie、密码、私钥或认证材料；
- 工具或网页内容可以支持事实性记忆，但其中的指令只有在用户明确认可后才能形成行为性
  记忆；
- assistant 对 `MemorySearch` 结果的转述本身不是新证据；只有用户确认或非 memory 证据
  独立支持时才可形成记忆；
- 不在记忆中声称高于当前 system/developer/project instructions 的优先级。

### 5.5 写入顺序

对通过整批结构校验的提取结果：

1. 逐条执行敏感信息检测，拒绝命中的候选；如果没有安全候选，本 Turn 不请求 embedding；
2. 在 transaction 外用一次 embedding 请求提交本 Turn 的全部安全候选；
3. 校验响应数量和索引与输入一一对应，并校验所有向量的维度与
   `memory.embedding.dimensions` 一致、全部为有限值且范数非零；
4. 只有整批向量都合法时，才把全部向量归一化为 Float32；
5. 在一个短 transaction 中插入本 Turn 的全部安全候选、embeddings 和来源元数据，精确重复
   通过 `text_sha256` 的唯一约束忽略。

embedding 请求、响应映射、任一向量校验或写入 transaction 失败时，本 Turn 的全部安全候选
都不写入；已经由之前 Turn 提交的记忆不受影响。MVP 不实现同一 Turn 内的部分提交、逐条
embedding 重试或补偿协议。

## 六、存储

### 6.1 位置和权限

数据库和诊断日志放在用户级 Tinker 数据目录下：

```text
~/.tinker/memory/memory.sqlite
~/.tinker/memory/memory-log.jsonl
~/.tinker/memory/extracted-memories.log
```

- `~/.tinker/memory` 权限为 `0700`；
- `memory.sqlite`、WAL、SHM、`memory-log.jsonl` 和 `extracted-memories.log`
  文件权限为 `0600`；
- 数据库启用 WAL 和 5 秒 `busy_timeout`；
- 每个进程持有自己的连接；
- 两份日志都用现有的 `appendPrivateFile` 追加写，不新增日志框架、轮转或配置项。

如果仓库在实现时已经有统一的用户级数据目录解析器，应复用该解析器；否则只新增一个明确的
memory path helper，不引入通用路径框架。

### 6.2 schema v1

```sql
CREATE TABLE memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO memory_meta(key, value) VALUES ('schema_version', '1');
INSERT INTO memory_meta(key, value) VALUES ('embedding_profile', ?);
INSERT INTO memory_meta(key, value) VALUES ('embedding_kind', ?);
INSERT INTO memory_meta(key, value) VALUES ('embedding_model', ?);
INSERT INTO memory_meta(key, value) VALUES ('embedding_dimensions', ?);

CREATE TABLE memories (
  memory_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL UNIQUE,
  embedding BLOB NOT NULL,
  source_workspace TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX memories_created_at
ON memories(created_at DESC);
```

约束：

- `memory_id` 使用 UUIDv7；
- `text_sha256` 基于 trim 后的原始记忆文本 UTF-8 bytes；
- `UNIQUE(text_sha256)` 只消除完全相同的记忆；
- 相似但不完全相同的记忆允许共存；
- `memory_meta` 中的 embedding profile name、kind、model 和 dimensions 来自首次创建
  数据库时的 `memory.embedding`；
- 后续启动时 `memory.embedding` 的这四个字段必须与数据库一致，`apiKey` 可以正常轮换，
  `apiBase` 可以在保持同一模型语义时改用代理；保持 name 表示用户确认代理前后仍是同一
  embedding 空间；
- embedding dimensions 是整个数据库所属 embedding space 的常量，只存于
  `memory_meta.embedding_dimensions`，不在每条 `memories` row 中重复保存；
- 不增加 `keywords`、`content`、`version`、`status`、`generation` 或 relation 字段；
- v1 只接受精确 schema version，不做旧版迁移，因为 MVP 之前没有正式 memory schema。

打开数据库时校验 schema、权限、embedding identity，并确认 metadata 中的 dimensions 是
合法正安全整数。open 不扫描 `memories.embedding`，因此启动成本不随记忆数量线性增长。
结构错误或当前 profile 与已有向量不兼容时，当前进程不启用 memory，但 TUI 继续启动；系统
不自动重建、混用或静默丢数据，并显示一次纯 TUI 本地提示。MVP 不提供 re-embed；开发阶段
需要更换 embedding 模型时，关闭 Tinker 后删除整个 MVP 数据库重新积累。

首次 schema v1 创建也是 schema initialization，必须与未来 migration 使用相同的
`BEGIN IMMEDIATE` 串行化边界：

1. 打开连接并设置 5 秒 `busy_timeout`；
2. 在 transaction 外启用并验证 WAL mode；
3. 执行 `BEGIN IMMEDIATE`；
4. 取得写锁后重新读取 schema 状态；
5. 空数据库在同一个 transaction 中创建全部 table、index 和 `memory_meta`；
6. 已初始化数据库在锁内读取 schema version 和 embedding identity；
7. 成功时 `COMMIT`，任何失败都 `ROLLBACK`。

不能用锁外的“数据库是否为空”判断决定初始化，也不能用 `CREATE TABLE IF NOT EXISTS`
代替串行化。后者无法保证多条 metadata 与 schema 原子提交，还可能掩盖不兼容结构。
`PRAGMA journal_mode = WAL` 不能放进 active transaction；它与等待写锁任一步骤超过
`busy_timeout` 都按 Memory 初始化失败处理。

两个进程同时首次启动时，第二个进程等待写锁，取得锁后必须重新读取状态并按“已初始化”
路径验证，不能继续执行等待前选定的创建路径。如果等待超过 5 秒，本次 Memory 初始化按
第十节降级：当前进程不创建 coordinator、不注册工具并显示一次 notice，TUI 继续启动。

如果并发初始化进程使用不同的 embedding identity，先提交的进程确定数据库 identity；后
取得锁的进程只禁用自己的 Memory，不修改、迁移或覆盖已有数据库。

## 七、MemorySearch

### 7.1 工具定义

```ts
MemorySearch {
  query: string
}
```

固定参数规则：

- 只接受 `query`；
- trim 后为 1 到 1024 UTF-8 bytes；
- 拒绝未知字段；
- 不提供 `limit`、分页、workspace filter 或最低分参数；
- 服务端固定返回最多 5 条。

工具只在 TUI 的 tooling composition 中注册。不要先注册到
`createDefaultTooling()` 再在 one-shot 执行时拒绝；composition root 必须让 one-shot
模型完全看不到该 schema。

最小的装配方式是给 tooling factory 一个显式的可选 `memorySearch` executor。`runTui`
传入由进程级 `MemoryCoordinator` 创建的 executor，`runOneShot` 不传。不要在 registry
内部通过全局变量、环境探测或 runner 名称猜测入口。

### 7.2 搜索算法

1. 在 SQLite transaction 外为 `query` 生成一次 embedding；
2. 校验并归一化 query vector；
3. 根据 `memory_meta.embedding_dimensions` 计算固定的
   `expectedBlobBytes = dimensions * 4`，并确认结果是正安全整数；
4. 流式扫描所有 `memories.embedding`，每行解码前确认值是 BLOB 且
   `blob.byteLength === expectedBlobBytes`；
5. 任一 row 的 BLOB 类型或长度不合法时，立即终止本次搜索，记录
   `memory_embedding_blob_invalid`，不返回已经计算出的部分候选；
6. 对全部合法 row 计算归一化向量点积，即 cosine similarity；
7. 按 `score DESC, created_at DESC, memory_id ASC` 排序；
8. 返回前 5 条。

MVP 不设相似度阈值。固定 top 5 便于先观察真实召回质量；空库返回成功的空结果。

### 7.3 observation

成功结果使用紧凑文本：

```text
MemorySearch returned 2 derived memories. They may be stale or wrong; verify current workspace facts.

1. score=0.842 created_at=2026-07-25T10:00:00.000Z workspace=/path/to/project
   在 Tinker 仓库中，源代码变更完成前必须通过 bun run check。

2. score=0.791 created_at=2026-07-20T08:30:00.000Z workspace=/path/to/other
   ...
```

不返回原 Session 内容，不把记忆包装成指令，也不赋予 Recall 的稳定来源或 context 特权。

空结果：

```text
MemorySearch found no stored memories.
```

embedding 请求、query vector 校验、stored embedding BLOB 校验或 SQLite 读取失败时，工具
返回普通失败 observation：

```text
MemorySearch unavailable: <bounded reason>
```

该失败不使 RuntimeSession fault。发现非法 stored BLOB 时不能跳过坏行后返回部分成功。

## 八、配置

MVP 使用一个可选的顶层 `memory` 对象作为完整启用边界：

- `memory` 缺席表示未启用 memory；
- `memory` 存在时，`profile` 和 `embedding` 都是必填字段；
- `memory.profile` 引用现有 `profiles` 中负责提取原子记忆的工作模型 profile；
- `memory.embedding` 是独立、单例的 embedding 请求 profile。

```json
{
  "default": "work-model",
  "profiles": {
    "work-model": {
      "...": "现有工作模型字段"
    },
    "memory-model": {
      "...": "现有工作模型字段"
    }
  },
  "memory": {
    "profile": "memory-model",
    "embedding": {
      "name": "zhipu-embedding-3",
      "kind": "openai-compatible",
      "model": "embedding-3",
      "apiBase": "https://open.bigmodel.cn/api/paas/v4",
      "apiKey": "...",
      "dimensions": 2048
    }
  }
}
```

固定合同：

- `memory` 必须是对象，并且只允许 `profile` 和 `embedding` 两个字段；
- `memory.profile` 与 `memory.embedding` 都必填；`memory` 空对象或缺少任一字段都不是关闭
  memory 的方式，而是配置错误；
- `memory.profile` 必须是非空字符串，并精确引用 `profiles` 中一个合法 profile；
- `memory.profile` 不要求支持 image input；提取输入是纯文本，text-only 模型完全可用；
- `memory.embedding` 必须是对象，缺少必填字段或包含未知字段都属于配置错误；
- `MemoryCoordinator` 在 TUI 启动时解析一次 `memory.profile` 并创建自己的 extraction
  client，同时持有该 profile 已经派生的 context budget；运行期间不重新读取配置；
- `/model`、`/resume` 和 `/clear` 不改变当前进程的 `memory.profile`；
- RuntimeSession 与 coordinator 分别创建和拥有自己的 model client，不共享实例；
- `memory.embedding.name` 是非空稳定标识，用于确认数据库中的既有向量仍属于同一
  embedding 空间；
- `memory.embedding.kind` 在 MVP 中只接受 `"openai-compatible"`；
- `memory.embedding` 的 `model`、`apiBase` 和 `apiKey` 是非空字符串；
- `memory.embedding.dimensions` 是正整数；
- client 向 `${memory.embedding.apiBase}/embeddings` 发送请求；
- timeout 和已有 model client 范围内的 retry 使用代码常量，不增加配置项；
- 顶层 `memory` 缺席时 memory 视为未启用，不提示；
- 顶层 `memory` 存在但不是对象、缺少任一子字段、引用不存在的 profile 或任一字段错误时，
  TUI 启动 fast-fail；
- env-only 模式没有顶层 `memory` 配置，因此 MVP 暂不提供 memory。

MVP 只需要同时维护一套可比较的全局向量，因此不增加 `embeddingProfiles` map、default
选择或运行时切换。单例 profile 已经消除了工作模型命名耦合；只有实际出现多套全局记忆库
或 re-embed 需求时，才值得扩展为多 profile。

固定 `memory.profile` 可能与当前 Session 使用不同供应商。完整 Turn 文本会发送给
`memory.profile` 对应的供应商（图片不发送），这是用户通过显式配置作出的隐私选择；Tinker
不自动选择或改写该 profile。

## 九、组件边界

建议新增：

```text
src/memory/
  memory-coordinator.ts
  memory-store.ts
  memory-extractor.ts
  embedding-client.ts
  vector.ts
  memory-search-tool.ts
  memory-log.ts
  contracts.ts
```

职责：

- `MemoryCoordinator`：接收结构化 `CompletedTurnSnapshot`，过滤 `MemorySearch` 并投影
  `extractionEvidenceText`；同时负责进程级 active/pending 状态、取消、提取编排、固定
  extraction client 及其 context budget、embedding client 和工具 executor 所有权；
- `MemoryStore`：全局 SQLite、schema、权限、短 transaction、向量流式读取和逐 row BLOB
  类型/长度校验；
- `MemoryExtractor`：构造并 prepare 纯文本提取请求，执行本地静态 input preflight，并严格
  解析 `{ memories: string[] }`；
- `EmbeddingClient`：按独立 profile 发送 OpenAI-compatible 单条 query 或批量候选
  embedding 请求、校验响应和隔离错误；
- `vector.ts`：Float32 编解码、归一化和点积；
- `memory-search-tool.ts`：参数解析、固定 top 5 和 observation；
- `memory-log.ts`：按 10.5 的形状调用现有 `appendPrivateFile` 追加一行并吞掉自身失败；
- `contracts.ts`：memory 内部的固定限制和共享类型；Session 层的
  `CompletedTurnSnapshot` 不定义在这里。

现有层的改动控制在：

- `src/cli/tui-runner.tsx`：初始化 memory；成功时创建和销毁唯一的
  `MemoryCoordinator` 并注入每个 TUI Session，store 不可用时向 App 传递一次本地
  `memory disabled` notice；
- `src/agent/runtime-session.ts`：completed Turn 提交后从现有 SessionStore 取得结构化
  `CompletedTurnSnapshot`，不检查内容并原样传给可选 hook；快照或 hook 失败必须局部隔离，
  且该层不依赖任何 memory 类型、tool name 或过滤规则；
- `src/session/session-store.ts`：定义结构化 `CompletedTurnSnapshot`，增加按 `turn_id`
  读取 completed Turn canonical message 字段的窄查询并完成字段映射、校验和冻结，不加载
  完整 Session，也不识别 `MemorySearch` 或拼接提取文本；
- `src/tools/registry.ts`：显式接收并注册可选 executor；
- `src/tools/types.ts` 与 observation 层：增加 `memory_search` raw result 和渲染；
- `src/cli/public-config-contract.ts` 与 `src/cli/model-profiles.ts`：声明并严格解析可选的
  顶层 `memory` 对象及其必填 `profile`、`embedding` 子字段；
- config/profile 装配：解析固定 `memory.profile`，由 coordinator 创建独立 extraction
  client，并把 `memory.embedding` 交给独立 embedding client；RuntimeSession model client
  不跨边界共享。

Memory 不进入：

- `src/context`；
- Session canonical history 的 schema；
- Recall reader 或 Recall index；
- TUI slash command 和面板；
- one-shot runner。

## 十、失败与生命周期语义

启动爆炸半径固定为：

| 状态                                     | TUI                           | Memory                            |
| ---------------------------------------- | ----------------------------- | --------------------------------- |
| 顶层 `memory` 缺席                       | 正常启动                      | 正常关闭，不提示                  |
| 顶层 `memory` 存在但违反配置合同         | 启动失败                      | 不初始化                          |
| `memory` 合法，但环境或全局 store 不可用 | 正常启动并显示一次本地 notice | 当前进程禁用，不注册工具或 worker |
| `memory` 合法，且环境和全局 store 可用   | 正常启动                      | 正常启用                          |

### 10.1 配置错误 fast-fail

顶层 `memory` 缺席表示用户没有启用 memory，不是错误。`memory` 存在即表示明确的启用意图；
以下配置合同错误使整个 TUI 启动失败：

- `memory` 不是对象，包含未知字段，或缺少 `profile`、`embedding` 任一必填字段；
- `memory.profile` 不是非空字符串或没有引用一个已有合法 profile；
- `memory.embedding` 不是对象、缺少必填字段或包含未知字段；
- `memory.embedding` 的 `name`、`model`、`apiBase` 或 `apiKey` 不是非空字符串；
- `memory.embedding.kind` 不是 `"openai-compatible"`；
- `memory.embedding.dimensions` 不是正整数；
- `memory.embedding.apiBase` 不是合法 URL。

这里的 fast-fail 只覆盖可以直接归因于用户显式配置的确定性错误。启动时不通过网络请求探测
provider，因此认证失败、endpoint 不可达或 provider 返回错误不属于启动配置错误。

### 10.2 Memory 初始化失败

合法配置不保证当前机器上的全局 memory store 可用。以下问题只禁用当前 TUI 进程的 memory，
不能阻止 Tinker 主 TUI 启动：

- memory 目录或数据库权限不安全；
- 目录或数据库无法创建、打开或写入；
- schema version 不支持或 schema 结构损坏；
- embedding profile identity 与已有数据库不一致；
- SQLite 无法启用 WAL 或 5 秒 `busy_timeout`。

初始化失败后遵循固定行为：

- 不创建 `MemoryCoordinator`，不启动 worker；
- 不向任何 RuntimeSession 注册 `MemorySearch`；
- TUI 显示一次 `memory disabled: <bounded reason>` 本地 notice；
- notice 不形成 agent Turn，不写 prompt history，不进入 canonical Session history；
- 完整错误写入诊断日志；
- 不自动 chmod 既有文件，不重建、迁移、删除或覆盖数据库。

Memory 初始化必须在创建首个 RuntimeSession 的 tool surface 之前完成，避免先注册工具再在
执行阶段拒绝。恢复旧 Session 时，现有 context surface refresh 负责接受
`MemorySearch` 缺席这一工具面变化。

### 10.3 运行时降级

以下错误只影响本次 memory 操作：

- completed Turn snapshot 的窄查询、字段映射或角色字段校验失败；
- memory hook 的 `MemorySearch` 过滤、文本投影或入队失败；
- 完整提取请求的 prepare 或本地静态估算失败；
- 本地估算超过当前提取模型的 input budget；
- 记忆提取模型失败或返回非法 JSON；
- 敏感信息检测拒绝候选；
- 批量 embedding 网络、响应映射或任一向量校验失败；
- 写锁等待超时；
- 本 Turn 的整批记忆写入失败；
- 搜索扫描到类型错误或长度不等于 `memory_meta.embedding_dimensions * 4` 的 stored
  embedding BLOB；
- `MemorySearch` 查询失败。

后台失败按 10.5 记入诊断日志；MVP 不为此新增状态面板。工具搜索失败通过 observation 立即
对模型可见。任何后台 memory 失败都不得改变当前 Turn 的 completed 状态。

### 10.4 退出

TUI 开始退出时：

1. coordinator 停止接收新任务；
2. abort active 任务的当前提取或 embedding 请求；
3. 丢弃 pending 任务；
4. 关闭全局 SQLite；
5. 继续既有 RuntimeSession/TUI 清理。

不等待 active 或 pending drain，不把未完成任务写到磁盘。

### 10.5 诊断日志

MVP 要验证的三个假设需要证据，而记忆库本身只能回答“存了多少”。因此每次提取和每次搜索
各向 `~/.tinker/memory/memory-log.jsonl` 追加一行 JSON，成功和失败共用同一形状，只靠
`outcome` 区分。这既是 10.2 和 10.3 所说的诊断日志，也是第十四节各项指标的唯一数据来源。

提取（每个开始处理的 active Turn 一行，含处理后的跳过；snapshot 构造失败或 memory hook
投影、入队失败也单独写一行）：

```json
{
  "at": "2026-07-25T10:00:00.000Z",
  "kind": "extraction",
  "outcome": "ok",
  "reason": null,
  "workspace": "/path/to/project",
  "turnId": "...",
  "inputTokens": 8421,
  "returned": 2,
  "written": 1,
  "rejected": { "duplicate": 1, "secret": 0, "invalid": 0, "embedding": 0 },
  "ms": 3120
}
```

搜索（每次 `MemorySearch` 调用一行）：

```json
{
  "at": "2026-07-25T10:05:00.000Z",
  "kind": "search",
  "outcome": "ok",
  "reason": null,
  "workspace": "/path/to/project",
  "sessionId": "...",
  "queryBytes": 64,
  "returned": 5,
  "scores": [0.842, 0.791, 0.688, 0.612, 0.59],
  "ms": 240
}
```

固定约束：

- 失败时 `outcome` 为 `failed` 或 `skipped`，`reason` 取已有的 bounded 错误码，例如
  `completed_turn_snapshot_failed`、`completed_turn_enqueue_failed` 或
  `extraction_preflight_failed`、`extraction_input_too_large`、
  `memory_embedding_blob_invalid`；计数字段照常填已知值，尚未形成 active task 或本地估算
  未完成时未知计数填 0；
- extraction 行的 `inputTokens` 是按 5.4 计算的 `estimatedInputTokens`，不是 provider
  usage，也不触发远程 token estimator；
- 10.2 的 Memory 初始化失败写一行 `kind` 为 `init` 的记录，只带 `outcome` 和 `reason`；
  若失败原因本身就是目录不可写，这行自然也写不成，按下一条吞掉；
- 不记录 query 原文、记忆正文或 Turn 内容。前两者可能含敏感信息，且记忆正文已在库中，可
  通过 `source_turn_id` 与提取行关联；
- 写日志失败只吞掉并继续，不影响提取、搜索或主 Session；
- 日志不轮转、不清理、不进入 TUI，删除整个 MVP 数据库时一并删除。

这些字段刚好覆盖第十四节的五项指标：记忆数量来自库内 `count(*)`；提取质量看
`returned`/`written` 配合按 `source_turn_id` 读库；主动工具调用率是 `search` 行数除以
`extraction` 行数；top-5 命中率的判定阈值来自 `scores` 分布；错误率是 `outcome != "ok"`
的比例。

### 10.6 开发期记忆正文日志

为了开发阶段能直接 `tail` 观察新记忆，每批 transaction 成功提交后，如果至少新增一条
memory，再向 `~/.tinker/memory/extracted-memories.log` 追加一个文本区块：

```text
[2026-07-26T01:03:42.616Z] workspace="/path/to/project" turn=... written=2
- 019f... | "One atomic memory."
- 019f... | "Another atomic memory."

```

固定约束：

- 只列出该 transaction 真正新增的 row；精确重复、secret 拒绝、embedding 失败或 transaction
  失败都不写正文，`written = 0` 时不产生空区块；
- 每条包含 `memory_id`，header 包含 `workspace`、`turn` 和新增数量，便于与
  `memory-log.jsonl` 及 SQLite 互相定位；
- workspace 和正文使用 JSON string 表示，换行及控制字符被转义为单行；数据库中的原文
  不变；
- memory store 初始化时先创建权限为 `0600` 的空文件，便于在首次新增记忆前启动
  `tail -f`；
- 每批只做一次 append；正文日志失败不回滚已经提交的 SQLite transaction，也不影响诊断
  日志或主 Session；
- 这是显式包含派生记忆正文的本地开发日志，不是指标数据源，不记录 prompt、tool observation、
  embedding、query 或被 secret detector 拒绝的内容。

## 十一、安全最低线

在生成 embedding 和写库之前，对完整记忆文本做确定性敏感信息检测。至少覆盖：

- 常见 API key 和 bearer token 形状；
- cookie/session token；
- password/secret 赋值；
- PEM private key；
- 同一个最小 detector 中已经覆盖的其他认证材料模式。

任一命中拒绝整条记忆。MVP 不用“遮盖后保存”，因为遮盖可能仍泄露上下文，也可能形成
无用记忆。

数据库结果进入模型 context 时必须始终带“derived、可能过期或错误”的说明。记忆不能
覆盖当前 system/developer/project instructions。

## 十二、实施顺序

### M1：存储和向量基础

- 用户级安全目录、SQLite schema 和 `memory-log.ts`；
- `BEGIN IMMEDIATE` 串行化首次 schema 创建；
- embedding BLOB 编解码、归一化、cosine；
- exact duplicate 幂等；
- 多连接 WAL/busy timeout；
- store 重开，以及 embedding BLOB decoder 拒绝非 BLOB 值和错误 byte length 的测试。

完成条件：不用 agent loop，也能插入若干记忆并稳定得到确定的 top 5。

### M2：只读搜索工具

- 独立 embedding profile 和 OpenAI-compatible embedding client；
- `MemorySearch` schema、执行和 observation；
- 仅 TUI 装配，one-shot surface 不出现该工具；
- 空库、provider 失败和 SQLite 失败路径。

完成条件：手工 seed 的记忆能在真实 TUI Turn 中被模型主动调用并取回。

### M3：completed Turn 自动提取

- SessionStore 结构化 `CompletedTurnSnapshot` 窄查询、RuntimeSession 原样透传 hook，以及
  memory 侧的 `MemorySearch` 过滤和 `extractionEvidenceText` 投影；
- 严格 memory extractor；
- 基于 prepared prompt segments 和固定初始保护系数的纯本地 input preflight；
- 每个 Turn 的安全候选只调用一次批量 embedding，并在一个短 transaction 中整批提交；
- 进程级 coordinator、一个 active 加一个可替换 pending 和退出取消；
- 仅 completed Turn 入队；
- 敏感信息和 MemorySearch 自我污染边界。

完成条件：在 workspace A 完成 Turn 后，workspace B 的新 Session 能通过
`MemorySearch` 找回自动形成的记忆。

不应把 M1 到 M3 拆成长期并存的半成品发布。M2 的手工 seed 只用于开发验证；MVP 对用户
成立的标准是 M3 的端到端闭环完成。

## 十三、测试与验收

### 13.1 自动测试

至少覆盖：

- 顶层 `memory` 缺失时不启动 memory，也不提示；
- 顶层 `memory` 存在但不是对象、包含未知字段、缺少 `profile` 或 `embedding`、profile 引用
  不存在，或任一子字段非法时 fast-fail；
- coordinator 创建并持有自己的 extraction client，不接收 RuntimeSession model client；
- profile A Session 的任务入队后切换到 profile B，提取仍使用固定 `memory.profile`；
- profile 的 name/model/dimensions 与已有数据库不一致时禁用 memory，但 TUI 正常启动；
- memory 权限、SQLite open、schema 或 WAL 失败时禁用 memory，但 TUI 正常启动；
- 初始化降级后不创建 worker、不注册 `MemorySearch`，并且只显示一次纯 TUI 本地 notice；
- memory 初始化 notice 不形成 Turn，不写 prompt history 或 canonical history；
- `apiKey` 轮换不影响打开已有数据库；
- schema 初始化写锁等待超过 5 秒时只禁用当前进程 Memory，TUI 正常启动；
- completed 触发，failed/cancelled/interrupted 不触发；
- completed Turn 提交后，SessionStore 窄查询只读取目标 `turn_id` 的结构化 canonical
  message 字段并按 `ordinal` 排序，不调用 `loadProtocolView()`，也不读取 image attachment
  或 image asset；
- SessionStore 返回的 `CompletedTurnSnapshot` 保留包括 `MemorySearch` 在内的全部 tool
  row，按角色投影字段，把 BigInt 转为安全整数，并冻结 records 和数组；
- RuntimeSession 把同一个 `CompletedTurnSnapshot` 原样传给 hook，不过滤 tool row、不拼接
  文本，也不依赖 memory 模块或 `MEMORY_SEARCH_TOOL_NAME`；
- completed Turn snapshot 查询、字段映射或校验失败，以及 memory hook 过滤、文本投影或
  入队失败时，已经 completed 的 Turn 与 RuntimeSession 均不 fault，并 best-effort 写一行
  对应 bounded reason 的提取诊断；
- memory hook 过滤 `MemorySearch`、保留其他 tool observation，并把投影完成的
  `extractionEvidenceText` 放入 active/pending task；任务不再持有 snapshot；
- 文本任务入队后立即 dispose 来源 RuntimeSession，active 或 pending 任务仍能使用
  coordinator client 完成，且不再访问来源 SessionStore；
- 一个 Turn 可产生 0、1、4 条记忆，5 条或非法 JSON 整批拒绝；
- 提取输入包含完整 user message 文本、所有 assistant content/reasoning、非 MemorySearch
  tool observation 和 workspace；
- `MemorySearch` observation 只在 memory hook 投影阶段被代码过滤，其他 tool observation
  保留；
- 提取 prompt 默认空数组，并明确要求证据不足时不生成记忆；
- 提取 preflight 使用 extraction client 产出的 `prepared.promptSegments`、
  `estimatePromptSegments` 和 `INITIAL_CORRECTION_FACTOR`，并与该 profile 已解析的
  `contextBudget.inputBudgetTokens` 比较；
- 提取 preflight 不创建 `ContextMeter`，不使用 anchor、calibration 或 provider usage；即使
  `memory.profile` 配置了远程 input token estimator，纯文本提取也不调用它；
- `prepare` 或本地估算失败时记录 `extraction_preflight_failed` 并整条跳过；估算超过 input
  budget 时记录 `extraction_input_too_large` 并整条跳过，二者都不发送 provider request、
  不截断、不写库；估算值等于 input budget 时允许发送；
- 含图片 Turn 保留 user message 中的 `[Image #N]` 占位符照常提取，不读取 image asset，
  也不因 `memory.profile` 缺少 image input 而跳过；
- coordinator 同时最多处理一个 active 和保留一个 pending；第三个任务到达时用最新任务
  替换原 pending，active 完成后只处理最新 pending；
- 退出取消 active 并丢弃 pending；
- 记忆文本 byte limit、精确 hash 幂等和 secret 拒绝；
- 没有安全候选时不调用 embedding；同一 Turn 有 1 到 4 条安全候选时只发送一次批量
  embedding 请求，并严格校验响应数量、索引、维度、有限值和非零范数；
- 批量 embedding 或任一向量校验失败时该 Turn 不写入任何候选；成功时在一个 transaction
  中提交全部安全候选，精确重复通过唯一约束忽略；
- 整批写入 transaction 失败时，该 Turn 不留下部分新增记忆；
- Float32 round-trip、非有限值、零范数、维度错误；
- cosine 排序和确定性 tie-break；
- stored embedding row decoder 拒绝非 BLOB 值，也拒绝 byte length 不等于
  `memory_meta.embedding_dimensions * 4` 的 BLOB，两种情况都产生
  `memory_embedding_blob_invalid`；
- SQLite 插入、读取、重复插入、WAL 多连接、重开和权限；
- `MemorySearch` 只接受 `query`，固定最多 5 条；
- TUI tool surface 包含 `MemorySearch`；
- one-shot tool surface 不包含 `MemorySearch`；
- 成功提取、跳过提取和成功搜索各写一行诊断日志，且不含 query 原文或记忆正文；
- 成功 transaction 只把真正新增的 memory ID 和正文写入 `extracted-memories.log`，重复、
  secret 拒绝及失败候选不写，并保持文件权限 `0600`；
- 写日志失败不影响提取、搜索和主 Turn；
- memory 运行时失败不使主 Turn fault。

以下两处只在契约层面覆盖，不再构造更大的集成测试，这是刻意的取舍，不是遗漏：

- 6.2 的并发 schema 初始化只保留写锁超时降级一条测试。barrier 同时首次初始化和不同
  embedding identity 的先后提交都是同一段 `BEGIN IMMEDIATE` 代码的必然结果，为它们构造
  双连接时序既难写又容易 flaky，收益不足以进入 MVP。
- 7.2 的非法 stored embedding BLOB 只测 decoder 本身。写入路径在 5.5 步骤 3 已经校验过
  维度，该失败只可能来自外部损坏或本 MVP 自身写入代码的 bug；整次失败、不返回部分结果的
  语义由 decoder 抛错加扫描路径的直线传播保证，不值得为它构造损坏数据库并穿过
  store、search 和 Turn 三层验证。

如果后续真实使用中出现上述任一失败，再补相应的集成测试。

源代码完成后必须运行：

```text
bun run check
```

### 13.2 真实 smoke

使用真实工作模型和配置的真实 embedding provider：

1. 在 workspace A 的 TUI 中完成一个包含明确长期偏好或项目决定的 Turn；
2. tail `~/.tinker/memory/memory-log.jsonl`，等到该 Turn 的 `extraction` 行出现，并确认
   `outcome` 与 `written`；
3. tail `~/.tinker/memory/extracted-memories.log`，确认新增区块的 `turn`、`written`、
   `memory_id` 和正文与数据库一致；
4. 退出并重新启动 Tinker；
5. 在 workspace B 开启新 Session；
6. 提出语义相关但措辞不同的问题；
7. 确认模型可见并调用 `MemorySearch`；
8. 确认返回正确记忆，且 observation 带来源与不可信提示；
9. 临时使 embedding 请求失败，确认搜索明确失败但主 Turn 仍可继续；
10. 检查数据库、WAL、SHM、两份日志和目录权限。

只通过 fake model、mock embedding 或直接查 SQLite，不能宣称 MVP 已完成。

## 十四、MVP 完成定义

以下条件全部满足才算完成：

- TUI completed Turn 能 best-effort 自动形成原子记忆；
- 全局库不保存 Turn 原文、keywords 或独立 content；
- 原子记忆跨 Session、跨 workspace 持久存在；
- TUI 模型只有一个 memory 工具 `MemorySearch`；
- one-shot 看不到任何 memory 工具，也不触发提取；
- 搜索使用真实 query embedding 和精确 cosine；
- 记忆失败不会破坏主 Session；
- secret 和持久化提示注入最低线已覆盖；
- 10.5 的诊断日志同时记录成功与失败的提取和搜索；
- `bun run check` 通过；
- 跨 workspace 的真实 provider smoke 通过。

完成 MVP 后先基于实际记忆数量、提取质量、主动工具调用率、top-5 命中率和错误率决定
下一步，全部按 10.5 末尾给出的口径从诊断日志和记忆库直接算出。没有这些数据前，不默认
进入完整高层方案；日志为空或样本过少时，结论是继续用，不是继续建。

## 十五、开放问题

### 15.1 超长 Turn 的记忆提取

一个 completed Turn 可能因为大量 tool observation 或长文本而超过当前提取模型的
context。MVP 按第五节合同跳过整个 Turn，不尝试恢复。

只有真实使用数据显示这类跳过达到不可接受的频率，才进一步设计处理方式。候选方向包括：

- 按 protocol Frame 或消息边界分块；
- 单独切分超大的 tool observation；
- 各块只生成临时候选记忆；
- 对候选执行一次或递归执行全局去重与收敛；
- 只把最终 0 到 4 条记忆写入数据库。

后续设计必须继续满足：不静默截断、不把中间候选写库、不突破每 Turn 最多 4 条记忆，也不
因为提取失败影响主 Session。MVP 不为这些方向预建接口或持久化结构。
