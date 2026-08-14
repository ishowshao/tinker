# Agent Runtime Roadmap：为「无限上下文」建立地基

## 文档状态

- 日期：2026-07-18
- 性质：实施路线图，不替代阶段技术设计
- 目标方案：[`infinite-context-technical-design-a.md`](infinite-context-technical-design-a.md)
- 当前依据：仓库现有源码、测试与已完成的 runtime 设计

## 一、结论

现在仍不应直接实施自动化的完整「无限上下文」方案。

Tinker 已经完成后台任务管理、turn cancellation、运行身份、资源生命周期、context
preflight、协议安全账本、可恢复 SessionStore，以及稳定历史来源与 `Recall`。F1 至 F5
地基阶段、G0 基准门禁、I1 Context Revision 影子规划、I2 温层确定性换出与手动
`/compact`，以及 I3 Recall-first 冷前缀退休与手动 `/compact retire` 已经完成。活动视图
现在可以原子换出 observation 或退休完整冷前缀并精确恢复。Agent Skills 也已在 schema v8
上完成严格发现、渐进披露、durable activation、resume 重绑定和 `/skills` 展示。I4 主动
Recall 评测与自动化门禁也已完成：DeepSeek floor holdout 通过后，runtime pressure 可以在
turn commit/skill settlement 或 resume 后的 idle boundary 自动提交 swap，并在仍高于 target 时
提交 qualified prefix retirement。

这条顺序已经避免了直接开发完整“无限上下文”的不可归因风险：自动路径复用 I1 至 I3 的
deterministic planner/transaction，没有引入摘要、checkpoint 或新的历史 source of truth。

后续路线改为：

```text
已完成的运行控制与生命周期
  -> 长 session 的内存和所有权收束
  -> Context 计量与请求预检
  -> 协议安全的会话账本
  -> SessionStore 与 /resume
  -> 可精确寻址的 Recall
  -> 「无限上下文」实施门禁
  -> Context revision 影子运行
  -> 确定性换出与手动 /compact
  -> Recall-first 冷前缀退休
  -> 主动 Recall 评测与自动 compaction 门禁
  -> 证据驱动的可选 checkpoint
```

这条顺序的核心原则是：先证明历史能稳定保存、恢复、计量和找回，再允许任何机制把它
从活动上下文换出。长期上不把每条 placeholder 当成永久索引；早期完整前缀可以
退出 active context，由不会被换出的 system Recall 契约和 canonical 全文索引提供
按需恢复。

## 二、长期目标与本轮边界

### 2.1 长期目标

Tinker 最终应提供一个逻辑上持续增长、可精确寻址的 session 历史；模型每次只接收
一个有界、协议合法、可解释来源的活动视图。

对应的工程保证是：

1. 原始 user、assistant 和 tool 历史不会因 compaction 被覆盖或删除。
2. 每条历史可以按稳定 ID 和哈希精确取回。
3. 所有 provider 请求在发送前通过预算与 tool-call 协议校验。
4. 换出、前缀退休和 checkpoint 失败时，旧活动视图继续有效。
5. `/resume` 恢复同一份 canonical history，而不是只恢复一段自由文本摘要。
6. 退出 active context 的历史仍可由 `RecallSearch/RecallGet` 检索原文；“未出现在当前
   请求中”不能被解读为“session 中不存在”。

### 2.2 当前不做

- 不在地基阶段实现自动 compaction。
- 不用 `events.jsonl` 作为 session 恢复数据库。
- 不引入 embedding、reranker、知识图谱、AST/LSP 索引或跨 session 记忆。
- 不实现 session 分支、云同步、多人共享、多 agent capsule 或后台进程跨重启恢复。
- 不按 model name 猜 context window，也不把粗略估算展示成精确 token。
- 不为旧的本地实验数据建立复杂迁移框架；不支持的 schema 直接 fast-fail。

## 三、当前实现基线

### 3.1 已完成

