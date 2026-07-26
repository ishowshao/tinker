# 全局记忆：TUI 只读浏览器设计

## 文档状态

- 日期：2026-07-26
- 状态：待实现
- 上位文档：
  [`high-level-decisions.md`](high-level-decisions.md)
- 前置实现：
  [`atomic-memory-mvp-design.md`](atomic-memory-mvp-design.md)
- 目标：在已经落地的原子记忆 MVP 上增加一个纯 TUI、只读的 `/memory` 浏览入口

本文定义 atomic memory MVP 完成后的一个窄 follow-up。它只解决“用户如何直接查看当前全局
SQLite 中已经存储的原子记忆”，不开始实现搜索、状态、编辑、删除、clear、organize 或 CLI
管理面。

## 一、结论

新增无参数命令：

```text
/memory
```

该命令打开一个全屏只读面板，按创建时间从新到旧展示当前用户级全局数据库中的原子记忆。

整个操作是纯 TUI 本地读取：

- 不形成 agent Turn；
- 不调用模型；
- 不生成 query embedding；
- 不调用 `MemorySearch`；
- 不写 prompt history；
- 不进入 canonical Session history；
- 不产生 memory search 诊断日志；
- 面板内容不自动提供给模型。

数据只来自 `memory.sqlite`。`extracted-memories.log` 是开发期观察成功写入批次的日志，不是
存储真相，不能作为浏览器的数据源。

## 二、范围

### 2.1 本次包含

- 无参数 `/memory` slash command；
- 全屏只读记忆面板；
- 按创建时间倒序读取全部已存原子记忆；
- 记忆正文、来源 workspace 和创建时间；
- 固定行缓冲滚动；
- grapheme-safe 宽度测量和控制字符安全显示投影；
- 与 FileViewer 共用的终端 mouse tracking hook；
- 空库、未配置、初始化失败和运行时读取失败的本地反馈；
- store、coordinator facade、TUI component、App 接线和真实 PTY 验证；
- 对现有两份全局记忆文档中冲突契约的同步修订。

### 2.2 本次明确不包含

- `/memory` 的任何参数或子命令；
- `/memory search`、`status`、`delete`、`clear` 或 `organize`；
- `tinker memory ...` CLI；
- `tinker run` 的 memory surface；
- 记忆编辑、选择、确认或批量操作；
- FTS、关键词过滤、workspace filter 或语义排序；
- 面板内手动刷新、自动刷新、SQLite polling 或文件监听；
- 独立的只读数据库连接；
- 数据库分页、cursor 或懒加载；
- schema、table、index 或 migration 变更；
- memory worker 状态和诊断指标面板；
- 为未来管理功能提前展示内部 ID。

## 三、命令契约

slash command 声明固定为：

```ts
{
  name: "memory",
  usage: "/memory",
  description: "Browse stored global memories",
}
```

解析规则：

- `/memory` 返回 `{ type: "memory" }`；
- `/memory ` trim 后仍等价于 `/memory`；
- `/memory` 后出现任何参数都返回 `Usage: /memory`；
- 命令在 slash command autocomplete 中始终可见，即使当前进程没有启用 memory。

命令始终由 `App` 本地截获，不能经过 `submitAgentPrompt()`。这与 `/view`、`/skills` 和
`/mcp` 的本地命令边界一致。

## 四、展示与交互

### 4.1 全屏面板

面板替换正常的 Header、Timeline、Footer 和 PromptInput。它必须加入 `App` 现有
`fileView`、`resumePicker` 全屏分支链，使 PromptInput 在面板打开期间被卸载，避免多个
`useInput` 同时接收按键。

布局固定为：

```text
Global memory
↑/↓ or j/k · PgUp/PgDn · Home/End · mouse wheel · Esc close

2026-07-26 14:32 · /Users/cyberoldman/htdocs/tinker
在 Tinker 仓库中，源代码变更完成前必须通过 bun run check。

2026-07-25 09:18 · /Users/cyberoldman/htdocs/other-project
另一条已经存储的原子记忆。

1–8 / 42 lines · 17 memories
```

