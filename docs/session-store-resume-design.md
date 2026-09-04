# F4：SessionStore v1 与 `/resume` 技术方案

## 文档状态

- 日期：2026-07-12
- 状态：已实施（2026-07-12，与 F3 同批完成）
- 前置阶段：F1、F2、F3 已完成
- 后续阶段：F5 稳定来源与 `Recall`

## 实施结果（2026-07-12）

F4 已按本文完成，生产 `RuntimeSession` 只绑定每 session 一个
`SqliteSessionLedger`，SQLite 写失败时不会回退到内存或 JSONL。

主要落点：

- `src/session/session-schema.ts`：STRICT schema v1、application ID、user version、schema
  fingerprint、immutable/monotonic triggers 与 integrity check；
- `src/session/session-store.ts`：store-first new/resume、短 `BEGIN IMMEDIATE`
  transaction、持久化 counters、runtime contract、open turn/frame recovery、权限与 dispose；
- `src/session/session-lock.ts`：exclusive lease、active owner 检查、stale reclaim 和
  compare-before-release；
- `src/session/sqlite-session-ledger.ts`：把 F3 mutation 原样映射到 SQLite transaction；
- `src/session/session-catalog.ts`、`src/session/resume-projection.ts`：只读摘要、安全删除与
  有界 TUI hydration，不 replay event log；
- `src/tui/tui-session-controller.ts`、`src/tui/slash-commands.ts`：`/resume`、
  `/resume <session-id>`、`/session delete <session-id> --confirm` 与 target-first switch。

当前实现只在 active turn 生命周期内保留 transaction 成功后才更新的不可变 staging
core；turn terminal 后立即释放，空闲 session 不长期缓存完整 history。每次新 turn 从
`session.sqlite` 严格加载，数据库仍是唯一 durable source of truth；这不是 SQLite 与内存
双写，也没有 memory fallback。

验证覆盖 schema/fingerprint/permission corruption、canonical round-trip、持久化 counters、
runtime mismatch、open-frame deterministic recovery、catalog/projection/delete、真实子进程
lock conflict 与 `SIGKILL` stale reclaim。真实 PTY 还验证了 one-shot session 可由 TUI
列出、切换、恢复 timeline/context、继续下一 turn，再次正常退出。

## 一、结论先行

F4 的任务不是重新设计 message、tool result 或 protocol frame，而是把 F3 已经验证过的
内存领域契约原样映射到 SQLite，并让 `RuntimeSession` 可以从这份 canonical
history 恢复。

完成 F4 后：

1. `.tinker/sessions/<session-id>/session.sqlite` 是 session canonical history
   的唯一持久化 source of truth；
2. `events.jsonl` 和 `observations.md` 继续只用于诊断，绝不参与恢复；
3. 新 session 和恢复 session 使用同一套 `SessionLedger` API、相同写屏障和相同
   `ContextProtocolValidator`；
4. user、assistant、tool completion、frame closure 和身份计数器在各自 SQLite
   transaction 成功后才算落账；
5. 同一个 session 同时最多只有一个写者，第二个进程必须在连接 provider 或执行工具前
   因 lock conflict 失败；
6. 进程中断留下的 open frame 只按 F3 的确定性 interrupted helper 补齐，不重试工具；
7. `/resume` 恢复同一个 `sessionId`、相同未压缩 provider-neutral
   messages、连续的身份计数器和最近 TUI 投影；
8. F4 只建立一个表示完整未压缩历史的 initial revision，不创建第二个 revision，也不切换
   active view。

F4 的生产实现不保留 SQLite 与 `InMemorySessionLedger` 双写，也不在 SQLite
失败时退回内存继续运行。SQLite、schema、lock、workspace、runtime contract 或协议完整性
任一项不成立，session 都在模型请求和下一次工具副作用前 fast-fail。

## 二、前置契约与 F4 实施前缺口

本节中的“当前”均指 F4 实施前的 runtime 和 session 文件状态。

### 2.1 F3 已经冻结的领域语义

F4 必须直接继承 F3 的以下决定：

- `SessionLedger` 是 canonical message、protocol frame 和 tool result 的唯一 owner；
- message 与 tool result 只追加，frame 只允许一次 `open -> closed`；
- assistant tool calls 和对应 tool messages 组成不可拆分的
  `tool_exchange` frame；
- tool raw result、observation、tool message 和最后一次 frame closure 使用一个原子
  completion boundary；
- 每次 provider 请求前只从 closed frames 构建，并由
  `ContextProtocolValidator` 校验；
- user、assistant 和 tool completion 在各自写屏障处成为 canonical fact，turn terminal
  不回滚已经接受的事实；
- interrupted recovery 中只有 open frame 的第一个缺口可能已经执行，后续缺口客观上没有
  执行。

F4 只能替换这些操作的存储介质和 transaction 实现，不能重新解释状态机。若 F3 实际落地
后的类型或不变量与设计文档不同，应先回填并重新评审 F3，再更新本方案；不能在 F4 schema
中暗自形成第二套语义。

### 2.2 实施前 session 文件只是诊断面

F4 实施前，runner 已经把文件放在：

```text
.tinker/sessions/<session-id>/
  events.jsonl
  observations.md
```

但这两个文件不具备恢复数据库所需的保证：

- event schema 面向可观测性，可以随展示需求演进；
- required event sink 与 canonical ledger 无法共享一个 transaction；
- observation log 是人类可读投影，丢失了 frame、hash 和 raw result 的完整结构；
- 日志可能截断、重复或单独写失败；
- TUI projection 已经有界，不能依赖 replay 全部事件重建长期状态；
- 日志没有可验证的 schema version、workspace identity、single-writer ownership 或
  canonical content hash。

因此 F4 不解析旧 JSONL 来创建消息，不从 observation log 猜 tool result，也不为现有只有
日志、没有 `session.sqlite` 的目录提供兼容恢复。

### 2.3 实施前身份与计数器仍只存在于进程内

F4 实施前，`RuntimeSession` 在内存中维护：

- `nextTurnNumber`；
- 每个 turn 的 `nextIterationNumber`；
- 每个 iteration 的 `nextToolCallNumber`；
- session 级 `eventSequence`；
- 已知 turn、iteration 和 tool call 的身份映射。

当时进程退出后这些值全部丢失。F4 已将下一可分配 number 持久化，并在创建相应领域对象的
同一个 transaction 中推进它；UUIDv7 的低碰撞概率不承担顺序恢复职责。

### 2.4 实施前 TUI 绑定不能切换 session

F4 实施前，`runTui()` 在启动时一次性创建一个 `RuntimeSession`、一个
`TuiProjectionStore` 以及静态传给 `App` 的 `sessionId` 和
`run()` 回调。slash command 只有 `/status` 与 `/quit`。

F4 已增加 `TuiSessionController`，负责列出、打开、切换和删除 session。该 controller 只管理
runner/UI binding，不是新的 canonical state owner。

### 2.5 F4 对旧总方案的收束

早期无限上下文总方案把 Message ID、protocol frame、SessionStore 和 `/resume`
放在同一大阶段。实际实施将它们拆开：

- MessageId、FrameId、hash、origin、completion state machine 属于 F3；
- SQLite mapping、lock、crash recovery 和 `/resume` 属于 F4；
- Recall/FTS 属于 F5；
- active revision 编译和切换属于 I1 之后。

