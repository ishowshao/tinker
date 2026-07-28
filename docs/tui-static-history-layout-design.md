# TUI 布局改造：不变历史进 `<Static>`

## 文档状态

- 日期：2026-07-28
- 状态：方案待评估，尚未实施
- 文档性质：实施方案（研究结论见 `docs/tui-frame-render-performance-research.md`）
- 目标：在**尽量不动业务逻辑**的前提下落地研究文档的方案 A
- 相关实现：
  - `src/cli/tui-runner.tsx`（Ink `render()` 入口）
  - `src/tui/app.tsx`（活动帧布局）
  - `src/tui/tui-projection-store.ts`（投影 store，本方案主要落点）
  - `src/tui/event-store.ts`（reducer，本方案**不动**）
  - `src/tui/components/timeline.tsx`

## 一、方案一句话

保持 `reduceTuiProjection` 与 `TuiProjectionState` 完全不变，只在 **`TuiProjectionStore`
里额外派生**一份 `{ committed, live }` 时间线切分，`committed` 交给 `<Static>` 打印一次，
`live` 留在活动帧。活动帧因此恒定在 4~11 行，与会话长度无关。

与研究文档 7.2 的差别只有一处，但很关键：**不把投影拆成两条状态**。切分是从既有快照
派生出来的纯函数结果，因此"移出 live 列表"与"追加 committed 列表"天然在同一次计算里
完成，7.1.3 要求的原子交接是构造性成立的，不需要靠实现纪律保证。

## 二、研究文档之外的新发现（这些改变了方案形状）

### 2.1 溢出兜底会清空终端 scrollback（严重）

`ansiEscapes.clearTerminal`（`node_modules/ansi-escapes/base.js:124`）的定义是：

```
ESC[2J  ESC[3J  ESC[H
        ^^^^^^ 连同 scrollback 缓冲区一起擦除
```

研究文档只把"帧高 ≥ 视口"当成性能问题。实际上在方案 A 下它是**正确性问题**：一旦活动帧
顶穿视口，Ink 会擦掉整个 scrollback，也就是擦掉我们打印出去的全部历史。Ink 紧接着会重写
`fullStaticOutput`（`ink.js:768`）把内容补回来，所以数据不会永久丢失，但代价是：整场会话
的 ANSI 文本每帧重发一次，用户的滚动位置被摧毁，终端里 Tinker 启动之前的内容也一并没了。

结论：

> **活动帧行数 < 终端行数**，从"性能不变量"升级为"正确性不变量"，必须有硬防线，
> 不能只靠调 policy。

顺带一提，这条也解释了为什么 `fullStaticOutput` 不该主动清理——它是这条兜底路径唯一的
数据来源。只在切会话时重置（见 5.4）。

### 2.2 现有浮层正好把帧钉在 `rows`，关闭时必然触发一次全屏清屏

`shouldClearTerminalForFrame`（`ink.js:89-112`）里 `isLeavingFullscreen = wasFullscreen &&
next < viewportRows`，而 `wasFullscreen` 的判定是 `>=`。

- `FileViewer`：`bodyRows = rows - VIEWER_CHROME_ROWS(3)`，加回 3 行 chrome 正好 `rows`。
- `MemoryBrowser`：同样是 `rows - BROWSER_CHROME_ROWS(3)`。
- `ResumeSessionPicker`：`(rows - PICKER_CHROME_ROWS) / SESSION_ROWS` 向下取整，通常略小于
  `rows`，但边界值会踩到。

也就是说**今天**每次关闭 `/view`、`/memory` 就已经在打一次 `clearTerminal`。今天无害；
Static 之后每次都会擦一遍历史。修法是把这三处的视口预算从 `rows` 改成 `rows - 1`。

### 2.3 slash 建议列表没有行数上限

`prompt-input.tsx:754` 的 `suggestions.map(...)` 直接铺开全部匹配命令，而
`availableCommands = 内置命令 + props.projectSlashCommands`，项目命令数量不可控
（`loadProjectSlashCommands` 扫目录）。在 24~30 行终端上敲一个 `/` 就可能顶穿视口。
这是 2.1 那条不变量的第二个破口，必须一起补。

