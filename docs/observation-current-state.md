# Observation 现状

本文记录当前 Tinker 工具执行结果如何转换成反馈给模型的 Observation。
内容以 `src/tools/`、`src/mcp/`、`src/observation/observation-builder.ts`、
`src/context/protocol-frame.ts` 和现有测试为准。

## 1. Observation 在 agent loop 中的位置

一次工具调用的主要链路如下：

```text
模型返回 assistant.toolCalls
  -> ToolRuntime.execute(call)
  -> ToolRawResult（带 kind 的结构化原始结果）
  -> ObservationBuilder.build({ call, raw })
  -> ToolObservation.content（纯文本）
  -> ledger 写入 role=tool 的消息
  -> 下一次模型请求看到该文本
```

同时，运行时会依次记录 `tool.raw_result`、`tool.finished` 和
`tool.observation` 事件。原始结果供事件日志、TUI 等内部消费者使用；模型实际看到的
是 `ToolObservation.content`，不是原始 JSON，也不是 TUI 的展示文本。

当前 Observation 协议版本为 `tool-observation-v2`。一个 assistant 消息若包含多个
tool call，运行时会按顺序执行并逐个提交 tool message；全部闭合后才发起下一次模型
请求。

## 2. 当前工具面

默认内建工具如下：

| 工具名 | raw `kind` | 是否总是注册 | 主要用途 |
| --- | --- | --- | --- |
| `Glob` | `glob` | 是 | 按 glob 查找文件 |
| `Grep` | `grep` | 是 | 用 ripgrep 搜索内容 |
| `Read` | `read` | 是 | 按行读取文件，并建立文件快照 |
| `Recall` | `recall` | 是 | 搜索或读取当前 session 的历史模型可见内容 |
| `Write` | `write` | 是 | 写入完整文件 |
| `Edit` | `edit` | 是 | 精确字符串替换 |
| `Bash` | `bash` | 是 | 前台或后台执行 shell 命令 |
| `TaskList` | `task_list` | 是 | 列出后台 Bash 任务 |
| `TaskOutput` | `task_output` | 是 | 查看后台任务当前输出 |
| `TaskStop` | `task_stop` | 是 | 停止后台任务 |
| `WebSearch` | `web_search` | 有非空 `EXA_API_KEY` 时 | Exa Web 搜索 |
| `WebFetch` | `web_fetch` | 是 | 获取并按需提炼网页内容 |

MCP server 连接成功后，其工具会动态注册为 `mcp__<server>__<tool>`，所有 MCP
工具的 raw `kind` 都是 `mcp`。注册表禁止同名覆盖；内建工具或 MCP 工具重名会在
注册时直接报错。

## 3. 通用结果和失败规则

`ToolRawResult` 是按 `kind` 区分的联合类型。每个具体 executor 通过
`defineToolExecutor(kind, executor)` 自动补上 `kind`，而
`ObservationBuilder` 对所有 kind 做穷尽分派。增加新 kind 时，如果没有同步增加
Observation 分支，TypeScript 会在 `assertNever` 处暴露问题。

### 3.1 普通失败仍是有效 Observation

以下情况由 `ToolRuntime` 转成 `kind: "generic", ok: false`：

- provider 给出的工具参数 JSON 无法解析；
- 调用了未注册工具；
- executor 抛出普通异常，而不是 fatal error 或取消。

模型看到的格式统一为：

```text
<toolName> failed: <error>
```

例如：

```text
Read failed: Invalid tool arguments JSON: Unexpected token } in JSON
```

```text
Delete failed: Unknown tool: Delete
```

工具自己校验参数、路径或外部响应失败时，通常返回自己的 `kind` 和 `ok: false`，
由对应 renderer 给出更具体的 Observation。无论是这种失败还是 generic 失败，均会
正常写入 `role=tool` 消息，agent loop 可以在下一轮让模型纠正参数或换一种做法。

### 3.2 不经过普通 ObservationBuilder 的合成结果

取消、运行时 fatal failure 和进程中断恢复可能发生在工具没有正常返回时。为了不让
assistant 的 tool calls 悬空，ledger 会生成协议安全的 tool message：

| 情况 | 模型看到的文本 |
| --- | --- |
| 正在执行的工具被用户取消 | `Tool execution was cancelled by the user. Side effects may have partially completed; inspect current state before retrying.` |
| 同批后续调用因取消跳过 | `Tool call was skipped because the user cancelled the turn.` |
| 正在执行的工具发生 fatal failure | `Tool execution failed: <detail>. Side effects may have partially completed; inspect current state before retrying.` |
| 同批后续调用因 fatal failure 跳过 | `Tool call was skipped because an earlier tool call failed.` |
| Tinker 中断时可能正在执行 | `Tinker was interrupted while this tool call may have been running. Its side-effect state is unknown; inspect current state before retrying.` |
| 同批后续调用因中断未执行 | `Tool call was skipped because Tinker was interrupted before it could run.` |