本方案以该阶段拆分和 F3 契约为准，不把旧总方案中后续阶段的表或抽象提前搬入 F4。

## 三、目标与非目标

### 3.1 目标

F4 完成后必须满足：

1. 每个新 session 都创建独立 schema v1 SQLite store；store 创建失败时
   `RuntimeSession` 不进入 ready。
2. F3 的 canonical messages、protocol frames 和 tool results 无损落入 SQLite，并能
   重建字节稳定的 `AgentMessage[]`。
3. session、turn、iteration、tool call、message、frame 和 initial revision 的身份关系
   可以从数据库完整验证。
4. turn、iteration、tool call 与 event 的下一序号在恢复后继续递增，不重复已对外产生的
   number。
5. 所有 ledger mutation 使用短 transaction；transaction 之外不保留“数据库已经写了一半”
   的正常状态。
6. 同一个 session 同时只有一个 active writer；锁冲突在初始化期间明确失败。
7. workspace、schema、权限、数据库结构、hash、frame 状态或 runtime contract 不兼容时
   fail-closed。
8. open tool frame 在 resume 时按 F3 helper 一次性补齐并关闭；任何 tool 都不会被自动
   重试。
9. open turn 即使没有 open frame，也会被标记为 interrupted，不自动继续旧 agent loop。
10. `/resume` 列出当前 workspace 最近 session，并允许在 TUI 空闲时恢复指定
    session。
11. 恢复后的 TUI 从 SessionStore 构建最近窗口，不 replay event log，也不一次加载完整
    timeline。
12. 提供更新时间、模型、turn 数、可恢复状态、数据库占用和显式删除入口。
13. one-shot CLI 产生的 session 同样持久化，之后可以从 TUI `/resume`。
14. session 目录和数据库只允许当前用户访问，并继续被 Git 忽略。
15. F2 的 token 计量、request preflight、prefix hash 和健康历史的 provider payload
    保持不变。

### 3.2 非目标

F4 不做：

- Recall、FTS、substring search、embedding 或跨 session 检索；
- tool observation 换出、placeholder、`/compact` 或自动 compaction；
- checkpoint、第二个 context revision 或 active revision 切换；
- session branching、merge、rename、云同步、共享或跨 workspace resume；
- 从 `events.jsonl`、`observations.md` 或 Bash log 重建 canonical
  history；
- 为旧 schema、旧日志目录或实验数据建立 migration/fallback；
- 恢复上次进程中的 Bash/MCP/Web 后台进程；
- 自动重试处于 unknown 状态的工具；
- 从中断位置继续同一个 agent loop；
- 在 runtime contract 变化时自动改写 system prompt 或创建
  `runtime_change` revision；
- 根据 Git remote、branch、inode 或目录内容猜测“可能是同一个 workspace”；
- session 自动过期、按大小清理或静默删除；
- one-shot 的 `--resume` CLI 参数；F4 的恢复入口先只在 TUI。

## 四、必须保持的不变量

```text
每个 session directory 恰好对应一个 sessionId
session.sqlite 是 canonical history 的唯一持久化 source of truth
events.jsonl / observations.md 永远不是恢复输入
生产 RuntimeSession 只绑定一个 SqliteSessionLedger
不进行 SQLite + memory 双写，不因 SQLite 失败回退到内存
同一 session 同时最多一个有效 SessionLease
workspaceRoot 使用 realpath 后逐字节匹配
schema version、application id 和 schema fingerprint 必须全部匹配
session_meta 恰好一行，sessionId 必须与目录名和所有记录一致
message ordinal 从 1 开始且严格连续
turnNumber 在 session 内从 1 开始且严格单调
iterationNumber 在 turn 内从 1 开始且严格单调
toolCallNumber 在 iteration 内从 1 开始且严格单调
eventSequence 在 session 内严格单调；失败或崩溃可以留下空洞，但不能复用
message/tool result 只追加且不可更新、不可删除
frame 只允许一次 open -> closed
turn/iteration 只允许一次 open -> terminal
tool result 与 tool message 在同一个 transaction 中提交
最后一个 tool completion 与 frame closure 在同一个 transaction 中提交
只有 closed frames 可以构建 provider request
ledger transaction 失败后不能执行下一个有副作用的 tool
resume 不发起 provider request，不自动执行或重试 tool
open frame recovery 只使用数据库记录和 F3 纯 helper
恢复成功前 RuntimeSession 不进入 ready
F4 恰好存在一个 initial_full revision，activeRevisionId 永不切换
当前 system prompt、model request config、tool schema 或 observation format 不兼容时拒绝恢复
background task 不跨进程恢复
显式删除不能删除 active/current session，也不能递归删除未知文件
```

## 五、目标架构与所有权

### 5.1 总体结构

```text
TUI / one-shot runner
  |
  +-- TuiSessionController              只负责 TUI 当前 binding
  |     |
  |     +-- SessionCatalog              只读列表与摘要
  |     +-- RuntimeSession              当前 active session
  |
  +-- RuntimeSession                    session 生命周期唯一 owner
        |
        +-- SessionLease                跨进程 single-writer ownership
        +-- SessionStore                连接、schema、transaction、计数器、查询
        |     |
        |     +-- SqliteSessionLedger   F3 SessionLedger 的 SQLite 实现
        |     +-- ResumeProjectionReader
        |
        +-- ContextBuilder              读取已验证的 provider-neutral view
        +-- Event Sinks                 诊断与展示，不拥有 canonical state
        +-- Tooling / MCP               只能在 store 基础校验后初始化
```

### 5.2 `RuntimeSession` 继续是唯一生命周期 owner

`RuntimeSession` 负责：

- 持有并释放 `SessionLease`；
- 持有并关闭 `SessionStore`；
- 选择 new/resume 打开模式；
- 串行分配 runtime identity；
- 组织 ledger transaction、event append、tool side-effect barrier；
- 在 resume 初始化期间执行 runtime contract 检查和 interrupted recovery；
- 决定何时进入 ready、faulted、disposing 和 disposed；
- 在 dispose 时先结束 active turn、再释放工具/MCP、写结束诊断、关闭数据库、最后释放
  lease。

runner、App、ContextBuilder、event sink 和 tool executor 都不能直接持有可写数据库连接。

### 5.3 `SessionStore` 是存储资源，不是领域总管

`SessionStore` 负责连接、schema、短 transaction、严格 row codec、counter、
turn/iteration terminal 和有界 projection query。它不负责调用 provider、执行工具、
生成 observation、决定 compaction、渲染 TUI、写 event log 或读取当前 workspace 文件。

### 5.4 `SqliteSessionLedger` 原样实现 F3 API

F4 的生产 ledger 实现 F3 已冻结的 `SessionLedger`、
`PendingLedgerTurn` 和 `AgentTurnLedger`。它复用 F3 的 staging、
canonical clone、hash、synthetic completion renderer 和 validator。区别只有 commit：

```text
F3 staged in-memory mutation
  -> F4 BEGIN IMMEDIATE
  -> INSERT / monotonic UPDATE
  -> database constraints
  -> COMMIT
  -> transaction 成功后才更新小型 runtime cache
```

`InMemorySessionLedger` 可以继续作为 F3 纯单元测试 fixture，但生产 factory
不得根据配置在两种 ledger 之间切换。

### 5.5 `SessionCatalog` 只读

