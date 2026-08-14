# Bash / TaskOutput 有界 Preview 技术方案

## 文档状态

- 日期：2026-08-14
- 状态：已实施
- 优先级：P0
- 相关实现：`src/tools/bounded-output-preview.ts`、`src/tools/task-output.ts`、
  `src/tools/task-output-snapshot.ts`、`src/tools/bash.ts`、`src/tools/task-output-tool.ts`、
  `src/observation/observation-builder.ts`
- 相关设计：[`bash-tool-design.md`](bash-tool-design.md)、
  [`background-task-management-design.md`](background-task-management-design.md)、
  [`observation-current-state.md`](observation-current-state.md)

## 一、结论

`Bash` 和 `TaskOutput` 进入模型观察的非 PTY `preview` 必须同时受行数和 UTF-8
字节数约束。完整命令输出继续写入 `outputFilePath`，preview 只提供有界的头尾窗口和明确的
省略标记。

本方案采用以下固定限制：

```ts
const MAX_PREVIEW_LINES = 200;
const PREVIEW_EDGE_LINES = 100;
const MAX_PREVIEW_BYTES = 32 * 1024;
const MAX_PREVIEW_LINE_BYTES = 8 * 1024;
```

最终 `preview` 必须满足：

```ts
Buffer.byteLength(preview, "utf8") <= MAX_PREVIEW_BYTES;
```

限制适用于前台 `Bash` 完成结果、后台任务的 `TaskOutput` 结果，以及运行中任务的非 PTY
输出快照。PTY 的固定终端 screen 不属于本方案。

## 二、目标与非目标

### 2.1 目标

- 不超过 200 行的输出也不能用超长单行绕过 preview 上限。
- 每条进入 preview 的文本行最多占用 8 KiB UTF-8 字节。
- 整个 preview（包括省略标记）最多占用 32 KiB UTF-8 字节。
- 截断同时保留输出头部和尾部，便于观察命令上下文、错误结尾和总结信息。
- 截断不切开 UTF-16 surrogate pair，不产生由 Tinker 截断造成的非法 Unicode 字符串。
- `Bash` 与 `TaskOutput` 使用同一套 preview 选择和渲染实现。
- 完整输出文件、`outputBytes`、`outputLines` 和 `outputFilePath` 语义保持不变。
- `truncated` 在发生行数、单行字节数或 preview 总字节数截断时统一为 `true`。

### 2.2 非目标

- 不修改 context preflight、context revision、自动 compaction 或 recent-turn 保护规则。
- 不增加全局 tool observation 字节预算或 tool-exchange frame 聚合预算。
- 不改变 `Read`、`Grep`、`WebSearch`、`WebFetch`、MCP 等其他工具的输出规则。
- 不调整 `TaskOutput` 内部保存 `pendingLine`、`firstLines`、`lastLines` 的内存模型。
- 不移除完成后读取 Bash 输出文件并生成 snapshot 的现有路径。
- 不以本方案解决超大日志的常量内存处理问题。
- 不保证截断点位于完整 grapheme cluster 边界；只保证 Unicode code point 完整。
- 不限制 observation 中的 `command`、路径和其他元数据长度。
- 不改变模型可见的 `Bash`、`TaskOutput` tool schema。

## 三、当前实现基线

`TaskOutput` 当前以 200 行为唯一 preview 上限：

- 输出不超过 200 行时，全部行进入 preview。
- 输出超过 200 行时，保留前 100 行和后 100 行。
- `Bash` 完成后通过 `buildOutputSnapshotFromText()` 使用相同的行数规则。
- `ObservationBuilder` 将 `raw.preview` 原样写入非 PTY 模型观察。

因此，少量超长行可以生成远大于预期的模型观察。新的实现必须在保留现有行级头尾语义的
基础上增加单行和总 preview UTF-8 字节上限。

## 四、Preview 合同

### 4.1 `TaskOutputSnapshot`

