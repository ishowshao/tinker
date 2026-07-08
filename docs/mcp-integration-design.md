# MCP 接入设计方案

## 背景

`tinker` 当前已经有一个最小 ReAct loop、`Read` / `Write` / `Edit` / `Glob` /
`Grep` / `Bash` 工具、JSONL event log、observation log、TUI event stream 和
`tinker run` 非交互入口。所有工具都实现统一的 `ToolExecutor` 接口，由
`ToolRegistry` 收集、`ToolRuntime` 分发、`ObservationBuilder` 渲染成回传给
模型的文本。

下一阶段需要支持 MCP（Model Context Protocol），让 tinker 可以接入外部
MCP server 提供的工具，例如 playwright mcp、chrome devtools mcp 这类本地
开发工具。核心思路是把每个 MCP tool 适配成一个普通的 `ToolExecutor` 并注册
进现有 `ToolRegistry`，agent loop、模型层和事件系统不感知 MCP 的存在。

## 目标

- 通过 workspace 根目录的 `.mcp.json` 配置 MCP server 列表。
- 支持 stdio transport：按配置启动子进程并通过 stdio 通信。
- 启动时连接所有配置的 server，拉取工具列表，把每个 MCP tool 注册为
  `mcp__<server>__<tool>` 形式的工具。
- MCP tool 的 `inputSchema` 直接作为模型可见的 JSON Schema 参数。
- 工具调用结果中的 text content 渲染成 observation 回传给模型，超大输出
  必须截断。
- 某个 server 连接失败不影响整个 run；发出事件并跳过该 server。
- run 结束时关闭所有连接并回收子进程。
- TUI、stdout event printer、observation log 能显示 MCP 工具调用摘要。

## 非目标

- 不做 Streamable HTTP / SSE transport（本项目只需要本地 stdio server）。
- 不做 MCP resources、prompts、sampling、roots、elicitation。
- 不处理 `tools/list_changed` 通知；工具列表在连接时确定，run 中不变。
- 不做 OAuth 或其他远程认证。
- 不做权限审批、人类确认或 allow / deny 规则。
- 不做 server 健康检查、自动重连或懒加载（首次调用才启动）。
- 不在第一版渲染 image / audio / resource content，遇到时降级为占位说明。

## 依赖

使用官方 TypeScript SDK `@modelcontextprotocol/sdk`：

- `Client` + `StdioClientTransport` 作为客户端。
- 测试中使用 `Server` + `InMemoryTransport.createLinkedPair()` 搭建进程内
  假 server，避免真实子进程。
- stdio 集成测试使用 `Server` + `StdioServerTransport` 写一个 fixture
  server 脚本，由 `bun` 启动。

## 配置文件

配置文件为 `<workspaceRoot>/.mcp.json`，格式与主流 agent 生态兼容：

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "env": { "DEBUG": "1" }
    }
  }
}
```

规则：

- 文件不存在时视为未配置 MCP，正常运行。
- 文件存在但 JSON 非法或结构不符合预期时 fast-fail，错误信息指向具体字段。
- server 名必须匹配 `/^[a-zA-Z][a-zA-Z0-9_-]*$/`，且不允许包含 `__`，
  避免与 `mcp__<server>__<tool>` 命名产生歧义。
- `command` 必填字符串；`args` 可选字符串数组；`env` 可选字符串到字符串
  的映射；`cwd` 可选字符串。
- `env` 合并在 SDK 默认环境变量之上传给子进程。
- `type` 字段可选；仅接受 `"stdio"`，其他值 fast-fail 并提示当前只支持
  stdio。

## 工具命名与 Schema

每个 MCP tool 注册为：

```text
mcp__<serverName>__<toolName>
```

例如 playwright 的 `browser_click` 注册为 `mcp__playwright__browser_click`。
前缀保证不与内置工具冲突，也不在不同 server 之间冲突。

`ToolDefinition` 映射：

- `name`: 前缀后的完整名。
- `description`: MCP tool 的 `description`，缺失时使用
  `MCP tool <toolName> from server <serverName>`。
- `parameters`: MCP tool 的 `inputSchema`，做轻度清洗：
  - 删除顶层 `$schema` 字段；
  - `inputSchema` 缺失或 `type` 不是 `"object"` 时替换为
    `{ "type": "object", "properties": {} }`。

同一 server 返回重名 tool 时保留第一个并忽略后续；不同 server 之间因前缀
天然隔离。

## 生命周期

```text
runner 启动
  -> loadMcpConfig(workspaceRoot)
  -> 无配置: 跳过, 零开销
  -> 有配置: createMcpManager(config, eventSink)
       对每个 server:
         -> StdioClientTransport 启动子进程
         -> client.connect + listTools
         -> 成功: 发 mcp.server.connected 事件, 注册工具
         -> 失败: 发 mcp.server.failed 事件, 跳过该 server
  -> 把所有 MCP ToolExecutor 注册进 ToolRegistry
  -> runAgent(...)
  -> finally: manager.dispose()  // 关闭所有 client, 回收子进程
