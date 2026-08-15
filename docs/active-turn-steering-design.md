# Active Turn Steering 技术方案

## 文档状态

- 日期：2026-08-15
- 状态：待实施
- 优先级：P1
- 相关实现：`src/agent/runtime-session.ts`、`src/agent/loop.ts`、
  `src/agent/session-ledger.ts`、`src/session/sqlite-session-ledger.ts`、
  `src/tui/app.tsx`、`src/tui/components/prompt-input.tsx`、
  `src/tui/tui-session-controller.ts`
- 相关设计：
  [`protocol-safe-session-ledger-design.md`](protocol-safe-session-ledger-design.md)、
  [`runtime-session-lifecycle-design.md`](runtime-session-lifecycle-design.md)、
  [`turn-cancellation-design.md`](turn-cancellation-design.md)、
  [`tui-incremental-output-design.md`](tui-incremental-output-design.md)、
  [`multimodal-image-input-design.md`](multimodal-image-input-design.md)

## 一、结论

Tinker 将支持在 active turn 运行期间继续提交文本 Prompt。新 Prompt 不打断当前模型请求或
工具调用，而是进入当前 `RuntimeSession` 的内存 FIFO 队列，并按两类安全边界处理：

1. **完整 tool batch 结束后**：原子取出当时已排队的全部 Prompt，把它们作为当前 turn
   内新的 user frames 追加到 canonical history，然后继续当前 turn 的下一次模型请求。
2. **assistant 返回不含 tool call 的最终 response 后**：先按现有合同完整结束当前 turn，
   再取队首一条 Prompt，通过标准 turn admission 启动下一个 turn；其余 Prompt 保持排队。

固定语义如下：

```text
有 tool calls：同一 turn 内 steering
无 tool calls：结束当前 turn，再 handoff 到下一个 turn
```

队列属于 session runtime 的执行链，而不是某个 React 组件或某一个 turn。第一阶段队列只
存在于内存，不作为 canonical history 持久化；只有在安全边界成功应用的 Prompt 才进入
SessionStore。

## 二、用户语义

### 2.1 Tool boundary：当前 turn 内 steering

```text
Turn 12
  user: 修复配置加载
  assistant: Read + Grep
  tool: Read result
  tool: Grep result
  user: 同时兼容旧版字段          # active turn 期间排队
  user: 不要新增依赖              # active turn 期间排队
  assistant: 结合工具结果和补充要求继续
```

assistant 一次声明的全部 tool calls 构成一个不可拆分的 tool batch。Tinker 必须先为全部
calls 形成合法 tool completion，才允许插入 queued user frames。不能在同一 assistant
message 的两个 tool result 之间插入 user message。

### 2.2 Final-response boundary：启动下一个 turn

```text
Turn 12
  user: 解释当前实现
  assistant: 当前实现是……         # 没有 tool calls，Turn 12 完成

Turn 13
  user: 再给出一个重构方案         # 从队列 handoff
  assistant: ……
```

不把 final response 后的 queued Prompt 追加回已经完成的 turn，不延迟或重开
`turn.finished`，也不改变 completed-turn hook、Memory、undo checkpoint 和自动 context
maintenance 的现有结束语义。

### 2.3 多条 Prompt 的消费规则

队列严格 FIFO：

- tool boundary 一次消费边界到达前已经入队的**全部** Prompt；
- final-response boundary 只消费队首一条，用它启动一个新 turn；
- 新 turn 启动后，其余 Prompt 继续排队；
- 如果新 turn 产生 tool calls，剩余 Prompt 可在其完整 tool batch 后一次性成为 steering；
- 如果新 turn 也直接返回 final response，则再取下一条启动后续 turn。

例如：

```text
Turn 1 运行期间依次入队 A、B、C
Turn 1 final response
Turn 2 以 A 开始，B、C 仍在队列
Turn 2 tool batch 完成
B、C 一起作为 Turn 2 的 steering messages 应用
```

### 2.4 用户可见反馈

Prompt 成功入队后，TUI 立即清空输入草稿并显示：

```text
Follow-up queued for the active turn (2 pending).
```