其中 fatal detail 会去掉首尾空白并限制在 2,000 字符。`Recall` 访问必需的 session
历史存储失败，是当前明确使用 `ToolExecutionFatalError` 的场景之一。

## 4. 各工具的 Observation

以下示例中的哈希、路径、任务 ID 等为示意值，但文本结构与当前 renderer 一致。

### 4.1 Glob

成功时输出搜索条件、匹配数、固定忽略目录和排序后的路径列表：

```text
Glob succeeded for pattern="**/*.ts".
searchPath=.
matchCount=2
ignored=node_modules,.git
matches:
src/app.ts
src/index.ts
```

无匹配仍是成功，最后一行为 `(no matches)`。参数非法、路径越界、不存在或不是目录
时为：

```text
Glob failed for pattern="**/*.ts": Path escapes workspace.
```

### 4.2 Grep

Grep 有三种输出模式，Observation 有意保持接近 ripgrep 的文本，避免重复元数据。

`files_with_matches`：

```text
Found 2 files
src/a.ts
src/b.ts
```

无文件时是 `No files found`。

`content`：

```text
src/a.ts:12:const value = "foo";
```

无匹配时是 `No matches found`。

`count`：

```text
src/a.ts:1
src/b.ts:3

Found 4 total occurrences across 2 files.
```

使用分页时追加：

```text
[Showing results with pagination = limit: 20, offset: 20]
```

如果 ripgrep 因输出上限只返回部分结果，且 raw 同时带有 `truncated: true` 和错误
说明，还会追加 `Warning: results are incomplete. <error>`。工具失败为：

```text
Grep failed for pattern="foo": ripgrep is required. Install rg and ensure it is available on PATH.
```

### 4.3 Read

成功 Observation 包含内容哈希、文件总大小、总行数、实际行范围和正文：

```text
Read succeeded for src/app.ts.
sha256=0123456789abcdef...
sizeBytes=4210
totalLines=138
displayed=lines 21-40
content:
export function run() {
  // ...
}
```

默认最多展示 20,000 bytes。超限时 `displayed` 后追加：

```text
Content was truncated to 20000 displayed bytes.
```

注意：`sizeBytes` 和 `totalLines` 仍描述完整文件，`sha256` 也是完整文件哈希。只有
读取了完整文件，快照才会标记为 `fullFile`，这会影响后续 Write/Edit 的并发保护。

失败示例：

```text
Read failed for missing.ts: ENOENT: no such file or directory
```

### 4.4 Write

成功只向模型反馈写入规模和变更前后哈希；raw 中给 TUI/日志使用的 diff 不会进入
Observation：

```text
Write succeeded for src/app.ts.
bytesWritten=128
oldSha256=aaaa...
newSha256=bbbb...
```

新文件的 `oldSha256=null`。若目标文件已存在但没有基于当前版本完成必要的 Read，
失败文本会带操作指引：

```text
Write failed for src/app.ts: Existing file must be read before Write. Call Read on this file before trying Write again.
```

文件在上次 Read 后发生变化时，executor 自己的错误已经包含重新读取指引，因此不会
再追加上述固定提示：

```text
Write failed for src/app.ts: File changed after the last successful Read. Read it again before Write.
```

其他失败也不会追加该指引：

```text
Write failed for src/app.ts: Path escapes workspace.
```

### 4.5 Edit

成功反馈替换次数、是否 `replace_all`、是否创建文件及哈希：

```text
Edit succeeded for src/app.ts.
bytesWritten=144
replacementCount=2
replaceAll=true
created=false
oldSha256=aaaa...
newSha256=bbbb...
```

并发保护失败会明确要求完整 Read：

```text
Edit failed for src/app.ts: File must be read completely before Edit. Call Read on the full file before trying Edit again.
```

文件在上次完整 Read 后变化时，错误本身会要求再次 Read，但不追加固定提示。旧字符
串找不到、不唯一但未启用 `replace_all`、参数错误或路径错误，也使用
`Edit failed for <path>: <error>`，但不附加 Read 指引。

### 4.6 Bash

Bash 的 `ok` 不简单等同于 exit code 是否为 0。部分命令的非零返回码是有效业务
结果，例如 `grep` 的 1 可解释为 `No matches found.`，`diff` 的 1 可解释为
`Files differ.`；此时状态仍可为 `completed`。

前台完成：

```text
Bash completed.
command=bun test
exitCode=0
status=completed
cwd=/workspace
outputFilePath=/workspace/.tinker/bash/task-.../output.log
outputBytes=48
outputLines=2
truncated=false
preview:
2 pass
0 fail
```

