# 全局记忆实施路线图：从显式控制到自动收敛

## 文档状态

- 日期：2026-07-25
- 状态：讨论中
- 上位决策：
  [`global-memory-high-level-decisions.md`](global-memory-high-level-decisions.md)
- 当前代码基线：commit `d145cf2`
- 文档性质：阶段实施路线图，不替代各阶段的完整技术设计

本文把已经确定的全局记忆方向拆成可以独立实现、验证和交付的阶段。它确定阶段顺序、
阶段边界、组件所有权和晋级门槛，但不在这里展开完整数据库 schema、JSON Schema、
搜索公式、processor prompt 或 TUI 逐键交互。

## 一、结论

全局记忆建议按以下七个阶段顺序实施：

```text
GM0  跨阶段合同冻结与 sqlite-vec 资格验证
  ↓
GM1  全局存储与确定性写入基础
  ↓
GM2  Embedding、sqlite-vec 与混合搜索
  ↓
GM3  显式记忆竖切：模型工具 + CLI/TUI 管理
  ↓
GM4  completed Turn 自动提取 worker
  ↓
GM5  手动整理与可演化记忆
  ↓
GM6  空闲自动整理与发布收口
```

各阶段的产品结果是：

| 阶段 | 阶段结束时得到的结果 | 是否新增公开能力 |
| --- | --- | --- |
| GM0 | 未决合同冻结，原生扩展和失败边界被真实验证 | 否 |
| GM1 | 安全、并发可用、支持 CAS 和 generation 的全局数据库 | 否 |
| GM2 | 关键词与向量混合搜索完整可用，首个公开 schema 冻结 | 否 |
| GM3 | TUI 模型可显式 CRUD；用户可搜索、查看状态、删除和清空 | 是 |
| GM4 | TUI completed Turn 可以 best-effort 自动形成记忆 | 是 |
| GM5 | 用户可以手动整理重复、替代、冲突和强化关系 | 是 |
| GM6 | TUI 空闲时可以按固定阈值自动整理，完成发布级验证 | 是 |

GM1 和 GM2 是隐藏的基础阶段，不注册 Memory 工具，不增加 `/memory`，也不增加
`tinker memory`。第一个公开版本从 GM3 开始，并且必须同时具备搜索、状态、删除和清空
能力。自动提取在 GM4 才启用，自动整理在 GM6 才启用。

这条顺序的关键约束是：

1. 在系统自动积累数据前，用户已经可以检查和移除数据。
2. 在系统自动改变已有记忆前，用户已经可以手动运行、观察和中断同一套整理引擎。
3. vector 路径没有通过 macOS、Linux 和安装包验证前，不把混合搜索暴露为产品能力。
4. 每个阶段只开放已经完整实现的入口，不提前注册返回占位错误的命令或工具。

## 二、当前代码基线与实施含义

当前仓库还没有全局记忆实现，现有边界对阶段拆分有直接影响。

### 2.1 已有基础

- `SessionStore` 已经提供严格 SQLite schema、短 transaction、完整性检查、私有文件权限和
  FTS5 实现经验。
- `RuntimeSession` 已经区分 completed、failed 和 cancelled Turn；completed Turn 的
  canonical 提交边界位于 `pendingLedgerTurn.finish(result)` 之后。
- `ToolRegistry`、`ToolRawResult` 和 `ObservationBuilder` 已经形成普通工具的注册、执行、
  raw result 与 observation 分层。
- TUI slash command 在 `App` 内作为本地操作处理；`/status`、`/skills`、`/mcp`、全屏
  picker 和 Esc cancellation 可以作为交互参考。
- `runTui()` 是跨 `/resume`、`/clear` 和 model switch 存活的进程级 composition root；
  单个 `RuntimeSession` 会在 session 切换时被替换。
- CLI 已有 Commander、公共 CLI contract、公共配置 contract、README 生成和发布包 smoke
  测试。
- CI 已经同时运行于 macOS 和 Linux。

### 2.2 当前缺口

- 没有独立的 `src/memory` 领域层，也没有用户级全局数据目录。
- 没有 embedding client、embedding 配置 contract 或 vector index。
- `package.json` 没有 `sqlite-vec` 依赖，也没有安装包内加载原生 extension 的验证。
- TUI 和 one-shot 当前共用同一套默认工具注册，尚无 entry capability manifest。
- CLI 只区分 TUI 与 `tinker run`；所有运行命令都会先进入当前 session/model 配置解析。
- SessionStore 没有按单个 completed Turn 输出“可供记忆提取的安全投影”的只读接口。
- 当前 TUI session controller 只管理 session 生命周期，不应顺便成为全局记忆 worker
  owner。

### 2.3 由此确定的所有权

全局记忆不能加入 workspace `SessionStore`，也不能让每个 `RuntimeSession` 各自打开和关闭
一套 worker。建议的所有权如下：

