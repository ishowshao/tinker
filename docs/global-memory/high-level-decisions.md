# 全局记忆：高层决策记录

## 文档状态

- 日期：2026-07-25
- 状态：讨论中
- 文档性质：高层决策记录

本文只记录当前已经达成共识的产品方向、能力边界和用户入口，不展开数据库 schema、
IPC 消息、完整工具参数、搜索排序算法或迁移步骤。它不是可直接实施的完整技术设计。

## 一、结论先行

Tinker 将增加一套独立的全局记忆系统：

- 记忆来自各个 Session 中已经完成的 Turn。
- 记忆跨 Session、跨 workspace 全局共享。
- 记忆保存提炼后的信息，不保存 Session 原文。
- 记忆可以通过关键词和向量语义进行搜索。
- TUI 中的模型不仅可以搜索记忆，也可以写入、修改和删除记忆。
- `tinker run` one-shot 中的模型只能搜索记忆。
- 用户可以通过 CLI 和 TUI slash command 管理记忆。
- 记忆是可演化的知识，不是只增不改的笔记集合。
- 记忆允许短期重复、粗糙、过期或冲突，通过后续整理逐步收敛。

这套系统被视为 Tinker 的外挂能力，而不是 Session、canonical history 或 context
compaction 的组成部分。

## 二、与 Recall 的边界

全局记忆不是 Recall 的扩展，两者承担不同职责。

| 维度         | Recall                                 | 全局记忆                        |
| ------------ | -------------------------------------- | ------------------------------- |
| 范围         | 当前 Session                           | 所有 Session 和 workspace       |
| 内容         | canonical history 中的历史原文         | 从历史中提炼出的派生信息        |
| 完整性       | 面向稳定来源和精确取回                 | 允许有损、归纳和演化            |
| 生命周期     | 依附于 Session                         | 独立于来源 Session              |
| 模型入口     | 具有历史取回语义的专用工具             | 与 Read 类似的普通工具          |
| context 行为 | 可参与 Recall 和 compaction 的专门契约 | 不获得 Recall result 的特殊处理 |

删除 Session 不级联删除已经由该 Session 产生的记忆。记忆项可以保留来源标识用于诊断，
但其生存期不依赖来源 Session 是否仍然存在。

## 三、记忆来源与提取

### 3.1 提取单位

记忆提取的语义单位是 completed Turn，而不是单个 Frame。

failed、cancelled 或仍在执行中的 Turn 不作为自动提取来源。一个 completed Turn 可以产生
零条、一条或多条候选记忆；并非每个 Turn 都必须形成记忆。

### 3.2 记忆条目与提取结果

每条候选记忆由三个模型生成的部分组成：

- `keywords`：用于关键词召回的精确检索锚点；
- `semantic_cues`：一条或多条简短、自包含的语义线索，每条线索独立参与向量召回；
- `content`：相对完整的记忆正文，保存细节、原因、约束和适用范围。

`semantic_cues` 的数量必须有固定上限，避免单条记忆通过堆积大量线索获得不合理的召回
优势；具体上限留待完整设计确定。同一条记忆的多条 semantic cue 可以覆盖不同召回角度，
但必须仍然指向同一个逻辑主题，否则应拆成多条记忆。

全局记忆库不保存 Turn 原文。`content` 是模型对 Turn 的提炼结果，而不是历史消息的复制。

### 3.3 记忆处理模型

自动提取和记忆整理共用同一个记忆处理 profile，不再增加单独的 organizer profile。
用户可以单独配置这个 profile，例如使用成本更低、能力更弱的模型。

未配置专用 profile 时：

- 自动提取和 TUI 中的整理使用当前 Session profile；
- 独立运行的 `tinker memory organize` 使用当前默认 profile。

单独指定记忆处理 profile 可能在提取时把原 Session 内容发送给另一家模型供应商。这是
显式的用户配置与隐私决策；Tinker 只提供能力，不替用户自动选择不同供应商。

## 四、提取进程与可靠性

自动提取由交互式 Tinker 进程所拥有的伴随 worker 完成：