（`@` 文件补全已经有上限：`MAX_FILE_MENTION_RESULTS = 8`。）

### 2.4 `<Static>` 会卸载已打印的 item，异步高亮永远追不上

`node_modules/ink/build/components/Static.js` 的核心是 `items.slice(index)` +
`useLayoutEffect(() => setIndex(items.length))`：**已打印的 item 在下一帧就从 React 树里
卸载了**。这正是它每帧成本恒定的原因，但也意味着：

`useShikiHighlighter`（`@assistant-ui/react-ink-markdown`）首帧返回 `undefined`，在
`useEffect` 里异步 `import("shiki")` 后才 `setHighlighter(fn)`。等它解析完成时，
assistant 消息早已打印并卸载——**代码块会永久失去语法高亮**。

所以研究文档第六节的 highlighter 修复不是"可以单独落地的独立优化"，而是本方案的
**前置必做项**。好消息是修完之后 markdansi 的记忆化就不需要了：Static 里每条消息只渲染
一次。

### 2.5 `ink-testing-library` 用的是 `debug: true`，现有 App 级测试基本不受影响

`node_modules/ink-testing-library/build/index.js` 传 `debug: true`，而 debug 路径
（`ink.js:352-360`）写的是 `this.fullStaticOutput + output`。也就是说 `lastFrame()`
**包含**静态输出。`src/__tests__/tui-components.test.tsx` 里 30 处 `<App>` 渲染、110 处
`lastFrame()` 断言绝大多数可以原样通过。

唯一需要留意的是 1219-1220 行 `/clear` 后 `expect(frame).not.toContain("old session
prompt")`——它依赖 `<Static key={sessionId}>` 触发 Ink 的 `handleStaticChange`
（`ink.js:324-327`）把 `fullStaticOutput` 清零。这恰好也是我们本来就需要的行为
（见 5.4），所以断言继续成立。

### 2.6 Ink 支持 `maxHeight`

`styles.js:249` 有 `setMaxHeight`。可以用 `<Box maxHeight={...} overflow="hidden">` 给
可变高度区域加硬上限，而不必像 `height` 那样把帧钉成固定高度（钉成固定高度会让每帧都是
满屏帧，成本回到 8ms 量级）。这是 2.1 那条不变量的兜底防线。

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

## 四、时间线流：丢掉省略标记

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

与 `visibleTimelineItems` 的唯一差别是**不注入两个省略标记**
（`projection-omitted-turns`、`turn-*-omitted-items`）。理由：

- 被 policy 裁掉的项在裁掉之前早就打印进 scrollback 了，"N 项已省略"在 append-only 日志里
  是**错误信息**——内容其实还在，往上滚就能看到。
- 这两个标记 id 稳定但文本会变（计数递增），放进 Static 会被永久冻结在第一个计数值上。

state 侧的裁剪（`limitTurnItems` / `recentTurnLimit`）保持不变，它约束的是内存与活动帧
状态量，与打印无关。

> 理论风险：如果某一项在"定稿"和"被裁掉"之间从未经过一次派生计算，它就永远不会被打印。
> 触发条件是单个 33ms 帧内涌入 40 个以上事件——每个工具调用都是一次真实 I/O，实际达不到。
> 唯一的批量入口是 resume 的 `hydrate()`，而那是一次性全量提交，反而正是我们要的行为。

## 五、逐文件改造点

### 5.1 `src/tui/tui-projection-store.ts`（主要落点，约 45 行）

在 store 内维护打印水位，`append()` / `hydrate()` 后重算：

