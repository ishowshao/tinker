# TUI 段落式增量输出技术方案

## 文档状态

- 日期：2026-08-01
- 状态：待实施，核心合同已确认
- 范围：交互式 TUI 的 assistant 正文增量展示
- 上位路线图：[`product-hardening-roadmap.md`](product-hardening-roadmap.md)

## 一、结论

Tinker 采用 **section-framed streaming**：流式正文先在 presentation 层累积；当下一条完整的
顶层 Markdown ATX heading 出现时，前一个 section 封口，独立渲染一次并 append 到
`<Static>`。尚未封口的 section 只保存在内存中，不进入 live 区，也不触发 React 重渲染。

```text
SSE chunk
  -> 在线 response accumulator：组装并严格校验完整响应
       -> delta.content：临时 presentation input
            -> MarkdownSectionFramer
                 -> 已封口 section：AssistantMarkdown -> <Static>
                 -> 未封口 section：只留在 buffer
       -> 完整响应成功
            -> 有提前输出：flush 尾 section，正式正文认领既有输出
            -> 无提前输出：沿用现有正式 Markdown 输出路径
```

完整响应合同不变：`ModelClient.request()`、ledger、canonical history、正式 AgentEvent、SQLite、
Recall 和 resume 仍只消费完整响应。提前进入 `<Static>` 的 section 是不可撤回但非 canonical 的
presentation output。

失败或 retry 后，已经进入 `<Static>` 的 section 允许留在当前 scrollback；尚未封口的 buffer
丢弃。这是本方案的明确产品合同。

## 二、用户可见合同

1. 一个 section 从某条顶层 ATX heading 开始，到下一条顶层 ATX heading 之前结束。
2. 下一条 heading 完整到达后，前一个 section 才进入 `<Static>`；新 heading 属于下一 section。
3. heading 前的非空导语视为 preamble；第一条 heading 到达时，preamble 可以先提交。
4. 未封口 section 不显示正文；Footer 和现有 model 状态继续表示“仍在生成”。
5. 如果已有 section 提前提交，成功结束时只补交最后一个 section，不再打印整篇回复。
6. 如果没有 section 提前提交，继续由现有正式事件一次性显示完整 Markdown。
7. 无 heading 或只有一条 heading 的短回复通常要等到结束才显示；不增加空行或普通 paragraph
   fallback。
8. reasoning、tool-call fragment、provider ID 和参数片段不进入可见通道。

这里的“section”不是 CommonMark paragraph token。普通空行不是可靠的提交边界。

## 三、Section 切分合同

### 3.1 唯一边界

第一版只接受 Markdown parser 识别出的**顶层 ATX heading**（`#` 至 `######`）：

- heading 行必须完整结束；chunk 末尾的半截 `## 新段` 不算；
- token 必须位于 document root；代码围栏、blockquote、list、raw HTML 内的 `##` 不算；
- 任意 heading 层级都可以开始新 section；
- 连续 headings 合法；
- 一个 delta 内出现多个 headings 时，按源顺序产出多个 section。

空行、Setext heading、list item、thematic break、provider chunk 边界都不切分。

### 3.2 检测算法

`MarkdownSectionFramer` 使用与 `markdansi` 相同的 `marked` lexer 确认 top-level heading。
`marked` 声明为 Tinker 的直接依赖，不读取 `markdansi` 的内部文件。

framer 保留原始 source 和增量扫描位置：

1. delta 原样追加到当前 attempt buffer；
2. 只扫描新追加内容中已经结束的行；
3. 没有 ATX-heading 候选行时，不运行 lexer；
4. 出现候选行时，用 lexer 确认它是否是新的顶层 heading；
5. 确认后按原始 UTF-16 offset 切分，不规范化正文或换行。

因此每个 fragment 只有小型行扫描；完整 Markdown 解析只发生在 heading 候选点，不形成按
chunk 全量重扫的 O(n²) 路径。

### 3.3 文档级语义

Markdown reference definition 可能从后文改变前文：

```md
参见 [文档][ref]

## 下一节

[ref]: https://example.com
```

候选 section 出现 reference-style link、shortcut reference 或其他可能依赖后置定义的语法时，
该 attempt 停止提前封口，完整响应结束后走现有正式 Markdown 路径。inline link
（`[text](url)`）不受影响。section 独立性不能确认时，不猜测、不改写。

### 3.4 示例

收到：

```md
## 第一部分
第一部分正文。

## 第二部分
```

完整的 `## 第二部分\n` 到达后，第一部分进入 `<Static>`；buffer 从 `## 第二部分` 开始继续
累积。第二部分直到下一条顶层 heading 或完整响应成功时才提交。

## 四、分层与接口

### 4.1 Model 层

`ModelRequestOptions` 增加可选回调：