- 不启动全局常驻 daemon。
- 每个交互式 Tinker 进程最多启动一个记忆 worker。
- worker 内的模型请求并发度固定为 1。
- completed Turn 提取队列最多保留 64 个任务。
- 队列满时丢弃最老的尚未开始任务，保留较新的 Turn。
- 队列保存 Session 和 Turn 引用，不复制原文。
- worker 的生命周期跟随本次 Tinker 进程。
- Tinker 退出时，尚未完成的提取可以丢失。
- 不要求每个 completed Turn 都被严格、最终地处理。

这是有意采用的 best-effort 语义。记忆是一项长期积累能力，允许偶尔漏掉单个 Turn，
不为此引入全局任务服务或严格的持久化重试系统。

worker 不在模型客户端已有重试之外增加自己的重试循环。单个提取或整理任务失败后记录
诊断并继续处理后续任务，不使当前 Session fault。手动整理的优先级高于自动整理，但不
强行打断已经开始的模型请求。

正常退出时停止接收任务、取消当前记忆模型请求并丢弃剩余队列，不等待 drain，也不留下
孤儿 worker。已经提交到全局数据库的结果继续保留。

显式写错的记忆处理 profile 或 embedding 配置属于启动配置错误，应明确失败；运行期间的
提取、整理或向量搜索故障只降低记忆能力，并通过状态和诊断对用户可见。

`tinker run` one-shot 不参与自动记忆提取，也不为提取启动 worker。它只消费已有记忆，
不会因为一次 one-shot 执行而自动形成新的记忆。

## 五、全局存储与搜索

### 5.1 存储位置

记忆属于用户级全局数据，存放在用户 home 目录下，而不是任一 workspace 内。具体目录和
文件命名留待完整设计确定。

### 5.2 存储方向

当前选择以 SQLite 作为本地存储基础：

- 使用 FTS5 提供关键词搜索；
- 每条 semantic cue 的 embedding 以归一化 Float32 BLOB 保存在普通 SQLite 表中；
- 使用 TypeScript 流式扫描向量并计算精确 cosine 相似度；
- 不引入额外原生向量依赖，也不依赖额外服务进程。

第一版采用精确向量搜索，不使用 ANN。写入时验证 embedding 维度、有限值和非零范数，
归一化后再持久化；搜索时只归一化一次 query embedding，逐条计算点积，并先把同一条
Memory 的多个 semantic cue 折叠为一条逻辑候选。

向量数据与记忆正文、关键词 FTS 在同一个短 transaction 中原子提交。macOS 和 Linux CI
以及最终 npm 安装包必须真实验证向量 BLOB 的插入、读取、更新、删除、重开和精确 cosine
结果。第一版不增加进程内向量缓存，避免多个 Tinker 进程之间产生缓存同步和失效语义。

如果 embedding 请求不可用、向量数据无效或向量计算失败，系统必须明确显示 vector
search unavailable，并继续提供 FTS5 搜索。不能静默把 FTS-only 结果伪装成完整混合召回，
也不能因此阻止 Tinker 主 Session 继续工作。

### 5.3 Embedding

Embedding model 独立于工作模型和记忆提取模型配置。全局记忆搜索将结合关键词召回与
向量召回；具体融合和排序策略留待后续设计。

### 5.4 Workspace 关系

搜索时所有 workspace 的记忆完全同权：

- 不按当前 workspace 提权；
- 不默认过滤其他 workspace；
- 不建立 workspace 级记忆隔离。

来源 workspace 可以作为诊断元数据保留，但不影响默认召回权重。

### 5.5 多进程访问

多个 Tinker 进程直接访问同一个全局 SQLite，不增加全局写入 daemon：

- 数据库使用 WAL mode 和 5 秒 `busy_timeout`；
- 每个进程使用独立连接；
- 模型和 embedding 网络请求必须在数据库 transaction 之外完成；
- 记忆正文、FTS 和 vector 变更在同一个短 transaction 中提交；
- 修改、删除和整理提交使用记录版本的 compare-and-swap；
- 整理批次通过带过期时间的 SQLite lease 避免被多个进程重复处理；
- schema 迁移通过 `BEGIN IMMEDIATE` 串行化；
- `clear` 推进全局 store generation，使清空前的 worker 结果失效。