```

接入点：

- `runOneShot`: eventSink 创建之后、`runAgent` 之前连接；`finally` 中
  dispose。
- `runTui`: 与 `createDefaultTooling` 同时机连接一次（对话共享连接），
  连接事件写入 `TuiEventStream`；TUI 退出时 dispose。

子进程 stderr 以 pipe 模式接收，保留最近约 2000 字符。连接失败时把
stderr 尾部拼进错误信息，方便定位 server 启动问题；连接成功后丢弃后续
stderr，避免污染 TUI。

## 执行与超时

`McpToolExecutor.execute`：

```text
execute(args)
  -> args 必须是 object 或 undefined, 否则返回 ok=false
  -> client.callTool({ name, arguments }, timeout)
  -> 提取 content 中 type="text" 的 block, 拼接为 text
  -> 非 text block 渲染为占位说明, 例如 [image image/png] / [resource ...]
  -> text 超过上限时截断并标记 truncated=true
  -> result.isError=true 时 ok=false, text 作为错误内容
  -> 传输错误 / 超时: ok=false, error 为原因
```

参数：

- 调用超时默认 `60_000` ms，通过 `TINKER_MCP_TIMEOUT_MS` 调整。
- observation text 上限默认 `40_000` 字符，通过
  `TINKER_MCP_MAX_OBSERVATION_CHARS` 调整。截断在 raw result 阶段完成，
  JSONL log 中也不保留全量，避免日志和上下文双双膨胀。
- image / audio block 的 base64 数据不写入 raw result，只保留 mimeType
  占位，防止 JSONL log 膨胀。

## Raw Result

`src/tools/types.ts` 新增：

```ts
export type McpToolRawResult = {
  ok: boolean;
  toolName: string; // mcp__<server>__<tool>
  serverName: string;
  serverToolName: string;
  isError?: boolean;
  text?: string;
  truncated?: boolean;
  contentBlockCount?: number;
  error?: string;
};
```

并加入 `ToolRawResult` union。

字段语义：

- `toolName`: 模型可见的完整工具名。
- `serverName` / `serverToolName`: 拆分后的来源，便于日志和 TUI 展示。
- `isError`: server 返回 `isError=true`（工具级失败，例如页面上找不到
  元素），此时 `ok=false` 且 `text` 是 server 给出的错误内容。
- `text`: 提取并截断后的文本内容。
- `truncated`: 发生截断时为 `true`。
- `contentBlockCount`: 原始 content block 数量。
- `error`: 传输错误、超时或参数错误的原因。

## Observation

`ObservationBuilder` 以 `mcp__` 前缀识别 MCP 工具，新增
`renderMcpObservation()`：

成功：

```text
<text>
```

发生截断时追加：

```text
[Output truncated to 40000 characters.]
```

server 返回 `isError=true`：

```text
mcp__playwright__browser_click failed (server reported error):
<text>
```

传输失败 / 超时：

```text
mcp__playwright__browser_click failed: <error>
```

成功但没有任何 text content：

```text
(no text content, 1 content block)
```

## 事件、TUI 和日志

`src/events/types.ts` 新增：

```ts
| { type: "mcp.server.connected"; serverName: string; toolCount: number }
| { type: "mcp.server.failed"; serverName: string; error: string }
```

现有 sink 的 `default` 分支保证未处理的新事件不会破坏行为。显式处理：

- TUI event store：
  - connected: info item `mcp <serverName> connected -> N tools`
  - failed: failed item `mcp <serverName> failed -> <error>`
  - tool.started 摘要：`mcp__` 工具显示完整工具名。
- stdout event printer：
  - `mcp.server.connected name=<serverName> tools=<N>`
  - `mcp.server.failed name=<serverName> error=<error>`
- JSONL event log 自动记录（已是全量 sink）。
- ObservationTextLog 的 tool observation 已按 `call.name` 输出标题，
  无需修改。

## 系统提示

第一版不修改 `SYSTEM_PROMPT`。MCP 工具的用途由各自的 description 承载，
`mcp__<server>__<tool>` 命名本身已经表达来源。后续如有需要，可以在连接后
把 server 摘要追加到 system prompt。

## 模块结构

```text
src/mcp/mcp-config.ts
  loadMcpConfig(workspaceRoot): McpConfig | undefined
  parseMcpConfig(json, sourcePath): McpConfig