页脚的行范围表示当前可见的物理行位置；memory 部分只显示数据库 snapshot 中的记忆总数。

每条记录展示：

- 本地可读的创建时间；
- 完整的绝对来源 workspace；
- 可完整浏览的记忆正文安全显示投影。

不展示：

- `memory_id`；
- `source_session_id`；
- `source_turn_id`；
- embedding；
- score。

`memory_id` 只用于数据库确定性排序和 React key，不作为普通用户身份显示。

### 4.2 固定行缓冲

记忆正文最多 512 UTF-8 bytes，但在窄终端中仍可能换成多行。面板不能同时维护“数据库页”、
“视口页”和“选中条目”三套位置。

布局使用一个只依赖当前 snapshot 和正文列宽的纯函数：

```ts
function layoutMemoryLines(
  memories: readonly StoredMemorySummary[],
  contentWidth: number,
): readonly MemoryDisplayLine[];
```

该函数先把数据库中的原始正文投影为只用于 TUI 展示的安全文本：

- `\r\n` 和单独的 `\r` 统一为 `\n` hard break；
- `\t` 固定展开为 4 个空格，与 FileViewer 一致；
- 除 `\n` 外的 C0、DEL 和 C1 控制字符替换为可见的 `U+FFFD`；
- 不修改数据库正文、hash、embedding、提取日志或 `MemorySearch` 返回值。

归一化顺序固定为：

```ts
function normalizeMemoryDisplayText(text: string): string {
  return text
    .replaceAll(/\r\n?/g, "\n")
    .replaceAll("\t", "    ")
    .replaceAll(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
      "\uFFFD",
    );
}
```

该归一化是显示边界，不是存储 migration。当前提取器和 Store 只校验 trim、byte limit 等
合同，正文内部的 tab、CR、BEL、ESC 或其他控制字符可能已经存在，不能直接交给终端，也不能
把它们当作 0 列字符参与布局。

安全显示文本按 `\n` 拆成逻辑行，包括连续换行产生的空行。每个逻辑行再由
`new Intl.Segmenter("und", { granularity: "grapheme" })` 遍历。一个 unit 固定是一整个
grapheme cluster，不能是 Unicode code point。每个 grapheme 只调用一次
`Bun.stringWidth()`，按 `contentWidth` 累加并直接生成物理正文行。这样 ZWJ emoji、肤色
修饰符、regional indicator 和 combining mark 不会被重复计宽，也不会在 cluster 内部折行。

```ts
type MemoryDisplayLine = {
  readonly kind: "metadata" | "text" | "separator";
  readonly memoryIndex: number;
  readonly memoryId: string;
  readonly text: string;
};
```

每个 metadata、折好的正文行、原始空行和记录间 separator 都直接对应一个
`MemoryDisplayLine`，不保留中间测量缓存。metadata 始终只占一行，workspace 使用
`wrap="truncate-middle"`，避免绝对路径在窄终端撑破布局。

组件只使用一个 memo：

```ts
const displayLines = useMemo(
  () => layoutMemoryLines(props.memories, contentWidth),
  [props.memories, contentWidth],
);
```

组件只维护：

```ts
const [topLine, setTopLine] = useState(0);
```

终端尺寸变化后重新生成行缓冲，并把 `topLine` clamp 到新的合法范围。

本次没有可执行的条目操作，因此不增加 selected memory 或条目 cursor。

### 4.3 按键

- `↑`、`k`：向上滚动一行；
- `↓`、`j`：向下滚动一行；
- `PgUp`：向上滚动 `bodyRows`；
- `PgDn`：向下滚动 `bodyRows`；
- `Home`：跳到第一行；
- `End`：跳到最后一个完整视口；
- 鼠标滚轮：每次滚动 3 行；
- `Esc`：关闭面板，恢复正常 TUI。

鼠标滚轮不能只复用转义序列 parser。终端只有在应用显式开启 mouse tracking 和 SGR mouse
mode 后才会发送该输入。实现时把 FileViewer 私有的 enable/disable effect 和
`parseMouseWheelInput()` 抽到一个窄的共享 `terminal-mouse.ts`：

