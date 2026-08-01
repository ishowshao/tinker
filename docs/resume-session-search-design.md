# `/resume` 会话面板搜索方案

## 文档状态

- 日期：2026-08-01
- 状态：待实施
- 范围：仅增加 TUI `/resume` 会话选择面板的本地摘要搜索
- 基线：现有 `SessionCatalog`、`TuiSessionController` 与
  `ResumeSessionPicker`

## 一、结论

第一版只提供一个窄能力：

> `/resume` 打开时读取当前 workspace 的全部 `SessionSummary`；空查询时面板只展示最近
> 20 个会话，非空查询时只用每个会话的 `firstUserPromptPreview` 在全部会话中匹配，并展示
> 最近更新的前 20 个匹配结果。

搜索只改变当前 picker 中的临时展示，不修改 session、canonical history、SQLite、事件、
prompt history 或 `/resume <完整 UUID>` 的直接恢复路径。

本方案明确不做跨会话全文检索。后续 user message、assistant message、tool result、model、
profile、session ID、状态、时间和 turn 数都不参与匹配。

## 二、冻结的产品契约

本阶段以下决策不再留作实现时选择：

1. 搜索字段只有 `SessionSummary.firstUserPromptPreview`。
2. 搜索候选集是当前 workspace 中 `SessionCatalog` 能列出的全部会话，不是默认展示的
   20 个会话。
3. 面板在任何状态下最多展示 20 个会话卡片：
   - 空查询：最近 20 个会话；
   - 非空查询：全部匹配会话中最近更新的前 20 个；
   - 匹配不足 20 个：有多少展示多少；
   - 没有匹配：展示明确的空结果。
4. 搜索不增加分页或“加载更多”。第 21 个及之后的匹配不会进入可导航列表，用户需要继续
   收窄查询。
5. 现有键盘优先交互、disabled session 规则、interrupted session 提示、焦点可见滚动和
   `/resume <完整 UUID>` 均保留。

“全部会话都能被搜索”描述的是候选集边界。没有首条用户提示预览的 session 仍可出现在
默认列表中，但在非空查询下不会匹配，因为本方案不允许用其他字段补充搜索文本。

## 三、现状与问题

### 3.1 当前数据读取

`SessionCatalog.list()` 当前已经：

1. 扫描当前 workspace 的全部合法 session 目录；
2. 逐个只读打开 SQLite 并构造 `SessionSummary`；
3. 过滤无有效内容的普通 session；
4. 按 `updatedAt` 倒序排序；
5. 最后才截取最近 20 条。

因此，当前实现的主要 I/O 成本已经发生在截取之前。搜索功能不需要增加全局索引、缓存或
逐次查询数据库，只需要把“读取边界”和“展示边界”拆开。

### 3.2 当前摘要与面板

`SessionSummary.firstUserPromptPreview` 来自第一条 user message：先合并空白、去除首尾空白，
再截取前 120 个字符。面板将该 preview 作为三行 session 卡片的第二行。

`ResumeSessionPicker` 当前只接收已经截断的 session 数组，并在其中维护：

- `selectedIndex`；
- `windowStart`；
- 根据终端高度计算的可见卡片数量；
- `↑/↓` 或 `j/k` 导航；
- `Enter` 恢复和 `Esc` 取消。

如果直接在 picker 当前收到的 20 条数据上增加 `filter()`，较早 session 永远无法命中，
不满足本方案的候选集契约。

## 四、目标与非目标

### 4.1 目标

1. `/resume` 每次打开都基于当前 workspace 的完整 session 摘要快照搜索。
2. 空查询保持现有最近 20 条体验。
3. 非空查询立即在内存中筛选全部摘要，并只展示前 20 个匹配。
4. 搜索输入支持中文、英文、大小写差异、普通编辑和终端粘贴。
5. 搜索前后保持现有 session 状态文案、可选性和恢复安全边界。
6. 结果列表继续受现有终端高度预算和焦点可见窗口约束。
7. 不增加 schema、migration、持久化状态或异步搜索竞态。

### 4.2 非目标

- 不搜索第二条及之后的 user message。
- 不搜索 assistant、tool、reasoning 或 observation 内容。
- 不搜索 model、profile、完整或短 session ID、状态、错误原因、时间或 turn 数。
- 不使用 `message_fts`，不做跨 session Recall，也不增加全局搜索数据库。
- 不做模糊匹配、拼音、同义词、相关性排序或匹配片段高亮。
- 不增加搜索历史、最近查询、保存查询或恢复上次查询。
- 不增加分页、加载更多、结果总览页面或 session 预览详情。
- 不改变 one-shot CLI、`/session delete` 或 `/resume <完整 UUID>`。
- 不缓存跨 picker 生命周期的 session 摘要；每次重新打开 `/resume` 都读取新快照。

