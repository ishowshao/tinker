# Grep Tool 设计方案

## 背景

`tinker` 当前已经有一个最小 ReAct loop、`Read` / `Write` /
`Edit` / `Glob` / `Bash` 工具、JSONL event log、human-readable
observation log、TUI event stream 和 `tinker run` 非交互入口。

下一阶段需要加入一个模型可调用的 `Grep` 工具，让 agent 能稳定搜索文件内容，
并把结果以受控、可分页、可直接交给 `Read` 使用的形式返回给模型。

`Grep` 的公开工具名和参数形态本身是 prompt surface，应保持稳定。runtime
内部可以继续使用 tinker 当前的轻量 `ToolExecutor`、workspace 路径安全和
observation 构建方式。

## 目标

- 模型可以通过 `Grep` 搜索 workspace 内文件内容。
- `Grep` 基于 ripgrep 执行，支持正则、glob 过滤、文件类型过滤和大小写选项。
- 默认返回匹配文件列表，避免一开始就把大量匹配行塞进上下文。
- 支持 `content`、`files_with_matches`、`count` 三种输出模式。
- 支持 `head_limit` 和 `offset`，让模型可以分页探索大结果集。
- 返回 workspace-relative 路径，使结果可以直接传给 `Read`。
- 搜索路径必须限制在 workspace 内，路径逃逸应 fast-fail。
- ripgrep exit code `1` 表示无匹配，不应算作工具失败。
- TUI、stdout event printer、observation log 都能显示清楚的搜索摘要。

## 非目标

- 不做权限审批、人类确认或持久化 deny / ask / allow 规则。
- 不做独立索引、repo map、语义检索或缓存。
- 不把 `Grep` 做成 `Bash` 的薄包装。
- 不在第一版引入 bundled / embedded ripgrep 发行链。
- 不在第一版兼容 workspace 外搜索。
- 不自动读取匹配文件全文；模型需要细节时应再调用 `Read`。
- 不在第一版实现并发 tool 调度或搜索流式输出。

## Tool Schema

模型可见 schema：

```ts
{
  name: "Grep",
  description: "Search file contents in the local workspace with ripgrep.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: {
        type: "string",
        description: "The regular expression pattern to search for in file contents."
      },
      path: {
        type: "string",
        description: "Optional workspace-relative file or directory to search in. Defaults to the current workspace-local cwd."
      },
      glob: {
        type: "string",
        description: "Glob pattern to filter files, such as \"*.js\" or \"**/*.tsx\"."
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Output mode. Defaults to \"files_with_matches\"."
      },
      "-B": {
        type: "integer",
        minimum: 0,
        description: "Number of lines to show before each match. Only applies to output_mode=\"content\"."
      },
      "-A": {
        type: "integer",
        minimum: 0,
        description: "Number of lines to show after each match. Only applies to output_mode=\"content\"."
      },
      "-C": {
        type: "integer",
        minimum: 0,
        description: "Alias for context."
      },
      context: {
        type: "integer",
        minimum: 0,
        description: "Number of lines to show before and after each match. Only applies to output_mode=\"content\"."
      },
      "-n": {
        type: "boolean",
        description: "Show line numbers in content output. Defaults to true."
      },
      "-i": {
        type: "boolean",
        description: "Case insensitive search."
      },
      type: {
        type: "string",
        description: "File type to search, such as js, ts, py, rust, go, or java."
      },
      head_limit: {
        type: "integer",
        minimum: 0,
        description: "Limit output to first N lines or entries. Defaults to 250. Pass 0 for unlimited."
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Skip first N lines or entries before applying head_limit. Defaults to 0."
      },
      multiline: {
        type: "boolean",
        description: "Enable multiline mode where dot matches newlines. Defaults to false."
      }
    },
    required: ["pattern"]
  }
}
```

参数语义：

- `pattern`: 必填。ripgrep 正则表达式。
- `path`: 可选。workspace-relative 文件或目录，也允许 workspace 内绝对路径。
  未提供时使用当前 workspace-local cwd，初始为 workspace root。
