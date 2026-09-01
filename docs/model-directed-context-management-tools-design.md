# 模型自主 Context 管理工具技术方案

## 文档状态

- 日期：2026-07-18
- 状态：草稿（设计已与需求方对齐，待实现）
- 前置阶段：Context Revision I2 温层确定性换出、I3 Recall-first 冷前缀退休、
  I4 主动 Recall 评测与自动化门禁
- 当前基线：SessionStore schema v10、immutable `ContextSurface`、线性
  `ContextRevision`、`swap-only-v1`、`recall-first-retirement-v1`、稳定来源与
  Recall、自动 `runtime_pressure` 维护、手动 `/compact`
- 相关设计：
  [`context-revision-i2-deterministic-swap-manual-compact-design.md`](context-revision-i2-deterministic-swap-manual-compact-design.md)、
  [`context-revision-i3-recall-first-prefix-retirement-design.md`](context-revision-i3-recall-first-prefix-retirement-design.md)、
  [`stable-source-recall-design.md`](stable-source-recall-design.md)

## 一、结论

把 context 管理的决策权开放给模型本身。模型通过三个常驻工具获取压力、浏览候选、
选择换出；runtime 保留全部不变量校验与提交职责。

本方案采用以下决定：

1. 模型只做"选择"，不做"提交"。模型产出候选 id 集合，plan 校验、投影、事务提交、
   激活仍走 `ContextManager` 现有管线，所有既有不变量（前缀哈希审计、乐观并发基校验、
   严格 token 递减）不因入口变为模型而削弱。
2. 三个工具常驻 tool schema，不随压力动态注入。
3. 工具的模型观察必须小但有效。`ContextSwapCandidates` 列出的候选按定义是当前
   active context 中模型可见的消息，因此 listing 不携带任何内容摘要，只提供选择
   句柄、label 映射锚点、时间定位和收益数字。
4. `ContextSwap` 不在工具调用时执行交换，采用两阶段设计：调用时 validate-and-schedule，
   当前 iteration 的全部 tool frame 闭合后、下一次模型请求前走完整管线提交。
5. 与 `runtime_pressure` 自动维护共存而非替代。模型驱动是新 trigger kind
   `model_directed`，两路共用同一提交管线，state 机互斥，乐观并发兜底。
6. Status/Candidates 走新增的 mid-turn 读路径（`allowOpenTail` 视图），不复用
   `measureCurrent()`——后者在工具执行中必然抛 `SESSION_INTEGRITY_FAILED`。
7. `ContextSwapCandidates` 建立一次性 model-directed lease，恰好抑制一次自动
   swap，保证模型在真正有压力时仍握有选择权（见 4.2）。
8. 新增持久化 raw kind `context_maintenance` 必须走全链路：类型联合、严格解码
   白名单、observation、TUI/one-shot exhaustive 消费者、持久化往返与 resume
   测试（见第五章）。

## 二、现状盘点

| 能力 | 现状 |
|---|---|
| 获取 context 压力 | `ContextManager.measureCurrent(activeTurnId?, activeLedger?)` 返回完整 `ContextUsageSnapshot`（usedInputTokens / pressure / inputBudgetTokens / triggerTokens / source / correctionFactor），目前仅被 runtime 自动维护路径使用。**但它以 `store.assertContextRevisionBoundary` 开头，要求 `open_iterations === 0 && open_frames === 0`，工具执行中（iteration/frame 未闭合）调用会直接抛 `SESSION_INTEGRITY_FAILED`，不能复用**（见第四节读路径） |
| 枚举可换出候选 | `SwapPlanner.scanCandidates()` 已能枚举全部合格候选并统计排除原因，但为 private，仅服务于贪心自动选择 |
| open-tail 读取 | 协议校验器支持 `allowOpenTail`（`context-protocol-validator.ts`），允许末尾一个 open frame；`sqlite-session-ledger.ts` 已暴露该选项。mid-turn 读取的基础设施已存在 |
| 执行换出 | `ContextManager.compact()` 已有完整 plan→validate→commit→activate 管线，含 `assertPlanBaseCurrent` / `SwapPlanStaleError` 乐观并发校验、`CommittedPrefixAuditor` 前缀哈希审计、SQLite 事务提交 |
| mid-turn 换出 | `performActiveTurnContextMaintenance` 已支持在 agent loop 执行中途携带 `activeTurn.turnId + consumedThroughOrdinal` 换出，未消费消息受 `active_turn_unconsumed` 保护 |
| 换出后找回 | swap placeholder 自带 `ctx://message/<id>` source 与 "Use RecallGet to recover" 指引，闭环自洽；Recall 工具结果按名称被排除在候选之外 |
| 延期执行钩子 | `loop.ts` 每次迭代收尾固定序列：全部 tool result `commitToolCompletions` 写入 canonical → `finishIterationForContinuation` 闭合 frame → `maintainContextAfterIteration`。该钩子是延期提交的现成落点 |