| 能力 | 状态 | 当前边界 |
| --- | --- | --- |
| 后台任务管理 | 已完成 | `TaskList`、`TaskOutput`、`TaskStop` 和 `ShellTaskManager` 已形成统一生命周期 |
| `Esc` 取消当前 turn | 已完成 | 取消信号已贯穿模型、工具、MCP、Web 与前台 Bash；后台任务保持独立 |
| Session/Turn/Iteration/ToolCall 身份 | 已完成 | 运行身份和单调 `eventSequence` 已统一 |
| `RuntimeSession` 生命周期 | 已完成 | one-shot 与 TUI 共享创建、执行、故障和释放路径 |
| 事件可靠性 | 已完成 | required sink 失败会 fault session；展示 sink 失败被隔离并产生诊断事件 |
| 工具结果契约 | 已完成 | `ToolRawResult` 已判别化，raw result 与模型 observation 分离 |
| Provider 输出边界 | 已完成 | assistant message、tool call 和基础 token usage 会在 adapter 层校验与规范化 |
| 失败/取消后的 tool 协议补齐 | 已完成 | 当前 agent loop 会补齐未完成 tool message，避免下一 turn 直接携带悬空调用 |
| 协议安全会话账本 | 已完成 | canonical message/frame/tool result 由统一 ledger 追加，请求前执行完整协议校验 |
| SessionStore 与 `/resume` | 已完成 | SQLite 是 durable source of truth，支持 single-writer、恢复、TUI 切换与显式删除 |
| 稳定来源与 `Recall` | 已完成 | 当前 schema v8 保留 `ctx://message/...`、scoped reader、FTS5/substring search 和精确 get |
| 模型 profile 与兼容契约 | 已完成 | `SessionCompatibilityContract` 只冻结历史消息协议；request fingerprint、tool surface 与 activation policy 已分离 |
| 项目指令与 active surface | 已完成 | creation system message 保持不可变；resume 加载当前 AGENTS.md/CLAUDE.md，并以 `surface_refresh` 留下 durable revision |
| Context revision、确定性换出与冷前缀退休 | 已完成 | schema v8 延续 immutable `ContextSurface`、线性 revision、active override manifest、原子 active switch、手动 `/compact` 与 `/compact retire`；active view 为 `{1} U [keep, tail]` |
| Agent Skills | 已完成 | 严格加载 project/user `.agents/skills`，条件注册 `Skill`，以 `skills_update` 持久化 promotion/rejection，并在 resume 重绑定当前版本；`/skills` 只读展示 |

已完成项继续作为回归基线，不在后续阶段重新设计。详细设计见：

- [`background-task-management-design.md`](background-task-management-design.md)
- [`turn-cancellation-design.md`](turn-cancellation-design.md)
- [`session-turn-iteration-identity-design.md`](session-turn-iteration-identity-design.md)
- [`runtime-session-lifecycle-design.md`](runtime-session-lifecycle-design.md)
- [`runtime-contract-context-surface-refresh-design.md`](runtime-contract-context-surface-refresh-design.md)
- [`agent-skills-support-design.md`](agent-skills-support-design.md)

### 3.2 部分具备，但不能当成已完成

| 能力 | 已有部分 | 仍缺少 |
| --- | --- | --- |
| 自动 context 管理 | I4 已完成 DeepSeek floor qualification、automatic swap 与 guarded retirement | admission rescue 和可选 checkpoint 仍未实施 |

### 3.3 尚未开始

- 可选结构化 checkpoint；只有后续证据显示 Recall-only 存在稳定缺口时才启动。

### 3.4 旧路线图如何迁移

| 旧阶段 | 当前处理 | 调整原因 |
| --- | --- | --- |
| 后台进程管理 | 标记为已完成，转为回归基线 | 工具、TUI 和退出清理已经落地 |
| `Esc` 中断当前执行 | 标记为已完成，转为回归基线 | 模型、工具和进程取消链路已经落地 |
| Session 持久化与 `/resume` | 拆成 F3、F4 | 先确定 message/frame 和提交契约，再固化数据库 schema |
| Context Window 统计 | 扩展为 F2，并前移 | 后续所有存储和换出策略都需要统一预算与真实观测 |
| 自动 compaction 与 `/compact` | 拆成 F5、门禁、I1 至 I5 | 先具备精确找回和影子验证，再逐步允许换出、冷前缀退休与可选 checkpoint |

## 四、基础阶段

基础阶段必须按阶段独立交付。每一阶段都先收紧契约和验收条件，不在同一批改动中提前
预埋后面阶段的完整实现。

