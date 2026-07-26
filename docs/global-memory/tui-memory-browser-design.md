# 全局记忆：TUI 只读浏览器收窄设计

## 文档状态

- 日期：2026-07-26
- 状态：已实现并验证
- 文档性质：独立重写的收窄实施方案
- 上位文档：
  [`high-level-decisions.md`](high-level-decisions.md)
- 前置实现：
  [`atomic-memory-mvp-design.md`](atomic-memory-mvp-design.md)

本文定义 atomic memory MVP 完成后的一个窄 follow-up：为 TUI 增加无参数 `/memory`
命令，让用户直接浏览当前全局 SQLite 中已经存储的原子记忆。

本功能只有读取和展示，不扩展模型工具、自动提取、数据库 schema 或用户管理能力。

## 一、结论

新增无参数命令：

```text
/memory
```

命令打开一个全屏只读面板，按创建时间从新到旧展示全部已存原子记忆。每次打开只读取一次
数据库；面板显示的是该次读取形成的固定 snapshot。

该操作完全属于 TUI 本地行为：

- 不形成 agent Turn；
- 不调用模型或 embedding provider；
- 不调用 `MemorySearch`；
- 不写 prompt history；
- 不进入 canonical Session history；
- 不产生 memory search 诊断记录；
- 不自动把面板内容提供给模型。

数据只来自 `memory.sqlite`。`extracted-memories.log` 只是开发期观察日志，不能作为浏览器的
数据源。

## 二、范围

### 2.1 本次包含

- 无参数 `/memory` slash command；
- 全屏只读浏览面板；
- 按创建时间倒序读取全部原子记忆；
- 展示创建时间、来源 workspace 和完整记忆正文；
- Ink 原生折行和物理行滚动；
- 控制字符安全显示投影；
- 键盘逐行、翻页、首尾跳转和退出；
- 空库、未配置、初始化失败和读取失败的本地反馈；
- store 读取、coordinator facade、TUI component 和 App 接线；
- 一条覆盖真实公开路径的 PTY journey；
- 对现有全局记忆文档中现行合同的最小同步。

### 2.2 本次不包含

- `/memory` 的参数或子命令；
- `/memory search`、`status`、`delete`、`clear` 或 `organize`；
- `tinker memory ...` CLI；
- `tinker run` 的 memory surface；
- 搜索、筛选、排序选项或 workspace filter；
- 记忆选择、编辑、删除、确认或批量操作；
- 手动刷新、自动刷新、SQLite polling 或文件监听；
- 鼠标滚轮或 terminal mouse tracking；
- 独立的只读数据库连接；
- 数据库分页、cursor、懒加载或任意条数上限；
- 自定义文本折行、字符宽度算法或布局缓存；
- schema、table、index 或 migration 变更；
- worker 状态、诊断指标或内部 ID 展示；
- 通用 viewer framework 重构；
- 对现有 `MemorySearchMatch` 合同的重构。

## 三、命令合同

内建 slash command 声明为：

```ts
{
  name: "memory",
  usage: "/memory",
  description: "Browse stored global memories",
}
```

解析规则：

- `/memory` 返回 `{ type: "memory" }`；
- trailing whitespace 在 trim 后仍等价于 `/memory`；
- 后面出现任何参数都返回 `Usage: /memory`；
- autocomplete 始终显示该命令，即使当前进程没有启用 memory；
- project slash command 不能覆盖内建 `/memory`。

`App` 必须在本地 slash command 分支中截获该命令，不能进入
`submitAgentPrompt()`。

## 四、展示合同

### 4.1 全屏面板

面板替换正常的 Header、Timeline、Footer 和 PromptInput，并加入 `App` 现有全屏分支。
面板打开期间 PromptInput 必须卸载，避免多个 `useInput` 同时接收按键。

布局形状为：

```text
Global memory
↑/↓ or j/k · PgUp/PgDn · Home/End · Esc close

2026-07-26 14:32 · /Users/cyberoldman/htdocs/tinker
在 Tinker 仓库中，源代码变更完成前必须通过 bun run check。

2026-07-25 09:18 · /Users/cyberoldman/htdocs/other-project
另一条已经存储的原子记忆。

1–8 / 42 lines · 17 memories
```

每条记录展示：

- 转换为本地可读格式的创建时间；
- 来源 workspace 的完整绝对路径作为 metadata 内容；
- 记忆正文的安全显示投影。

workspace metadata 在窄终端中可以中间截断，以免撑破布局。数据库中的完整路径不被修改。

面板不展示：

