我的问题：
```
你了解现在coding agent都有/compact上下文压缩能力对吧，我在思考设计一个“无限”上下文，其实就是一个良好的长上下文管理，其实我有一些模糊的思路，比如1MB的内存其实可以完成100M数据的排序，再比如系统SWAP分页，比如只要我们把所有历史持久化，总有办法检索出合适的context，现在很多模型窗口都1M了，基础是够的，总有办法交换到合适的context，除非真的极端情况，做某事的必要条件信息都超过1M了，这种情况很少，因为大任务必然能拆解。你有啥思路？
```
AI的回复：
`````
我很认同你的方向。所谓“无限上下文”，本质上不应该是让模型一次看到无限多内容，而是：

> **给模型一个近乎无限的逻辑地址空间，同时只把当前工作集映射进有限的物理上下文。**

不过相比操作系统虚拟内存，它更难的一点是：计算机知道自己访问了哪个地址，LLM 往往不知道自己忘了什么，甚至会用幻觉填补缺失信息。

所以真正需要设计的不是普通 `/compact`，而是一套 **Agent Context OS**。

---

## 一、最关键的思想：对话历史不等于状态

现在很多 `/compact` 的基本模式是：

```text
旧对话
  ↓
生成一段摘要
  ↓
摘要 + 最近对话继续运行
```

这只能算“压缩聊天记录”。

更理想的模型应该是：

```text
完整事件日志 + 项目真实状态
             ↓
       Context Compiler
             ↓
       当前任务所需视图
             ↓
             LLM
```

也就是说：

> **LLM 不应该拥有长期状态。LLM 每次只消费由外部状态编译出来的一次性上下文视图。**

类似数据库：

* 历史记录是 event log
* 当前项目状态是 materialized state
* 上下文是针对本次任务生成的 materialized view
* `/compact` 是 checkpoint，不是把旧世界销毁掉

这是我认为最根本的变化。

---

# 二、可以直接套用虚拟内存的模型

我会把上下文分成几层。

## L0：Kernel Context

始终驻留，不允许被换出：

* 系统规则
* 用户核心目标
* 当前任务定义
* 最重要的不变量
* 工具协议
* 如何请求缺失上下文

例如：

```text
目标：修复支付回调重复入账问题

不可破坏的不变量：
1. 同一 transaction_id 只能入账一次
2. 已成功订单不能回退到 pending
3. 数据库迁移必须向后兼容

当前任务：
定位重复入账的竞态条件
```

这部分可能只有几千 token。

---

## L1：Active Working Set

当前真正工作的材料：

* 正在修改的文件
* 相关函数和类型定义
* 当前错误日志
* 当前计划
* 最近几轮推理和工具结果
* 直接依赖的测试

类似进程的物理内存。

即使模型有 1M 上下文，我也未必会让 L1 长期占满 1M。因为上下文越大：

* 成本越高
* 延迟越大
* 注意力越分散
* 错误信息和过期信息越容易干扰
* “lost in the middle”仍可能存在

可能 50K～200K 才是更合理的常态工作集。

---

## L2：Warm Context

已经结构化、很可能近期再次使用，但暂时不全部放进 prompt：

* 当前子系统架构
* 最近做出的关键决策
* 相关模块的 repo map
* 前几个步骤产生的中间结果
* 相邻任务的结果
* 已读文件的摘要与引用

L2 中保留的是摘要、索引和地址，原文随时可以换入。

---

## L3：Cold Store

理论上无限：

* 所有历史消息
* 所有工具调用结果
* 所有历史文件版本
* 完整日志
* Git commit 和 diff
* 被放弃的方案
* 测试运行记录
* 外部文档
* Agent 的每次决策

可以是 SQLite、对象存储、Git、搜索索引和向量库的组合。

---

# 三、“页”不能按固定 token 切

操作系统可以每 4KB 分页，因为字节地址是确定的。

LLM 的上下文页最好是语义对象，而不是：

```text
第 10000～12000 token
```

更适合作为 page 的东西包括：

* 一个函数或类
* 一组相关类型
* 一条架构决策
* 一次测试失败
* 一个用户约束
* 一个任务节点
* 一段完整讨论
* 一个 Git diff
* 一次实验及其结论
* 一个文件的特定版本

例如：

```ts
interface ContextPage {
  id: string
  type:
    | "source_symbol"
    | "decision"
    | "constraint"
    | "task"
    | "tool_result"
    | "conversation_episode"
    | "artifact"
    | "test_result"