### F1：收束长 Session 的内存与所有权

**状态：已完成（2026-07-11）。**

详细设计见
[`long-session-memory-ownership-design.md`](long-session-memory-ownership-design.md)。

目标是在不改变模型输入内容的前提下，消除两个会随 session 长度持续放大的内存问题，
并为 SessionStore 留出单一接入边界。

实施范围：

- 从 `runAgent()` 中抽出只负责追加本 turn 记录、构建当前请求的 conversation 接口；
  第一版使用内存实现。
- `RuntimeSession` 继续是唯一 session owner；agent loop 不再返回和提交完整 session
  history，只返回本 turn 的终态和必要 delta。
- 明确 completed、failed、cancelled 三条路径的 message 提交边界。
- TUI presentation sink 不再保存或 replay 完整原始事件，改为维护有界 projection
  snapshot，新订阅者直接读取当前 snapshot。
- `TuiState` 只保留当前 turn、最近若干 turn 和后台任务最新快照；完整诊断历史仍写入
  event log。
- presentation 路径只保留渲染所需投影，避免 provider raw response 或完整 tool output
  被 TUI 长期持有。

验收门槛：

- 连续执行大量 fake-model turns 时，模型收到的消息与改造前逐条一致。
- `RunAgentResult` 不再携带完整 session messages。
- TUI 常驻事件和 timeline 数量有明确上限，后台任务状态不因窗口淘汰而丢失。
- completed、failed、cancelled 后都能继续下一 turn，现有取消与工具协议测试全部通过。

### F2：Context 计量、模型配置与请求预检

**状态：已完成（2026-07-11）；未改变消息选择行为。**

详细设计与真实 provider 验证记录见
[`context-measurement-model-profile-preflight-design.md`](context-measurement-model-profile-preflight-design.md)。

这一步只建立可观测性和预算真相，不执行换出或摘要。

实施范围：

- 每个可运行模型必须显式配置 context window 与最大输出能力；缺失或非法时启动
  fast-fail，不按 model name 猜测，也不保留 unknown-profile 模式。
- 产品输出上限固定为 `128K`；adapter 对 prepared payload 真正发送派生的
  `max_tokens`，输入预算固定为 `context window - request max output`。
- provider 成功响应强制包含内部一致的 prompt/completion/total usage，并规范化 cache
  hit/miss 与 reasoning tokens。
- 对 adapter 最终 messages、tool calls 和 tool schemas 做确定性字符估值，以最近八次
  provider prompt usage 校准；append-only 时使用 measured total + estimated delta。
- 增加 `context.usage.updated`、80% pressure trigger、请求前 hard preflight、Prompt Input 状态栏与
  本地 `/status`；F2 不执行 compaction。
- 使用累计 prefix hash、request config hash 和 tool schema hash 验证 anchor 前缀稳定性。

验收门槛：

- 没有合法 profile 时 one-shot 与 TUI 均无法创建 RuntimeSession。
- 每次模型请求前都有确定性的估值和分项；超过严格输入预算时不发出
  `model.request.started`，也不访问 provider。
- provider usage 与下一请求 estimate 使用不同来源类型；TUI projection 只保留最新数量和
  hash，不保留 prompt 或 raw response。
- 真实 DeepSeek smoke test 已验证 `max_tokens=131072`、guarded estimate、anchor delta、
  cache hit/miss 与 reasoning usage；真实 PTY 已验证 Prompt Input 状态栏和 `/status`。

### F3：建立协议安全的会话账本

**状态：已完成（2026-07-12）。**

详细设计见
[`protocol-safe-session-ledger-design.md`](protocol-safe-session-ledger-design.md)。

在写入 SQLite 前，先用内存实现把 canonical history 的数据契约和协议边界验证清楚，
避免把当前可变消息数组直接固化成长期 schema。

实施范围：

- 增加稳定 `MessageId`、ordinal、content hash 和客观 origin。
- 把 system、user、assistant text 和完整 tool exchange 建模为 `ProtocolFrame`。
- frame 在 assistant tool calls 全部获得 tool message 后才能从 open 转为 closed。
- 增加 `ContextProtocolValidator`，每次 provider 请求前检查 tool call 数量、顺序、
  provider ID 唯一性和配对关系。
