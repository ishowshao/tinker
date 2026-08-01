# TUI 可见增量输出技术方案

## 文档状态

- 日期：2026-08-01
- 状态：待实施，核心边界已确认
- 范围：只为交互式 TUI 增加 assistant 正文的可见增量预览
- 上位路线图：[`product-hardening-roadmap.md`](product-hardening-roadmap.md)
- 相关实现：
  - `src/model/openai-chat-model-client.ts`
  - `src/model/openai-chat-stream.ts`
  - `src/agent/loop.ts`
  - `src/agent/runtime-session.ts`
  - `src/tui/tui-projection-store.ts`
  - `src/tui/app.tsx`

## 一、结论

Tinker 保留现有完整响应合同：`ModelClient.request()` 继续返回一个经过严格校验的
`Promise<ModelRequestOutput>`，agent loop、ledger、canonical history、正式 runtime event
和 resume 都只消费完整响应。

流式接收过程中，OpenAI-compatible adapter 额外把已经通过当前 chunk 结构校验的
`delta.content` 片段发送到一条**临时 presentation 通道**。TUI 按当前 attempt 保留全部片段，
把“截至当前已流出的完整正文”作为 Markdown source 在 live 区持续重渲染；完整响应通过现有
mapper 后，再由 `assistant.progress` 或 `turn.finished` 原子替换为正式 Markdown 内容并进入
`<Static>`。

核心不变量是：

> 流式文本只是可丢弃的界面预览。只有完整 provider 响应通过现有严格校验并进入 ledger
> 后，才是 assistant 历史事实。

本方案不把增量文本定义成 `AgentEvent`，不分配 `eventSequence`，不写 JSONL、observation、
SQLite 或 Recall。临时 sink 失败只会关闭本次增量预览，不能使模型请求或 RuntimeSession
失败。

```text
OpenAI SSE chunk
  -> 在线 stream accumulator：校验并累积完整响应
       -> delta.content 片段：临时 presentation sink
            -> TUI live 区：当前完整 Markdown 前缀
       -> finish：现有严格 mapper
            -> ledger + 正式 AgentEvent
                 -> 现有完整 Markdown renderer + Static 历史
```

## 二、目标

1. TUI 在完整模型请求结束前显示正在生成的 assistant 正文。
2. 完整响应校验、tool-call 组装、ledger commit 和 canonical history 语义保持不变。
3. retry、取消、provider 失败或最终响应非法时，不留下半截 assistant 历史。
4. live 区使用当前已流出正文的完整 Markdown 前缀，视口跟随最新内容；不截断正文，也不降级为
   纯文本。
5. `/resume`、fork、session persistence 和 observation log 与当前行为完全一致。
6. `stream: false` 和 one-shot CLI 保持当前非增量行为。

## 三、非目标

- 不展示或传递 `reasoning_content` 的增量内容。
- 不新增 thinking/reasoning 状态行、字符计数或动画。
- 不展示尚未组装完成的 tool-call 名称、provider ID 或参数片段。
- 不实现增量 Markdown AST、block cache 或手工折行；每个可见帧仍使用现有 Markdown renderer。
- 不为 one-shot stdout 增加无法撤回的推测性正文输出。
- 不增加新的 profile 字段、环境变量或 slash command。
- 不修改 `assistant.progress` 的既有“完整中间说明”语义。
- 不为临时更新建立回放、诊断日志或通用 presentation event bus。

“忽略 reasoning”只限定本次可见增量功能。现有 stream accumulator 仍按当前协议累积
`reasoning_content`，完整 mapper、reasoning-only 判定、脱敏诊断和 retry 行为均保持不变；
这些内容不会进入新增的回调和 TUI preview。

## 四、为什么不复用正式事件总线

当前 `RuntimeSession.append()` 是正式事件提交路径：它校验 runtime identity、分配
`eventSequence`、进入串行 event tail，并把事件送到 required persistence sinks 和 auxiliary
presentation sinks。required sink 失败会 fault 当前 session。

如果把 token 或文本快照定义成 `assistant.delta` AgentEvent，再让 JSONL 和 observation sink
各自过滤，会产生错误的所有权：

- 类型上是正式事件，持久化层却必须知道并忽略它；
- `events.jsonl` 中会出现不可解释的 sequence 空洞；
- `void runtimeSession.append(...)` 的异步失败仍可能 fault session；
- 高频临时更新会进入正式 event tail，与 canonical 事件和磁盘写入争用；
- 将来新增 sink 时容易意外持久化完整生成过程。