| 能力 | 所有者 | 生命周期 |
| --- | --- | --- |
| 全局数据库、FTS、vector index | `src/memory` | 用户级，跨 workspace |
| 记忆查询、mutation、status | `MemoryService` | 由 composition root 注入 |
| completed Turn 安全读取 | `src/session` 的只读 reader | 按 Session/Turn 引用读取 |
| Memory 模型工具 adapter | `src/tools` | 随当前 RuntimeSession tool surface |
| 提取与整理 worker | TUI `runTui()` 创建的进程级 memory runtime | 整个 TUI 进程最多一个 |
| `/memory` 本地操作 | 独立 `MemoryController` 注入 `App` | 不随 session 切换重建 |
| `tinker memory ...` | 独立 CLI runner | 单条命令生命周期 |
| one-shot Memory 能力 | command-scoped read service | 无 worker、无 mutation 工具 |

`RuntimeSession` 只负责在 completed Turn 已经 canonical commit 后提交一个轻量引用，以及把
当前入口允许的 Memory tool adapter 注册到 tool surface。它不负责调度、整理策略、全局
连接所有权或 TUI 面板状态。

## 三、跨阶段不变约束

以下约束从 GM1 开始持续成立，后续阶段不能重新解释。

### 3.1 数据边界

- 全局记忆数据库独立于所有 workspace `.tinker/sessions/.../session.sqlite`。
- 全局数据库不保存 Session 原文、system/developer prompt、assistant reasoning 或 tool raw
  JSON。
- 来源只保存诊断和幂等所需的 workspace、Session、Turn、ToolCall、时间与 hash 等身份。
- 删除 Session 不级联删除全局记忆。
- Recall 继续只读取当前 Session canonical history；Memory 不生成 `ctx://message/...`
  source，也不参与 context revision。

### 3.2 transaction 与并发

- 模型调用和 embedding 请求一律在 SQLite transaction 外完成。
- 记忆正文、关键词 FTS 和全部 cue vectors 在一个短 transaction 中原子提交。
- update、delete 和 organizer 提交使用 `expected_version` CAS。
- 所有异步任务携带 store generation；`clear` 后旧 generation 的结果不能提交。
- 多进程通过 WAL、5 秒 `busy_timeout`、短写 transaction 和 organizer lease 协作，不增加
  全局 daemon。
- 锁等待超时是本次 Memory 操作失败，不使主 RuntimeSession fault。

### 3.3 搜索

- `keywords` 只搜索记忆的 keywords，不搜索 content。
- `query` 只生成 query embedding，并与 semantic cue vectors 比较。
- 多条 cue 必须先按逻辑 Memory ID 折叠，再参与两路结果聚合。
- 所有 workspace 默认同权，不过滤也不提权当前 workspace。
- vector 不可用时必须明确标记降级；FTS 可以继续工作，但不得伪装为完整混合搜索。
- 搜索 observation 必须把结果标为派生、可能过期或错误的数据，并提醒模型用
  Read/Grep/Bash 验证当前 workspace 事实。

### 3.4 自动任务

- 只有 TUI completed Turn 可以进入自动提取。
- one-shot 不启动 worker，也不自动提取。
- 同一 TUI 进程中的提取、手动整理和自动整理最终共用一个 memory worker，memory model
  总并发始终为 1。
- worker 失败、队列丢弃和 vector 降级必须可见，但不能使主 Session fault。
- worker 不持有 RuntimeSession，也不因 `/resume`、`/clear` 或 model switch 被重建。
- 正常退出停止接收任务、取消当前 memory model 请求、丢弃队列，不等待 drain。

### 3.5 交付纪律

- 每个阶段有独立技术设计；本路线图不是直接编码依据。
- GM1 和 GM2 不增加隐藏的用户命令、实验性环境变量或未完成 tool schema。
- 从 GM3 起，每个公开字段都进入公共 contract、README 生成、CLI/TUI parser 和测试。
- 每个包含源码、依赖、脚本或运行配置的阶段都必须通过 `bun run check`。

## 四、GM0：跨阶段合同冻结与 sqlite-vec 资格验证

### 4.1 目标

在修改生产代码前，解决会影响数据库和所有后继阶段的未决问题，并用最小原型验证
`sqlite-vec` 在 Tinker 实际发布形态中可用。

### 4.2 GM0 必须冻结的跨阶段合同

#### 数据与状态

- 全局目录和数据库文件的最终路径。
- Memory ID、version、store generation 和 evidence ID 的格式。
- 逻辑记忆、版本、evidence、来源、unorganized、superseded 和 conflict 的状态机。
- organizer 是否保留完整旧版本、如何表示 supersede 关系和 unresolved conflict。
- exact normalized-content 幂等规则以及 reinforcement 的记录方式。
- 字段 UTF-8 byte 上限、keywords 数量、semantic cue 数量与单项长度上限。
- delete、clear 和重新形成同主题记忆的精确数据库语义。

#### 搜索

- keywords 规范化、FTS tokenizer、短关键词和特殊字符匹配规则。
- 每条 Memory 的 vector candidate 折叠规则。
- FTS 与 vector 的固定候选数、聚合公式、稳定 tie-breaker 和最终固定结果数。
- active、unorganized、superseded、conflict 各状态是否进入普通搜索。
- vector unavailable、embedding unavailable 和 partial result 的返回形状。
- `tinker memory search <query>` 如何从单个用户 query 驱动关键词和语义两条路径。

#### Embedding

- embedding endpoint、model、credential、dimension、metric 和 timeout 的配置形状。

#### 失败分类