- canonical records 只追加；已提交正文不可修改。
- 将取消、工具失败和进程中断的补齐结果纳入同一套 frame 规则。
- 定义 tool raw result、observation 与 tool message 的单次提交边界。

验收门槛：

- 单工具、多工具、进度文本加工具、失败和取消都生成合法 closed frame。
- 删除、重复或错配任一 tool message 时，请求在 adapter 之前被 validator 拒绝。
- 同一份 canonical records 重建出的 provider-neutral messages 逐字节稳定。
- 账本追加或协议校验失败后不继续执行下一个有副作用的工具。

### F4：SessionStore v1 与 `/resume`

**状态：已完成（2026-07-12）。**

详细设计见
[`session-store-resume-design.md`](session-store-resume-design.md)。

第一版只追求“未压缩历史可完整恢复”，不同时实现 Recall、换出或 checkpoint。

实施范围：

- 使用 `bun:sqlite` 建立独立 `SessionStore`；event log 继续只做诊断。
- 持久化 session metadata、turns、protocol frames、messages 和 tool results。
- schema v1 只支持当前格式；版本不支持、完整性检查失败或 workspace 不一致时 fast-fail。
- 使用 transaction 提交关联记录，并以 single-writer lock 防止同一 session 被两个进程
  同时恢复。
- user message 在 turn 开始时写入；assistant 通过协议校验后写入；tool raw result 与
  observation 在下一次模型请求前写入。
- 建立一个只表示完整未压缩视图的 initial revision，给后续 revision 演进留下明确边界，
  但本阶段不切换视图。
- `/resume` 列出当前 workspace 的近期 sessions；`/resume <session-id>` 恢复计数器、
  conversation 和最近 TUI 投影。
- 恢复 open frame 时只补充“执行状态未知”的 interrupted result，不自动重试工具。
- 提供最小 session 运维信息：更新时间、状态、数据库大小和显式删除入口；不自动清理。

验收门槛：

- 多 turn 退出后恢复，下一次 provider 请求与退出前的未压缩上下文一致。
- session ID、turn/iteration/tool call 计数器在恢复后继续递增且不冲突。
- 数据库不可写时，在模型请求和工具副作用前失败。
- 模拟 transaction 中断、损坏 schema、锁冲突和 open frame，错误均明确且旧数据可诊断。
- session 目录权限仅允许当前用户访问，并继续被 Git 忽略。

### F5：稳定来源与 `Recall`

**状态：已完成（2026-07-12）。**

落地前技术方案见
[`stable-source-recall-design.md`](stable-source-recall-design.md)。

任何历史被换出前，必须先证明原文能够被确定性找回。

实施范围：

- 定义稳定 `ctx://message/<message-id>` 来源和只读 `SessionHistoryReader`。
- `RecallGet` 按 source 精确返回正文、哈希和分页信息。
- `RecallSearch` 使用 session 内 FTS5 trigram；短查询使用显式 substring fallback。
- 搜索只覆盖允许返回的 user、assistant 和 tool observation，不默认暴露 reasoning 或
  provider raw response。
- observation 明确标记为历史数据；历史 Read/Grep/Bash 与当前 workspace 的
  Read/Grep/日志文件路径保持不同语义。
- 空结果只表示本次 query 和 filters 在当前 session 未命中。

验收门槛：

- source get 返回的正文和 hash 与最初进入模型的 observation 一致。
- 中英文、路径、代码符号和错误字符串都可搜索，并支持稳定分页。
- 不能跨 session 或 workspace 读取历史。
- Read 文件 v1、修改为 v2 后，Recall 返回历史 v1，Read 返回当前 v2。

实际结果：

- Recall 最初随 schema v2 一次性切换落地；后续 measured anchor 与项目指令快照使当前
  schema 演进到 v4。旧 schema 继续 fast-fail；FTS-only 损坏可从已验证 canonical
  history 重建，message/FTS trigger 失败会回滚整个 mutation。
- `Recall` 已作为必选 built-in tool 进入 tool schema；ordinary miss 可继续，required
  reader 故障会补齐 tool frame、跳过后续副作用、持久化 failed turn 并 fault session。