- `glob`: 可选。映射到 `rg --glob`，支持空格或逗号分隔多个 pattern。
- `output_mode`: 可选。默认 `files_with_matches`。
- `-B` / `-A` / `-C` / `context`: 只在 `content` 模式生效。
- `context` 优先级高于 `-C`，`-C` 优先级高于 `-B` / `-A`。
- `-n`: 可选。`content` 模式默认显示行号。
- `-i`: 可选。大小写不敏感搜索。
- `type`: 可选。映射到 `rg --type`。
- `head_limit`: 可选。默认 `250`；`0` 表示不限制，应谨慎使用。
- `offset`: 可选。默认 `0`。
- `multiline`: 可选。为 `true` 时启用 `rg -U --multiline-dotall`。

## 系统提示约束

加入 `Grep` 后，`SYSTEM_PROMPT` 需要更新：

- 使用 `Grep` 搜索文件内容，不要通过 `Bash` 调用 `grep` 或 `rg` 做常规内容搜索。
- 使用 `Glob` 查找文件名或路径 pattern。
- 使用 `Read` 打开 `Grep` 返回的具体文件。
- 默认先用 `files_with_matches` 缩小范围，需要上下文时再用 `content`。
- 大结果集使用 `head_limit` / `offset` 分页，不要一次性请求无限输出。
- 读文件仍优先使用 `Read`，不要用 `cat` 读取大文件。

## 执行模型

第一版使用 Node/Bun 的 `child_process.execFile` 调用系统 `rg`。如果找不到可用
`rg`，工具应直接失败并返回明确错误：

```text
ripgrep is required. Install rg and ensure it is available on PATH.
```

建议结构：

```text
src/tools/grep.ts
  createGrepToolExecutor()
  parseGrepArgs()
  buildRipgrepArgs()
  applyHeadLimit()
  render / parse output helpers

src/tools/ripgrep.ts
  findRipgrepCommand()
  ripGrep()
  EAGAIN single-thread retry
  timeout / buffer handling
```

工具执行流程：

```text
Grep.execute(args)
  -> parse and validate args
  -> resolve search path inside workspace
  -> ensure path exists and is file or directory
  -> build rg args
  -> execute ripGrep(args, absoluteSearchPath)
  -> normalize absolute paths to workspace-relative paths
  -> apply output_mode handling
  -> apply head_limit / offset
  -> return GrepRawResult
```

`rg` 参数组装：

```text
--hidden
--max-columns 500
--glob !.git
--glob !.svn
--glob !.hg
--glob !.bzr
--glob !.jj
--glob !.sl
--glob !node_modules
--glob !.tinker
```

附加规则：

- `output_mode="files_with_matches"` 时加 `-l`。
- `output_mode="count"` 时加 `-c`。
- `output_mode="content"` 且 `-n !== false` 时加 `-n`。
- `multiline=true` 时加 `-U --multiline-dotall`。
- `-i=true` 时加 `-i`。
- `type` 存在时加 `--type <type>`。
- `glob` 存在时每个 pattern 加 `--glob <pattern>`。
- `pattern` 以 `-` 开头时必须用 `-e <pattern>`，避免被当作命令选项。

## ripgrep 封装

`ripGrep()` 返回 stdout 按行拆分后的字符串数组。

退出码语义：

| exit code | 语义 | tool ok |
| --- | --- | --- |
| `0` | 找到匹配 | `true` |
| `1` | 无匹配 | `true` |
| 其他 | ripgrep 错误、参数错误或执行失败 | `false` |

第一版建议：

- 默认 timeout 使用 `20_000` ms。
- 通过 `TINKER_GREP_TIMEOUT_MS` 允许调整 timeout。
- stdout buffer 默认上限 `20_000_000` bytes。
- 通过 `TINKER_GREP_MAX_BUFFER_BYTES` 允许调整 buffer。
- 遇到 EAGAIN / `Resource temporarily unavailable` 时重试一次，并加 `-j 1`。
- timeout 且没有任何可用结果时返回失败，提示模型缩小 `path`、`glob` 或 `pattern`。
- timeout 或 buffer overflow 但已有完整行结果时可以返回部分结果，并通过
  `truncated=true` 或 error summary 告知结果不完整。

## Raw Result

新增类型：

```ts
export type GrepOutputMode = "content" | "files_with_matches" | "count";

export type GrepRawResult = {
  ok: boolean;
  pattern: string;
  searchPath: string;
  absoluteSearchPath?: string;
  mode: GrepOutputMode;
  filenames: string[];
  numFiles: number;
  content?: string;
  numLines?: number;
  numMatches?: number;
  appliedLimit?: number;
  appliedOffset?: number;
  ignored?: string[];
  truncated?: boolean;
  error?: string;
};
```