- 显式错误的 embedding 配置何时属于启动失败。
- extension unavailable、vector query failure、store busy、CAS conflict、generation mismatch
  和 corruption 的稳定分类。
- 哪些错误只影响本次操作，哪些使整个 MemoryService unavailable；两者都不能被错误提升为
  RuntimeSession canonical fault。

GM0 只冻结会影响首个数据库 schema、混合搜索和跨阶段错误语义的内容，不要求在 GM1 前
完成所有 TUI 逐键交互或 processor prompt。

### 4.3 后续阶段设计检查点

以下合同在对应阶段开始前冻结，不阻塞 GM1：

| 阶段 | 开始实施前必须冻结 |
| --- | --- |
| GM3 | embedding 公共配置、五个工具完整 JSON Schema 与 observation、CLI TTY/non-TTY、`/memory` 面板交互、各命令的配置依赖 |
| GM4 | memory processing profile 公共配置与 snapshot、completed Turn allowlist 投影、Memory observation/reasoning/raw result 排除、secret detector、结构化候选协议 |
| GM5 | organizer batch 输入输出、lease 续期与丢失、action 幂等、手动 progress/cancel 和 batch failure 合同 |
| GM6 | idle 判定、新 Turn 抢占、手动/自动任务优先级和自动调度状态展示 |

其中 organizer 的持久化状态机和旧版本保留方式仍属于 GM0，因为它们会影响 GM1 schema；
自由文本 prompt、面板布局和调度细节留到使用它们的阶段。

### 4.4 原生扩展资格验证

使用一个不进入生产入口的最小脚本验证上位文档选定的精确 `sqlite-vec` 版本：

- Bun 在 macOS 和 Linux 加载 extension。
- 创建 `vec0`、插入、cosine KNN、更新、删除和重开数据库。
- 实际加载的 extension 与固定依赖版本一致。
- `npm pack` 后从干净全局安装前缀仍能加载 extension。
- extension 缺失、架构不匹配和 vector table 损坏时能够与普通 FTS 数据库打开失败区分。

### 4.5 交付物

- GM1/GM2 存储与搜索详细技术设计。
- 跨阶段数据状态机、失败分类和后续设计检查点。
- `sqlite-vec` 资格报告和已知平台边界。

### 4.6 晋级门槛

- 上位文档“待后续讨论”的三项内容全部有明确阶段归属，GM1/GM2 所需部分已经冻结。
- 不再存在会要求 GM3 后破坏首个公开数据库 schema 的已知未决项。
- macOS、Linux 和安装包原型都通过；失败路径能够保留 FTS 能力。
- 本阶段不注册任何生产 Memory 命令、工具或 worker。

## 五、GM1：全局存储与确定性写入基础

### 5.1 目标

建立不依赖模型、不依赖 vector extension、可以承受多进程并发的全局记忆 write plane。

### 5.2 实施范围

- 新增独立 `src/memory` 领域层，不复用 SessionStore 数据库或 schema version。
- 创建用户级 `0700` 根目录和 `0600` 数据库；校正 WAL/SHM 等 sidecar 权限。
- 使用独立 application ID、schema version、schema fingerprint 和初始化状态。
- 启用 foreign keys、WAL 和 5 秒 `busy_timeout`。
- 建立逻辑 Memory、版本/evidence、来源身份、幂等键、store generation、诊断摘要和
  organizer 状态所需的关系模型。
- 实现 create、get、update、delete、clear 和 status 的 repository/service 内部 API。
- create/update/delete 支持：
  - 完整字段原子提交；
  - `expected_version` CAS；
  - ToolCall 和 extraction candidate 幂等键；
  - exact normalized-content reinforcement；
  - generation mismatch 拒绝；
  - 短 transaction 和 bounded busy failure。
- 建立只索引 keywords 的 FTS5；content 不进入 FTS。
- mutation 网络前处理与数据库 commit 分层，保证后续 embedding 不会被放入 transaction。
- 建立 fault injection、integrity check 和最小 schema migration 框架；migration 使用
  `BEGIN IMMEDIATE` 串行化，第一版不迁移任何不存在的旧全局数据。

GM1 的生产 composition root 不打开该数据库。数据库只由单元/集成测试和开发验证入口创建，
因此本阶段尚未形成用户数据兼容承诺。

### 5.3 明确不做

- 不增加 embedding client、`sqlite-vec` 或 vector table。
- 不实现最终 `MemorySearch` 聚合。
- 不注册模型工具、CLI 子命令或 TUI slash command。
- 不读取 Session 或启动 worker。
- 不调用 processing model 或 organizer。

### 5.4 重点验证

- 两个和多个进程并发 create/update/delete 时没有 lost update。
- stale version、stale generation 和重复 ToolCall 都得到确定结果。
- clear 与正在数据库外准备的写入并发时，旧结果不能回写。
- transaction 任一点失败后，正文、FTS、version 和 evidence 不出现半提交。
- 数据目录、数据库及 sidecar 权限满足合同，symlink 和过宽权限按设计处理。
- 删除 Session 测试 fixture 不影响全局 Memory。

### 5.5 晋级门槛

