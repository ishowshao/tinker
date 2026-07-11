# Agent Runtime Roadmap：为「无限上下文」建立地基

## 文档状态

- 日期：2026-07-11
- 性质：实施路线图，不替代阶段技术设计
- 目标方案：[`infinite-context-technical-design-a.md`](infinite-context-technical-design-a.md)
- 当前依据：仓库现有源码、测试与已完成的 runtime 设计

## 一、结论

现在不应直接实施完整的「无限上下文」方案。

Tinker 已经解决了后台任务管理、turn cancellation、运行身份和资源生命周期等问题，
但长 session 的核心状态仍是内存中的 `AgentMessage[]`；TUI 仍保存无界事件和 timeline；
context 还没有可靠的下一请求预算；持久化、协议帧、历史寻址和恢复也都尚未建立。

如果此时直接开发自动 compaction，会同时改动 agent loop、持久化格式、provider 协议、
TUI 和检索路径，出现问题时很难判断是计量、存储、协议还是摘要策略造成的。

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
  -> 结构化 checkpoint 与自动 compaction
```

这条顺序的核心原则是：先证明历史能稳定保存、恢复、计量和找回，再允许任何机制把它
从活动上下文换出。

## 二、长期目标与本轮边界

### 2.1 长期目标

Tinker 最终应提供一个逻辑上持续增长、可精确寻址的 session 历史；模型每次只接收
一个有界、协议合法、可解释来源的活动视图。

对应的工程保证是：

1. 原始 user、assistant 和 tool 历史不会因 compaction 被覆盖或删除。
2. 每条历史可以按稳定 ID 和哈希精确取回。
3. 所有 provider 请求在发送前通过预算与 tool-call 协议校验。
4. 换出和 checkpoint 失败时，旧活动视图继续有效。
5. `/resume` 恢复同一份 canonical history，而不是只恢复一段自由文本摘要。

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

已完成项继续作为回归基线，不在后续阶段重新设计。详细设计见：

- [`background-task-management-design.md`](background-task-management-design.md)
- [`turn-cancellation-design.md`](turn-cancellation-design.md)
- [`session-turn-iteration-identity-design.md`](session-turn-iteration-identity-design.md)
- [`runtime-session-lifecycle-design.md`](runtime-session-lifecycle-design.md)

### 3.2 部分具备，但不能当成已完成

| 能力 | 已有部分 | 仍缺少 |
| --- | --- | --- |
| 跨 turn 对话状态 | `RuntimeSession` 已拥有 `sessionMessages` | 仍只在内存；`RunAgentResult` 每轮返回完整消息数组 |
| Context 构建边界 | 所有正常请求经过 `ContextBuilder` | 当前只是透传，没有预算、分项、revision 或 validator |
| Token usage | `ModelUsage` 有 prompt/completion/total | 没有 cache hit/miss、model profile、下一请求估值和安全余量 |
| Session 文件目录 | 已有 event log 和 observation log | 二者是诊断记录，不是可恢复 canonical history |
| Tool-call 合法性 | 受控失败和取消会补齐 tool message | 没有显式 `ProtocolFrame`，也没有请求前全量 validator |
| TUI 历史 | event 可投影成 timeline | `TuiEventStream.events` 和 timeline 都会随 session 无界增长 |

### 3.3 尚未开始

- 稳定 `MessageId`、不可变 canonical history 和 context revision。
- `SessionStore`、single-writer lock、崩溃恢复和 `/resume`。
- `/status`、Prompt Input context 状态栏和严格的请求 preflight。
- `Recall`、session 内搜索和精确历史 page-in。
- 确定性换出、结构化 checkpoint、`/compact` 和自动 compaction。

### 3.4 旧路线图如何迁移

| 旧阶段 | 当前处理 | 调整原因 |
| --- | --- | --- |
| 后台进程管理 | 标记为已完成，转为回归基线 | 工具、TUI 和退出清理已经落地 |
| `Esc` 中断当前执行 | 标记为已完成，转为回归基线 | 模型、工具和进程取消链路已经落地 |
| Session 持久化与 `/resume` | 拆成 F3、F4 | 先确定 message/frame 和提交契约，再固化数据库 schema |
| Context Window 统计 | 扩展为 F2，并前移 | 后续所有存储和换出策略都需要统一预算与真实观测 |
| 自动 compaction 与 `/compact` | 拆成 F5、门禁、I1、I2、I3 | 先具备精确找回和影子验证，再逐步允许活动视图发生变化 |

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

**状态：待实施；F2 已完成。**

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

**状态：待 F3 完成。**

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

**状态：待 F4 完成。**

任何历史被换出前，必须先证明原文能够被确定性找回。

实施范围：

- 定义稳定 `ctx://message/<message-id>` 来源和只读 `SessionHistoryReader`。
- `Recall get` 按 source 精确返回正文、哈希和分页信息。
- `Recall search` 使用 session 内 FTS5 trigram；短查询使用有界 substring fallback。
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

