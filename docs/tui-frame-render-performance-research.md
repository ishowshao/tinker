# TUI 帧渲染性能：局部动画导致大面积重绘的研究

## 文档状态

- 日期：2026-07-26
- 状态：研究结论已实测，方案待决策，本次不实施
- 文档性质：性能研究 + 架构方案对比
- 相关实现：
  - `src/cli/tui-runner.tsx`（Ink `render()` 入口）
  - `src/tui/app.tsx`（活动帧布局）
  - `src/tui/event-store.ts`（时间线投影）
  - `src/tui/tui-projection-policy.ts`（投影上限）

本文回答一个具体问题：为什么在 footer 的 `Running` 位置放一个动画（spinner）会造成
整屏重绘和明显 CPU 消耗，以及要消除它需要付出什么代价。

结论先行：**问题不是"局部动画"，而是 Ink 的一帧是一个整体，而 Tinker 的帧通常比终端
还高。** 帧高度一旦达到视口行数，Ink 每帧都会清屏并重发全部内容。

## 一、结论

三条独立结论：

1. Ink 7 默认的写路径在任何变化时擦除并重写整帧；`incrementalRendering` 选项可以改成
   逐行 diff，但我们从未开启（`src/cli/tui-runner.tsx:259` 调用 `render()` 时不传任何
   options）。
2. 当帧高度 ≥ 终端行数时，Ink 走"清屏 + 重发 `fullStaticOutput + output`"的兜底路径，
   并且完全绕过逐行 diff。Tinker 的活动帧在 3 轮会话后就已经超过 40 行视口。
3. 每帧成本线性于帧行数（实测真实组件树 3.4ms@36 行 → 17.3ms@203 行）。因此动画帧率
   直接乘在这个成本上：80ms 的 spinner ≈ 216ms/s CPU + 每秒 12.5 次全屏清屏。

要让局部动画变便宜，唯一需要守住的不变量是：

> **活动帧行数 < 终端行数**

`<Static>` 是在保留历史的前提下把活动帧压小的手段，不是绕过这条不变量的手段——见
第四节第 3 张表。

## 二、Ink 7 的渲染机制

版本：`ink@7.1.0`、`react@19.2.7`。

| 机制 | 代码位置 | 行为 |
|---|---|---|
| 默认写路径（standard） | `node_modules/ink/build/log-update.js:48` | `eraseLines(上一帧行数)` + 重写整帧字符串 |
| 增量写路径（默认关闭） | `node_modules/ink/build/log-update.js:172-189` | 逐行比较，未变化的行只发 `cursorNextLine` |
| 溢出兜底 | `node_modules/ink/build/ink.js:89-112` → `:756-777` | 帧高 ≥ 视口行数时写 `clearTerminal + fullStaticOutput + output`，每帧一次，且不经过 log-update |
| 静态输出累积 | `node_modules/ink/build/ink.js:415-417` | `fullStaticOutput += staticOutput`，整场会话只增不减 |
| 渲染节流 | `node_modules/ink/build/ink.js:194` | `maxFps` 默认 30，即 33ms 预算 |

两个由此推出的要点：

- 溢出兜底路径下，开不开 `incrementalRendering` 没有任何区别（实测字节数完全相同）。
- 一旦使用 `<Static>` 又让活动帧溢出，兜底路径会把**整场会话已打印的静态输出**每帧
  重发一次，比现在更糟。

## 三、Tinker 当前的帧构成

`src/tui/app.tsx` 的活动帧自上而下包含：Header、`Timeline`（`visibleTimelineItems`
展开的全部可见项）、BackgroundTasks、可选面板（status/skills/mcp）、Footer、
PromptInput。全部处在同一帧内，没有任何 `<Static>`。

帧高度的上界由投影策略决定（`src/tui/tui-projection-policy.ts:8-13`）：

```text
recentTurnLimit: 8
itemLimitPerTurn: 40
```

即最多 8 轮 × 每轮 40 项，加上 diff、bash 预览、assistant markdown 的多行输出。实测
8 轮真实内容为 203 行，远超常见的 40 行视口。

## 四、实测数据

测量方法（可复现，见附录 A）：用一个假的 TTY `stdout`（`isTTY: true`、
`columns: 120`、`rows: 40`）统计写入字节数，用 Ink 的 `onRender` 回调取每帧
`renderTime`，然后只改动 footer 一行、重复 20~30 帧。环境：macOS arm64、Bun 1.3.12。
绝对值依机器而变，倍数关系是重点。

### 4.1 真实组件树，每次只改 footer 一行

| 场景 | 帧行数 | ms/帧 | 字节/帧（standard → incremental） | 全屏清屏 |
|---|---|---|---|---|
| 1 轮会话 | 36 | 3.4 | 1978 → 146 | 0 |
| 3 轮会话 | 83 | 7.0 | 3187 → 3187 | 每帧 |
| 8 轮会话（policy 上限） | 203 | 17.3 | 6902 → 6902 | 每帧 |
| 仅底部 chrome（2 项 + footer + prompt） | 26 | 2.2 | 1600 → 116 | 0 |
| 仅 footer + prompt | 7 | 0.5 | 899 → 58 | 0 |

