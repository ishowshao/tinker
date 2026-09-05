# 自动上下文维护与模型评测解耦

## 决策（2026-09-05）

自动 swap / prefix retirement 是产品行为，不由模型评测结果、报告存在与否、模型名称、
Recall description 哈希或 continuity 例外决定。评测只衡量效果；产品策略决定是否启用；
运行时安全检查决定一次具体操作是否可执行。

## 实现边界

- `src/context/context-automation-policy.ts` 仅定义不可变默认策略：
  `policyId=context-automation-v1`、`automaticSwap=true`、
  `automaticPrefixRetirement=true`。不依赖评测模块、文件、模型 profile 或工具 surface。
- RuntimeSession 通过内部 dependency 注入取得策略并在初始化时冻结副本。
  不增加用户配置、模型白名单或新的维护模式。无 profile 的会话也使用相同产品默认值。
- 删除 compiled qualification、continuity、评测工具/contract/report 哈希门禁，以及
  `requireAutomationQualificationId`。原 `automaticSwapOnly` 改名为 `automaticSwap`。
- 自动触发、压力 notice 的让步轮次、model-directed swap 优先、轮次关闭/恢复调度不变。
  仍先 swap，仅在 `no_eligible_candidates` 或 `insufficient_candidates` 时尝试 retirement。
- 初始化检查已注册的 RecallSearch/Get executor 与当前 retirement contract；缺失时明确
  失败，不以“未获评测资格”为由静默关闭功能。ContextManager/planner 继续检查请求与
  surface 一致性、活跃轮次/工具帧边界、过期计划、token 减少、事务与取消条件。
- 评测记录中的工具 hash 不再进入产品策略。当前请求/surface 的 hash、canonical 内容
  完整性及 revision/计划 hash 仍保留，不能借解耦绕过真实一致性校验。

## 事件与旧会话

新自动维护 started/finished/failed 事件写 `automationPolicyId`，算法版本仍写现有
`policyVersion`。手动与 model-directed 操作不伪装成自动策略事件。

旧 `qualificationId` 仅作为可选历史字段兼容，不再写入新运行时事件，也不参与决策。
SQLite canonical history 及既有 revision 不改写，不需要 schema 迁移。恢复会话时按当前
产品策略工作，诊断日志中的旧 qualification 不影响启用状态，也不会被重新解释为策略。

## 评测与报告

- `scripts/i4-active-recall-policy.ts` 保留原指标、冻结门槛及报告可比性校验。
- `scripts/qualify-i4-active-recall.ts` 新输出 `active-recall-qualification-v2`，只含
  passed、gates、metrics 和来源元数据；不再输出 automaticSwapOnly / automaticPrefixRetirement。
- 历史 v1 报告（包括 `passed=false`）原样保留；其中自动化字段只是旧格式遗留，不能
  控制运行时。原始文件哈希完整性由独立评测测试检查，不再编译入产品代码。
- 修改工具 description 仍可能使旧报告不能代表当前 surface。该判断只影响评测报告适用性，
  不关闭产品功能。将来调整评测或增加模型不需要改动自动维护策略。

## 回归范围

- 默认策略不依赖模型、profile、报告或工具文案；无 profile 与未评测模型均可自动维护。
- 更新工具文案并正常构建 surface 后自动维护继续工作；请求/surface 不一致仍失败。
- 缺失 Recall executor 或 contract 不兼容明确失败。
- 开关通过内部测试依赖显式注入，不再用“没有 profile”模拟关闭。
- 旧 qualification 诊断事件保留，恢复后的事件使用当前 automationPolicyId。
- 通过与未通过的新评测报告均不含产品开关字段。
- 保留压力触发、swap/retirement 顺序、手动操作、失败/取消/事务与恢复回归。

完成门禁为 `bun run check:fast` 和 `bun run check`。本次不调整维护算法，不重跑真实模型
评测；离线质量门禁不代表模型主动 Recall 能力评测通过。