### I1：Context Revision 与影子规划

先建立活动视图编译器，但不改变真正发给模型的内容：

- 实现 immutable canonical history 到 active view 的稳定渲染。
- 增加 `ContextRevision`、frame 边界、prefix hash 和 revision 校验。
- swap planner 在 shadow mode 中计算候选、预计释放 token 和目标视图，不提交 revision。
- 用真实长 session 数据校准保护区、候选阈值、trigger 和 target。

验收门槛：shadow planner 对模型行为零影响；相同 revision 的旧前缀逐字节稳定；任何计划
都不会切开 protocol frame，且预计的新视图严格小于旧视图。

### I2：确定性换出与手动 `/compact`

先只允许用户在空闲状态手动触发 swap-only compaction：

- 只替换已关闭 frame 中的大体积 tool observation。
- 占位符由 raw result 机械生成，包含 source、hash 和历史/当前两条恢复路径。
- 完整候选 revision 在 transaction 中写入并校验后，才原子切换 active revision。
- `/compact` 与未来自动路径调用同一个 `ContextManager.compact()`。
- 原始 message 和 tool result 永不删除；Recall 在尾部 page-in，不改写旧前缀。

验收门槛：换出零模型调用、tool 协议始终合法、输入 token 严格下降、原文可 Recall、
revision 失败时旧视图保持活动。手动路径稳定后，才允许基于 F2 压力数据启用自动
swap-only。

### I3：结构化 Checkpoint 与自动 Compaction

只有确定性换出仍无法稳定达到 target 时，才引入模型参与的 checkpoint：

- checkpoint 增量消费上一 capsule 和新退休前缀，不重总结完整历史。
- ID、hash、artifact、command 和后台任务由 runtime 确定性生成。
- objective、decision、progress 等 derived 字段必须带有效 source。
- user quote 必须是原始消息的精确子串；tool/web/MCP 正文不提升到 system role。
- schema、source、协议和预算全部校验通过后才能切换 revision。
- 自动 compaction 只在 closed frame 的安全边界运行，并使用 trigger/target 回差。

验收门槛：非法或超预算 checkpoint 不改变活动视图；合法 checkpoint 达到 target；早期
用户约束、失败原因、文件版本和命令结果都可以从 source 下钻到原文。

### I4：长会话评测与稳定化

- 建立至少 50 turn、包含多轮 Read/Grep/Bash、取消、恢复、Recall 和两次 revision 的
  固定基准。
- 对比无 compaction、swap-only 和 checkpoint 三种策略的任务成功率、token、延迟、
  cache hit/miss 和存储增长。
- 验证模型何时会主动 Recall，并诚实记录关键词检索和模型行为的边界。
- 只有评测支持后，才对外使用“原文可精确找回”“compaction 不删除 session 历史”等
  产品表述；不承诺“模型永不忘记”。

## 七、统一交付规则

每一阶段都遵循以下规则：

1. 先补充或更新对应 `docs/` 设计，明确所有权、失败语义和不变量，再改代码。
2. 一个阶段只引入一类新的 source of truth；不让 event log、SessionStore 和 TUI
   projection 互相推断状态。
3. 无法确认的配置、损坏数据、协议断裂和超预算请求都在最接近来源处 fast-fail。
4. 单元测试之外，runtime 控制和 `/resume` 需要真实 PTY 验证；存储需要 crash/fault
   injection；cache 假设需要真实 provider usage 验证。
5. 每阶段完成后更新本路线图的状态和实际结果，再决定是否进入下一阶段。

当前明确的下一项是 **F3：建立协议安全的会话账本**。F1、F2 已完成；在 F3
完成 canonical history 与 protocol frame 契约前，不启动 SessionStore 或 compaction
的实现。
