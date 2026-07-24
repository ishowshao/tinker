# Context Revision I4：主动 Recall 评测与自动化门禁技术方案

## 文档状态

- 日期：2026-07-18
- 状态：已完成（2026-07-18）；DeepSeek floor qualification 已通过，自动 swap-only 与
  prefix retirement 已放行
- 所属阶段：[`agent-runtime-roadmap.md`](agent-runtime-roadmap.md) 的 I4
- 前置阶段：I1 Context Revision 影子规划、I2 温层确定性换出、I3 Recall-first
  冷前缀退休
- 当前基线：SessionStore schema v8、immutable `ContextSurface`、线性
  `ContextRevision`、`swap-only-v1`、`recall-first-retirement-v1`、稳定来源与
  `Recall`、手动 `/compact`、手动 `/compact retire`
- 后继阶段：只有本阶段证明 Recall-only 存在稳定、可重现且可归因的连续性缺口时，才进入
  I5 可选结构化 checkpoint
- 相关设计：
  [`context-revision-i1-shadow-planning-design.md`](context-revision-i1-shadow-planning-design.md)、
  [`context-revision-i2-deterministic-swap-manual-compact-design.md`](context-revision-i2-deterministic-swap-manual-compact-design.md)、
  [`context-revision-i3-recall-first-prefix-retirement-design.md`](context-revision-i3-recall-first-prefix-retirement-design.md)、
  [`stable-source-recall-design.md`](stable-source-recall-design.md)、
  [`infinite-context-technical-design-a.md`](infinite-context-technical-design-a.md)

## 一、结论

I4 不是再实现一种压缩表示，也不是要求模型在所有长会话问题上“永不忘记”。I4 要建立一套
可重复、可归因、可机器判分的主动 Recall 评测，并把评测结果变成自动 swap-only 与自动
prefix retirement 的显式资格。

本阶段采用以下决定：

1. 先完成评测基础设施、题目和真实 profile 基线；门槛冻结并通过独立 qualification
   workload 后，runtime pressure 才允许在 turn 结束或 resume 的 idle boundary 提交 revision。
2. 同一题必须比较 `full_history`、`swap_only` 和 `recall_only_retirement` 三种活动视图；
   canonical history、workspace 初始状态和最终 user prompt 保持一致。
3. 最终 prompt 必须完整说明当前任务的对象、动作和验收结果。唯一允许缺失的是刻意放入
   退休前缀、且当前任务确实依赖的历史事实。
4. “继续完成它”这类对象不明、目标不明或验收不明的 prompt 不得进入 qualification suite；
   这类失败无法归因于 Recall。
5. 每类正例至少使用一组反事实配对：两个会话拥有不同的早期决定，但使用逐字相同的最终
   prompt，并要求产生不同且可客观验证的正确结果，防止模型靠默认选择或猜测过关。
6. `full_history` 是题目有效性基线，不是无条件的满分答案。完整历史下仍不能稳定完成的题目
   不能用来处罚 retirement；不能在看到 Recall-only 结果后再选择性删除题目。
7. 第一版 Recall 是 FTS5 trigram/substring 检索，不把完全无词面锚点的任意语义改写当作
   自动退休门槛。改写题必须保留现实中可用的实体名、文件名、路径、命令、错误串或主题锚点，
   并允许模型迭代 search。
8. qualification 不使用另一个模型做主观 judge。任务结果、workspace、命令轨迹、Recall
   source/hash 和 provider usage 全部由确定性 grader 判分；人工评审只用于题目入库前审核，
   不参与正式得分。
9. 主动调用 Recall 的比例是诊断指标，不是单独的通过条件。核心结果是必要历史是否恢复、
   source 是否正确、最终任务是否完成、是否违反早期约束，以及额外成本是否合理。
10. 不在没有真实基线时拍脑袋写百分比门槛。实际先用 calibration workload 记录
    full-history 上限和三种视图分布，再冻结
    `active-recall-qualification-policy-v1`；calibration 与 holdout 使用不同实体和事实。
11. 自动 swap-only 与自动 prefix retirement 分开过门：前者只需要工程安全、预算、cache、
    成本和 revision 失败语义；后者在此基础上还必须通过主动 Recall 任务质量门槛。
12. 本机现有 profile 采用用户明确指定的 capability-floor 规则：以能力相对普通的
    `deepseek-v4-flash` 作为行为下限；它通过后，当前已配置的更高能力 profile 继承行为资格。
    这不是从相似 model name 猜测，而是本产品对当前 profile 集合的显式策略。
13. 资格绑定 manifest、grader、fixture、policy、正负 holdout report、Recall contract 文本和
    Recall tool definition 的 hash。runtime 对 contract/tool 漂移 fast-fail 到 automation off；
    checked-in report 与编译门禁的 hash 由测试互相校验。手动 `/compact` 和
    `/compact retire` 始终不依赖资格。
14. 自动 revision 只在完整 turn 已提交、session 空闲的边界重新规划并提交；不能复用旧 shadow
    plan，也不能在 open tool frame、工具执行中或 pending turn 中切换活动视图。
15. I4 不生成 checkpoint、summary、embedding、reranker，也不增加 model-assisted eviction。
    Recall-only 未达门槛时先保留手动路径，用失败数据决定是否值得设计 I5。

## 二、I3 已经证明什么，I4 还缺什么

### 2.1 I3 已经证明检索链路可用

I3 已经用 deterministic benchmark、真实 provider smoke 和 PTY 证明：

- 完整旧前缀可以退出 provider payload；
- canonical messages、tool results 和 Recall FTS 不被删除或改写；
- 明确告诉模型“使用 Recall 找回早期 marker”时，模型可以完成 `search -> get`；
- retirement、继续追加、再次 compact 和 `/resume` 后，相同 source/content/hash 仍可取回；
- retirement 本身不调用模型，不执行工具，并保持 revision transaction 的失败语义。

这证明“书还在图书馆里，而且给出明确要求时可以借到”，但没有证明模型在真实任务中会意识到
自己缺少哪段历史，也没有证明检索后的任务质量足以支撑自动退休。

### 2.2 “主动 Recall”不是 runtime 自动注入历史

I4 所说的主动 Recall，指模型在当前任务存在历史依赖、而 active context 没有相关原文时，
自己决定调用已有 `Recall` tool。第一版不增加 runtime query generator，不在模型请求前自动
搜索，也不把搜索结果偷偷注入 prompt。

因此需要分别观察：

```text
模型是否意识到需要历史
  -> 是否发出合理的 Recall search
  -> search 是否出现正确 source
  -> 是否 Recall get 必要原文
  -> 是否把历史原文用于正确任务结果
```

其中任一层失败，都应在报告中有独立原因，不能只留下一个模糊的“模型忘了”。

