# Tinker Chrome 一阶段技术方案

## 状态

- 阶段：一阶段已实现，并于 2026-07-21 完成本机真实 Chrome 验收。
- 目标平台：macOS + Google Chrome + Manifest V3。
- 涉及组件：`tinker`、`tinker-chrome-mcp`、`TinkerChromePlugin`。
- 本文只定义一阶段。二阶段的页面快照和元素操作不在本方案内。

本次验收环境为 Google Chrome 150、独立 `Tinker Dev` profile，固定扩展 ID 为
`bakgbafndlkajmiifhlndicifmhdchpn`。验收结果包括：

- 真实 Chrome 中 `open_page(https://example.com/)` 创建可见标签页并返回最终
  URL、`Example Domain` 标题和 `pageId`；
- `get_page_summary(pageId)` 返回语言、H1 和有界正文；
- 保持 MCP runtime 不变并终止 Native Host 后，扩展自动重连，同一 `pageId`
  仍能继续获取摘要；
- 真实 Tinker one-shot 模型回合依次调用
  `mcp__tinker-chrome__open_page` 和
  `mcp__tinker-chrome__get_page_summary`，两项 tool event 均成功，最终回答来自
  Chrome observation；
- `bun run check` 通过，共 681 项测试成功。

## 背景

Tinker 已经支持 workspace 级 `.mcp.json`、stdio MCP server、MCP tool
发现和注册。只要一个 MCP server 能稳定地把请求转发给 Chrome 扩展，现有
agent loop、模型适配层和 TUI 就不需要理解 Chrome。

Chrome 扩展不能直接连接一个已经在终端中运行的 CLI 进程。Chrome Native
Messaging 的语义是：扩展调用 `chrome.runtime.connectNative()` 后，由 Chrome
启动 Native Messaging Host 子进程，再通过该进程的 stdin/stdout 通信。因此
一阶段需要在 Native Host 与 `tinker-chrome-mcp` 之间增加一条本地 Unix Domain
Socket 链路。

本阶段只证明以下最小闭环可靠成立：

```text
tinker
  -> stdio MCP
  -> tinker-chrome-mcp
  -> Unix Domain Socket
  -> tinker-chrome-native-host
  -> Chrome Native Messaging
  -> TinkerChromePlugin
  -> chrome.tabs / chrome.scripting
```

## 核心决定

1. Tinker 只通过现有 MCP 接口接入，不新增内置 Chrome tool，也不修改 agent
   loop。
2. `tinker-chrome-mcp` 是独立发行单元，包含 MCP server 和 Native Host 两个
   可执行入口。
3. Chrome 侧使用 Native Messaging，不使用 localhost WebSocket。
4. MCP server 无论 Chrome 是否在线，都必须成功初始化并固定返回两项工具。
5. 一阶段只支持 `open_page` 和 `get_page_summary`。
6. 页面摘要是确定性的、有界的可读内容投影，不额外调用模型。最终自然语言
   总结仍由 Tinker 当前主模型完成。
7. 一阶段不申请 `debugger` 权限，不使用 CDP。
8. 一阶段只允许一个活动的 `tinker-chrome-mcp` runtime；发现多个 runtime 时
   fast-fail，不猜测应连接哪一个。
9. 协议只接受精确的 v1，不做兼容分支或静默降级。

## 目标

- 用户能在 workspace `.mcp.json` 中注册 `tinker-chrome-mcp`。
- Tinker 启动后能发现两项模型可见工具：
  - `mcp__tinker-chrome__open_page`
  - `mcp__tinker-chrome__get_page_summary`
- 模型能让用户当前 Chrome 打开一个新的可见页面。
- 模型能凭 `pageId` 获取该页面当前的标题、URL、描述、主要标题和有界正文。
- Chrome、Tinker 和 Native Host 以任意顺序启动时，连接最终都能建立。
- Native Host 崩溃或 Chrome Native Messaging 断开后，扩展能自动重建连接。
- Chrome 未启动、扩展未安装或未连接时，MCP server 仍能完成初始化，工具调用
  快速返回明确错误。
- 连接、导航、摘要提取和清理都有确定的超时、错误码和日志边界。

## 非目标

- 不读取或控制用户原有标签页。
- 不列出标签页，不切换标签页，不关闭标签页。
- 不生成 DOM、Accessibility 或视觉页面快照。
- 不返回元素 ref、selector、坐标或节点树。
- 不支持 click、type、press、select、scroll、hover、drag 等页面操作。
- 不截图，不下载或上传文件。
- 不执行任意 JavaScript，不向模型暴露 `evaluate`。
- 不申请或使用 `chrome.debugger`，不发送 CDP 命令。
- 不读取 Cookie、浏览历史、书签或下载记录。
- 不支持 `chrome://`、`file://`、扩展页面或其他非 HTTP(S) 页面。
- 不支持 iframe 内容；摘要只来自主 frame。
- 不支持 incognito。
- 不支持多个同时活动的 Tinker runtime，也不做 runtime 选择 UI。
- 不支持 Windows、Linux、Chromium、Chrome Beta 或 Chrome for Testing。
- 不把 Chrome 可用性动态写进 Tinker 的 tool surface。
- 不修改 Tinker 的 MCP transport、MCP observation 或 RuntimeSession 契约。