`SessionCatalog` 扫描当前 workspace 的 session 目录，用只读连接读取 metadata。
它不能获取或回收 active lock、执行 recovery、修改时间、创建文件，或把无
`session.sqlite` 的旧日志目录视为可恢复 session。单个损坏目录只显示 unavailable，
不能让整个列表失败。

## 六、目录、身份与权限

### 6.1 目录布局

```text
<workspace>/.tinker/
  prompt-history.jsonl
  sessions/
    <session-id>/
      session.sqlite
      session.sqlite-wal
      session.sqlite-shm
      events.jsonl
      observations.md
      active.lock
      active.lock.reclaim
  bash/
    <task-id>.log
```

`session.sqlite-wal` 与 `session.sqlite-shm` 是 WAL 的组成部分。macOS
上的 Bun/SQLite 可能在连接关闭后保留 sidecar；正常关闭时不手工删除。数据库占用统计
相加主文件、WAL 和 SHM。

### 6.2 SessionId 的公共输入校验

来自 `/resume` 或删除命令的文本必须是 canonical 小写 UUIDv7，不能包含路径分隔、
点路径、空白或前后缀。parser 成功后才转 branded `SessionId`。构造路径后再次确认
parent realpath 是预期 session root，不把任意 branded string 当成安全文件名。

### 6.3 Workspace identity

创建前执行 `realpath(workspaceRoot)` 并保存。resume 时当前 realpath 必须逐字节
相同；不根据 Git remote、branch、内容或 inode 猜测。不提供 force。不同 symlink 文本若
指向同一 realpath 可以恢复；目录移动后直接拒绝。

### 6.4 权限

| 路径 | mode |
| --- | --- |
| `.tinker/sessions` | `0700` |
| session directory | `0700` |
| `session.sqlite` | `0600` |
| lock、event、observation 文件 | `0600` |

session directory 的 `0700` 是 WAL/SHM 创建瞬间的保护边界；sidecar 出现后校正为
`0600`。resume 使用 `lstat` 拒绝 symlink，并拒绝 group/other 权限过宽的
目录或数据库，给出明确修复提示。

## 七、Single-writer SessionLease

### 7.1 为什么 transaction 还不够

短 SQLite transaction 不能阻止两个完整 runtime 交替接受 prompt、初始化 MCP 或执行工具。
因此 lease 负责整个 runtime activation 的单写者所有权，SQLite 负责每次 mutation 原子性。

### 7.2 Lock record

```ts
type SessionLockRecordV1 = {
  version: 1;
  lockId: string;
  sessionId: SessionId;
  pid: number;
  hostname: string;
  processStartedAt: string;
  acquiredAt: string;
};
```

`lockId` 是本次 lease 的随机 token，只用于 compare-before-release。内容损坏、
session 不匹配或权限不合法时返回 `SESSION_LOCK_CORRUPT`；不能直接删除。

### 7.3 获取、回收与释放

获取使用 `open(path, "wx", 0o600)`。若已存在：

1. 严格读取 record；
2. foreign hostname 视为 active/unknown，不自动回收网络文件系统锁；
3. 本机用 `process.kill(pid, 0)` 检查；成功或 `EPERM` 视为活跃，
   `ESRCH` 才视为死亡；
4. owner 活跃则返回包含 pid/acquiredAt 的 `SESSION_LOCKED`；
5. owner 死亡则先 exclusive-create `active.lock.reclaim`；
6. 持有 reclaim marker 后重新读取并确认 lockId 未变、owner 仍死亡；
7. 只删除确认 stale 的 lock并立即重试 exclusive-create；
8. 无论成功失败都释放 reclaim marker。

listing 只报告 stale，不回收。释放 lease 时先关闭 SQLite，再重新读取 lock；只有 lockId
匹配才删除。不匹配时报告 cleanup failure，绝不删除别人的 lock。

所有可写 `SessionStore` constructor 都要求有效 `SessionLease`；生产代码
没有 `disableLock`。

## 八、SQLite 打开策略与 schema 身份

### 8.1 连接配置

生产使用：

```ts
new Database(databasePath, {
  create: false,
  readwrite: true,
  strict: true,
  safeIntegers: true,
});
```

新 session 先以 mode `0600` exclusive-create 空文件，再以
`create: false` 打开。catalog 使用 `readonly: true` 且禁止 create。

每个可写连接设置并验证：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 0;
PRAGMA trusted_schema = OFF;
PRAGMA wal_autocheckpoint = 1000;
```

`synchronous=FULL` 优先保证 agent canonical facts 的 durability；
`busy_timeout=0` 让意外第二写者立即暴露；`safeIntegers=true` 避免篡改的
大整数先被 JS 截断。decoder 检查 bigint 在安全正整数范围后再转换。

transaction callback 内只执行同步 SQLite 操作，不 `await`、不写 event、不执行
工具，也不调用外部可替换回调。

### 8.2 三层 schema 身份

schema v1 同时使用：

1. `PRAGMA application_id = 0x544b5231`；
2. `PRAGMA user_version = 1`；
3. 编译期 `SESSION_SCHEMA_V1_FINGERPRINT`。

fingerprint 从预期 `sqlite_schema` 中 table/index/trigger 的名字和规范化 SQL 计算。
resume 读取实际 schema 重算；不能只信 meta 自报 version。任一不匹配都 fast-fail，F4
没有 migration runner。

### 8.3 Resume 数据库校验

取得 lease 后、初始化 MCP 前依次执行：

1. 文件类型、owner 和 mode；
2. application ID、user version、schema fingerprint；
3. `PRAGMA quick_check`，必须恰好返回 `ok`；
4. `PRAGMA foreign_key_check`，必须为空；
5. meta 单行、session/workspace；
6. stored JSON 严格 decode；
7. ordinal、identity、frame、hash、tool result full validation；
8. initial revision invariant。

`quick_check` 不检查 foreign key，所以两项必须分开。catalog 不运行完整 scan；
真正 resume 必须运行。

## 九、Schema v1

### 9.1 表集合

```text
session_meta
turns
iterations
protocol_frames
messages
tool_results
context_revisions
```

不创建 events、message_fts、context_overrides、checkpoints、recall_sources 或 embeddings。
所有表使用 SQLite `STRICT`。时间由 runtime clock 生成 UTC ISO-8601，并由 TS
decoder 严格解析。

### 9.2 `session_meta`

```ts
type StoredSessionMetaV1 = {
  schemaVersion: 1;
  schemaFingerprint: string;
  initializationState: "creating" | "ready";
  sessionId: SessionId;
  workspaceRoot: string;
  modelName: string;
  systemPromptSha256: string;
  toolSchemaSha256: string | null;
  runtimeContractJson: string | null;
  runtimeContractSha256: string | null;
  activeRevisionId: ContextRevisionId;
  nextTurnNumber: number;
  nextEventSequence: number;
  openCount: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  lastClosedAt: string | null;
  lastCloseReason:
    | "oneshot_complete"
    | "tui_exit"
    | "session_switch"
    | "runner_failed"
    | "initialization_failed"
    | null;
};
```

`creating` 只用于新建短窗口；contract 字段只在 finalize transaction 中写一次。
ready 后 identity/workspace/model/system/contract 不可更新；next counters/openCount 只增不减；
activeRevisionId 在 F4 不变。正常 exit 只结束一次 runtime activation，不把 durable session
变成不可恢复的 completed。

进程在 creating 退出时，该目录不能 resume。初始化 rollback 只有在从未 ready、没有 turn、
且目录只含已知初始化文件时才可逐项删除；否则 catalog 显示 incomplete，等待显式删除。

### 9.3 Runtime contract

```ts
type RuntimeContractV1 = {
  version: 1;
  modelName: string;
  includeReasoningContent: boolean;
  contextProfile: ModelContextProfile;
  contextBudget: ModelContextBudget;
  systemPromptSha256: string;
  toolSchemaSha256: string;
  requestConfigSha256: string;
  observationFormat: "tool-observation-v1";
};
```

使用 `stableJsonStringify()` 和 SHA-256。resume 用当前 runtime 构造同一结构并比较，
错误只列变化字段，不打印 prompt/schema/API 正文。

model、reasoning 行为、profile/budget、system prompt、最终 tool/MCP schema、F2 request
config 或 observation format 任一变化都拒绝。`maxIterations` 是新 turn runtime
policy，不进入兼容 hash。Git branch、文件内容和 API key 也不属于 contract。

F4 不用 `runtime_change` revision 绕过 mismatch。

### 9.4 `turns` 与 `iterations`

```ts
type StoredTurnV1 = {
  sessionId: SessionId;
  turnId: TurnId;
  turnNumber: number;
  status: "open" | "completed" | "failed" | "cancelled" | "interrupted";
  nextIterationNumber: number;
  lastIterationId: IterationId | null;
  finalMessageId: MessageId | null;
  terminalDetailJson: string | null;
  startedAt: string;
  finishedAt: string | null;
};