```ts
useTerminalMouseTracking();
parseMouseWheelInput(input);
```

共享 hook 在 TTY stdout 上挂载时写入 `?1000h` 和 `?1006h`，卸载时写入对应 disable
sequence。FileViewer 和 MemoryBrowser 都调用该 hook。两个全屏 viewer 由 App 保证互斥，
不需要引用计数或全局 mouse manager。

本功能不重构通用 viewer framework，也不支持水平滚动；正文通过折行展示，workspace 单行
中间截断。

### 4.4 snapshot 生命周期

每次打开 `/memory` 时同步读取一次数据库，形成该次面板的固定 snapshot。面板打开后不再
读取或观察数据库变化。

completed Turn 的后台提取可能在主响应结束后仍在进行，因此用户紧接着打开 `/memory` 时，
最新记忆可能尚未提交。这是允许的。用户关闭面板后再次执行 `/memory`，才会创建新的
snapshot。

### 4.5 空库

数据库可用但没有记录时，面板显示：

```text
Global memory
↑/↓ or j/k · PgUp/PgDn · Home/End · mouse wheel · Esc close

No stored memories.

0 memories
```

## 五、数据读取

### 5.1 共享类型

`StoredMemorySummary` 是存储层和 UI 共用的基础投影：

```ts
export type StoredMemorySummary = {
  readonly memoryId: string;
  readonly text: string;
  readonly sourceWorkspace: string;
  readonly createdAt: string;
};

export type MemorySearchMatch = StoredMemorySummary & {
  readonly score: number;
};
```

这样列表和搜索不会重复声明相同字段，也不会让存储浏览类型反向依赖搜索结果类型。

### 5.2 Store API

`MemoryStore` 新增同步方法：

```ts
listStoredMemories(): readonly StoredMemorySummary[];
```

查询固定为：

```sql
SELECT memory_id, text, source_workspace, created_at
FROM memories
ORDER BY created_at DESC, memory_id DESC;
```

规则：

- 调用前执行现有 `requireOpen()`；
- 使用现有 SQL row validation helper 校验每个字段；
- `created_at` 继续使用现有 UTC timestamp validator；
- 返回冻结的 records 和数组；
- 不选择、读取或解码 `embedding`；
- 不执行第二次 `COUNT(*)`，总数就是结果数组长度；
- 任一 row 非法时整次读取失败，不返回部分 snapshot。

`created_at DESC` 表示最新批次优先。同一批 `insertBatch()` 共享一个 `created_at`，
`memory_id DESC` 只提供稳定的次级顺序，不承诺额外业务语义。

### 5.3 为什么不分页

本次不使用 keyset 或 offset pagination：

- 现有 `MemorySearch` 每次已经全表扫描并解码所有 embedding；
- 浏览器只读取文本和少量元数据，单行成本更低；
- 每条正文已有 512-byte 上限；
- 浏览器是用户主动打开的低频本地界面；
- 分页会引入 cursor、缓存和可变高度条目之间的额外状态；
- 当前没有实际数据证明需要限制只读文本 snapshot。

本次也不设置任意的“最近 2000 条”硬上限，因为 `/memory` 的合同是查看当前已存记忆，而不是
只查看一个不可配置的最近子集。如果真实使用证明全量读取或行缓冲导致可感知卡顿，再根据
实际数量和耗时调整 UI 布局策略，不能提前猜测数据库阈值或预建测量缓存。数据库全量读取和
UI 折行是两个不同的成本；前者比现有 embedding 全表扫描更轻，后者先使用 4.2 的直接布局，
只在真实 benchmark 证明需要时再优化。

## 六、所有权和生命周期

### 6.1 单一 Store

现有 `MemoryCoordinator` 创建并独占 `MemoryStore`，退出时由 coordinator 关闭。浏览器必须
复用这一个 store，不能为了“只读”另开连接。

`MemoryCoordinator` 增加同步 facade：

```ts
listStoredMemories(): readonly StoredMemorySummary[] {
  return this.store.listStoredMemories();
}
```

完整调用链：