因此本方案使用一个只服务当前界面的窄接口。它不是第二套 runtime event bus：没有 sequence、
时间戳、持久化、回放和可靠投递承诺，只有“按当前 provider attempt 尽力更新预览”的语义。

## 五、Model 层合同

### 5.1 保持 Promise 返回值

`ModelRequestOptions` 只增加一个可选的正文片段回调：

```ts
export type ModelRequestOptions = {
  signal: AbortSignal;
  identity?: {
    iteration: IterationIdentity;
    runtimeSession: RuntimeSessionContext;
  };
  onTextDelta?: (content: string) => void;
};
```

`content` 是 provider 当前 chunk 中的原始 `delta.content` 片段，不是累计快照。空字符串和
`null` 不触发回调。未提供回调时，streaming 与当前行为完全相同。

非流式请求不调用 `onTextDelta`。在完整响应返回前人为调用一次没有可见延迟收益，只会制造
一个马上被正式内容替换的 preview 帧。

### 5.2 accumulator 改成在线消费

将当前“收集全部 chunk 数组后一次性累积”收敛成有状态 accumulator：

```ts
class OpenAIChatStreamAccumulator {
  push(chunk: unknown): readonly string[];
  finish(): Record<string, unknown>;
}
```

`push()` 完成当前 chunk 的全部结构校验和状态合并后，才返回其中可展示的 content 片段。
若同一 chunk 同时包含 `content` 与 `tool_calls`，两者必须独立处理；tool-call fragment 非法时
整个 chunk 失败，不发送该 chunk 的 preview。

`finish()` 继续生成 non-streaming completion 形状，并交给现有
`fromOpenAIChatCompletion()` 校验 role、finish reason、usage、tool calls 和有效 assistant
内容。usage-only chunk、reasoning delta 和 tool-call fragment 都不产生可见文本。

保留现有 `accumulateOpenAIChatCompletionChunks()` 作为对 accumulator 的小型包装也可以，
便于继续覆盖现有纯函数测试；生产路径不再保存完整 chunk 数组。

### 5.3 回调不是成功承诺

某个 content chunk 合法，不代表完整响应最终合法。后续仍可能出现：

- malformed chunk；
- stream 中断或取消；
- 缺少终止 finish reason；
- 缺少 usage-only chunk；
- tool-call ID、类型、名称或参数不完整；
- 完整 mapper 拒绝响应。

因此 UI 必须把 preview 标记为临时内容，并在失败路径丢弃。adapter 不允许因 preview sink
不可用而改变 provider request 的结果。

## 六、Runtime 临时通道

### 6.1 窄接口

新增只描述正文片段的接口：

```ts
export type AssistantTextDeltaUpdate = IterationIdentity & {
  attemptNumber: number;
  content: string;
};

export interface AssistantTextDeltaSink {
  updateAssistantTextDelta(update: AssistantTextDeltaUpdate): void;
}
```

`CreateRuntimeSessionInput` 增加一个可选的 `assistantTextDeltaSink`。只有 TUI session 注入；
one-shot runner 不注入。`RuntimeSessionContext` 向 agent loop 暴露对应的可选、同步、
non-throwing presentation 方法。

TUI 中同一个 `TuiProjectionStore` 可以同时实现：

- `EventSink.append(event)`：消费正式、可持久化语义的 runtime event；
- `AssistantTextDeltaSink.updateAssistantTextDelta(update)`：消费可丢弃的正文片段。

共用一个 store 只为保证 React 看到原子的 render snapshot，不代表两种输入共享事件协议。

### 6.2 attempt 归属

`loop.ts` 必须在每次 provider attempt 内创建回调闭包，显式携带当前
`iterationId + attemptNumber`。不能只依赖 iteration，因为 transient retry 和
reasoning-only retry 会在同一 iteration 中重新 dispatch。

```text
model.request.started(attempt N) 已正式投影
  -> model.request(..., onTextDelta for attempt N)
       -> transient sink update(iterationId, attempt N, fragment)
```

TUI 只接受与当前活动 attempt 完全匹配的片段。旧 attempt、已结束 attempt 或错误 session
的更新直接忽略。

### 6.3 失败隔离

RuntimeSession 调用临时 sink 时捕获同步异常，并在当前 session 内禁用后续 delta 投递。
它不得调用 `RuntimeSession.append()`，也不得产生 `diagnostic.sink_failed`；正式事件 sink
仍继续工作，因此用户最终仍能看到完整回复或明确错误。