footer 在执行链运行期间显示 pending 数量：

```text
Running · 2 follow-ups queued
```

Prompt 真正应用后，timeline 按普通 user Prompt 的视觉样式显示它。用户应能区分“已经
排队”和“已经进入 canonical history”，不能在 enqueue 时提前把 Prompt 渲染成已执行的
user message。

## 三、目标与非目标

### 3.1 目标

- active turn 期间允许继续输入和提交文本 Prompt。
- 不取消、不重启当前 provider request，不中断正在执行的工具。
- 只在协议安全边界修改 active canonical tail。
- queued Prompt 按 FIFO 顺序且最多应用一次。
- final response 保持明确的 turn 结束语义。
- 自动 handoff 使用现有 turn admission、preflight、持久化和事件合同。
- session 切换、取消、失败和进程退出时不产生幽灵 Prompt。
- 保持 request/canonical committed-prefix 对应关系可审计。
- resumed session 只展示已经 canonicalize 的 steering，不恢复纯内存队列。

### 3.2 非目标

第一阶段不支持：

- queued Prompt 持久化或进程崩溃后恢复；
- active turn 期间提交图片附件；
- active turn 期间执行 slash command；
- 中断当前模型流以立即注入 Prompt；
- 在单个 assistant tool batch 的 calls 之间插入 Prompt；
- 编辑、撤回或重新排序已经排队的 Prompt；
- 多 session 并行执行链；
- 将多个 queued Prompt 拼接成一个 user message；
- 对外承诺与 Codex CLI 完全一致的内部实现。

## 四、当前实现基线

当前 Tinker 每个 `RuntimeSession` 最多有一个 active turn：

- `RuntimeSession.admitTurn()` 只在 `state === "ready"` 时接受 Prompt；
- active turn 存在时并发 admission 会失败；
- `SessionLedger.beginTurn()` 创建 turn 的初始 closed user frame；
- `AgentTurnLedger` 只能追加 assistant 和 tool completion，不能追加后续 user frame；
- `runAgent()` 在无 tool calls 时立即返回 completed；
- 有 tool calls 时顺序执行完整 batch，然后进入下一 iteration；
- `App` 以 `isRunning` 禁用整个 `PromptInput`；
- `AcceptedTurn.completion` 只代表单个 turn 的完成。

因此本功能需要扩展 runtime scheduler、open-turn ledger 和 TUI submission routing，但不需要
放宽“一个 session 同时最多执行一个模型/工具 turn”的基本约束。

## 五、核心不变量

实现必须维持以下不变量。

### 5.1 模型请求快照不被追写

provider request 发出后，其对应的 canonical request prefix 不再改变。模型流式返回期间
收到的 Prompt 只能排队，不能在本次 request 完成前进入 ledger。

### 5.2 Tool exchange 不被拆开

对于：

```text
assistant(tool call A, tool call B)
```

canonical 顺序必须是：

```text
assistant(A, B)
tool result A
tool result B
[user steering...]
```

不能产生：

```text
assistant(A, B)
tool result A
user steering
tool result B
```

### 5.3 Final response 永远关闭 turn

无 tool call 的 assistant response 保持 terminal response。即使队列非空，也先完成：

1. `agent.iteration.finished`；
2. `turn.finished`；
3. ledger turn commit；
4. undo checkpoint 完成；
5. completed-turn hooks；
6. skills settlement；
7. 必要的自动 context maintenance。

之后才允许标准 admission 启动新 turn。

### 5.4 Exactly-once queue transfer

每条 Prompt 只能处于以下一种状态：

```text
queued -> applied_to_active_turn
queued -> admitted_as_next_turn
queued -> discarded
```

不能同时被 steering drain 和 next-turn handoff 消费，也不能因 React 重渲染重复提交。

### 5.5 Session 所有权固定

queued Prompt 记录入队时的 `sessionId`。它只能应用到同一个 runtime session。存在 active
execution chain 或非空队列时，`/clear`、`/fork`、`/resume`、`/model` 继续不可用。

## 六、Runtime Prompt Scheduler

### 6.1 队列记录

建议新增 runtime-private 类型：