### 2.3 模糊 prompt 会污染结论

以下题目无效：

```text
早期：只能改文档，不能改代码。
很久以后：继续完成它。
```

失败可能来自：

- “它”没有明确指向哪个任务；
- “完成”没有说明需要产生什么结果；
- 当前任务和早期约束是否仍属于同一目标不明确；
- 模型即使完整看到历史，也可能无法确定下一步。

这种题目不能区分 prompt 理解失败和主动 Recall 失败，因此不得进入 calibration 或
qualification。

一个有效的隐式历史依赖题应更接近：

```text
早期会话 A：session export 的清单格式确定为 JSONL。
早期会话 B：session export 的清单格式确定为 YAML。

两个会话使用相同的最终 prompt：
实现 session export 的清单序列化和文件命名，并补充 round-trip 测试。
```

当前任务对象、动作和验收都明确，唯一缺失的是早期已经确定的格式。两个历史要求不同输出，
因此可以判断模型是否真的利用了 session 历史。

## 三、本阶段范围

### 3.1 实施范围

- `active-recall-eval-v1` versioned case manifest、fixture builder 和 deterministic grader。
- 每个 case 使用 10 个已结束 turns、每 turn 一个 12 KiB Read observation 的 token-long
  synthetic fixture；不以 turn 数冒充长度，而以早期 source 确实小于 `keepFromOrdinal`、且正文
  确实不在 provider payload 为硬条件。
- `full_history`、`swap_only`、`recall_only_retirement` 三种隔离运行模式。
- 显式历史提示、隐式早期约束、词面线索改写、旧失败防重复、历史/当前版本区分五类题目。
- 每类至少一组反事实 pair，以及不需要 Recall 的 negative controls。
- required source 是否真正退休、provider payload 是否不含原文、Recall search/get 轨迹、
  workspace mutation、command trace、usage、latency 和 cache 的结构化采集。
- fake model 基础设施测试和真实 provider/profile qualification runner。
- calibration report、冻结的 evaluation policy、holdout qualification report 和机器可读资格文件。
- streaming/non-streaming response 的 resolved model identity 采集，以及 versioned
  qualification/report hash 校验。
- 自动 swap-only 与自动 prefix retirement 的独立 feature gate。
- turn 结束和 resume 后的 idle-only automatic context maintenance coordinator。
- 自动 revision 的 bounded event reason/qualification identity、fault matrix、真实 provider
  与 cache smoke。

### 3.2 明确不做

- 不把含糊代词、目标不完整或无客观验收的 prompt 当作主动 Recall 考题。
- 不测试“猜出某个随口提到的冷知识”，只测试明确记录过、且后续任务确实依赖的 decision、
  constraint、failure、evidence 或 historical version。
- 不要求没有任何可检索锚点的任意语义改写命中当前 literal Recall。
- 不用模型评审模型，不使用自由文本 rubric 产生资格。
- 不以 Recall 调用次数越多越好，也不要求每个任务都调用 Recall。
- 不改写 Recall source、FTS 排序、search/get 参数或 canonical history 语义；calibration 只在
  system contract 和 tool description 中补充“用短字面锚点搜索”的真实工具提示。
- 不引入 embedding、reranker、知识图谱、跨 session Recall 或长期用户记忆。
- 不生成 checkpoint、capsule 或自由文本摘要。
- 不增加 model-assisted candidate selection；I4 自动路径继续复用 I1 至 I3 的确定性 planner。
- 不在 active turn、open tool frame、工具副作用执行中提交 revision。
- 不自动重试因 hard preflight 失败的 user turn，也不静默截断新 user prompt。
- 不让 qualification 文件成为 session 历史或恢复 source of truth。
- 不为未发布的 qualification schema 提供 migration 或 compatibility shim。

## 四、当前实现基线与需要补齐的边界

| 当前组件 | 已有能力 | I4 缺口 |
| --- | --- | --- |
| `scripts/bench-long-session-memory.ts` | 真实 RuntimeSession/SessionStore、50-turn、resume、swap、retirement、显式 Recall marker | 没有真实主动 Recall workload、三视图对照和任务 grader |
| `ContextManager.compact()` | 接受 `runtime_pressure`，复用确定性 `SwapPlanner` | 已接 automatic coordinator；正常支持 `below_trigger` no-op |
| `ContextManager.retirePrefix()` | 完整 transaction/fault 语义 | 已接受 production `runtime_pressure`，只在行为资格通过时调度 |
| `RuntimeSession` | iteration preflight 执行 shadow planning | 已在 turn commit/skill settlement 后及 pressured resume 后重新规划；每 cycle 最多一次 swap、一次 retirement |
| `ContextSurface` | 保存 system prompt、tool definitions、request config 及 hash | automation gate 精确校验当前 Recall contract 文本与 Recall definition hash |
| `ModelProfile` | profile name、model、context budget、reasoning/stream 配置 | 当前配置集合按 DeepSeek floor policy 继承；无 profile 时 automation off |
| `Recall` | session-local FTS5/substring search、稳定 source、精确 get | 已有三视图行为 recorder；检索存储语义未改 |
| revision events | 手动 swap/retirement 的 bounded 生命周期事件 | 已支持 `reason=runtime_pressure` 与 bounded qualification ID |

I4 优先复用已有 compiler、planner、transaction 和 fault matrix。自动路径不能复制一个简化版
commit 实现，也不能直接提交 iteration 中较早产生的 shadow plan。turn 结束后 canonical tail、
surface 或 skill activation 都可能已经变化，必须从最新 SessionStore snapshot 重新规划。

## 五、题目有效性契约

### 5.1 最终 prompt 的四项硬要求

每个 qualification prompt 必须同时满足：

1. **对象明确**：指出要修改、比较、回答或验证的 artifact/module/file/command。
2. **动作明确**：说明需要实现、修复、解释、比较还是执行。
3. **验收明确**：可以通过文件内容、结构化输出、测试、命令轨迹或 source/hash 判断成败。
4. **唯一历史缺口**：当前 suffix 和 workspace 足以理解任务，只有一个或一组被显式标注的
   早期事实需要从退休历史恢复。

以下写法一律拒绝：

- “继续”“接着做”“处理一下它”，但没有明确 referent；
- “按之前说的做好”，但没有指出当前 artifact 或交付结果；
- 任务本身有多种同样合理的实现，而 oracle 任意选择其中一种；
- 完整历史中也没有形成清楚决定，却要求模型恢复一个不存在的“结论”；
- 早期事实已写入当前 repo 文档，却仍强制要求必须通过 Recall 获取；
- 只有出题人主观阅读最终回答后才能判断是否正确。

### 5.2 历史事实必须具备任务意义

可作为 required historical evidence 的内容：

