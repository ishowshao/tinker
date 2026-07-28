# TUI 布局改造：不变历史进 `<Static>`

## 文档状态

- 日期：2026-07-28
- 状态：方案待评估，尚未实施
- 文档性质：实施方案（研究结论见 `docs/tui-frame-render-performance-research.md`）
- 目标：在**尽量不动业务逻辑**的前提下落地研究文档的方案 A
- 性能边界：只保证**包含周期性动画的正常运行态活动帧**保持较小；Prompt 编辑态、
  浮层交互态不在本方案里重做
- 相关实现：
  - `src/cli/tui-runner.tsx`（Ink `render()` 入口）
  - `src/tui/app.tsx`（活动帧布局）
  - `src/tui/tui-session-controller.ts`（切会话提交点）
  - `src/tui/tui-projection-store.ts`（投影 store，本方案主要落点）
  - `src/tui/event-store.ts`（reducer，本方案**不动**）
  - `src/tui/components/timeline.tsx`

## 一、方案一句话

保持 `reduceTuiProjection` 与 `TuiProjectionState` 完全不变，只在 **`TuiProjectionStore`
里额外派生**一份 `{ committed, live }` 时间线切分，`committed` 交给 `<Static>` 打印一次，
`live` 留在活动帧。Prompt 被成功接纳后立即进入 `committed`；此后将来承载 footer / live
动画的正常运行态活动帧约 4~11 行，与会话长度和已发送 Prompt 的长度无关。

与研究文档 7.2 的差别只有一处，但很关键：**不把投影拆成两条状态**。切分是从既有快照
派生出来的纯函数结果，因此"移出 live 列表"与"追加 committed 列表"天然在同一次计算里
完成，7.1.3 要求的原子交接是构造性成立的，不需要靠实现纪律保证。

## 二、研究文档之外的新发现（这些改变了方案形状）

### 2.1 运行态溢出会让周期性动画退化为整场历史重放（严重）

`ansiEscapes.clearTerminal`（`node_modules/ansi-escapes/base.js:124`）的定义是：

```
ESC[2J  ESC[3J  ESC[H
        ^^^^^^ 连同 scrollback 缓冲区一起擦除
```

在方案 A 下，一旦**带周期性动画的运行态活动帧**顶穿视口，Ink 会擦掉整个 scrollback，
再用 `fullStaticOutput`（`ink.js:768`）补回 Tinker 历史。数据不会永久丢失，但每个动画 tick
都会重发整场会话的 ANSI 文本，用户滚动位置和 Tinker 启动前的终端内容也会被破坏。

结论：

> **包含周期性动画的正常运行态活动帧必须保持较小，并且小于终端行数。**

这不是"所有 TUI 状态永不溢出"的全局承诺。多行 Prompt 在编辑和 admission 期间仍可随输入
增高；Prompt 输入交互会在后续方案单独处理。本方案只约束成功接纳 Prompt 之后、未来会承载
周期性动画的运行区域。`fullStaticOutput` 仍只在切会话时重置（见 5.4）。

### 2.2 现有浮层正好把帧钉在 `rows`，关闭时必然触发一次全屏清屏

`shouldClearTerminalForFrame`（`ink.js:89-112`）里 `isLeavingFullscreen = wasFullscreen &&
next < viewportRows`，而 `wasFullscreen` 的判定是 `>=`。

- `FileViewer`：`bodyRows = rows - VIEWER_CHROME_ROWS(3)`，加回 3 行 chrome 正好 `rows`。
- `MemoryBrowser`：同样是 `rows - BROWSER_CHROME_ROWS(3)`。
- `ResumeSessionPicker`：`(rows - PICKER_CHROME_ROWS) / SESSION_ROWS` 向下取整，通常略小于
  `rows`，但边界值会踩到。

也就是说**今天**每次关闭 `/view`、`/memory` 就已经在打一次 `clearTerminal`。Static 之后
浮层滚动或关闭时可能重放静态历史。这里采用一个不改变交互模型的兼容修正：把这三处的视口
预算从 `rows` 改成 `rows - 1`。