```ts
private log: TuiTimelineLog = { committed: [], live: [] };
private printed = new Set<string>();

readonly getLogSnapshot = (): TuiTimelineLog => this.log;

private refreshLog(): void {
  const stream = timelineStreamItems(this.snapshot);
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

只增加 4.1 的 `timelineStreamItems` 与 `firstRunningIndex`。reducer 一行不改。

### 5.3 `src/tui/components/timeline.tsx`（约 10 行）

- 把私有的 `renderTimelineItem` 提成导出的 `TimelineRow`，供 `<Static>` 的 render prop 使用。
- `Timeline` 去掉 `<Text bold>Timeline</Text>` 标题与空态 `idle`——在 append-only 日志下，
  标题会夹在历史和当前运行行之间反复重绘，空态由 Footer 的 `idle` 表达。
  （现有 `Timeline` 测试只断言 item 内容，不断言标题，可原样通过。）

### 5.4 `src/tui/app.tsx`（约 35 行）

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
3. **切会话时显式清屏**。`/clear` 今天会把旧会话从屏幕上抹掉（`cli-pty-session.test.ts:39`
   的 `not.toContain("PTY_CLEAR_SEED")` 就是这条语义），Static 之后旧输出会留在屏上。
   建议在 `/clear`、`/resume`、`/fork`、切模型这四个命令**发起时**（而不是完成后）用
   `useStdout().write(ansiEscapes.clearTerminal)` 清一次。走 `useStdout` 而不是裸写
   `process.stdout`，是因为 Ink 的 `writeToStdout`（`ink.js:433-461`）会做
   `log.clear() → write → restoreLastOutput()`，帧簿记不会错乱。发起时清屏还能避开
   "resume 已 hydrate 的历史刚打印完就被擦掉"的时序问题。
4. **浮层不再替换整棵树**。今天 FileViewer 等浮层通过三元表达式吃掉整个布局；Static 之后
   历史仍然留在屏幕上方，浮层在下方的活动帧里渲染。这是可接受的（更像 `less`），但要求
   浮层遵守 5.6 的行数预算。

### 5.5 `src/cli/tui-runner.tsx`（约 10 行）

- `render(<App … />, { incrementalRendering: true })`。帧装得下之后字节数降 13~15 倍
  （研究文档 4.1）。这是前提不是替代品。
- 启动时后台预热 shiki（见 5.7），不阻塞首帧。

### 5.6 硬防线：把不变量做成结构约束（约 20 行）

按 2.1，这条不能靠"调 policy 让典型帧装得下"。三层：

| 层 | 做法 |
|---|---|
| 结构上限 | live 区、可选面板（status/skills/mcp）、BackgroundTasks 各自包一层 `<Box maxHeight={…} overflow="hidden">`，预算从 `useWindowSize().rows` 推导 |
| 列表上限 | slash 建议列表截断到 `min(8, rows - 10)` 并显示 `+N more`（2.3）；BackgroundTasks 超过 5 条折叠 |
| 浮层预算 | FileViewer / MemoryBrowser / ResumeSessionPicker 的 `rows` 改成 `rows - 1`（2.2）。写成 `props.viewportRows ?? windowSize.rows - 1`，显式传参的既有测试不受影响 |

live 区本身按 3.1 只有 1~3 行，`maxHeight` 只是兜底，正常路径永远不会被裁到。

### 5.7 shiki highlighter 提到模块级（约 50 行，**前置必做**）

新增 `src/tui/shiki-highlighter.ts`：模块级单例 + `useSyncExternalStore` 订阅，
`AssistantMarkdown` 同步读取当前值。`tui-runner` 启动时 fire-and-forget 触发创建
（实测约 64ms/实例，只发生一次）。在它就绪之前打印的 assistant 消息不带高亮——由于预热
在进程启动时开始、首条 assistant 消息在数秒之后，实际不会发生。

这一步顺带解决研究文档第六节的另外两个问题：每条消息一个 highlighter 实例（现在共享），
以及 `setHighlighter(undefined) → async → setHighlighter(fn)` 引发的两次整树重渲染
（现在没有了）。markdansi 的记忆化在 Static 下不再需要。

## 六、需要接受的语义变化

| 变化 | 说明 | 我的判断 |
|---|---|---|
| notices 从"置顶"改为"按时序就地" | append-only 日志只能按发生顺序打印 | 对日志式 UI 反而更自然 |
| 省略标记消失 | 内容其实还在 scrollback 里（第四节） | 净收益 |
| resize 不再回流历史 | 已打印行保持旧折行 | 与终端里其他工具一致 |
| 历史失去可回溯修改能力 | 压缩后置灰旧行、重新编号 turn 之类今后只能表达为"追加一行说明" | 本方案真正的代价 |
| `fullStaticOutput` 内存 | 整场会话的 ANSI 文本累积在 Ink 内部（`ink.js:415`），长会话数 MB | 不能主动清（2.1），只在切会话时重置 |
| 浮层不再遮住历史 | 见 5.4 第 4 点 | 可接受 |

## 七、测试影响

| 层 | 影响 |
|---|---|
| `tui-event-store.test.ts` | **零改动**（reducer 与 `visibleTimelineItems` 都没动） |
| `resume-projection.test.ts` | **零改动** |
| `tui-projection-store.test.ts` | 新增切分规则用例：running 项不进 committed、finished 后原子迁移、hydrate 一次性全量提交 |
| `tui-components.test.tsx` | 绝大部分零改动（2.5）；`Timeline` 标题相关无断言，安全 |
| PTY journeys | 需要逐条复核。历史滚出视口后 `screenText()` 读不到（`PtyTerminalScreen` 的 `scrollback: 0`），受影响的断言改用已有的 `transcriptText()` / `transcriptSince(mark)`。默认视口 30×120，多轮会话的早期内容会滚出去 |

建议新增两条守卫测试，直接盯 2.1 那条不变量：

1. **单元**：用假 TTY（`isTTY: true`, `rows: 24`）渲染最坏情况活动帧（live 区有 running 的
   Bash + 大 diff、状态面板展开、slash 建议铺开、多行 draft、长 notice），断言
   `onRender` 的帧行数 < 24，且输出中不含 `ESC[3J`。
2. **PTY journey**：跑一段多轮会话，断言首帧之后 `transcriptText()` 里不再出现 `ESC[3J`。

第 2 条是最有价值的一条——它把"永不顶穿视口"变成 CI 能持续验证的事实。

## 八、落地顺序

分三次提交，每次独立可验证、可回滚：

1. **highlighter 提到模块级**（5.7）。独立收益（每条 assistant 消息省 64ms + 两次整树
   重渲染），且是第 3 步的前置条件。
2. **硬防线**（5.6）。纯防御，不改布局，先把 2.2 / 2.3 两个破口堵上，并把守卫测试第 1 条
   先立起来。此时它对现有布局就已经能跑（现有布局本来也不该顶穿）。
3. **Static 切分**（5.1~5.5）+ `incrementalRendering` + 守卫测试第 2 条。

先做 1、2 的好处是：如果第 3 步评估下来不做，前两步的收益也已经落袋。

## 九、预期收益

| 指标 | 现在（8 轮会话，203 行帧） | 改造后 |
|---|---|---|
| 活动帧行数 | 203 | 4~11 |
| ms/帧 | 17.3 | 0.5~2 |
| 字节/帧 | 6902 | 58~140 |
| 全屏清屏 | 每帧 | 0 |
| 1 秒读秒计时器 CPU | 17 ms/s + 每秒一次全屏重画 | 可忽略，无重画 |
| 12.5fps spinner 可行性 | 216 ms/s（22% 单核） | 6~25 ms/s |

改动量估算：源码约 200 行，其中 `event-store.ts` 只有纯新增的 12 行，reducer、持久化、
resume 路径零改动。

## 十、需要你拍板的

1. **切会话是否保留"清屏"语义**（5.4 第 3 点）。保留 = 与今天一致、PTY 断言不动；不保留 =
   更像 shell，旧会话留在上方。我倾向保留。
2. **省略标记直接删掉**（第四节）是否可接受。我认为在 append-only 日志里它是错误信息。
3. **浮层不再遮住历史**（5.4 第 4 点）是否可接受，还是希望浮层出现时也清一次屏。
4. **是否要一个回退开关**（例如 `TINKER_TUI_STATIC=0` 走旧布局）过渡一个版本。CLAUDE.md
   倾向快速失败，我倾向不加；但这是一次用户可见的交互变化，加一版开关也说得过去。
5. **`recentTurnLimit` / `itemLimitPerTurn` 是否顺手调大**。Static 之后活动帧不再受它们
   影响，它们只约束内存和 `/status` 视图，可以放宽——但这属于独立决策，本方案默认不动。