- store fault 不传播为 RuntimeSession fault 的错误分类已经稳定。
- 并发、CAS、generation、幂等、权限和 transaction fault matrix 全部通过。
- repository API 不泄露 SessionStore、TUI 或 provider 类型。
- `bun run check` 通过。

## 六、GM2：Embedding、sqlite-vec 与混合搜索

### 6.1 目标

在 GM1 write plane 上完成可发布的 read plane，并冻结第一个对用户数据负责的全局数据库
schema。

### 6.2 实施范围

- 以精确版本加入 `sqlite-vec` 依赖和加载器，不使用运行时下载。
- 把 `src/memory` 和 extension 所需运行文件纳入 npm package files，并让 release verifier
  检查实际安装位置，而不是只在源码 checkout 中验证。
- 增加独立 embedding client；不把 embedding 塞入工作模型 `ModelClient` 接口。
- 按 GM0 冻结的 embedding model、dimension 和 metric 创建单一 vector index。
- 为每条 semantic cue 单独生成和保存 vector，并持久化对应 cue 文本。
- create/update 的执行顺序固定为：
  1. 在 transaction 外验证文本、生成所需 embeddings；
  2. 打开短 transaction；
  3. 重新检查 generation、version 和幂等；
  4. 原子提交逻辑记录、FTS 和全部 vectors。
- 实现 `MemorySearch` 两条独立候选路径：
  - keywords 只查询 keywords FTS；
  - query 只生成 query embedding 并执行精确 cosine KNN。
- vector hits 先按 Memory ID 折叠，再按 GM0 冻结算法与 FTS hits 聚合。
- 搜索固定有界，不向工具调用方开放分页或 limit。
- 普通搜索默认不按 workspace 过滤或提权。
- extension 加载或 vector query 失败时：
  - 保留 FTS 查询；
  - 返回明确 degraded 状态和原因；
  - status 显示 vector unavailable。
- 在本阶段结束时冻结并记录 global memory schema v1。

### 6.3 明确不做

- 不注册 Memory 模型工具。
- 不增加 `tinker memory` 或 `/memory`。
- 不读取 Session，不自动提取，不整理记忆。
- 不增加 ANN、reranker、workspace boost 或 content search。

### 6.4 重点验证

- 同一 Memory 的多 cue 命中只返回一条逻辑结果。
- keywords 命中、vector 命中、双路命中和稳定 tie-breaker 都符合冻结算法。
- vector unavailable 时结果明确标记为 FTS-only，且不会返回伪造 semantic score。
- 多进程搜索与写入并发时，查询只看到提交前或提交后的完整版本。
- macOS、Linux CI 真实执行 load/insert/query/update/delete/reopen。
- `release:verify` 从实际 npm tarball 的干净安装前缀验证 extension。
- 使用固定规模 fixture 记录写入、FTS、KNN、混合搜索时间和 RSS 基线；具体门槛
  在 GM0 详细设计中冻结。

### 6.5 晋级门槛

- 两个平台和发布包都通过真实 extension 验证。
- schema v1 和 embedding 配置合同冻结。
- vector 降级不影响 FTS，也不阻止主 Tinker session。
- benchmark 与 fault matrix 达到 GM0 门槛。
- `bun run check` 通过。

## 七、GM3：显式记忆竖切

### 7.1 目标

一次性交付可由用户控制的完整显式记忆能力。用户可以先要求 TUI 模型创建记忆，再通过模型、
CLI 或本地 TUI 搜索和管理；本阶段没有自动提取或自动整理。

### 7.2 Composition root 与工具面

- TUI composition root 打开一份共享 `MemoryService`，并把同一实例注入后续所有
  RuntimeSession 和本地 `MemoryController`。
- session switch 只替换 RuntimeSession，不关闭全局 MemoryService。
- one-shot 打开 command-scoped MemoryService，只注册：
  - `MemorySearch`
  - `MemoryGet`
- TUI RuntimeSession 注册：
  - `MemorySearch`
  - `MemoryGet`
  - `MemoryCreate`
  - `MemoryUpdate`
  - `MemoryDelete`
- 工具注册使用显式 entry capability，不在 executor 内用 `if (oneShot)` 拒绝 mutation。
- tool definitions 由入口能力和已验证配置决定，不因一次 transient provider/vector/store
  故障在 session 中途增删；运行故障通过 raw result、observation 和 status 暴露。
- one-shot 创建的 Session 以后由 TUI resume 时，通过现有 context surface refresh 获得完整
  TUI tool surface。
- system instructions 按实际 tool capability 生成，不向 one-shot 宣传不存在的 mutation
  工具。

### 7.3 模型工具

- 五个工具使用上位文档已冻结的顶层参数。
- Search observation 只返回有界候选、Memory ID、版本、来源诊断、匹配信息和警告；完整
  content 只由 `MemoryGet` 返回。
- Create/Update 在 transaction 外生成 cue embeddings，再原子提交完整三部分。
- Update/Delete 强制 `expected_version`，CAS conflict 返回可操作的普通 observation。
- mutation 使用 ToolCall identity 幂等；同一次工具调用重放不能重复产生副作用。
- mutation transaction 提交前取消不产生变化，提交后取消保留变化。
- 成功 mutation 立即持久化，不等待当前 Turn completed，也不因 Turn 后续失败或取消回滚。
- 每次 mutation 保存 Session、Turn、ToolCall 和 workspace 来源身份。
- Memory tool failure 是普通 tool failure；存储或 vector 降级不能变成
  `ToolExecutionFatalError` 使 Session fault。
