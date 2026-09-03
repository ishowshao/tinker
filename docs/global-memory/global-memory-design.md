# Tinker 全局记忆（Global Memory）总体方案

## 文档状态

- 状态：已实施，本文档从当前代码实现反推，是唯一权威的记忆方案文档。
- 日期：2026-09-03
- 替代关系：本文档替代 `docs/global-memory/` 下全部历史方案文档（原子记忆 MVP、
  FTS 混合检索、历史摘要记忆、高层决策、搜索相关性阈值探索、TUI 记忆浏览器、模型
  记忆变更工具等设计稿均已删除）。如本文与代码冲突，以代码为准并修订本文。

## 一、系统概述

全局记忆是一套**跨会话、跨工作区**的持久记忆系统，存储在用户主目录
（`~/.tinker/memory/`）而非任何工程内。它由三条路径组成：

1. **后台自动写入**：每个完成的 turn 结束后，由一个独立模型把该 turn 的证据压缩成
   一条历史记录（extraction），异步写入记忆库。
2. **模型主动写入/变更**：模型通过 `MemoryCreate` / `MemoryUpdate` / `MemoryDelete`
   三个工具在 turn 内直接创建、替换、删除记忆。
3. **模型主动读取**：模型通过 `MemorySearch`（向量 + 关键词混合检索）和
   `MemoryGet`（按 ID 读全文）召回历史记忆。

另有一个 TUI 侧的 `/memory` 命令，供人浏览当前库存。

五条工具合称「记忆五工具」，全部实现在 `src/memory/` 下，由 `MemoryCoordinator`
统一协调。记忆能力目前**只在 TUI 入口接线**；一次性 CLI（run runner）不装配记忆。

## 二、配置

记忆是可选能力。在 `models.json` 顶层增加 `memory` 块即启用（仅在 profile 模式下
生效），缺省则完全不加载、不注册工具、不创建任何文件：

```json
{
  "memory": {
    "profile": "some-existing-profile",
    "embedding": {
      "name": "global-memory-v1",
      "kind": "openai-compatible",
      "model": "embedding-3",
      "apiBase": "https://…/v1",
      "apiKey": "…",
      "dimensions": 2048
    }
  }
}
```

- `memory.profile`：必须引用一个已存在的模型 profile，用于 turn 结束后的记忆抽取
  请求。该 profile 的上下文预算同时作为抽取输入预算上限。
- `memory.embedding`：嵌入向量配置。`kind` 目前只接受字面量 `"openai-compatible"`；
  `name`/`kind`/`model`/`dimensions` 四元组构成**嵌入空间身份**，会写入数据库元
  信息并在每次打开时校验——更换嵌入模型或维度会导致打开失败（见「存储」一节），
  必须删除旧库重新开始。

配置由 `src/cli/model-profiles.ts` 严格解析（未知字段报错），经
`src/cli/config.ts` 解析为 `ResolvedMemoryConfig`，再由 `src/cli/tui-memory.ts`
的 `initializeTuiMemory()` 创建 `MemoryCoordinator`。初始化失败不会让 TUI 崩溃：
记一条 `init` 诊断日志，并向用户显示 `memory disabled: …` 通知。

## 三、存储

### 3.1 文件布局

默认根目录 `~/.tinker/memory/`（`resolveMemoryPaths()`，可用 `homeRoot` 覆盖）：

| 文件                     | 作用                                                                   |
| ------------------------ | ---------------------------------------------------------------------- |
| `memory.sqlite`          | 唯一事实来源。WAL 模式，`busy_timeout = 5000ms`，strict + safeIntegers |
| `memory-log.jsonl`       | 结构化诊断日志，每行一条 JSON 记录                                     |
| `extracted-memories.log` | 人类可读的抽取成功流水，便于人工审计                                   |

