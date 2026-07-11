# 关于《无限上下文》讨论的评论 —— 结合 Tinker 现状

> 本文是对 [`context-research.md`](context-research.md) 的评论。立场：那份讨论的
> 核心思想是对的，且 Tinker 的现有架构恰好已经为它铺好了地基；但按原文的完整
> 蓝图去做会掉进过度工程的坑。真正的亮点机会在于一条原文没有充分展开的路径：
> **确定性的、可逆的换出（swap-out），而不是模型驱动的摘要（summarize）**。

## 一、先说结论

1. 原文最有价值的一句话是：「LLM 不应该拥有长期状态，上下文是外部状态编译出的
   一次性视图」。这个方向判断是对的，值得作为 Tinker 上下文系统的第一性原理。
2. Tinker 当前代码里已经存在这套思想的三块地基（事件日志、raw/observation 分离、
   ContextBuilder 接缝），比大多数从零开始的项目起点好得多。
3. 原文有一个致命的工程盲区没有提：**prompt caching**。逐轮重编译上下文会摧毁
   KV-cache 前缀命中，成本和延迟直接翻数倍。这决定了「Context Compiler」只能
   低频运行（checkpoint 时），不能每个 iteration 都跑。
4. 原文的完整蓝图（四层存储 + 五种检索 + 可信度分层 + 分支隔离 + 因果图）是一个
   多年期研究计划。对个人项目，其中约 20% 的内容能产出 80% 的效果，剩下的应该
   明确列为「以后再说」。

## 二、Tinker 已经拥有的地基（原文没看到，但很关键）

评论一份设计，最重要的是对照现实。逐条看 Tinker 现状：

### 1. Append-only event log 已经是 WAL 了

原文第十二节呼吁「写屏障，像数据库 WAL 一样对关键事件立即持久化」。这在 Tinker
里**已经实现**：`RuntimeSession.append()` 维护严格递增的 `eventSequence`，写入
串行化（`eventTail` 链），写失败会把 session 置为 `faulted` 而不是静默丢失
（`src/agent/runtime-session.ts:463`）。每个事件带完整的
session/turn/iteration/toolCall 身份链，且身份被强校验。

这意味着「compact 是从事件日志重建 snapshot，而不是靠模型回忆」这个原文最核心
的主张，在 Tinker 里不需要新造基础设施——`events.jsonl` 就是那个 event log。

### 2. raw result / observation 分离，就是「页」和「视图」的分离

`ObservationBuilder` 把结构化的 `ToolRawResult`（带 `kind` 判别、sha256、字节数、
行数）渲染成给模型看的文本（`src/observation/observation-builder.ts`）。raw
result 同时被持久化为 `tool.raw_result` 事件。

这是一个被低估的架构决策：**observation 是从 raw result 确定性推导出来的，
所以它是可丢弃的缓存**。原文说「summary 是可丢弃的缓存」，但模型生成的摘要
其实不可丢弃（丢了就再也造不出来）；而 Tinker 的 observation 才真正满足
「可丢弃」——任何时候都能从事件日志里的 raw result 重新渲染，甚至用不同的
详细程度重新渲染。这是后面第四节方案的基础。

### 3. ContextBuilder 是预留好的接缝

`src/agent/context-builder.ts` 现在是 15 行的透传。但它出现在 `runAgent` 每次
调模型的必经之路上（`src/agent/loop.ts:74`）。原文设想的 Context Compiler
有天然的插入点，不需要动 loop 的结构。

### 4. 工具本身就是 page fault handler

原文第五节花了很大篇幅设计 `NEED_CONTEXT` 协议。但对 coding agent 来说，
**Read/Grep/Glob 就是 page-in 原语**——模型遇到不认识的符号时去 grep，这就是
一次语义缺页处理，而且今天的模型已经被训练得很擅长这样做。Tinker 甚至已经有
更进一步的例子：后台 Bash 任务的输出落在磁盘文件里，observation 只给一个
`outputFilePath` 加一句「Use Read on outputFilePath to inspect current
output」——这就是换出到 swap 文件、按需换入的完整闭环，已经在生产路径上跑着。

