# G0：Context Revision 实施前基准门禁

## 文档状态

- 日期：2026-07-16
- 状态：已完成
- 性质：基准与工程门禁，不改变 runtime 消息选择或 session 语义

## 一、目标

G0 在开发 Context Revision 与 shadow planner 前，恢复一套能随当前代码持续运行的基准，
避免使用已经删除的内存 conversation API 或手工复制旧版 SessionStore schema。

G0 必须回答四个问题：

1. 当前完整历史路径在长 session 下的存储、内存和请求构建成本是多少。
2. TUI projection 是否继续保持有界。
3. SessionStore、取消、resume 和 Recall 能否在同一个确定性 workload 中共同工作。
4. Recall 索引的构建、打开、搜索、分页读取和重建基线是否仍可重复。

## 二、确定性长会话基准

`scripts/bench-long-session-memory.ts` 使用临时 workspace 和当前生产路径：

```text
RuntimeSession
  -> SessionStore / SqliteSessionLedger
  -> OpenAI-compatible request serialization（不访问 provider）
  -> 默认 Read / Grep / Bash / Recall 工具
  -> ContextMeter
  -> JSONL / observation log
  -> TuiProjectionStore
```

默认 workload 为 50 个普通 turn。每个普通 turn 执行一个真实工具调用并产生终态回答，
工具按 Read、Grep、Bash 循环。基准还会：

- 在中点释放并 resume 同一个 session；
- 执行一个受控取消 turn，并验证后续 turn 仍可继续；
- 最后通过 RecallSearch -> get 找回第一轮的稳定 marker；
- 定期记录 RSS、heap、数据库大小、message 数和 TUI 可见项数量；
- 记录 active request 构建、provider serialization、TUI projection 和总耗时。

所有 fixture 都在临时目录生成，结束后删除。基准不得读取真实项目文件、访问 provider、
依赖 API key，或把个人 session 内容写入输出。

## 三、Recall 基准

`scripts/bench-recall.ts` 先通过当前 `SessionStore.createNew()` 创建数据库和 runtime
contract，再批量插入确定性 canonical messages。它不再手工构造 `session_meta` 或引用
特定历史 schema fingerprint。

默认规模保持 10,000 条消息和 100 次采样，继续记录：

- SQLite 与 FTS 空间增量；
- schema、SQLite integrity 和 Recall index 打开校验时间；
- 稀疏 trigram、密集 trigram 与单字符 substring 查询的 p50/p95；
- 20,000-byte `RecallGet` 的采样内存；
- Recall index rebuild + verify 时间。

## 四、本地历史 session 的使用边界

本机历史 session 只用于只读聚合校准，不作为测试输入：

- 可以统计 schema 版本、turn/message 数、各 role 字节量和 tool observation 分布；
- 不读取或输出 prompt、tool result 正文、session ID 或 workspace 私有路径；
- 不要求开发机一定存在这些数据；
- 不因为旧 schema session 无法 resume 而加入兼容迁移。

确定性 fixture 负责回归，本地历史聚合只帮助 I1 选择 shadow planner 的候选分布和指标。

## 五、工程门禁

G0 完成后必须满足：

1. `scripts/**/*.ts` 进入 TypeScript、ESLint 和 Biome 检查。
2. `bun run check` 包含一个低成本 benchmark smoke，不访问网络。
3. `bun run bench:long-session` 默认 workload 完成，并验证 resume、取消和 Recall。
4. `bun run bench:recall` 默认 workload 完成。
5. 长会话基准的 TUI projection 数量受既有 policy 限制。
6. 两个 benchmark 都使用当前 schema/runtime API，schema 演进导致漂移时在常规检查中
   立即失败。
7. G0 不新增 revision、不切换 `active_revision_id`、不实现 `/compact`。

## 六、实际结果

基线环境：macOS arm64、Bun 1.3.12，2026-07-16。本数据是当前机器上的工程基线，
用于比较后续 revision 实现，不是 SLA。

### 6.1 确定性长会话

命令：`bun run bench:long-session`

- 50 个普通 workload turns，加 1 个取消 turn 和 1 个 Recall turn，共落库 52 turns、
  208 messages、156 frames 和 52 tool results。
- 中点 resume、取消后继续、RecallSearch -> get 均通过；schema 为 v4。
- 最终 measured context 为 194,579 tokens；最大 request 为 207 messages、218 prompt
  segments。
- request build 共 158 次，p50/p95 为 1.33/9.44ms，最大 11.24ms；model prepare
  p50/p95 为 0.93/1.76ms。
- 全部 workload 用时 2,386.09ms，turn p50/p95 为 43.80/72.76ms；resume 为
  26.62ms。
- TUI 最终只保留 8 个近期 turns，淘汰 44 个，最终/峰值 visible items 为 46/54；
  projection append p95 为 0.02ms。
- 最终 session 目录为 5,348,019 bytes。
- 采样 RSS 从 137,576,448 增至 330,629,120 bytes，增量 193,052,672 bytes；heap
  增量 44,938,939 bytes。TUI 已有界，但完整 canonical request 热路径仍随历史增长。
- 生成 fixture 中 tool observation 正文为 606,879 bytes，占全部消息正文约 98.9%；
  tool observation p50/p95 均约 14 KiB。

### 6.2 Recall

命令：`bun run bench:recall`

- 10,000 条消息带来的 SQLite 增量为 13,082,624 bytes，其中 FTS shadow pages 为
  1,490,944 bytes。
- 批量插入 514.84ms；低层 schema/SQLite/index 打开校验 80.40ms；完整
  `SessionStore.openExisting()` 校验 155.12ms。
- 稀疏 trigram p50/p95 为 0.20/0.21ms；密集 trigram 为 11.17/11.17ms；单字符
  substring 为 9.72/9.87ms。
- index rebuild + verify 为 47.58ms；search + 20,000-byte get 的采样 RSS 峰值增量
  49,152 bytes。

### 6.3 本地历史匿名聚合

只读扫描 `~/htdocs` 下的 44 个 SessionStore，没有输出 session ID、路径或正文：

- schema v2/v3/v4 分别为 4/9/31 个；总计 80 turns、2,154 messages 和 1,136 tool
  results。
- 最长 session 为 15 turns；单 session 最大 509 messages、287 tool results。因此真实
  数据用于分布校准，不替代 50-turn 确定性 fixture。
- 全部消息正文 2,347,139 bytes，其中 tool observation 为 2,074,813 bytes，占
  88.4%。
- tool observation p50/p95/p99 为 653/7,943/17,564 bytes，最大 33,852 bytes；
  54 条至少 8 KiB。
- 可用 measured anchor 中最大 context 为 166,763 tokens；这些 session 均未达到各自
  input budget 的 80% trigger。

这组分布支持 I1 首先对大体积 tool observation 做确定性 shadow planning，不需要在 G0
引入模型辅助候选选择。