## 五、用户交互

### 5.1 浏览状态

打开 `/resume` 后仍进入现有键盘选择面板：

```text
Resume session
↑/↓ or j/k to move · / to search · Enter to resume · Esc to cancel
```

浏览状态下：

- `↑/↓` 或 `j/k`：在当前展示的最多 20 条记录中移动；
- `/`：进入搜索状态，初始查询为空；
- `Enter`：恢复当前选中的 resumable 或 interrupted session；
- `Esc`：关闭 picker，并沿用现有 Static viewport 恢复行为。

### 5.2 搜索状态

进入搜索状态后展示单行查询输入：

```text
Resume session
Search: wav repair█
↑/↓ to move · Enter to resume · Esc to clear search
```

搜索状态下：

- 普通字符写入查询；
- `j/k` 是查询字符，不再承担导航；
- `↑/↓` 在当前最多 20 个搜索结果中移动；
- `←/→` 移动查询光标；
- `Backspace`、`Delete`、`Ctrl+A`、`Ctrl+E`、`Ctrl+U` 复用现有单行编辑语义；
- 终端粘贴作为查询文本插入，换行和连续空白在匹配时被规范化；
- `/` 在搜索状态中是普通查询字符；
- `Enter` 直接恢复当前选中的可恢复 session；
- `Esc` 清空查询并返回浏览状态，不关闭 picker；再次按 `Esc` 才关闭 picker。

搜索查询和模式只存在于当前 `ResumeSessionPicker` 实例。关闭、恢复成功或重新打开 picker
后都回到空查询浏览状态。

### 5.3 空结果与截断提示

无匹配时不保留旧列表，也不让 `Enter` 作用于隐藏的旧选择：

```text
No sessions match "wav repair" · Esc to clear search
```

footer 必须区分当前可导航结果与完整候选数量。建议文案：

```text
Showing 1–6 / 20 recent · 114 sessions total
Showing 1–6 / 20 results · 37 matches total
7 matches
No sessions match "wav repair"
```

具体窗口范围继续由现有 `windowStart` 和终端高度决定：

- 默认列表有超过 20 个候选时，`/ 20 recent` 表示展示边界，不表示 catalog 只有 20 条；
- 搜索命中超过 20 条时，`/ 20 results` 表示只有前 20 条可导航，同时报告完整命中数；
- 搜索命中 1 到 20 条时，直接报告实际命中数；
- 无匹配时不渲染 session 卡片。

## 六、搜索语义

### 6.1 唯一搜索字段

每个 session 的唯一搜索文本是：

```ts
session.firstUserPromptPreview ?? ""
```

匹配函数不得读取或拼接 `modelName`、`profileName`、`sessionId`、`status`、
`statusDetail`、时间或 turn 数。这样，用户看到一个搜索结果时，卡片第二行一定能解释它
为什么命中，不会出现由隐藏字段造成的“神秘匹配”。

preview 继续由 `SessionCatalog` 按现有规则生成。本方案不扩大 120 字符上限，也不为搜索
返回完整首条 prompt。查询只命中 preview 中实际保留的文本。

### 6.2 规范化

查询和 preview 使用同一个纯函数规范化：

1. Unicode `NFKC`；
2. 所有连续空白折叠为一个空格；
3. 去除首尾空白；
4. 转为小写。

规范化后的查询按空白拆成 term。每个 term 都必须是规范化 preview 的子串：

```ts
function matchesSessionPreview(session: SessionSummary, query: string): boolean {
  const terms = normalizeSearchText(query).split(" ").filter(Boolean);
  if (terms.length === 0) {
    return true;
  }
  const preview = normalizeSearchText(session.firstUserPromptPreview ?? "");
  return preview !== "" && terms.every((term) => preview.includes(term));
}
```

这是大小写不敏感的 AND 子串匹配，不是 fuzzy search。它允许 `wav repair` 命中同时包含
`wav` 和 `repair` 的 preview，而不要求两个 term 相邻；中文查询不依赖分词库。

### 6.3 顺序和展示上限

`SessionCatalog` 已按 `updatedAt` 倒序返回完整摘要。picker 的过滤必须保持输入顺序，不做
相关性重排：

```ts
const candidates = queryIsEmpty
  ? sessions
  : sessions.filter((session) => matchesSessionPreview(session, query));

const displayedSessions = candidates.slice(0, 20);
```

因此：

- 默认“前 20”是最近更新的 20 个 session；
- 搜索“前 20”是最近更新的 20 个匹配 session；
- 相同输入快照和查询始终得到相同顺序。

## 七、数据流与职责边界

### 7.1 新数据流