## 三、工具契约

### 3.1 ContextStatus

获取当前 context 压力。无参数。

```jsonc
// 参数：{}
// 响应：
{
  "ok": true,
  "usedInputTokens": 142000,
  "inputBudgetTokens": 180000,
  "pressure": "high",
  "triggerTokens": 162000,
  "source": "measured_plus_estimated_delta"
}
```

实现为 4.1 节 mid-turn 读路径的薄封装（**不是**现有 `measureCurrent()` 的薄封装：
后者在工具执行中必然抛 `SESSION_INTEGRITY_FAILED`）。不携带候选预估（与
Candidates 工具职责重叠）；行动引导写在工具 description 中，响应不加 hint 字段。

### 3.2 ContextSwapCandidates

列出当前可换出的候选片段。仅分页参数，按 ordinal 升序（时间顺序，最旧在前）。

```jsonc
// 参数：{ "limit": 20 /* 默认 20，上限 50 */, "offset": 0 }
// 响应：
{
  "ok": true,
  "total": 34,
  "candidates": [
    {
      "candidateId": "msg_01J…",
      "label": "Bash: bun run check:fast",
      "ordinal": 87,
      "savingsBytes": 47888
    }
  ]
}
```

- 不合格候选直接不出现，不携带任何排除原因统计。
- 每条仅四字段：`candidateId`（即 canonical messageId，选择句柄）、`label`
  （映射锚点）、`ordinal`（时间定位）、`savingsBytes`（换出净释放字节数）。
- 按时间序而非收益序：越旧的观察通常越过时，时间序本身是自然的换出优先级
  启发式，且分页稳定、模型容易建立历史空间感。
- 分页稳定性说明：两次 list 之间会有新工具结果进入、也可能发生换出，offset
  会漂移。apply 的失败逐项报告，模型重新 list 即可，不引入游标。

**label 设计**：按工具类型从 tool call 参数提取（canonical tool 消息携带
`toolCallId`，可回溯到 assistant 消息中的调用参数），单行、净化、截断约 80
字节；取不到参数时 fallback 为裸工具名。label 措辞与模型上下文中"那次调用"
的参数一致，候选到可见消息的映射是直觉级的。

| 工具 | label 取法 | 示例 |
|---|---|---|
| Bash | `description` 参数，缺失时取命令首行 | `Bash: bun run check:fast` |
| Read | 文件路径（带行范围） | `Read: src/agent/loop.ts:330-559` |
| Grep | pattern + path | `Grep: "maintainContext" in src/agent` |
| Glob | pattern | `Glob: src/context/**/*.ts` |
| TaskOutput | task_id | `TaskOutput: task_7` |
| WebSearch | query | `WebSearch: anthropic context editing` |
| WebFetch | URL 去协议头 | `WebFetch: docs.anthropic.com/…` |
| MCP | server.tool | `MCP: playwright.browser_click` |
| view_image | 文件路径 | `view_image: screenshot.png` |

**观察体积估算**：一页 20 条每条约 60–80 字节，加头部约 1.5KB（约 400
token）；Status 与 Swap 响应各约 150–300 token。

### 3.3 ContextSwap

选择候选执行换出。仅候选 id 参数。

```jsonc
// 参数：{ "candidate_ids": ["msg_01J…", "msg_01K…"] }   // 1–16 个，去重
// 响应（调用时，validate-and-schedule 的即时反馈）：
{
  "ok": true,
  "scheduled": [{ "candidateId": "msg_01J…", "savingsBytes": 47888 }],
  "rejected": [{ "candidateId": "msg_01K…", "reason": "frame_not_closed" }],
  "note": "Swap executes when this iteration's tool frames close."
}
```

- 逐项校验，不静默跳过；`rejected` 带原因（already_swapped / frame_not_closed /
  active_turn_unconsumed 等既有排除码）。
- 全部失败时 `ok:false` + rejected 列表，不登记 pending 指令。

## 四、执行路径设计

### 4.1 Status/Candidates 的 mid-turn 读路径

工具执行发生在 iteration 未闭合时（loop 的工具执行循环在
`finishIterationForContinuation` 之前），而 `ContextManager.measureCurrent()`
与 `compact()` 均以 `store.assertContextRevisionBoundary` 开头，要求
`open_iterations === 0 && open_frames === 0`。因此 Status 与 Candidates 不能
复用 `measureCurrent()`，必须新增专用读路径：

- `ContextManager` 新增 `measureActive(turnId, ledger)`：以
  `allowOpenTail: true` 从活跃 ledger 构建包含 open tail 的视图 →
  `model.prepare` → `contextMeter.measure`，**跳过** boundary 断言。open tail
  中的消息计入 token 估计，使压力读数反映"此刻真实负载"，而非上一次 dispatch
  的陈旧快照。
