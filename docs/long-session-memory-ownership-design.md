# F1：长 Session 内存与所有权收束技术方案

## 文档状态

- 状态：已实施
- 日期：2026-07-11
- 实施日期：2026-07-11
- 对应路线图：[`agent-runtime-roadmap.md`](agent-runtime-roadmap.md) 的 F1
- 相关设计：
  - [`runtime-architecture-optimization.md`](runtime-architecture-optimization.md)
  - [`runtime-session-lifecycle-design.md`](runtime-session-lifecycle-design.md)
  - [`turn-cancellation-design.md`](turn-cancellation-design.md)
  - [`infinite-context-technical-design-a.md`](infinite-context-technical-design-a.md)

## 一、结论先行

F1 不是 SessionStore，也不会让整个 Tinker 进程的内存立即变成常数。它解决的是进入
持久化和长上下文之前，当前运行时里两类已经明确存在的放大问题：

1. **Conversation 所有权和复制放大**：`RuntimeSession` 保存完整历史，`runAgent()`
   每个 turn 再复制一份 message 引用数组，`RunAgentResult` 又把完整历史返回给调用方。
2. **Presentation 状态和 Ink 渲染放大**：`TuiEventStream` 永久保存完整原始事件，
   `TuiState.timeline` 永久追加展示项，Ink 每次更新都遍历越来越长的 timeline。

F1 完成后的状态应是：

```text
Conversation
  一个 RuntimeSession-owned 内存实现
  = committed history + 当前 turn delta

每次模型请求
  临时展平 committed history + delta
  请求结束后允许释放

Presentation
  完整 AgentEvent -> required diagnostic sinks
                     -> 有界 TUI projection snapshot
                        原始 event 随后可释放

Ink
  只渲染 active turn + 最近有限 turns + 有界任务快照
```

因此，F1 可以做出两个准确承诺：

- TUI 常驻状态和 Ink live tree 不再随 session 的全部事件历史持续增长；
- conversation 不再通过函数参数和返回值传播完整历史，只保留一个长期 owner。

F1 **不能**承诺 canonical conversation 已经有界。第一版 conversation 仍在内存中，仍会
随 session message 数量增长。后续 SessionStore 接入后，才把完整 canonical history
移到 SQLite，让内存主要受 active context budget 和当前 turn tail 限制。

## 二、当前实现与问题

### 2.1 Conversation 每个 Turn 复制完整引用数组

`src/agent/runtime-session.ts` 当前长期保存：

```ts
private sessionMessages?: AgentMessage[];
```

每个 turn 调用 `runAgent()` 时，把它作为 `initialMessages` 传入。`runAgent()` 随即创建
新数组：

```ts
const messages =
  input.initialMessages === undefined
    ? [systemMessage, userMessage]
    : [...input.initialMessages, userMessage];
```

这是一份浅复制：旧 message 对象和字符串通常不会被深拷贝，但全部数组引用会重新分配。
在 turn 执行期间，旧 `sessionMessages` 和新的 working messages 同时存活。turn 结束后，
完整 working messages 又进入 `RunAgentResult.messages`，最后被 `RuntimeSession` 接回：

```ts
this.sessionMessages = result.messages;
```

当前实现的正确性没有问题，但有三个长期缺点：

- 每个 turn 至少产生一次与完整历史长度成正比的数组分配；
- `runAgent()`、`RuntimeSession` 和调用方都能接触完整 session history，所有权不唯一；
- 未来接入 SessionStore 时，很难只替换一个边界，容易继续让完整历史在内存 API 中流动。

### 2.2 TuiEventStream 把辅助 Sink 变成了第二份事件档案

`src/events/tui-event-stream.ts` 当前永久保存：

```ts
readonly events: AgentEvent[] = [];
```

`append()` 对每个事件执行 `events.push(event)`，`subscribe()` 会从头 replay 全部事件。
其中可能长期持有：

- `model.request.finished.data.output.rawResponse`；
- WebFetch、MCP、Grep 等 `tool.raw_result` 大字段；
- tool observation 和 assistant progress 正文；
- 每一次任务生命周期事件。

完整事件已经由 required JSONL/observation sinks 写入磁盘。TUI 是 auxiliary presentation
sink，不应再成为一份无界的内存事件档案。

### 2.3 TuiState 同时保存第二份无界展示历史

`src/tui/event-store.ts` 又把 raw event 投影成 `TimelineItem[]`。追加通常使用：

```ts
timeline: [...state.timeline, item];
```

更新已有 model/tool item 时也会先执行：

```ts
const timeline = [...state.timeline];
```

因此 timeline 长度为 `T` 时，一个普通事件就可能产生 `O(T)` 的数组复制。部分 item 还
保留 diff hunks、Bash preview、完整 prompt 或 final answer。