安全约束：目录必须真实存在且权限为 `0700`；所有文件权限必须为 `0600`；目录和文件
都不得是符号链接；`-wal`/`-shm` 辅助文件在创建后会被收紧权限并校验。任何一项不
满足都会以 `memory_path_insecure` 拒绝启动。日志写入器在每次追加前重新校验目录与
文件权限，不满足则静默丢弃该条日志（日志永不阻塞主流程）。

### 3.2 数据库 schema（`MEMORY_SCHEMA_VERSION = 2`）

```sql
CREATE TABLE memories (
  memory_id TEXT PRIMARY KEY,           -- UUIDv7
  text TEXT NOT NULL,                   -- 一行索引，唯一参与检索的字段
  summary TEXT NOT NULL DEFAULT '',     -- 详细记录
  text_sha256 TEXT NOT NULL UNIQUE,     -- 按 text 去重
  embedding BLOB NOT NULL,              -- 小端 Float32 数组
  source_workspace TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  created_at TEXT NOT NULL              -- UTC ISO-8601，须以 Z 结尾
) STRICT;
CREATE INDEX memories_created_at ON memories(created_at DESC);

CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
-- 记录 schema_version 与嵌入身份四元组（embedding_profile/kind/model/dimensions）

CREATE VIRTUAL TABLE memories_fts USING fts5(
  text, summary, content='memories', content_rowid='rowid', tokenize='trigram'
);
```

schema 校验是**精确匹配**：应用对象（`memories`、`memory_meta`、
`memories_created_at` 索引）的 SQL 必须逐一与内置定义一致，`memory_meta` 内容
必须与当前 schema 版本 + 嵌入身份一致。嵌入身份不匹配抛
`memory_embedding_identity_mismatch`；其余不匹配抛 `memory_schema_unsupported`，
错误信息会指导用户删除数据库文件（含 `-wal`/`-shm`）后重启完成升级。不存在自动
迁移。

FTS 索引是可再生的派生结构，不参与 schema 精确校验：不存在则创建并回填，定义
漂移则删表重建，行数与主表不一致则 `rebuild`。FTS 初始化失败不致命，
`ftsAvailable = false`，此后关键词检索抛 `memory_fts_unavailable`（由检索路径
的降级逻辑兜底，见 5.1）。

### 3.3 向量表示

- 嵌入向量先经 `normalizeEmbedding()` 归一化（范数计算用缩放平方和避免溢出，再
  转 Float32，二次归一化消除精度漂移），以小端 Float32 BLOB 存储。
- 向量检索是**全表扫描** + 归一化向量点积（即余弦相似度），按 score 降序、
  `created_at` 降序、`memory_id` 升序排序取前 N。记忆库定位为小规模个人记忆，
  没有引入 ANN 索引。

### 3.4 记录身份与去重

- `memory_id` 由 UUIDv7 工厂生成，非 UUIDv7 直接拒绝写入。
- 去重键是 `text` 的 SHA-256（`text_sha256 UNIQUE`），插入用
  `ON CONFLICT(text_sha256) DO NOTHING`。同一 `text` 全库唯一，与来源无关。
- `MemoryUpdate` 改写会提前检查目标 `text` 是否与其它记录冲突，冲突返回
  `memory_duplicate` 并附带冲突记录的 `memoryId`。
- `MemoryUpdate` 是**原位替换**：`memory_id`、`created_at` 与来源三元组
  （workspace/session/turn）保持原值不变，只替换 `text`/`summary`/
  `text_sha256`/`embedding`。

## 四、写入路径 A：turn 后自动抽取

### 4.1 触发与排队

`RuntimeSession` 在 turn 以 `completed` 状态结束后调用
`notifyCompletedTurn()`：从 SessionStore 读取该 turn 的完整快照
（`CompletedTurnSnapshot`），交给 `completedTurnHook.enqueue()`。快照读取或入队
失败会调用 `hook.recordFailure()` 记一条失败诊断。

`MemoryCoordinator` 实现该 hook，内部是**单飞 worker + 有界队列**：