本方案不增加持久化字段，继续使用现有结构：

```ts
type TaskOutputSnapshot = {
  outputBytes: number;
  outputLines: number;
  preview: string;
  truncated: boolean;
  omittedLines?: number;
};
```

字段语义：

- `outputBytes`：完整输出文件的原始字节数。
- `outputLines`：完整输出的逻辑行数。
- `preview`：有界模型可见窗口。
- `truncated`：任一内容未逐字进入 preview 时为 `true`。
- `omittedLines`：完全未进入 preview 的逻辑行数；只有行内被截短而没有整行缺失时不设置。

行内被截短不计入 `omittedLines`。行内省略的 UTF-8 字节数直接写入该行的省略标记。

### 4.2 完整输出

preview 截断不能修改输出文件。以下事实必须保持：

- stdout/stderr 的完整捕获内容仍写入 `outputFilePath`。
- `outputBytes` 和 `outputLines` 继续描述完整输出，而不是 preview。
- observation 继续提供 `outputFilePath`，模型需要更多内容时通过后续有界命令或 `Read` 获取。

### 4.3 空输出与未截断输出

- 空输出的 preview 为 `""`，`truncated=false`，不设置 `omittedLines`。
- 同时满足 200 行、单行 8 KiB 和总量 32 KiB 的输出保持逐字 preview，
  `truncated=false`。
- 原输出末尾是否包含换行继续沿用现有 snapshot 语义；本方案不改变尾换行归一化规则。

## 五、确定性截断算法

实现新增共享模块 `src/tools/bounded-output-preview.ts`。`TaskOutput.snapshot()` 和
`buildOutputSnapshotFromText()` 都必须调用该模块，不能分别维护字节截断逻辑。

处理顺序固定如下：

```text
完整逻辑行
  -> 行数窗口：前 100 行 + 后 100 行
  -> 单行 UTF-8 字节截断：每行最多 8 KiB
  -> preview 总 UTF-8 字节截断：整体最多 32 KiB
  -> 生成最终 preview / truncated / omittedLines
```

### 5.1 行数窗口

- `outputLines <= 200`：所有逻辑行进入候选窗口。
- `outputLines > 200`：候选窗口由前 100 行和后 100 行组成。
- 中间插入一条整行省略标记：

```text
... output omitted: lines <start>-<end> (<count> lines). Full output is available at outputFilePath.
```

- `<count>` 计入 `omittedLines`。

### 5.2 单行字节上限

候选窗口中的每条原始输出行分别检查 UTF-8 字节数。字节数不超过 8 KiB 时保持原文。

超过 8 KiB 时，生成以下一行：

```text
<UTF-8-safe prefix>... <count> UTF-8 bytes omitted from this line ...<UTF-8-safe suffix>
```

规则：

1. 省略标记本身计入 8 KiB。
2. 扣除省略标记后，剩余字节预算平均分配给 prefix 和 suffix；奇数字节归 suffix。
3. `<count>` 是该原始逻辑行未逐字保留的 UTF-8 字节数。
4. 行内截断令 `truncated=true`，但不增加 `omittedLines`。
5. 生成后的行必须再次断言不超过 8 KiB。

### 5.3 Preview 总字节上限

将行数窗口和行内截断结果连同换行符拼接。若总量不超过 32 KiB，直接返回。

以 80 行、每行 64 KiB 的输出为例：

1. 每行先按 5.2 节压缩到不超过 8 KiB，同时保留该行的头尾。
2. 80 条有界行合计仍超过 32 KiB，因此不能全部进入 preview。
3. 最终保留输出开头约 2 条有界行和结尾约 2 条有界行。
4. 中间约 76 行完全省略并计入 `omittedLines`。
5. 被保留的 4 行仍各自包含原始行的头部、行内省略标记和尾部。

最终结构为：

```text
<开头若干条完整的有界行>

... output omitted to fit the 32768-byte preview limit. Full output is available at outputFilePath.

<结尾若干条完整的有界行>
```