### 4.2 帧行数的纯缩放曲线（合成树）

| 历史行数 | 活动帧内 ms/帧 | 放进 `<Static>` 后 ms/帧 |
|---|---|---|
| 20 | 5.0 | 0.60 |
| 60 | 13.1 | 0.54 |
| 200 | 41.2 | 0.55 |

活动帧内的成本线性于行数；移入 `<Static>` 后与历史长度无关（恒定约 0.55ms）。合成树
每行一个 `Text` 节点，因此每行成本高于真实树（真实树把多行打包进较少的 `Text`），两者
都是线性。

### 4.3 `<Static>` 的边界条件（200 行历史）

| 场景 | 帧行数 | ms/帧 | 字节/帧 | 全屏清屏 |
|---|---|---|---|---|
| `<Static>` + 45 行 live tail（溢出 40 行视口） | 503 | 7.2 | **14279** | 每帧 |
| `<Static>` + 25 行 live tail（装得下） | 233 | 4.3 | **137** | 0 |

这张表是第一节那条不变量的直接证据。

## 五、动画成本推算

以 4.1 的 8 轮会话（17.3ms/帧）为基准：

| 动画节奏 | CPU 时间 | 全屏清屏频率 |
|---|---|---|
| spinner 80ms（12.5fps） | ≈ 216 ms/s（约 22% 单核） | 12.5 次/秒 |
| 当前 1 秒读秒计时器 | ≈ 17 ms/s（可忽略） | 1 次/秒 |

补充两点：

- 合成 200 行时单帧 41ms 已超过 30fps 的 33ms 预算，Ink 追不上自己的节流。
- 当前已合并的 1 秒读秒计时器（`src/tui/app.tsx` 的 `useElapsedMs`）CPU 成本可忽略，
  但在帧高超过视口的会话里，它会把"每秒一次全屏清屏重画"变成常态心跳——在此之前只有
  事件才触发重画。开启 `incrementalRendering` 对这种溢出帧无效。这是本文之外需要单独
  决策的一个既有影响。

## 六、附带发现：markdown 渲染链路

与动画无关，但处在同一条每帧成本链上：

- `useShikiHighlighter`（`node_modules/@assistant-ui/react-ink-markdown/dist/useShikiHighlighter.js`）
  按**组件实例**创建 highlighter，没有模块级缓存。实测 `createHighlighter`（13 种语言）
  **64ms/实例**，每条 assistant 消息一个；其 `setHighlighter(undefined) → async →
  setHighlighter(fn)` 每次还会额外触发两次整树重渲染。
- `MarkdownText` 每次渲染都重跑 markdansi（0.133ms/条），没有按 text 记忆化。叠加其
  约 20 行输出的序列化成本，实测**每条 markdown 消息约 2ms/帧**（1 条 4.2ms、4 条
  14.4ms）。

修复方向：highlighter 提到模块级或 App 根 context 共享；`AssistantMarkdown` 按 text
记忆化。这两项独立于下面的架构方案，可单独实施。

## 七、方案 A：append-only 打印区 + 有界 live tail（推荐）

把时间线拆成"已定稿、打印一次、进入终端 scrollback"的静态区，和"仍会变化、留在活动帧
里"的 live tail。活动帧因此恒定为几十行，与会话长度无关。

### 7.1 语义前提（已在代码中验证成立）

- `updateTurnItem` 的所有调用点只作用于 `activeTurn`；`recentTurns` 只在
  `src/tui/event-store.ts:560` 被追加，从不回改。因此"已结束的 turn 不可变"成立。
- 更细一层也成立：只有 `status === "running"` 的项会被改写（`markRunningItemsFailed`、
  `applyTurnCancellation`）。因此提交粒度可以细到"activeTurn 中状态已定的最长前缀"，
  而不必等整轮结束。

### 7.2 改造点

1. `src/cli/tui-runner.tsx:259`：`render()` 传 `{ incrementalRendering: true }`。这是
   前提而不是替代品——帧装得下时字节数降 13~15 倍。
2. `src/tui/event-store.ts`：投影拆为 `committedItems`（append-only）与 live tail；
   提交规则见 7.1，turn 结束时提交剩余项。
3. `src/tui/app.tsx`：历史用 `<Static items={committedItems}>` 渲染；需要把
   `src/tui/components/timeline.tsx` 中私有的 `renderTimelineItem` 抽成可导出的
   `TimelineRow`。
4. 强制不变量：live 区行数 < `stdout.rows`（`useWindowSize` 已在 memory-browser 与
   file-viewer 中使用）。live tail 超限时截断并给省略提示。同时复查 FileViewer、
   MemoryBrowser、ResumeSessionPicker 这些浮层的高度上限——它们目前也会把帧顶穿。
5. 恢复会话：`ResumeProjectionReader` 读出的历史在挂载时一次性打印进静态区。
6. `src/tui/components/assistant-markdown.tsx`：共享 highlighter（第六节）。