```ts
type QueuedPrompt = {
  readonly queueId: PromptQueueId;
  readonly sessionId: SessionId;
  readonly enqueuedDuringTurnId?: TurnId;
  readonly userMessage: UserMessage;
  readonly enqueuedAt: number;
};
```

`queueId` 只用于当前进程中的 identity、UI snapshot 和诊断，不进入 provider request。

第一阶段固定限制：

```ts
const MAX_QUEUED_PROMPTS = 8;
const MAX_QUEUED_PROMPT_TEXT_BYTES = 64 * 1024;
```

总字节数按队列中 `userMessage.content` 的 UTF-8 字节数计算。第一阶段要求
`attachments === undefined`。超限提交不清空 PromptInput 草稿，并返回明确错误。

### 6.2 Scheduler snapshot

Runtime 暴露只读 snapshot 和订阅接口，而不是让 TUI 自己维护权威队列：

```ts
type PromptSchedulerSnapshot = {
  readonly state: "idle" | "running";
  readonly activeTurnId?: TurnId;
  readonly pendingCount: number;
};

subscribePromptScheduler(listener: () => void): () => void;
promptScheduler(): PromptSchedulerSnapshot;
```

snapshot 不暴露 Prompt 正文，避免 presentation 层复制敏感内容。Prompt 原文只保存在 runtime
queue、Prompt history 和成功应用后的 canonical history中。

### 6.3 提交接口

建议在 `RuntimeSession` / `TuiSessionBinding` 增加独立接口：

```ts
type QueueFollowUpResult = {
  readonly kind: "queued";
  readonly queueId: PromptQueueId;
  readonly pendingCount: number;
  readonly activeTurnId: TurnId;
};

queueFollowUp(userMessage: UserMessage): QueueFollowUpResult;
```

该接口是同步 enqueue：

- 验证 runtime execution chain 正在运行且接受 follow-up；handoff admission 短窗口内可以没有
  active turn，此时 `enqueuedDuringTurnId` 为空；
- 验证纯文本和队列限制；
- 复制并冻结 `UserMessage`；
- 追加 FIFO；
- 发布新的 scheduler snapshot；
- 返回 receipt。

正常 idle Prompt 仍使用异步 `admitTurn()`，不把 admission 与 enqueue 混成一个返回类型。

## 七、安全边界与 agent loop 接口

### 7.1 Tool batch boundary

`runAgent()` 在当前 assistant 声明的全部 tool calls 成功形成 completion、所有
`tool.observation` 事件追加完成后，调用 runtime callback：

```ts
takeQueuedPromptsForSteering(turn: TurnIdentity): readonly QueuedPrompt[];
```

该调用同步、原子地取出当时队列中的全部记录。调用返回后才到达的新 Prompt 留给后续边界。

如果返回非空，agent loop 调用：

```ts
ledger.appendSteeringUserMessages({
  turn,
  messages: queued.map((entry) => entry.userMessage),
});
```

每条 Prompt 形成独立 closed user frame。append 成功后，runtime 追加对应 applied 事件，然后
正常执行 `agent.iteration.finished`、context maintenance 和下一 iteration。

建议顺序：

```text
最后一个 tool.observation
-> 原子 drain queue
-> ledger append user frames
-> turn.steering.applied events
-> agent.iteration.finished(outcome=continue)
-> maintainContextAfterIteration
-> 下一次 model request
```

steering user frames 尚未被上一 provider request 消费，因此
`consumedThroughOrdinal` 仍保持上一 request 的实际 canonical message 数量；不能把新 user
frames 误标为已消费。

### 7.2 无 tool final-response boundary

`runAgent()` 不读取 follow-up queue，继续按现有合同返回 `status: "completed"`。

`RuntimeSession.performExecuteTurn()` 完成当前 turn 的 terminal commit、hooks 和自动 context
maintenance 后，由 runtime execution-chain scheduler：

1. 原子检查队列；
2. 队列为空则关闭 execution chain；
3. 队列非空则 peek 队首；
4. 对该 Prompt 执行标准 candidate build、preflight、media materialization 和 admission；
5. admission 成功后才从队列移除该记录；
6. 以新的 `turnId` 启动下一个 turn；
7. 保持 scheduler `state === "running"`，避免 TUI 闪现 idle。