### 2.4 Ink 压力是 F1 的直接动机之一

`src/tui/app.tsx` 每收到一个事件就 `setState()`；`src/tui/components/timeline.tsx` 每次
render 都对全部 items 执行：

```tsx
items.map((item) => renderTimelineItem(item));
```

随着 timeline 增长，每个事件会触发越来越大的 React element 构造、reconciliation、
Ink layout 和终端输出 diff。即使内存尚未耗尽，也会先出现：

- tool 密集 turn 刷新越来越慢；
- 输入与取消反馈延迟增加；
- Markdown、diff 和 Bash detail 被重复布局；
- 长 session 的 CPU 与短期分配量持续上升。

单次更新近似线性依赖 live timeline 长度；一个不断追加事件的 session，累计 UI 工作量
最坏会表现出接近二次增长。F1 必须同时限制数据保留和 live component tree，不能只在
渲染层加 `memo`。

### 2.5 其他仍会增长、但本阶段不解决的状态

`ShellTaskManager` 当前会在 `Map` 中保留所有 ManagedShellTask，包括已经结束的任务。
TaskOutput preview 本身有界，但 terminal task 仍持有 process、completion 和 output 对象。

F1 不改变 TaskList/TaskOutput/TaskStop 的历史可查询语义，因此暂不清理该 registry。测试
和 benchmark 应单独记录 task manager 的增长；如果它在真实长 session 中成为主要来源，
再设计“active task record + lightweight terminal task record”，不要顺手破坏任务工具契约。

## 三、目标与非目标

### 3.1 目标

1. `RuntimeSession` 是 conversation 的唯一长期 owner。
2. `runAgent()` 只操作当前 turn conversation，不接收或返回完整 session messages。
3. completed、failed、cancelled 三条结构化结果保持现有 message 提交语义。
4. 每次模型请求仍收到与改造前相同、顺序一致的 `AgentMessage[]`。
5. 原始 `AgentEvent` 在 presentation sink 投影后即可释放。
6. TUI 常驻 projection、timeline items 和 terminal background task snapshots 有明确上限。
7. Ink 每次 render 的 item 数只依赖 projection policy 和当前 active tasks，不依赖 session
   已处理的总历史事件数。
8. 完整诊断信息继续进入 JSONL 和 observation log，不因 TUI 限界而丢失。
9. 为未来 SessionStore 留出可替换的 conversation 接口，不在 F1 预埋 SQLite 细节。

### 3.2 非目标

- 不实现 SessionStore、`/resume`、MessageId、ProtocolFrame 或 ContextRevision。
- 不实现 context 计量、Recall、swap、checkpoint 或 `/compact`。
- 不改变模型实际看到的 message 内容、顺序、tool schema 或 provider 映射。
- 不修改 event log 的诊断职责和现有磁盘格式。
- 不让 TUI 从 JSONL replay 并推断 session conversation。
- 不保证第一版内存 conversation 与 session 长度无关。
- 不在本阶段重新设计 ShellTaskManager 的 terminal task archive。
- 不引入通用状态容器、事件总线或依赖注入框架。

## 四、必须保持的不变量

```text
RuntimeSession 是 session conversation 的唯一 owner
同一 session 最多有一个 open turn conversation
模型请求看到的消息序列与改造前逐条一致
completed / failed / cancelled 都提交协议合法的 turn delta
unexpected reject 和 terminal event failure 不提交 turn delta
runAgent 不负责 commit 或 discard
TUI projection 不是 conversation source of truth
EventLog 保留完整诊断，TUI 只保留有界展示
presentation 失败不能改变 agent 执行结果
限界不能隐藏仍在运行的后台任务
```

## 五、目标架构

```text
                          +-----------------------+
                          |    RuntimeSession     |
                          | lifecycle / terminal  |
                          +-----------+-----------+
                                      |
                                      v
                          +-----------------------+
                          | SessionConversation   |
                          | committed messages    |
                          +-----------+-----------+
                                      |
                               beginTurn(prompt)
                                      |
                                      v
                          +-----------------------+
                          | PendingTurn           |
                          | user + turn delta     |
                          | transient model view  |
                          +-----------+-----------+
                                      |
                                runAgent uses
                                      |
                              terminal event succeeds
                                      |
                          commit delta / discard delta


AgentEvent
  |
  +--> required sinks -----------------> events.jsonl / observations.md
  |
  +--> TuiProjectionStore --------------> bounded snapshot
          |                                     |
          | raw event released                  v
          +------------------------------> React / Ink live tree
```

完整状态、诊断状态和展示状态继续严格分层：