### 7.3 需要接受的语义变化

`<Static>` 打印出去无法收回，以下都是行为变化而非实现细节：

- **notices 位置**：现在 `src/tui/event-store.ts:397` 把 notices 提到时间线顶部；
  append-only 日志只能按发生顺序就地打印。
- **省略标记失真**：`omittedTurnCount` / `omittedItemCount` 提示的内容其实仍在
  scrollback 中，这些标记在打印区是错的，应只对 live tail 生效；state 侧的裁剪保留。
- **resize 不再回流历史**：已打印行保持旧折行。
- **切会话**：`/clear`、fork、resume、切模型后旧会话历史留在 scrollback，只能补一条
  分隔线，无法擦除。
- **`fullStaticOutput` 内存**：整场会话的 ANSI 文本会累积在 Ink 内部字符串中
  （`ink.js:415`），长会话为数 MB 量级。

### 7.4 测试影响

- PTY journey 断言读的是可见屏幕，历史滚出屏幕后
  `expect(harness.screenText()).toContain("PTY_CANCEL_BLOCK")` 这类断言会失效，需要改
  为对 live 区断言。
- 建议新增一条守卫测试：断言活动帧渲染行数 < 视口行数，防止不变量被后续改动破坏。

### 7.5 预期收益

12.5fps 的 spinner 变为 0.5~4ms/帧 ≈ 6~50ms/s CPU、58~137 字节/帧、零全屏清屏。局部
动画重新变得可以负担。

## 八、方案 B：alternate screen + 自绘视口

`render()` 支持 `alternateScreen: true`。把 TUI 做成 vim/htop 那样的全屏应用，自己裁剪
到视口高度：帧恒等于视口，逐行 diff 一直有效，一切内容仍然可变、可随 resize 回流，
不需要 7.3 的"打印即定稿"纪律。

代价：自己实现滚动状态、按键与鼠标滚轮；失去终端原生 scrollback 与选中复制体验；代码量
高于方案 A。与既有的 terminal mouse tracking 设计线相关。

每帧成本约等于 4.1 中"36 行"一档（3.4ms），比方案 A 的 0.5~4ms 略高但同样有界。

## 九、不改架构时的缓解措施

- 保持当前 1 秒读秒（不引入 spinner），接受帧溢出会话里每秒一次全屏重画。
- 单独开启 `incrementalRendering`：只在帧装得下视口时有效，对 3 轮以上会话无效。
- 调低 `recentTurnLimit` / `itemLimitPerTurn` 让典型帧装进视口：实测 1 轮（36 行）无
  清屏、3 轮（83 行）已溢出，因此需要压到 1~2 轮，代价是屏幕上几乎没有历史。这条只是
  权衡，不是解法。

## 十、本次不包含

- 不实施上述任何改造；本文只固定研究结论与方案边界。
- 不改动投影策略默认值。
- 不引入 spinner 或其他高频动画。
- 不修改 Ink 依赖版本，也不 patch Ink。

## 十一、开放问题

1. 选方案 A 还是 B？两者互斥：A 保留原生 scrollback 与复制，B 保留历史可变与 resize
   回流。
2. 方案 A 下 notices 从"置顶"改为"按时序就地"，是否可接受？
3. live tail 的高度预算怎么定：固定行数，还是 `rows - 已保留的 chrome 行数`？
4. 第六节的 markdown 链路修复是否先于架构改造单独落地？它独立可验证、收益明确。

## 附录 A：测量方法

关键点是让 Ink 走真实的交互式写路径（`isTTY: true`），并把 `stdout` 换成计数器：

```tsx
class FakeStdout extends EventEmitter {
  columns = 120;
  rows = 40;
  isTTY = true;
  destroyed = false;
  writableEnded = false;
  writable = true;
  writableLength = 0;
  bytes = 0;
  text = "";
  write(data: string, callback?: () => void): boolean {
    this.bytes += Buffer.byteLength(data, "utf8");
    this.text += data;
    callback?.();
    return true;
  }
}

const instance = render(tree(0), {
  stdout: fakeStdout as unknown as NodeJS.WriteStream,
  stdin: fakeStdin as unknown as NodeJS.ReadStream,
  patchConsole: false,
  incrementalRendering, // 对照开关
  maxFps: 60,
  onRender: ({ renderTime }) => renderTimes.push(renderTime),
});
await instance.waitUntilRenderFlush();
// 首帧后清零计数，再只改 footer 一行连续 rerender
for (let tick = 1; tick <= 20; tick++) {
  instance.rerender(tree(tick));
  await instance.waitUntilRenderFlush();
}
```

判定指标三个：`onRender` 的 `renderTime` 均值（React + yoga + 序列化）、每帧写入字节数
（终端侧成本与闪烁来源）、以及输出中 `ESC[2J` 出现次数（全屏清屏次数，即
`ansiEscapes.clearTerminal` 的第一个序列）。`stdin` 需要提供
`isTTY`/`setRawMode`/`setEncoding`/`ref`/`unref`/`read`/`resume`/`pause` 的空实现。