- ObservationBuilder 明确标注 Memory 数据是派生、非指令、可能过期，并提醒核对当前
  workspace。

### 7.4 CLI 管理入口

本阶段增加：

```text
tinker memory search <query>
tinker memory delete <id>
tinker memory clear
tinker memory status
```

`tinker memory organize` 到 GM5 才注册，不提前显示占位实现。

- memory 命令走独立 runner，不创建 Session、RuntimeSession、MCP、Skills 或 workspace
  event log。
- `status`、`delete` 和 `clear` 不应被无关的工作模型配置阻塞。
- `search` 解析所需 embedding 配置；vector 不可用时按合同明确执行 FTS-only。
- interactive TTY 中 delete/clear 请求确认。
- 非交互 delete/clear 必须显式 `--confirm`，否则以 usage failure 结束。
- CLI contract、help、exit code、README 生成和发布 smoke 同步更新。

### 7.5 TUI 本地入口

本阶段增加：

```text
/memory
/memory status
/memory search <query>
/memory delete <id>
/memory clear
```

`/memory` 无参数等价于 `/memory status`。`/memory organize` 到 GM5 才加入命令列表。

- 所有命令是纯本地操作，不创建 agent Turn，不写 prompt history，不进入 canonical
  Session history。
- search 使用可滚动全屏结果面板。
- status 使用全局状态面板；因为本阶段尚无 worker，明确显示 `worker=not_started`，而不是
  伪造运行计数。
- delete 先读取并显示目标记录，再进入确认面板；提交仍使用读取到的 expected version。
- clear 必须确认，并展示推进后的 store generation。
- 面板内容不自动进入模型 context。

### 7.6 明确不做

- 不从 completed Turn 自动提取。
- 不启动 memory worker。
- 不提供 organize 命令或 organizer 状态变更。
- 不自动向 prompt 注入搜索结果。

### 7.7 重点验证

- TUI 与 one-shot 的 tool definitions 精确符合能力矩阵，one-shot schema 中完全不存在三个
  mutation 工具。
- tool surface 变化在新建、resume 和 one-shot-to-TUI resume 后保持 context surface 合法。
- ToolCall 重放、CAS conflict、取消前后边界和 generation mismatch 不产生重复副作用。
- CLI TTY/non-TTY 确认和 exit code 通过测试。
- `/memory` 命令不增加 turn、prompt history、canonical message 或模型请求。
- 两个 workspace 创建的记忆能被同权搜索。
- vector degraded、store busy 和记录冲突在工具、CLI、TUI 三个入口都明确可见。
- 真实 PTY 验证 search 滚动、delete/clear 确认和取消。
- `bun run check` 与安装包 smoke 通过。

### 7.8 晋级门槛

- 用户已经能够搜索、检查、删除和清空记忆。
- 模型显式 CRUD 在失败、取消和 resume 后语义稳定。
- 没有入口会在后台自动保存 Turn 内容。
- 公开配置、命令、slash command 和 README 指向同一份代码 contract。

## 八、GM4：completed Turn 自动提取 worker

### 8.1 目标

在 GM3 已经提供完整用户控制面的基础上，为交互式 TUI 增加 best-effort completed Turn
提取；提取只创建或强化候选记忆，不做语义合并、替代或冲突判断。

### 8.2 completed Turn 提交边界

- 在 `RuntimeSession` 中增加只接受引用的 completed Turn sink。
- 只有 `pendingLedgerTurn.finish(result)` 已成功且 `result.status === "completed"` 时才入队。
- 入队发生在 skill settlement、automatic context maintenance 和 TUI completion callback
  之外，不依赖 presentation event 是否仍在屏幕中。
- sink 的 `enqueue()` 是同步、有界、非抛出接口；队列或 worker 故障不能改变
  `executeTurn()` 结果。
- failed、cancelled、interrupted 和尚未 canonical commit 的 Turn 不入队。

### 8.3 worker 所有权与队列

- `runTui()` 创建整个进程唯一的 `MemoryWorker`。
- 所有新建或 resumed RuntimeSession 共享同一个 completed Turn sink。
- 队列容量固定为 64，模型请求并发度固定为 1。
- 队列满时丢弃最老的未开始提取任务，保留较新任务并增加 dropped 计数。
- 队列项保存：
  - workspace、Session 和 Turn 引用；
  - 入队时的 store generation；
  - 入队时解析出的 processor profile snapshot/identity；
  - 调度和诊断元数据。
- 队列项不保存 Turn 原文、tool raw result 或提取 prompt。
- `/resume`、`/clear` 和 model switch 不重建 worker；旧 Session 引用仍可读取时继续处理。
- Session 已删除或 source 不再可读时记录 skipped/failed，继续后续任务。
- TUI 退出时先停止接收任务，再取消当前 memory model 请求并清空剩余队列，不等待 drain。

### 8.4 completed Turn 安全投影

新增只读 completed Turn reader，由 Session 层负责验证：