等待写锁超时后，本次记忆操作以普通失败结束，不使 RuntimeSession fault。
`MemoryUpdate` 和 `MemoryDelete` 通过 `expected_version` 执行 compare-and-swap；版本冲突
的具体 observation 形状留待后续设计。

## 六、模型能力

模型侧提供普通工具完成以下操作：

- 搜索记忆；
- 按 ID 精确读取记忆；
- 创建记忆；
- 修改已有记忆；
- 删除单条记忆。

这些工具属于普通 agent tool，不拥有 Recall 的 context 或 compaction 特殊语义。

### 6.1 工具名称与参数

模型可见的工具名称和顶层参数形状确定为：

```ts
MemorySearch {
  query: string
  keywords: string[]
}

MemoryGet {
  id: string
}

MemoryCreate {
  keywords: string[]
  semantic_cues: string[]
  content: string
}

MemoryUpdate {
  id: string
  expected_version: number
  keywords: string[]
  semantic_cues: string[]
  content: string
}

MemoryDelete {
  id: string
  expected_version: number
}
```

`MemorySearch` 的两个输入分别驱动不同的召回路径：

- `keywords` 由模型显式提供，只与记忆条目的 `keywords` 执行关键词匹配；系统不先从
  `query` 中自动提取关键词；
- `query` 是模型对所需记忆的语义描述。系统为它生成一个 embedding，并与每条记忆的各个
  `semantic_cues` embedding 执行向量匹配；
- `content` 不参与关键词或向量搜索，只在按 ID 精确读取记忆时提供相对完整的内容；
- 关键词候选与向量候选最终在逻辑 Memory 层聚合，同一条记忆的多个 semantic cue 不能被
  当成多条独立结果。

第一版 `MemorySearch` 不向模型提供分页或返回数量参数，服务端使用固定的有界结果数量。
关键词规范化和匹配规则、单条记忆的 semantic cue 数量上限、向量候选按 Memory 折叠的
规则，以及关键词和向量结果的聚合与排序算法留待完整设计确定。

`MemoryCreate` 和 `MemoryUpdate` 都接收完整的 `keywords`、`semantic_cues` 和 `content`。
三部分作为同一条逻辑记忆原子提交，避免检索入口与完整正文来自不同版本。
`MemoryUpdate.expected_version` 和 `MemoryDelete.expected_version` 是必须满足的提交
前置条件；版本不匹配时不能覆盖或删除更新后的记忆。

批量 `clear` 当前只出现在用户管理 API 中，没有被纳入模型工具能力。各工具的完整 JSON
Schema、字段长度和数组数量限制、成功与失败 observation 形状尚未冻结。

不同运行入口拥有不同的 memory tool surface：

| 运行入口     | `MemorySearch` | `MemoryGet` | `MemoryCreate`、`MemoryUpdate`、`MemoryDelete` | 自动提取 |
| ------------ | -------------- | ----------- | ------------------------------------------------ | -------- |
| TUI          | 支持           | 支持        | 支持                                             | 支持     |
| `tinker run` | 支持           | 支持        | 不注册                                           | 不支持   |

one-shot 模型完全看不到 `MemoryCreate`、`MemoryUpdate` 和 `MemoryDelete`，而不是看到
工具后在执行时被拒绝。这个限制只属于当前运行入口；one-shot 创建的 Session 以后通过 TUI
恢复时，使用 TUI 的完整 memory tool surface。

### 6.2 模型 mutation 的提交语义

成功的记忆写入、修改和删除在工具调用自己的 SQLite transaction 中立即提交，不等待
Turn 进入 completed。Turn 后续变为 failed 或 cancelled 时，已经成功提交的记忆变更不
回滚。

- transaction 提交前收到取消：不产生变更；
- transaction 已经提交后再取消：变更保留；
- 每次 mutation 自动记录来源 Session、Turn 和 ToolCall 身份；
- 自动提取仍然只处理 completed Turn。

