# Tinker Chrome 三阶段：页面生命周期与调试观察

## 状态

- 版本：Tinker Chrome `0.3.0`，bridge protocol v2。
- 日期：2026-08-02。
- 范围：增加页面列举、导航、关闭、JavaScript dialog、console 和 network 调试观察。
- 验收：本机真实 Chrome 十八项工具 smoke 已通过。
- 所有操作继续只接受当前 runtime 通过 `open_page` 创建并持有的 `pageId`。
- MCP multimodal observation、截图、任意 JavaScript/evaluate 仍不在本阶段内。

二阶段的 AX snapshot、稳定 UID 和既有交互工具保持不变。v1 兼容协议也不修改；
`0.3.0` 只扩展严格 v2 的固定 capability 集合。

## 工具面

MCP server 离线时固定列出十八项工具，其中本阶段新增：

1. `list_pages()`
2. `navigate_page(pageId, type, url?, ignoreCache?, handleBeforeUnload?)`
3. `close_page(pageId)`
4. `handle_dialog(pageId, action, promptText?)`
5. `list_console_messages(pageId, pageIdx?, pageSize?, types?, includePreservedMessages?)`
6. `get_console_message(pageId, msgid)`
7. `list_network_requests(pageId, pageIdx?, pageSize?, resourceTypes?, includePreservedRequests?)`
8. `get_network_request(pageId, reqid)`

Tinker 不引入上游的全局 selected-page 状态。每个工具显式携带不透明 UUID
`pageId`；`list_pages` 也只列出当前 runtime 拥有的页面，不暴露 tab ID 或用户原有
标签页。结果按 Chrome window/index 排序，最多返回 100 页并显式报告截断。

## 页面生命周期和 dialog

- `open_page` 先创建 `about:blank` 标签、附着 ExtensionTransport 和 collector，再执行
  首次 HTTP(S) 导航，避免遗漏初始 console/network 事件。
- `navigate_page` 搬运上游 URL/back/forward/reload 分流和 beforeunload 自动处理；
  `ignoreCache` 只允许用于 reload，默认 accept beforeunload。
- 导航仍立即使 AX snapshot UID 失效；动作结果保留 Tinker 的 `performed`、
  `not_started`、`unknown` 语义。
- 普通 alert/confirm/prompt 由 session 持有。任一动作若打开 dialog，会在结果中返回
  type、message 和 default value，并跳过可能被 dialog 阻塞的 DOM 稳定等待；随后用
  `handle_dialog` accept/dismiss。ExtensionTransport 下输入命令可能随 renderer 一起
  暂停，因此动作完成与 dialog 事件竞速；dialog 胜出时先返回 observation，再由
  `handle_dialog` 释放并收敛原动作。prompt 文本只允许随 accept 发送。
- `close_page` 关闭 Chrome tab，同时清理 runtime ownership、Puppeteer session、
  collector 和 dialog 状态。

## 从 chrome-devtools-mcp 移植的调试算法

以下算法以 ChromeDevTools/chrome-devtools-mcp `PageCollector`、
`ConsoleFormatter`、`NetworkFormatter` 和 pagination utility 的 Apache-2.0 源码为
基础移植，源文件保留 license 和出处：

- console 和 network item 获得 session 内单调、稳定的数字 ID；list 返回 ID，get
  再按 ID 取得详细 observation。
- 数据按主 frame 导航分桶；默认只返回最新导航，preserved 模式按时间顺序合并最近
  三次导航。
- network collector 在 `framenavigated` 时把最后一个 main-frame navigation
  request 移入新桶，使新文档请求归属于新页面而不是旧页面。
- console list 按 type、text 和参数数量聚合连续重复消息；detail 延迟解析参数和堆栈。
- network list 输出 method、URL、status 和 resource type；detail 延迟读取 request/
  response headers、body、failure 和 redirect chain。
- 无效分页回到第 0 页，并返回当前页、总项数和总页数。

## Tinker 适配与边界

- 每次导航每类最多保存 1000 项，只保留最近 3 次导航；list 默认 50 项，单页最多
  200 项。
- list/detail 最终 observation 最多 32,000 Unicode code points；单个参数或 body
  最多 10,000 code points，并显式标记截断。
- request/response 中的 authorization、cookie、proxy-authorization、set-cookie 和
  x-api-key 在模型 observation 中始终脱敏。
- 无法再读取的 console 参数、二进制或已释放的 response body 返回稳定占位文本，
  不使整个列表失败。
- list/get 都是 read-only 调用；不存在的 `msgid`/`reqid` 返回不可重试的稳定错误。
- 所有 MCP 参数先规范化为完整 v2 params，再由扩展端 exact-key parser 二次验证；
  未知字段、越界值和非法字段组合直接拒绝。

## 开发与验收

本机开发 profile、扩展 ID、unpacked 路径和 Native Host 沿用二阶段文档。修改后的
完整循环：

```bash
bun run chrome:build
bun run chrome:diagnose
```

然后在 `chrome://extensions` 的 Tinker Chrome 卡片点击“重新加载”，并运行：

```bash
bun run chrome:smoke
```

smoke 会调用全部十八项工具，验证初始 console/fetch 捕获、list/get 详情、dialog、
历史导航、reload、AX UID 导航失效和 close 后 ownership 清理。源代码变更最终仍以
仓库根目录的 `bun run check` 为质量门禁。