```text
App /memory
  -> injected listStoredMemories function
  -> MemoryCoordinator.listStoredMemories()
  -> MemoryStore.listStoredMemories()
  -> memory.sqlite
```

`App` 不持有 coordinator，不直接导入 `MemoryStore`，也不知道 SQLite 路径。

### 6.2 同步读取与写入

`bun:sqlite` API 是同步的。当前提取 worker 和 TUI 读取运行在同一个 JavaScript 线程；
`listStoredMemories()` 只能发生在 `insertBatch()` transaction 之前或之后，不会插入事务
中间观察部分批次。

因此本功能不增加读写 mutex、队列、retry 或并发集成测试。

### 6.3 退出

面板不持有独立连接和异步读取任务。TUI 退出仍由既有 coordinator disposal 关闭 store，
不增加 cleanup 顺序。

## 七、Composition 与 App 状态

### 7.1 Runner 注入

`runTui()` 只向 `App` 注入一个窄函数：

```tsx
<App
  listStoredMemories={
    memoryCoordinator === undefined
      ? undefined
      : () => memoryCoordinator.listStoredMemories()
  }
  memoryDisabledNotice={memoryNotice}
  // existing props
/>
```

不能把 coordinator、store 或 database 暴露给 TUI component。

### 7.2 App props 和 state

新增：

```ts
type AppProps = {
  // existing props
  listStoredMemories?: () => readonly StoredMemorySummary[];
  memoryDisabledNotice?: string;
};

type MemoryViewState = {
  readonly memories: readonly StoredMemorySummary[];
};
```

`openMemoryView()` 同步调用注入函数：

- 函数存在且读取成功：设置 `memoryView`；
- 函数不存在且有 `memoryDisabledNotice`：原样再次显示该 notice；
- 函数不存在且没有初始化错误：显示 `memory disabled: not configured`；
- 读取抛错：不打开面板，显示 `memory unavailable: <bounded reason>`。

初始化失败的 bounded notice 已由 `initializeTuiMemory()` 生成并在 TUI 启动时展示过。
`/memory` 不能为同一个失败重新发明另一套原因或绕过初始化校验读取数据库。

### 7.3 App 接线位置

`App` 至少需要完成以下接线：

1. 增加 `memoryView` state 和 open、close handlers；
2. 在 `onSubmit()` 开头现有的本地面板 reset 区保持面板互斥；
3. 在 slash command 分发中处理 `{ type: "memory" }`；
4. 在全屏 `fileView` / `resumePicker` 条件链中加入 `MemoryBrowser`；
5. 确保打开面板后 PromptInput 被卸载；
6. 关闭面板后 PromptInput 重新挂载并获得输入权。

## 八、失败语义

| 状态              | `/memory` 行为                                        |
| ----------------- | ----------------------------------------------------- |
| memory 未配置     | 不打开面板，显示 `memory disabled: not configured`    |
| memory 初始化失败 | 不打开面板，复用启动时的 bounded notice               |
| store 可用且为空  | 打开面板并显示 `No stored memories.`                  |
| 同步读取失败      | 不打开面板，显示 bounded local notice                 |
| 后台提取尚未提交  | 显示当前 snapshot；关闭后重新打开才能读取新提交的记忆 |
| TUI 正在退出      | 既有 coordinator disposal 负责关闭 store              |

所有失败都只影响本次本地浏览，不使 RuntimeSession fault，不修改 memory 数据，也不写
MemorySearch observation。

## 九、文档一致性

实现本功能时必须同步修订现有两份文档。

### 9.1 `high-level-decisions.md`

当前高层文档规定无参数 `/memory` 等价于 `/memory status`。实现前应改为：

- 无参数 `/memory` 打开当前已存原子记忆的只读浏览器；
- `/memory status` 仍是未来完整管理面的独立子命令；
- search、organize、delete、clear 的高层方向保持不变，但不属于本次范围。

### 9.2 `atomic-memory-mvp-design.md`

atomic MVP 文档当前明确排除了 `/memory`、用户可见列表，并在组件边界中写明 Memory 不进入
TUI slash command 和面板。