## 当前 Tinker 基线

### MCP 生命周期

当前生产入口由 `createRuntimeSession()` 统一创建默认 tooling 和 MCP manager。
`.mcp.json` 存在时，RuntimeSession 会：

1. 使用 `StdioClientTransport` 启动 MCP server；
2. 完成 MCP initialize；
3. 调用 `tools/list`；
4. 将每个工具注册进 `ToolRegistry`；
5. 在 session dispose 时关闭 MCP client 和子进程。

当前 `createMcpManager()` 对连接失败、`tools/list` 失败和无效 schema 都会
fast-fail RuntimeSession 初始化。因此 `tinker-chrome-mcp` 不能把“Chrome 已连接”
作为 MCP server 启动条件。

### 固定工具面

MCP 工具在 RuntimeSession 初始化阶段发现，并进入当前 context surface。Chrome
之后上线或下线，只能改变工具调用结果，不能增删工具。`tinker-chrome-mcp`
必须始终返回相同的两个工具定义。

### 输出上限

当前 Tinker 对单个 MCP observation 的默认上限是 40,000 字符。一阶段页面摘要
正文限制为 20,000 个 Unicode code point，连同元数据和标题列表后仍应明显低于
Tinker 的上限。

## 组件边界

### tinker

职责：

- 按 `.mcp.json` 启动 `tinker-chrome-mcp`；
- 发现并注册 MCP tools；
- 把模型 tool call 转发给 MCP server；
- 把 MCP text content 作为 observation 回传给模型；
- 在 RuntimeSession 结束或切换时关闭 MCP 子进程。

一阶段不修改 Tinker 源码。`/mcp` 会通过现有 runtime inventory 自然显示
`tinker-chrome` 和两项工具。

### tinker-chrome-mcp

同一发行单元包含三个 CLI 入口：

```text
tinker-chrome-mcp                 # stdio MCP server
tinker-chrome-native-host         # Chrome 启动的 Native Messaging Host
tinker-chrome-mcp install-host    # 安装 Native Host manifest
```

MCP server 职责：

- 立即完成 MCP initialize 和 `tools/list`；
- 暴露 `open_page`、`get_page_summary`；
- 为当前进程创建唯一 `runtimeId`、认证 token 和 Unix socket；
- 发布 runtime registry；
- 把 tool call 映射为本地 RPC；
- 管理请求 ID、超时、断线失败和进程清理；
- 不解析 DOM，不生成页面摘要，不持有 Chrome tab ID。

Native Host 职责：

- 校验 Chrome 传入的扩展 origin；
- 解析和写入 Chrome Native Messaging 帧；
- 发现唯一活动的 MCP runtime；
- 通过认证握手连接对应 Unix socket；
- 双向转发经过 schema 校验的 v1 消息；
- 不执行 shell，不解释页面命令，不监听 TCP 端口。

### TinkerChromePlugin

职责：

- Manifest V3 Service Worker 调用
  `chrome.runtime.connectNative("com.tinker.chrome")`；
- 在 Native Host 断开后按退避策略重连；
- 处理 `page.open` 和 `page.summary` 两种 RPC；
- 创建并跟踪插件自己打开的标签页；
- 使用 `chrome.scripting.executeScript()` 在主 frame 提取有界页面摘要；
- 将 `pageId -> tabId` 映射保存在 `chrome.storage.session`；
- 校验 runtime、page ownership、URL scheme 和消息 schema；
- 不主动向 Tinker 发起工具或 shell 操作。

## 安装与注册

### Chrome 扩展

一阶段使用固定扩展 ID 的 unpacked extension。开发版本在 manifest 中携带稳定
`key`，不能依赖加载目录偶然生成 ID。扩展 ID 必须在安装 Native Host manifest
前确定；后续更换扩展 ID 必须重新安装 manifest。

扩展 manifest 最小权限：

```json
{
  "manifest_version": 3,
  "minimum_chrome_version": "105",
  "permissions": ["nativeMessaging", "scripting", "storage", "tabs"],
  "host_permissions": ["http://*/*", "https://*/*"],
  "background": {
    "service_worker": "service-worker.js",
    "type": "module"
  }
}
```

本阶段不声明 `debugger`、`history`、`cookies`、`downloads`、`bookmarks` 或
`sidePanel`。

`activeTab` 不适合本阶段：由扩展程序化创建的页面没有用户点击扩展按钮所产生
的临时授权，所以摘要提取需要明确的 HTTP(S) host permissions。

### Native Messaging Host

用户显式执行：

```bash
tinker-chrome-mcp install-host --extension-id <extension-id>
```

安装器将稳定的 Native Host 可执行入口和只读运行配置放入用户级 Tinker Chrome
目录：