  summary: string
  sourceRefs: SourceRef[]
  version?: string
  contentHash: string

  dependencies: string[]
  supersedes?: string[]
  branchId?: string

  confidence: number
  createdAt: string
  validUntil?: string
}
```

换出时保留：

* page ID
* 极短摘要
* 来源
* 版本
* 依赖关系

需要时再加载原始内容。

---

# 四、`/compact` 应该是“状态编译”，不是普通摘要

一个好的 compact 结果不应该是一篇自然语言小作文，而应该是结构化 checkpoint。

例如：

```yaml
objective:
  修复支付回调重复入账问题

current_status:
  已确认 webhook 可能并发执行
  service 层目前没有事务内幂等保护

invariants:
  - transaction_id 必须全局唯一入账
  - 成功订单状态不可回退
  - 不修改现有 webhook API

accepted_decisions:
  - decision: 使用数据库唯一约束作为最终幂等屏障
    rationale: 应用层锁无法覆盖多实例
    source: decision://D42

rejected_approaches:
  - approach: 进程内 mutex
    reason: 多实例部署下无效
    source: experiment://E17

active_files:
  - path: src/payment/webhook.ts
    hash: abc123
    relevant_symbols:
      - processWebhook
      - creditAccount

open_questions:
  - 旧数据是否存在重复 transaction_id
  - 当前数据库是否支持在线创建唯一索引

tests:
  passed:
    - payment-webhook-basic
  failing:
    - concurrent-webhook-idempotency

next_actions:
  - 检查 transaction 表结构
  - 实现并发测试
  - 设计兼容旧数据的迁移方案