- 自动化集成用例验证 Read v1、Edit v2、Recall v1、当前 Read v2，以及退出后恢复同一
  source/hash 再次 get。
- fake-model one-shot、真实 TUI PTY、`/resume` 后再次 Recall，以及真实 DeepSeek
  search→get smoke 均通过。
- `bun run bench:recall -- 10000 100` 基线：SQLite 总增量 13,082,624 bytes，其中 FTS
  shadow pages 1,490,944 bytes；打开并完成 schema/SQLite/index 校验 78.35ms，index
  rebuild+复验 46.78ms；稀疏 trigram p50/p95 0.21/0.23ms，全量命中 trigram 10.79ms，
  一字 substring p50/p95 9.29/9.51ms；20-hit search + 20,000-byte get 的采样 RSS
  增量 131,072 bytes。本数据是本机基线，不是 SLA。

## 五、进入「无限上下文」实施的门禁

F1 至 F5 完成不等于「无限上下文」完成，只表示已经具备安全实施它的条件。进入活动
上下文换出前，以下条件必须同时满足：

1. 长 session 中 TUI 和运行时投影保持有界，canonical history 仍完整。
2. 每次 provider 请求前能说明预算、估值来源和协议合法性。
3. 退出重启后可以恢复相同的未压缩模型上下文。
4. 任一历史记录可以按 source 精确取回，并能区分历史 observation 与当前 workspace。
5. 存储写失败、损坏、锁冲突和 open frame 都有经过故障注入验证的 fast-fail 语义。
6. 至少完成一组长 session 基准，记录消息体积、tool observation 占比、估算误差、
   provider cache 和 TUI 内存曲线。

任一条件未满足，都不进入自动 compaction。

## 六、门禁后的「无限上下文」阶段

这一部分遵循
[`infinite-context-technical-design-a.md`](infinite-context-technical-design-a.md)，但仍按
可回滚的小阶段实施。

### G0：重新建立长会话基准门禁

**状态：已完成（2026-07-16）。**

详细契约与本机基线见
[`context-revision-g0-baseline.md`](context-revision-g0-baseline.md)。

G0 不改变 runtime 行为，只恢复可重复的工程门禁：

- 长会话 benchmark 已改用真实 RuntimeSession、SessionStore、默认工具、ContextMeter 与
  TUI projection，默认覆盖 50 个 workload turns、中点 resume、受控取消和 Recall
  search -> get。
- Recall benchmark 通过当前 SessionStore 两阶段创建 schema/compatibility contract，再生成
  10,000 条确定性 canonical messages，不再复制历史 schema SQL。
- `scripts/**/*.ts` 已进入 TypeScript、ESLint 与 Biome；低成本 `bench:smoke` 已进入
  `bun run check`。
- 50-turn 基线最终为 207-message request、194,579 measured tokens，request build p95
  9.44ms；TUI 仍稳定保留 8 个近期 turns，但采样 RSS 增量约 193MB，证明完整历史热路径
  仍需由 I1 拆分。
- 本地 44 个历史 SessionStore 的匿名聚合显示 tool observation 占正文 88.4%，支持 I1
  优先对大体积 tool observation 做确定性 shadow planning。

### I1：Context Revision 与影子规划

**状态：已完成（2026-07-16）。**

详细设计见
[`context-revision-i1-shadow-planning-design.md`](context-revision-i1-shadow-planning-design.md)。

先建立活动视图编译器，但不改变真正发给模型的内容：

- 实现 immutable canonical history 到 active view 的稳定渲染。
- 将 schema v4 的 `initial_full` ContextRevision 接入唯一编译路径，增加 compiled frame
  manifest、prefix append-only 审计和 revision 校验。
- swap planner 在 shadow mode 中计算候选、预计释放 token 和目标视图，不提交 revision。
- 明确记录全部合格候选仍无法达到 target 的 `insufficient_candidates` 结果，作为后续
  Recall-first 前缀退休的直接输入，不把 placeholder 设计成永久常驻层。
- 用 G0 确定性长会话和本地历史匿名聚合校准保护区、候选阈值、trigger 和 target。

验收门槛：shadow planner 对模型行为零影响；相同 revision 的旧前缀逐字节稳定；任何计划
都不会切开 protocol frame，且预计的新视图严格小于旧视图。

实际结果：