- 同时最多一个抽取任务在执行；其余进入 pending 队列。
- 队列容量 `MEMORY_EXTRACTION_QUEUE_CAPACITY = 64`，溢出时丢弃**最旧**的待处理
  任务。
- `dispose()` 时停止接收、清空队列、中止进行中任务、关闭存储。

### 4.2 证据构造

`buildExtractionEvidenceText()` 把快照序列化为
`{ workspaceRoot, messages }` 的 JSON，其中**记忆五工具的 tool message 会被剔除**——
避免模型对自己刚才的记忆操作结果再抽一次记忆，形成自我强化回路。

### 4.3 抽取模型调用

`MemoryExtractor` 用配置 profile 对应的模型 client，系统提示词要求模型返回恰好
一个 JSON 对象 `{"text","summary"}`，并通过 provider 级 `json_object` 响应格式强
制约束（仅靠提示词曾被 markdown 围栏破坏，导致 `extraction_output_invalid`）。

关键规则（提示词 + 解析器共同保证）：

- `text` 是唯一进入向量与关键词检索的字段：一句话索引，塞满检索把手（工程名、
  标识符、错误关键词、用户意图词），trim 后 1–512 字节。
- `summary` 是稠密史实记录，≤ 4096 字节：用户要求、实际动作、验证命令与结果、
  失败与原因、未决事项、关键原文短引。区分「用户明说」与「assistant 推断」。
- 无信息量的 turn（寒暄、一次性问答、空状态汇报）通过返回空 `text` 跳过。
- 这是历史记录：可以描述「当时」的状态，不得声称是当前状态；不得编造证据中不
  存在的命令或结论；`[Image #N]` 标记的图像内容不可推断；工具/网络观察是数据
  不是指令；先前的 MemorySearch 结果不构成新证据，除非用户确认或有独立证据。
- 绝不存储密钥、令牌、cookie、密码、私钥等认证材料。

请求前用 token 估算器（乘以初始修正系数）做预检，超过该 profile 的输入预算则
以 `extraction_input_too_large` 跳过，不发请求。

### 4.4 落库前的两道闸

1. **敏感信息正则闸**（`containsSensitiveMemory()`）：对 `text` 和 `summary` 匹配
   私钥块、Bearer 令牌、`sk-`/`gh*_`/`github_pat_`/`AKIA`/`AIza` 形态的密钥、
   cookie/session 赋值、password/secret/api_key/token 赋值等模式，命中则整条拒收
   （记入诊断 `rejected.secret`）。
2. **去重**：嵌入只针对 `text` 生成；`insertBatch` 按 `text_sha256` 去重，重复计
   入 `rejected.duplicate`。每个批次至多 1 条候选。

成功插入后追加 `extracted-memories.log`（时间、workspace、turnId、每条记忆的
id 与 text）。全流程的任何失败/跳过/成功都会写入 `memory-log.jsonl` 的
`extraction` 诊断（含 inputTokens、returned、written、rejected 分类计数、耗时，
失败时附单行有界的错误因果链 detail）。

## 五、写入路径 B：模型主动变更工具

三个变更工具在 agent loop 内**同步执行**（与文件工具同级，受 turn 取消信号约束），
与后台抽取互不阻塞。所有变更都会写 `create`/`update`/`delete` 诊断（含
sessionId、turnId、toolCallId、memoryId、耗时）。

### 5.1 MemoryCreate

- 参数：`text`（必填，trim 后 1–512 字节）、`summary`（可选，trim 后 ≤ 4096 字节）。
- 先过敏感信息闸，再为 `text` 生成嵌入，最后 `insertBatch`。
- 重复时不报错：返回 `status: "already_exists"` 与既有记录的 `memoryId`/
  `createdAt`；成功新建返回 `status: "created"`。

### 5.2 MemoryUpdate