该文档记录的是 MVP 当时的真实范围，不能把历史改写成“原 MVP 已经包含浏览器”。应增加一段
明确的 follow-up 注释，并修订容易被理解为当前永久边界的语句：

- 原 atomic MVP 确实不包含任何用户可见管理面；
- MVP 完成后，新增了本文件定义的只读 `/memory` 浏览 follow-up；
- status、search、delete、clear、organize 和 CLI 仍不属于该 follow-up；
- `MemorySearch` 的模型工具合同、提取链路和 schema v1 均未因此改变。

不需要新增或预留任何数据库字段。

## 十、代码落点

```text
docs/global-memory/
  high-level-decisions.md
  atomic-memory-mvp-design.md
  tui-memory-browser-design.md

src/memory/
  contracts.ts
  memory-store.ts
  memory-coordinator.ts

src/cli/
  tui-runner.tsx

src/tui/
  slash-commands.ts
  app.tsx
  terminal-mouse.ts
  components/
    file-viewer.tsx
    memory-browser.tsx

src/__tests__/
  memory-store.test.ts
  memory-coordinator.test.ts
  slash-commands.test.ts
  terminal-mouse.test.tsx
  file-viewer.test.tsx
  memory-browser.test.tsx
  tui-components.test.tsx
  cli-pty.test.ts
```

不修改：

- `src/agent`；
- `src/context`；
- `src/session`；
- Recall；
- tool registry 或 observation；
- one-shot runner；
- memory schema。

## 十一、测试

### 11.1 Store

- 空库返回冻结空数组；
- 多 workspace 记录按 `created_at DESC, memory_id DESC` 排序；
- 同一 `created_at` 使用 `memory_id DESC` 稳定排序；
- 返回正文、workspace 和时间，不返回 embedding；
- 关闭 store 后调用失败；
- row 字段非法时整次失败；
- stored embedding BLOB 损坏时列表仍可读取，证明列表不选择或解码 embedding；
- `MemorySearch` 对损坏 BLOB 的原有失败合同保持不变。

### 11.2 Coordinator

- facade 返回 store snapshot；
- facade 不创建新 store 或新连接；
- dispose 后 facade 按 store closed 合同失败；
- 浏览不影响 active/pending worker 状态。

不增加“读取插入到 transaction 中间”的并发测试，因为同步单线程执行不存在该交错。

### 11.3 Slash command

- `/memory` 精确解析；
- trailing whitespace 合法；
- 任意参数返回 `Usage: /memory`；
- autocomplete 中包含 `/memory`；
- project slash command 不能覆盖内建 `/memory`。

### 11.4 MemoryBrowser

- 空库状态；
- metadata 和可完整浏览的正文安全显示投影；
- 长正文按 terminal columns 折行；
- tab 固定展开为 4 个空格；
- CRLF 和单独 CR 都形成一个 hard break；
- BEL、ESC、DEL 以及其他 C0/C1 控制字符显示为 `U+FFFD`，原始 memory text 保持不变；
- ZWJ emoji `👩‍💻`、肤色修饰符 `👍🏽`、regional indicator `🇨🇳` 和 combining mark
  都只在 grapheme cluster 边界测量和折行；
- grapheme 宽度之和与对应完整逻辑行的 `Bun.stringWidth()` 一致；
- 连续换行产生的空正文行保持可见；
- 改变终端列宽后重新折行，显示内容不丢失且 grapheme 不被拆分；
- 多次连续 resize 后仍能访问一条高于视口的完整 512-byte 记忆；
- 绝对 workspace 路径在窄终端使用 `truncate-middle`；
- 行滚动、PgUp/PgDn、Home/End；
- 鼠标滚轮；
- `topLine` 在 resize 后 clamp；
- Esc 关闭。

### 11.5 终端鼠标

- shared hook 在 TTY mount 时写入 mouse tracking 和 SGR enable sequence；
- cleanup 写入对应 disable sequence；
- 非 TTY stdout 不写控制序列；
- FileViewer 改用 shared hook 后原有滚轮行为不变；
- MemoryBrowser 打开时启用 mouse reporting，关闭时禁用；
- parser 单元测试之外，真实 PTY 必须观察 enable sequence 并验证滚轮输入会移动视口。