字段语义：

- `pattern`: 原始搜索正则。
- `searchPath`: workspace-relative 搜索路径。
- `absoluteSearchPath`: 调试和 JSONL 记录用，observation 可以不强调。
- `mode`: 实际输出模式。
- `filenames`: 匹配文件的 workspace-relative 路径列表。
- `numFiles`: 当前返回结果中的文件数量。
- `content`: `content` 或 `count` 模式下返回给模型的文本。
- `numLines`: `content` 模式下返回的行数。
- `numMatches`: `count` 模式下当前返回页的匹配总数。
- `appliedLimit`: 实际发生截断时记录使用的 limit。
- `appliedOffset`: `offset > 0` 时记录。
- `ignored`: 自动排除项，例如 `node_modules`、`.git`、`.tinker`。
- `truncated`: timeout、buffer overflow 或分页导致结果不完整时为 `true`。
- `error`: 失败原因或部分结果警告。

## 输出模式

### files_with_matches

默认模式。`rg -l` 返回文件路径。

处理规则：

1. 对结果去重。
2. 按文件 mtime 降序排序，mtime 相同则按路径排序。
3. 测试环境中按路径排序，保证断言稳定。
4. 应用 `offset` 和 `head_limit`。
5. 转成 workspace-relative 路径。

模型 observation：

```text
Found 3 files
src/a.ts
src/b.ts
src/c.ts
```

无匹配：

```text
No files found
```

### content

`content` 模式返回匹配行。默认包含行号。

处理规则：

1. 只在该模式下应用 `-n`、`-A`、`-B`、`-C`、`context`。
2. 先应用 `offset` 和 `head_limit`，再做路径 relativize。
3. 每行保持 ripgrep 输出格式：

```text
src/file.ts:12:matching line
```

模型 observation：

```text
src/file.ts:12:matching line

[Showing results with pagination = limit: 250]
```

无匹配：

```text
No matches found
```

### count

`count` 模式返回每个文件的匹配次数。

处理规则：

1. `rg -c` 输出形如 `<path>:<count>`。
2. 应用 `offset` 和 `head_limit`。
3. 转成 workspace-relative 路径。
4. 解析当前页的 count，生成 `numMatches` 和 `numFiles`。

模型 observation：

```text
src/a.ts:2
src/b.ts:5

Found 7 total occurrences across 2 files.
```

无匹配：

```text
No matches found
```

## 分页

默认 `head_limit=250`。

分页函数：

```ts
function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset = 0,
): { items: T[]; appliedLimit?: number } {
  if (limit === 0) {
    return { items: items.slice(offset) };
  }

  const effectiveLimit = limit ?? 250;
  const itemsPage = items.slice(offset, offset + effectiveLimit);
  const wasTruncated = items.length - offset > effectiveLimit;

  return {
    items: itemsPage,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  };
}
```

只有真正发生截断时才设置 `appliedLimit`，避免 observation 出现没有意义的
`limit: undefined`。

## 路径策略

`Grep` 必须沿用 workspace 路径安全策略：

- 相对 `path` 以 workspace root 为基准解析。
- workspace 内绝对路径允许使用。
- workspace 外绝对路径或 `..` 逃逸应拒绝。
- 未提供 `path` 时使用当前 Bash cwd；如果当前 cwd 不在 workspace 内，fast-fail。
- 输出路径统一转成 workspace-relative。

`path` 可以是文件或目录：

- 文件：只搜索该文件。
- 目录：递归搜索目录。
- 不存在：返回失败。
- 其他类型：返回失败。

## Observation

`ObservationBuilder` 需要新增 `Grep` 分支。

失败 observation：

```text
Grep failed for pattern="foo": <error>
```

`files_with_matches` observation：

```text
Found 2 files
src/a.ts
src/b.ts
```

`content` observation：

```text
src/a.ts:10:foo()
src/b.ts:22:foo()
```

`count` observation：

```text
src/a.ts:1
src/b.ts:3

Found 4 total occurrences across 2 files.
```

分页信息追加在结果末尾：

```text
[Showing results with pagination = limit: 250, offset: 250]
```

## TUI 和日志

TUI event store 需要识别 `Grep`：