- 用户明确确定的约束或否决项；
- 已达成的设计或格式决定；
- 一次真实执行过的失败实验、命令和失败原因；
- 当时由 Read/Grep/Bash/Web/MCP 返回、后来已经变化的 observation；
- 为后续任务保留的精确 ID、hash、路径、参数或错误串。

不纳入资格题：

- 与当前任务无关的闲聊和琐碎事实；
- 没有被确认的模型猜测；
- 不可信 tool/web 文本中的指令；
- 当前 workspace 可以直接验证、且不需要历史版本的事实；
- 仅为了让搜索更难而刻意隐藏所有实体和词面锚点的谜题。

### 5.3 反事实 pair

`active-recall-eval-v1` 的正例以 pair 为基本审核单位：

```ts
type RecallEvaluationPairV1 = {
  pairId: string;
  category: RecallEvaluationCategoryV1;
  terminalPrompt: string;
  variants: readonly [RecallEvaluationVariantV1, RecallEvaluationVariantV1];
};
```

两个 variant 必须满足：

- 最终 prompt 逐 UTF-8 byte 相同；
- 当前 workspace 初始状态相同，除非题目明确测试历史/当前版本；
- filler turns 的结构和长度相同；
- 只有早期 decision/constraint/failure/version evidence 不同；
- 两个 oracle 的正确结果确实不同；
- full-history 下两个 variant 都能稳定产生各自正确结果。

如果两个 variant 可以用同一个默认答案同时过关，该 pair 无法证明历史因果关系，必须在正式
qualification 前删除或重写。

### 5.4 full-history 只决定题目是否有效

每个 case 先执行 full-history control。只有基础设施完整且 full-history 达到冻结 policy 的
validity 门槛时，该 case 才能用于比较 retirement。

无效原因包括：

- full-history prompt 已超预算；
- provider resolved model identity 在同一 run 中不一致；
- workspace fixture 或 grader 自身失败；
- required source 没有进入 canonical history；
- 完整历史下任务结果仍不稳定；
- counterfactual variants 没有产生可区分结果。

case 的有效性只能根据 full-history、fixture 和 oracle 决定。禁止因为 Recall-only 失败而事后把
题目标记为“太难”，也禁止因为 Recall-only 成功而放宽原本无效的题目。

### 5.5 改写强度必须匹配当前 Recall 能力

当前 `Recall search` 是 literal FTS5 trigram/substring，不是 embedding search。改写题用于测试
模型能否构造和迭代合理 query，而不是测试尚不存在的检索算法。

有效改写至少保留一个稳定锚点：

- feature/module 名；
- 文件名或路径片段；
- command、flag 或错误串；
- artifact、协议或配置字段名；
- 用户在早期和当前都自然会使用的主题词。

例如早期使用“temporary file + rename”，后期可以要求“让 profile 保存具备 crash-safe 语义”，
但仍应保留 `profile`、配置文件名或 persistence 模块名。把所有实体都换掉，只保留抽象同义词，
不属于 v1 自动退休门槛。

## 六、评测场景

### 6.1 五类正例

| 类别 | 主要验证 | 最终 prompt 约束 | 确定性结果 |
| --- | --- | --- | --- |
| `explicit_history` | 用户明确提示存在历史时，模型会使用 Recall | 明确说“之前讨论/决定/执行过”，同时明确当前任务 | 正确 source/get 与任务结果 |
| `implicit_constraint` | 当前任务隐式依赖早期硬约束时，模型能意识到要查 | 当前任务完整，不用模糊代词；保留 artifact 锚点 | workspace/output 满足对应 variant 约束 |
| `lexical_rewrite` | 当前措辞与历史原文不完全一致时，模型能迭代 search | 至少保留一个现实锚点，不要求任意语义搜索 | 正确 source 命中、get 和任务结果 |
| `prior_failure` | 模型不会重复已知失败路径 | 当前目标明确，旧失败仍与当前环境相关 | 不执行 forbidden attempt，采用可行路径 |
| `historical_current_version` | 模型区分历史 observation 与当前 workspace | 明确需要比较或利用两个版本 | Recall 返回旧版，Read/Grep 返回新版，差异正确 |

`explicit_history` 是 Recall 工具链和 instruction-following 基线，不单独证明“主动”。主动 Recall
质量主要由另外四类 case 评价。

### 6.2 negative controls

suite 必须包含当前 suffix 或 workspace 已经提供全部必要信息的任务，用于测量无必要 Recall。
negative control 同样需要明确任务和确定性 oracle，但不得埋入会改变正确答案的退休事实。

以下行为不自动算错：

- 模型为核实是否存在旧决定而执行一次有界 search；
- 第一次合理 query 未命中后，用同一 artifact 的另一个锚点重试；
- 当前任务明确要求审计历史，即使最终事实也能从 workspace 看见。

以下行为记为无效检索成本：

- negative control 中反复搜索无关主题；
- 已 get 正确完整 source 后继续重复相同 search/get；
- 获取错误 source 后不核对当前 workspace 就据此修改文件；
- 用 Recall 历史 observation 代替用户要求的当前 Read/Grep 验证。

### 6.3 v1 最低覆盖

正式 suite 至少包含：

- 每类一组反事实 pair；
- 至少三个 negative controls；
- required evidence 使用 user decision/constraint，另有 Read 当前文件状态；assistant/tool 历史
  的精确 Recall 已由 I3 component/provider benchmark 覆盖，不重复伪装成 I4 行为题；
- project、artifact、persistence、命令、path 和历史/当前配置标签；
- 至少一个需要多次 search 才命中的合理改写题；
- 至少一个同时要求 Recall 历史版本与 Read 当前版本的任务。

正式 qualification 对每个 variant、每种活动视图执行固定三次 trial。trial 数、case 集合和顺序
生成规则进入 suite hash；不得只重跑失败项并从多次结果中挑最好的一次。

## 七、长会话 fixture 与三种活动视图

### 7.1 fixture 构造

每个 case 使用 10 个完整已结束 turns。这个数字不是用来模拟“第 60 turn”的表面长度，而是
刚好超过 8-turn 保护区，并用 12 KiB observation 把 token 体积做实：

```text
turn 1        required historical evidence
turn 2..10    deterministic 12 KiB Read observations
swap point    benchmark-forced swap-only revision when applicable
retire point  benchmark-forced prefix retirement
recent tail   at least 8 complete protected turns
terminal turn real provider evaluation prompt
```

session 从创建起就绑定待评测 profile 的 model、message protocol、request config 和 surface。
前 10 turns 注入一个使用相同 `prepare()`/serialization identity 的 deterministic
OpenAI-compatible benchmark client，不消耗真实 provider，但必须经过真实 RuntimeSession、
SessionStore、tool registry、observation builder、protocol validator 和 context compiler。terminal
turn 在同一个 model wrapper 中切换到真实 transport，因此 `prepare()`、message protocol、profile
和 surface 从 session 创建起保持不变。