后续 turn 不是前一 turn 的内部 continuation。iteration number、undo checkpoint、Memory
snapshot 和 turn terminal event 全部独立。

### 7.3 Assistant content 与 tool calls 并存

如果 assistant message 同时含文本和 tool calls，现有文本仍是 `assistant.progress`，不构成
final response。执行完整 tool batch 后按 tool boundary 规则消费队列。

### 7.4 Max iterations

同一 turn 内 steering 不重置 `maxIterations`。如果 turn 达到 iteration 上限、失败或被取消，
尚未消费的 Prompt 按失败清理规则丢弃，不自动转成下一 turn。

## 八、Ledger 与 canonical persistence

### 8.1 AgentTurnLedger 扩展

新增：

```ts
appendSteeringUserMessages(input: {
  readonly turn: TurnIdentity;
  readonly messages: readonly UserMessage[];
}): readonly CanonicalMessageRecord[];
```

合同：

- 只允许当前 open turn 调用；
- 每条 message 必须通过 `validateUserMessage()`；
- 每条 message 创建独立 `kind: "user"`、`state: "closed"` frame；
- message 与 frame 使用当前 open turn 的 `turnId`；
- ordinal、ID、hash、attachments 按普通 user frame 规则生成；
- 整批在一次 ledger commit 中原子写入；
- 任一 message 无效则整批不写入；
- append 后执行完整 protocol validation。

不要调用 `beginTurn()`，因为这不会创建新 turn，也不能替换 pending turn ownership。

### 8.2 Store commit

新增 ledger commit kind，例如：

```ts
{
  kind: "append_steering_users";
  turn: TurnIdentity;
  frames: readonly ProtocolFrame[];
  messages: readonly CanonicalMessageRecord[];
  next: ProtocolContextView;
}
```

SQLite 持久化必须在同一事务中写入全部 frames/messages 和必要的 canonical metadata。事务失败
时 runtime fault，已经从队列 drain 的记录不能被再次应用。

### 8.3 Protocol validator

现有 user frame 已支持关联 `turnId`，但测试必须明确验证一个 turn 内可以出现多个 closed user
frames，且它们只能出现在：

- turn 初始位置；或
- 完整 closed tool-exchange frame 之后。

如果现有 validator 只检查单帧形状而不检查 turn-level 顺序，应补充跨 frame 合法性测试，防止
user frame 插入 open/incomplete tool exchange。

### 8.4 Resume

已经应用的 steering user frames 是普通 canonical records，必须由现有 resume projection、
Recall、context compiler 和 provider mapping 恢复。

尚未应用的内存 queue 不恢复。进程异常退出后：

- 已持久化 user frames 保留；
- 未应用 queue 消失；
- interrupted frame recovery 只处理现有 canonical open tail；
- 不根据诊断事件重建 queue。

## 九、Execution chain 生命周期

### 9.1 定义

execution chain 是一个 TUI 提交触发、可能跨越多个 sequential turns 的 runtime 活动期：

```text
initial admitted turn
  -> zero or more same-turn steering drains
  -> zero or more queued next-turn handoffs
  -> idle / cancelled / failed
```

它不引入 canonical `chainId`，也不改变 turn identity。chain 只是 runtime 调度概念。

### 9.2 完成

只有同时满足以下条件，scheduler 才从 running 变为 idle：

- 当前 turn 已完成；
- completed-turn hooks 和自动 context maintenance 已完成；
- follow-up queue 为空；
- 不存在 handoff admission。

检查队列为空和关闭 enqueue 接收必须在同一同步临界区完成。JavaScript 单线程内不得在两者之间
`await`，从而避免：

```text
检查为空 -> 用户 enqueue -> chain 关闭 -> Prompt 永远不消费
```

### 9.3 Handoff admission 失败

下一 turn 仍走完整 admission，因此可能因 context budget、模型 media aggregate、asset 或
runtime fault 失败。

固定策略：