- started: `Grep <pattern>`
- finished raw summary:
  - `files_with_matches`: `Grep <pattern> -> N files`
  - `content`: `Grep <pattern> -> N lines`
  - `count`: `Grep <pattern> -> N matches across M files`

`StdoutEventPrinter` 的 tool line 可以显示：

```text
tool.started name=Grep pattern=<pattern>
tool.finished name=Grep pattern=<pattern> ok=true
```

`ObservationTextLog` 已经会记录 tool observation；只需要 tool call summary
继续显示 `Pattern: <pattern>` 即可。

## 接入点

需要修改：

```text
src/tools/grep.ts
src/tools/ripgrep.ts
src/tools/types.ts
src/tools/registry.ts
src/observation/observation-builder.ts
src/cli/config.ts
src/tui/event-store.ts
src/events/stdout-event-printer.ts
src/__tests__/tools.test.ts
src/__tests__/tui-event-store.test.ts
src/__tests__/tui-components.test.tsx
src/__tests__/config.test.ts
```

可选修改：

```text
docs/agent-loop-mvp-tech-plan.md
docs/bash-tool-design.md
```

如果只是加入 `Grep` 实现，优先不改历史设计文档，避免扩大文档 churn。

## 实现步骤

第一步：ripgrep 封装

- 新增 `src/tools/ripgrep.ts`。
- 实现 PATH 查找、`execFile` 调用、timeout、buffer 上限。
- 处理 exit code `0` / `1`。
- 增加 EAGAIN 单线程重试。

第二步：Grep executor

- 新增 `src/tools/grep.ts`。
- 实现 strict 参数解析。
- 实现 workspace path resolve 和 path stat。
- 实现 rg args 组装。
- 实现三种输出模式。
- 实现分页和 workspace-relative 输出。

第三步：注册和类型

- 在 `src/tools/types.ts` 加 `GrepRawResult`。
- 在 `ToolRawResult` union 中加入 `GrepRawResult`。
- 在 `src/tools/registry.ts` 注册 `createGrepToolExecutor()`。
- 若 `Grep` 默认搜索当前 Bash cwd，需要把 `cwdState` 传入 executor。

第四步：observation 和 UI

- 在 `ObservationBuilder` 中新增 `renderGrepObservation()`。
- 在 TUI event store 中新增 `Grep` started 和 raw result summary。
- 在 stdout event printer 中显示 `pattern`。

第五步：系统提示

- 更新 `SYSTEM_PROMPT`，指导内容搜索优先使用 `Grep`。
- 保留 `Glob` 用于路径搜索，`Read` 用于打开具体文件。

第六步：测试和验证

- 补齐单元测试。
- 运行 `bun run check`。

## 测试计划

工具行为测试：

- registry 暴露 `Grep` schema，且 `additionalProperties=false`。
- 默认 `files_with_matches` 返回 workspace-relative 文件路径。
- `content` 模式返回匹配行和行号。
- `count` 模式返回每个文件计数和总匹配数。
- `head_limit` / `offset` 分页生效。
- `glob` 过滤生效。
- `type` 过滤生效。
- `-i` 大小写不敏感生效。
- `multiline` 可匹配跨行内容。
- `context` / `-C` / `-A` / `-B` 只在 `content` 模式生效。
- pattern 以 `-` 开头时仍能搜索。
- 无匹配时 `ok=true`，并返回空结果。
- ripgrep 不存在时 `ok=false`，错误信息明确。
- `path` 逃逸被拒绝。
- `path` 不存在被拒绝。
- `node_modules`、`.git`、`.tinker` 默认被忽略。

Observation 测试：

- `files_with_matches` 输出 `Found N files` 或 `No files found`。
- `content` 输出匹配行或 `No matches found`。
- `count` 输出 count 行和总数摘要。
- 分页时显示 `limit` / `offset`。

TUI / event 测试：

- `tool.started` 显示 `Grep <pattern>`。
- `tool.raw_result` 后显示文件数、行数或匹配数摘要。
- stdout event printer 显示 `pattern=<pattern>`。

系统提示测试：

- `SYSTEM_PROMPT` 包含使用 `Grep` 搜索内容的指导。
- `SYSTEM_PROMPT` 仍保留 `Glob`、`Read`、`Edit`、`Bash` 的职责边界。

最终验证：

```bash
bun run check
```

另需用搜索命令确认本文档不包含外部参考项目名称。