- schema 保持 v4，durable revision 仍恰好一条
  `1 / initial_full / keep_from_ordinal=1`；active 与 measured revision 均未改变。
- 50-turn formal benchmark 在第 12 回合强制规划一次：11 条已结束 observation 中 7 条
  受最近 8 turns 保护、1 条小于 8KiB，入选 Read 2 条、Bash 1 条。
- 3 条入选 observation 从 42,762 bytes 降到 1,665 bytes；完整请求 raw/guarded token
  分别从 43,964/48,361 降到 31,577/34,735，均下降 28.2%。零 token 强制目标得到
  `insufficient_candidates`，明确记录了 swap-only 的 guarded floor。
- forced shadow 为 6.56ms；request build p50/p95 为 1.89/8.97ms，对比 G0 的
  1.33/9.44ms；RSS 增量为 221,315,072 bytes，heap 增量为 26,342,774 bytes。
- provider request 保持精确的 104 次；resume、取消、Recall、active payload 与 tool side
  effect 均未被 shadow 改变。`bun run check`、50-turn formal benchmark 和 Recall
  benchmark 全部通过。

### I2：温层确定性换出与手动 `/compact`

**状态：已完成（2026-07-17）。**

详细设计见
[`context-revision-i2-deterministic-swap-manual-compact-design.md`](context-revision-i2-deterministic-swap-manual-compact-design.md)。

先只允许用户在空闲状态手动触发 swap-only compaction：

- 只替换已关闭 frame 中的大体积 tool observation。
- 占位符由 raw result 机械生成，包含 source、hash 和历史/当前两条恢复路径。
- 完整候选 revision 在 transaction 中写入并校验后，才原子切换 active revision。
- `/compact` 与未来自动路径调用同一个 `ContextManager.compact()`。
- 原始 message 和 tool result 永不删除；Recall 在尾部 page-in，不改写旧前缀。
- placeholder 是温层表示，不是永久目录；后续 revision 可以让它所属的完整旧前缀退出
  active context。

验收门槛：换出零模型调用、tool 协议始终合法、输入 token 严格下降、原文可 Recall、
revision 失败时旧视图保持活动。I2 不启用自动 prefix retirement，也不引入模型摘要。

实际结果：

- SessionStore 已一次性切换到 schema v5；v4 无 migration/dual-read，直接
  `SESSION_SCHEMA_UNSUPPORTED`。revision chain、override、active switch 和 measurement
  binding 由 schema fingerprint、trigger、读取时全链验证和 transaction readback 共同
  约束。
- `SwapPlanner` 现在由 I1 shadow 与 I2 `ContextManager.compact()` 共用；生产手动路径只
  接受 `{ kind: "manual" }`，runtime pressure 仍只 shadow，不存在自动 commit flag。
- 50-turn formal benchmark 提交 revision 2/3，累计 28 条 override。第一次 guarded token
  从 53,301 降到 39,675，第二次从 199,761 降到 86,073；provider request 仍为 104 次，
  resume、取消、Recall 和 measured revision 均通过。
- 两次 compact 的 planning/validation/transaction/activation/total 分别为
  9.25/5.11/8.02/1.88/24.28ms 和 54.32/19.28/34.23/2.12/109.96ms；database + WAL
  分别增加 61,800 和 103,000 bytes。
- transaction 内 6 个 fault point 全部回滚到旧 active revision 并保留旧 measurement；
  COMMIT 后 activation fault 则保留新 revision，measurement 为空，重启能精确恢复。
- 真实 PTY 中 `/compact` 将 16,977 降到 5,098 estimated tokens（下降 70.0%），随后可
  继续 turn 并正常 `/quit`。真实 provider smoke 中 compact 零请求；两次 post-compact
  请求均通过，cache hit/miss 从 0/3,303 变为 3,200/138 tokens。
- 10,000-message Recall benchmark 的 trigram p95 为 0.23ms；最终 `bun run check` 包含
  457 项测试并通过，formal benchmark、Recall benchmark、fault matrix、PTY 和真实
  provider smoke 也全部通过。

### I3：Recall-first 冷前缀退休

**状态：已完成（2026-07-18）。**

详细设计见
[`context-revision-i3-recall-first-prefix-retirement-design.md`](context-revision-i3-recall-first-prefix-retirement-design.md)。