所以 `need_context` 不必作为独立协议实现。真正缺的只有一类缺页无法用现有工具
处理：**对话历史本身**。被 compact 掉的讨论、早期 turn 的工具结果，模型现在
无处可查。这才是需要新工具的地方（见第四节第 3 步）。

## 三、原文的问题：三个盲区和一处过度设计

### 盲区 1：prompt caching 经济学

这是最大的遗漏。现代 API 的 KV-cache 按前缀命中计价，缓存命中的 token 成本
约为未命中的 1/10。agent loop 每个 iteration 都带着全部历史重新请求，之所以
可行，正是因为消息数组是 append-only 的，前缀几乎全部命中缓存。

原文的运行循环（第十五节）里 `contextManager.assemble()` 每轮重新组装上下文。
如果组装结果的前缀逐轮变化（换出一页、更新一个摘要、调整一段顺序），每轮都是
全价 + 全延迟。**这直接否决了「每轮动态编译」的朴素实现**，并给出一个明确的
工程约束：

> 上下文重编译只能发生在 checkpoint（compact、turn 边界、显式换出）时刻；
> 两次 checkpoint 之间必须保持严格 append-only。

这不是妥协，反而让系统更简单：Context Compiler 变成一个低频批处理组件，
而不是热路径上的实时系统。

### 盲区 2：低估了「协议合法性」约束

OpenAI/Anthropic 协议要求 assistant 的 tool_calls 与后续 tool 消息一一配对。
换出一条 observation 不能直接删消息，只能原位替换内容，否则请求直接报错。
Tinker 最近的 commit（「工具执行失败时保留协议合法的消息历史」）说明项目已经
在这个问题上交过学费——任何换出机制的设计必须把「消息骨架不可变、只有内容
可替换」作为硬约束写进设计文档。

### 盲区 3：模型不配合怎么办

原文正确地指出「LLM 不知道自己缺页」，但给出的解法（要求关键陈述附带
`[symbol://S392]` 式引用）在实践中对指令遵循的要求极高，且会污染输出格式。
更现实的路径是降低期望：不追求模型自证引用，而是**让换出后的占位文本本身
携带足够的找回路径**（文件路径 + sha256 + 行数 + 「内容已换出，需要时重新
Read」）。占位文本就是地址，模型顺着地址走工具就行——这利用的是模型已有的
工具使用能力，不需要新的行为约定。

### 过度设计：ContextPage 的元数据

`confidence: number`、`validUntil`、五种检索、可信度五层……这些字段没有任何
系统知道该怎么诚实地填。填不准的元数据比没有更糟，因为下游会信以为真。
第一版应该只有三个不会说谎的字段：**来源指针（路径/事件 ID）、内容哈希、
时间戳**。其余等真的撞上需求再加。

## 四、给 Tinker 的落地路径

结合 [`agent-runtime-roadmap.md`](agent-runtime-roadmap.md) 的阶段四（context
统计）和阶段五（compaction），我建议的顺序和 roadmap 一致，但阶段五的做法
应该和「主流 /compact」分道扬镳：

### 第 1 步：度量（roadmap 阶段四，不变）

没有 token 计量就没有换出策略。在 `ContextBuilder.build()` 里统计每条消息的
token 估值，按消息类型（system / user / assistant / tool，以及 tool 按 `kind`
细分）聚合，暴露给 TUI。这一步同时会产出一个副产品：**你会第一次看清上下文
到底被什么吃掉了**。我的预判是大头在 Read 和 Grep 的 observation，这正好是
第 2 步的目标。

### 第 2 步：确定性换出（这是亮点所在，主流工具没有做）

主流 `/compact` 的做法是让模型写一段摘要替换历史——有损、不可逆、可能失真。
Tinker 可以做一件更好且更便宜的事：