- `memory_id`；
- `source_session_id`；
- `source_turn_id`；
- embedding；
- score。

`memory_id` 只用于数据库确定性排序和 React key，不作为用户可见身份。

### 4.2 文本安全边界

Memory Store 当前只约束正文非空和 byte limit；正文内部可能包含 tab、CR 或终端控制字符。
这些内容不能未经处理直接写入终端。

浏览器在展示边界进行以下投影：

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

规则固定为：

- CRLF 和单独 CR 都转成一个 `\n` hard break；
- tab 展开为 4 个空格；
- 除 `\n` 外的 C0、DEL 和 C1 控制字符显示为 `U+FFFD`；
- 连续换行形成的空正文行必须保留；
- 不修改数据库正文、hash、embedding、日志或 `MemorySearch` 返回值。

该函数只是显示投影，不是存储 migration。

### 4.3 折行与滚动

正文直接交给 Ink `Text`，由 Ink 根据当前父容器宽度完成折行和重新布局。浏览器不自行分词、
测量字符宽度或预先生成折行文本。

滚动以 Ink 布局后的物理行为单位。实现必须满足以下可观察合同：

- 所有记忆正文都可以完整浏览；
- `↑`、`k` 向上滚动一行；
- `↓`、`j` 向下滚动一行；
- `PgUp`、`PgDn` 按当前正文视口高度翻页；
- `Home` 跳到顶部；
- `End` 跳到最后一个完整视口；
- `Esc` 关闭面板；
- footer 显示当前物理行范围、总物理行数和 snapshot 中的记忆数量；
- terminal resize 后使用新的 Ink 布局结果，并把当前位置限制到新的合法范围；
- 一条高于整个视口的记忆在 resize 和滚动后仍然完整可达。

具体使用多少 React state、如何取得 Ink 布局高度、如何偏移内容以及记录间距的组件结构，
属于实现细节，不构成长期方案合同。

### 4.4 空库

数据库可用但没有记录时仍打开面板：

```text
Global memory
↑/↓ or j/k · PgUp/PgDn · Home/End · Esc close

No stored memories.

0 memories
```

## 五、Snapshot 生命周期

每次执行 `/memory` 时同步读取一次数据库，并把结果保存为该次面板的固定 snapshot。面板
打开后不再读取数据库，也不观察数据库文件变化。

completed Turn 的后台提取可能尚未提交，因此用户紧接着打开面板时不保证看到最新 Turn
产生的记忆。这不是读取失败。关闭面板后再次执行 `/memory`，才会形成新的 snapshot。

固定 snapshot 避免在浏览期间处理列表插入、排序变化、当前位置漂移或跨进程刷新。

## 六、数据读取

### 6.1 浏览投影

在 `src/memory/contracts.ts` 中新增独立类型：

```ts
export type StoredMemorySummary = {
  readonly memoryId: string;
  readonly text: string;
  readonly sourceWorkspace: string;
  readonly createdAt: string;
};
```

该类型是只读浏览所需的完整存储投影。它不继承 `MemorySearchMatch`，也不要求
`MemorySearchMatch` 改为交叉类型。浏览和搜索暂时独立声明字段，避免一个本地 UI follow-up
改变既有模型搜索合同。

返回值使用 TypeScript `readonly` 合同。本功能不额外要求或测试 runtime
`Object.freeze()`。

### 6.2 Store API

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

读取规则：

- 调用前执行现有 `requireOpen()`；
- 使用现有 SQL row helper 验证所有返回字段；
- `created_at` 使用现有 UTC timestamp validator；
- 不选择、读取或解码 `embedding`；
- 不执行第二次 `COUNT(*)`，总数使用结果数组长度；
- 任一 row 非法时整次读取失败，不返回部分 snapshot。

`created_at DESC` 使新批次优先。同一批 `insertBatch()` 共享创建时间，
`memory_id DESC` 只提供确定性的次级顺序，不承诺业务含义。

### 6.3 首版全量读取

首版一次读取并渲染全部记忆，不引入数据库分页或任意硬上限：

- 每条正文已有 512 UTF-8 bytes 上限；
- 浏览是用户主动触发的低频本地操作；
- 固定全量 snapshot 不需要 cursor、页缓存或可变高度条目的跨页状态；
- 当前没有实际数量和耗时证明需要更复杂的读取策略。

数据库读取成本和 Ink 布局成本不是同一件事。后续只有在真实数量和测量结果表明打开面板会
产生可感知停顿时，才重新设计分页或虚拟化；本次不预建这些能力。

## 七、所有权与并发