当 swap-only 的 placeholder 和 tool-call 骨架开始形成线性增长的 token 地板时，先不生成
摘要，而是允许连续的完整旧前缀退出 active context：

- `keepFromOrdinal` 只能指向保留 turn 的起始 user message；它之前必须是连续的完整
  已结束 turn，不能留下半个 tool exchange。
- active view 只保留固定 system/kernel、必选 Recall tool 和近期完整 suffix；退休区间
  不留每条 placeholder。
- canonical message、tool result 和 FTS 索引不变；`RecallSearch/RecallGet` 必须继续命中
  已退休历史。
- 在 F5 已有 Recall rule 上增强并长期保留一条常量成本的契约：active context 中缺席
  只表示未加载，不表示 session 中不存在；在重复旧工作、否定历史证据或依赖早期决策
  前应先 Recall。
- 首先只允许 benchmark-forced 和空闲状态手动退休；不在本阶段自动启用。

验收门槛：退休前后 canonical/FTS 不变，provider payload 不含退休 frame 或其旧
placeholder，协议骨架完整，resume 恢复同一 active revision，并且明确提示的历史
问题可经 search -> get 找回原文。

实际结果：

- SessionStore 已切换到 schema v7；新增版本化 Recall retirement surface contract（当前为
  `recall-retirement-v2`，并支持历史 `recall-retirement-v1`）、
  独立 `prefix_retirement` revision、active override manifest 和 `{1} U [keep, tail]`
  compiler。v6 不迁移、不 dual-read，直接 fast-fail。
- 50-turn formal benchmark 在两次 swap 后提交 retirement revision 4/5。第一次 keep
  1 -> 170，退休 42 turns / 126 frames / 168 messages，guarded token 从 86,150 降到
  35,720；第二次 keep 170 -> 174，再退休 1 turn，guarded token 从 35,746 降到
  30,853。两次 database + WAL 增量均为 32,960 bytes，provider request 仍精确为 104。
- 历史 28 条 override 全部保留为审计行并退出 active manifest；canonical messages、frames、
  tool results、FTS source/content/hash 在 retirement、append、swap、surface refresh、重复
  retirement 和 resume 后保持一致。六个 transaction fault point 全部回滚；COMMIT 后
  activation fault 保留新 revision。
- 真实 provider smoke 的 retirement request count 为 1 -> 1；首个新 payload 不含 marker，
  cache hit/miss 从第一次 rewrite 的 0/3,267 变为同 revision append 的 3,200/91 tokens，
  随后真实模型完成 RecallSearch -> get。真实 TUI PTY 将 10,103 降到 4,105 estimated
  tokens，直接 `/resume` 后取回 9,020-byte 退休消息，再 `/compact` 并正常 `/quit`。
- schema v7 的 10,000-message Recall benchmark trigram p95 为 0.27ms；formal benchmark、
  fault matrix、component tests、真实 PTY、provider cache/protocol/Recall smoke 和
  `bun run check` 全部通过；最终为 512 项测试、3,350 个断言。

### I4：主动 Recall 评测与自动化门禁

**状态：已完成（2026-07-18）；DeepSeek floor qualification 通过，自动 swap 与 retirement 已开启。**

详细设计见
[`context-revision-i4-active-recall-evaluation-automation-gates-design.md`](context-revision-i4-active-recall-evaluation-automation-gates-design.md)。

- 建立超过 placeholder 保护区的长会话基准，对比 full-history、swap-only 和
  Recall-only retirement。
- 分别覆盖显式提示历史、隐式依赖早期约束、词面线索改写、旧失败防重复和
  历史/当前文件版本区分。
- 记录模型是否主动调用 Recall、search -> get 成功率、正确 source 命中、任务成功率、
  无效检索次数、token/延迟和 cache hit/miss。
- 自动 swap-only 先通过协议、预算、cache 和 revision 失败语义门禁；自动 prefix
  retirement 在此基础上还必须通过主动 Recall 质量门禁。
- 当前配置按用户明确选择使用 `deepseek-v4-flash` capability floor；真实 response/chunk 只解析到
  一个 model identity，当前高级 profile 继承该行为资格。