fixture builder 记录 logical evidence label 到实际 `ctx://message/<id>`、ordinal、content hash 和
必要 byte range 的映射。这个 oracle mapping 只交给 grader，不进入 model-visible prompt、tool
output、workspace 文件或 event notice。

### 7.2 隔离和可比性

每个 mode/trial 使用新的临时 workspace 与新 session，全部串行执行。临时路径 suffix 是不参与
任务的 opaque 值；其余 model-visible fixture 内容保持一致。runner 固定：

- canonical message 内容、turn/frame 边界和 created-at 顺序；
- system prompt 模板、project instructions、空 skill catalog 和 tool definitions；
- terminal prompt bytes；
- workspace fixture 内容与权限；
- model profile 和 request policy。

evaluation 文件只允许位于专用临时目录或 workspace 下 Git 忽略的
`.tinker/evaluations/<run-id>/`。benchmark tool runtime 拒绝写出该目录；Bash command trace 记录
argv/cwd/exit，不保存环境变量或 secret。每个 trial 结束后验证 repo tracked files 未变化。

### 7.3 三种模式

#### `full_history`

- 不提交 swap 或 retirement revision；
- required source 原文必须存在于 terminal prepared payload；
- 作为题目有效性和最高可见历史基线；
- 整个 request 必须低于 input budget。

#### `swap_only`

- 使用 I2 的 deterministic planner 和 `swap-observation-v1`；
- tool observation 若合格则变为 source/hash placeholder；user/assistant 历史仍保留；
- 不前移 `keepFromOrdinal`；
- 记录 placeholder cue 对 Recall 与任务质量的影响。

#### `recall_only_retirement`

- 先使用与 `swap_only` 相同的 swap 序列，再提交 I3 prefix retirement；
- required evidence 必须满足 `ordinal < keepFromOrdinal`；
- terminal payload 中不得出现 required source 正文、旧 placeholder、marker 或对应 tool skeleton；
- active view 只保留 system surface、Recall tool 和近期完整 suffix；
- 不生成 checkpoint 或摘要。

如果 required evidence 未真正退出 payload，该 trial 不是 Recall-only 成功，而是 fixture failure，
整个 trial 无效并 fast-fail。

## 八、case manifest 与 grader 契约

### 8.1 manifest

```ts
type RecallEvaluationCategoryV1 =
  | "explicit_history"
  | "implicit_constraint"
  | "lexical_rewrite"
  | "prior_failure"
  | "historical_current_version"
  | "negative_control";

type RecallEvaluationCaseV1 = {
  caseId: string;
  pairId?: string;
  variantId: string;
  category: RecallEvaluationCategoryV1;
  terminalPrompt: string;
  promptAnchors: readonly string[];
  requiredEvidenceLabels: readonly string[];
  fixtureVersion: "active-recall-fixture-v1";
  oracle: RecallEvaluationOracleV1;
};

type RecallEvaluationOracleV1 = {
  requiredSources: readonly string[];
  exactOutput?: unknown;
  workspaceAssertions: readonly WorkspaceAssertionV1[];
  forbiddenCommands: readonly CommandPatternV1[];
  requireHistoricalGet: boolean;
  requireCurrentWorkspaceRead: boolean;
};
```

manifest parser 必须拒绝：

- 重复 case/pair/variant ID；
- 不完整的 counterfactual pair；
- pair 的 terminal prompt 不同；
- 正例没有 required evidence；
- negative control 携带 required evidence；
- 没有任何机器可判分 oracle；
- required source label 不存在或位于 protected suffix；
- prompt anchor 既不出现在 terminal prompt，也不对应可用的 source/path/filter；
- oracle 路径逃逸 evaluation workspace；
- command pattern 包含宽泛通配而可能误判无关命令。

### 8.2 不使用模型 judge

grader 只接受以下证据：

- exact JSON 或其他 versioned structured output；
- 文件存在性、mode、hash、AST-free 精确字段和值；
- repo/workspace diff allowlist；
- test exit status；
- command argv/cwd/exit trace；
- Recall tool args、search hit source、get source/content hash/byte range；
- Read/Grep 等当前 workspace tool trace；
- provider usage 和 wall-clock duration。

如果题目必须由人理解一段自由文本“是否大致正确”，该题只能留在探索报告，不能产生
qualification。

### 8.3 行为失败与基础设施失败分离

行为失败包括：

- 模型没有在必要时 Recall，随后猜错或违反历史约束；
- search query 合理执行但没有命中 required source，且模型未继续定位；
- get 了错误 source 并据此完成错误任务；
- 重复执行 oracle 明确标注的旧失败命令；
- 把 historical observation 当成当前文件状态；
- tool args、文件结果或最终 structured output 不满足 oracle。

基础设施失败包括：

- provider transport/usage/model identity 不完整；
- SessionStore、fixture、tool sandbox 或 grader 故障；
- required evidence 没有按预期进入或退出 active payload；
- qualification runner 自身超时或被取消；
- workspace 初始状态不一致。

基础设施失败不计作模型质量失败，但也不得生成资格。正式 run 不自动挑选性重试；修复原因后
重新运行完整 suite。

## 九、指标定义

### 9.1 主要任务指标

- `task_success_rate`：确定性 oracle 全部通过的 trial 比例。
- `relative_task_success_delta`：Recall-only 相对同 case full-history 的成功率差值。
- `hard_constraint_violation_rate`：违反用户早期硬约束或 forbidden action 的比例。
- `repeat_failure_rate`：执行已知失败 attempt 的比例；即使后来修复，也单独记录。
- `historical_current_confusion_rate`：版本题中把历史内容当当前状态或反向混淆的比例。

### 9.2 Recall 路径指标

- `recall_opportunity_count`：oracle 声明需要退休历史的有效 trials。
- `active_recall_rate`：未直接提示“调用 Recall”的有效机会中，模型至少调用一次 Recall 的比例。
- `expected_source_discovery_rate`：任一 search page 出现 required source 的比例。
- `expected_source_get_rate`：模型对 required source 执行 get，并覆盖 oracle 必要 byte range 的比例。
- `search_to_get_rate`：search 后 get 其中返回 source 的比例；只在任务需要精确正文时作为质量项。
- `wrong_source_get_count`：get 了与任务无关 source 的次数。
- `zero_hit_search_count`：空 search 次数；合理 query 迭代与无关搜索在 grader 中分开。
- `unnecessary_recall_rate`：negative controls 中超过 policy allowance 的 Recall 比例。
- `redundant_recall_count`：已取得足够 source 后重复相同 search/get 的次数。

