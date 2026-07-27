# Token Usage 累计统计与缓存命中率展示技术方案

## 文档状态

- 日期：2026-07-26
- 状态：待实施
- 前置能力：provider usage 解析（`parseUsage` 已支持 cache 字段）、ContextMeter
  `lastProviderUsage`、`/status` 的 ProviderUsage 展示（均已完成）
- 实测依据：`scripts/bench-cache-usage-smoke.ts` 对 deepseek-v4-flash / glm-5.2 / k3
  三个 profile 的真实请求结果（2026-07-26）

## 一、结论先行

Tinker 已经能解析每次模型请求的 cache 字段并在 `/status` 里展示**最近一次**请求的
cache hit/miss，但缺少**session 级累计**：用户看不到"这个会话一共消耗了多少 token、
其中多少命中了缓存"。Tinker 的 canonical history 严格 append-only，provider payload
前缀字节稳定，缓存命中率是可直接量化的架构优势，应当成为可见的产品特性。

本方案做三件事：

1. **session 级累计计数器**：跨全部模型请求累计 input / cached input / output，
   持久化到 session SQLite，resume 后完整保留。
2. **TUI 输入框状态行**（`model · workspace · branch · context X/Y (Z% used)` 一行）：
   在 context 用量之后追加 `· cache 94%`，显示 session 累计缓存命中率。
3. **`/usage` 纯 TUI 命令**：向 timeline 输出一行
   `Token usage: total=A input=B (cached C) output=D`。

不展示成本（订阅制 profile 没有干净的按 token 计价，且用户明确不需要）；不新增
模型可见工具；不改变任何 provider 请求内容。

## 二、当前实现基线与实测证据

### 2.1 已有接缝

1. `src/model/openai-chat-mapping.ts` 的 `parseUsage()` 已解析
   `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（DeepSeek 形状）和
   `prompt_tokens_details.cached_tokens`（OpenAI 嵌套形状），双形状并存时做一致性
   校验，`ModelUsage.promptCacheHitTokens` / `promptCacheMissTokens` 已存在。
2. `ContextMeter` 已持有 `lastProviderUsage`，`/status` 的 `ProviderUsage` 组件已展示
   最近请求的 cache hit/miss。
3. TUI 输入框状态行在 `prompt-input.tsx` 渲染，`formatContextUsageLine()` 输出
   `context X / Y (Z% used)`，追加段落是纯展示改动。
4. slash command 解析、分发和 timeline info item 是既有模式（`/status` 等）。
5. `session.usage` 类事件的 required/presentation sink 分类已有先例
   （`context.usage.updated`）。

### 2.2 实测证据（2026-07-26，三个 profile 各三轮请求）

| profile | 命中时返回 | 未命中时返回 | 流式 include_usage |
| --- | --- | --- | --- |
| deepseek-v4-flash | `prompt_cache_hit/miss_tokens` **和** `prompt_tokens_details.cached_tokens`，两值一致 | 同样返回，hit=0 | ✅ |
| glm-5.2 | `prompt_tokens_details.cached_tokens` | 同样返回，cached=0 | ✅ |
| k3 | 顶层 `cached_tokens` **和** `prompt_tokens_details.cached_tokens`，两值一致 | **两种字段都缺席** | ✅ |

严格 append 的第二轮请求命中率三家均 ≥94%（2560/2571 ≈ 99.6% 为最高）。三家都按
64 token 块量化命中数。

实测暴露的两个解析层事实：

- 现有 `parseUsage()` 已覆盖三个 profile 的**命中**路径（k3 命中时嵌套字段存在）。
- Moonshot 官方 schema 文档化的顶层 `usage.cached_tokens` 在当前解析中没有独立
  fallback。实测 k3 端点命中时同时返回两种形状，因此这不是阻断缺口，但官方
  schema 只承诺顶层字段，解析层应补一个低优先级 fallback 以覆盖端点行为漂移。

## 三、指标定义

### 3.1 累计计数器

session 级累计四个计数器，只统计**成功返回且通过 usage 校验**的模型请求：

```ts
export type SessionTokenUsage = {
  requestsTotal: number;          // 计入统计的模型请求数（含未上报 cache 的）
  cacheReportedRequests: number;  // usage 中实际携带 cache 字段的请求数
  inputTokens: number;            // Σ promptTokens
  cachedInputTokens: number;      // Σ promptCacheHitTokens（未上报的请求贡献 0）
  outputTokens: number;           // Σ completionTokens
};
```

- 统计粒度是**模型请求**（iteration），不是 turn。一个 turn 内多次 iteration 逐次
  累计，与计费语义一致。
- `total = inputTokens + outputTokens`，展示时派生，不单独存储。
- 取消、失败、reasoning-only 重试中被丢弃的响应不计入；只有被 ledger 接受的
  assistant 响应才累计。
- `cachedInputTokens` 恒 ≤ `inputTokens`（解析层已有不变量校验保证）。

### 3.2 缓存命中率

```text
cache hit rate = cachedInputTokens / inputTokens  （inputTokens > 0 时）
```

token 加权，不按请求数平均。session 无任何已统计请求时命中率为 undefined，
UI 不显示。

### 3.3 "未上报 cache"的处理

k3 实测显示未命中时 cache 字段整体缺席，而 DeepSeek/GLM 未命中时返回 0。若一律把
缺席解释为"该请求不参与统计"，k3 的命中率会被系统性高估（miss 请求被排除）。

处理规则：

- 默认：cache 字段缺席的请求**计入 inputTokens，cachedInputTokens 贡献 0**。
  这对 k3 是正确的（缺席即 miss，实测证据），对真正不报 cache 的 provider 会记为
  0% 命中——这是保守方向（低估而非高估），可接受。
- `cacheReportedRequests` 单独计数，供 `/status` 诊断区区分"provider 不报"与
  "报了但没命中"。
- 不引入 per-profile 行为配置；解析层规则对三家实测行为均正确。

### 3.4 解析层补充

`parseUsage()` 增加第三优先级来源：顶层 `usage.cached_tokens`（Moonshot 官方
schema 形状）。优先级与冲突规则：

```text
hit = prompt_cache_hit_tokens
      ?? prompt_tokens_details.cached_tokens
      ?? cached_tokens          // 新增，仅在前两者缺席时生效