type StoredIterationV1 = {
  sessionId: SessionId;
  turnId: TurnId;
  iterationId: IterationId;
  iterationNumber: number;
  outcome:
    | "open"
    | "continue"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  nextToolCallNumber: number;
  startedAt: string;
  finishedAt: string | null;
};
```

约束：

- turn number 在 session 内唯一，iteration number 在 turn 内唯一；
- turn row、closed user frame/message 和 next turn counter 同 transaction；
- iteration row 与 next iteration counter 同 transaction，且在 provider 前落账；
- assistant tool calls 入账时推进 next tool call counter；
- open 到 terminal 只允许一次，terminal 后不能继续追加；
- completed finalMessageId 指向该 turn 的最后合法 assistant text；
- terminal detail 有界、版本化，不复制 message 正文或 stack。

### 9.5 Frame、message 与 tool result 映射

三张表逐字段映射 F3 类型，不定义新 message 形状。

`protocol_frames` 保存 frame/session/turn/iteration ID、kind、state、first/last ordinal、
created/closed time。约束 system/user/assistant_text 创建即 closed；
tool_exchange open 时 last/closed 为 null；trigger 只允许 immutable 字段不变的一次
`open -> closed`，禁止删除。

`messages` 保存 F3 的 message/session/frame ID、ordinal、role、turn/iteration ID、
content/hash、reasoning、canonical `tool_calls_json`、provider/model、tool call
协议字段、origin 和 createdAt。ordinal 在 session 内唯一，role-specific 字段组合由 CHECK
限制，所有正文和关联禁止更新/删除。

assistant tool-call skeleton 的唯一 source of truth 是 `tool_calls_json`。F4 不额外
建立复制 args/provider ID 的 tool_calls 表；加载时由 F3 decoder/validator 校验其 ID、
number、name 和顺序。

`tool_results` 保存 toolCallId、frameId、toolMessageId、completion kind、canonical
raw JSON/hash、observation format、synthetic reason/detail、observation hash 和 createdAt。
returned 必须有 raw/hash/format 且无 synthetic；synthetic 必须有 F3 reason 且无 raw。
toolMessageId 唯一并指向同 frame/call 的 tool message。禁止更新/删除。

raw/tool-calls/terminal JSON 在 TS 层先 canonical clone、stable stringify、schema validation
和 hash；数据库 JSON validity 只是第二层防线。

### 9.6 Initial context revision

```ts
type StoredContextRevisionV1 = {
  revisionId: ContextRevisionId;
  sessionId: SessionId;
  revisionNumber: 1;
  kind: "initial_full";
  keepFromOrdinal: 1;
  createdAt: string;
};
```

bootstrap transaction 创建该 row 并设置 activeRevisionId。full validator 断言恰好一条、
number=1、kind=initial_full、keepFromOrdinal=1、active 指向它，且 build request 包含所有
closed canonical messages 和之后追加的 tail。

任何第二 revision 或 activeRevisionId 更新都不属于 F4。

### 9.7 Constraints 与领域 validator 分工

SQLite 表达局部 NOT NULL/CHECK/UNIQUE/FK、immutable trigger、单调 terminal/counter 和
JSON 基础合法性。F3/F4 full validator 表达 ordinal 无空洞、frame 范围、tool 配对、
hash 重算、system 唯一、open state 数量、next counter、initial revision 和 runtime
contract。数据库 constraint 不能替代每次 provider request 前的 protocol validator。

## 十、Transaction 与写屏障

### 10.1 通用 transaction 模式

```text
读取当前小型状态
  -> 在内存完成规范化、ID 分配、canonical clone、hash
  -> 构造完整 staged candidate
  -> 使用 F3 validator 校验 candidate
  -> BEGIN IMMEDIATE
  -> 重新断言数据库 counter/state 与 staged base 相同
  -> 执行全部 INSERT / 单调 UPDATE
  -> COMMIT
  -> transaction 成功后更新 runtime 小型 cache
  -> 才写完成类 event / 执行下一副作用
```

任何可能调用外部代码或抛出不受控异常的工作都在 transaction 前完成。transaction callback
只执行预编译 statement 和纯 decoder。

### 10.2 Begin turn

```text
candidate user protocol validation + F2 admission preflight
  -> stage TurnIdentity + closed user frame + user message
  -> transaction:
       assert session ready and next_turn_number
       insert turn(status=open, next_iteration_number=1)
       insert closed user frame
       insert user message
       increment session_meta.next_turn_number
       update session_meta.updated_at
  -> turn.started event
  -> runAgent
```

transaction 失败时不发 `turn.started`、不访问 provider、不执行工具、number 不前进，
RuntimeSession fault。

### 10.3 Begin iteration

```text
stage IterationIdentity
  -> transaction:
       assert turn open and expected next_iteration_number
       insert iteration(outcome=open, next_tool_call_number=1)
       increment turns.next_iteration_number
  -> agent.iteration.started event
  -> build request / provider
```

这样 provider 已收到请求但进程崩溃时，resume 能客观知道 iteration 曾开始，而不是从 event
log 猜测。

### 10.4 Assistant message

provider response 通过 adapter/F3 candidate validation 后：

```text
stage assistant + closed assistant_text frame
OR
stage assistant + open tool_exchange frame
  -> transaction:
       assert iteration open
       insert frame
       insert assistant message
       if tool calls:
         persist canonical tool_calls_json
         advance iterations.next_tool_call_number
  -> model/assistant completion events
  -> if tool calls: enter tool loop
```

assistant transaction 失败后不执行任何 tool。

### 10.5 Tool completion

```text
assertCanExecuteTool(call)
  -> tool.started event
  -> execute tool
  -> build observation
  -> stage ToolResultRecord + tool message
  -> transaction:
       assert frame open and expected next call
       insert tool result
       insert tool message
       if last call:
         update frame open -> closed
       update session_meta.updated_at
  -> raw/finished/observation events
  -> only now may execute next tool