| 状态 | F1 owner | 保留策略 |
| --- | --- | --- |
| Committed conversation | SessionConversation | F1 仍完整保存在内存 |
| Current turn delta | PendingTurn | terminal 后 commit 或 discard |
| Full diagnostic events | required EventSink | 只在磁盘 append-only 保留 |
| TUI projection | TuiProjectionStore | 按 policy 有界保留 |
| Ink component tree | App/Timeline | 只从 bounded projection 渲染 |

## 六、Conversation 所有权设计

### 6.1 两层接口

F1 新增一个内存实现，但接口不暴露底层数组：

```ts
type SessionConversation = {
  beginTurn(userPrompt: string): PendingTurnConversation;
  committedMessageCount(): number;
};

type PendingTurnConversation = {
  readonly agent: AgentTurnConversation;
  projectedMessageCount(): number;
  commit(): void;
  discard(): void;
};

type AgentTurnConversation = {
  appendAssistant(message: AssistantMessage): void;
  appendTool(message: ToolMessage): void;
  buildModelRequest(tools: ToolDefinition[]): ModelRequestInput;
};
```

这里刻意把 API 分成两层：

- `runAgent()` 只拿到 `AgentTurnConversation`，因此不能 commit、discard 或读取底层完整
  history。
- `RuntimeSession` 持有 `PendingTurnConversation`，只有它能在 terminal boundary 决定
  commit 或 discard。

`ToolMessage` 可以定义为当前 `AgentMessage` 中 `role: "tool"` 的提取类型，不新增另一套
消息 schema。

### 6.2 InMemorySessionConversation

第一版实现内部只维护：

```ts
class InMemorySessionConversation implements SessionConversation {
  private readonly committed: AgentMessage[];
  private pending?: InMemoryPendingTurn;
}
```

创建 session 时，`committed` 立即包含唯一 system message。`beginTurn()`：

1. 校验没有另一个 pending turn；
2. 校验 prompt 非空；
3. 创建只包含当前 user message 的 delta；
4. 返回一次性的 pending handle。

pending 内部状态固定为：

```text
open -> committed
open -> discarded
```

重复 commit、重复 discard、terminal 后 append、同时 begin 两个 turn 都在最近来源处
fast-fail。

### 6.3 只在模型请求边界临时展平

`buildModelRequest()` 需要继续满足当前 `ModelClient` 的数组契约。内存实现可以在请求前
临时构造：

```ts
const messages = [...committed, ...delta];
return contextBuilder.build({ messages, tools });
```

这仍然会创建一份完整的浅数组，这是 provider 请求边界暂时无法避免的 materialization，
但和当前实现有两个重要区别：

- flat array 不作为 turn 的长期工作状态，也不通过 result 返回；
- 模型请求结束后，如果 adapter 不再引用它，就可以被 GC。

因此 F1 消除的是长期重复 owner 和每 turn 固定保留的完整 working array，不虚构“完全
没有全量数组”。后续 ContextView/SessionStore 可以在同一个 `buildModelRequest()` 边界
替换消息来源。

### 6.4 Append 规则

`runAgent()` 的消息修改改为：

```text
model response validated
  -> appendAssistant(message)

tool raw result + observation completed
  -> appendTool(toolMessage)

tool batch failed/cancelled
  -> 继续通过现有规则补齐剩余 tool messages
  -> appendTool(placeholders)
```

当前接受的相邻 user messages 语义保持不变：模型请求在产生 assistant message 前失败或
取消时，pending delta 只有本 turn user message；提交后，下一个 turn 可以再追加一条 user
message，不伪造 assistant reply。

### 6.5 Commit 与失败矩阵

消息提交顺序保持既有 RuntimeSession 设计：先写 terminal event，再提交 conversation。

目标 `executeTurn()` 顺序是：

```text
1. 校验 RuntimeSession ready、prompt 和单 active turn
2. SessionConversation.beginTurn(prompt)
3. 写 turn.started
4. runAgent(pending.agent)
5. 根据结构化结果写唯一 terminal event，并读取 projectedMessageCount
6. terminal event 成功后 pending.commit()
7. 清理 active turn 并返回轻量 RunAgentResult

unexpected reject
  -> 尝试写 turn.failed
  -> pending.discard()
  -> 继续抛出原错误

terminal event / required sink failure
  -> pending.discard()
  -> session faulted
  -> 不允许下一 turn
```

| 路径 | terminal event | delta 处理 |
| --- | --- | --- |
| `RunAgentResult.completed` | `turn.finished` | event 成功后 commit |
| `RunAgentResult.failed` | `turn.failed` | event 成功后 commit |
| `RunAgentResult.cancelled` | `turn.cancelled` | event 成功后 commit |
| `runAgent()` unexpected reject | `turn.failed` | discard 后继续抛出 |
| required event sink 失败 | append 失败、session faulted | discard，不允许下一 turn |
| dispose 取消 active turn | `turn.cancelled` | terminal event 成功后 commit |