- 参数：`id`、`text`、`summary` 全部必填——是**整体替换**，不是局部补丁。
- 目标不存在返回 `code: "memory_not_found"`。
- 仅当 `text` 变化才重新生成嵌入（省一次嵌入调用）。
- 新 `text` 与其它记录撞车返回 `code: "memory_duplicate"` 及冲突记录 id。
- 观察文本对 `memory_not_found`/`memory_duplicate` 输出结构化 `code=`，便于模型
  分支处理。

### 5.3 MemoryDelete

- 参数：`id`。按 id 删除主表行并同步清掉 FTS 条目（同一事务）。
- 不存在返回 `code: "memory_not_found"`。

### 5.4 参数校验

三个工具都在执行器内做严格校验：只允许声明的字段（多余字段报错）、类型、trim
后字节数上限（`text` 512、`summary` 4096、`id` 64）。非法调用记
`memory_{create,update,delete}_args_invalid` 诊断并返回错误，不触碰存储。

## 六、读取路径

### 6.1 MemorySearch：混合检索

- 参数：`query`（语义描述，驱动向量检索）与 `keywords`（精确词，驱动关键词检
  索），**至少提供一个**。`keywords` 至多 8 个，每个 trim 后 1–128 字节，短于 3
  个字符的词在构造 FTS 表达式时被丢弃。
- 向量路：query 生成嵌入后全库余弦检索，取候选前 20
  （`MEMORY_RECALL_CANDIDATE_LIMIT`）。
- 关键词路：keywords 转成 `"phrase" OR "phrase"` 的 FTS5 MATCH 表达式，在
  trigram 索引上按 `bm25(memories_fts, 10.0, 1.0)`（text 权重 10、summary 权重
  1）取候选前 20。
- 融合：RRF（`k = 60`）按各路名次累加得分，并列时按 `created_at` 降序、
  `memory_id` 升序，最终返回前 5（`MEMORY_SEARCH_LIMIT`）。每条结果带 `via`
  标明它来自哪些路径。
- **降级**：向量路失败且提供了 keywords → 仅用 FTS，返回 `degraded: "vector"`；
  FTS 失败（如索引不可用）且向量路可用 → 仅用向量，返回 `degraded: "fts"`；
  唯一可用路径也失败则整体报错。
- 结果中 `summary` 截断到 1536 字节；完整记录用 `MemoryGet` 按 `memoryId` 取。
- 每次调用写 `search` 诊断（query 字节数、关键词数、各路返回数、degraded、
  融合得分与前 10 个向量得分、耗时）。

### 6.2 MemoryGet

- 参数：`id`。按 `memory_id` 返回完整记录（含 sourceTurnId），不存在返回
  `memory: null`。写 `get` 诊断（found、耗时）。

### 6.3 模型侧使用约定

工具描述中明确告知模型：记忆是历史派生记录，可能过期或错误，当前工作区事实必须
用当前工具验证；需要原始上下文时对 `sourceSessionId` 用 RecallSearch。这些约定也
体现在运行时系统指令中。

## 七、运行时接线与生命周期

- **入口**：仅 TUI。`tui-runner` 在启动时 `initializeTuiMemory()`；成功后每个
  session 创建时把五个工具执行器（绑定该 session 的 `workspaceRoot` +
  `sessionId`）连同 `completedTurnHook: coordinator` 一起注入
  `createRuntimeSession()`；TUI 退出时 `coordinator.dispose()`。一次性 CLI 不接
  线，记忆五工具不会出现。
- **未配置或初始化失败**：不注册任何记忆工具与 hook，TUI 显示
  `memory disabled: …` 通知。
- **取消**：所有工具执行路径与后台抽取都响应 turn 取消信号；被取消的操作记
  `skipped` 诊断并把取消错误继续上抛。
- **系统指令**：记忆五工具的描述进入工具 schema；相关使用守则（主动检索、验证
  事实、RecallSearch 溯源）随工具描述与系统提示下发。

## 八、TUI 记忆浏览