```

工具可能已经产生副作用而 transaction 失败时，RuntimeSession fault，后续 tool 调用次数
必须为 0。event log 可以记录诊断，但不能替 store 伪造成功 completion。

### 10.6 Turn 与 iteration terminal

F4 保持 F3 的 terminal 顺序：

```text
canonical message/frame mutations already committed
  -> required turn terminal event
  -> transaction:
       transition current iteration open -> terminal outcome
       transition turn open -> completed/failed/cancelled
       store bounded terminal metadata
       update session_meta.updated_at
  -> PendingLedgerTurn.finish()
```

terminal event 失败时 messages 不回滚，turn 仍 open，RuntimeSession fault；下一次 resume
将其标为 interrupted。event 成功但 terminal transaction 失败时同样 fail-closed，不能以
event log 为依据补写 completed。

### 10.7 Event sequence

`eventSequence` 仍由 RuntimeSession 串行分配，但下一值保存在
`session_meta.nextEventSequence`。每次 append event 前先用一个短 store
transaction 取得并推进序号。

正常路径连续；store 成功而 event sink 失败时序号被消耗；进程在两者之间崩溃可以留下
sequence gap。gap 是诚实的写失败证据，不是 corruption。event log 永远不是 counter
恢复源。

第一版不做 range reservation。若 benchmark 证明每 event transaction 是热点，再单独设计
可持久化 range，不能牺牲不复用保证。

### 10.8 双存储失败顺序

| 时点 | SessionStore | event log | 处理 |
| --- | --- | --- | --- |
| canonical transaction 前失败 | 未改变 | 可能已有 started 诊断 | fault，不执行后续副作用 |
| canonical transaction 成功，完成 event 失败 | 事实已保存 | 缺失/截断 | fault，事实不回滚 |
| terminal event 成功，turn transaction 失败 | turn 仍 open | 看似 terminal | resume 标 interrupted |
| event log 损坏但 store 健康 | canonical 完整 | 不可信 | 允许 resume，不 replay |
| store 损坏但 event log 健康 | 不可信 | 只有诊断 | 拒绝 resume，不从日志修复 |

## 十一、新 Session 创建流程

### 11.1 打开模式

```ts
type RuntimeSessionSelection =
  | { mode: "new"; sessionId: SessionId }
  | { mode: "resume"; sessionId: SessionId };
```

不再用“目录存在就猜 resume、目录不存在就猜 new”。new 遇到同名目录直接失败；resume
遇到数据库不存在直接失败。

### 11.2 创建顺序

new session 严格按：

1. 读取并验证 runner config、model profile 和 canonical workspace realpath；
2. 生成并验证 SessionId；
3. 创建/检查 session root 与 session directory 权限；
4. 获取 `SessionLease`；
5. mode `0600` 创建数据库并打开 `bun:sqlite`；
6. 设置 PRAGMA、创建 schema、写 application ID/user version；
7. bootstrap transaction 写
   `session_meta(initializationState="creating")`、system frame/message、
   initial_full revision 和 counters；
8. 创建 required event sinks，写一次 `session.started`；
9. 初始化 local tooling 和 MCP；初始化事件使用持久化 event sequence；
10. 从最终 tool definitions 和 F2 prepared request 构造 runtime contract；
11. finalize transaction 写 contract 并执行 `creating -> ready`；
12. 对 initial full view 做 F3 full validation 和 F2 initial measurement；
13. 写 context usage event；
14. RuntimeSession 进入 ready。

数据库创建和 schema 校验发生在 MCP 连接、provider request 和工具执行之前。

### 11.3 初始化失败回滚

失败后反向 dispose MCP/tooling、best-effort 写诊断、关闭数据库、释放 lease。只有打开模式
是 new、从未 ready、没有 turn 且目录只含已知初始化文件时，才逐个 unlink 本次文件并移除
空目录。不使用递归强制删除；不确定项保留并报告。

## 十二、Resume 打开与恢复

### 12.1 Resume 总流程

```text
parse SessionId
  -> resolve expected directory
  -> acquire SessionLease
  -> open existing database without create
  -> permissions / schema / quick_check / foreign_key_check
  -> decode meta and assert workspace
  -> full canonical integrity validation
  -> initialize tooling + MCP
  -> build current RuntimeContractV1
  -> exact runtime contract comparison
  -> recover interrupted turn/frame if needed
  -> reload and full-validate closed canonical history
  -> restore identity counters
  -> build bounded TUI projection
  -> restore exact persisted measured anchor when the full request matches
  -> otherwise F2 measure current full request
  -> append session.resumed + context usage events
  -> RuntimeSession ready
```

任一步失败都关闭已创建资源并释放 lease；不会发 provider request，也不会执行 tool。

### 12.2 Runtime contract 检查先于 recovery mutation

open frame recovery 是 canonical mutation。为了避免最终无法由当前 runtime 打开的 session
在失败前被不必要改写，F4 先初始化当前 tools/MCP 并完成 compatibility 比较，再执行
recovery transaction。

此时 lease 已持有、store 已通过基础校验、RuntimeSession 尚未 ready，任何 provider/tool
调用都被禁止。MCP 初始化事件可以写诊断，但不能改变 canonical ledger。

### 12.3 可恢复状态分类

| 数据库状态 | 动作 |
| --- | --- |
| 无 open turn、无 open frame | 正常恢复 |
| 一个 open turn、无 open frame | 把 open iteration/turn 标为 interrupted |
| 一个 open turn、tail 是合法 open tool_exchange | F3 helper 补齐并关闭，再标 interrupted |
| open frame 但没有 open turn | corruption，拒绝 |
| 多个 open turn 或 open frame | corruption，拒绝 |
| open frame 不在 tail | corruption，拒绝 |
| ordinal/hash/tool pairing 损坏 | corruption，拒绝 |
| terminal turn 仍有 open iteration/frame | corruption，拒绝 |

F4 不尝试挑一条“看起来可用”的分支。

### 12.4 Open frame recovery transaction

若 assistant calls 是 A/B/C/D，已提交 tool(A)/tool(B)，F3 helper 生成：

```text
C -> interrupted_active
D -> skipped_after_interruption
```

F4 在一个 `BEGIN IMMEDIATE` 中重新断言 frame/tail/counter，插入 C/D 的
synthetic tool results 和 messages，分配连续 ordinal，关闭 frame，并把 open
iteration/turn 标为 interrupted。

transaction 前验证完整 candidate，transaction 后重新 load 并 full-validate。失败全部
rollback，frame 保持原 open 状态；下一次 resume 可重试，绝不留下半批 completion。

### 12.5 Open turn 但没有 open frame

可能是 user 已落账但 provider 未返回、iteration 已创建但 request 状态未知、closed tool
frame 后尚未开始下一 iteration，或 final assistant 已落账但 terminal 未完成。

F4 不重发 prompt/request，也不根据最后一条 assistant 猜 completed。它只把 open
iteration/turn 标为 interrupted；已有 closed frames 原样保留，下一 prompt 创建新 turn。

### 12.6 Counter 恢复

resume 读取持久化 next counters，再验证它们严格大于已用最大 number且正常历史无空洞。
`MAX+1` 只用于校验和错误报告，不自动修复被篡改的 counter。后续 allocation
transaction 再次比较数据库 expected value。

### 12.7 Context 恢复

```text
initial_full revision
  -> all canonical messages ordered by ordinal
  -> all frames closed
  -> ContextProtocolValidator
  -> stable AgentMessage materialization
  -> model.prepare()
  -> F2 measure / preflight