```text
~/.tinker/chrome/
  bin/tinker-chrome-native-host
  native-host-config.json
```

`native-host-config.json` 权限为 `0600`，形状为：

```json
{
  "schemaVersion": 1,
  "nativeHostName": "com.tinker.chrome",
  "extensionOrigin": "chrome-extension://<extension-id>/",
  "runtimeRoot": "/tmp/tinker-chrome-<uid>"
}
```

安装器同时写入：

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
  com.tinker.chrome.json
```

manifest 形状：

```json
{
  "name": "com.tinker.chrome",
  "description": "Tinker Chrome bridge",
  "path": "/absolute/path/to/tinker-chrome-native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<extension-id>/"]
}
```

规则：

- macOS 上 `path` 必须是绝对路径；
- `allowed_origins` 只能有当前扩展的精确 origin，不允许通配符；
- 安装器覆盖既有 manifest 前必须先解析并确认它属于
  `com.tinker.chrome`；
- manifest、运行配置和稳定可执行入口使用临时文件 + 原子 rename 发布；
- Native Host 启动时先读取并严格校验 `native-host-config.json`；
- Native Host 再校验 Chrome 传入的第一个 argv 与配置的扩展 origin 一致；
- Native Host stdout 只能输出协议帧，所有诊断写 stderr。

### Tinker MCP 配置

workspace `.mcp.json`：

```json
{
  "mcpServers": {
    "tinker-chrome": {
      "type": "stdio",
      "command": "/absolute/path/to/tinker-chrome-mcp",
      "args": []
    }
  }
}
```

正式使用时采用稳定的绝对路径，避免 Tinker、shell 和 Chrome 启动环境的 PATH
差异。server 名固定为 `tinker-chrome`，模型最终看到：

```text
mcp__tinker-chrome__open_page
mcp__tinker-chrome__get_page_summary
```

## 运行时发现

### 目录

一阶段使用短且用户隔离的运行时目录：

```text
/tmp/tinker-chrome-<uid>/
  runtimes/
    <runtimeId>.json
  sockets/
    <runtimeId-short>.sock
```

约束：

- 根目录和两个子目录权限为 `0700`；
- registry 文件权限为 `0600`；
- socket 只接受当前用户连接；
- socket 文件名使用短 runtime ID，避免 macOS Unix socket 路径长度上限；
- registry 中的 socket path 必须解析到上述 `sockets/` 目录内；
- 只删除经过目录、文件名、PID 和 socket 状态校验的精确 stale entry。

### RegistryV1

```ts
type RuntimeRegistryV1 = {
  schemaVersion: 1;
  protocolVersion: 1;
  runtimeId: string;
  pid: number;
  socketPath: string;
  authToken: string; // 32 random bytes, base64url
  cwd: string;
  startedAt: string;
};
```

发布顺序：

1. MCP server 生成 `runtimeId` 和 token；
2. 绑定 Unix socket；
3. 将 registry 写入同目录临时文件；
4. chmod 为 `0600`；
5. 原子 rename 为 `<runtimeId>.json`；
6. 开始接受 Native Host 连接。

正常退出时，MCP server 关闭 socket，并删除自己的 registry 和 socket。异常退出
可能遗留文件；Native Host 忽略 PID 不存在或 socket 无法连接的 entry，后续 MCP
server 启动时清理经过验证的 stale entry。

### 单 runtime 规则

Native Host 每秒扫描一次 registry：

- 0 个 live runtime：保持 Native Messaging 端口，状态为 `waiting_for_tinker`；
- 1 个 live runtime：认证并连接；
- 多于 1 个：不选择任何一个，状态为 `ambiguous_runtime`。

当存在多个 live runtime 时，任一 MCP tool call 都返回
`MULTIPLE_RUNTIMES_UNSUPPORTED`。一阶段不使用“最新启动”“当前 cwd”或 PID 大小
等启发式规则。

## 连接生命周期

### 启动顺序

Chrome 和 Tinker 可以任意顺序启动：

```text
Chrome 先启动
  -> Plugin connectNative
  -> Native Host 启动并等待 runtime registry
  -> Tinker 启动 tinker-chrome-mcp
  -> registry 出现
  -> Host 连接 Unix socket
  -> ready

Tinker 先启动
  -> tinker-chrome-mcp 发布 registry 并等待 Host
  -> Chrome 启动 Plugin
  -> Plugin connectNative
  -> Host 发现 registry 并连接
  -> ready