### 11.6 布局性能观察

本功能是低频手动操作，不设置跨机器毫秒硬 SLA，也不在普通单元测试中断言绝对耗时。
实现完成时用确定性的 1,000 条 mixed Chinese、English 和 emoji fixture 报告：

- 首次 `layoutMemoryLines()` 的 p50/p95；
- 改变 `contentWidth` 后重新布局的 p50/p95；
- 本次布局的 heap delta。

该结果用于判断是否已经出现需要缓存的真实证据，不作为当前实现预建缓存的理由，也不把
绝对毫秒阈值加入 `bun run check`。

### 11.7 App 非干扰

执行 `/memory` 后验证：

- `admitTurn` 调用次数为 0；
- prompt history 没有新增；
- projection 中没有新增 Turn；
- canonical history 没有新增；
- 没有 provider 或 embedding 请求；
- 没有 MemorySearch 诊断记录；
- 面板打开时 PromptInput 不接收按键；
- Esc 后 PromptInput 恢复；
- 未配置和初始化失败使用约定 notice；
- 首次读取失败不会留下半打开面板。

### 11.8 真实 PTY

1. 使用与当前配置 identity 一致的 store seed 多条跨 workspace 原子记忆；
2. 启动真实 TUI；
3. 输入 `/memory`；
4. 验证面板按时间倒序展示正文、时间和 workspace；
5. seed 包含 ZWJ emoji、肤色修饰符、tab、CR 和 ESC 的正文，确认 grapheme 不被拆分且
   控制字符只以安全显示投影出现；
6. 验证窄终端路径不会破坏布局；
7. 确认 TUI 输出 mouse tracking enable sequence，再发送真实 SGR wheel input 并验证视口
   移动；
8. 验证键盘滚动和 Esc，关闭后确认 mouse tracking disable sequence；
9. 面板关闭后形成一个新的 completed Turn，并等待 memory 写入；
10. 再次执行 `/memory`，确认新记忆出现；
11. 确认 `/memory` 本身没有形成 Turn 或 provider request；
12. 正常 `/quit`。

## 十二、实施顺序

1. 更新本文件涉及的两份既有文档契约；
2. 增加 `StoredMemorySummary` 和同步 store 读取；
3. 增加 store 单元测试；
4. 增加 coordinator facade；
5. 注册并解析 `/memory`；
6. 抽出共享 terminal mouse tracking hook，并让 FileViewer 改用它；
7. 实现控制字符安全投影、grapheme 测量和固定行缓冲 `MemoryBrowser`；
8. 完成 `App` 的本地分发、互斥状态和全屏渲染接线；
9. 补齐 component、mouse tracking 和非干扰测试；
10. 报告 1,000 条 fixture 的布局性能观察；
11. 完成真实 PTY journey；
12. 运行 `bun run check`。

## 十三、完成定义

以下条件全部满足才算完成：

- `/memory` 能查看当前全局 SQLite 中全部已存原子记忆；
- 数据只来自 `memory.sqlite`；
- 浏览使用已有 coordinator 持有的唯一 store；
- 不读取 embedding，不做数据库分页，不增加 schema；
- 面板使用固定行缓冲，长正文和窄路径不会破坏布局；
- 控制字符只在显示投影中安全归一化，不修改存储正文；
- 宽度只在 grapheme cluster 边界测量，不会拆分组合字符；
- 布局实现不预建 grapheme 测量缓存，resize 后仍保持正文完整和滚动边界正确；
- 真实 TTY 打开和关闭面板时正确启用、禁用 mouse tracking；
- 每次打开面板只读取一次固定 snapshot；
- `/memory` 不形成 Turn，不调用模型，不修改任何历史；
- memory 未配置、初始化失败和读取失败都有明确本地反馈；
- 两份既有全局记忆文档与新合同一致；
- 自动测试和真实 PTY journey 通过；
- `bun run check` 通过。