命令失败时主体结构相同，但首行为 `Bash failed.`，并可包含 `error=<...>`；被停止
时首行为 `Bash killed.`。若存在特定返回码解释，会在 preview 前加入：

```text
returnCodeInterpretation=No matches found.
```

preview 超过 200 行时保留前 100 行和后 100 行，并提供：

```text
truncated=true
omittedLines=37
preview:
<lines 1-100>
... output omitted: lines 101-137 (37 lines). Full output is available at outputFilePath.
<lines 138-237>
```

省略提示给出完整的 1-based 行范围。模型可以直接用 `Read` 对
`outputFilePath` 设置 `offset=101, limit=37`，只补读缺失部分。

显式后台运行：

```text
Bash command is running in background.
taskId=task-...
command=bun run dev
cwd=/workspace
outputFilePath=/workspace/.tinker/bash/task-.../output.log
Use Read on outputFilePath to inspect current output.
```

超过前台等待时间但进程仍在运行：

```text
Bash command exceeded foreground timeout and is still running.
taskId=task-...
timeoutMs=10000
command=bun run dev
cwd=/workspace
outputFilePath=/workspace/.tinker/bash/task-.../output.log
Use Read on outputFilePath to inspect current output.
```

如果在创建 task 之前参数校验或启动就失败，`taskId` 为空，模型只看到：

```text
Bash failed: Bash.command must be a non-empty string.
```

### 4.7 TaskList

无任务：

```text
Background tasks: 0 total, 0 running.

(no background tasks)
```

有任务时，每个任务是一个段落：

```text
Background tasks: 1 total, 1 running.

taskId=task-...
description=dev server
status=running
startedAt=2026-07-12T00:00:00.000Z
outputFilePath=/workspace/.tinker/bash/task-.../output.log
```

已结束任务还会按实际存在的字段显示 `endedAt`、`exitCode`、`signal` 或 `error`。
失败格式为 `TaskList failed: <error>`。

### 4.8 TaskOutput

成功：

```text
Task output retrieved.
taskId=task-...
status=running
command=bun run dev
outputFilePath=/workspace/.tinker/bash/task-.../output.log
outputBytes=15
outputLines=1
truncated=false
preview:
server ready
```

输出超过 200 行时同样保留前 100 行和后 100 行，并通过
`... output omitted: lines <start>-<end> (<count> lines). ...` 明确缺失范围；
`omittedLines` 保存缺失行数。未知 task ID 或参数错误为：

```text
TaskOutput failed for missing-task: Unknown task ID: missing-task
```

### 4.9 TaskStop

成功：

```text
Task stopped.
taskId=task-...
status=killed
signal=SIGTERM
escalated=false
endedAt=2026-07-12T00:01:00.000Z
outputFilePath=/workspace/.tinker/bash/task-.../output.log
```

若 SIGTERM 后升级到 SIGKILL，raw 的 task signal 为 `SIGKILL`，同时
`escalated=true`。不存在、已经结束或参数错误时：

```text
TaskStop failed for missing-task: Unknown task ID: missing-task
```

### 4.10 WebSearch

WebSearch 只有配置了 Exa API key 才会出现在模型工具定义中。成功结果按序号展示；
highlight 会折叠多余空白：

```text
Web search results for query "bun 2.0 release notes" (1 result):

1. Bun 2.0 released
   URL: https://bun.sh/blog/bun-v2
   Published: 2026-06-01T00:00:00.000Z
   - Bun 2.0 ships a faster runtime.
```

标题为空时用 URL 代替标题。零结果为：

```text
Web search results for query "no hits" (0 results):

(no results)
```

参数、网络、HTTP、非 JSON 或响应结构错误统一为：

```text
WebSearch failed for query="no hits": Exa /search returned HTTP 429
```

raw 中的 request ID、费用、耗时、domain filters 等不会进入模型 Observation。

### 4.11 WebFetch

成功内容：

```text
Web fetch result for https://bun.sh/docs (route=exa, refined=false):

Title: Bun Docs

# Install
Run bun install.
```

`route` 可能是 `local`、`exa` 或 `local-browser`。大页面经过提炼时
`refined=true`；若后端还提供 highlights，会追加：

```text
Highlights:
- first relevant excerpt
- second relevant excerpt
```

跨 host redirect 不会自动跟随，而是返回一个成功 Observation，让模型显式决定：

```text
WebFetch was redirected to https://other.example.com/page.
The redirect crosses hosts, so it was not followed automatically.
Call WebFetch again with this URL if the redirect target is expected.
```

参数错误、HTTP 错误、无可读内容、页面过大但没有 refiner、提炼失败等均为：