```

### 扩展重连

Service Worker 在模块加载、`runtime.onStartup` 和 `runtime.onInstalled` 时调用统一
的 `ensureNativePort()`。`port.onDisconnect` 后使用带 jitter 的指数退避：

```text
250ms -> 500ms -> 1s -> 2s -> 5s（封顶）
```

建立连接后重置退避。任何时刻最多存在一个重连 timer 和一个 Native Port。
Chrome 105+ 中，活动的 `connectNative()` 端口会保持 Service Worker 存活；仍需
把 page registry 放进 `chrome.storage.session`，不能把全局变量当作事实来源。

### 本地链路存活

- MCP server 与 Plugin 每 15 秒交换一次 `ping` / `pong`；
- 45 秒没有收到对端消息视为断开；
- Native Host 只转发 heartbeat，不自行伪造 ready；
- tool call 不等待连接恢复；不在 `ready` 时立即返回连接错误；
- 断线后所有 pending RPC 都完成为失败，不能永久悬挂；
- 一阶段不自动重放任何 tool call。

### 关闭

- Tinker 关闭 MCP stdin 或终止子进程时，MCP server 先拒绝新请求，再失败所有
  pending 请求，最后删除自己的 registry/socket；
- Chrome 关闭 Native Port 时，Native Host 关闭对应 Unix socket 后退出；
- Service Worker 重启后从 `chrome.storage.session` 恢复仍存在的 page mapping；
- 插件或 MCP 断开时不关闭已经打开的 Chrome 标签页。

## Wire Protocol V1

### Framing

Chrome 与 Native Host 之间使用 Chrome 规定的 Native Messaging framing：

```text
4-byte native-endian JSON byte length + UTF-8 JSON
```

Native Host 与 MCP server 的 Unix socket 使用：

```text
4-byte little-endian JSON byte length + UTF-8 JSON
```

一阶段对两个方向都设置 1 MiB 内部帧上限。虽然 Chrome 允许扩展发给 Native
Host 的单条消息达到 64 MiB，本阶段不利用该上限。长度为 0、超过上限、JSON
非法或消息 schema 不合法时立即断开该连接。

### Plugin Hello

Plugin 建立 Native Port 后必须首先发送：

```ts
type PluginHelloV1 = {
  kind: "plugin_hello";
  protocolVersion: 1;
  pluginVersion: string;
  capabilities: ["page.open", "page.summary"];
};
```

Native Host 在收到并校验 `plugin_hello` 前不扫描或连接 runtime。Native Host
以 Chrome argv 和 `native-host-config.json` 为扩展 origin 的事实来源，不能信任
Plugin 自报 origin。5 秒内没有收到合法 `plugin_hello`，Host 直接退出，由 Plugin
按既定退避策略重新连接。

### Bridge 握手

Plugin Hello 完成后，Native Host 读取唯一 live registry，连接 socket，并使用
已经校验的 Plugin 信息发送：

```ts
type BridgeHelloV1 = {
  kind: "hello";
  protocolVersion: 1;
  runtimeId: string;
  authToken: string;
  extensionOrigin: string;
  pluginVersion: string;
  capabilities: ["page.open", "page.summary"];
};
```

MCP server 必须逐项验证：

- `protocolVersion === 1`；
- `runtimeId` 等于自身 runtime；
- token 常量时间比较成功；
- extension origin 是合法的单一 Chrome extension origin；
- capabilities 精确包含两项 v1 能力。

成功后返回：

```ts
type BridgeHelloAckV1 = {
  kind: "hello_ack";
  protocolVersion: 1;
  runtimeId: string;
};
```

Native Host 已在前一层保证该 origin 等于安装配置。MCP server 以 token 鉴权为
本地连接边界，不重复读取或解释 Native Host 安装文件。

握手完成前收到其他消息直接断开。不协商旧版本，也不忽略未知 capability。
连接建立后还要校验消息方向：Plugin 只能发送 response/pong，MCP server 只能发送
request/ping；任一方向出现反向 request 都立即断开。

### RPC 请求

```ts
type BridgeRequestV1 = {
  kind: "request";
  protocolVersion: 1;
  runtimeId: string;
  requestId: string;
  method: "page.open" | "page.summary";
  deadlineUnixMs: number;
  params: unknown;
};
```

### RPC 成功响应

```ts
type BridgeSuccessV1 = {
  kind: "response";
  protocolVersion: 1;
  runtimeId: string;
  requestId: string;
  ok: true;
  result: unknown;
};
```

### RPC 失败响应

```ts
type BridgeFailureV1 = {
  kind: "response";
  protocolVersion: 1;
  runtimeId: string;
  requestId: string;
  ok: false;
  error: {
    code: ChromeBridgeErrorCode;
    message: string;
    retryable: boolean;
    outcome: "not_started" | "unknown" | "performed";
    details?: Record<string, string | number | boolean>;
  };
};
```

`outcome` 区分：

- `not_started`：Chrome 尚未执行操作；
- `unknown`：请求已经发出，但断线导致无法确认是否执行；
- `performed`：操作已发生，但等待后续状态时失败，例如页面已创建但加载超时。

未知 `kind`、未知 method、重复 active `requestId`、错误 runtime 或已过 deadline
全部 fast-fail。响应找不到对应 pending request 时记录诊断并丢弃，不重新创建
请求。

## MCP 工具契约

### open_page

MCP tool 名：

```text
open_page
```

模型可见名：

```text
mcp__tinker-chrome__open_page
```

参数：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "url": {
      "type": "string",
      "minLength": 1,
      "maxLength": 8192,
      "description": "HTTP or HTTPS URL to open in a new visible Chrome tab"
    }
  },
  "required": ["url"]
}
```