### 2.3 Prompt 编辑态仍可能顶穿视口（已知、但不纳入本方案）

`prompt-input.tsx:754` 的 `suggestions.map(...)` 直接铺开全部匹配命令，而
`availableCommands = 内置命令 + props.projectSlashCommands`，项目命令数量不可控
（`loadProjectSlashCommands` 扫目录）；多行粘贴的 draft 本身也会持续增高。在 24~30 行
终端上，编辑态仍可能顶穿视口。

这不会进入已接纳 Prompt 之后的周期性动画帧：`turn.started` 创建的 Prompt item 出生即为
`status: "text"`，会立即提交到 Static，PromptInput 随成功的 `onSubmit` 清空。本方案不截断
draft、不修改 slash 建议和 Prompt 编辑行为，相关交互另案处理。

### 2.4 `<Static>` 会卸载已打印的 item，异步高亮永远追不上

`node_modules/ink/build/components/Static.js` 的核心是 `items.slice(index)` +
`useLayoutEffect(() => setIndex(items.length))`：**已打印的 item 在下一帧就从 React 树里
卸载了**。这正是它每帧成本恒定的原因，但也意味着：

当前 `AssistantMarkdownProvider` 已经在 App 根共享 `useShikiHighlighter`，但 highlighter
仍是在 `useEffect` 里异步创建。若 assistant 消息在它就绪前进入 Static，等解析完成时该消息
已经打印并卸载——**代码块会永久失去语法高亮**。

所以 highlighter 生命周期调整是本方案的**前置必做项**。不能只 fire-and-forget 后依赖
"首条回复通常更晚"；TUI 首次挂载 Static 前必须等初始化得到确定结果（成功，或确定降级为
无高亮）。现有 markdansi 记忆化不需要在本方案里顺手删除。

### 2.5 `ink-testing-library` 用的是 `debug: true`，现有 App 级测试基本不受影响

`node_modules/ink-testing-library/build/index.js` 传 `debug: true`，而 debug 路径
（`ink.js:352-360`）写的是 `this.fullStaticOutput + output`。也就是说 `lastFrame()`
**包含**静态输出。`src/__tests__/tui-components.test.tsx` 里 30 处 `<App>` 渲染、110 处
`lastFrame()` 断言绝大多数可以原样通过。

唯一需要留意的是 1219-1220 行 `/clear` 后 `expect(frame).not.toContain("old session
prompt")`——它依赖 `<Static key={sessionId}>` 触发 Ink 的 `handleStaticChange`
（`ink.js:324-327`）把 `fullStaticOutput` 清零。这恰好也是我们本来就需要的行为
（见 5.4），所以断言继续成立。

### 2.6 Ink 支持用 `maxHeight` 约束运行态可变区域

`styles.js:249` 有 `setMaxHeight`。可以用 `<Box maxHeight={...} overflow="hidden">` 给
运行态 live 区和后台任务区加上限，而不必像 `height` 那样把帧钉成固定高度（固定高度会让
每帧都是满屏帧，成本回到 8ms 量级）。它只用于控制动画运行态，不改变 Prompt 编辑态布局。

## 三、切分规则：为什么"状态非 running"就够

判定一个 item 能否打印，等价于判定它今后不会再被改写。四条约束叠加后结论很干净：

| 约束 | 依据 |
|---|---|
| 只有 `status === "running"` 的项会被回改 | `updateTurnItem` 的全部调用点：`model.request.started`(retry)、`model.request.finished`、`tool.raw_result`、`tool.finished`、`applyTurnCancellation`；外加 `markRunningItemsFailed` |
| 工具串行执行，同一时刻最多一个 running | `src/agent/loop.ts:357` 是 `for` 循环，`tool.started → raw_result → finished` 之间没有并发 |
| model iteration 行先于任何 tool 行定稿 | `model.request.finished` 在 `assistant.progress` 与 `tool.started` 之前发出 |
| `assistant.progress` 出生即定稿 | `loop.ts:349-355`，模型请求结束后一次性发送完整内容，不是流式增量 |