确定规则如下：

1. 总量省略标记和标记前后的换行符计入 32 KiB 上限。
2. 扣除省略标记后，剩余字节预算平均分配给头部和尾部；奇数字节归尾部。
3. 头部从第一条候选行开始、尾部从最后一条候选行开始，分别加入能够完整容纳的有界行。
4. 同一候选行不能同时出现在头部和尾部。
5. 未进入头部或尾部的原始输出行完全省略并累加到 `omittedLines`；5.1 节已经省略的
   行数同时保留。
6. 总量截断令 `truncated=true`。
7. 最终结果必须断言不超过 32 KiB；违反不变量时抛出内部错误，不能返回超限 preview。

省略标记不是命令原始输出，不能计入 `outputBytes` 或 `outputLines`。

## 六、UTF-8 安全截断

共享模块提供：

```ts
takeUtf8Prefix(text: string, maxBytes: number): string;
takeUtf8Suffix(text: string, maxBytes: number): string;
```

实现要求：

- 输入和输出均为 JavaScript 字符串。
- 按 Unicode code point 遍历，使用 `Buffer.byteLength(character, "utf8")` 计算预算。
- prefix 从前向后累计完整 code point。
- suffix 从后向前识别完整 surrogate pair，再累计 UTF-8 字节。
- 只在已经确定的 code point 边界调用字符串 `slice()`。
- 不使用 `Buffer.slice()` 截取文本。
- 不使用 `text.split("")`、直接字符串下标或任意 UTF-16 code-unit 位置作为截断边界。
- `text.split(/\r\n|\n|\r/)` 只负责识别换行边界，可以继续使用。
- helper 返回值必须满足 `Buffer.byteLength(result, "utf8") <= maxBytes`。

组合字符和 ZWJ emoji 可以在 code point 之间截断，但不得产生孤立 surrogate。

## 七、代码改动边界

### 7.1 新增共享实现

新增 `src/tools/bounded-output-preview.ts`，负责：

- preview 常量；
- UTF-8 prefix/suffix helper；
- 单行压缩；
- 行数窗口和总字节窗口渲染；
- `truncated`、`omittedLines` 汇总；
- 最终字节不变量检查。

常量不作为 public config 暴露。它们是 Tinker 的模型输入安全边界，所有 profile 使用同一值。

### 7.2 `src/tools/task-output.ts`

- 保留当前 stdout/stderr 流式写文件、字节计数、行数计数和内存数据结构。
- `snapshot()` 不再自行拼接最终 preview。
- 将当前候选行、`outputLines` 和已有行数窗口信息交给共享 renderer。
- 运行中的非 PTY `TaskOutput` snapshot 也必须满足 32 KiB 不变量。

### 7.3 `src/tools/task-output-snapshot.ts`

- 保留当前完成输出的解码和逻辑行拆分。
- 删除本文件内重复的 200/100 行 preview 拼接逻辑。
- 将逻辑行交给共享 renderer。

### 7.4 其他调用方

- `src/tools/bash.ts` 继续消费 `TaskOutputSnapshot`，不另做截断。
- `src/tools/task-output-tool.ts` 继续透传 snapshot 字段。
- `src/observation/observation-builder.ts` 继续渲染 `raw.preview`，不增加第二次截断。
- 在 Bash 和 TaskOutput observation 的测试中断言最终 preview 不超过共享常量。

## 八、兼容性与持久化

- 不修改 SessionStore schema。
- 不修改 `TaskOutputSnapshot`、`BashRawResult` 或 `TaskOutputRawResult` 的字段集合。
- 不修改公开 tool schema。
- 不修改完整输出文件格式和路径。
- 不改写已有 session 的 canonical observation 或 raw result。
- 新实现只影响修复发布后新产生的 Bash/TaskOutput preview。
- 这是对既有“大输出只进入有界 preview”合同的修复，不引入新的 observation format
  version。