`active_recall_rate` 不等于通过率。模型可能 Recall 后仍用错历史，也可能在不需要 Recall 的题目中
直接完成。资格以任务结果和 source correctness 为主，调用率用于解释原因。

### 9.3 成本与 cache

每个 terminal evaluation 记录：

- provider request 数和总 iteration 数；
- prompt/completion/total/reasoning tokens；
- prompt cache hit/miss tokens；
- Recall search/get 调用数和 observation bytes；
- 首 token 指标不可得时的总 request latency，以及 end-to-end duration；
- revision planning/validation/transaction/activation duration；
- full-history、swap-only、Recall-only 的 terminal payload tokens；
- 第一次 prefix rewrite 与同 revision append 的 cache 行为。

cache、latency 和 token 是资格成本的一部分，但不能通过降低任务质量换取好看的成本数字。

## 十、calibration、门槛冻结与 qualification

### 10.1 为什么现在不写任意百分比

在当前 profile 尚无主动 Recall 数据时，直接规定“必须 100% 主动 Recall”或随意写一个 95%，
既不能反映 full-history 本身的上限，也不能说明额外成本是否值得。过严会让自动退休永远没有
实际入口，过松则把错误归因成偶然波动。

I4 因此分两套互不重用的 workload：

```text
calibration set
  -> 测 full-history 上限、case 稳定性和成本分布
  -> 删除或重写无效题，但保留变更记录
  -> 冻结 evaluation-policy-v1 的具体数字和 suite 结构

holdout qualification set
  -> 不再改题或改门槛
  -> 对 DeepSeek floor profile 执行三视图、固定三次 trials
  -> 生成 pass/fail report
```

calibration case、同事实换皮版本和其 oracle 不得进入 holdout。门槛冻结后，任何 case、grader、
trial 数或评分公式变化都发布新 suite/policy version，旧资格失效。

### 10.2 冻结 policy 必须包含

`active-recall-qualification-policy-v1` 在正式 qualification 前必须写死：

- 每类最低有效 case/pair 数；
- full-history case validity 门槛；
- Recall-only 相对 full-history 的最大任务成功率下降；
- hard constraint、repeat failure 和历史/当前混淆上限；
- required source discovery/get 门槛；
- negative control 的无必要 Recall 上限；
- terminal token、request count、latency 和 cache 成本上限；
- infrastructure failure 处理方式；
- 是否允许以及如何统计合理的多 query 迭代；
- 任何 hard red-line failure；
- aggregate 和 category-level 是否必须同时通过。

实际 calibration 在修正无效 fixture 后得到：full-history 10/10、swap-only 10/10、Recall-only
9/10、主动 Recall 9/10、三类 negative unnecessary Recall 0/3。随后、且在 holdout 开始前冻结：

| 门槛 | 冻结值 |
| --- | ---: |
| full-history task success | >= 0.95 |
| swap-only task success | >= 0.95 |
| Recall-only task success | >= 0.90 |
| Recall-only active Recall | >= 0.90 |
| search -> get success | >= 0.30 |
| 任一反事实组 task success | >= 2/3 |
| invalid Recall / Recall-only trial | <= 0.20 |
| negative unnecessary Recall | <= 1/3 |
| Recall-only / full-history token ratio | <= 3.0 |
| Recall-only / full-history latency ratio | <= 3.0 |
| cache accounting | 每个 trial 必须存在 hit/miss |
| resolved model identity | 全部请求只能出现一个值 |

policy hash 为
`77ca611594d4e9b7b5a597a3a33e35fcaaffae284dc2ac9953ce9a63cce1c009`。这些值在
holdout 前已经写入代码，holdout 期间没有改 case、grader 或门槛。

### 10.3 通过与失败的含义

通过表示：在 suite/policy 覆盖的 workload、已解析 provider identity 和准确 Recall behavioral
surface 下，
Recall-only 达到了冻结的相对任务质量与成本门槛。它不表示任意问题、任意语言、任意未来模型
都不会忘记。

失败表示：该 identity 不能自动退休。失败不禁用：

- full-history 正常运行；
- runtime pressure shadow planning；
- 已通过工程门禁时的自动或手动 swap-only；
- 手动 `/compact retire`；
- 用户显式使用 Recall。

如果失败集中在稳定、现实且可复现的“工作状态导航”缺口，才把证据交给 I5；如果失败来自题目、
literal search 锚点或 system contract，应先修对应层并发布新 suite/version，不能用 checkpoint
掩盖评测问题。

## 十一、DeepSeek floor 与资格身份

### 11.1 为什么没有给每个 workspace/profile 各跑一份资格

原方案要求 exact profile/snapshot/system-prompt 组合逐一过门。真实配置检查后发现 provider 返回的
resolved identity 是 `deepseek-v4-flash`，但没有更细的 immutable snapshot ID；system prompt 又
包含 workspace path。把这些字段机械地 exact-match，会让同一个已验证 runtime 仅因临时路径不同
就永远不能启用，属于没有实际安全收益的苛刻门槛。

本轮按用户明确选择采用 capability floor：用当前配置中能力相对普通的
`deepseek-v4-flash` 做行为下限；它在冻结 holdout 通过后，当前已配置的高级 profile 继承资格。
无 profile 的 env-only 模式仍保持 automation off。未来若加入能力低于该 floor 的 profile，必须
发布新 floor policy 或把它显式排除，不能无条件沿用。

### 11.2 真正绑定的身份

checked-in qualification 绑定：

- manifest version/hash；
- deterministic grader version；
- token-long fixture version；
- frozen policy version/hash；
- positive/negative holdout report hash；
- Recall contract 文本 hash；
- model-visible Recall definition hash；
- qualification 中所有真实响应的唯一 resolved model identity。

stream adapter 会保留并校验每个 chunk 的 `model` 字段；同一 stream 出现冲突 identity 立即
fast-fail。qualification 观察到的唯一值是 `deepseek-v4-flash`。

### 11.3 文件与 runtime gate

`qualify:i4-active-recall` 读取两份 holdout report，校验冻结形状并用临时文件加 rename 生成
`0600` JSON。文件不含 API key、base URL、prompt/reasoning 或 Recall 正文。

runtime 不在启动时扫描任意本地目录猜资格，而是使用 checked-in qualification 的 bounded hash
和 aggregate。测试重新计算两份 report hash，保证编译门禁不能与证据悄悄分叉。当前 surface 的
Recall contract 或 Recall definition 任一漂移，自动 swap/retirement 都关闭；手动路径不受影响。

## 十二、两道独立自动化门禁

### 12.1 自动 swap-only 工程门禁

自动 swap-only 不移除 user/assistant 前缀，也保留每条换出 observation 的 source/hash
placeholder，因此不依赖 I4 的主动 Recall 分数。但它必须通过：