- 资格绑定 manifest、grader、fixture、policy、正负 holdout report、Recall contract 文本与 Recall
  definition hash；证据和编译门禁由测试互相校验。
- 只有评测支持后，才对外使用“原文可精确找回”“compaction 不删除 session 历史”等
  产品表述；不承诺“模型永不忘记”。

实测结果：full-history 30/30、swap-only 30/30、Recall-only 29/30、主动 Recall 29/30，三类
negative control 0/9 无效 Recall；retirement 相对 full-history 的 token/latency 为 1.1555x/1.365x。
机器 qualification 12/12 gates 通过。最终 `bun run check` 为 574 tests / 3,657 assertions；50-turn
long-session、10,000-message Recall、真实 DeepSeek provider smoke 和真实 TUI PTY 均通过。详细
证据见 I4 设计文档及其 checked-in JSON reports。

### I4.1：按消费水位维护 active context

**状态：已完成（2026-08-14）。**

真实大型任务证明固定保护最近 8 个 turns 不是可靠的安全边界：单个 active turn 本身就可能
包含多轮 provider dispatch 和足以占满多个窗口的工具结果。当前策略因此改为：

- 删除 swap 与 prefix retirement 的固定 recent-turn 数量保护；所有非 active closed turns
  都是候选，由 token target 决定实际换出或退休多少。
- 每次成功 provider request 记录本 turn 已消费到的 canonical ordinal。active turn 内只有不
  晚于该水位、位于 closed tool frame 中的 observation 可以换出；尚未进入任何成功请求的
  observation 必须保留。
- 每批工具执行完成并关闭 iteration 后重新测量 active context。达到压力阈值时先提交
  swap revision；若候选不足，再以当前 active turn 的 closed user frame 为锚点退休此前
  closed turns。
- active-turn revision 仍只在没有 open iteration、没有 open protocol frame 的边界提交；
  canonical messages、tool results 与 Recall 索引不变，pending ledger 随 revision 激活同步
  刷新。
- schema 仍为 v9；旧 v9 session 在打开时只升级 context revision validation trigger 和
  schema fingerprint，不修改 canonical history。

核心回归覆盖 active turn 中“已消费 observation 换出、未消费 observation 保留”，以及以
active-turn 起点退休此前全部 closed turns；原有 swap、retirement、resume、fault matrix 和
Recall 不变量继续保留。

### I5：证据驱动的可选结构化 Checkpoint

只有 I4 证明 Recall-only 在重要长会话 workload 中存在稳定、可重现的连续性缺口时，
才引入模型参与的 checkpoint：

- checkpoint 是有界的导航层，不是历史 source of truth，也不恢复每条 placeholder。
- 增量消费上一 capsule 和新退休前缀，不重总结完整历史。
- ID、hash、artifact、command 和后台任务由 runtime 确定性生成。
- objective、decision、progress 等 derived 字段必须带有效 source。
- user quote 必须是原始消息的精确子串；tool/web/MCP 正文不提升到 system role。
- schema、source、协议和预算全部校验通过后才能切换 revision。

验收门槛：非法或超预算 checkpoint 不改变活动视图；必须在指定失败 workload 上比
Recall-only 显著改善主动恢复和任务成功率，否则不进入默认路径。

## 七、统一交付规则

每一阶段都遵循以下规则：

1. 先补充或更新对应 `docs/` 设计，明确所有权、失败语义和不变量，再改代码。
2. 一个阶段只引入一类新的 source of truth；不让 event log、SessionStore 和 TUI
   projection 互相推断状态。
3. 无法确认的配置、损坏数据、协议断裂和超预算请求都在最接近来源处 fast-fail。
4. 单元测试之外，runtime 控制和 `/resume` 需要真实 PTY 验证；存储需要 crash/fault
   injection；cache 假设需要真实 provider usage 验证。
5. 每阶段完成后更新本路线图的状态和实际结果，再决定是否进入下一阶段。

当前已完成 **I4.1：按消费水位维护 active context**。下一项不是默认进入 I5；本轮 30 个
retirement holdout 只有一个随机的隐式依赖失败，没有形成稳定 checkpoint 需求。继续收集真实长
会话证据；只有缺口稳定、可重现且 Recall/query 改进不能解决时，才设计 I5。