`completed`、结构化 `failed` 和 `cancelled` 继续提交，是因为它们可能已经包含：

- 用户本 turn 的输入；
- 已完成的 assistant progress；
- 已执行工具的 observation；
- 为失败或取消补齐的 protocol-valid tool messages。

unexpected reject 表示 invariant 或未分类错误，当前实现不会把它的 working messages
赋给 `sessionMessages`；F1 保持同样行为。

### 6.6 轻量 RunAgentResult

移除三个分支中的 `messages`：

```ts
type RunAgentResult =
  | {
      status: "completed";
      finalText: string;
      lastIteration: IterationIdentity;
    }
  | {
      status: "failed";
      error: string;
      lastIteration: IterationIdentity;
    }
  | {
      status: "cancelled";
      cancellation: TurnCancellation;
      lastIteration: IterationIdentity;
    };
```

`turn.finished.messageCount` 不再读取 `result.messages.length`，改为在 commit 前读取：

```ts
pendingTurn.projectedMessageCount();
```

测试若需要核对完整历史，应从注入的 in-memory conversation test fixture 读取 snapshot，
不能重新把 messages 塞回生产 result。

### 6.7 为 SessionStore 留出的替换点

F1 后，agent loop 只知道 `AgentTurnConversation`。未来 SessionStore 接入时：

- `beginTurn()` 可以创建持久化 write transaction；
- append 方法可以写入 message/tool result records；
- `buildModelRequest()` 可以读取 active ContextView；
- `commit()` 可以提交 turn 状态；
- `discard()` 可以回滚未提交 transaction。

这些变化不再要求修改 `runAgent()` 的返回类型或重新引入完整 history 参数。

## 七、TUI Projection 与 Ink 有界化设计

### 7.1 不再 replay 原始 AgentEvent

roadmap 中的“有界 replay buffer”在实现时收紧为 **有界 projection snapshot**。原因是
任意最后 N 条 raw events 仍可能包含巨大 payload，也可能恰好从 turn 中间开始，无法
可靠重建 TUI 状态。

建议用 `TuiProjectionStore` 替换当前 `TuiEventStream.events` archive：

```ts
class TuiProjectionStore implements EventSink {
  readonly name = "tui-projection-store";

  private snapshot: TuiProjectionState;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): TuiProjectionState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { /* ... */ };

  async append(event: AgentEvent): Promise<void> {
    this.snapshot = reduceTuiProjection(this.snapshot, event, this.policy);
    for (const listener of this.listeners) {
      listener();
    }
  }
}
```

store 在 session 创建前由 TUI runner 初始化，并作为 auxiliary sink 传给 RuntimeSession。
即使 `session.started` 或 MCP 事件发生在 Ink mount 之前，它们也已经折叠进当前 snapshot。
App 初次订阅时直接读取 snapshot，不需要 replay 从 session 开始到现在的全部事件。

React 侧使用 `useSyncExternalStore()`：

```ts
const state = useSyncExternalStore(
  props.projectionStore.subscribe,
  props.projectionStore.getSnapshot,
);
```

`getSnapshot()` 在没有新事件时必须返回同一对象引用，避免无意义 render。

### 7.2 原始事件只在 append 栈上短暂存在

`reduceTuiProjection()` 可以读取完整 raw event 生成展示信息，但 snapshot 只能保存渲染
真正需要的字段。例如：

| 原事件 | Projection 保留 | 明确不保留 |
| --- | --- | --- |
| `model.request.finished` | iteration、完成状态、usage 摘要 | provider `rawResponse` |
| `tool.raw_result` | 工具摘要、有界 diff/Bash preview | Web/MCP/Grep 完整正文 |
| `tool.observation` | 通常不单独保留，或只保留状态 | 完整 observation 文本 |
| `assistant.progress` | 有界展示文本 | 额外 provider payload |
| task lifecycle | 每个 task 最新 snapshot | 同一 task 的旧 lifecycle events |

required event sinks 仍先写完整诊断事件；presentation reducer 成功返回后，TUI 不再持有
传入的 `AgentEvent`。`TuiProjectionState` 中不允许出现 `AgentEvent[]`、`rawResponse` 或
通用 `unknown` payload。

### 7.3 Projection 状态按 Turn 分组

当前单一 flat timeline 改为：

```ts
type TuiTurnProjection = {
  turnId: TurnId;
  turnNumber: number;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  items: TimelineItem[];
  omittedItemCount: number;
};

type TuiProjectionState = {
  sessionId: SessionId;
  modelName: string;
  workspaceRoot: string;
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  workedForMs?: number;
  activeTurn?: TuiTurnProjection;
  recentTurns: TuiTurnProjection[];
  notices: TimelineItem[];
  backgroundTasks: ShellTaskSnapshot[];
  omittedTurnCount: number;
};
```