1. 相同 snapshot 得到相同 candidate set、override、plan hash 和 token projection。
2. 只处理 allowlist 中已关闭 frame 的大 observation，不切开 protocol frame。
3. revision 本身零 model request、零 tool execution。
4. candidate prepared request 协议合法，raw/guarded tokens 严格下降。
5. COMMIT 前 fault 保持旧 revision；COMMIT 后 fault 保留新 durable truth 并 fault runtime。
6. 首次 rewrite 的 cache miss 与随后 append 的 cache hit/miss 有真实 provider 数据。
7. 真实 profile 的成本和 latency 低于冻结工程 policy。
8. pressure 下每个 base revision 最多提交一次 swap，不在阈值附近循环重编译。

通过该门禁可以生成 `automaticSwapOnly=true`，即使主动 Recall qualification 失败也不撤销。

### 12.2 自动 prefix retirement 行为门禁

`automaticPrefixRetirement=true` 必须同时满足：

- `automaticSwapOnly=true`；
- DeepSeek floor qualification 通过，provider response/chunk 只出现一个 resolved model identity；
- full-history validity 和全部 category coverage 通过；
- Recall-only 相对 full-history 的任务质量通过冻结 policy；
- source discovery/get、约束遵守、旧失败防重复、历史/当前版本区分通过；
- unnecessary Recall、token、latency 和 cache 成本通过；
- Recall contract/definition、suite、grader、fixture、policy 和 report hash 全部精确匹配。

任一条件不满足时，只关闭自动 prefix retirement，不删除既有 session、不改 active revision，也不
禁用手动 `/compact retire`。

## 十三、production 自动 maintenance 流程

### 13.1 安全边界

I4 v1 只在两个边界尝试自动 maintenance：

- turn 的 terminal event、canonical commit 和 Agent Skill settlement 全部完成之后，
  RuntimeSession 返回 `ready` 之前；
- `/resume` 完成 recovery、surface refresh 和 skill rebind 之后，接受新 user prompt 之前。

不在以下边界提交：

- iteration 内 model request 之前；
- assistant tool calls 尚未全部补齐时；
- Write/Edit/Bash/MCP/Web 或其他工具正在执行时；
- user turn 已开始但尚未 terminal commit 时；
- session faulted/dispose 中；
- 手动 compact 或另一个 automatic revision 正在运行时。

若一个超大新 user prompt 在此前没有 pressure 的 session 中直接触发 hard preflight，I4 v1 仍
fast-fail，不先持久化 prompt、不自动重试 turn。用户可以先执行手动 compact；后续若需要 admission
rescue，单独设计，不在 I4 偷偷扩大 mutation 边界。

### 13.2 调度阶梯

```text
closed current snapshot
  -> rebuild committed request and measure
  -> below 80% trigger: no-op
  -> automatic swap-only not requested/qualified: keep shadow-only
  -> replan swap from current snapshot
  -> commit at most one swap revision
  -> rebuild and remeasure
  -> at/below 30% target: stop
  -> automatic retirement not requested/qualified: stop, report manual retirement available
  -> replan prefix retirement from new current snapshot
  -> commit at most one retirement revision
  -> rebuild, validate, remeasure
  -> return ready
```

调度器不得把 iteration 中记录的 shadow plan 直接交给 transaction。shadow event 只提供候选和
收益诊断；automatic maintenance 必须重新加载 revision、surface、canonical tail、active overrides、
closed turn boundaries、tool definitions 和 measured correction factor。

一次 maintenance cycle 最多提交一个 swap revision 和一个 retirement revision，不用 while-loop
持续追 target。若 retirement 仍报告 `retirement_floor`，保留结果并让 hard preflight 在必要时明确
报告不可压缩地板；不能生成 checkpoint 或静默删除 suffix。

### 13.3 RuntimeSession 状态

实现采用显式 `maintaining_context` 状态，与用户主动触发的 `compacting` 分开；它保证：

- `executeTurn()`、手动 compact、session switch 和 dispose 不能并发创建第二个 revision；
- terminal response 可以先进入 TUI projection，但 `executeTurn()` promise 在 maintenance 完成后
  才 settle，避免用户立即开始并发 turn；
- one-shot 同样等待 maintenance 完成后退出，确保 committed revision 已 flush；
- background shell task 生命周期不由 context maintenance 停止或重启；
- surface/skill settlement 先完成，qualification 再针对最终 surface 匹配。

### 13.4 失败语义

| 失败点 | active revision | session 行为 |
| --- | --- | --- |
| qualification 缺失或不匹配 | 不变 | 不尝试自动化，展示 bounded reason |
| snapshot/plan 无候选或低于 target | 不变 | 正常返回 ready |
| COMMIT 前 stale/validation/transaction rollback | 旧 revision | 记录失败；canonical/storage invariant 错误时 fault，否则本 base revision 不重复尝试 |
| COMMIT 后 event/activation 失败 | 新 revision 是 durable truth | runtime fault；resume 从新 revision 恢复 |
| required event sink 或 SessionStore 故障 | 依现有 transaction 边界 | fault，不继续下一工具或模型请求 |

每个 maintenance cycle 对每种 strategy 最多尝试一次，不在同一 cycle 内循环重试。下一次 completed
turn 或 resume 只从最新 snapshot 重新规划；失败的旧 plan 不会被复用。

## 十四、事件、状态展示与隐私

### 14.1 revision events

现有 `context.revision.started/finished/failed` 扩展：

```ts
reason: "manual" | "runtime_pressure";
```

automatic event 允许包含：

- strategy、policy version 和 bounded qualification outcome；
- base/new revision number；
- tokens before/after/target；
- candidate/retired counts；
- duration 分项；
- cache aggregate；
- bounded `qualificationId`（当前为 `deepseek-v4-flash-floor-v1`），而不是文件路径或 report。

禁止包含：

- case prompt、用户历史正文、Recall query 或 result；
- source ID、文件路径、URL、command、diff 或 provider raw response；
- API key、qualification 文件路径或完整 report；
- model reasoning。

评测 detailed report 的 fixture 全为 synthetic，因此保存 case ID、grade code、synthetic search
query、命中 turn number、usage 和 aggregate；不保存 source ID、Recall 正文、reasoning 或 provider
raw response。真实用户历史不进入该 runner。

### 14.2 状态诊断

现有 `/status` 是本地 context usage 面板，I4 不把完整 qualification report 塞进这个常用界面。
automatic revision 发生时，既有 event/stdout 路径显示 `reason=runtime_pressure`、strategy、
outcome、revision 和 bounded qualification ID；未触发 pressure 时不制造常驻 UI 噪声。完整
identity 只在本地 qualification report 中查看，普通 TUI 不展示内部 UUID、完整 hash 或文件路径。