## 九、测试计划

### 9.1 共享 preview 单元测试

新增 `src/__tests__/bounded-output-preview.test.ts`，覆盖：

1. 空输出。
2. 小于所有限制的 ASCII 多行输出逐字保持。
3. 恰好 200 行保持完整。
4. 201 行保留前 100 行和后 100 行，`omittedLines=1`。
5. 单行 1 MiB 且没有换行，最终行和 preview 均在上限内。
6. 80 行、每行 64 KiB 的 JSONL 形状输入，最终 preview 不超过 32 KiB。
7. 少于 200 行但总量超过 32 KiB，触发总量头尾窗口。
8. 超过 200 行但行较短，同时验证行数和总字节省略计数不重复。
9. 中文字符正好落在 prefix/suffix 字节边界。
10. emoji surrogate pair 正好跨越截断位置，结果中不存在孤立 surrogate。
11. CRLF、LF、CR 和无尾换行输入保持现有逻辑行计数。
12. 省略标记计入 8 KiB 单行限制和 32 KiB 总限制。
13. 多次调用相同输入产生完全相同的 preview 和元数据。

### 9.2 工具集成测试

扩展 `src/__tests__/bash-tool.test.ts`：

- 执行生成单行超长输出的真实 Bash 命令。
- 断言完整 `outputFilePath` 的字节数与命令输出一致。
- 断言 `raw.outputBytes` 描述完整输出。
- 断言 `raw.preview` 不超过 32 KiB。
- 断言 `raw.truncated=true`。
- 断言 preview 同时包含原输出头部和尾部。
- 断言 Bash observation 不包含被省略的中间正文。

扩展 `src/__tests__/task-management.test.ts`：

- 后台任务产生超长单行输出。
- 运行中和完成后的 `TaskOutput` 都返回有界 preview。
- 完成后的完整日志仍可读取。
- 相同完整输出经 Bash 完成路径和 TaskOutput 路径生成相同 preview。

### 9.3 回归测试形状

加入不依赖历史 session 文件的确定性 fixture：

```text
80 lines × 64 KiB per line
```

每行使用 JSONL 形状的 ASCII 文本，并在头尾放置不同 marker。测试必须证明：

- 行数小于 200 不能绕过总字节限制；
- 每条超长行不能绕过单行限制；
- 最终 preview 保留整个输出的首尾 marker；
- 最终 preview UTF-8 字节数不超过 32768。

## 十、验收标准

实现完成必须同时满足：

1. 所有非 PTY Bash/TaskOutput preview 均不超过 32 KiB UTF-8。
2. preview 中任一原始输出行的有界表示不超过 8 KiB UTF-8。
3. 输出超过任一限制时 `truncated=true`。
4. `omittedLines` 只统计完全缺失的逻辑行，不把行内截断计为缺失行。
5. 完整输出文件内容、`outputBytes` 和 `outputLines` 不受 preview 截断影响。
6. 单行和整体截断都保留头尾内容并提供明确省略标记。
7. 中文和 emoji 截断不产生孤立 surrogate 或 Tinker 人为制造的替换字符。
8. Bash 完成结果与 TaskOutput 对相同输出使用同一确定性 preview 合同。
9. SessionStore schema、公开 tool schema 和 context revision 行为不变。
10. `bun run check` 通过。

## 十一、实施顺序

1. 新增共享 preview renderer 和 UTF-8 helper，并完成单元测试。
2. 将 `task-output.ts` 接到共享 renderer。
3. 将 `task-output-snapshot.ts` 接到共享 renderer。
4. 增加 Bash 与 TaskOutput 集成回归测试。
5. 更新 `bash-tool-design.md` 和 `observation-current-state.md` 中只按行描述的旧规则。
6. 运行 `bun run check:fast` 迭代验证。
7. 运行唯一完成门禁 `bun run check`。