语义：

1. MCP server 使用 `new URL()` 解析并只接受 `http:` / `https:`；
2. MCP server 生成 opaque UUID `pageId`，不暴露 Chrome `tabId`；
3. 发送 `page.open { pageId, url }`，内部 deadline 为 30 秒；
4. Plugin 调用 `chrome.tabs.create({ url, active: true })`；
5. Plugin 立即保存 `runtimeId + pageId -> tabId` 到
   `chrome.storage.session`；
6. Plugin 监听目标 tab 的 `onUpdated` / `onRemoved`，并在安装监听后再次读取
   tab 状态，避免错过快速完成事件；
7. `status === "complete"` 后读取当前 URL 和 title 并返回；
8. 重定向后的 URL 是结果事实来源；不尝试获取 HTTP status。

成功结果：

```ts
type OpenPageResultV1 = {
  pageId: string;
  url: string;
  title: string;
  loadState: "complete";
};
```

MCP text content：

```text
Opened a Chrome page.
pageId=<pageId>
url=<final URL>
title=<title>
loadState=complete
```

导航 30 秒未完成时，返回 `NAVIGATION_TIMEOUT`、`outcome=performed`，并在
details 中带 `pageId` 和当前 URL。标签页保持打开，模型可以稍后使用同一
`pageId` 调用 `get_page_summary`。

Native 链路在请求发出后断开时返回 `OPEN_PAGE_OUTCOME_UNKNOWN`。任何层都不得
自动重试 `open_page`，避免产生重复标签页。

### get_page_summary

MCP tool 名：

```text
get_page_summary
```

模型可见名：

```text
mcp__tinker-chrome__get_page_summary
```

参数：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "pageId": {
      "type": "string",
      "format": "uuid",
      "description": "Opaque pageId returned by open_page"
    }
  },
  "required": ["pageId"]
}
```

语义：

1. Plugin 查找当前 runtime 拥有的 `pageId`；
2. 使用 `chrome.tabs.get(tabId)` 校验标签页仍存在；
3. 若页面仍在加载，最多等待 10 秒；
4. 再次校验当前 URL 仍是 HTTP(S)；
5. 使用 `chrome.scripting.executeScript()` 在主 frame 的 isolated world 执行
   固定的本地 extractor 文件；
6. 校验 extractor 返回的 `PageSummaryV1`；
7. 返回当前页面状态，不要求 URL 仍等于 `open_page` 的初始 URL。

结果：

```ts
type PageSummaryV1 = {
  schemaVersion: 1;
  pageId: string;
  url: string;
  title: string;
  description?: string;
  canonicalUrl?: string;
  language?: string;
  headings: Array<{
    level: 1 | 2 | 3;
    text: string;
  }>;
  content: string;
  truncated: boolean;
};
```

MCP text content：

```text
Chrome page summary.
pageId=<pageId>
url=<current URL>
title=<title>
description=<description or empty>
canonicalUrl=<canonical URL or empty>
language=<language or empty>
truncated=<true|false>

Headings:
- H1 <text>
- H2 <text>

Content:
<bounded readable text>
```

该 text block 由 Tinker 现有 MCP adapter 直接变成模型 observation。工具自身不
调用模型；当前主模型读取该 observation 后完成用户要求的自然语言概括。

## 页面摘要提取

### 定义

一阶段的“页面摘要”不是 DOM snapshot，也不是 LLM summary，而是页面当前已渲染
主 frame 的有界语义投影：元数据、主要标题和一段适合模型阅读的正文。

### 提取规则

固定 extractor 按以下顺序执行：

1. 读取 `location.href`、`document.title`、`document.documentElement.lang`；
2. 读取 `meta[name="description"]` 和 `link[rel="canonical"]`；
3. 收集可见的 `h1`、`h2`、`h3`，规范空白后保留前 40 项；
4. 从 `article`、`main`、`[role="main"]` 中选择规范化可见文本最长且至少
   200 字符的候选；
5. 没有合格语义容器时使用 `document.body.innerText`；
6. 把连续空格压成单空格，每行 trim，连续空行最多保留一个；
7. 删除空标题，单个标题限制为 500 个 code point；
8. description 限制为 1,000 个 code point；
9. content 限制为 20,000 个 Unicode code point，超出时尾部截断并设置
   `truncated=true`；
10. content 为空时返回 `SUMMARY_EMPTY`。

使用 `innerText` 是有意选择：它反映当前渲染可见文本，并避免把 script、style
或隐藏模板内容发给模型。本阶段不尝试处理 shadow DOM、canvas、PDF、iframe 或
虚拟滚动尚未渲染的内容。

### 与 WebFetch 的关系

现有 WebFetch 已有 Readability、正文保留比例和大内容提炼管线。一阶段不直接
复用该实现：

- WebFetch 面向任意 URL 抓取；这里面向用户当前 Chrome 中已渲染页面；
- `tinker-chrome-mcp` 不应获得模型 API 配置并发起嵌套模型调用；
- 20,000 字符投影已经低于 MCP observation 上限，主模型可以直接概括；
- 等真实页面 badcase 出现后，再决定是否在 Plugin 中引入 Readability，而不是
  预先复制一套复杂正文提取器。

## 错误契约

```ts
type ChromeBridgeErrorCode =
  | "PLUGIN_NOT_CONNECTED"
  | "MULTIPLE_RUNTIMES_UNSUPPORTED"
  | "PROTOCOL_VERSION_MISMATCH"
  | "BRIDGE_AUTH_FAILED"
  | "BRIDGE_DISCONNECTED"
  | "REQUEST_TIMEOUT"
  | "INVALID_URL"
  | "TAB_CREATE_FAILED"
  | "NAVIGATION_TIMEOUT"
  | "OPEN_PAGE_OUTCOME_UNKNOWN"
  | "PAGE_NOT_FOUND"
  | "TAB_CLOSED"
  | "PAGE_ACCESS_DENIED"
  | "PAGE_NOT_READY"
  | "SUMMARY_EMPTY"
  | "INVALID_PLUGIN_RESPONSE"
  | "INTERNAL_ERROR";