```text
WebFetch failed for https://bun.sh/gone: Exa could not fetch the page: CRAWL_NOT_FOUND (HTTP 404).
```

raw 中的最终 URL、cache hit、HTTP status、费用、耗时和 error tag 不会单独展示给
模型，除非它们已经被写进 `error` 文本。

### 4.12 Recall

Recall 的内容是当前 session 的历史快照，不代表当前工作区状态。Observation 会反复
标记这一点。

搜索成功的头部：

```text
Recall searched historical session data.
historical=true
query="EACCES"
strategy=fts5_trigram
snapshotThroughOrdinal=42
offset=0
limit=10
nextOffset=null
matchesReturned=1
```

随后每条命中包含 `source`、`role`、可选 `toolName`、turn/ordinal、时间、内容哈希
和 excerpt。零命中时会明确提示“没有找到”并不证明信息不存在。

按 source 获取成功：

```text
Recall retrieved historical session data.
historical=true
source=ctx://message/019...
role=tool
toolName=Read
turnNumber=3
ordinal=17
createdAt=2026-07-12T00:00:00.000Z
contentSha256=aaaa...
totalBytes=15000
byteOffset=0
returnedBytes=12000
nextByteOffset=12000
currentWorkspaceGuidance=Use Read/Grep to verify current files; this content is historical.
content:
<historical content>
```

可恢复失败带稳定 error code：

```text
Recall get failed (RECALL_SOURCE_NOT_FOUND): Historical source was not found.
```

error code 包括 `RECALL_ARGS_INVALID`、`RECALL_SOURCE_INVALID`、
`RECALL_SOURCE_NOT_FOUND`、`RECALL_PAGE_INVALID`、`RECALL_SNAPSHOT_INVALID`。
底层 session 存储失败则是 fatal failure，不走上述普通失败模板。

### 4.13 MCP 工具

MCP 成功时尽量原样把 server 返回的 text 交给模型：

```text
hello
```

非文本 content block 会转换成占位符，例如：

```text
first
[image image/png content omitted]
[resource link https://example.com/data]
second
```

resource block 自带 text 时会保留该 text。没有文本时：

```text
(no text content, 1 content block)
```

默认最多 40,000 characters，截断后追加：

```text
[Output truncated to 40000 characters.]
```

server 正常响应但声明 `isError: true`：

```text
mcp__browser__click failed (server reported error):
element not found
```

参数不是 object、transport/timeout 或 client 调用抛错：

```text
mcp__browser__click failed: timeout
```

## 5. 当前设计特征和边界

1. **模型只看文本。** raw result 中有不少对日志、事件、TUI 很有用的信息，没有进入
   Observation。例如 Write/Edit diff、Web 请求费用和耗时。这是当前实现事实，不表示
   这些字段不重要。
2. **成功不等于“有内容”。** Glob/Grep/WebSearch 的零命中是成功；MCP 无文本也可
   成功；WebFetch 的无可读正文则是失败。
3. **失败通常可恢复。** 参数、路径、命令、网络和 MCP server error 都以 tool
   message 返回，让模型继续推理。只有明确的 fatal storage/runtime 问题会终止 turn。
4. **副作用不做虚假保证。** 工具被取消、fatal failure 或进程中断时，合成文本会
   提醒模型先检查当前状态再重试。
5. **截断策略不统一。** Read 按 bytes；Bash/TaskOutput 按行预览；MCP 按
   characters；Grep 同时可能受分页和 ripgrep 输出上限影响；WebFetch 对大正文采用
   refiner，而不是简单截断。
6. **`call` 当前不参与文案生成。** `ObservationBuilder.build` 接收 `call`，但现有
   renderer 都只根据带 kind 的 raw result 生成内容。tool call 身份由 ledger 和协议
   message 元数据保存，不重复写进 Observation 文本。

## 6. 修改 Observation 时需要同步检查的地方

- `src/tools/types.ts`：raw result 的结构和 `kind` 联合类型；
- 对应的 `src/tools/*.ts` 或 `src/mcp/mcp-tool-executor.ts`：结果产生端；
- `src/observation/observation-builder.ts`：正常返回结果的模型可见文本；
- `src/context/protocol-frame.ts`：取消、fatal failure、中断等合成文本；
- `src/agent/loop.ts` 与 `src/agent/session-ledger.ts`：提交顺序和协议闭合；
- 对应 `src/__tests__/*`：以精确字符串或关键字段固定当前行为。

对新增工具，推荐继续遵循当前 fast-fail 风格：先在 executor 边界校验参数和前置
条件，返回信息明确的结构化失败；再由 Observation renderer 给模型简洁、可行动的
文本。若失败意味着 session 的持久化或协议完整性已不可信，应显式使用 fatal error，
不要伪装成可继续的普通 `ok: false`。