```text
/resume
  -> App.openResumePicker()
  -> TuiSessionController.listSessions()
  -> SessionCatalog.listAll(currentSessionId)
  -> 全部、按 updatedAt 倒序的 SessionSummary[]
  -> App 保存当前 picker 快照
  -> ResumeSessionPicker 本地匹配
       空查询 -> slice(0, 20)
       非空查询 -> filter(all) -> slice(0, 20)
  -> 现有 onSelect(session) -> controller.resume(sessionId)
```

搜索发生在 TUI 展示层，因为它只消费 `SessionSummary` 的 presentation preview。Catalog
只负责完整、只读、状态正确且顺序稳定的摘要快照，不接收查询，不承担按键级过滤。

### 7.2 为什么一次读取全部摘要

现有 `SessionCatalog.list()` 已经在截取 20 条之前扫描并读取全部 session。新增
`listAll()` 后：

- 每次打开 picker 的数据库读取次数不增加；
- 返回到 TUI 的小型摘要对象从最多 20 个变为全部；
- 每次按键只进行内存中的有界 preview 匹配；
- 不需要 debounce、AbortSignal、请求序号或异步 loading 状态；
- 不会出现较慢的旧查询覆盖较新的查询结果。

不跨 picker 打开周期缓存摘要。session lock、updated time、turn count 和状态都可能变化，
重新打开时应继续通过只读 Catalog 获取新快照。

### 7.3 存储边界

本方案不改变：

- `SessionSummary` 字段；
- session SQLite schema 或 fingerprint；
- canonical message、turn、iteration 或 context revision；
- lock 检查和 unavailable/incomplete 推导；
- session resume、recovery、lease 或 target-first switch；
- event、observation log 或 prompt history。

搜索词不写入日志或 session。Catalog 仍然不能回收 stale lock、修改时间或打开可写连接。

## 八、Picker 状态与列表行为

### 8.1 状态

在现有 position 之外增加本地搜索状态：

```ts
type ResumeSearchState = {
  mode: "browse" | "search";
  editor: LineEditorState;
};
```

单行编辑复用 `src/tui/line-editor.ts`，避免另引入 text-input 依赖，并保持 Unicode code
point 光标语义。搜索输入不需要 PromptDraft、图片、prompt history、slash suggestion 或文件
mention 能力。

### 8.2 查询变化后的选择

每次查询文本变化后：

1. 重新计算完整命中数；
2. 截取前 20 个结果；
3. 把 `windowStart` 重置为 `0`；
4. 选择展示结果中的第一个 selectable session；
5. 如果没有 selectable session 但存在结果，选择第一行；
6. 如果没有结果，不保留可恢复的隐藏选择。

这与 picker 首次打开时的选择规则一致，也避免索引在过滤后指向另一个意外 session。

导航继续使用 clamp，不在列表首尾循环。disabled 行仍可获得焦点以展示原因，但 `Enter`
不得调用 `onSelect`。

### 8.3 恢复中与失败

用户按 `Enter` 后沿用现有 `isResuming`：

- 冻结搜索编辑和列表导航；
- 展示 `Resuming <short-id>`；
- 成功后关闭 picker；
- 失败后保留原查询和结果，恢复输入并显示 `Resume failed: <reason>`。

恢复失败不重新读取 catalog，也不隐式清空查询。用户可以重试当前结果、修改查询或按
`Esc` 回到默认列表。

### 8.4 终端高度预算

Session 卡片继续占 3 行。浏览状态仍是 header、快捷键提示和 footer；搜索状态多一行
query editor，因此可见卡片数量必须按实际 chrome 行数计算：

```text
browse chrome rows = 3
search chrome rows = 4
visible cards = floor((viewport rows - chrome rows) / 3)
```

至少保留一个卡片容量；无结果时可以只渲染 chrome。进入或退出搜索导致可见卡片数量变化
时，必须重新约束 `windowStart`，保证当前选择仍在 viewport 内。

Picker 继续使用 `windowSize.rows - 1` 的非全屏预算。只有真正关闭 picker 时才由 App 执行
一次 Static viewport 恢复；输入搜索词和结果滚动期间不得触发 `clearTerminal` 或 Static
重挂。

## 九、代码落点

| 文件 | 变更 |
| --- | --- |
| `src/session/session-catalog.ts` | 抽出共享的完整扫描/排序路径；增加 `listAll(currentSessionId)`；现有 `list()` 继续截取最近 20 条 |
| `src/tui/tui-session-controller.ts` | picker 的 `listSessions()` 改为调用 `catalog.listAll()`，其他 session operation 不变 |
| `src/tui/components/resume-session-picker.tsx` | 增加搜索 editor、preview-only matcher、最多 20 条展示、空结果、命中总数和动态 chrome 预算 |
| `src/tui/app.tsx` | 保持现有 loading/request-id/恢复流程；只确认 ready state 可以保存完整摘要数组 |
| `src/__tests__/session-store.test.ts` | 覆盖 `list()` 最近 20 与 `listAll()` 完整、有序、状态一致 |
| `src/__tests__/resume-session-picker.test.tsx` | 覆盖匹配范围、20 条上限、键位、选择、空结果与窗口滚动 |
| `src/__tests__/tui-components.test.tsx` | 覆盖 `/resume` 打开、搜索较早 session、恢复与完整 UUID 直接路径 |
| `src/__tests__/cli-pty-session.test.ts` | 增加真实终端搜索输入、结果导航、Esc 两阶段语义和恢复 smoke |
| `docs/session-store-resume-design.md` | 实施时把“最近最多 20 个”的旧描述澄清为“Catalog 可提供全部，picker 默认/搜索最多展示 20” |