```

恢复本身不访问 provider。若一次巨大 tool observation 让已提交历史超出当前预算，session
仍可恢复到 TUI 并显示 blocked；任何新 user admission 在创建 turn 前由 F2 拒绝。F4
不删除 observation，也不偷偷 compact。

### 12.8 Resume event

```ts
type SessionResumedData = {
  openCount: number;
  recoveredTurnId?: TurnId;
  recoveredFrameId?: ProtocolFrameId;
  syntheticCompletionCount: number;
};
```

事件不复制 messages/raw/contract/snapshot。若 recovery transaction 成功而 event sink
失败，canonical recovery 不回滚，RuntimeSession fault；下一次 resume 会看到 closed
frame 和 interrupted turn。

## 十三、`/resume` 与 Session 运维交互

### 13.1 命令语法

```text
/resume
/resume <session-id>
/session delete <session-id> --confirm
```

- `/resume`：Catalog 可提供当前 workspace 全部有至少一个 turn 的 session；picker
  默认展示最近 20 个，搜索时在全部候选中按 `firstUserPromptPreview` 匹配并最多展示
  前 20 个结果（见 `docs/resume-session-search-design.md`）；
- `/resume <id>`：TUI 空闲时切换；
- `/session delete <id> --confirm`：删除非 current、非 active session。

parser 返回判别联合并验证精确 arity。不能继续“找到 command 名后忽略尾随参数”。未知
flag、多余参数或无效 ID 只显示 usage，不创建 AgentTurn。

### 13.2 SessionSummary

```ts
type SessionSummary = {
  sessionId: SessionId;
  modelName: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  firstUserPromptPreview?: string;
  status:
    | "current"
    | "resumable"
    | "interrupted"
    | "active"
    | "incomplete"
    | "unavailable";
  databaseBytes: number;
  statusDetail?: string;
};
```

preview 从第一条 user message 有界生成，不另存标题、不调用模型。列表优先展示时间、
preview、model、turn 数和状态，同时提供可复制完整 ID。databaseBytes 是主 DB、WAL、SHM
之和。

status 由 current binding、live lock、唯一 open state、initializationState 和只读打开结果
推导。列表不自动回收 stale lock；一个 unavailable 条目不阻断其他条目。

### 13.3 TUI session controller

```ts
type TuiSessionBinding = {
  sessionId: SessionId;
  modelName: string;
  workspaceRoot: string;
  projectionStore: TuiProjectionStore;
  executeTurn(
    userPrompt: string,
    signal: AbortSignal,
  ): Promise<RunAgentResult>;
};

type TuiSessionController = {
  getBinding(): TuiSessionBinding;
  subscribe(listener: () => void): () => void;
  listSessions(): Promise<readonly SessionSummary[]>;
  resume(sessionId: SessionId): Promise<void>;
  delete(sessionId: SessionId): Promise<void>;
};
```

controller 不暴露 SessionStore，也不允许 App 写 canonical records。

### 13.4 Session 切换

switch 只在当前 ready、无 active turn、无 running/stopping background task、target 非
current 且能取得 lease 时运行。

采用“先验证 target，后释放 current”：

1. target 取得 lease并完整打开到 prepared binding；
2. target 失败：清理 target，current 完全不变；
3. target 成功：以 `session_switch` dispose current；
4. current dispose 成功后原子替换 binding；
5. React 以新 sessionId 为 key 订阅新 projection；
6. current dispose 失败：关闭 target，runner failure 结束，不宣称切换成功。

准备期间可短暂持有两个不同 session 的 lease，但都不得执行 turn。存在后台任务时拒绝
switch，要求用户先 `TaskStop`。resume 后 `backgroundTasks=[]`；旧 Bash
log 保留，但不重建进程。

### 13.5 显式删除

删除要求完整 ID 和 `--confirm`；拒绝 current，获取 target lease，验证 session/
workspace 和目录只含已知文件。在唯一 lease 下 checkpoint/close SQLite，再把目录原子
rename 为带随机 token 的 tombstone，释放 lease，逐个 unlink 已知文件并移除空目录。

不使用递归 force delete。rename 是从 catalog 移除的提交点；物理清理失败时报告 tombstone
路径。F4 不自动删除空、旧、faulted 或超大小 session。

## 十四、TUI Projection 恢复

### 14.1 不 replay event log

恢复输入是 SessionStore 中最近 turn 的 canonical records 和 terminal metadata。event log
可能更丰富，但不是恢复源。

### 14.2 有界读取

`ResumeProjectionReader`：

1. 查询总 turn 数；
2. 只读取最后 `recentTurnLimit` 个 turn；
3. 读取相关 messages/tool results/terminal metadata；
4. 每 turn 最多生成 `itemLimitPerTurn` 个 item；
5. 计算 omitted turn/item；
6. 不加载 provider raw response；
7. background tasks 为空；
8. context usage 由恢复后的 F2 measurement 填入。

可确定性重建 user prompt、assistant text、tool call/result 摘要、synthetic completion、
terminal 状态和 duration。不承诺逐像素复现退出前 timeline；旧 spinner、MCP notice 和
cache 瞬时值留在诊断日志。

### 14.3 ProjectionStore 初始化

`TuiProjectionStore` 增加 validated initial snapshot/hydrate 入口，不伪造
AgentEvent replay。snapshot 必须匹配 session/model/workspace、没有 running item、
interrupted turn 是 terminal、遵守 policy，且不含 raw response、完整 ledger 或无界数组。
之后的新事件继续通过现有 reducer 增量更新。

## 十五、事件、日志与 Dispose

### 15.1 新事件

建议新增：

```text
session.resumed
session.interrupted_frame_recovered
session.store_faulted
```

只包含 stable ID、error code、operation 和数量，不复制正文/raw。
`session.store_faulted` 是 best-effort；store 已不能分配 sequence 时不能使用临时
序号硬写。

### 15.2 Started、resumed 与 finished

- `session.started` 只在 durable session 首次创建写一次；
- 每次成功恢复写 `session.resumed`；
- 每次 runtime activation dispose 可写 `session.finished`；
- finished reason 增加 `session_switch`；
- 正常 TUI exit 或 one-shot complete 后 session 仍 resumable；
- Observation log 在 resume 增加简短分隔块，不重复 session header。

### 15.3 Dispose 顺序

```text
mark disposing
  -> abort/await active turn
  -> dispose MCP
  -> dispose tooling/tasks
  -> append session.finished
  -> transaction update close metadata
  -> finalize statements
  -> close SQLite
  -> release SessionLease
  -> disposed