```

MCP server 把失败映射为 `isError=true` 的单个 text block：

```text
tinker-chrome error
code=<error code>
retryable=<true|false>
outcome=<not_started|unknown|performed>
message=<bounded human-readable message>
<optional details>
```

规则：

- Chrome 离线、扩展未安装或 Native Host 未连接：
  `PLUGIN_NOT_CONNECTED`，`retryable=true`，`outcome=not_started`；
- 多 runtime：`MULTIPLE_RUNTIMES_UNSUPPORTED`，`retryable=false`；
- 非 HTTP(S) URL：`INVALID_URL`，`retryable=false`；
- 用户关闭 tab：`TAB_CLOSED`，`retryable=false`；
- Chrome 禁止注入的页面：`PAGE_ACCESS_DENIED`，`retryable=false`；
- read-only 的 `get_page_summary` 可由模型重新调用；
- mutating 的 `open_page` 只有明确 `outcome=not_started` 时才适合重新调用；
- 内部错误信息不能包含 auth token、完整 registry 或页面正文。

调用尚未进入 Native 链路时应在 500ms 内返回连接错误。内部导航超时为 30 秒，
摘要等待和提取总超时为 10 秒，都小于 Tinker 当前 60 秒 MCP tool timeout。

## 状态模型

### MCP Bridge

```text
starting
  -> waiting_for_plugin
  -> ready
  -> waiting_for_plugin   (native disconnect)
  -> closing
  -> closed
```

只有 `ready` 接受 RPC。`waiting_for_plugin` 不排队 tool call。

### Plugin Native Port

```text
disconnected
  -> connecting
  -> connected
  -> disconnected         (onDisconnect)
```

重复调用 `ensureNativePort()` 必须幂等。

### Page

```text
opening
  -> ready
  -> closed

opening
  -> timed_out            (tab 保持存在，允许 summary 再等待)
```

Plugin 的 page registry 是 page ownership source of truth；Chrome tab ID 只存在于
Plugin 内部，不能穿过 bridge 暴露给模型。

## 安全边界

- 没有 TCP/WebSocket listener，网页不能探测或连接本地 bridge。
- Native Host manifest 只允许一个固定扩展 ID。
- Native Host 同时校验 Chrome argv origin。
- Unix runtime 目录为用户私有，连接还需 256-bit token。
- Native Host 只连接 registry 声明且位于固定 sockets 目录的 Unix socket。
- Wire protocol 只允许两种方法；未知方法不转发。
- `open_page` 只允许 HTTP(S)。
- Plugin 只读取自己创建并登记的 tab。
- 摘要只返回渲染 DOM 文本，不读取 Cookie、localStorage、请求 header 或浏览历史。
- Native Host 不提供 shell、文件读取、进程启动或任意代理能力。
- stdout 严格保留给各自 framing；日志中不记录 auth token 或页面正文。
- 本阶段把当前 macOS 用户账号视为本地信任边界，不承诺抵抗同 UID 的恶意进程。

扩展拥有所有 HTTP(S) host permissions，因此可以读取用户已登录页面的渲染内容。
这是该模式的产品能力，也是明确的敏感权限；安装说明必须直接告知用户。

## 诊断与日志

### tinker

沿用现有 MCP 事件和展示：

- `/mcp` 显示 server 和两项工具；
- `mcp.server.connected` 证明 stdio MCP 已就绪，不代表 Chrome 已连接；
- tool observation 中的明确错误码表达 Chrome 链路状态。

### tinker-chrome-mcp

- stdout 仅供 MCP JSON-RPC；
- stderr 使用单行结构化诊断；
- 记录 runtime 发布、Native Host 连接、握手结果、RPC 开始/结束和清理；
- URL 日志只保留 origin，默认不记录 path/query；
- 不记录页面 summary content。

### Native Host / Plugin

- Native Host stdout 仅供 Native Messaging；
- Native Host stderr 记录 manifest/origin、registry 数量、socket 和 framing 错误；
- Plugin Service Worker console 记录连接状态和有界错误码；
- 不记录 auth token、正文、完整 query 或 hash。

`mcp.server.connected` 与 `PLUGIN_NOT_CONNECTED` 同时出现并不矛盾：前者表示
Tinker 与 MCP 子进程已连接，后者表示 MCP 子进程尚未连接 Chrome Plugin。

## 建议模块结构

`tinker-chrome-mcp`：

```text
src/
  mcp-server.ts
  tools/
    open-page.ts
    get-page-summary.ts
  bridge/
    protocol-v1.ts
    frame-codec.ts
    runtime-registry.ts
    socket-server.ts
    rpc-client.ts
  native-host/
    main.ts
    native-message-codec.ts
    runtime-discovery.ts
    socket-bridge.ts
  install-host.ts