这是普通有副作用工具的语义，不在全局记忆库与 SessionStore 之间建立跨库延迟提交或
回滚协议。

## 七、用户管理入口

CLI 采用以下高层命令形状：

```text
tinker memory search <query>
tinker memory organize
tinker memory delete <id>
tinker memory clear
tinker memory status
```

TUI 提供对应的 `/memory` 命令：

```text
/memory search <query>
/memory organize
/memory delete <id>
/memory clear
/memory status
```

CLI 与 TUI 应访问同一份全局记忆，而不是维护各自的数据副本。具体展示形式、确认交互和
输出格式遵循以下契约：

- `/memory` 无参数时等价于 `/memory status`；
- `/memory search` 使用可滚动的全屏结果面板；
- `/memory status` 使用全局状态面板；
- `/memory organize` 显示整理进度，Esc 可以中断；
- `/memory delete <id>` 先展示目标记忆并要求确认；
- `/memory clear` 必须确认。

CLI 在交互式 TTY 中请求确认；非交互环境执行 delete 或 clear 时必须显式传入
`--confirm`。

所有 `/memory` 命令都是纯 TUI 本地操作：

- 不形成 agent Turn；
- 不写 prompt history；
- 不进入 canonical Session history；
- 面板内容不自动提供给模型。

模型需要记忆时必须自行调用搜索工具；该普通工具的 observation 会像其他工具结果一样进入
Session history。`tinker memory ...` 是用户直接调用的管理命令，不属于 `tinker run`
中模型可见的工具，因此不受 one-shot 只读工具面的限制。

`memory status` 至少展示：

- 当前进程 worker 的 queued、running、succeeded、failed 和 dropped 计数；
- 全局 active、unorganized、superseded 和 conflict 计数；
- 最近一次提取与整理的时间和错误摘要；
- FTS、vector 和 embedding 状态。

## 八、可演化记忆与整理

全局记忆不追求每次写入后立即完成全局去重和事实协调。新记忆可以先进入存储并参与搜索，
即使短期内存在重复、表述粗糙、过期、错误或相互冲突的记录，也不视为系统故障。

用户可以通过以下入口主动整理记忆：

```text
tinker memory organize
/memory organize
```

整理过程负责让已有记忆逐步收敛。全局记忆不是 append-only 数据集，整理或新的信息可以
改变已有记忆，目标语义包括：

- `create`：形成一条新的记忆；
- `reinforce`：新的证据再次确认已有记忆；
- `supersede`：新的事实或决定替代旧记忆；
- `conflict`：发现矛盾，但暂时不能可靠判断哪一方有效；
- `ignore`：候选内容没有长期价值，或只是无意义的重复。

整理主要处理语义层面的质量问题，包括合并重复、强化已有结论、替代过期信息、保留未决
冲突，以及改善关键词和记忆表述。

手动与自动整理遵循以下调度：

- `/memory organize` 和 `tinker memory organize` 处理调用时全部待整理记忆，直到完成或
  用户中断；
- 自动整理只在 TUI 空闲时检查；
- 待整理记忆达到 50 条，或最老待整理记录已等待 7 天时触发；
- 每次自动整理最多处理 50 条；
- 自动整理不能延迟当前 Turn 的最终响应；
- 用户开始新 Turn 时，自动整理让路；
- 中断只停止未完成工作，已经原子提交的整理结果继续保留；
- 阈值是第一版固定代码常量，不增加用户配置。

整理继续使用第四节定义的进程内 worker，不因此引入全局常驻 daemon 或强时效性要求。

整理器不是事实核查器。没有反证、冲突或用户修正时，一条看似合理的错误记忆不一定能被
自动识别，因此模型和用户仍然需要修改、删除记忆的能力。整理也不能替代写入时必须保证的
数据库与 vector 数据完整性，以及敏感信息边界。

整理只依赖已经保存的派生记忆及其来源元数据，不要求重新打开原 Session 或读取原文。
旧信息如何保留、普通搜索是否展示 superseded 记录，以及冲突和重复整理的具体持久化方式，
留待完整设计。