src/mcp/mcp-tool-executor.ts
  createMcpToolExecutor({ client, serverName, tool, timeoutMs, maxObservationChars })
  mcpToolName(serverName, toolName)
  sanitizeInputSchema(schema)

src/mcp/mcp-manager.ts
  createMcpManager({ config, eventSink, clientFactory? }): Promise<McpManager>
  McpManager = { executors: ToolExecutor[]; dispose(): Promise<void> }
```

`createMcpManager` 接受可注入的 `clientFactory`，测试中用 in-memory
transport 替换 stdio。

## 接入点

需要修改：

```text
package.json                              (+ @modelcontextprotocol/sdk)
src/mcp/mcp-config.ts                     (新增)
src/mcp/mcp-tool-executor.ts              (新增)
src/mcp/mcp-manager.ts                    (新增)
src/tools/types.ts
src/events/types.ts
src/observation/observation-builder.ts
src/tui/event-store.ts
src/events/stdout-event-printer.ts
src/cli/run-runner.ts
src/cli/tui-runner.tsx
src/__tests__/mcp-config.test.ts          (新增)
src/__tests__/mcp-tools.test.ts           (新增)
src/__tests__/fixtures/fake-mcp-server.ts (新增)
```

## 实现步骤

第一步：配置加载

- 新增 `src/mcp/mcp-config.ts`，实现读取、解析、校验和 fast-fail 错误。

第二步：工具适配器

- 新增 `src/mcp/mcp-tool-executor.ts`。
- 实现命名前缀、schema 清洗、callTool 超时、text 提取和截断、
  `McpToolRawResult` 组装。
- 在 `src/tools/types.ts` 加 `McpToolRawResult` 并入 union。

第三步：连接管理

- 新增 `src/mcp/mcp-manager.ts`。
- 实现 stdio 连接、listTools、stderr 尾部缓存、失败降级、dispose。
- 在 `src/events/types.ts` 加 `mcp.server.connected` / `mcp.server.failed`。

第四步：observation 和 UI

- `ObservationBuilder` 新增 `mcp__` 前缀分支。
- TUI event store 和 stdout event printer 显式处理 MCP 事件与工具摘要。

第五步：runner 接入

- `runOneShot` 与 `runTui` 中加载配置、连接、注册、dispose。

第六步：测试和验证

- 补齐单元测试与 stdio 集成测试。
- 运行 `bun run check`。

## 测试计划

配置测试：

- 文件不存在返回 undefined。
- 非法 JSON fast-fail，错误包含文件路径。
- server 名含 `__` 或非法字符被拒绝。
- `command` 缺失被拒绝。
- `type` 为非 `"stdio"` 值被拒绝。

工具适配测试（in-memory transport）：

- listTools 后注册的工具名带 `mcp__<server>__` 前缀。
- `inputSchema` 透传到 `definition.parameters`，`$schema` 被删除。
- 无 `inputSchema` 的工具得到空 object schema。
- callTool 参数透传，text content 正确回传。
- 多个 text block 拼接。
- 非 text block 渲染为占位说明。
- 超长输出被截断且 `truncated=true`。
- server 返回 `isError=true` 时 `ok=false`。
- callTool 抛错时 `ok=false` 且 error 有原因。

manager 测试：

- 一个 server 连接失败时发出 `mcp.server.failed`，其余 server 工具正常注册。
- dispose 关闭所有 client。

stdio 集成测试：

- fixture server 通过 `bun` 启动，完成 connect / listTools / callTool /
  dispose 全流程。

observation 测试：

- 成功、截断、server error、传输失败、无 text content 五种渲染。

TUI / event 测试：

- `mcp.server.connected` / `mcp.server.failed` 生成对应 timeline item。
- `tool.started` 显示完整 `mcp__` 工具名。

最终验证：

```bash
bun run check
```