signal 已经 aborted 时，loop 不再投递新的片段。临时通道不启动独立异步任务，所以不存在
请求结束后仍等待发送的 loop 侧 timer。

## 七、TUI preview

### 7.1 状态归属

preview 只进入 `TuiProjectionStore` 派生的 render log，不进入 `TuiProjectionState`：

```ts
export type AssistantTextPreview = IterationIdentity & {
  attemptNumber: number;
  markdown: string;
};

export type TuiTimelineLog = Readonly<{
  committed: readonly TimelineItem[];
  live: readonly TimelineItem[];
  assistantPreview?: AssistantTextPreview;
}>;
```

这样可以保持以下边界：

- `reduceTuiProjection()` 仍是正式 AgentEvent 的纯 reducer；
- projection policy、recent turns、omission marker 和 resume snapshot 不认识 preview；
- preview 不可能进入 `<Static>` 的 committed item 集合；
- 正式内容与 preview 可以在同一次 store 更新中原子交接。

store 内按顺序保留当前 attempt 的全部正文片段；通知 React 时生成一个完整 Markdown source。
不设置独立字符上限，也不从头部截断。其生命周期只覆盖一次 provider attempt，体积由现有
模型输出预算约束，正式事件收口后立即释放。

### 7.2 通知节流

provider chunk 到达时立即追加到临时 buffer，但 React listener 使用 presentation 侧合帧：

- 第一个非空片段立即通知，保证首段反馈及时；
- 后续更新最多每 80ms 通知一次，且任意时刻最多存在一个待发送通知；
- 同一窗口中的多个片段只生成一个新 render snapshot；
- 每个 snapshot 都包含截至当时的完整 Markdown source，不丢片段；
- 正式 lifecycle event 到达时取消待发送的 preview timer，并以该 event 的收口规则为准。

节流不放在 model adapter 或 agent loop。模型层只负责协议与有序片段，具体界面可以按自己的
刷新成本选择策略；one-shot 等没有 sink 的 surface 不承担任何额外调度。

### 7.3 live Markdown 渲染

新增 `AssistantStreamPreview`，但不新增第二套正文 renderer：

- label 复用现有 `- assistant` 视觉，不增加 streaming 徽标或动画；
- 正文直接复用 `AssistantMarkdown`，输入是当前 attempt 已流出内容的完整 Markdown 前缀；
- 未闭合代码围栏、强调、列表或表格按当前前缀正常解析；后续片段补全语法时，允许此前内容
  重新排版；
- Markdown 视口固定高度并自动跟随底部，始终展示最新渲染结果；不对 source 做尾部切片或
  纯文本截断。

当前 live timeline 上限分别是 8 行和 3 行。模型请求期间 canonical live 区只有一条 running
model item，因此预算为：

```text
无后台任务：model 1 + assistant label 1 + Markdown viewport 6 = 8
有后台任务：model 1 + assistant label 1 + Markdown viewport 1 = 3
```

组件使用 `useBoxMetrics()` 测量完整 Markdown 的物理高度，并通过负 `top` 偏移把最后一屏放入
固定视口；该机制只裁剪终端可见行，不裁剪 Markdown source。终端宽度必须进入该子树的 render
identity，resize 时强制重新测量和回流。

流结束且完整响应通过 mapper、ledger 与正式事件提交后，store 在同一次 snapshot 更新中移除
preview。随后由现有 `TimelineRow` 渲染正式完整 Markdown，并把它作为唯一 assistant 正文进入
`<Static>`。

### 7.4 性能边界

`overflow="hidden"` 只能限制终端输出行数，不能消除完整 Markdown 的解析和 Yoga 布局成本。
因此本方案不宣称流式帧是 O(视口) 或固定成本：响应越长，单帧重渲染可能越慢。第一版选择
Markdown 语义一致性，并用 80ms 合帧、单一 pending timer 和固定 live 视口限制刷新压力与
终端输出。

实现验收必须覆盖代表性的长 Markdown 响应，记录实际帧耗时和输入响应；如果不能满足 TUI
可用性，则该阶段不能以纯文本或截断正文静默降级。后续优化仍须保持“完整 Markdown 前缀”
语义，可考虑 Markdown block 级缓存或窗口化，但不在第一版范围内。

## 八、生命周期与收口

