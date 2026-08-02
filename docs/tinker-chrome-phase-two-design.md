# Tinker Chrome 二阶段：可访问性观察与页面操作

## 状态

- 版本：Tinker Chrome `0.2.0`，bridge protocol v2。
- 日期：2026-08-01。
- 状态：阶段 1–5 已实现，并在本机真实 Chrome 中完成整条 MCP 链路验收。
- 范围仍只限 `open_page` 创建、当前 runtime 持有 `pageId` 的 HTTP(S) 页面。
- MCP multimodal observation、截图和视觉定位不在本阶段内。

一阶段文档仍是 v1 的历史合同，不因二阶段而改写。v2 是独立严格协议；v1 的
parser、types 和测试继续保留。

## 当前本机开发环境

固定环境已经存在，不需要重新创建：

- Chrome profile 名：`Tinker Dev`；profile directory：`Profile 1`。
- 扩展 ID：`bakgbafndlkajmiifhlndicifmhdchpn`。
- unpacked extension 路径：
  `packages/tinker-chrome/dist/extension`。
- Native Host：`com.tinker.chrome`，安装在当前用户的 Chrome Native Messaging
  目录。
- workspace 的 `.mcp.json` 已注册 `tinker-chrome`，入口为
  `bun packages/tinker-chrome/src/cli.ts mcp`。

日常修改后的最短循环：

```bash
bun run chrome:build
bun run chrome:diagnose
open -a "Google Chrome" --args --profile-directory="Profile 1"
```

然后在 `chrome://extensions` 的 Tinker Chrome 卡片点击“重新加载”。首次配置或
Native Host 安装损坏时再运行：

```bash
bun run chrome:install-host
```

`chrome:diagnose` 应显示：扩展 build 存在、两个 Native Host manifest 有效；没有
运行中的 MCP 时 `liveCount=0` 是正常状态。

扩展重载后，可用一条命令重复本阶段的真实 MCP 验收：

```bash
bun run chrome:smoke
```

该命令自行启动临时本地 HTTP fixture、调用全部十项工具并停止 fixture server；
Chrome 中会保留一个最终页标签，供开发者目视核对后手动关闭。

## 工具面

MCP server 离线时也固定列出十项工具：

1. `open_page(url)`
2. `get_page_summary(pageId)`
3. `take_snapshot(pageId, verbose?)`
4. `click(pageId, uid)`
5. `fill(pageId, uid, value)`
6. `press_key(pageId, key)`
7. `type_text(pageId, text, submitKey?)`
8. `wait_for(pageId, text[], timeoutMs?)`
9. `scroll(pageId, direction, amount?)`
10. `hover(pageId, uid)`

UID 动作必须使用同一 `pageId` 最新 snapshot 中的 UID。导航或刷新后必须重新
`take_snapshot`。

## Chrome 控制链路

扩展新增 `debugger` 权限，并在 Service Worker 内使用 Puppeteer 的
`ExtensionTransport.connectTab(tabId)` 附着到已经由 `pageId` 解析出的 tab。
Puppeteer browser IIFE 在构建时与 Service Worker 组合，因此扩展运行时不需要
Node.js 模块加载器。

每个 tab 有一个串行 `PageAutomationSession`：

```text
pageId
  -> runtime-owned StoredPage
  -> tabId
  -> ExtensionTransport
  -> Puppeteer Page / AX snapshot / input dispatch
```

session 在 tab 关闭、debugger detach、Native Messaging 断线或扩展重载时释放。
同一 tab 的操作串行执行，避免 snapshot、UID map 和输入事件相互穿插。

## 从 chrome-devtools-mcp 移植的算法

以下实现直接以 `ChromeDevTools/chrome-devtools-mcp` 的 Apache-2.0 源码为基础
移植，并在源文件中保留出处：

- `TextSnapshot` 的 UID 分配：以 `loaderId + backendNodeId` 作为节点身份；仍存在
  的节点跨 snapshot 复用 UID，消失的节点从 map 删除。