分组后，turn terminal event 可以原子地把 `activeTurn` 移入 `recentTurns`，并在一个明确
位置执行 retention policy；不再从 flat timeline 猜测哪些 item 属于哪个 turn。

### 7.4 显式 Projection Policy

限界必须是可测试的数据契约，不是渲染组件里的零散 `slice(-N)`：

```ts
type TuiProjectionPolicy = {
  recentTurnLimit: number;
  itemLimitPerTurn: number;
  sessionNoticeLimit: number;
  completedTaskLimit: number;
};
```

F1 在代码中提供一组明确、有限的默认值，并允许测试注入更小值；第一版不增加环境变量。
实际默认值如下：

| Policy | 默认值 | 选择依据 |
| --- | ---: | --- |
| `recentTurnLimit` | 8 | 保留足够的近期上下文，同时让已完成 turn 的 live tree 明确有界 |
| `itemLimitPerTurn` | 40 | 100-turn benchmark 的三次 tool iteration turn 实际为 11 项，为更密集 turn 留出余量 |
| `sessionNoticeLimit` | 12 | 覆盖近期 MCP/diagnostic 状态，不让 session notice 形成第二条历史流 |
| `completedTaskLimit` | 12 | 保留近期 terminal task；所有 running/stopping task 仍无条件保留 |

这些值是 presentation policy，不是协议常量；以后若真实 PTY profiling 显示不同取值更合适，
可以在不改变 conversation 或 event log 契约的前提下单独调整。

每次 reducer 更新后按固定顺序收束：

1. 始终保留 active turn。
2. active turn 超过 item limit 时，保留 prompt、当前 running item 和最新 terminal/detail
   items，淘汰最旧的已完成中间 item，并累计 `omittedItemCount`。
3. turn 结束后只保留最近 `recentTurnLimit` 个完整投影，累计 `omittedTurnCount`。
4. session/MCP/diagnostic notices 只保留最近 `sessionNoticeLimit` 项。
5. background tasks 始终保留所有 `running`/`stopping` 项；terminal tasks 只保留最近
   `completedTaskLimit` 项。

UI 在发生淘汰时显示一个短 marker，例如：

```text
... 17 earlier timeline items omitted from the live view
```

这只表示 live presentation 被限界，不表示模型历史或诊断日志被删除。

### 7.5 Ink 只渲染 Visible Projection

`Timeline` 改为只接收 `items`，删除 `events` fallback：

```tsx
<Timeline items={visibleTimelineItems(state)} />
```

这保证生产代码和测试都不能意外把完整 event history 重新送进渲染层。稳定 item ID 继续
作为 React key。

限界后的复杂度是：

```text
reducer / render 成本
= O(active turn item limit
    + recent turn limit * item limit
    + active background tasks
    + completed task limit)
```

它不再依赖 session 已经处理过多少历史事件。`React.memo` 或 Ink `Static` 可以在真实
profiling 后进一步优化，但不能替代 projection limit；第一版不依赖它们证明有界性。

### 7.6 Background Task 的两层边界

TUI 只保存每个 task 的最新 snapshot，不保留 started/stopping/finished 三份历史。所有
active task 必须可见，terminal task 使用 recent cap。

这只约束 presentation。`ShellTaskManager` 的 task registry 仍是运行控制 source of truth，
F1 不允许 TUI 淘汰反向删除 manager 内的 task。两者不能共享同一个可变数组。

## 八、内存模型与可观测性

### 8.1 F1 前后复杂度

设：

- `H`：session committed messages 数；
- `D`：当前 turn delta；
- `E`：session 累计 AgentEvent 数；
- `V`：projection policy 允许的 visible items；
- `A`：当前 active background task 数。

当前长期内存近似包含：

```text
O(H) session messages
+ active turn 期间 O(H + D) working message references
+ O(E) raw TUI events
+ O(E) derived timeline items
```

F1 后近似为：

```text
O(H) committed in-memory conversation
+ O(D) pending turn delta
+ 模型请求期间一次临时 O(H + D) flat view
+ O(V + A) bounded TUI projection
+ O(1) 当前正在分发的 raw event
```

SessionStore 接入后，目标才进一步变成：

```text
磁盘 O(H) canonical history
内存 O(active context budget + current tail + V + A)
```

### 8.2 不使用脆弱 Heap 数字作为唯一门禁

CI 中直接断言 `process.memoryUsage().heapUsed` 容易受 GC 时机和 Bun 版本影响。F1 的主要
门禁使用结构性断言：

- `RunAgentResult` 类型中没有 messages；
- production `TuiProjectionState` 中没有 `AgentEvent[]` 或 raw payload；
- 处理任意数量完成 turns 后，recent turns/items/notices/terminal tasks 不超过 policy；
- Ink 接收的 items 数不超过 visible projection 上限。

