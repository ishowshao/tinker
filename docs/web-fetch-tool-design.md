# WebFetch Tool 设计方案

> **状态：已实现** — 采用三后端混合架构（本地静态抓取 + Exa `/contents` +
> `Bun.WebView` 无头浏览器），由独立路由器决定每个 URL 走哪个后端，静态抓取
> 拿不到内容时自动升级到浏览器渲染，提炼决策由统一的大小阈值控制。
> 实现见 `src/tools/web-fetch/`，测试见 `src/__tests__/web-fetch-tool.test.ts`。

## 背景

`tinker` 已经接入了基于 Exa `/search` 的 `WebSearch` 工具（见
`web-search-tool-design.md`），模型可以搜索网页并拿到链接和摘录。`WebFetch`
让模型能"打开"一个已知 URL 并读取其内容。

工具名和参数对齐 Claude Code 的同名工具，并保留其最有价值的性质：**不把网页
原文无限制地回填进对话**——大页面先经过"小模型提炼"，只把针对 `prompt` 的
回答返回给主模型，保护主模型的上下文。

## 对齐目标：Claude Code 的 WebFetch 契约

- 参数：`url`（必填，uri 格式）、`prompt`（必填，"要对抓取内容执行的提示"）。
- 行为：抓取 → HTML 转 markdown → 小模型按 `prompt` 提炼 → 返回提炼结果。
- 公网 URL 的 http 自动升级为 https；跨域重定向不自动跟随，把重定向地址
  返回给模型让它重新调用；每个 URL 有 15 分钟缓存。

## 总体架构：双后端 + 路由器 + 共享提炼管线

三个后端**同构**：输入相同（url + prompt），输出相同形状的中间结果。差异
封装在后端内部，管线对它们一视同仁。

```
WebFetch.execute(url, prompt)
  → 参数校验（scheme / URL 格式 / prompt 非空）
  → 本地缓存查询（15 分钟，key = url + prompt）
  → 路由器 decideRoute(url) → "local" | "exa" | "local-browser"
  → 后端抓取（A：本地 fetch + readability + turndown；B：Exa /contents；
              C：Bun.WebView 无头浏览器渲染后取 DOM）
  → 升级判定（仅 local 路由：抓取失败且无明确 HTTP 状态码，或内容为空
              → 用 C 重试一次，成功则采用）
  → 大小阈值判定（markdown ≤ 2000 字符？）
      ├─ 是 → 直接返回原文（不提炼）
      └─ 否 → 返回提炼结果
              （A：deepseek-v4-flash 二次调用；B：Exa 服务端 summary）
  → 写缓存 → 组装 WebFetchRawResult
```

### 后端接口

```ts
type WebFetchRoute = "local" | "exa" | "local-browser";

type WebFetchBackend = {
  route: WebFetchRoute;
  fetch(input: { url: string; prompt: string }): Promise<WebFetchBackendResult>;
};

type WebFetchBackendResult = {
  ok: boolean;
  finalUrl?: string;          // 重定向后的最终地址
  redirectUrl?: string;       // 跨域重定向：不跟随，回给模型（仅 local）
  title?: string;
  publishedDate?: string;
  markdown?: string;          // 转换后的正文（阈值判定的输入）
  refined?: string;           // 服务端已完成的提炼（仅 exa 的 summary）
  highlights?: string[];      // 仅 exa
  source?: "cached" | "crawled"; // 仅 exa
  errorTag?: string;
  httpStatusCode?: number;
  costDollars?: number;
  error?: string;
};
```

"同构"的含义：构型一样（都产出 `markdown` 供阈值判定），方法可以不一样
（提炼一个在本地二次调用模型，一个由 Exa 服务端完成，通过 `refined`
字段体现）。

## 路由器（独立模块）

`src/tools/web-fetch/route.ts`，单一职责：`decideRoute(url, context)`。
后续遇到 badcase（某类站点 Exa 抓不到、某内网域名误判等），只调整这个
模块，不动管线和后端。

v1 规则（自上而下命中即返回）：

1. host 在强制 browser 列表（强依赖 JS 渲染的站点，当前为空）且浏览器
   后端可用 → `local-browser`；