- `SnapshotFormatter` 的紧凑 AX 文本格式：`uid`、role、name、状态属性和两空格
  树缩进。
- select/combobox、toggle 与普通输入的 fill 分流。
- 键组合解析与失败后逆序释放已按下 modifier。
- 动作后等待可能导航并等待 DOM 短暂稳定的策略。
- `wait_for` 的“跨 frame、任一文本命中”语义。

有一处为 ExtensionTransport 做了明确适配：上游的
`Locator.race(...).wait()` 在本机真实 ExtensionTransport 中对已出现文本仍会
超时，因此 v2 使用跨 frame 的可见文本与可访问名称做 100ms、有 deadline 的
轮询。它不读取完整 DOM、不执行模型代码，也不改变 MCP observation 类型。

## UID 与失效规则

- snapshot 序号单调递增；新节点 UID 为 `<snapshotId>_<counter>`。
- 同一 loader/backend 节点仍存在时复用旧 UID。
- 节点从新 snapshot 消失后，其映射被移除；以后重新出现会获得新 UID。
- tab 的 URL 或 loading 状态变化立即清空当前 snapshot 与稳定 UID map。
- 导航后使用旧 UID 返回 `SNAPSHOT_REQUIRED`；不会尝试猜测或重新定位相似节点。
- DOM 非导航变化不会主动废弃整个 snapshot；如果具体节点已消失，动作返回
  `ELEMENT_STALE`。

## 有界 observation

- accessibility snapshot 最多 32,000 Unicode code points。
- 超限时在边界内加入 `... snapshot truncated ...`，结果永不超过上限。
- v2 在扩展生成端和 bridge result parser 两端都验证这个上限。
- `verbose=false` 使用 interesting AX tree；`verbose=true` 使用完整 AX tree，但
  仍受相同输出上限约束。
- `pageId`、UID、URL、键、输入文本、wait 文本数量与 timeout 都有 v2 的精确
  类型和长度/数值上限；未知字段直接拒绝。

## 动作与 outcome

成功动作只返回：

```text
performed=true
outcome=performed
url=<current URL>
navigatedToUrl=<new URL or empty>
```

失败继续使用 Tinker 一阶段定义的 error envelope：

- 参数、UID 或 attach 在动作前失败：`outcome=not_started`。
- mutation 已发出后发生执行错误、timeout 或 bridge 断线：
  `outcome=unknown`，且不可自动重试。
- read-only 的 summary、snapshot、wait 仍可根据 `retryable` 重试。
- bridge 不会因响应丢失而伪造 `performed`。

`click` 和 `hover` 先把元素滚动到视口并使用元素中心坐标发送真实 mouse input；
没有可见几何区域的节点明确失败，不对隐藏节点发送 synthetic click。`fill` 使用
Puppeteer locator 的表单语义；`type_text` 和 `press_key` 作用于当前焦点；
`scroll` 发送有界 mouse wheel delta。

## 真实 Chrome 验收记录

Chrome 150、`Tinker Dev` profile 上完成两组验收：

1. ExtensionTransport spike：从已有 example.com `pageId` 取得 AX snapshot，找到
   `Learn more` link 并点击，最终 URL 为
   `https://www.iana.org/help/example-domains`。
2. 正式 MCP v2：受控本地页面完整调用十项工具，验证：
   - 连续 snapshot 的 input UID 稳定；
   - `fill`、`type_text`、`press_key`、`click`、`hover`、`scroll` 均产生页面可见
     效果；
   - `wait_for` 能观察每个动态结果；
   - click 导航返回最终 URL；
   - 导航后旧 UID 返回 `SNAPSHOT_REQUIRED`；
   - 新 snapshot 返回新页面 AX tree。

## 暂不实现

- MCP multimodal observation、截图、视觉定位或坐标模型输出；
- 任意 JavaScript/evaluate 工具；
- 用户原有 tab 的 claim/release；
- 多 runtime 选择；
- iframe 内动作的坐标修正、shadow DOM 特殊 locator、drag、文件上传；
- mutation command journal 或断线后的 outcome recovery。