- admission 成功前只 peek，不先 dequeue；
- admission 失败后停止 execution chain；
- 丢弃队首及其后的全部内存 queued Prompt；
- Prompt history 保留用户已经提交的草稿，便于通过历史导航恢复；
- TUI 显示失败原因和丢弃数量；
- 不创建半成品 turn，不写入 user canonical frame；
- budget/media 类错误可以提示用户在恢复 Prompt 后执行 context maintenance，但第一阶段不自动
  维护后重试。

该策略优先保证简单、明确和 exactly-once，不引入 blocked durable queue。

## 十、取消、失败与 session 操作

### 10.1 用户取消

Esc 表示取消整个 active execution chain：

1. abort 当前 active turn；
2. 不再启动 queued next turn；
3. 丢弃所有尚未 canonicalize 的 queued Prompt；
4. 已经应用到当前 turn 的 steering frames 保留；
5. TUI 显示丢弃数量。

不能在取消当前 turn 后自动执行队列，否则用户的停止意图会被反转。

### 10.2 Model 或 tool 失败

只有 `status === "completed"` 的 final-response turn 可以 handoff 到下一 turn。以下结果全部终止
chain 并丢弃未应用队列：

- cancelled；
- model request failure；
- tool execution failure；
- fatal tool error；
- max iterations；
- runtime/session fault；
- completed-turn settlement 或自动 context maintenance failure。

### 10.3 Bash confirmation

危险 Bash confirmation 显示期间继续保持 PromptInput 禁用，避免两个交互焦点竞争。confirmation
出现前已经排队的 Prompt 保留，待工具完成后的安全边界处理。

### 10.4 Session disposal 与切换

`dispose()` 先阻止新 enqueue，再 abort active turn并清空 queue。存在 active chain 或 pending
Prompt 时，session controller 不允许 clear/fork/resume/model switch。`/quit` 走 disposal，并可
在退出前显示 queued Prompt 已丢弃的诊断，但不阻塞退出等待用户确认。

## 十一、TUI 设计

### 11.1 输入激活

当前 `PromptInput` 的 `isDisabled` 不再直接包含 `isRunning`。新的禁用条件为：

- session operation；
- copy operation；
- Bash confirmation；
- cancellation settlement；
- PromptInput 自身 admission/import/maintenance operation。

active turn 期间保持文本编辑、粘贴、history navigation 和 Enter 提交可用。

### 11.2 Submission routing

`App.onSubmit()` 根据 scheduler snapshot 分流：

```text
scheduler idle   -> 现有 admitTurn
scheduler running -> queueFollowUp
```

`queueFollowUp` 成功才清空 draft 并写 Prompt history。失败时 draft 和附件状态保持不变。

### 11.3 Active-turn 限制

scheduler running 时：

- 只接受无附件的普通文本 Prompt；
- 以 `/` 开头的输入不解析为 slash command，提交时明确拒绝；
- project custom slash command 同样拒绝；
- file mention 仍只是文本编辑能力，可以使用；
- image import、drop、paste image 和附件提交禁用；
- `Ctrl+R` reasoning effort 切换禁用；
- Esc 继续取消整个 execution chain。

提示文本改为：

```text
Send a follow-up for the active turn…
```

### 11.4 `isRunning` 的所有权

长期应以 runtime scheduler snapshot 作为运行状态来源，而不是仅依赖单个
`AcceptedTurn.completion` 的 React 本地布尔值。这样 turn handoff 期间 footer、Esc handler 和
PromptInput 不会短暂进入 idle。

现有 `activeController` 仍只负责当前 active turn cancellation；execution-chain cancellation 由
runtime 提供统一入口，以同时 abort turn 和清空 queue。

## 十二、事件与 projection

### 12.1 Canonical-aligned 事件

建议增加：

```text
turn.steering.applied
```

每条成功写入 canonical history 的 steering Prompt 产生一个事件，包含：

```ts
{
  queueId: PromptQueueId;
  userPrompt: UserPromptProjection;
  ordinal: number;
}
```

该事件属于当前 turn，用于 live timeline。resume 时仍以 canonical messages 重建，不依赖事件
作为恢复真相。