## 十五、测试与真实评测方案

### 15.1 manifest、fixture 与 grader 单元测试

- 缺失字段、重复 ID、孤立 pair、不同 terminal prompt fast-fail。
- 正例无 source、negative control 有 source、source 位于 protected suffix fast-fail。
- oracle 路径逃逸和宽泛 forbidden command pattern fast-fail。
- deterministic clock/ID 下重复构造得到相同 logical history、suite hash 和 oracle mapping。
- grader 正确区分 task failure、wrong source、repeat failure、historical/current confusion 和 infra
  failure。
- grader 不读取模型自由文本做语义判断。

### 15.2 三视图集成测试

- full-history payload 包含 required source 原文。
- swap-only 对合格 observation 只保留正确 placeholder/source/hash，`keepFromOrdinal` 不变。
- Recall-only required source 全部早于 `keepFromOrdinal`，payload 不含原文、placeholder 或 skeleton。
- 三种模式 canonical history、FTS source/content/hash 和 terminal prompt 一致。
- Recall-only search/get 命中与 full-history 相同 source/hash。
- counterfactual pair 的 workspace 和 terminal prompt 相同，oracle 结果不同。
- negative control 不因 fixture filler 意外获得一个 hidden retired dependency。

### 15.3 qualification identity

- manifest、grader、fixture、policy、正负 report、Recall contract/definition hash 任一变化均不匹配。
- stream chunks 出现不同 resolved model identity 时 adapter fast-fail。
- 无 profile 正常启动为 manual；Recall behavioral surface 漂移时 automation off。
- qualification 原子写、`0600`、report hash 和 frozen shape 校验。

### 15.4 automatic runtime

- pressure normal 时零 planner commit、零额外 model request。
- qualified pressure 先提交最多一个 swap；仍高于 target 且 retirement qualified 时最多再提交一个
  retirement。
- retirement 未 qualified 时保持 swap-only，不偷偷提交 prefix revision。
- automatic path 重新规划，不提交 stale shadow plan。
- completed turn commit 与 skill settlement 后只在合法 idle boundary 运行；failed/cancelled turn 不为
  maintenance 扩大副作用。
- open frame、工具执行、手动 compact、session switch 和 dispose 并发被拒绝。
- fault matrix 覆盖 swap 与 retirement 的 snapshot/plan/validate/commit/activate。
- resume 恢复 COMMIT 后 revision，并重新匹配当前 qualification/surface。
- qualification 失效后 manual `/compact` 与 `/compact retire` 仍正常。

### 15.5 真实 provider 与 PTY

- calibration 和 holdout qualification 使用目标 profile 的真实 streaming 配置。
- adapter 验证所有 response/chunk 的 resolved model identity 一致。
- usage 完整，cache hit/miss、reasoning tokens、request count 和 wall latency 进入 report。
- revision 自身仍是零 provider request；额外请求只来自 terminal task 和 Recall tool loop。
- 真实 PTY 验证 qualified profile 的普通 turn、命令交互与退出未回归；pressure revision 的 bounded
  reason 由 runtime integration/fault tests 验证。
- `/resume` 后重新测量 pressure 并重新匹配当前 Recall surface。
- `bun run check`、formal long-session benchmark、Recall benchmark、automatic fault matrix、真实 PTY
  和 provider smoke 全部通过。

## 十六、实施顺序

### I4-A：评测基础设施与 calibration

1. 落地 case manifest、fixture builder、tool sandbox、recorder 和 deterministic grader。
2. 建立五类 counterfactual cases 与 negative controls；人工审核 prompt 有效性。
3. 建立三视图 runner，先用 fake model 验证 source/payload/oracle 不变量。
4. 用目标 profile 执行 calibration，记录 full-history 上限、Recall-only delta 和成本分布。
5. 删除或修正无效题并保留变更原因；冻结 suite、grader 和 evaluation policy v1。
6. 将 calibration 真实结果与具体数值门槛写回本文；此时仍不启用 automatic commit。

### I4-B：holdout qualification 与 guarded automation

1. 在未参与 calibration 的 holdout cases 上执行固定三次三视图 qualification。
2. 生成 report 和 machine-readable qualification；失败也保留完整 aggregate 结果。
3. 增加 stream resolved identity 验证、DeepSeek floor qualification、report hash 校验和 bounded
   revision events。
4. 先接 automatic swap-only，复用现有 ContextManager transaction 与 fault matrix。
5. 只有 qualification 明确通过时再接 automatic prefix retirement。
6. 完成真实 cache、PTY、resume、surface drift 和 crash/fault 验证。
7. 把最终通过/失败 profile、门槛、成本和 runtime 状态写回本文与 roadmap。

I4-A 与 I4-B 必须独立交付。不能在 calibration 尚未完成时预埋一个默认返回 `true` 的 gate，也
不能把本地开发用 override 暴露为普通用户的 `--force-auto-retire`。

## 十七、验收门槛

I4 只有同时满足以下条件才算完成：

1. qualification suite 的每个 prompt 都满足对象、动作、验收和唯一历史缺口契约。
2. 五类场景均有反事实 pair，terminal prompt 相同而历史事实和正确结果不同。
3. 每个有效 case 的 full-history 基线达到冻结 validity 门槛；无效 case 不进入比较。
4. 三种视图 canonical/workspace/prompt 可比，Recall-only required evidence 确实退出 payload。
5. grader 完全确定性，不使用模型 judge 或事后主观打分。
6. Recall 调用、source discovery/get、任务结果、无效检索、旧失败、版本混淆、token、latency 和
   cache 指标定义清楚且有固定 denominator。
7. calibration 与 holdout 分离，具体数值门槛在 holdout 前冻结并带 version/hash。
8. automatic swap-only 和 automatic prefix retirement 资格彼此独立、机器可读；行为资格生成前
   retirement 默认关闭。
9. 自动 retirement 只在 DeepSeek floor qualification、唯一 resolved identity、Recall
   contract/definition、suite/grader/fixture/policy/report hash 一致时生效。
10. automatic maintenance 只在 idle boundary 重新规划，每 cycle 最多一个 swap 和一个
    retirement revision，不提交 stale shadow plan。
11. COMMIT 前失败保留旧 active revision；COMMIT 后失败保留新 durable revision 并按现有语义
    fault/resume。
12. 无 profile、Recall surface 漂移或未来低于 floor 的 profile 保持手动 retirement；不能静默
    假装已 qualified。
13. I4 不生成 checkpoint、summary、embedding 或 model-assisted selection。
14. 全部 component/integration/fault/benchmark/PTY/真实 provider 验证通过，并把实际结果写回
    本文和 roadmap。