| 输入 | Preview 行为 | 正式状态行为 |
| --- | --- | --- |
| `model.request.started` attempt 1 | 建立当前 attempt，清空旧 preview | 创建 running model item |
| `model.request.started` retry | 切换 attempt，清空失败 attempt preview | 更新同一 model item 为 retrying |
| 匹配 attempt 的 text delta | 追加片段，按 80ms 合帧渲染当前完整 Markdown 前缀 | 不产生 AgentEvent |
| 旧 attempt 或错误 identity 的 delta | 忽略 | 不变 |
| `model.request.failed` | 立即清空并停止接受该 attempt | 沿用现有 retry/failure 投影 |
| `model.request.finished`，正文为空 | 清空 preview | 后续只展示 tool 流程或错误 |
| `model.request.finished`，正文非空 | 停止接收，暂留 preview 等待正式正文 | model item 定稿 |
| `assistant.progress` | 同一次 store 更新中清空 preview | 完整中间正文进入 committed/Static |
| `turn.finished` | 同一次 store 更新中清空 preview | 完整最终正文进入 committed/Static |
| `turn.failed` / `turn.cancelled` | 清空，不保留半截文本 | 只展示现有失败或取消状态 |
| `session.finished` / session switch | 取消 timer 并清空 | 沿用现有 session 生命周期 |

不采用“失败后把 preview 标成 failed/cancelled 并提交 Static”的策略。未通过最终协议校验的
正文不能在当前终端成为永久历史，同时又在 `/resume` 后消失；失败路径只保留明确的 model
或 turn 错误。

## 九、Resume、one-shot 与配置语义

### 9.1 Resume

SQLite 和 `ResumeProjectionReader` 不保存、不读取 preview。resume 只重建完整 assistant
message、tool results 和 turn terminal state。中断发生在 stream 中间时，恢复后不会出现
半截内容，也不需要 delta replay 或去重水位。

### 9.2 One-shot

第一版不向 `StdoutEventPrinter` 注入临时 sink。one-shot stdout 无法撤回已经写出的非法、
失败或取消响应，而且 `run-runner.ts` 仍在 turn 完成后打印最终 `result.finalText`。为避免引入
新的推测性 stdout 合同和去重状态，本方案保持它的当前行为。

### 9.3 配置

不增加“visible streaming”开关：

- TUI + `stream: true`：provider 有 content delta 时显示 preview；
- TUI + `stream: false`：没有 preview，完整响应行为与当前一致；
- provider 没有及时分片或批量返回大 chunk：按实际收到的 content 片段展示，不伪造 token；
- one-shot：无论 profile 是否 streaming，都只显示现有正式输出。

## 十、代码落点

| 文件 | 变更 |
| --- | --- |
| `src/model/model-client.ts` | `ModelRequestOptions` 增加可选 `onTextDelta` |
| `src/model/openai-chat-stream.ts` | 把 accumulator 收敛为 `push()` / `finish()`，返回已校验 content fragment |
| `src/model/openai-chat-model-client.ts` | 在线消费 SDK stream，不再先保存完整 chunk 数组；按片段调用回调 |
| `src/agent/runtime-session.ts` | 增加可选 `AssistantTextDeltaSink` 接线与失败隔离，不经过 `append()` |
| `src/agent/loop.ts` | 每个 attempt 注入带 identity 的 non-throwing text callback |
| `src/cli/tui-runner.tsx` | 将当前 projection store 同时接成正式 event sink 和临时 text sink；deferred sink 只在 attach 后转发 delta |
| `src/tui/tui-projection-store.ts` | 维护 attempt 的完整片段、80ms 合帧和正式事件收口 |
| `src/tui/app.tsx` | 在 canonical live timeline 后渲染固定高度的 Markdown preview |
| `src/tui/components/assistant-stream-preview.tsx` | 复用 `AssistantMarkdown`，测量高度并让 live 视口跟随底部 |
| `src/model/fake-model-client.ts` | 增加一个显式、确定性的延迟分片测试场景 |

明确不修改：

- `src/events/types.ts`
- `src/events/jsonl-event-log.ts`
- `src/events/observation-text-log.ts`
- `src/events/stdout-event-printer.ts`
- `src/session/*`
- session schema 与 compatibility contract
- public config contract 和 README 配置表

## 十一、测试计划

### 11.1 Stream accumulator 与 adapter

1. `push()` 按 provider 顺序返回 content fragment，`finish()` 仍组装相同完整响应。
2. content 与 tool-call fragment 同 chunk 时独立消费，最终 tool call 保持严格校验。
3. malformed chunk 不产生该 chunk 的 preview，并按现有错误类型 fast-fail。
4. reasoning delta、usage-only chunk 和 tool-call-only chunk 不触发正文回调。
5. `stream: false` 不触发回调。
6. 使用可控 `ReadableStream` 延迟终止 chunk，证明首个 callback 发生在 `request()` settle 之前。
7. partial chunk 后 abort 仍返回现有 cancellation 结果，不产生完整 assistant message。