另提供非脆弱的 benchmark 报告 RSS/heap 趋势，但不把某个绝对 MB 数作为跨机器测试。

### 8.3 建议 Benchmark

新增一个 fake-model 长 session benchmark，至少覆盖：

```text
100 turns
每 turn 3 iterations
每 iteration 1 个 tool raw result
包含大 rawResponse、Web/MCP 文本、diff 和 Bash preview
包含 completed / failed / cancelled turns
```

记录：

- committed message 数；
- materialized request view 次数和最大长度；
- processed event 总数；
- projection 当前 turn/item/task 数；
- Ink render 的最大 item 数；
- heap/RSS 趋势，仅作诊断；
- 每 10 turns 的 reducer 和 render 耗时。

验收重点是 processed events 持续增长时，projection 和 Ink item 数保持平台线，而不是要求
canonical in-memory conversation 在 F1 就保持平台线。

## 九、代码调整范围

### 9.1 新增

```text
src/agent/session-conversation.ts
src/tui/tui-projection-store.ts
src/tui/tui-projection-policy.ts
scripts/bench-long-session-memory.ts
```

可选 benchmark：

```text
scripts/bench-long-session-memory.ts
```

### 9.2 修改

- `src/agent/runtime-session.ts`
  - 创建并拥有 `InMemorySessionConversation`；
  - 每 turn 创建 pending handle；
  - terminal event 成功后 commit，异常路径 discard；
  - message count 从 pending conversation 读取。
- `src/agent/loop.ts`
  - `RunAgentInput` 接收 `AgentTurnConversation`；
  - append assistant/tool delta；
  - 每次请求调用 `buildModelRequest()`；
  - 不再创建完整 working messages。
- `src/agent/types.ts`
  - 抽出 `ToolMessage`；
  - 从 `RunAgentResult` 移除 `messages`。
- `src/events/tui-event-stream.ts`
  - 已由 projection store 替代并删除；
  - 不再保留永久 raw event 数组或 replay API。
- `src/tui/event-store.ts`
  - reducer 改为 turn-grouped、policy-bounded projection；
  - raw event 只用于当次投影。
- `src/tui/app.tsx`
  - 使用 `useSyncExternalStore()`；
  - 不再本地 replay raw events；
  - Timeline 只接收 visible items。
- `src/tui/components/timeline.tsx`
  - 删除 `AgentEvent[]` fallback；
  - 渲染 omitted markers 和 bounded items。
- `src/tui/components/background-tasks.tsx`
  - 展示 active tasks 与 recent terminal snapshots，不假设拥有全部历史。
- `src/cli/tui-runner.tsx`
  - 在 RuntimeSession 创建前初始化 projection store；
  - 同一个 store 同时作为 auxiliary sink 和 App external store。
- 相关测试 helper
  - 用 conversation fixture 检查历史；
  - completed/cancelled result fixture 不再构造 `messages: []`。

### 9.3 不修改

- JSONL/observation log schema；
- provider adapter 和 OpenAI-compatible message mapping；
- ToolRawResult/ObservationBuilder 契约；
- ShellTaskManager 的运行控制和查询语义；
- cancellation signal 与 protocol placeholder 语义。

## 十、分步实施顺序

### F1.1：Conversation 接口与 Golden Tests（已完成）

1. 增加 `InMemorySessionConversation` 和 pending state machine。
2. 为现有 completed、tool failure、model failure、cancelled、max iterations 构造 golden
   model input 序列。
3. 让 `runAgent()` 改用 conversation，但暂时保留外部行为。
4. 移除 `RunAgentResult.messages`，更新 RuntimeSession 和测试 helper。

完成条件：两轮及以上模型请求收到的 messages 与改造前逐条相同；提交矩阵全部通过。

### F1.2：TUI Projection Store（已完成）

1. 引入 bounded `TuiProjectionState` 和 policy。
2. 把现有 `applyAgentEvent()` 的展示映射迁入 projection reducer。
3. store 直接消费 `AgentEvent` 并只保存 projection。
4. App 改用 external store snapshot，删除 raw event replay。

完成条件：大 rawResponse/tool content 不出现在 snapshot；App 晚于 session 初始化 mount 时
仍能直接显示正确 session/MCP 状态。

### F1.3：Turn/Task 限界与 Ink 验证（已完成）

1. 实现 active/recent turn retention。
2. 实现 item/notices/terminal task caps 和 omitted counters。
3. Timeline 删除 events fallback，只渲染 visible projection。
4. 用真实 PTY 跑长 fake session，检查输入、Esc、`/quit` 和刷新延迟。

完成条件：累计事件增加时，projection/Ink item 数保持在 policy 内；所有 active background
tasks 始终可见。