> 当上下文有压力时，把旧的 tool observation **原位替换**为从 raw result
> 确定性生成的占位摘要，例如：
> `[已换出] Read src/foo.ts (sha256=abc123, 214 行)。文件仍在工作区，需要时重新 Read。`

关键性质：

- **零模型调用**，纯字符串操作，不花钱、不失真、无幻觉风险；
- **可逆**：raw result 在事件日志里，工作区文件还在磁盘上，任何被换出的内容
  都有两条找回路径；
- **协议合法**：消息骨架不动，只替换 content；
- **缓存友好**：换出发生时前缀失效一次，之后继续 append-only。

一个自然的优先换出顺序：同一文件被多次 Read 时的旧版本（sha256 已经不同，
本来就是过期信息，换出它反而**减少**了误导）→ 大体积 Grep/Glob 结果 →
已结束的 Bash preview。注意这些都不需要判断「语义上是否还重要」——判断依据
全是机械的（是否过期、体积、距今轮数），这正是它可靠的原因。

### 第 3 步：`recall` 工具（对话历史的 page-in）

一个小工具：按关键词/时间范围检索本 session 的 `events.jsonl`（后续可加
FTS），返回匹配的事件摘要和事件 ID，支持按 ID 取回完整 raw result。有了它，
第 2 步的换出和未来 compact 的信息丢失都从「遗忘」降级为「冷存储」。这也是
原文第十一节「区分忘记和不存在」的最小实现：检索返回空才能说「没有」。

### 第 4 步：结构化 checkpoint（roadmap 阶段五的差异化做法）

`/compact` 时不让模型「自由发挥写小作文」，而是从事件日志**编译**出结构化
capsule：本 turn 序列里改过哪些文件（FILE_EDITED 事件都在）、用户原话提出过
哪些约束（user 消息原文摘录，不改写）、哪些命令/测试跑过、结果如何（bash
事件都在）。模型摘要只负责填「当前意图和未决问题」这一小块非结构化的空隙。
配合第 3 步，compact 错了也不致命——原文最后一段说的「compact 从遗书变成
可重放的 checkpoint」，到这一步就真正成立了。

### 明确推迟的东西

向量检索、调用图/AST 索引、可信度分层、分支 memory namespace、子 agent
capsule 协议。不是因为它们不对，而是因为前四步没做完之前，它们没有可依附的
骨架；而前四步做完之后，可能会发现其中一半不再需要。

## 五、关于「亮点」的定位建议

如果要把这件事做成 Tinker 的招牌，我建议对外的叙事不要用「无限上下文」——
这个词已经被营销用滥，且承诺了无法验证的东西。更诚实也更锋利的表述是：

> **Tinker 从不遗忘，只会换出。** 任何被移出上下文窗口的信息都保留确定性的
> 找回路径（事件日志 + 工作区 + 占位指针），compaction 是可逆操作。

这个主张的每个字都可以写测试验证：跑一个 50+ turn 的长任务，中间强制多次
compact，然后问 agent「第 3 个 turn 里那个测试为什么失败」「用户最开始提了
什么约束」，检查它能否通过 recall/Read 找回原文而不是编造。这种可验证性本身
就是和其他 coding agent 的差异点——它们的 compact 之后，这类问题的答案只剩
运气。

## 六、总结

原文的思想框架（event log 为本、上下文即视图、缺页协议、来源指针）值得全盘
吸收为设计原则；它的实施蓝图值得砍掉四分之三。Tinker 的幸运之处在于：严格的
事件日志、raw/observation 分离、ContextBuilder 接缝这三件事已经存在，使得
「确定性换出 + recall + 编译式 checkpoint」这条差异化路径的增量成本很低。
最先要补的一课不在原文里，而在账单上：prompt cache 决定了这套系统的节拍——
**平时 append-only，checkpoint 时才重编译**。
