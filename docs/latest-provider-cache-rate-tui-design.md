# 最近一次 Provider 缓存命中率 TUI 展示方案

## 文档状态

- 日期：2026-07-29
- 状态：待实施
- 范围：仅调整 Prompt Input 状态行的动态展示

## 一、结论

Tinker 在 Prompt Input 状态行中展示最近一次被接受的模型请求所报告的缓存命中率：

```text
deepseek-v4-flash · tinker · main · context 12.3K / 256K (5% used) · cache 94%
```

该数值只描述当前 RuntimeSession 中最近一次有效 provider 响应，不累计、不持久化，
也不从历史会话或事件日志重建。

只有 provider usage 明确包含 cache hit 和 cache miss 时才显示。字段缺席表示当前没有
可展示的精确数据，TUI 隐藏整个 cache 段，不把缺席推断为 0。

本次改动不增加数据库表、schema version、runtime event、slash command 或模型请求字段。

## 二、为什么展示最近一次请求

Provider cache 是请求发生时的临时状态，不是 session 历史的固有属性。

- 较早的 session 被 resume 时，provider 可能已经淘汰原有缓存。
- resume 后的第一次请求可能完全 miss，后续 iteration 才重新命中稳定前缀。
- 同一个 turn 包含多次模型请求时，每次请求的 cache 状态都可能不同。
- provider 可能不报告 cache 字段；没有字段不等于经过测量的 0。

因此，跨请求累计或恢复历史统计会混合不同时间点的缓存状态，不能准确表达当前请求
是否复用了 provider cache。最近一次请求的 usage 是更直接、可解释的展示口径。

## 三、目标

1. 在 Prompt Input 状态行追加最近一次 provider cache 命中率。
2. 每次被接受的模型响应带来新 usage 后，展示立即替换为新值。
3. 新 session、刚 resume 的 session 和没有 cache 字段的响应不显示 cache 段。
4. 失败、取消或被拒绝的 provider 响应不改变展示。
5. 完全复用现有 `ContextMeter`、`context.usage.updated` 和 TUI projection 数据流。

## 四、非目标

- 不累计当前 turn、当前运行周期或整个 session 的 token usage。
- 不把 cache usage 写入 SQLite、canonical message 或其他持久化存储。
- 不从 `events.jsonl`、observation log 或 canonical history 重建 usage。
- 不改变 resume、fork、session delete 或 schema identity。
- 不增加 `/usage` 或其他 slash command。
- 不修改 provider usage 的解析规则或兼容新的 provider 字段形状。
- 不展示成本，不做缓存健康度判断、阈值变色或优化建议。
- 不改变 `/status` 中现有的最近请求 usage 明细。

## 五、现有数据流

当前链路已经提供全部所需数据：

```text
provider 返回 ModelRequestOutput.usage
  -> ledger 接受 assistant message
  -> ContextMeter.recordProviderUsage()
  -> ContextUsageSnapshot.lastProviderUsage
  -> context.usage.updated
  -> TuiProjectionState.contextUsage
  -> PromptInput.contextUsage
```

`ContextMeter.recordProviderUsage()` 在 assistant message 成功进入 ledger 后调用，因此
`lastProviderUsage` 对应最近一次被接受的响应。reasoning-only retry、请求失败、取消以及
assistant commit 失败都不会进入这一步。

`PromptInput` 已经接收完整的 `ContextUsageSnapshot`，不需要增加新的 prop、TUI state
或 event-store 字段。

## 六、展示契约

### 6.1 数据来源

唯一数据来源：

```ts
props.contextUsage?.lastProviderUsage
```

不在组件内保存上一份 usage，不增加独立 accumulator。

### 6.2 可展示条件

同时满足以下条件时显示：

```ts
usage.promptCacheHitTokens !== undefined
usage.promptCacheMissTokens !== undefined
usage.promptCacheHitTokens + usage.promptCacheMissTokens > 0
```

任一条件不满足时返回 `undefined`，Prompt Input 不渲染分隔符和 cache 文本。

不使用 `promptTokens - hit` 在 TUI 层推导 miss。字段规范化和一致性校验继续由 model
mapping 层负责；TUI 只消费已经规范化的 `ModelUsage`。

### 6.3 百分比

```text
rate = hit / (hit + miss)
percent = Math.round(rate * 100)
```

显示为整数百分比，不增加小数：

```text
· cache 0%
· cache 72%
· cache 100%
```

`0%` 只在 provider 明确报告 `hit = 0` 且 `miss > 0` 时显示。cache 字段整体缺席时
隐藏，而不是显示 `0%`。

### 6.4 文案与颜色

- 固定文案：`cache N%`
- 前置分隔符：` · `
- 使用 `dimColor`，与 context normal 状态的视觉层级一致。
- 不根据百分比设置红、黄、绿等颜色。
- 不额外标注 `last request`；该口径由产品契约和 `/status` 的最近请求语义共同定义。

### 6.5 更新与清空