### F1.4：Benchmark 与文档回填（已完成）

1. 运行结构性 stress test 和非门禁 heap benchmark。
2. 记录默认 policy 值的选择依据。
3. 更新 roadmap 状态和本设计的实际实现差异。

## 十一、测试计划

### 11.1 Conversation 单元测试

- system message 只初始化一次。
- 同时 begin 两个 turn fast-fail。
- committed messages + delta 的 model request 与当前实现逐条一致。
- model input 数组被 adapter 修改时不会污染 committed conversation；必要时在边界复制。
- append/commit/discard 状态转换非法时 fast-fail。
- completed、failed、cancelled 在 terminal event 成功后提交 delta。
- cancellation/tool failure 补齐后的 assistant/tool frame 对下一 turn 仍协议合法。
- model request 尚未产生 assistant 时失败，提交 user-only delta。
- unexpected reject 和 required sink failure discard delta。
- commit 后旧 pending handle 不能继续 append。
- `RunAgentResult` 三个分支都不含 messages。

### 11.2 Projection 单元测试

- `rawResponse`、Web/MCP 正文和完整 observation 不进入 snapshot。
- model/tool started 与 finished 仍更新同一个稳定 item。
- active turn 永不因 recent turn cap 被淘汰。
- 超过 item cap 后保留 prompt、running item 和 terminal item，并增加 omitted count。
- recent turns、notices 和 terminal tasks 始终不超过 policy。
- 所有 running/stopping tasks 始终保留。
- 同一 task 多个 lifecycle event 只保留最新 snapshot。
- 处理一千个 synthetic turns 后 snapshot 大小仍在 policy 内。
- `getSnapshot()` 在无事件时保持引用稳定，新事件后返回新引用。
- late subscriber 立即读取当前 snapshot，不 replay 原始历史。

### 11.3 Ink 组件测试

- Timeline 只接收 projected items，不接受 AgentEvent fallback。
- omitted marker 文案清楚区分 live view 和完整诊断历史。
- retained turns 的 prompt、assistant final、diff 和 Bash detail 继续正确渲染。
- 大量累计事件下，实际渲染 element 数不超过 visible policy。
- cancellation 的本地 `cancelling` 反馈和 terminal `cancelled` 状态不回归。

### 11.4 Runtime 集成测试

1. 连续多 turn 后，第二及后续模型请求历史和 F1 前完全一致。
2. tool batch 中途失败/取消，下一 turn 请求仍通过 OpenAI mapping。
3. terminal event append 失败，conversation 不前进且 session 进入 faulted。
4. TUI auxiliary projection sink 失败时，required logs 和 agent turn 仍按既有策略处理。
5. TUI runner 创建 session 后再 mount App，startup/MCP snapshot 不丢失。
6. real PTY 中执行长 fake session，`Esc` 和 `/quit` 仍及时生效。

### 11.5 完整门禁

```text
bun run check
real PTY smoke test
long-session structural stress test
```

heap benchmark 作为诊断证据，不替代结构性上限测试。

## 十二、验收标准

F1 只有在以下条件全部满足时完成：

1. 生产 `RunAgentResult` 不再包含 `messages`。
2. `runAgent()` 不接收 `initialMessages`，也不拥有 session commit 权限。
3. RuntimeSession 只通过一个 `SessionConversation` owner 管理跨 turn 历史。
4. 所有 golden model requests 与改造前逐条一致。
5. completed、failed、cancelled、unexpected reject 和 sink failure 提交矩阵通过。
6. TUI production state 中不存在无界 `AgentEvent[]`。
7. provider raw response 和完整 tool raw content 不被 presentation snapshot 长期持有。
8. recent turns、per-turn items、notices 和 terminal tasks 都受 policy 限制。
9. 除当前 active tasks 外，Ink live item 数不随累计 session events 增长。
10. required diagnostic logs 继续保存完整事件。
11. 真实 PTY 的输入、取消、退出和后台任务显示无回归。
12. 文档和 benchmark 明确说明 canonical conversation 在 F1 仍是内存增长项，不夸大结果。

## 十三、主要风险与处理