```

`TinkerChromePlugin`：

```text
manifest.json
src/
  service-worker.ts
  native-port.ts
  protocol-v1.ts
  rpc-router.ts
  page-registry.ts
  open-page.ts
  get-page-summary.ts
  page-summary-extractor.ts
```

一阶段不要求把两个组件迁进 Tinker 仓库或把 Tinker 改造成 workspace monorepo。
协议类型可以分别实现，但必须共享同一组 v1 JSON fixture 做契约测试；版本不一致
直接拒绝连接。

## 测试方案

### tinker-chrome-mcp 单元测试

- 无 Plugin 时 MCP initialize 和 `tools/list` 成功；
- tools/list 始终只有 `open_page`、`get_page_summary`；
- 两项 input schema 与本文完全一致；
- 无 Plugin 时调用在 500ms 内返回 `PLUGIN_NOT_CONNECTED`；
- URL 解析只接受 HTTP(S)，拒绝其他 scheme 和额外字段；
- summary 输出映射为一个 text content block；
- Plugin error 正确映射为 `isError=true`；
- request ID、deadline、断线和 pending request 清理；
- 超长/非法 frame、非法 JSON、错误 runtime、错误 token 和版本不匹配；
- registry 原子发布、正常清理和经过验证的 stale entry 清理；
- 多 live runtime 返回 `MULTIPLE_RUNTIMES_UNSUPPORTED`。

### Native Host 测试

- Native Messaging 的分片读取和多帧读取；
- UTF-8 byte length，而不是 JavaScript string length；
- 0 字节、超过 1 MiB、短帧和 stdout 污染 fast-fail；
- extension origin 精确匹配；
- 0/1/多个 live registry 分支；
- Chrome 先启动且 runtime 后出现时最终完成握手；
- 已选 runtime 在 `hello_ack` 前消失时，握手超时后重新发现下一 runtime；
- registry socket path 逃逸被拒绝；
- Unix socket 鉴权失败；
- 致命 Plugin 协议错误后 Native Host 退出，使扩展能够重新拉起进程；
- Chrome stdin EOF 后关闭 socket 并退出。

### Plugin 单元测试

Chrome API 使用 fake：

- `connectNative` 成功、断开和退避重连；
- 重复 `ensureNativePort()` 不创建多个 Port；
- `open_page` 创建 active tab，等待 complete 并返回 redirect 后 URL；
- 快速完成事件不丢失；
- tab 被关闭、创建失败和导航超时；
- page mapping 写入并从 `chrome.storage.session` 恢复；
- 其他 runtime 不能读取 page；
- `get_page_summary` 只对主 frame 执行固定 extractor；
- restricted page 注入失败映射为 `PAGE_ACCESS_DENIED`；
- heading、description 和 content 边界；
- content Unicode 截断不破坏 surrogate pair；
- 空页面返回 `SUMMARY_EMPTY`；
- 未知方法和非法 schema 不调用 Chrome API。

### 进程级集成测试

不启动真实 Chrome：

1. 启动真实 stdio MCP server；
2. 使用 fake Native Host 连接其 Unix socket；
3. 完成 v1 hello；
4. 通过 MCP 调用 `open_page`；
5. fake Plugin 返回 `OpenPageResultV1`；
6. 通过 MCP 调用 `get_page_summary`；
7. fake Plugin 返回 `PageSummaryV1`；
8. 断开 bridge，确认 pending request 失败和资源清理。

### macOS + Chrome 真实验收

固定使用 `https://example.com`：