### 7.1 复用唯一 Store

现有 `MemoryCoordinator` 创建、独占并在退出时关闭 `MemoryStore`。浏览器复用这个 store，
不能另开“只读”连接。

`MemoryCoordinator` 增加窄 facade：

```ts
listStoredMemories(): readonly StoredMemorySummary[] {
  return this.store.listStoredMemories();
}
```

调用链固定为：

```text
App /memory
  -> injected listStoredMemories function
  -> MemoryCoordinator.listStoredMemories()
  -> MemoryStore.listStoredMemories()
  -> memory.sqlite
```

`App` 不持有 coordinator，不导入 `MemoryStore`，也不知道数据库路径。

### 7.2 同步读写

`bun:sqlite` API 是同步的。当前提取 worker 和 TUI 读取运行在同一个 JavaScript 线程，
因此 `listStoredMemories()` 只能发生在 `insertBatch()` transaction 之前或之后，不会在
一个同步 transaction 中间观察到部分批次。

本功能不增加 mutex、读取队列、retry 或并发协议。

### 7.3 退出

浏览器没有独立连接或异步读取任务。TUI 退出仍由既有 coordinator disposal 关闭 store，
不增加 cleanup 顺序。

## 八、Composition 与 App

### 8.1 Runner 注入

`runTui()` 只向 `App` 注入浏览所需能力：

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

不能把 coordinator、store 或 database 暴露给 TUI。

### 8.2 App 状态

新增 props：

```ts
type AppProps = {
  // existing props
  listStoredMemories?: () => readonly StoredMemorySummary[];
  memoryDisabledNotice?: string;
};
```

面板 snapshot 可以直接存入可选 state，不增加只包装一个字段的状态类型：

```ts
const [memoryView, setMemoryView] = useState<
  readonly StoredMemorySummary[] | undefined
>();
```

打开流程：

- `listStoredMemories` 存在且读取成功：保存 snapshot 并打开面板；
- 函数不存在且有 `memoryDisabledNotice`：再次显示这个既有 bounded notice；
- 函数不存在且没有初始化失败：显示
  `memory disabled: not configured`；
- 读取抛错：不打开面板，显示
  `memory unavailable: <bounded reason>`。

初始化失败的 notice 由 `initializeTuiMemory()` 生成。`/memory` 不重新解释同一个初始化错误，
也不绕过初始化结果直接读取数据库。

### 8.3 本地分发与面板互斥

`App` 完成以下接线：

1. 注册并解析 `{ type: "memory" }`；
2. 在本地 slash command 分支同步打开面板；
3. 打开其他本地面板或提交新输入时保持现有互斥关系；
4. 在 `fileView`、`resumePicker` 所在全屏分支中加入 `MemoryBrowser`；
5. 面板打开时卸载 PromptInput；
6. Esc 关闭后重新挂载 PromptInput。

`/memory` 的成功返回只表示本地命令已经处理，不得调用 session controller 的 Turn admission
路径。

## 九、失败语义

| 状态              | `/memory` 行为                                        |
| ----------------- | ----------------------------------------------------- |
| memory 未配置     | 不打开面板，显示 `memory disabled: not configured`    |
| memory 初始化失败 | 不打开面板，复用启动时的 bounded notice               |
| store 可用且为空  | 打开面板并显示 `No stored memories.`                  |
| 同步读取失败      | 不打开面板，显示 bounded local notice                 |
| 后台提取尚未提交  | 显示当前 snapshot；重新打开后才读取新的数据库状态     |
| TUI 正在退出      | 由既有 coordinator disposal 关闭 store                |

所有失败都只影响本次本地浏览：

- 不使 RuntimeSession fault；
- 不修改 memory 数据；
- 不产生 MemorySearch observation 或诊断记录；
- 不留下半打开的面板状态。

## 十、文档一致性

实现时只做两处最小同步。

### 10.1 `high-level-decisions.md`

把现行合同：

```text
/memory 无参数时等价于 /memory status
```

改为：

```text
/memory 无参数时打开当前已存原子记忆的只读浏览器
```

`/memory status`、search、organize、delete 和 clear 仍是未来完整管理面的方向，不属于本次
实现。

### 10.2 `atomic-memory-mvp-design.md`

atomic MVP 文档记录的是当时已经实现并验证的范围，其中“不包含 `/memory` 和用户可见列表”
仍然是历史事实，不应逐处改写。

只需在文档状态附近增加一段 dated follow-up 注释：