- Session、Turn 身份存在且状态确实为 completed。
- 只返回 GM0 合同允许的 user、assistant 和必要 tool observation。
- 不返回 system/developer prompt、assistant reasoning、tool raw JSON 或 provider raw response。
- 不返回 MemorySearch/Get/Create/Update/Delete observation，阻断记忆自我复制。
- 图片只提供允许的文本标签/诊断，不读取或复制原始图片 bytes。
- 返回内容有严格总 byte 上限和确定性截断/拒绝语义。

Memory worker 只消费这个 reader，不直接查询 SessionStore 内部表，也不使用 Recall tool。

### 8.5 提取管线

单个任务按以下顺序执行：

```text
读取并验证 completed Turn 安全投影
  -> 使用选定 memory processing profile 请求结构化候选
  -> 严格解析 keywords / semantic_cues / content
  -> 执行字段限制、主题拆分和确定性 secret 检测
  -> 在 transaction 外生成 cue embeddings
  -> 使用 source + candidate hash + generation 幂等提交
  -> 更新 worker/status 诊断
```

- processor 可以返回零条候选。
- 任一候选命中 secret detector 时拒绝整条候选，不保存局部内容。
- 非法 processor 输出、provider failure、embedding failure 或 DB busy 都只使本任务失败。
- 不在 worker 层增加超出模型客户端已有行为的重试循环。
- 完全相同内容走 reinforcement；近似重复仍可创建为 unorganized。
- 网页或工具 observation 中的行为性指令，只有安全投影中存在用户明确认可证据时才允许形成
  行为记忆。

### 8.6 状态与可见性

GM3 的 status 面板和命令扩展为真实显示：

- 当前 TUI 进程 worker queued、running、succeeded、failed、dropped；
- 最近一次提取时间、来源和 bounded error summary；
- 全局 active、unorganized、superseded、conflict；
- FTS、vector 和 embedding 状态。

standalone `tinker memory status` 没有当前 TUI 的内存计数，因此明确显示 worker 不属于本
进程，同时仍展示持久化的最近提取诊断和全局计数。

### 8.7 明确不做

- one-shot 自动提取。
- 持久化提取任务、退出 drain 或全局 daemon。
- vector 相似度写入时去重。
- 自动 supersede、conflict 或语义合并。
- 自动 organizer 阈值。

### 8.8 重点验证

- completed、failed、cancelled、interrupted 四种 Turn 只有 completed 入队。
- 入队点发生在 canonical commit 后；reader 永远不读取 open Turn。
- 65 个阻塞任务触发 drop-oldest，计数与保留顺序准确。
- RuntimeSession 切换后只有一个 worker，旧 worker 不泄漏，MemoryService 不被提前关闭。
- 退出取消当前请求且不 drain；已经 commit 的结果保留。
- clear 与 in-flight extraction 并发时，旧 generation 结果不能回写。
- Memory observation、reasoning、system prompt、raw tool result 和 secrets 都不会进入数据库。
- 处理 profile 的供应商选择与入队时 snapshot 一致，并有明确隐私提示。
- fake processor 覆盖零候选、非法 JSON、多候选、secret、provider/embedding/DB failure。
- 至少一个真实 processing profile + embedding provider smoke 验证完整提取链。
- `bun run check` 通过。

### 8.9 晋级门槛

- 自动提取不会延迟 Turn 最终响应，也不会 fault 主 Session。
- worker 在 session switch、clear、退出和多进程场景下没有生命周期泄漏。
- 安全投影和 secret gate 有可重复的负向证据。
- 用户能通过 GM3 入口观察、删除或清空自动形成的记忆。

## 九、GM5：手动整理与可演化记忆

### 9.1 目标

实现可重复、可中断、并发安全的 organizer，并先只通过用户显式命令运行。该阶段让重复、
替代、冲突和强化从高层概念变成稳定的存储状态与搜索行为。

### 9.2 整理引擎

- organizer 只读取全局数据库中的派生记忆、版本、evidence 和来源元数据。
- 不打开原 Session，不读取 Session 原文，也不调用 Recall。
- TUI 手动 organize 作为高优先级任务提交到 GM4 的同一进程级 worker；不创建第二个
  organizer worker，也不与 extraction 并发调用 memory model。
- 每个 batch 在 transaction 外请求 memory processing model。
- processor 输出严格限制为：
  - `create`
  - `reinforce`
  - `supersede`
  - `conflict`
  - `ignore`
- 每项结果带输入版本和 generation；提交时重新执行 CAS。
- create/reinforce/supersede/conflict/ignore 的数据库变更各自原子，已经提交的结果不因后续
  取消回滚。
- organizer 使用带过期时间的 SQLite lease；同一批待整理记录不能被多个进程重复拥有。
- lease 过期后的旧 worker 不能提交已经失去所有权的结果。
- CAS conflict、lease lost、clear generation changed 和记录已删除都按确定规则跳过或失败，
  不覆盖较新结果。
- 普通搜索如何展示 active、superseded 和 conflict，严格使用 GM0 冻结合同。

### 9.3 手动入口

本阶段正式增加：

```text
tinker memory organize
/memory organize
```

