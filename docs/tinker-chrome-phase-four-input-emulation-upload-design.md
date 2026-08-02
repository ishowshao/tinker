# Tinker Chrome 四阶段：输入、环境仿真与文件上传

## 状态

- 版本：Tinker Chrome `0.4.0`，bridge protocol v2。
- 日期：2026-08-02。
- 范围：批量表单、拖拽、双击、响应式尺寸、浏览器环境仿真与单文件上传。
- 工具面：MCP server 离线时固定列出二十三项工具。
- 所有页面操作继续只接受当前 runtime 通过 `open_page` 创建并持有的 `pageId`。
- MCP multimodal observation、截图和任意 JavaScript/evaluate 仍不在本阶段内。

三阶段的页面生命周期、dialog、console/network collector 不变；v1 兼容协议也不
修改。`0.4.0` 只扩展 strict v2 capability 和现有 `PageAutomationSession`。

## 新增与扩展的工具

本阶段新增五项工具：

1. `fill_form(pageId, elements[], includeSnapshot?)`
2. `drag(pageId, fromUid, toUid, includeSnapshot?)`
3. `resize_page(pageId, width, height)`
4. `emulate(pageId, networkConditions?, cpuThrottlingRate?, geolocation?, userAgent?, colorScheme?, viewport?, extraHttpHeaders?)`
5. `upload_file(pageId, uid, filePath, includeSnapshot?)`

既有工具增加两个窄扩展：

- `click` 增加 `doubleClick?` 和 `includeSnapshot?`；
- `fill`、`press_key`、`hover` 增加 `includeSnapshot?`。

动作后快照在动作已经成功后单独读取。如果 dialog 正在阻塞 renderer，结果明确
报告 `postActionSnapshot=blocked_by_dialog`；如果快照失败，动作结果仍保持
`outcome=performed`，并附带 snapshot error，不把已经发生的操作伪装成失败。

## chrome-devtools-mcp 移植边界

实现以 ChromeDevTools/chrome-devtools-mcp commit
`c5ebf9e2023ec37c77d2ee355a345249ac91d192` 的以下算法为基础，保留原有 Puppeteer
调用序列，只适配显式 `pageId`、strict v2 和 Tinker outcome：

- `src/tools/input.ts`：`fill_form` 的逐元素 fill、`drag` 的
  `drag -> 50ms -> drop`、文件 input 与 file chooser 两级上传、双击和动作后 snapshot；
- `src/tools/pages.ts`：保留“先恢复 normal、再按内容区尺寸调整”的算法；由于
  ExtensionTransport 的 tab session 不暴露 browser-level target，扩展改用
  `chrome.windows` 规范化窗口状态，并按 outer window 与页面 viewport 的差值换算目标
  窗口尺寸；
- `src/tools/emulation.ts` 与 `src/McpPage.ts`：网络、CPU、地理位置、user agent、
  `prefers-color-scheme`、viewport 和额外 HTTP headers 的 Puppeteer emulation；
- `src/WaitForHelper.ts`：按网络档位与 CPU 倍数放大 page timeout。

Tinker 不引入上游 selected-page 全局状态。所有新动作仍进入每个 tab 的串行
`PageAutomationSession`，复用导航观察、DOM 稳定等待、dialog 竞速、AX UID 失效和
bridge 断线语义。

`fill_form` 复用已有 select/toggle/input fill 算法并逐项执行。若中途导航或打开
dialog，停止后续字段；若前面字段已经成功而后续字段失败，错误明确返回
`outcome=performed` 和 `completedElements/totalElements`，避免错误重试整个表单。

## `emulate` 合同

MCP 参数沿用上游适合模型生成的文本格式，进入 bridge 前规范化成 exact-key v2
结构：

- `geolocation`: `<latitude>,<longitude>`；
- `viewport`: `<width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape]`；
- `extraHttpHeaders`: JSON object string；空字符串清空，省略时保留当前 headers；
- 省略 network、CPU、geolocation、UA、color scheme 或 viewport 会恢复默认值；
- network 档位为 Offline、Slow/Fast 3G、Slow/Fast 4G，CPU slowdown 为 1–20。

扩展端二次验证数值、枚举、viewport tags 和 header string values。设置 viewport 放在
timeout 更新之后，因为 Puppeteer 可能因 mobile/touch 状态变化触发 reload；任何真实
导航仍使旧 snapshot UID 失效。

## 文件边界

Tinker MCP client 现在按 MCP roots 标准公布当前 canonical workspace root。`upload_file`
在 MCP server 侧先 realpath 并验证 regular file，只允许：

- client 返回的 `file:` workspace roots 内文件；
- 系统临时目录内文件，供生成的临时 fixture 和一次性上传使用。

相对路径、不存在的文件、目录、symlink 逃逸以及 roots 之外的路径在进入 Chrome
bridge 前分别返回 `FILE_NOT_FOUND` 或 `FILE_ACCESS_DENIED`。扩展只收到已经规范化的
绝对路径。启动 stdio MCP server 时也显式传递父进程的有效 `TMPDIR`/`TEMP`，确保 client
生成的临时文件和 server 认可的系统临时目录一致。

## 验证

自动测试覆盖：

- 二十三项固定 tool surface 和 MCP 参数规范化；
- strict v2 新 capability、exact params、emulation bounds 和 action results；
- workspace roots 协商以及 upload realpath/root/temp 边界；
- 动作成功后 snapshot、dialog 阻塞和 snapshot failure 不覆盖动作 outcome；
- extension browser bundle 构建。

真实 Chrome smoke 使用 `Tinker Dev` profile 的 unpacked extension，验证表单批量填写、
双击、拖拽、上传、800×600 resize、640×480 dark/UA/header emulation，以及原有
console/network/dialog/导航/UID 失效/close 全链路。最终质量门禁仍是仓库根目录的：

```bash
bun run check
```