```ts
onTextDelta?: (content: string) => void;
```

`content` 是已经通过当前 chunk 全部结构校验的原始 `delta.content`，不是累计快照。空值和
非流式请求不回调。

现有 stream accumulator 改为在线 `push()` / `finish()`：`push()` 先校验并合并整个 chunk，
再返回可展示 content；`finish()` 继续交给现有 mapper 严格校验 role、finish reason、usage、
tool calls 和有效 assistant 内容。同一 chunk 的 tool-call fragment 非法时，不发出其中的正文。

reasoning delta 仍只服务现有完整响应组装与 reasoning-only 判定，不触发正文回调。

### 4.2 临时 presentation 通道

```ts
export type AssistantTextDeltaUpdate = IterationIdentity & {
  attemptNumber: number;
  content: string;
};

export interface AssistantTextDeltaSink {
  updateAssistantTextDelta(update: AssistantTextDeltaUpdate): void;
}
```

只有 TUI session 注入该 sink。loop 在每个 provider attempt 内创建带
`iterationId + attemptNumber` 的回调；stale attempt、错误 session 和 abort 后的 fragment
直接忽略。

该通道同步、best-effort、non-throwing：不经过 `RuntimeSession.append()`，不分配
`eventSequence`，不产生 `assistant.delta`，不写 JSONL、observation、SQLite 或 Recall。sink
异常只禁用本 session 的后续增量展示，不影响模型请求和正式事件。

### 4.3 TUI presentation 层

`TuiProjectionStore` 接收 raw delta，内部使用独立、可单测的 `MarkdownSectionFramer`。只有封口
section 才更新 render log 和通知 React；未封口 fragment 只改变内部 buffer。

`TuiProjectionState` 和 `reduceTuiProjection()` 仍只认识正式 AgentEvent。临时 section 使用
独立 render item：

```ts
export type AssistantStreamSectionItem = {
  kind: "assistant-stream-section";
  id: string;
  iterationId: IterationId;
  attemptNumber: number;
  sectionNumber: number;
  markdown: string;
  showAssistantLabel: boolean;
};
```

每个 attempt 的第一个可见 section 输出一次现有 `- assistant` label；后续 section 只输出正文。
正文复用 `AssistantMarkdown`。Shiki 继续在 App mount 前准备，因为 Static item 打印后会离开
React tree。

## 五、成功收口与去重

store 为当前 attempt 保存完整原始 content、已提交 source 范围、未封口 buffer，以及是否在
`ModelClient.request()` settle 前提交过 section。

收到正式 `model.request.finished` 时：

1. 校验累计正文与 `event.data.output.message.content` 完全一致；
2. 此前没有 section 提前提交：丢弃 framer，沿用现有正式输出路径；
3. 此前已经提交 section：把 buffer 作为最后一节进入 `<Static>`；
4. 将该 iteration 标记为 physically adopted；
5. 后续 `assistant.progress` 或 `turn.finished` 仍进入 canonical reducer，但对应 assistant item
   标记为已经物理输出，不再追加到 `<Static>`。

“认领”只是一条 TUI 去重规则，不改变正式 event 或 session schema。

### running model 行

Ink 的单一 `<Static>` 始终位于 live 内容上方。section 提前提交时，running model 行继续留在
底部表达生成状态，Footer 同时保持 `Running`。

成功 attempt 已提前输出 section 时，settled model item 不再晚于 assistant section 进入
`<Static>`；store 将它标记为 presentation-complete 并从 live 区移除。最终物理顺序保持为：

```text
prompt
assistant sections
tool / turn 后续内容
```

没有提前 section 时，model item 和正式 assistant item 完全沿用当前排序。

## 六、失败、retry 与取消

| 输入 | 已提交 section | 未封口 buffer | 正式状态 |
| --- | --- | --- | --- |
| `model.request.failed`，将 retry | 保留；非空时追加简短 retry 分隔行 | 丢弃 | model 行继续显示 retrying |
| `model.request.failed`，终止 | 保留 | 丢弃 | 沿用正式 turn failure |
| `turn.cancelled` | 保留 | 丢弃 | 沿用正式 cancelled |
| abort 后迟到 delta | 不变 | 不接收 | 不变 |
| 新 attempt | 旧 section 保留 | 建立全新 buffer | attemptNumber 递增 |
| session switch / 退出 | 不回滚已打印内容 | 丢弃 | 新 session 只按 canonical state 重建 |

retry 分隔行只在失败 attempt 已经物理输出正文时添加。新 attempt 的第一个 section 重新输出
`- assistant` label。失败、取消或协议错误都不强行提交未封口尾部。

当前终端可能保留失败 attempt 的 section，而 resume 不会重建它们；这是已接受差异。

## 七、性能、兼容与范围