- atomic MVP 本身仍不包含用户管理面；
- 2026-07-26 之后新增了本文件定义的只读 `/memory` follow-up；
- 该 follow-up 不改变 `MemorySearch`、自动提取、schema v1 或 one-shot 边界。

## 十一、代码落点

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
  components/
    memory-browser.tsx

src/__tests__/
  memory-store.test.ts
  slash-commands.test.ts
  memory-browser.test.tsx
  tui-components.test.tsx
  cli-pty.test.ts
```

本功能不修改：

- `src/tui/components/file-viewer.tsx`；
- `src/agent`；
- `src/context`；
- `src/session`；
- Recall；
- tool registry 或 observation；
- one-shot runner；
- memory schema。

## 十二、验证

测试只覆盖跨边界行为和无法从直线代码结构直接得到的风险，不为简单 facade 或不存在的同步
交错构造额外测试。

### 12.1 Store

- 空库返回空数组；
- 多 workspace 记录按 `created_at DESC, memory_id DESC` 排序；
- 返回正文、workspace 和创建时间，不返回 embedding；
- 关闭 store 后调用失败；
- 非法 row 使整次读取失败；
- embedding BLOB 损坏时列表仍可读取，证明浏览路径不选择或解码 embedding。

### 12.2 Slash command

- `/memory` 精确解析；
- trailing whitespace 合法；
- 任意参数返回 `Usage: /memory`；
- autocomplete 包含 `/memory`；
- project command 不能覆盖内建 `/memory`。

### 12.3 MemoryBrowser

- 空库状态；
- metadata 和正文正确展示；
- tab、CRLF、CR、C0、DEL 和 C1 经过安全投影，原始对象不变；
- 连续换行保持可见；
- 中英文长正文由 Ink 折行并可完整滚动；
- workspace 在窄终端不破坏布局；
- `↑/↓`、`j/k`、PgUp/PgDn、Home/End 和 Esc；
- resize 后重新布局并 clamp；
- 高于视口的单条记忆在连续 resize 后仍完整可达。

### 12.4 App

- `/memory` 成功读取后打开全屏面板；
- 本地分发不调用 Turn admission；
- 面板打开时 PromptInput 不接收输入，Esc 后恢复；
- 未配置、初始化失败和读取失败显示约定 notice；
- 读取失败不留下半打开面板。

一个本地分发测试足以证明命令没有进入 agent Turn。无需分别重复断言 prompt history、
projection、canonical history、provider、embedding 和 MemorySearch diagnostic 的每个内部
结果。

### 12.5 真实 PTY

保留一条生产路径 journey：

1. 使用与当前 memory identity 一致的 store seed 多条跨 workspace 记忆；
2. 启动真实 TUI；
3. 输入 `/memory`；
4. 验证正文、时间和 workspace 按倒序显示；
5. 用键盘滚动到后续内容；
6. 按 Esc 关闭；
7. 输入普通 prompt，确认 PromptInput 和正常 Turn 路径恢复；
8. 正常 `/quit`。

控制字符全集、resize 边界和 snapshot 刷新由确定性的 component/App 测试覆盖，不塞入同一条
PTY journey。

源代码实现完成后运行唯一完整质量门：

```text
bun run check
```

## 十三、实施顺序

1. 最小同步两份既有设计文档；
2. 新增独立 `StoredMemorySummary`；
3. 实现 `MemoryStore.listStoredMemories()` 及 store 测试；
4. 增加 coordinator facade；
5. 注册并解析 `/memory`；
6. 实现安全显示投影和 `MemoryBrowser`；
7. 完成 runner 注入、App 本地分发和全屏互斥；
8. 补齐 component、App 和真实 PTY 验证；
9. 运行 `bun run check`。

## 十四、完成定义

以下条件全部满足才算完成：

- `/memory` 能浏览当前全局 SQLite 中全部已存原子记忆；
- 数据只来自 `memory.sqlite`；
- 浏览复用 coordinator 持有的唯一 store；
- 不读取 embedding，不增加 schema、分页或独立连接；
- 每次打开只读取一次固定 snapshot；
- 正文经过安全显示投影，数据库内容不变；
- Ink 原生折行，所有正文在键盘滚动和 resize 后完整可达；
- `/memory` 不形成 Turn，不调用模型，不修改任何历史；
- 面板打开时 PromptInput 卸载，Esc 后恢复；
- 未配置、初始化失败和读取失败都有明确本地反馈；
- 不修改 FileViewer，不引入 terminal mouse tracking；
- 既有全局记忆文档完成最小一致性同步；
- 自动测试、真实 PTY journey 和 `bun run check` 通过。