两个额外确认（研究文档 7.1 提过，这里逐点核对过调用点）：

- **取消/失败不会回改已提交行**。`applyTurnCancellation` 用 `iterationId` / `toolCallId`
  定位的行，在中断发生时必然还是 running（`finished` 事件根本没发出）；`agent_boundary`
  阶段则是 `appendTurnItem` 追加新行。`markRunningItemsFailed` 按定义只碰 running。
- **后台 bash 任务不在时间线上**。`bash.task.*` 只更新 `state.backgroundTasks`
  （`event-store.ts:217-227`），由独立面板渲染。这是"晚到事件"唯一的来源，而它已经被隔离了。

因此切分规则是：

```
settledEnd = 第一个 status === "running" 的下标（没有则 = 长度）
committed  += stream[0, settledEnd) 中尚未打印的 id
live        = stream[settledEnd, end)
```

用"最长定稿前缀"而不是"全部定稿项"，是为了保证打印顺序恒等于发生顺序；由于串行执行，
两者实际重合，`live` 通常只有 1 行（当前运行的工具行或 model 行），偶尔 0 行。

### 3.1 `tool.raw_result` 与 `tool.finished` 之间的中间态

这两个事件在 `loop.ts:429-437` 背靠背 `await`，中间态（文本已是最终形态、`status` 仍是
running、已挂上 diff/bash 预览）通常撑不过 Ink 的 33ms 节流，不会被渲染。即便渲染了也只是
在 live 区停留一帧，随后原子地移入 Static——**同一帧里不会两处同时出现**，因为两个列表
来自同一次派生计算。

## 四、时间线流：实时追加不打印省略标记，hydrate 例外

新增一个与 `visibleTimelineItems` 并列的导出（后者原样保留，它的全部测试不动）：

```ts
export function timelineStreamItems(state: TuiProjectionState): TimelineItem[] {
  return [
    ...state.notices,
    ...state.recentTurns.flatMap((turn) => turn.items),
    ...(state.activeTurn?.items ?? []),
  ];
}
```

正常 live append 路径与 `visibleTimelineItems` 的唯一差别是**不注入两个省略标记**
（`projection-omitted-turns`、`turn-*-omitted-items`）。理由：

- 被 policy 裁掉的项在裁掉之前早就打印进 scrollback 了，"N 项已省略"在 append-only 日志里
  是**错误信息**——内容其实还在，往上滚就能看到。
- 这两个标记 id 稳定但文本会变（计数递增），放进 Static 会被永久冻结在第一个计数值上。

但 `hydrate()` 必须保留一次省略说明。`ResumeProjectionReader` 只读取
`recentTurnLimit` 内的轮次，每轮也受 `itemLimitPerTurn` 限制；新打开的目标会话不能假设
更早内容已经存在于当前终端 scrollback。因此：

- 新会话的逐事件 append 使用 `timelineStreamItems()`，不打印会变化的省略标记。
- `hydrate()` 初始化日志时使用一次 `visibleTimelineItems(snapshot)`，把已有的 turn/item
  省略标记连同保留历史一起提交到 Static。它们描述的是这次恢复快照实际缺少的内容，语义准确。
- hydrate 完成后的新事件继续走无标记的 `timelineStreamItems()`；此后被 policy 裁掉的内容
  已经在本次终端会话里打印过，不再追加新标记。

state 侧的裁剪（`limitTurnItems` / `recentTurnLimit`）保持不变，继续约束投影状态量。
`refreshLog()` 在每次 store `append()` 时同步执行，不受 Ink 33ms 渲染节流影响，因此实时事件
不会在"定稿"与"裁剪"之间漏过提交。

## 五、逐文件改造点

### 5.1 `src/tui/tui-projection-store.ts`（主要落点，约 45 行）

在 store 内维护打印水位，`append()` / `hydrate()` 后重算：