本方案没有 assistant live Markdown viewport，也不需要 timer、字符上限、尾部截断或 React
帧节流：

- fragment 只更新 buffer 和增量行扫描位置；
- section 只调用一次 `AssistantMarkdown`；
- 进入 `<Static>` 后不再参与正常活动帧；
- 极长的单一 section 只占内存，不持续重渲染。

Static section 使用提交时的终端宽度，和现有 Static history 一样不会在后续 resize 时重排。

SQLite 不保存 framing、offset 或 physical adoption。成功响应 resume 后作为一个完整 canonical
Markdown item 重建；失败 attempt 的临时 section 不重建。

one-shot 不注入临时 sink。`stream: false` 完全沿用现有行为。不增加 profile 字段、环境变量或
slash command。

## 八、代码落点

| 文件 | 变更 |
| --- | --- |
| `package.json`、`bun.lock` | 将 `marked` 声明为直接依赖 |
| `src/model/model-client.ts` | `ModelRequestOptions` 增加 `onTextDelta` |
| `src/model/openai-chat-stream.ts` | accumulator 改为在线 `push()` / `finish()` |
| `src/model/openai-chat-model-client.ts` | 逐 chunk 调用已校验 content callback |
| `src/agent/loop.ts` | 每个 attempt 注入带 identity 的 callback |
| `src/agent/runtime-session.ts` | 接入临时 sink，并隔离失败，不经过 `append()` |
| `src/cli/tui-runner.tsx` | 只为 TUI 注入临时 sink |
| `src/tui/assistant-markdown-section-framer.ts` | 新增 section 切分器 |
| `src/tui/tui-projection-store.ts` | 管理 attempt、Static section、retry、认领和去重 |
| `src/tui/app.tsx` | Static renderer 支持 section render item |
| `src/model/fake-model-client.ts` | 增加 delayed section stream fixture |

明确不修改正式事件类型、`event-store` reducer 语义、session schema、JSONL、observation 和
one-shot stdout 合同。

## 九、测试与验收

### Section framer

- heading 跨 delta、单 delta 多 headings、preamble 和连续 headings；
- code fence、blockquote、list、HTML 内 heading-like 行不切分；
- 空行、Setext heading、thematic break 不切分；
- CRLF、CJK、emoji 和原始 source offset；
- reference-style syntax fallback，inline link 正常；
- 无 heading、单 heading 不提前产出；reset 隔离 attempts。

### Model 与 runtime

- 首个封口 section 在 `request()` settle 前到达；
- malformed chunk、reasoning、usage-only、tool-call-only 不产生正文；
- sink 失败和 abort 不改变正式请求结果；
- tool call 只在完整 mapper 与 ledger 成功后执行；
- JSONL、observation、SQLite、Recall 不含临时 section。

### TUI 与真实 PTY

- 未封口 fragment 不通知 React；下一 heading 只提交前一 section 一次；
- 同一 attempt 只显示一次 assistant label；
- 成功补交尾 section，并认领正式 item，不出现整篇副本；
- 无提前 section 时，完整 Markdown 路径不变；
- 成功 model item 不晚于 assistant section 进入 Static；
- retry 保留 sealed section、丢弃尾部并分隔新 attempt；
- failure/cancel 不提交未封口尾部；resume 只重建 canonical 正文；
- `transcriptSince(mark)` 证明无 `ESC[3J`，也不重放既有 Static history。

真实 provider smoke 还必须证明 section 输出早于 request settle、拼接 source 等于最终 content、
最终终端无重复、工具不提前执行，且不记录凭据、reasoning 或 tool 参数。

## 十、非目标

- token、逐行或普通 paragraph 级输出；
- 未封口 section 的 live Markdown；
- 空行或计时器 fallback；
- reasoning 和 tool-call argument streaming；
- one-shot streaming；
- 临时 section 持久化、resume replay 或失败回滚。

## 十一、实施门禁与完成条件

实施顺序：section framer → 在线 response accumulator → runtime 临时 sink → TUI Static
section/认领/retry → 真实 PTY 与 provider smoke。

迭代运行 `bun run check:fast`；源代码完成后必须运行 `bun run check`。文档通过
`git diff --check` 和 `bun run docs:check`。

完成条件：

- 满足切分合同时，至少一个完整 section 在 request 结束前进入 `<Static>`；
- 未封口正文不进入 live 区，也不产生 React frame；
- 已提交 section、尾 section 和正式 assistant item 在当前终端只出现一次；
- 无 heading、单 heading 和保守 fallback 沿用现有完整 Markdown 输出；
- retry、失败、取消只保留 sealed 物理输出，不污染 canonical history；
- resume、one-shot、`stream: false`、session schema 和正式 AgentEvent 合同不变；
- 单测、真实 PTY、真实 provider smoke 和 `bun run check` 全部通过。