- Candidates 扫描经同一路径取 canonical 视图后调用
  `SwapPlanner.scanCandidates`；`frame_not_closed` 过滤天然排除 open tail，
  候选语义与提交时完全一致。
- loop.ts 零改动仍然成立：执行体在 loop 内部被调用，新增代码位于
  ContextManager 与 ledger 层。

### 4.2 自动维护仲裁：model-directed lease

自动维护每次迭代收尾都会运行（`maintainContextAfterIteration` →
`performActiveTurnContextMaintenance`），pressure 非 normal 时立即贪心换出。
模型在 iteration N 调 Candidates、要到 iteration N+1 的模型请求后才能调用
Swap——若不仲裁，真正有压力时选择权仍归自动策略，listing 在模型使用前失效，
后续 P3 压力提示也会被同样抢跑。

引入一次性 lease：

- `ContextSwapCandidates` 返回 ≥1 个候选且 pressure 非 normal 时，登记 turn 级
  `modelDirectedSwapLease`（易失控制状态，与 pending 指令同生命周期，不进
  canonical）。
- `performActiveTurnContextMaintenance` 入口检查：lease 存在且无 pending
  swap 指令 → 跳过本次自动 swap 并消费 lease（恰好抑制一次，模型获得恰好一个
  iteration 的决策窗口）。
- 模型调用了 ContextSwap → pending 指令优先执行（见 4.4），lease 随之失效；
  模型一个 iteration 内未行动 → lease 已消费，自动策略恢复正常，不会被饿死。
- turn 结束清理 lease（`finally` 中与 `pendingAutomaticContextMaintenance`
  一并清理）。
- P3 的压力提示注入时也登记同一 lease，保证提示与候选列表不被自动路径抢跑。

### 4.3 ContextSwap 阶段一：调用时（validate-and-schedule）

executor 内部：

1. 经 4.1 读路径对当前视图跑一次只读候选扫描，将 `candidate_ids` 分为
   `scheduled` 与 `rejected`。
2. 将 scheduled id 集合去重取并集，登记为 turn 级 pending 指令
   （`pendingModelDirectedSwap`），仿照 `pendingAutomaticContextMaintenance`
   的易失控制状态，不进 canonical。
3. 立即返回上述响应。不做 prepare、不做投影、不产生 revision。

模型当场获得逐项有效性反馈。

### 4.4 ContextSwap 阶段二：iteration 收尾时（deferred commit）

在 `maintainContextAfterIteration` 开头（自动维护判断之前）插入：

1. 若存在 pending 指令，以
   `{ kind: "model_directed", messageIds, activeTurn: { turnId, consumedThroughOrdinal } }`
   调用 `compact()`，走现有 plan→validate→commit→activate 全管线，事件
   reason 记 `"model_directed"`。
2. 之后原有自动维护路径照常执行，重新 measure，模型已换出足够则自然
   early-return。
3. state 机沿用 `maintaining_context`，与自动路径互斥。

### 4.5 为什么不在调用时直接交换

1. **canonical 基序干净**：ContextSwap 自身的 result 先写入 canonical、frame
   先闭合，revision 的 `baseCanonicalThroughOrdinal` 才覆盖它。调用时直接换，
   revision 基序不包含产生这次决策的消息，语义不闭合。
2. **天然批量合并**：一次 iteration 内多次调用 ContextSwap 只产生一个
   revision、一次前缀重建，而非 N 次事务加 N 次审计。
3. **候选资格在 commit 点才完整**：frame 闭合与 consumedThroughOrdinal 边界
   都以 iteration 收尾为准。
4. **staleness 窗口趋近于零**：登记到提交之间只有同批其他工具执行，仅向
   open frame 追加，不触碰已闭合 frame 中的候选；提交时管线照常重扫并做
   乐观并发校验兜底。

### 4.6 结果反馈闭环

不额外向 canonical 写入"执行结果通知"。模型在下一个 iteration 的请求中直接
看到原文变为 placeholder，这是最确定的成功信号；需要数字确认可调用
ContextStatus。延期提交非致命失败仅发 `context.revision.failed` 事件，模型
发现上下文未变化可重试。与现有自动路径对模型的可见性完全一致。

### 4.7 边界与失败语义

- 调用后 turn 被取消：pending 随 turn 结束丢弃（`finally` 中已有清理
  `pendingAutomaticContextMaintenance` 的先例，同样处理）。
- pending 不跨 iteration 存活：第一次 `maintainContextAfterIteration` 即被消费。
- ContextSwap 自身结果消息：raw kind 为新增的 `context_maintenance`，不加入
  `SWAPPABLE_RAW_KINDS`，永远不会成为候选，无自引用悖论。