2. host 是 `localhost`、`*.localhost`、`*.local`、`*.internal` → `local`；
3. host 是 IP 且属于 `127.0.0.0/8`、`::1`、`10/8`、`172.16/12`、
   `192.168/16`、`169.254/16` → `local`；
4. host 在强制 local 列表（badcase 覆盖，当前含 `mp.weixin.qq.com`）
   → `local`；
5. 没有配置 `EXA_API_KEY` → `local`（优雅降级，公网也走本地抓取）；
6. 其余 → `exa`。

另有升级规则 `shouldEscalateToBrowser`（同在 route.ts）：`local` 路由的
结果满足"抓取失败且无明确 HTTP 状态码"（网络错误——4xx/5xx 浏览器也一样
会失败，不重试）或"抓取成功但内容为空"（典型 SPA：静态 HTML 里只有空壳）
时，自动用浏览器后端重试一次，成功则采用浏览器结果并把 `route` 标记为
`local-browser`；浏览器也失败则保留原始错误。

预留的演进方向（不在 v1 实现）：

- B 返回抓取类错误（如 `CRAWL_NOT_FOUND`）时自动回退 A 重试一次；
- 把强制 local / browser 列表扩展为可配置的 allowlist/denylist 覆盖规则。

## 后端 A：本地抓取

### 依赖（需新引入）

| 库 | 用途 |
|----|------|
| `linkedom` | 轻量 DOM 实现（jsdom 太重），供 readability 使用 |
| `@mozilla/readability` | 正文提取，去除导航、页脚等噪音 |
| `turndown` | HTML → Markdown 转换 |

readability 是为"文章页"设计的，直接套在所有页面上会出问题，因此提取
有三条防御规则（`extractMarkdownFromHtml`）：

1. **小页面跳过提取**：页面全文 < 4000 字符（app 型 UI、dashboard 等）
   时不跑 readability，直接全文转换——对这类页面做"正文提取"会丢侧边栏
   和控件（badcase：SPA 棋盘应用只剩棋盘坐标）；
2. **提取失败降级**：readability 返回 null（常见于非文章类页面）时，
   降级为对 `<body>` 全文做 turndown 转换；
3. **提取质量兜底**：readability 结果的文本量不足页面全文的 20% 时，
   视为丢失正文，同样降级为全文转换（badcase：微信文章正文被
   `visibility: hidden` 隐藏时整个被丢弃）。

提取前统一预处理：移除 `script/style/noscript/template`，并去掉
`visibility: hidden` / `opacity: 0` 内联样式（JS 揭示型页面，静态抓取
不会执行那段 JS）。

### 抓取行为

- Bun 原生 `fetch`，30s 超时（`AbortSignal.timeout`），响应体上限 5MB；
- 请求头带常规 Chrome UA 和 `accept-language: zh-CN`（部分站点如
  `mp.weixin.qq.com` 会对非浏览器 UA 返回反爬页）；
- **http→https 升级只对公网 URL 生效**；走 `local` 路由的 URL（本地 dev
  server 都是 http）保持原 scheme；
- 重定向：同 host 的自动跟随；**跨 host 的不跟随**，把重定向地址放进
  `redirectUrl` 返回给模型，让它用新地址重新调用（对齐 Claude Code）；
- Content-Type 处理：
  - `text/html` → readability + turndown；
  - `text/markdown`、`text/plain` → 原样通过；
  - `application/json` → 原样通过（pretty-print）；
  - 其他 → 明确报错（不支持的内容类型）。

### 提炼（> 2000 字符时）

用 `deepseek-v4-flash` 做二次调用（当前没有更小的模型，直接复用主模型）：

- 复用 `OpenAIChatModelClient`（`tools: []`），封装成 `Refiner` 接口，
  测试时可注入 fake；
- 输入：system 指令（"只依据给定内容回答，指明信息不足"之类）+ 截断到
  50k 字符的 markdown + 用户的 `prompt`；
- 模型名预留 `TINKER_WEBFETCH_REFINE_MODEL` 环境变量覆盖，默认取当前
  主模型配置。