| 风险 | 处理 |
| --- | --- |
| 直接让 runAgent 修改 committed history，terminal event 失败时无法回滚 | 使用 pending turn delta；只有 RuntimeSession 能 commit |
| 为避免 copy 而把内部可变数组直接交给 provider | 只在 request boundary 临时 materialize，测试 adapter mutation 不污染 owner |
| 移除 messages 后测试无法检查历史 | 注入 InMemorySessionConversation fixture，不把完整历史放回生产 result |
| 有界 raw event ring 仍保留巨大 payload | 不 replay raw event；保存 bounded projection snapshot |
| 任意截取最后 N 个事件导致从 turn 中间恢复 | snapshot 按 turn 分组，late subscriber 直接读取当前状态 |
| Timeline 限界后用户误以为历史丢失 | 显示 omitted marker，明确完整诊断在磁盘；未来由 SessionStore 分页 |
| 淘汰后台任务导致正在运行任务不可见 | active tasks 永不因历史 cap 淘汰，只限制 terminal snapshots |
| 只限制数组数量但单条内容极大 | raw tool 内容不进入 projection；当前可见 prompt/final 受单 turn 保留，后续由 model output/context budget 继续约束 |
| 使用 Static/memo 后误以为状态已限界 | 结构性 policy 是门禁，渲染优化只能作为补充 |
| F1 被宣传为总内存已经有界 | 验收明确保留 O(H) in-memory canonical conversation 和 ShellTaskManager 残余 |

## 十四、最终设计决策

1. **RuntimeSession 通过 SessionConversation 成为完整对话的唯一长期 owner。**
2. **当前 turn 使用 delta，不在 runAgent 内长期持有另一份完整 working history。**
3. **模型请求边界允许临时展平数组，但数组不进入 RunAgentResult 或长期状态。**
4. **completed、failed、cancelled 在 terminal event 成功后提交；unexpected reject 和
   event failure 丢弃 delta。**
5. **TUI 不再保存或 replay 完整 AgentEvent 历史，而是维护有界 projection snapshot。**
6. **Projection 按 turn 分组并显式限制 recent turns、items、notices 和 terminal tasks。**
7. **Ink 只渲染 visible projection；Static/memo 不是有界性的替代品。**
8. **EventLog 继续保存完整诊断，TUI 淘汰不影响模型历史。**
9. **F1 不处理 SessionStore、compaction 和 ShellTaskManager archive。**
10. **只有 SessionStore 接入后，完整 canonical history 才从内存迁移到磁盘。**

用一句话收束：

```text
F1 = Single Conversation Owner
   + Turn-Local Delta
   + Transient Request Materialization
   + Bounded TUI Projection
   + Bounded Ink Live Tree
```

## 十五、实施回填

### 15.1 实际落地

- `InMemorySessionConversation` 持有唯一 committed message 数组；pending turn 只持有本 turn
  delta，并对并发 begin、settled 后 append/commit/discard 做 fast-fail。
- `runAgent()` 只接收 `AgentTurnConversation`，不再接收 `systemPrompt`、`userPrompt` 或
  `initialMessages`，三个 `RunAgentResult` 分支也都不再返回 `messages`。
- `RuntimeSession` 在 terminal event 成功后 commit；结构化 completed/failed/cancelled 提交，
  unexpected reject 和 required sink failure discard，后者会让 session 进入 faulted。
- `TuiProjectionStore` 直接作为 auxiliary sink，App 使用 `useSyncExternalStore()` 读取
  snapshot；`TuiEventStream` 和 Timeline 的 raw-event fallback 已删除。
- projection 按 active/recent turn 分组，notices、per-turn items、recent turns 和 terminal
  tasks 使用显式 policy；所有 running/stopping tasks 始终保留。
- `applyAgentEvent` 只作为现有测试调用点的兼容别名保留；生产 store 直接调用
  `reduceTuiProjection()`，两者都不保存 raw event。

### 15.2 结构性验证与 Benchmark

自动化门禁包含：

- conversation state machine、请求数组隔离和跨 turn golden input；
- completed、model failed、tool failed、cancelled、unexpected reject、required sink failure
  的提交矩阵；
- raw provider response、tool content 和 observation 不进入 projection snapshot；
- 1,000 个 synthetic completed turns 后，recent turns/items/notices/tasks 仍不超过 policy；
- Timeline 只接受 `TimelineItem[]`，late subscriber 直接读取当前 snapshot。

最终 `bun run check` 通过：typecheck、format、lint 和 287 项测试全部成功。真实 PTY 还验证
了连续两个 fake-model turns、`Esc` 从 `cancelling` 进入 terminal `cancelled`，以及
`/quit` 以 exit code 0 完成退出清理。

非门禁诊断命令：

```text
bun run bench:long-session 100
```

本机一次运行处理了 100 turns、300 次 request materialization 和 2,300 个事件。结果为：

- committed messages 从 system-only 增长到 801，最大临时 request view 为 798；
- recent turns 固定为 8，淘汰 92 个旧 turn；
- 第 10 至 100 turn 的完成态 visible items 始终为 89，active turn 峰值为 99；
- benchmark 输出 RSS/heap 仅作诊断，不作为跨机器门禁。

这组结果明确显示 F1 的边界：canonical in-memory conversation 仍按历史增长；有界的是
turn-local working state、TUI projection 和 Ink live tree。SessionStore 接入前不应把 F1
描述为“总内存常数化”。