```ts
private log: TuiTimelineLog = { committed: [], live: [] };
private printed = new Set<string>();

readonly getLogSnapshot = (): TuiTimelineLog => this.log;

private refreshLog(
  stream = timelineStreamItems(this.snapshot),
): void {
  const settledEnd = firstRunningIndex(stream);
  const pending = stream.slice(0, settledEnd).filter((i) => !this.printed.has(i.id));
  for (const item of pending) this.printed.add(item.id);
  this.log = {
    committed: pending.length === 0 ? this.log.committed
                                    : [...this.log.committed, ...pending],
    live: stream.slice(settledEnd),
  };
}
```

`append()` 在更新 snapshot 后调用无参 `refreshLog()`；`hydrate()` 则在校验 snapshot 后调用
一次 `refreshLog(visibleTimelineItems(this.snapshot))`，只在恢复入口把已有省略标记打印出来。
若构造器收到 `initialSnapshot`，按 hydrate 的同一规则初始化日志。所有 refresh 都发生在通知
listener 之前，React 每次只会看到原子完成的 `{ committed, live }`。

放在 store 而不是 App 里的三个理由：

1. **切会话自动重置**——每个会话都是一个全新的 `TuiProjectionStore` 实例
   （`tui-runner.tsx:159`、`:191`），累加器随实例一起换掉，不需要任何清理代码。
2. **`useSyncExternalStore` 友好**——`getLogSnapshot` 返回引用稳定的对象，不需要在 React
   渲染期做副作用（render-phase setState 或 mutable ref 那类写法）。
3. **可脱离渲染测试**——切分规则是纯逻辑，用现有的 `tui-projection-store.test.ts` 风格
   直接喂事件断言即可。

`getSnapshot()` 与 `TuiProjectionState` 的形状完全不变，所以 `ResumeProjectionReader`、
持久化、`validateInitialSnapshot` 全部不受影响。

### 5.2 `src/tui/event-store.ts`（约 12 行，纯新增）

只增加第四节的 `timelineStreamItems` 与 `firstRunningIndex`。reducer 一行不改。

### 5.3 `src/tui/components/timeline.tsx`（约 10 行）

- 把私有的 `renderTimelineItem` 提成导出的 `TimelineRow`，供 `<Static>` 的 render prop 使用。
- `Timeline` 去掉 `<Text bold>Timeline</Text>` 标题与空态 `idle`——在 append-only 日志下，
  标题会夹在历史和当前运行行之间反复重绘，空态由 Footer 的 `idle` 表达。
  （现有 `Timeline` 测试只断言 item 内容，不断言标题，可原样通过。）

### 5.4 `src/tui/app.tsx` + `src/tui/tui-session-controller.ts`（约 55 行）

```tsx
<Static key={binding.sessionId} items={log.committed}>
  {(item) => <TimelineRow key={item.id} item={item} />}
</Static>
<Box marginTop={1} flexDirection="column">
  <Timeline items={log.live} />
</Box>
```

四个配套动作：

1. **`Header` 一并进 Static**。它每会话恒定，打印一次当横幅，活动帧再省 2 行。
   （`<Header key={binding.sessionId}>` 已经是按会话 keyed 的，语义天然吻合。）
2. **`<Static key={binding.sessionId}>`**。切会话时 React 重挂 Static，reconciler 触发
   `onStaticChange` → `fullStaticOutput = ''`（`ink.js:324`、`reconciler.js:98-104`），
   既防止旧会话在兜底路径里被重放，也防止内存无界增长。
3. **切会话时在提交点显式清屏**。`/clear` 今天会把旧会话从屏幕上抹掉
   （`cli-pty-session.test.ts:39` 的 `not.toContain("PTY_CLEAR_SEED")` 就是这条语义），
   Static 之后旧输出会留在屏上。清屏不能放在命令发起时：若目标会话创建、旧会话 dispose
   失败，当前 binding 会保留，但其物理历史已经被擦掉且 Static 不会主动重放。

   App 用 `useStdout().write(ansiEscapes.clearTerminal)` 构造一个同步 `beforeCommit` 回调，
   传给 `/clear`、`/resume`、`/fork`、切模型的 controller 操作。
   `DefaultTuiSessionController.replaceSession()` 在**目标 binding 已创建、当前 session 已成功
   dispose 之后，`this.binding = target` 与通知 listener 之前**调用它。这样失败路径完全不
   清屏，成功路径又不会擦掉已经挂载的新 Static 历史。走 `useStdout` 而不是裸写
   `process.stdout`，继续让 Ink 维护正确的帧簿记。