## 后端 C：本地无头浏览器（`Bun.WebView`）

静态 `fetch` 对强依赖 JS 渲染的 SPA 有天花板——HTML 里只有空壳 `<div>`，
内容要执行 JS 后才存在。后端 C 用 Bun 1.3.12+ 内置的 `Bun.WebView`
（macOS 上走系统 WKWebView，零外部依赖）真实渲染页面后取 DOM：

1. `new Bun.WebView({ width: 1280, height: 800 })`（headless）；
2. `await view.navigate(url)`——主框架 load 完成后 resolve，30s 超时；
3. 等待 1s（`settleDelayMs`，给页面 JS 渲染时间）；
4. `view.evaluate("document.documentElement.outerHTML")` 取渲染后的
   HTML（上限 5MB），复用后端 A 的 `extractMarkdownFromHtml` 转 markdown；
5. `finally` 中 `view.close()` 释放；进程退出时 Bun 自动 `closeAll()`。

触发方式有两种（见路由器一节）：强制 browser host 列表直达，或 `local`
静态抓取失败/空内容时自动升级重试。浏览器渲染成本高（每次约 1–2s + 一个
渲染进程），所以不作为默认路由。

浏览器后端可用性由 `isBrowserBackendAvailable()` 探测（`Bun.WebView`
是否存在），不可用（如旧版 Bun）时该路由自动不参与。测试通过
`browserBackend: false | 注入 fake` 控制，避免单测真实拉起浏览器。

备选（未采用）：Playwright——跨平台更成熟，但引入较重的外部依赖；
`Bun.WebView` 与本项目技术栈契合且零依赖。注意其 API 标注为
`@experimental`，Bun 升级时留意变更。

### 关于 SSRF 的说明

tinker 是单用户本地 agent，模型本来就能用 Bash 工具执行任意 `curl`，
本地后端支持私网抓取正是设计目标而非漏洞。因此不做私网 IP 封禁，只保留
跨域重定向不跟随、大小与超时上限这些稳健性措施。

## 后端 B：Exa `/contents`

`POST https://api.exa.ai/contents`，header `x-api-key: $EXA_API_KEY`，
30s 超时，请求体：

```json
{
  "urls": ["<url>"],
  "text": { "maxCharacters": 20000 },
  "summary": { "query": "<prompt>" },
  "highlights": { "query": "<prompt>" },
  "livecrawlTimeout": 10000
}
```

### 为什么 text 和 summary 一次同时要

阈值判定需要先知道内容大小，而 Exa 的 summary 必须在发请求前决定要不要。
权衡三种做法后采用"一次调用全都要，判定在本地做"：

1. **（采用）text + summary 同时请求**：内容 ≤ 2000 字符返回原文、丢弃
   summary；> 2000 返回 summary。小页面浪费约 $0.001 的 summary 费用，
   换取单次往返。
2. 两阶段：先只要 text，超阈值再发第二次要 summary（命中 Exa 缓存）。
   省钱但大页面多一次往返。若日后在意成本可切换，管线结构不变。
3. B 也用本地模型提炼：同构最彻底，但放弃了 Exa 服务端提炼的低延迟。

### 响应映射

- 成功：`results[0]` 的 `text` → `markdown`，`summary` → `refined`，
  另取 `title` / `publishedDate` / `highlights`，`statuses[0].source`；
- 失败：`statuses[0].error` 映射 `errorTag` 与 `httpStatusCode`。

## 提炼决策（共享阈值）

- 常量 `WEB_FETCH_REFINE_THRESHOLD = 2000`（markdown 转换后的字符数），
  预留 `TINKER_WEBFETCH_REFINE_THRESHOLD` 环境变量覆盖；
- ≤ 阈值：observation 直接给原文（`refined=false`）；
- > 阈值：observation 给提炼结果（`refined=true`）——A 走本地 Refiner，
  B 直接用响应里的 `refined`（Exa summary），highlights 附在后面。

约 2000 字符 ≈ 500–1000 token，是"直接读原文比读摘要更有价值"的经验
分界，后续按实际使用调整。

## 工具契约与类型

- 名称：`WebFetch`；参数 `url`（必填）、`prompt`（必填，minLength 1），
  与 Claude Code 完全一致。