### 11.2 Runtime 隔离

1. delta sink 能在 request 尚未完成时收到 `iterationId + attemptNumber + content`。
2. sink 抛错后 turn 仍能完成，正式 event sink 继续收到最终事件。
3. retry 时 attempt 递增，旧 attempt 的 preview 不进入新 attempt。
4. abort 后不再投递片段。
5. `events.jsonl`、`observations.md` 和 SQLite 均不包含 preview marker 或半截正文。
6. tool call 只在完整 response mapping 和 ledger append 成功后执行。

### 11.3 TUI store 与组件

1. 首个片段立即出现，后续片段在 80ms 窗口内合并通知，且没有 timer backlog。
2. 每个 render snapshot 都包含当前 attempt 的完整有序正文，并忽略 stale attempt。
3. retry、失败、取消和 session finish 都清空 preview。
4. `assistant.progress` 与 `turn.finished` 在一个 store snapshot 中完成 preview → committed
   交接，不重复一帧。
5. 普通段落、列表、强调、链接、表格和未闭合代码围栏都由 `AssistantMarkdown` 渲染；语法补全
   后允许既有内容重新排版。
6. live Markdown 视口保持 6/1 行并跟随最新物理行，source 不截断；resize 后重新测量和回流。
7. 正式完成态仍由 `AssistantMarkdown` 渲染完整原文。
8. 多次 preview 更新不含 `ESC[3J`，不重放 Static history sentinel。
9. 长 Markdown fixture 验证刷新不会形成通知积压，并记录渲染耗时与按键响应。

### 11.4 真实 PTY

FakeModel 增加一个显式 streaming 场景，以两个不同 marker 分隔早期片段和最终正文：

1. 提交 Prompt 后，在 footer 仍为 running 时看到 early marker。
2. 最终 marker 尚未产生时，证明 request 仍未完成。
3. streaming 期间看到已经流出部分的 Markdown 样式，最新内容保持在 live 视口内。
4. 完成后看到完整 Markdown 进入 Static、idle footer 恢复，且 live preview 与正式正文不重复。
5. 取消场景不留下 early marker 作为 Static assistant 历史。
6. `/resume` 后只重建最终 canonical 回复，不重建 preview。
7. 使用 `transcriptSince(mark)` 证明增量更新没有清屏或重复打印旧历史。

### 11.5 真实 provider smoke

在资格矩阵内至少验证一个真实 streaming profile：

- 首个 content delta 的时间早于完整 request settle；
- 最终 TUI 文本与 `ModelRequestOutput.message.content` 完全一致；
- 含工具调用的 response 不提前执行工具；
- 用户取消后没有 canonical partial assistant；
- smoke 输出不记录凭据、请求正文、reasoning 原文或 tool-call 参数片段。

## 十二、实施顺序与门禁

1. 先完成在线 accumulator 和可控 delayed-stream 测试，保证完整响应行为不变。
2. 增加 runtime 临时 sink 与 retry/cancel 隔离测试，不接 UI。
3. 增加 TUI live Markdown preview、原子收口和组件测试。
4. 增加真实 PTY 场景与 provider smoke。

迭代期间运行相关测试和：

```bash
bun run check:fast
```

源代码实现完成后必须运行完整门禁：

```bash
bun run check
```

文档本身应通过：

```bash
git diff --check
bun run docs:check
```

## 十三、完成条件

- streaming TUI 在模型完整返回前，用 Markdown 展示当前已流出的完整正文前缀。
- live 视口高度和通知频率有界，始终跟随最新内容；Markdown source 不截断、不降级纯文本。
- 长响应下的 Markdown 重渲染成本经过测量，不产生通知积压或不可接受的交互阻塞。
- reasoning、tool-call fragment 和 provider raw response 不进入临时可见通道。
- preview 不属于 AgentEvent、canonical history、SQLite、JSONL、observation 或 Recall。
- retry、失败、取消、退出与 resume 均不留下半截 assistant 历史。
- 正式 assistant 内容仍经过现有严格 mapper，并由现有 Markdown renderer 只进入 `<Static>`
  一次。
- `stream: false` 与 one-shot CLI 没有行为变化。
- 相关单测、真实 PTY、真实 provider smoke 和 `bun run check` 全部通过。