1. 加载固定 ID 的 `TinkerChromePlugin`；
2. 安装 `com.tinker.chrome` Native Host；
3. 在测试 workspace 注册 `tinker-chrome` MCP；
4. 启动 Tinker，`/mcp` 显示两项工具；
5. 请求模型使用 Chrome 打开 `https://example.com`；
6. 确认出现新的可见 Chrome tab；
7. 模型使用返回的 `pageId` 调用 `get_page_summary`；
8. observation 包含最终 URL、`Example Domain` 标题和页面正文；
9. 最终回答能依据该 observation 概括页面；
10. 分别验证 Chrome 先启动和 Tinker 先启动；
11. 终止 Native Host，确认扩展重连后下一次 summary 调用恢复；
12. 关闭目标 tab，确认返回 `TAB_CLOSED`；
13. 同时启动第二个 MCP runtime，确认不静默选错 runtime。

真实验收不依赖模型自行决定是否使用工具；prompt 必须明确要求使用
`tinker-chrome`，并同时核对 tool event 与真实 Chrome 页面，不能只看最终回答。

## 实现顺序

### 第一步：协议和离线 MCP server

- 定义 v1 TypeScript types、严格 validator 和 frame codec；
- 完成两个 MCP tool schema；
- 保证没有 Chrome 时 initialize/listTools 成功、callTool 快速失败；
- 完成 fake bridge 的进程级测试。

### 第二步：runtime registry 和 Native Host

- 实现用户隔离 runtime 目录、registry、Unix socket 和鉴权；
- 实现 Native Messaging codec；
- 实现单 runtime 发现、转发、heartbeat 和清理；
- 实现 macOS user-level manifest 安装器。

### 第三步：Plugin 连接

- 建立 MV3 Service Worker；
- 实现 `connectNative` 幂等连接和退避重连；
- 完成 hello、heartbeat 和严格 RPC router；
- 暂时用 fake page handlers 验证完整链路。

### 第四步：打开页面

- 实现 URL 校验、pageId、`tabs.create` 和加载状态机；
- 持久化 page registry；
- 补齐超时、tab close 和断线 outcome；
- 完成真实 Chrome open-page smoke。

### 第五步：页面摘要

- 实现固定 extractor 和边界；
- 实现 `get_page_summary`；
- 补齐 restricted page、空内容和截断测试；
- 完成 `example.com` 端到端验收。

## 一阶段完成标准

只有同时满足以下条件，才算一阶段完成：

- Tinker 核心不需要 Chrome 专用改动；
- `.mcp.json` 注册后稳定发现且只发现两项 Chrome 工具；
- Chrome 离线不影响 MCP server 初始化；
- 新标签页和摘要都经过真实 Tinker -> MCP -> Native Host -> Plugin 链路；
- 不使用 WebSocket、CDP、Playwright 或 `chrome.debugger`；
- start-order、Native Host 重连、tab close 和多 runtime fast-fail 通过；
- 页面摘要始终有界，不把原始 HTML 或超大 DOM 发给模型；
- 所有 stdout framing 均通过分片、多帧、Unicode 和大小边界测试；
- Tinker 仓库验证通过 `bun run check`；
- `tinker-chrome-mcp` 和 Plugin 各自的 typecheck、lint、format、unit、integration
  gate 全部通过；
- `https://example.com` 真实端到端验收通过并保存可复现命令/事件证据。

## 二阶段边界

二阶段再单独设计：

- 页面/Accessibility snapshot 和稳定 element ref；
- click、type、press、select、scroll 等操作；
- 导航后 ref 失效规则；
- screenshot 和视觉输入；
- iframe、shadow DOM、虚拟列表；
- 用户已有 tab 的显式 claim/release；
- 多 Tinker runtime 选择和 tab lease；
- `chrome.debugger` / CDP 权限与 domain policy；
- mutating action 的 command journal、去重和 outcome recovery；
- 用户确认、站点 allowlist/denylist 和敏感操作策略。

一阶段的 `pageId`、runtime ID 和 RPC envelope 可以作为二阶段输入，但本文不承诺
二阶段必须兼容 v1；如果控制语义需要改变，应直接提升协议版本并 fast-fail 旧版。

## 参考

- Tinker MCP 设计：[`mcp-integration-design.md`](./mcp-integration-design.md)
- Tinker RuntimeSession 生命周期：
  [`runtime-session-lifecycle-design.md`](./runtime-session-lifecycle-design.md)
- Tinker WebFetch 设计：[`web-fetch-tool-design.md`](./web-fetch-tool-design.md)
- 当前 MCP manager：[`src/mcp/mcp-manager.ts`](../src/mcp/mcp-manager.ts)
- 当前 MCP tool adapter：
  [`src/mcp/mcp-tool-executor.ts`](../src/mcp/mcp-tool-executor.ts)
- Chrome Native Messaging：
  https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- Chrome Extension Service Worker lifecycle：
  https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- `chrome.scripting`：
  https://developer.chrome.com/docs/extensions/reference/api/scripting
- `chrome.tabs`：
  https://developer.chrome.com/docs/extensions/reference/api/tabs
- `chrome.storage`：
  https://developer.chrome.com/docs/extensions/reference/api/storage