```

这里有几个原则：

### 原始事实永远不被摘要替代

摘要只是缓存，不是 source of truth。

### 关键约束尽量原样保存

尤其是：

* 用户明确要求
* API 契约
* 错误信息
* 数值
* 文件名
* 命令
* 测试结果

这些内容不应该被“意思差不多地总结”。

### 所有结论都带来源指针

模型看到：

```text
用户不允许改变 API
```

还应该能看到：

```text
source: message://M182
```

关键操作前可以重新读取原文。

---

# 五、真正困难的是 Page Fault

CPU 访问一个不在内存中的地址，操作系统立刻知道发生了缺页。

LLM 不知道。

它可能遇到一个陌生函数，然后：

1. 请求读取函数定义；
2. 根据名字猜测函数行为；
3. 根本没有意识到自己缺信息。

后两种很危险。

所以我会把“缺页”设计成一等协议：

```text
NEED_CONTEXT {
  query: "PaymentService.creditAccount 的事务边界和调用方"
  reason: "需要判断唯一约束异常是否会导致整个订单事务回滚"
  expected_types: ["source_symbol", "call_graph", "test_result"]
}
```

Context Manager 接收到后：

1. 搜索符号定义；
2. 获取调用图；
3. 找相关测试；
4. 加载必要依赖；
5. 重新执行当前推理步骤。

关键是要训练或约束模型：

> 对项目私有事实，没有来源就不能猜；缺少来源必须触发 context fault。

甚至可以要求模型对关键陈述附带内部引用：

```text
PaymentService.creditAccount 当前不在事务中。[symbol://S392]
```

无法给出引用，就说明它可能在凭印象工作。

---

# 六、检索不能只有向量搜索

“只要把所有历史持久化，再向量检索”是必要条件，但不够。

Coding Agent 至少需要几类检索同时工作。

## 1. 精确检索

适合：

* 函数名
* 文件路径
* 错误字符串
* commit hash
* 类型名
* API 名称

代码场景里，精确搜索经常比 embedding 更重要。

## 2. 语义检索

适合：

* “之前为什么没有用 Redis 锁”
* “和订单幂等有关的讨论”
* “用户对兼容性的要求”

## 3. 图检索

围绕当前对象展开依赖：

```text
当前函数
  → 调用的函数
  → 使用的类型
  → 相关测试
  → 修改过它的决策
  → 最近的错误日志
```

对于代码，AST、LSP、调用图、import 图通常比纯向量库可靠。

## 4. 时间与版本检索

需要区分：

* 当前版本
* 已废弃版本
* 当前分支
* 另一条实验分支
* 修改前状态
* 修改后状态

否则 Agent 很容易把两个时间线混在一起。

## 5. 因果检索

不仅找“相似内容”，还要找：

* 这个决定是因为什么产生的？
* 哪个实验否定了某个方案？
* 哪个用户要求导致了这个限制？
* 这个修改影响了哪些后续任务？

---

# 七、检索目标不应是“相关信息”，而是“充分信息”

普通 RAG 的目标通常是：

> 找到和问题最相关的几个 chunk。

Agent 更需要的是：

> 找到完成当前操作所需的最小充分上下文。

例如模型要修改一个函数，光加载函数本身并不充分，还可能需要：

* 参数类型
* 返回值消费者
* 不变量
* 相关测试
* 数据库约束
* 用户之前否决过的方案
* 当前分支中尚未提交的修改

所以检索之后还要做 dependency closure：

```text
目标函数
  + 直接类型
  + 关键调用方
  + 相关测试
  + 当前任务不变量
  + 最近变更
```

这更像编译器链接依赖，而不是普通搜索。

---

# 八、任务拆解是实现“无限”的核心

你说“大任务必然能拆解”，我基本同意，但要加一个条件：

> 子任务必须有明确的输入输出契约，否则只是把混乱分散到多个上下文里。

每个子任务应该像一个独立进程，有自己的 context capsule：

```yaml
task:
  分析 webhook 并发问题

inputs:
  - webhook handler
  - payment service
  - transaction schema

constraints:
  - 不修改外部 API
  - 多实例部署

expected_output:
  - 竞态发生路径
  - 可复现测试
  - 至少两个修复方案
  - 推荐方案及理由
```

子 Agent 返回的不是几万 token 推理过程，而是一个 typed result：

```yaml
result:
  竞态发生在查询 transaction 后、插入记录前

evidence:
  - symbol://S31
  - test://T98

assumptions:
  - 数据库隔离级别为 READ COMMITTED

recommended_change:
  添加 transaction_id 唯一约束，并捕获冲突

changed_artifacts:
  - tests/payment-concurrency.test.ts

verification:
  - 100 次并发测试通过

unresolved:
  - 线上旧数据是否有重复值
```

父任务只加载这个接口结果，必要时再下钻读取子任务原始历史。

这和软件工程本身非常相似：

* 函数隐藏实现细节
* 模块暴露接口
* 子 Agent 隐藏推理 trace
* 父 Agent 只消费验证后的结果

---

# 九、对于 Coding Agent，代码仓库本身就是外部内存

我不会试图把整个 repo 塞进上下文。

Agent 应主要操作：

* repo map
* symbol index
* AST
* definition/reference
* call graph
* Git diff
* 测试结果
* 编译器错误
* runtime trace

例如当前目标是修改 `processWebhook`，上下文管理器可以自动预取：

```text
processWebhook 定义
processWebhook 调用的项目内函数
processWebhook 使用的类型
引用 processWebhook 的测试
当前 Git diff
最近一次失败日志
相关架构决策
```

而不是把整个 `src/` 文件夹塞进去。

另外还应记录一个 edit ledger：

```yaml
edit:
  file: src/payment/webhook.ts
  symbol: processWebhook
  reason: 防止并发重复入账
  related_task: task://T120
  tests:
    - concurrent-webhook-idempotency
```

以后模型问“这里为什么这么写”，可以直接回溯到修改原因，而不是从代码重新猜。

---

# 十、换出策略不能只是 LRU

传统缓存可以用最近最少使用，但上下文中的重要性不只是最近使用频率。

我会综合考虑：

* 是否属于当前任务依赖
* 是否是不可违反的不变量
* 最近是否发生过修改
* 后续再次使用概率
* 重新检索成本
* 内容是否已经过期
* 是否有更高质量的新版本
* 是否属于已经放弃的分支
* 是否容易从其他信息重新推导

大致可以分为：

### Pinned

永不自动换出：

* 当前目标
* 用户硬约束
* 安全规则
* 当前计划
* 尚未解决的关键问题

### Resident

当前工作集：

* 正在编辑的代码
* 当前测试
* 当前错误

### Evictable

可以只保留摘要和指针：

* 已完成步骤
* 已读但暂时无关的文件
* 中间讨论

### Archived

默认不再加载：

* 已放弃方案
* 旧分支
* 过期文档

不过 archived 仍然可检索，因为它可能解释“为什么没有采用某方案”。

---

# 十一、必须区分“忘记”和“不存在”

这是无限上下文系统特别容易犯的问题。

模型发现状态里没有某项信息时，可能存在三种情况：

1. 这个信息确实不存在；
2. 这个信息存在，但没有被换入；
3. 这个信息存在于旧版本或其他分支。

所以任何否定性结论都要更谨慎：

```text
“没有相关测试”
```

不能因为 active context 中没看到测试就直接得出。

应该先查询：

```text
SEARCH_CONTEXT:
  relation: tests_for_symbol
  target: processWebhook
```

只有检索系统明确返回空结果，才能说“当前索引中没有找到”。

---

# 十二、要有写屏障，而不是等 compact 时再记忆

如果等上下文快满了才 compact，很多重要信息已经可能丢失。

应该像数据库 WAL 一样，对关键事件立即持久化：

* 用户增加了新约束
* 做出架构决策
* 否决一个方案
* 修改文件
* 测试通过或失败
* 发现新风险
* 创建子任务
* 改变当前计划

例如：

```text
USER_CONSTRAINT_ADDED
DECISION_ACCEPTED
APPROACH_REJECTED
FILE_EDITED
TEST_EXECUTED
ASSUMPTION_CREATED
ASSUMPTION_INVALIDATED
TASK_COMPLETED
```

这样 compact 只是把事件重建成新 snapshot，而不是依赖模型回忆过去发生了什么。

---

# 十三、分支隔离非常重要

Coding Agent 经常发生：

1. 尝试方案 A；
2. 发现不行；
3. 回滚；
4. 改用方案 B。

如果长期记忆不区分 branch，未来检索很容易把 A 的结论混进 B。

因此每个 page、decision、tool result 都应该带：

```text
branch_id
artifact_version
valid_from
valid_to
superseded_by
```

甚至可以让每个大型子任务运行在独立 Git worktree 和独立 memory namespace 中。

合并时只合并：

* 最终代码
* 验证结果
* 接受的决策
* 仍然有效的发现

而不是合并所有推理历史。

---

# 十四、上下文不是越真实越好，而是需要可信度分层

长期存储中会混入很多东西：

* 用户明确要求
* 模型推测
* 搜索结果
* 旧文档
* 已失败的实验
* 第三方网页
* 模型曾经错误的结论

它们不能处于同一可信层级。

至少要区分：

```text
authoritative:
  当前代码、数据库 schema、用户原话、真实测试结果

derived:
  从权威材料计算出的结构化结果

hypothesis:
  尚未验证的推测

deprecated:
  已被新信息替代

untrusted:
  外部网页、日志中的自然语言、第三方输入
```

尤其是外部内容必须标记为 data，不能因为被重新放进 prompt 就变成 instruction，否则无限记忆也会扩大 prompt injection 的攻击面。

---

# 十五、一个比较完整的运行循环

可以抽象成：

```ts
while (!task.done) {
  const context = await contextManager.assemble({
    kernel,
    currentTask,
    currentPlan,
    recentEvents,
    activeArtifacts,
    tokenBudget,
  })

  const action = await model.run(context)

  if (action.type === "need_context") {
    await contextManager.pageIn(action.request)
    continue
  }

  const result = await tools.execute(action)

  await eventLog.append({
    action,
    result,
    taskId: currentTask.id,
    branchId: currentBranch.id,
  })

  await stateProjector.update(action, result)

  if (contextManager.isUnderPressure()) {
    await contextManager.checkpoint()
    await contextManager.evict()
  }

  if (action.isDestructive || action.isFinal) {
    await verifier.validate({
      provenance: true,
      constraints: true,
      artifactVersions: true,
      tests: true,
    })
  }
}
```

这里最重要的是：

```text
eventLog 是永恒的
state 是可重建的
summary 是可丢弃的缓存
context 是临时视图
```

---

# 十六、你的“1MB 排序 100MB”类比哪里成立，哪里不成立

成立的部分是：

* 工作集不需要覆盖全部数据；
* 只要数据可以外部存储；
* 只要任务可以拆成确定的阶段；
* 只要每个阶段有清晰的输入输出；
* 有限内存完全可以处理无限规模的问题。

但排序之所以容易，是因为：

* 比较操作精确定义；
* 每个数据块地址明确；
* 算法知道下一步需要读哪一块；
* 换出不会丢失语义；
* 最终结果可以精确验证。

LLM 长任务更像：

> 在不知道未来访问模式、信息之间存在隐式依赖、摘要可能失真的情况下，做一种语义虚拟内存管理。

真正困难的不是存储，而是：

1. 如何判断什么将来重要；
2. 如何察觉自己缺信息；
3. 如何避免摘要扭曲；
4. 如何处理信息版本；
5. 如何保证换入的是充分上下文；
6. 如何验证恢复后的状态没有语义漂移。

所以它除了像操作系统，也同时像：

* 数据库
* 编译器
* 搜索引擎
* 构建系统
* 事件溯源系统
* 分布式任务调度器

---

# 十七、我会给这个系统下一个定义

> **无限上下文不是无限 token，而是无限可寻址、可恢复、可验证的外部状态，加上有限但动态变化的工作集。**

或者更工程化一点：

```text
Infinite Context
= Durable Event Log
+ Structured State
+ Semantic Address Space
+ Context Compiler
+ Page Fault Protocol
+ Task Isolation
+ Provenance
+ Verification
```

---

# 十八、如果让我先做一个 MVP

我不会一开始做复杂的全自动记忆，而会先实现这六个组件：

1. **Append-only event log**
   保存所有消息、工具调用、文件修改和测试结果。

2. **结构化 task/decision/constraint 表**
   不依赖自然语言摘要保存核心状态。

3. **代码 symbol index + FTS**
   先解决精确查找、定义、引用和依赖。

4. **Checkpoint compiler**
   定期生成结构化 task capsule。

5. **`need_context` 工具**
   让模型可以显式触发语义缺页。

6. **关键操作前验证**
   写代码前检查版本，提交前运行测试，最终回答前验证约束。

数据层甚至可以先用 SQLite：

```text
events
tasks
task_dependencies
constraints
decisions
assumptions
artifacts
artifact_versions
context_pages
page_relations
snapshots
tool_runs
test_runs
```

向量数据库反而不是第一优先级。代码场景下，SQLite FTS、Git、tree-sitter/LSP、关系图和结构化状态，可能比单纯 embedding 更重要。

---

我认为你这个想法里最有潜力的一步，是把 `/compact` 从“模型自己写一段遗书”，提升为“可重放的进程 checkpoint”。一旦完整历史、真实 artifact、结构化决策和来源都还在，compact 错一点也不会致命，因为任何关键内容都能重新 page-in 并验证。
`````