- 自引用保护：调用时模型无法换出当前 iteration 的消息（frame 未闭合 +
  active_turn_unconsumed 双重排除）。
- 失败分层沿用现状：非致命 `ContextManagerError`（stale plan、候选不足等）在
  调用时表现为结构化工具错误、在延期提交时表现为 `context.revision.failed`
  事件；致命错误（协议/存储损坏）抛 `ToolExecutionFatalError` 终止 turn，与
  Recall 工具对 `SessionError` 的处理一致。
- `performAutomaticContextMaintenance` 现有入口有
  `pendingAutomaticContextMaintenance` 标志门控；model-directed 分支必须放在
  该门控之外，两者独立判断。

## 五、改动清单

| 位置 | 改动 |
|---|---|
| `src/context/swap-planner.ts` | `scanCandidates` 提为 public；新增显式 id 集合规划模式（跳过贪心排序与二分搜索，对选定子集做单次投影与校验，逐项核对资格） |
| `src/context/context-manager.ts` | `ContextCompactionTrigger` 增加 `{ kind: "model_directed"; messageIds; activeTurn }`；抽出共用提交段复用；**新增 `measureActive(turnId, ledger)` mid-turn 读路径（`allowOpenTail` 构建视图，跳过 boundary 断言）**，供 Status/Candidates/validate-and-schedule 使用 |
| `src/session/sqlite-session-ledger.ts` | 确认/暴露 `allowOpenTail` 读取路径供 mid-turn 视图构建（选项已存在，按需接线） |
| `src/context/context-swap-renderer.ts`（或相邻新文件） | 新增 label 渲染器：按 raw kind 从 tool call args 提取，单行净化截断 |
| `src/agent/runtime-session.ts` | 新增 `pendingModelDirectedSwap` 与 `modelDirectedSwapLease` 状态；`maintainContextAfterIteration` 中增加 model-directed 分支（`maintaining_context` state、`context.revision.started/finished/failed` 事件，reason `"model_directed"`）；`performActiveTurnContextMaintenance` 入口增加 lease 检查（恰好抑制一次自动 swap）；turn 结束一并清理 pending 与 lease |
| `src/agent/loop.ts` | 零改动（`maintainContextAfterIteration` 钩子已存在且位置正确） |
| `src/tools/types.ts` | `ToolExecutionContext` 增加 `contextMaintenance` 句柄（仿 `confirmBashCommand` 注入模式）；`ToolRawResultByKind` 增加 `context_maintenance` 类型 |
| `src/tools/context-maintenance.ts`（新） | 三个 ToolDefinition 与 executor，参数解析风格参照 `recall.ts` |
| `src/tools/registry.ts` 与 `src/cli` 组合根 | 注册三个工具并注入 session 句柄，常驻 schema |
| `src/observation` | 新 kind 的观察渲染；不加入 `SWAPPABLE_RAW_KINDS` |

### raw kind 全链路（`context_maintenance`）

新增持久化 raw kind 不是局部改动。当前 schema 为 v10，returned completion 的
raw JSON 全量持久化（`insertToolResult`），readback 经严格白名单解码
（`decodeStoredToolRawResult`，`enumFromSql`）。白名单外的 kind 会使 context
revision readback 与 `/resume` 直接抛错，严重时会话 fault。注意不能复用
`generic` kind 规避——其形状为 `{ ok: false; toolName; error }`，只能表达失败。
必须纳入：

1. `src/tools/types.ts`：`ToolRawResultByKind` 类型联合新增成员。
2. `src/session/session-store.ts`：`decodeStoredToolRawResult` 白名单与
   字段校验。
3. `src/observation`：观察文本渲染。
4. `src/tui` 与 one-shot 输出：所有对 `raw.kind` 的 exhaustive 消费者。
5. 测试：持久化往返（写入→readback 逐字段相等）、`/resume` 投影、context
   revision 加载路径覆盖新 kind。

## 六、后续阶段（不在本方案范围）

- P2：`ContextRetirePrefix`，按 turn 边界退休前缀，复用 `retirePrefix` 管线，
  选择粒度为 turnId。
- P3：主动暴露压力——loop 在 pressure 升级时向模型追加轻量提示，引导使用
  本工具组，把拉取变为推送。需求方已认可该方向。

## 七、开放问题

1. 延期提交失败（非致命）时模型只能被动发现上下文未变化，是否需要在下一次
   请求的某个低成本位置携带一行结果提示，值得在实现后用 benchmark 观察再定。
2. one-shot 与 benchmark 模式下默认开放，以便量化模型自主管理与自动策略的
   效果差异；是否需要在 qualification 中增加 model-directed 维度，待 P1 落地
   后评估。
3. `minimumObservationBytes`（当前 8KiB）保留为 policy 常量还是提升为 plan
   输入，本方案暂不改变，模型驱动场景下小片段换出无收益。