4. **浮层不再替换整棵树**。今天 FileViewer 等浮层通过三元表达式吃掉整个布局；Static 之后
   历史仍然留在屏幕上方，浮层在下方的活动帧里渲染。这是可接受的（更像 `less`），但要求
   浮层遵守 5.6 的行数预算。

### 5.5 `src/cli/tui-runner.tsx`（约 10 行）

- `render(<App … />, { incrementalRendering: true })`。帧装得下之后字节数降 13~15 倍
  （研究文档 4.1）。这是前提不是替代品。
- 尽早启动 shiki 初始化，与其余启动 I/O 重叠；调用 Ink `render()` 前等待它得到确定结果
  （见 5.7）。

### 5.6 运行态布局边界（约 20 行）

这里约束的不是所有 TUI 状态，而是 Prompt 已成功接纳、draft 已清空、未来 footer / live
indicator 会周期性更新的正常运行态。`onSubmit` 已经会关闭 status/skills/mcp 面板并清掉旧
notice；ModelPicker 和三种浮层也不会与 agent turn 同时活动。因此只处理会与运行态动画共存
的可变区域：

| 层 | 做法 |
|---|---|
| 运行态总上限 | Static 之外的运行态根容器使用 `<Box maxHeight={rows - 1} overflow="hidden">` 作为最后兜底；只在 turn 运行期间启用，不影响编辑态 draft |
| 可变区域 | live 区和 BackgroundTasks 分别设 `maxHeight`；BackgroundTasks 超过 5 条折叠并显示 `+N more` |
| 浮层预算 | FileViewer / MemoryBrowser / ResumeSessionPicker 的 `rows` 改成 `rows - 1`（2.2）。写成 `props.viewportRows ?? windowSize.rows - 1`，显式传参的既有测试不受影响 |

live 区本身按 3.1 通常只有 0~1 个 item；上限只兜住偶尔渲染出来的 `tool.raw_result` 大 diff /
bash 预览。Prompt draft、slash 建议和 ModelPicker 的高度不在本方案中调整。

### 5.7 shiki highlighter 提到模块级并确定初始化边界（约 35 行，**前置必做**）

新增 `src/tui/shiki-highlighter.ts`：模块级单例持有初始化 Promise，以及最终稳定的 highlighter
函数或"不可用"结果。`tui-runner` 尽早调用 `prepareShikiHighlighter()`，继续并行完成 session、
MCP 等启动工作，在 Ink `render()` 前 `await` 同一个 Promise。实测初始化约 64ms；通常会被
其他启动 I/O 覆盖，最坏也只是把首帧延后这段时间。

`AssistantMarkdown` 挂载时只同步读取这个稳定结果，不再在 App 挂载后从 `undefined` 变成
函数。这样 fresh turn、resume hydrate、快速 fake/local model 都不会把"尚未就绪"的代码块
永久打印进 Static；初始化失败则确定性地降级为无高亮。当前 App 根共享和 markdansi 记忆化
都保留，本方案不顺手清理已有优化。

## 六、需要接受的语义变化

| 变化 | 说明 | 我的判断 |
|---|---|---|
| notices 从"置顶"改为"按时序就地" | append-only 日志只能按发生顺序打印 | 对日志式 UI 反而更自然 |
| 省略标记只在 hydrate 时出现一次 | 连续会话中内容仍在 scrollback，不再打印失真的递增标记；resume/fork 对快照缺失的旧内容保留准确说明 | 语义完整 |
| resize 不再回流历史 | 已打印行保持旧折行 | 与终端里其他工具一致 |
| 历史失去可回溯修改能力 | 压缩后置灰旧行、重新编号 turn 之类今后只能表达为"追加一行说明" | 本方案真正的代价 |
| `fullStaticOutput` 内存 | 整场会话的 ANSI 文本累积在 Ink 内部（`ink.js:415`），长会话数 MB | 不能主动清（2.1），只在切会话时重置 |
| 浮层不再遮住历史 | 见 5.4 第 4 点 | 可接受 |