### 12.2 Ephemeral queue 状态

`queued`、pending count 和 discard notice 不应作为 queue 恢复依据。第一阶段通过 scheduler
snapshot 和 TUI notice 展示：

- enqueue 成功；
- pending count 变化；
- cancellation/failure 丢弃数量；
- handoff admission failure。

如果为了诊断追加 observation log，必须明确其非恢复性质，不能让 resumed projection 显示已经
不存在的 pending queue。

### 12.3 Next-turn timeline

final response 后 handoff 的 Prompt 使用标准 `turn.started` 和普通 user Prompt projection，不
产生 `turn.steering.applied`，因为它是新 turn 的初始消息。

## 十三、与其他子系统的关系

### 13.1 Context preflight 与 maintenance

- 同 turn steering 在 append 后由下一 iteration 的正常 build/preflight 检查预算；
- final response 后先执行前一 turn 的自动 context maintenance，再 admission 下一 turn；
- steering append 可能使下一 request 超预算；该失败属于当前 turn，终止 chain并丢弃剩余队列；
- 第一阶段不在 enqueue 时承诺未来一定能通过 preflight。

### 13.2 Committed-prefix audit

steering 只在上一 request 完成后追加，因此不会改写已审计 prefix。下一 iteration 的 request
包含新的 user frames，并成为新的 committed prefix。必须增加测试证明旧 prefix byte-stable。

### 13.3 Memory

同 turn steering 在该 turn 最终完成后一起进入 completed-turn snapshot。next-turn handoff 则形成
独立 snapshot。Memory coordinator 不感知 runtime queue，只处理 canonical completed turns。

### 13.4 Undo

在 tool boundary 应用的 steering 属于同一 turn，因此该 turn 前后所有文件 mutation 仍属于一个
undo checkpoint。final-response handoff 创建新 turn，也创建独立 checkpoint。

### 13.5 Agent Skills

steering drain 发生在完整 tool batch completion 和 skill activation协调之后。该 batch 加载的
Skill 必须在下一 model dispatch 前激活；新 user steering 与已激活 Skill 一起进入下一请求。

### 13.6 Prompt history

用户每次 enqueue 成功后立即写入 Prompt history，即使稍后因取消或失败被丢弃。history 表示用户
提交过的草稿，不等价于 canonical execution history，也为 handoff admission failure 提供恢复路径。

## 十四、并发与竞态清单

实现和测试必须覆盖：

1. provider request streaming 时 enqueue；
2. 最后一个 tool completion 前 enqueue；
3. tool batch drain 同一 event-loop tick enqueue；
4. queue drain 后、下一 request build 前 enqueue；
5. final response 与 enqueue 同时到达；
6. 当前 turn terminal commit 与 next-turn handoff 之间 enqueue；
7. handoff admission 期间再次 enqueue；
8. Esc 与 enqueue 同时发生；
9. session dispose 与 enqueue 同时发生；
10. tool failure 后 queue cleanup；
11. final response hooks/maintenance failure后 queue cleanup；
12. React binding 被 session replacement 更新时旧 runtime receipt 返回。

所有队列状态转换都由 `RuntimeSession` 同步方法串行化。TUI 不通过读取 `isRunning` 后再异步写入
来决定队列所有权，因为该 check-then-act 会产生 stale binding 竞态。

## 十五、实施分层

### Phase A：Ledger 与协议

- 增加同 turn user append API 和原子 store commit；
- 验证多 user frame 的合法 turn-level 顺序；
- 覆盖 SQLite round-trip、resume、Recall 和 compiled context；
- 保持 schema version，除非实现确实新增持久化结构。

### Phase B：Runtime scheduler 与 agent boundary

- 增加 FIFO、限制、snapshot 和订阅；
- agent loop 在完整 tool batch 后 drain；
- runtime 在 completed turn 后执行单条 next-turn handoff；
- 实现 chain cancellation、failure cleanup 和结束竞态保护；
- 保持单 session 单 active turn。

### Phase C：TUI

- active turn 期间开放文本 PromptInput；
- submission routing、placeholder、footer pending count 和 notice；
- 禁止 slash command、图片与 reasoning 切换；
- timeline 渲染 applied steering；
- 用 scheduler snapshot 替代单-turn本地 running 所有权。