```

若多个来源同时出现且数值不一致，沿用现有冲突校验抛 `ProviderResponseError`
（实测 k3 两形状一致，不触发）。miss 由 `promptTokens - hit` 派生（顶层形状无
独立 miss 字段）。

## 四、持久化

### 4.1 Schema v10：session_token_usage

```sql
CREATE TABLE session_token_usage (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  session_id TEXT NOT NULL UNIQUE,
  requests_total INTEGER NOT NULL CHECK (requests_total >= 0),
  cache_reported_requests INTEGER NOT NULL CHECK (cache_reported_requests >= 0),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES session_meta(session_id),
  CHECK (cached_input_tokens <= input_tokens),
  CHECK (cache_reported_requests <= requests_total)
) STRICT;
```

- 单行表，session 初始化时插入全零行。
- 本设计与 turn checkpoint 设计各自提出 schema 变更；先落地者占用 v10，
  后落地者递增为 v11，实施时协调。

### 4.2 更新时机与事务边界

累计更新挂在 **assistant 响应被 ledger 接受的同一写屏障**：

```text
provider response 校验通过
  -> ledger 提交 assistant message（现有事务）
  -> 同事务 UPDATE session_token_usage 累计计数器
  -> 发出 session.usage.updated 事件
```

- 计数器与 assistant message 同事务，保证"历史里存在的响应恰好被统计一次"：
  不存在消息已落账但统计丢失、或统计了未落账响应的窗口。
- reasoning-only 重试：被丢弃的响应从未进入 ledger，自然不被统计。
- 更新失败（如 CHECK 约束失败说明解析层不变量被破坏）按账本写失败处理：
  session fault，fast-fail，不静默吞掉。

### 4.3 生命周期语义

- **resume**：session open 时读取单行，`session.resumed` 流程把计数器载入
  runtime，footer 立即可显示，无需任何重算。usage 不在 message record 里
  （F3 明确决策），因此本表是唯一来源，不从历史重建。
- **fork**：复制计数器行。fork 克隆了产生这些 usage 的完整历史，统计跟随历史
  保持一致。
- **session delete**：级联删除，无外部资源。
- **多 session**：按 session 隔离，不提供跨 session 汇总（非目标）。

## 五、事件与数据流

新增事件：

```ts
type SessionUsageUpdatedEvent = {
  type: "session.usage.updated";
  usage: SessionTokenUsage;
};
```

- 归类为 required + presentation sink（与 `context.usage.updated` 同类），JSONL、
  observation log 与 TUI event stream 均可见。
- 发射时机：每次计数器更新后、session open/resume 载入后各一次。
- `TuiProjectionState` 增加 `sessionUsage?: SessionTokenUsage`，event-store 在
  `session.usage.updated` 时替换；`session.resumed` 重建路径同样由该事件供给，
  不引入第二套状态源。
- one-shot CLI：计数器照常累计入库；`StdoutEventPrinter` 输出一行稳定摘要
  （如 `usage total=2604 input=2559 (cached 0) output=45`），供 runner 测试断言，
  非交互场景不做额外展示。

## 六、TUI 展示

### 6.1 输入框状态行（footer 区）

现状（`prompt-input.tsx` 状态行）：

```text
deepseek-v4-flash · tinker · main · context 12.3K / 256K (5% used)
```

追加 cache 段：

```text
deepseek-v4-flash · tinker · main · context 12.3K / 256K (5% used) · cache 94%
```

规则：

- 数据来自 `state.sessionUsage`；`inputTokens > 0` 时才渲染该段，否则整段隐藏
  （新 session 不显示 `cache 0%` 噪声）。
- 百分比为 `Math.round(rate * 100)`，不加小数。
- 配色：默认 dimColor（与 context normal 一致）；不引入按命中率变色的阈值逻辑
  ——命中率高低取决于任务形态，不是健康度指标，避免误导。
- turn 运行中同样实时更新（事件驱动，无需特殊处理）。

### 6.2 `/usage` 命令

纯 TUI 展示，不进模型上下文，不触发任何运行态操作：

```text
/usage
```

输出为 timeline info item（单行 + 一行诊断），格式固定：

```text
Token usage: total=15.0K input=12.4K (cached 8.9K) output=2.6K
Cache hit: 72% across 24 requests
```

- 第一行严格按用户指定格式；数字用现有 `formatTokenCount()`（K/M 单位）。
- 第二行补充命中率与请求数；`cacheReportedRequests < requestsTotal` 时追加
  说明 `(N requests did not report cache)`。
- session 无任何已统计请求时输出 `Token usage: no model requests yet`。
- `/status` 的 ProviderUsage 区块保持不变（最近请求视角）；`/usage` 是累计视角，
  两者不合并。
- slash command 注册、usage 解析、建议列表与既有命令同模式；
  `ParsedSlashCommand` 增加 `{ type: "usage" }`。

## 七、非目标

- 成本估算与价格表（订阅制 profile 无干净计价；用户明确不需要）。
- 跨 session / 全局用量汇总、按天统计、用量导出。
- 命中率告警、阈值变色、缓存优化建议。
- reasoning tokens 的单独展示（`completion_tokens_details.reasoning_tokens`
  已解析，是 output 的子集，留待后续）。
- 每次请求的命中率展示（`/status` 已有最近请求 cache hit/miss 原始值）。
- 把 usage 反写进 canonical message record（维持 F3 决策）。

## 八、代码落点

| 文件 | 主要变更 |
| --- | --- |
| `src/model/openai-chat-mapping.ts` | `parseUsage()` 增加顶层 `cached_tokens` fallback 与冲突校验 |
| `src/agent/context-meter.ts` 或新 `src/agent/session-usage.ts` | `SessionTokenUsage` 类型与累计 reducer（纯函数） |
| `src/session/session-schema.ts` | schema 版本递增：`session_token_usage` 表与迁移 |
| `src/session/session-store.ts` | 单行读写、与 assistant commit 同事务的累计更新、fork 复制 |
| `src/agent/runtime-session.ts` | assistant 接受点驱动累计；open/resume 载入并发事件 |
| `src/events/types.ts` | `session.usage.updated` 事件 |
| `src/events/observation-text-log.ts` / `stdout-event-printer.ts` | 人类可读段落与单行摘要 |
| `src/tui/event-store.ts` | `TuiProjectionState.sessionUsage` 与事件归约 |
| `src/tui/components/prompt-input.tsx` | 状态行追加 `· cache N%` 段 |
| `src/tui/slash-commands.ts` | `/usage` 注册与解析 |
| `src/tui/app.tsx`（或对应分发处） | `/usage` 渲染 timeline info item |
| `src/tui/components/context-status.tsx` | Measurement 区补一行累计口径说明（可选） |
| `package.json` | `bench:cache-usage` 挂载现有探针脚本 |

## 九、分步实施顺序

### U1：解析与纯领域层

1. `parseUsage()` 顶层 fallback + 冲突校验测试（用三 profile 实测 fixture 做 golden）。
2. `SessionTokenUsage` 类型与累计 reducer 纯函数。

完成门槛：三个 profile 的实测 usage JSON 各自由 fixture 驱动通过解析与累计断言；
冲突形状抛精确错误。

### U2：持久化与 runtime 接线

1. schema 迁移与单行 CRUD。
2. assistant commit 同事务累计；open/resume 载入；fork 复制。
3. `session.usage.updated` 事件与三个 sink。

完成门槛：中断-恢复后计数器不变；fork 后两边一致；同事务性由注入失败测试
（assistant 落账与计数器更新不存在只完成其一的窗口）。

### U3：TUI 展示

1. event-store 归约与状态行 cache 段。
2. `/usage` 命令与 timeline 渲染。
3. PTY journey：两轮请求后状态行出现 `cache N%`，`/usage` 输出累计行；resume 后
   两处直接显示。

完成门槛：`bun run check` 通过；公共契约文档（slash commands 列表）重新生成无
diff。

## 十、测试计划

### 10.1 解析

- DeepSeek 形状（hit/miss 双字段）、GLM 形状（仅嵌套）、k3 命中形状（顶层+嵌套
  一致）、k3 未命中形状（全缺席）分别解析正确。
- 顶层与嵌套不一致时抛冲突错误；`cached_tokens > prompt_tokens` 抛边界错误。
- 未携带任何 cache 字段的通用 OpenAI 响应回归：不计 cached，不抛错。

### 10.2 累计与持久化

- 多 iteration turn：每次成功响应各累计一次。
- 取消发生在两个 tool 之间：已接受的 assistant 响应已计入，未返回的不计。
- reasoning-only 重试：仅最终接受的响应计入一次。
- resume：计数器从 SQLite 恢复，`session.usage.updated` 在 open 后发出。
- fork：新 session 计数器与源一致，此后各自独立累计。
- 注入计数器更新失败：session fault，且 assistant message 未单独落账。

### 10.3 TUI

- 状态行：无请求时不显示 cache 段；首次响应后出现；每次响应后百分比更新。
- `/usage`：空 session、纯 miss、混合命中三种场景的固定格式 golden。
- `cacheReportedRequests < requestsTotal` 时的说明文案。
- resume 后状态行与 `/usage` 均直接可用（不经任何新请求）。
- PTY：完整 turn 后 footer 段与 `/usage` 输出符合预期。

### 10.4 门禁

```bash
bun test src/__tests__/openai-chat-mapping.test.ts
bun test src/__tests__/session-store.test.ts
bun test src/__tests__/runtime-session.test.ts
bun test src/__tests__/tui-event-store.test.ts
bun test src/__tests__/slash-commands.test.ts
bun scripts/bench-cache-usage-smoke.ts deepseek-v4-flash glm-5.2 k3
bun run check
```

## 十一、手工验收

1. 新 session 提一个问题，确认状态行在首个响应后出现 `· cache N%`。
2. 连续进行多轮对话（严格 append），确认命中率随轮次上升并稳定在高位。
3. `/usage` 确认输出格式为
   `Token usage: total=A input=B (cached C) output=D`，数值与 `/status` 最近请求
   的原始值量级一致。
4. 退出 TUI，`/resume` 该 session，不发任何新请求，确认状态行 cache 段与
   `/usage` 直接显示退出前的累计值。
5. `/fork` 后在两个 session 各自对话，确认计数互不影响。
6. 换用未验证 cache 字段的 OpenAI-compatible profile，确认不报错、cache 段显示
   0% 或不显示，无崩溃。
7. 检查 events.jsonl，确认每次模型响应后有一条 `session.usage.updated`。

## 十二、关键取舍

1. **累计而不是逐请求展示**：命中率的意义在 session 尺度（"严格 append 的架构
   红利"），逐请求波动已由 `/status` 覆盖。
2. **SQLite 单行持久化而不是事件重放**：usage 不在 canonical message 里（F3
   决策），累计计数器与 assistant commit 同事务是唯一能同时保证准确和
   resume 一致的位置。
3. **cache 缺席记 0 而不是剔除**：对 k3 实测行为正确，对未知 provider 是保守
   方向；命中率宁可低估不高估。
4. **命中率不做阈值变色**：它是架构特性的量化展示，不是健康度告警；任务形态
   不同命中率天然不同。
5. **展示成本留给价格表成熟之后**：三个 profile 中 k3 是订阅计量，此时做成本
   只会制造一个看起来精确实则错误的数字。