| 场景 | 展示行为 |
| --- | --- |
| 新 RuntimeSession 尚无 provider 响应 | 隐藏 |
| 最近一次被接受的响应报告 hit/miss | 显示该次请求的百分比 |
| 下一次 iteration 报告新的 hit/miss | 替换为新百分比 |
| 新请求正在运行、尚未返回 | 保留最近一次已接受响应的值 |
| 最近一次响应不报告 cache 字段 | 隐藏 |
| 请求失败、取消或响应未被 ledger 接受 | 保持原值，不用失败数据更新 |
| resume 后尚未产生新 provider 响应 | 隐藏 |
| context revision 或 invalidation 清除 `lastProviderUsage` | 隐藏 |
| 清除后产生新的有效 provider 响应 | 重新显示 |

“请求运行中保留旧值”不表示对正在执行的请求作出推断；它仍然只表示最近一次已经完成
并被接受的 provider 响应。

## 七、Resume 语义

Measured context anchor 的持久化只用于恢复 context measurement，不恢复 cache hit/miss。
resume 后即使存在可用 anchor，`lastProviderUsage` 也不携带 cache 字段，因此状态行不显示
历史 cache 值。

第一次 post-resume 请求完成后：

- provider 明确报告 miss：显示 `cache 0%`；
- provider 明确报告部分或全部 hit：显示实际百分比；
- provider 不报告 cache 字段：继续隐藏。

这一行为直接反映 resume 时 provider 的当前缓存状态，不尝试延续退出前的值。

## 八、代码落点

| 文件 | 变更 |
| --- | --- |
| `src/tui/context-format.ts` | 增加纯函数，将 `lastProviderUsage` 格式化为 `cache N%` 或 `undefined` |
| `src/tui/components/prompt-input.tsx` | 在现有 context 段之后按条件渲染 ` · cache N%` |
| `src/__tests__/tui-components.test.tsx` | 覆盖显示、隐藏、更新和边界百分比 |

不修改：

- `src/agent/context-meter.ts`
- `src/agent/loop.ts`
- `src/agent/runtime-session.ts`
- `src/events/types.ts`
- `src/tui/event-store.ts`
- `src/session/*`
- public slash-command 文档

## 九、建议实现

格式化逻辑保持为纯函数：

```ts
export function formatLatestProviderCacheRate(
  usage: ModelUsage | undefined,
): string | undefined {
  const hit = usage?.promptCacheHitTokens;
  const miss = usage?.promptCacheMissTokens;
  if (hit === undefined || miss === undefined || hit + miss === 0) {
    return undefined;
  }
  return `cache ${Math.round((hit / (hit + miss)) * 100)}%`;
}
```

`PromptInput` 在渲染时计算一次：

```tsx
const cacheRate = formatLatestProviderCacheRate(
  props.contextUsage?.lastProviderUsage,
);
```

并在 context 段之后追加：

```tsx
{cacheRate === undefined ? null : (
  <>
    <Text dimColor> · </Text>
    <Text dimColor>{cacheRate}</Text>
  </>
)}
```

格式化函数不读取 React state，不缓存结果，也不负责验证 provider 原始响应。

## 十、测试计划

### 10.1 组件展示

1. `contextUsage` 缺席：不显示 cache。
2. `lastProviderUsage` 缺席：不显示 cache。
3. usage 有 prompt/completion/total，但没有 cache 字段：不显示 cache。
4. `hit = 0, miss > 0`：显示 `cache 0%`。
5. `hit > 0, miss > 0`：按四舍五入显示整数百分比。
6. `hit > 0, miss = 0`：显示 `cache 100%`。
7. `hit = 0, miss = 0`：不显示 cache。
8. rerender 为新的 provider usage：旧百分比被新百分比替换。
9. rerender 为不含 cache 字段的 usage：cache 段消失。
10. context pressure 为 normal、triggered、blocked 时，cache 段均不改变颜色。

### 10.2 既有行为回归

- 原有 model、workspace、branch、phase 和 context 文案不变。
- slash suggestions 或 file suggestions 可见时，状态行继续整体隐藏。
- `/status` 的 ProviderUsage 展示保持不变。
- context invalidation 后 `lastProviderUsage` 清空的既有测试继续通过。

### 10.3 门禁

实现期间先运行相关测试：

```bash
bun test src/__tests__/tui-components.test.tsx
bun test src/__tests__/context-measurement.test.ts
```

源代码变更完成后运行完整门禁：

```bash
bun run check
```

## 十一、手工验收

1. 启动新 TUI，不发送请求，确认状态行没有 cache 段。
2. 发送一个产生明确 cache miss 的请求，确认显示 `cache 0%`。
3. 在同一 session 继续 append，确认下一次 provider 响应后百分比被新值替换。
4. 构造一个 turn 内包含工具调用的多 iteration 流程，确认每次有效响应后动态更新。
5. resume 一个较早的 session，不发送新请求，确认不显示历史 cache 值。
6. 在 resumed session 中发送请求，确认只显示 post-resume provider 返回的新值。
7. 使用不报告 cache 字段的 profile，确认不出现 `cache 0%`，且 TUI 正常运行。

## 十二、完成条件

- footer 只展示最近一次被接受响应中明确报告的 cache hit rate。
- cache 字段缺席时没有推断值。
- resume 不恢复、不重建历史 cache usage。
- 没有 schema、session persistence、event protocol 或 model request 变化。
- 相关测试和 `bun run check` 全部通过。