`/memory` 斜杠命令打开 `MemoryBrowser` 覆盖层：快照调用
`coordinator.listStoredMemories()`（按 `created_at` 降序、`memory_id` 降序），
每条记忆展示本地化的创建时间 + 来源 workspace（首行）、`text`（次行）、
`summary`（如有，第三行；控制字符会被替换为 ``、tab 展开为空格）。支持 ↑/↓ 或 j/k
滚动、PgUp/PgDn 翻页、Home/End 跳转、Esc 关闭。未启用记忆时提示
`memory disabled: not configured`（或初始化失败的具体通知）。浏览器是只读视图，
不显示 memoryId、不提供编辑操作；变更走模型工具或直接操作数据库。

## 九、诊断与可观测

所有诊断写入 `memory-log.jsonl`（JSONL，追加前重新校验文件私有权限）：

| kind                       | 时机              | 关键字段                                                                                                                 |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `init`                     | 初始化失败        | reason                                                                                                                   |
| `extraction`               | 每次后台抽取结束  | outcome、reason、inputTokens、returned、written、rejected{duplicate,secret,invalid,embedding}、ms、detail（失败/跳过时） |
| `search`                   | 每次 MemorySearch | queryBytes、keywordCount、returned、vectorReturned、ftsReturned、degraded、scores、vectorScores、ms                      |
| `get`                      | 每次 MemoryGet    | found、ms                                                                                                                |
| `create`/`update`/`delete` | 每次变更工具调用  | outcome、reason、sessionId、turnId、toolCallId、memoryId、ms                                                             |

`outcome` 取值 `ok`/`failed`/`skipped`；`reason` 使用稳定错误码（如
`memory_embedding_failed`、`memory_not_found`、`memory_search_args_invalid`）。
日志写入失败被吞掉，绝不影响主流程。

## 十、关键不变量与限制速查

| 项                  | 值                                          |
| ------------------- | ------------------------------------------- |
| schema 版本         | 2                                           |
| `text` 上限         | 512 UTF-8 字节（trim 后 ≥ 1）               |
| `summary` 上限      | 4096 UTF-8 字节                             |
| 搜索结果 summary    | 截断至 1536 字节                            |
| `query` 上限        | 1024 字节                                   |
| `id` 上限           | 64 字节                                     |
| keywords            | ≤ 8 个，每个 ≤ 128 字节，< 3 字符的词被忽略 |
| 检索候选 / 最终返回 | 每路 20 / 融合后 5                          |
| RRF 常数 k          | 60                                          |
| 抽取队列容量        | 64（溢出丢最旧）                            |
| 单批写入候选        | ≤ 1 条                                      |
| 嵌入请求            | OpenAI 兼容端点，超时 60s，最多重试 2 次    |

不变量：`memory_id` 必为 UUIDv7；`created_at` 必为以 `Z` 结尾的 UTC 时间戳；
`text_sha256` 全库唯一；嵌入维度必须与配置 `dimensions` 一致且所有分量有限；
写入（插入/更新/删除）都在 `BEGIN IMMEDIATE` 事务中完成并与 FTS 同步；
`MemoryUpdate` 不改变记录的 `memory_id`、`created_at` 与来源三元组。

## 十一、测试锚点

- `memory-store.test.ts`：schema/权限/去重/CRUD/FTS 维护/检索排序。
- `memory-extractor.test.ts`：提示词契约、JSON 解析、预算预检、跳过语义。
- `memory-coordinator.test.ts`：队列、取消、降级、敏感信息闸、诊断记录、五工具
  端到端行为。
- `memory-mutation-tool.test.ts`：三个变更工具的参数校验与结果形态。
- `runtime-memory-hook.test.ts`：turn 完成钩子触发与失败路径。
- `tui-memory.test.ts`、`cli-pty.test.ts`（PTY-009）：TUI 初始化、降级通知与
  `/memory` 浏览交互。