```

每步收集错误但继续后续释放。数据库 close 前不释放 lease；lease release 后禁止 event/store
write。

## 十六、错误类型与失败语义

### 16.1 稳定错误 code

| Code | 含义 |
| --- | --- |
| `SESSION_STORE_NOT_FOUND` | resume 目标无数据库 |
| `SESSION_ALREADY_EXISTS` | new 目录已存在 |
| `SESSION_ID_INVALID` | 公共输入不是合法 ID |
| `SESSION_PERMISSION_INVALID` | owner/mode/symlink 不安全 |
| `SESSION_LOCKED` | 活跃进程持有 lease |
| `SESSION_LOCK_CORRUPT` | lock 无法安全解释 |
| `SESSION_SCHEMA_UNSUPPORTED` | application ID/version 不支持 |
| `SESSION_SCHEMA_INVALID` | schema/fingerprint 不匹配 |
| `SESSION_INTEGRITY_FAILED` | SQLite/FK/record/hash 失败 |
| `SESSION_WORKSPACE_MISMATCH` | workspace realpath 不同 |
| `SESSION_RUNTIME_MISMATCH` | model/system/tool/request 不兼容 |
| `SESSION_PROTOCOL_INVALID` | F3 protocol 不合法 |
| `SESSION_WRITE_FAILED` | SQLite mutation 失败 |
| `SESSION_RECOVERY_FAILED` | recovery 无法原子完成 |
| `SESSION_DELETE_BLOCKED` | active/current/unknown files |

错误对象带 operation、sessionId、可选 frame/message/call ID 和 SQLite stable code；正文、
raw、API key、system prompt 不进入普通消息。

### 16.2 SQLite 分类

至少区分 busy/locked、readonly/cantopen、full/ioerr、corrupt/notadb、constraint 和 schema。
写错误一律 fault，不自动 retry 一个可能紧邻 tool side effect 的 transaction。

### 16.3 失败矩阵

| 失败点 | Canonical store | 外部动作 | 结果 |
| --- | --- | --- | --- |
| lease | 未打开 | 无 | current/target 不变 |
| schema/permission/workspace | 不修改 | 无 provider/tool | 拒绝 |
| runtime contract | 不修改 | 可能已连接 MCP | 清理并拒绝 |
| begin turn | 不变 | 无 | 不发 provider |
| begin iteration | user 已在 | 无 provider | fault |
| assistant commit | provider 已返回 | 无 tool | fault |
| tool completion | tool 可能有副作用 | 无下一个 tool | fault |
| terminal event | messages 已在、turn open | 无后续 tool | resume interrupted |
| terminal transaction | messages 已在、turn open | event 已写 | 不从 event 补写 |
| recovery transaction | open 原样 | 不执行 tool | 拒绝，可重试 |
| projection | store 已验证 | 无 provider/tool | 不 ready |
| switch current dispose | current 不确定 | target prepared | 关闭 target，runner failure |
| delete preflight | 不变 | 无 | 拒绝 |
| delete rename 后清理 | catalog 已移除 | 无 | 报告 tombstone |

## 十七、代码落点

### 17.1 新增

- `src/session/session-schema.ts`：DDL、version/fingerprint、row codec、integrity。
- `src/session/session-store.ts`：open、PRAGMA、transaction、counter、query、close。
- `src/session/sqlite-session-ledger.ts`：F3 ledger 的生产 SQLite 实现。
- `src/session/session-lock.ts`：lease、owner detection、stale reclaim、release。
- `src/session/session-catalog.ts`：read-only list/status/size/delete。
- `src/session/session-errors.ts`：stable error 与 SQLite mapping。
- `src/session/resume-projection.ts`：bounded projection，无 event replay。
- `src/tui/tui-session-controller.ts`：active binding 和 switch。

测试新增：

```text
src/__tests__/session-schema.test.ts
src/__tests__/session-store.test.ts
src/__tests__/session-lock.test.ts
src/__tests__/session-resume.test.ts
src/__tests__/resume-projection.test.ts
src/__tests__/tui-session-controller.test.ts
```

### 17.2 修改

- `src/ids/runtime-id.ts`：ContextRevisionId、factory、公共 SessionId parser。
- `src/agent/runtime-session.ts`：new/resume、store-first、counters、recovery、
  dispose/lease；删除生产内存 fallback。
- `src/agent/loop.ts`：iteration 在 provider 前持久化；不直接读 SQLite。
- `src/agent/context-builder.ts`：继续只读 protocol view，不导入 `bun:sqlite`。
- `src/cli/config.ts`：显式 session selection 与数据库/lock path。
- `src/cli/tui-runner.tsx`：controller、binding switch、Ink/stdin/dispose 顺序。
- `src/cli/run-runner.ts`：one-shot persistent store；test event disable 不关 store。
- `src/tui/app.tsx`：list/open/delete command UI；不创建 AgentTurn。
- `src/tui/slash-commands.ts`：严格参数 parser。
- projection store/event store：validated hydration 和 interrupted terminal。
- event types/log sinks：resume/recovery/store fault 与继续的 event sequence。

### 17.3 不应新增

- 巨型通用 SessionManager 或 generic ORM/repository；
- event-sourced recovery 或 JSONL dual-write；
- SQLite 失败后的 memory fallback；
- 未来 FTS/checkpoint 空表；
- 任意数据库 repair service；
- 绕过 lease/schema/contract 的 force flag；
- 让 ContextBuilder、App 或未来 Recall 拿可写 Database。

## 十八、分步实施顺序

### F4.1：Schema、连接与 Lease

实现 ID parser、schema/fingerprint/codec、连接 PRAGMA、lease 和 catalog 基础摘要。

门槛：schema 可关闭重开；version/permission/corruption 错误精确；两进程不能同时持锁；
kill owner 后两个 contender 中恰好一个回收成功；尚不接 RuntimeSession。

### F4.2：SqliteSessionLedger 与 counters

映射 F3 records，实现 begin turn/iteration、assistant/completion/terminal/event sequence、
initial_full materialization，并用 F3 golden 对比内存/SQLite。

门槛：logical records 和 provider payload 相同；失败注入无部分 row/counter；completion
失败后下一 tool 调用为 0。

### F4.3：RuntimeSession new/resume

production 切 store，完成 store-first init、runtime contract、open state recovery、counter/
context restore 和 dispose。

门槛：多 turn 可恢复；open frame 只生成 interrupted completion；mismatch 在 provider/tool
前失败；无 production memory fallback。

### F4.4：TUI resume、projection 与 delete

完成 slash parser、catalog、bounded projection、controller switch、显式 delete 和帮助。

门槛：target 失败 current 可继续；成功后 header/session/timeline/context 全部来自 target；
后台任务/active/delete 边界明确；不 replay JSONL。

### F4.5：故障注入、真实 PTY 与回填

完成 transaction/crash/lock/schema/permission suite、真实 PTY、多进程 lock 和 prepared
payload 对比，更新本设计实际差异和路线图状态。

整体任务可以连续执行，但 F3、F4 和上述子门禁不能揉成一个无法定位故障的大提交。

## 十九、测试计划

### 19.1 Schema 与 codec

- application ID/version/fingerprint；
- 缺 table/index/trigger/column；
- unsupported version 不 migration；
- strict table、malformed JSON、未知 enum、非法 timestamp；
- unsafe bigint 不截断；
- meta 行数/session ID；
- initial revision 数量/kind/ordinal。

### 19.2 Canonical round-trip

- system/user/assistant/tool exchange；
- null/空串/Unicode/换行/reasoning；
- single/multi-tool args、rawArgs、provider ID 顺序；
- 所有 returned raw kind；
- synthetic 无 raw；
- content/raw hash 重算；
- database 到 provider-neutral golden 字节一致。

### 19.3 Transaction 原子性

在 bootstrap、begin turn、begin iteration、assistant/frame、returned/synthetic completion、
frame closure、terminal 和 event counter 的 statement 前后注入异常。

断言无部分 rows、ordinal/number 无空洞（已分配失败的 event sequence 除外）、counter 只在
commit 后推进、runtime fault、provider/下一 tool 调用不增加。

### 19.4 Lock 多进程

- child 持锁时第二个立即 locked；
- 第二进程不能开 writable store；
- 正常退出删除 lock；
- SIGKILL 后 stale 可回收；
- 两 contender 恰好一个成功；
- 损坏 JSON/foreign host 不自动删除；
- EPERM 视为 alive；
- release token mismatch 不删除。

### 19.5 Resume 正常路径

固定 session 覆盖 text、single/multi-tool、cancelled、provider failure、raw ok=false 和
one-shot。每次重开断言 sessionId、counters、full validator、candidate/committed prepared
payload、prefix/request/tool hash、token estimate 和 append-only prefix。

### 19.6 Crash recovery

child process failpoint：

- user commit 后 provider 前；
- iteration 后 response 前；
- open frame 后第一 tool 前；
- 第一 completion 后第二 tool 中；
- side effect 后 completion 前；
- closed frame 后 next iteration 前；
- final assistant 后 terminal 前；
- terminal event 后 DB terminal 前；
- SQLite transaction 中间。

断言 transaction 无部分写、只首缺口 unknown、后续 skipped、resume tool executor 为 0、
turn interrupted、下一 request 协议合法、成功 recovery 只发生一次。

### 19.7 损坏与 mismatch

workspace、symlink、权限、model、system prompt、profile/budget、tool/MCP schema、
observation format、tool pairing、hash、ordinal、counter、多 open frame、active revision。
全部在 provider fetch/tool executor 调用为 0 时失败。

### 19.8 TUI 与命令

- list 不创建 turn且有界倒序；
- 旧 logs-only 不 resumable；
- unavailable 不阻断；
- ID/arity/flag usage；
- active turn/background task 拒绝 switch；
- target lock/mismatch 时 current 不变；
- switch 成功 dispose old；
- projection policy/omitted；
- 不恢复 background task；
- current/active/unknown-files 不能 delete；
- 无 confirm 不能 delete。

### 19.9 真实 PTY

完成两个 turns、退出、重新启动、list、resume、检查 timeline/header/status/context、继续
新 turn、再次恢复；另一终端同时 resume 必须 lock error；kill 后恢复 open frame，不得
重试工具。

### 19.10 资源与有界性

- catalog readonly connection 全关闭；
- 多次 switch 不泄漏 DB statement、MCP 或 lease；
- TUI 只持最近 policy 窗口；
- store 不长期缓存完整 `AgentMessage[]`；
- build request 临时 materialize 后释放；
- WAL 不被泄漏 reader 阻止 checkpoint；
- size 包含 sidecars。

### 19.11 完整门禁

```bash
bun test src/__tests__/session-schema.test.ts
bun test src/__tests__/session-store.test.ts
bun test src/__tests__/session-lock.test.ts
bun test src/__tests__/session-resume.test.ts
bun test src/__tests__/resume-projection.test.ts
bun test src/__tests__/tui-session-controller.test.ts
bun test src/__tests__/agent-loop.test.ts
bun test src/__tests__/runtime-session.test.ts
bun test src/__tests__/turn-cancellation.test.ts
bun test src/__tests__/context-measurement.test.ts
bun test src/__tests__/run-runner.test.ts
bun test src/__tests__/slash-commands.test.ts
bun run check
git diff --check
```

F4 不需要真实 provider smoke，除非 prepared payload、request config hash 或 tool schema
serialization 有意变化。恢复和 lock 需要真实进程/PTY，不能只靠 mock。

## 二十、验收标准

只有以下全部满足，F4 才完成：

1. production RuntimeSession 使用 SQLite ledger，无 memory/JSONL fallback 或双写。
2. schema v1、application ID、fingerprint、codec、permission、workspace 校验落地。
3. SessionLease 阻止双写者并通过多进程/stale recovery。
4. F3 语义无变化，SQLite round-trip 和 provider payload 字节稳定。
5. user、iteration、assistant、tool completion、terminal 都有 transaction barrier。
6. 任一 write 失败后下一 provider/tool side effect 为 0。
7. open frame recovery 原子、确定性、不重试 tool，turn 标 interrupted。
8. 多 turn 重启后下一未压缩 provider request 与退出前一致。
9. session/turn/iteration/tool call/event counters 不复用。
10. `/resume` list/open 可用，target 失败不破坏 current。
11. TUI 只读有界最近窗口，不 replay JSONL、不恢复后台进程。
12. runtime mismatch、schema 损坏、lock、权限、workspace 错误在 provider/tool 前失败。
13. size/status/time 和显式安全删除可用，无自动清理。
14. initial_full revision 恰好一个，无 active view 切换、Recall、FTS、compaction。
15. session 目录仅当前用户可访问且被 Git 忽略。
16. 真实 PTY、多进程 lock、crash injection、`bun run check` 和
    `git diff --check` 全通过。

## 二十一、给 F5 与 I1 的稳定接入契约

### 21.1 给 F5

F5 可新增只读 history reader、stable source 和 FTS，但必须复用既有 ID/正文/hash，不复制
canonical 正文；FTS 是可重建 index；Recall 无写权限；历史 observation 来自 store，当前
文件仍由 Read/Grep；不在 F4 预建空 FTS 表。

### 21.2 给 I1

I1 可扩展多 revision，但必须保留 initial 语义；新 revision 先完整写入校验再 transaction
切 active；canonical records 不改不删；ContextBuilder 不直接读写 SQLite；runtime contract
变化只有 revision 能表达后才允许。不支持的 schema 明确 fast-fail。

### 21.3 长期不变量

```text
SessionStore owns canonical durable history
Event logs remain diagnostic
One active writer per session
Tool completion remains atomic
Open frame recovery never retries tools
Original message/tool result remains immutable
Workspace and protocol integrity fail closed
```

## 二十二、最终设计决策

1. **F4 使用每 session 一个 `bun:sqlite` 数据库，event log 只做诊断。**
2. **生产 RuntimeSession 只使用 SQLite ledger，不双写、不 fallback。**
3. **F3 records/state machine 原样映射；F4 不重定义协议。**
4. **短 `BEGIN IMMEDIATE` 保证 mutation 原子性，SessionLease 保证跨进程单写者。**
5. **turn、iteration、tool call 和 event 的 next counter 都持久化。**
6. **event sequence 可因失败留空洞，但不从 JSONL 恢复或复用。**
7. **resume 在 full validation、runtime contract 和 recovery 完成后才 ready。**
8. **open frame 只做 synthetic completion；open turn 不继续旧 loop。**
9. **runtime contract 不兼容直接失败，不提前实现 runtime-change revision。**
10. **TUI projection 来自 canonical store 有界读取，不 replay event log。**
11. **`/resume` 可切换 session，但 active turn 或后台任务存在时拒绝。**
12. **删除必须取得 lease、验证目录并逐个删除已知文件，不递归 force delete。**
13. **F4 只建 initial_full revision；Recall、FTS、active-view 切换留后续。**

## 参考资料

- [Bun SQLite API](https://bun.sh/docs/runtime/sqlite)
- [SQLite PRAGMA reference](https://sqlite.org/pragma.html)
- [SQLite Write-Ahead Logging](https://sqlite.org/wal.html)