- 调用时冻结“本次需要处理的全部待整理集合”，之后新产生的记录留给下一次 organize。
- 命令持续处理该集合，直到完成、用户取消或不可恢复的命令级配置错误。
- TUI 使用全屏进度面板，展示 snapshot total、processed、created、reinforced、superseded、
  conflicted、ignored、failed 和当前 batch。
- TUI Esc 取消尚未完成的模型请求和后续 batch；已提交结果保留。
- CLI interactive TTY 支持用户中断；非交互环境使用进程 signal/exit code 合同。
- 手动整理任务优先于尚未开始的自动整理任务；本阶段尚不存在自动整理调度。
- 显式错误的 processing profile 是命令启动失败；运行中的单批 provider/DB failure 记录后
  继续还是停止，按 GM0 冻结的 batch failure 合同执行。
- status 增加最近一次手动整理时间、结果计数和 bounded error summary。

### 9.4 明确不做

- 不在 TUI 空闲时自动触发。
- 不根据向量距离直接提交合并。
- 不做外部事实核查。
- 不实现 suppression 或“永久忘记某主题”。
- 不重新读取来源 Session 来判断真伪。

### 9.5 重点验证

- 每种 organizer action 都有 version、evidence、搜索结果和 status 的端到端测试。
- 两个进程同时 organize 时 lease 保证单批单 owner。
- lease expiry、CAS conflict、clear、delete 和 cancellation 不产生 stale overwrite。
- 手动 organize 的 snapshot 不会无限吸收运行中新增记录。
- 中断后已提交 batch 保留，未提交 batch 仍可再次处理。
- `/memory organize` 不创建 agent Turn、不写 prompt history 或 canonical history。
- TUI Esc 与新 user Turn 的输入状态不会相互污染。
- 真实 processing profile smoke 覆盖至少 reinforce、supersede 和 conflict。
- `bun run check` 通过。

### 9.6 晋级门槛

- 用户可以观察、启动和中断整理，并能解释每条记忆为何处于当前状态。
- 多进程 organizer 没有重复提交或覆盖新版本。
- 手动整理的结果和普通搜索语义稳定。
- 自动调度只需要调用同一 organizer API，不需要复制简化版实现。

## 十、GM6：空闲自动整理与发布收口

### 10.1 目标

在 GM5 手动引擎稳定后启用固定阈值的空闲自动整理，并完成全局记忆第一版的跨入口、
跨进程、真实 provider 和发布包验证。

### 10.2 自动调度

- 只由交互式 TUI 的进程级 MemoryWorker 检查自动整理。
- TUI idle 时满足任一条件即触发：
  - unorganized 数量达到 50；
  - 最老 unorganized 记录已经等待 7 天。
- 每次自动整理最多处理 50 条。
- 阈值是代码常量，不增加公共配置。
- 自动整理不能延迟当前 Turn 的最终响应；调度发生在 completed Turn 已提交并返回用户后的
  idle boundary。
- 用户开始新 Turn 时：
  - 停止领取新 batch；
  - 取消当前尚未提交的自动整理模型请求；
  - 已经原子提交的结果保留。
- 手动 organize 优先于未开始的自动 organize，但不强行回滚已经提交的结果。
- 手动 organize 不打断已经开始的 memory model 请求；当前请求结束后再按优先级调度。
- 多个 TUI 进程同时达到阈值时继续使用 GM5 lease，只允许一个 owner 处理同一批记录。
- one-shot 和 standalone `tinker memory` 不启动周期性检查或常驻 worker。

### 10.3 发布收口

- README 和公共生成文档完整描述 Memory 配置、工具面、CLI、slash commands、隐私边界、
  vector 降级、best-effort 提取和整理阈值。
- release tarball 验证：
  - 全局安装后加载精确 `sqlite-vec`；
  - 创建安全全局目录；
  - status、search、delete/clear 非交互保护；
  - TUI 与 one-shot 的工具面差异。
- CI 在 macOS、Linux 继续执行真实 vector CRUD/reopen。
- 建立全局 Memory benchmark 和 fault suite，覆盖：
  - 大量 Memory 和多 cue 的 FTS/KNN/聚合；
  - 多进程读写与 organize lease；
  - worker 队列和退出；
  - store busy、provider failure、embedding failure、extension failure；
  - clear generation 与 stale task。
- 真实端到端 smoke 至少覆盖：
  1. workspace A completed Turn 自动提取；
  2. workspace B 的 TUI 和 one-shot 同权搜索；
  3. TUI 模型 update/delete；
  4. CLI status/search/delete；
  5. 手动 organize；
  6. 自动阈值触发；
  7. `/resume`、session delete 和 Tinker 重启后结果仍然一致。

### 10.4 明确不做

- 全局 daemon、云同步、多人共享或跨机器复制。
- one-shot 自动提取或自动整理。
- Recall/compaction 特殊语义。
- ANN、SQLite Vec1、reranker 或 workspace boost。
- suppression、永久主题屏蔽或删除 tombstone 规则。
- 自动事实核查。
- 为早期未公开的 GM1/GM2 测试数据库增加兼容迁移。

### 10.5 完成标准

只有以下条件全部满足，才能把全局记忆第一版标记为完成：