- 新增 `WebFetchRawResult` 加入 `ToolRawResult` 联合：

```ts
export type WebFetchRawResult = {
  ok: boolean;
  url: string;
  route?: "local" | "exa";
  finalUrl?: string;
  redirectUrl?: string;
  title?: string;
  publishedDate?: string;
  refined?: boolean;          // 是否经过提炼
  content?: string;           // 原文（未提炼时）或提炼结果
  highlights?: string[];
  source?: "cached" | "crawled";
  cacheHit?: boolean;         // 命中 15 分钟本地缓存
  errorTag?: string;
  httpStatusCode?: number;
  costDollars?: number;
  durationMs?: number;
  error?: string;
};
```

## Observation 渲染

```
Web fetch result for <url> (route=exa, refined=true):

<content（原文或提炼结果）>

Highlights:
- <highlight 1>
```

- 跨域重定向：`WebFetch was redirected to <redirectUrl>. Call WebFetch
  again with this URL.`；
- 失败：输出 `errorTag` / HTTP 状态码与错误信息。

## 本地缓存

进程内 15 分钟 memo（key = `url + prompt`），位于管线层、后端之上，两个
后端共享。只缓存成功结果；实现为 executor 闭包内的 Map，带过期清理。

## 注册

**WebFetch 无条件注册**（本地后端不依赖任何 key）；Exa 后端仅在
`EXA_API_KEY` 存在时创建，否则路由器全部导向 `local`。WebSearch 的条件
注册逻辑保持不变。

## TUI / stdout 展示

- `toolCallSummary`：`WebFetch <url>`；
- 结果摘要：`WebFetch <url> -> ok (exa, refined)` /
  `WebFetch <url> -> CRAWL_NOT_FOUND (404)`；
- `stdout-event-printer`：`tool.started name=WebFetch url=<url>`。

## 系统提示词

在 `SYSTEM_PROMPT` 中 WebSearch 一行之后追加：
"Use WebFetch to read the content of a specific URL, such as documentation
pages found via WebSearch or local dev server pages."

## 文件组织

```
src/tools/web-fetch/
  index.ts        # executor：校验、缓存、管线编排（含浏览器升级）、RawResult 组装
  backend.ts      # WebFetchBackend / WebFetchBackendResult 共享类型
  route.ts        # 路由器 + 升级判定（独立模块，badcase 只改这里）
  local-backend.ts
  exa-backend.ts
  browser-backend.ts  # Bun.WebView 无头浏览器渲染
  refiner.ts      # Refiner 接口 + 模型提炼实现（模型客户端惰性创建）
```

## 测试要点

沿用 WebSearch 的测试模式（注入 fetch stub / fake Refiner）：

1. 路由器：localhost、`*.local`、各私网段 IP、无 key 降级、公网走 exa；
2. 后端 A：HTML→markdown 转换、readability 失败降级、content-type 分支、
   同域重定向跟随、跨域重定向返回 `redirectUrl`、大小/超时上限、
   本地 URL 不做 https 升级；
3. 后端 B：请求体映射（text/summary/highlights）、响应映射、
   `statuses[].error` 映射；
4. 阈值：≤ 2000 返回原文且不调用 Refiner；> 2000 走提炼（A 调用注入的
   fake Refiner，B 取 summary）；
5. 缓存：相同 url+prompt 第二次不发 HTTP 请求；
6. 参数校验：缺 url / 非法 scheme / 空 prompt；
7. observation 渲染（原文 / 提炼 / 重定向 / 失败）；
8. `createDefaultTooling`：WebFetch 始终注册；
9. 浏览器升级（注入 fake browser 后端）：空内容升级成功、HTTP 4xx/5xx
   不升级、浏览器也失败时保留原始错误；`shouldEscalateToBrowser` 各分支。

## 参考

- Exa `/contents` 文档：https://exa.ai/docs/reference/get-contents
- Exa coding agents 指南：
  https://exa.ai/docs/reference/search-api-guide-for-coding-agents
- 既有实现：`web-search-tool-design.md`、`src/tools/web-search.ts`