不修改 `SessionStore`、resume projection、session schema、Recall、slash-command parser 或公开
CLI 命令列表。

## 十、测试计划

### 10.1 Catalog

1. 构造超过 20 个合法 session，`list()` 仍只返回最近 20 个。
2. 同一 fixture 中 `listAll()` 返回全部有效候选并保持 `updatedAt` 倒序。
3. `list()` 与 `listAll()` 中相同 session 的 status、preview、turn count 和 model 完全一致。
4. incomplete、unavailable 和无 turn 普通 session 继续沿用现有纳入/排除规则。
5. 单个损坏 session 仍只产生 unavailable summary，不阻断完整列表。

### 10.2 纯匹配语义

1. 中文 preview 可按中文子串命中。
2. 英文匹配忽略大小写。
3. 连续空白、换行和全角兼容字符经过规范化后稳定匹配。
4. 多个 term 采用 AND 语义。
5. query 只命中第二条 user message 时不匹配。
6. query 只命中 model、profile、session ID、status 或 statusDetail 时不匹配。
7. preview 缺席时，任何非空 query 都不匹配。
8. 空白 query 等价于空查询。

### 10.3 展示上限

1. 空查询且总数超过 20：只渲染最近 20 条，第 21 条不可导航。
2. 非空查询命中超过 20：只渲染最近的 20 条，同时 footer 报告完整命中数。
3. 非空查询命中不足 20：全部渲染。
4. 无匹配：不渲染旧卡片，显示空结果，`Enter` 无效果。
5. 较早 session 不在默认 20 条中，但查询后进入匹配前 20，可以恢复。

### 10.4 键盘与选择

1. 浏览状态 `/` 进入搜索；搜索状态 `/` 写入 query。
2. 浏览状态 `j/k` 导航；搜索状态 `j/k` 写入 query。
3. 搜索状态 `↑/↓` 导航结果，`←/→`、Backspace、Delete 和 Ctrl 编辑查询。
4. 搜索状态第一次 `Esc` 清空并返回浏览，第二次 `Esc` 关闭 picker。
5. query 变化后选择第一个 selectable 结果；全部 disabled 时选择第一行但禁止恢复。
6. query 变化、进入/退出搜索和滚动时，selected row 始终可见。
7. 恢复失败后 query、结果和选择保留；恢复成功后 picker 关闭。

### 10.5 集成与真实 PTY

- `/resume` loading 完成后默认仍只看到最近 20 条。
- 输入搜索词可找到默认列表之外的 session 并恢复。
- current、active、incomplete、unavailable 仍不可选，interrupted 仍可恢复并显示原提示。
- `/resume <完整 UUID>` 不经过 picker 搜索，行为不变。
- 搜索输入和结果滚动不触发重复 `ESC[3J`；关闭 picker 只执行现有一次 viewport 恢复。
- 小终端中进入搜索后不会顶穿视口，焦点不会滚出可见区域。

## 十一、实施顺序与门禁

建议按以下顺序实施：

1. 先为 `SessionCatalog` 增加完整快照读取并锁定 >20 条测试。
2. 增加 preview-only 规范化和匹配纯函数测试。
3. 在 picker 中接入搜索状态、最多 20 条派生列表和选择重置。
4. 接入 controller 的完整摘要快照。
5. 补 App integration 和真实 PTY 用例。
6. 更新已有 resume 设计文档中的 20 条边界说明。

迭代期间运行：

```bash
bun run check:fast
```

源码、测试和 TUI 行为完成后必须运行唯一完整门禁：

```bash
bun run check
```

## 十二、完成条件

- 搜索字段严格只有 `firstUserPromptPreview`。
- 默认列表从全部候选中展示最近 20 条。
- 搜索在全部候选中执行，并只展示最近的前 20 个匹配。
- 匹配不足 20 条时全部展示，无匹配时没有残留旧选择。
- 键盘模式、disabled/interrupted 语义、焦点可见滚动和直接 UUID resume 无回归。
- 没有 schema、canonical history、事件、Recall 或跨生命周期缓存变化。
- 相关单元、组件、集成、真实 PTY 测试和 `bun run check` 全部通过。