1. GM3 至 GM6 的全部公开入口与上位高层决策一致。
2. TUI、one-shot 和 standalone CLI 使用同一全局数据库，没有各自副本。
3. 自动提取只来自 completed Turn，one-shot 不提取。
4. Memory mutation 的 CAS、ToolCall 幂等、generation 和取消语义通过 fault test。
5. vector 不可用时 FTS 保持可用且所有入口明确降级。
6. clear 能阻止旧 worker 和旧 organizer 结果回写。
7. Memory 内容源过滤、secret rejection 和 observation 警告通过负向测试。
8. 多进程 write、lease 和 busy timeout 行为可重复。
9. macOS、Linux、npm tarball、fake client 和真实 provider/embedding smoke 全部通过。
10. `bun run check` 通过，README 和生成公共 contract 无漂移。

## 十一、阶段晋级总表

| 从 | 到 | 必须先证明 |
| --- | --- | --- |
| GM0 | GM1 | schema/search/config/security 未决项已冻结，sqlite-vec 原型通过 |
| GM1 | GM2 | CAS、generation、幂等、权限和并发 write plane 稳定 |
| GM2 | GM3 | 混合搜索、双平台和安装包 extension 验证通过 |
| GM3 | GM4 | 用户已有 search/status/delete/clear，显式工具语义稳定 |
| GM4 | GM5 | 自动提取不 fault Session，安全投影和 worker 生命周期稳定 |
| GM5 | GM6 | 手动 organizer、CAS、lease、取消和搜索状态语义稳定 |
| GM6 | 完成 | 自动阈值、全入口 E2E、真实 provider、发布包和文档全部通过 |

任何阶段未达到晋级门槛时，只修复该阶段，不提前启用后继自动化。内部模块可以为下一阶段
保留清晰接口，但不能提前注册下一阶段命令、启动 worker 或改变用户数据。

## 十二、实施时必须避免的跨层陷阱

### 12.1 把 worker 绑到 RuntimeSession

如果每个 RuntimeSession 创建 worker，`/resume`、`/clear` 和 model switch 会反复关闭和
重建队列，还可能让同一 TUI 同时存在旧、新 worker。worker 必须由 `runTui()` 进程级持有。

### 12.2 在 presentation 层判断 completed

`turn.finished` event 或 TUI completion callback 不是数据提交真相。自动提取必须挂在
canonical turn finish 成功之后，并只传 Session/Turn 引用。

### 12.3 让 SessionStore 兼任全局数据库

SessionStore 有值得复用的工程模式，但它的 workspace、single-session、Recall 和
canonical-history 语义不能复用为 Memory schema。可以复用小型 SQLite helper，不能共享表或
生命周期。

### 12.4 在 transaction 内等待网络

embedding 和 organizer/processor 请求如果持有写 transaction，会直接放大多进程
`busy_timeout`。所有网络工作必须先完成，commit 时再用 version、generation 和 lease
重新验证。

### 12.5 在 one-shot executor 内拒绝写操作

如果 one-shot 仍注册 mutation schema，只在 execute 时拒绝，模型会看到错误能力，session
surface 也会被污染。不同入口必须在 registry 层拥有不同 definitions。

### 12.6 把 content 加入“方便搜索”的索引

上位合同已经确定 content 不参与关键词或向量搜索。FTS 只能索引 keywords，vector 只能来自
semantic cues；完整 content 只由 get 返回。

### 12.7 静默吞掉 vector 失败

FTS fallback 是降级，不是成功的完整混合召回。raw result、observation、CLI、TUI status
必须携带同一个 vector capability 状态。

### 12.8 直接把 canonical Turn 全量发给 processor

Session SQLite 中存在 system prompt、reasoning、tool raw result、Memory observation 和图片
引用。必须由专用 completed Turn reader 构造 allowlist 投影，不能让 worker 自己从完整
protocol view 中临时过滤。

### 12.9 clear 只做 DELETE

只删除当前记录不能阻止已经在数据库外执行的 extraction、embedding 或 organizer 请求稍后
回写。clear 必须先推进 generation，所有提交都重新验证 generation。

### 12.10 在用户没有管理入口前启用自动积累

GM4 依赖 GM3，不允许只因 extraction 已能写库就提前启动。自动产生的数据必须已经有
search/status/delete/clear 入口。

### 12.11 在手动整理未稳定前启用自动整理

GM6 只能调度 GM5 已验证的同一 organizer API。不能为 idle path 复制一个缺少 progress、
CAS、lease 或 cancellation 的简化实现。

### 12.12 session switch 关闭共享 MemoryService

Memory tool executor 可以随 RuntimeSession 销毁，但共享数据库连接、worker 和本地
MemoryController 的 owner 是 TUI composition root。session disposal 不能关闭它们。

## 十三、建议的下一步

本路线图确认后，下一步只进入 GM0，不直接开始数据库实现。优先编写
`global-memory-storage-search-design.md`，一次冻结：

1. global schema 与状态机；
2. keywords/semantic cues 的限制和搜索聚合；
3. embedding 配置与 vector schema；
4. CAS、generation、lease 和幂等；
5. vector 降级与 status 合同；
6. `sqlite-vec` 双平台及安装包资格脚本。

该设计通过后再实施 GM1；GM3、GM4 和 GM5/GM6 分别保留独立技术设计和审批点。