### Phase D：端到端与恢复验证

- PTY 驱动真实运行中输入；
- 验证 tool boundary 同 turn 与 final boundary 新 turn；
- 验证取消、失败、session disposal 和重启；
- 验证 canonical SQLite identity 与 provider request 实际内容。

## 十六、测试矩阵

### 16.1 Ledger / protocol 单元测试

- 初始 user -> assistant tools -> tool results -> steering user -> assistant 合法；
- 两条 steering 生成两个独立 closed user frames；
- incomplete tool exchange 后 append 被拒绝；
- 非当前 turn、空消息、attachments policy 违规整批回滚；
- SQLite commit failure不产生部分 frames；
- resume 后 ordinals、turnId、hash 和 request rendering 一致。

### 16.2 Runtime 测试

- model request 期间 enqueue 不改变当前 prepared request；
- 多 tool batch 完成后一次 drain 全部现有 Prompt；
- drain 后新入队 Prompt 等待下一边界；
- final response 先关闭当前 turn，再以队首创建新 turn；
- 连续 final responses 让 A、B、C 分别形成 sequential turns；
- handoff turn 出现 tools 后将剩余队列作为同 turn steering；
- max iterations、model failure、tool failure、cancel 丢弃 queue；
- completion hook 与 automatic maintenance 发生在 handoff admission 之前；
- admission failure 不创建新 turn且清空队列；
- queue limits 和 FIFO exactly-once；
- close/enqueue 边界不存在遗留 Prompt。

### 16.3 TUI 组件测试

- running 时文本输入和 Enter 可用；
- queued 成功后 draft 清空、history 追加、pending count 更新；
- queue reject 后 draft 保留；
- running 时 slash command、图片和 Ctrl+R 被拒绝；
- Bash confirmation 和 cancellation settlement 期间输入禁用；
- handoff 不闪现 idle footer；
- applied steering 与 next-turn Prompt 使用不同 projection 路径。

### 16.4 PTY 端到端测试

至少增加以下 journeys：

1. 长工具执行期间提交 follow-up，工具完成后同 turn request 收到它；
2. 一次 assistant 声明两个 tools，follow-up 只出现在两个 result 之后；
3. final response 前提交 follow-up，前一 turn完成后自动创建下一 turn；
4. 排队 A/B/C，验证 tool boundary 全量 drain 与 final boundary 单条 handoff；
5. 排队后 Esc，验证当前 turn cancelled、队列丢弃且没有后续 provider request；
6. tool failure 后没有自动 handoff；
7. TUI 重启后只恢复已应用 steering，不恢复纯内存 queued Prompt；
8. SQLite 中 turn、frame、message 和 provider request日志严格匹配预期。

## 十七、验收标准

功能完成必须满足：

- active turn 期间可以提交纯文本 follow-up；
- 当前 provider request 和当前 tool execution 不被中断；
- 完整 tool batch 后 queued Prompt 作为当前 turn user frames 生效；
- 无 tool final response 后 queued Prompt 作为新 turn 启动；
- tool boundary 全量消费、final boundary 单条消费且全程 FIFO；
- 每条 Prompt 最多应用一次；
- 取消或失败不会静默执行剩余队列；
- canonical history、resume、Recall、Memory 和 undo 语义一致；
- handoff 期间 TUI 不闪现 idle；
- 未应用内存 queue 不被错误恢复；
- `bun run check` 和新增 PTY journeys 全部通过。

## 十八、后续扩展

第一阶段稳定后可单独设计：

- durable queued Prompt 与 crash recovery；
- queued Prompt 列表、撤回和重排；
- multimodal follow-up；
- active turn 中可安全展开的 project Prompt aliases；
- 更细粒度的 tool scheduler，使尚未开始的独立 tool calls 可被 steering 重新规划；
- execution chain 的显式 UI history 和性能指标。

这些扩展不得反向削弱本方案的两条核心边界：tool batch 完成后才允许同 turn steering，final
assistant response 永远先结束当前 turn。