完成 I4 不要求所有 profile 都逐个重复评测。当前 DeepSeek floor holdout 已通过；在它通过之前，
runtime pressure 确实只做 shadow planning。未来 qualification 失效时自动路径退回 manual，而不是
靠 fallback 假装 qualified。

## 十八、实施结果

### 18.1 calibration 与 fixture 修正

首次 pre-calibration 的 full-history/swap-only 都是 10/10，但 Recall-only 只有 3/10。轨迹证明
fixture 把内部 `cal-...-a/b` case ID 写进每个 filler 和 payload，普通模型会围绕这个无意义 ID
搜索并幻觉答案；system/tool 文案也没有说明 search 是短字面锚点检索。这是 fixture/affordance
问题，不能拿来处罚模型。

修正后删除所有 model-visible case ID，只保留无任务事实的 12 KiB payload，并在 Recall contract
与 tool description 中说明先用 path/project/command/error 等短锚点。没有修改 FTS、source 或
grader。第二次 calibration 结果：

| 视图 | task success | provider requests | total tokens | latency |
| --- | ---: | ---: | ---: | ---: |
| full-history | 10/10 | 18 | 582,296 | 30.13s |
| swap-only | 10/10 | 19 | 517,852 | 32.17s |
| Recall-only retirement | 9/10 | 25 | 672,287 | 44.42s |

Recall-only 主动 Recall 9/10、search -> get 4/10；唯一失败是一个隐式 serialization variant
完全没有查历史。三个 calibration negative controls 全部完成，unnecessary Recall 为 0/3。随后
冻结第 10.2 节的 policy，未再修改 case、grader 或门槛。

### 18.2 独立 holdout qualification

holdout 有五类、每类一组 A/B 反事实，共 10 个正例；每个正例在三视图各跑 3 次，共 90 个
trial。另有三个 negative control 在退休视图各跑 3 次。manifest hash 为
`093679e221e02b71ba5acf54693faa7a299d05dd25f6faabbeb84645d4db4d2d`。

| 指标 | 实测 | 门槛 |
| --- | ---: | ---: |
| full-history task success | 30/30 = 100% | >= 95% |
| swap-only task success | 30/30 = 100% | >= 95% |
| Recall-only task success | 29/30 = 96.67% | >= 90% |
| Recall-only active Recall | 29/30 = 96.67% | >= 90% |
| search -> get success | 9/30 = 30% | >= 30% |
| 最差反事实组 task success | 5/6 = 83.33% | >= 2/3 |
| invalid Recall / retirement trial | 1/30 = 3.33% | <= 20% |
| negative unnecessary Recall | 0/9 = 0% | <= 1/3 |
| token ratio，retirement / full | 1.1555x | <= 3x |
| latency ratio，retirement / full | 1.365x | <= 3x |

唯一 task failure 仍是隐式 checksum variant 的一次 trial：模型未调用 Recall，猜成另一个常见
算法；同一反事实组其余 5/5 通过。一次 invalid Recall 是正确 search 后发出无效 get，但模型从
search excerpt 得到正确命令，task 仍通过。没有 repeat-failure 或 historical/current 混淆失败。

正例 provider 明细：

| 视图 | requests | total tokens | cache hit / miss | latency |
| --- | ---: | ---: | ---: | ---: |
| full-history | 61 | 1,976,504 | 999,040 / 971,536 | 108.53s |
| swap-only | 54 | 1,474,199 | 652,288 / 816,181 | 95.20s |
| Recall-only retirement | 85 | 2,283,829 | 1,462,016 / 812,779 | 148.15s |

全部真实 response/chunk 只解析到 `deepseek-v4-flash`。qualification 的 12 道机器门全部通过；
详细证据见
[`context-revision-i4-holdout-deepseek-v4-flash.json`](context-revision-i4-holdout-deepseek-v4-flash.json)、
[`context-revision-i4-holdout-negative-deepseek-v4-flash.json`](context-revision-i4-holdout-negative-deepseek-v4-flash.json)
和
[`context-revision-i4-qualification-deepseek-v4-flash.json`](context-revision-i4-qualification-deepseek-v4-flash.json)。

### 18.3 production automation

- `RuntimeSession` 在 pressured iteration 只记 maintenance 请求；当前 turn terminal commit 和 skill
  settlement 完成且结果为 completed 后，才从最新 snapshot 重新规划；failed/cancelled turn 不触发
  revision mutation。
- 每个 cycle 最多一个 automatic swap；只有仍高于 target 且行为资格通过时，才再做一个 prefix
  retirement。resume 的 initial snapshot 已处于 pressure 时也走同一 coordinator。
- automatic 与 manual 共用 `ContextManager` transaction；revision 自身零 provider request、零工具
  执行。事件使用 `reason=runtime_pressure` 和 bounded qualification ID。
- pre-commit nonfatal planning failure 记录 bounded failed event 后回到 ready；fatal/COMMIT 后失败沿用
  durable revision 与 runtime fault 语义。
- resume 的初始 snapshot 已处于 pressure 时，在接受新 prompt 前运行同一 coordinator；集成测试验证
  swap 与 retirement 均完成且 provider request 数保持为零。
- checked-in report hash、policy hash、Recall contract 文本 hash 和 Recall definition hash 由测试
  锁定。runner 从当前真实 contract/definition 计算 hash，qualifier 逐项校验冻结的 10 个正例、3 个
  negative、view 与 trial matrix；无 profile 或 Recall surface 漂移时 automation off。
- DeepSeek floor 通过后，当前已配置 profile 的 `automaticSwapOnly` 与
  `automaticPrefixRetirement` 均为 `true`；手动命令保持可用。

当前数据没有形成进入 I5 的稳定证据：30 个 retirement holdout 只有一个“完全没查历史”的随机
失败，五类中另外四类和同组其余 trial 全部通过。I5 checkpoint 继续保持证据驱动、暂不实施。

### 18.4 最终验证

- `bun run check` 通过 typecheck、format、lint、574 项测试（3,657 个断言）和 I3 benchmark
  smoke。
- 50-turn formal long-session benchmark 通过，包含 cancel、resume、Recall、两次 swap、两次
  retirement、payload 退出验证和 revision/provider-request 不变量。
- 10,000-message Recall benchmark 通过；trigram search p50/p95 为 0.19/0.22ms。
- 最终 Recall contract/tool 版本上的真实 `deepseek-v4-flash` provider smoke 通过：退休 revision
  自身没有增加 provider request，模型完成 Recall search -> get 并恢复旧 marker，随后 append
  命中 prompt cache。
- 真实 TUI PTY 使用 `deepseek-v4-flash` 完成普通 turn，精确返回 `I4-PTY-OK`，没有调用工具，
  `/quit` 以状态 0 退出。