### 8.1 写入时的最小幂等

写入路径只做便宜、确定性的幂等：

- 当前 agent loop 不重放已执行 ToolCall；模型 mutation 使用 `expected_version` CAS；
- 自动提取把 Session、Turn 和候选内容 hash 合成非空 source fingerprint，防止同一候选
  重放；
- 完全相同的规范化内容不创建新记录，而是记录新的 evidence/reinforcement；
- `clear` 之后，旧 store generation 的任务不能再回写结果。

写入时不使用向量相似度执行语义合并。近似重复、措辞不同的重复，以及同一 Turn 中模型
主动写入与自动提取产生的相似内容，都允许暂时存在并交给后续整理。

### 8.2 删除与重新形成

删除表示移除当前逻辑记忆及其全部派生搜索数据，不表示永久禁止记住相同主题：

- 删除前已经开始的旧工作不能立即恢复被删除的记忆；
- 未来新的 Turn 提供新证据时，可以重新形成同类记忆；
- 第一版不提供 suppression 或永久 forget 规则。

第一版 delete 推进全局 store generation，使删除前已经开始、尚未提交的异步任务全部
失效；这是避免增加 per-Memory tombstone 的简化选择。删除后的新任务使用新 generation。

如果未来需要“永远不要记住这类内容”，应单独设计 suppression 能力，不重载 delete。

## 九、安全与污染边界

记忆允许短期错误，但秘密泄露和持久化提示注入不能等待整理器事后修正。

存储和提取必须遵守：

- 全局记忆目录权限为 `0700`，数据库文件权限为 `0600`；
- system/developer prompt、assistant reasoning 和原始工具结果不作为记忆内容；
- 对 API key、token、cookie、密码和私钥做确定性检测，命中后拒绝整条候选；
- Memory 工具 observation 不能作为后续自动提取的证据；
- 网页或工具内容中的指令，除非用户明确认可，否则不能形成行为性记忆；
- 搜索结果必须明确标记为派生、可能过期或错误的数据，而不是高优先级指令；
- 记忆保留来源 workspace 和时间，使模型能够判断项目作用域，但不改变全局同权排序；
- 当前 workspace 的事实仍应通过 Read、Grep 或 Bash 验证。

错误记忆通过整理、模型修改和用户删除逐步修正。单个记忆任务的运行时失败只影响记忆能力，
不使主 Session fault；任何降级都必须通过 observation、TUI notice 或
`memory status` 明确可见。

## 十、明确不做

当前高层方案明确不做以下事情：

- 不把全局记忆合并进 Recall。
- 不把记忆作为 canonical Session history。
- 不在记忆库中保存 Session 原文。
- 不为提取启动全局常驻 worker。
- 不保证所有 completed Turn 最终都完成提取。
- 不支持 `tinker run` one-shot 自动提取记忆。
- 不向 `tinker run` one-shot 注册记忆写入、修改或删除工具。
- 不因删除 Session 而自动删除记忆。
- 不对当前 workspace 的记忆给予额外搜索权重。
- 不要求每次写入立即完成全局去重和冲突消解。
- 不保证整理器能够独立识别没有反证的错误记忆。
- 不因 failed 或 cancelled Turn 回滚已经提交的模型记忆 mutation。
- 不把 delete 解释为永久 suppression。
- 不在第一版使用 ANN、原生向量扩展或独立向量服务。

## 十一、待后续讨论

以下内容已有明确阶段归属：

- 模型工具的完整 JSON Schema 和 observation 形状在 GM3 开始前冻结；
- 关键词匹配、semantic cue 向量候选折叠，以及两路结果的聚合与排序算法已经由
  [`global-memory-storage-search-design.md`](global-memory-storage-search-design.md) 冻结；
- GM0 已冻结 schema v1 不保留逐次 update 历史、不预建 organizer/relations；旧逻辑
  Memory 保留、supersede/conflict relation、action 幂等、batch、lease 和交互合同在 GM5
  开始前统一冻结并通过 migration 增加。