## 七、测试影响

| 层 | 影响 |
|---|---|
| `tui-event-store.test.ts` | **零改动**（reducer 与 `visibleTimelineItems` 都没动） |
| `resume-projection.test.ts` | **零改动** |
| `tui-projection-store.test.ts` | 新增切分规则用例：running 项不进 committed、finished 后原子迁移、hydrate 提交保留项并只打印一次既有省略标记 |
| `tui-components.test.tsx` | 绝大部分零改动（2.5）；`Timeline` 标题相关无断言，安全 |
| PTY journeys | 需要逐条复核。历史滚出视口后 `screenText()` 读不到（`PtyTerminalScreen` 的 `scrollback: 0`），受影响的断言改用已有的 `transcriptText()` / `transcriptSince(mark)`。默认视口 30×120，多轮会话的早期内容会滚出去 |

建议新增两条守卫测试，直接盯"运行态周期性更新不重放历史"这个目标：

1. **单元**：用假 TTY（`isTTY: true`, `rows: 24`）先打印一段带唯一 sentinel 的长
   committed 历史，再进入包含 running tool、大 diff/bash 中间态和多个 BackgroundTasks 的
   运行态。标记 stdout 后用测试探针驱动两次仅改变 live chrome 的重渲染，断言后续写入不含
   `ESC[3J`，也不再包含历史 sentinel。Prompt 使用成功提交后的空 draft，不把编辑态混进
   这条验收；探针只存在于测试，不在本方案中新增产品动画。
2. **PTY journey**：跑一段多轮会话，在最后一个 Prompt 被接纳、Static 输出稳定后标记原始
   transcript，让 fake model 继续产生至少两个真实 live 更新；断言 mark 之后不出现
   `ESC[3J`，也不重复早期历史 sentinel。会话切换主动清屏不在这段采样窗口内。

第 2 条直接验证用户目标：历史长度不会重新进入周期性运行帧的写出成本。

## 八、落地顺序

分两次提交：

1. **highlighter 生命周期确定化**（5.7）。模块级单例、尽早启动、Ink render 前 await。
   这是 Static 正确打印 assistant 代码块的前置条件，可独立测试初始化成功与降级路径。
2. **Static 架构改造**（5.1~5.6）：store 切分、hydrate 一次性省略标记、会话切换提交点清屏、
   活动帧布局、浮层 `rows - 1`、`incrementalRendering`，以及第七节两条守卫测试一起落地。

不再把"全局活动帧硬防线"拆成一个前置提交：Static 落地前，现有多轮 Timeline 本来就会超过
视口；单独提交全局守卫没有成立的运行条件。Prompt 编辑交互不在这两次提交中调整。

## 九、预期收益

下表只描述 Prompt 已成功接纳后的正常运行态，不描述多行 draft 编辑或全屏浮层：

| 指标 | 现在（8 轮会话，203 行帧） | 改造后运行态 |
|---|---|---|
| 周期性重绘的活动帧行数 | 203 | 4~11 |
| ms/帧 | 17.3 | 0.5~2 |
| 字节/帧 | 6902 | 58~140 |
| 周期性运行帧触发全屏清屏 | 每帧 | 0 |
| 未来 1Hz 运行态动画（推算） | 17 ms/s + 每秒一次全屏重画 | 可忽略，无历史重画 |
| 12.5fps spinner 可行性 | 216 ms/s（22% 单核） | 6~25 ms/s |

改动量估算：源码约 220 行，其中 `event-store.ts` 只有纯新增的 12 行；reducer、持久化和
`ResumeProjectionReader` 不改。
