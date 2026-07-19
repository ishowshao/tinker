# 多模态图片输入技术方案（候选实现合同）

## 文档状态

本文是 Tinker TUI 图片输入能力的候选实现合同，用于冻结交互、消息协议、资产存储、
持久化和上下文计量边界。本版已根据对现有实现的第二轮逐条核对完成修订，补齐了
不可变资产引用、inline range 持久化、同步规划与异步物化拆分、Token admission、
Prompt 提交事务、事件投影和 provider 聚合限制。文末仍列为“需真实验证”的 endpoint
行为在验证完成前不得凭假设实现。

本文采用与 Codex CLI 相同的核心思路：Prompt Input 中显示可编辑的
`[Image #N]` 占位符；提交给模型时先发送带名称的图片块，最后发送包含这些占位符的
完整 Prompt 文本。图片不按照占位符在句子中的位置穿插发送。

当前可用于真实集成验证的多模态 provider 只有 Kimi K3。MVP 只实现 Kimi 的图片请求
和远端 Token 计数适配器，但通用层仍通过 profile 显式声明能力和适配器类型，不根据
`kimi-k3` 等模型名称猜测行为。Kimi 文档目前已经在 Chat API 和图片示例中列出
`kimi-k3`；Token estimate 页面也给出了 K3 示例，但其生成的 request model enum 仍未
列出 K3。本文只把后者视为需要真实 endpoint 验证的 schema/documentation 不一致。

## 背景

Tinker 当前通过 OpenAI SDK 调用 Chat Completions 兼容接口。内部 `AgentMessage`、
session ledger、Prompt 历史和 OpenAI 映射都把用户消息表示为纯字符串：

```ts
type UserMessage = {
  role: "user";
  content: string;
};
```

TUI 已支持使用 `@` 搜索工作区文件，但选中结果后只会把路径插入文本，不读取文件，
也不会形成结构化附件。要支持多模态模型，不能只在 `openai-chat-mapping.ts` 中临时把
路径替换成 Base64；图片身份、删除、历史恢复、session 持久化、上下文预算和模型能力
都需要拥有一致的结构化表示。

本方案参考 Codex CLI 的交互与请求组织方式，但按 Tinker 当前的 OpenAI Chat
Completions 协议和 session 架构重新设计。

## 目标

- 继续通过 `@` 搜索工作区文件，不增加 `/attach` 命令。
- 选中受支持的图片后，在 Prompt Input 中插入 `[Image #N]` 原子元素。
- 占位符可随普通文本一起移动光标和编辑，但不能被拆开或部分删除。
- 删除图片占位符时同步删除附件，并重新连续编号剩余图片。
- 提交时先发送带 `[Image #N]` 名称的图片块，最后发送完整 Prompt 文本。
- 图片和用户消息一起进入 session 的历史真相，支持 timeline 展示、`/resume` 和后续
  agent iteration 重放。
- Prompt 历史能够恢复文本、占位符和对应图片，而不是只恢复失效的字符串标签。
- 模型不支持图片、图片不可读或附件状态不一致时快速失败，不静默删除图片，也不把
  图片降级成普通文件路径。
- 不向模型发送本机绝对路径；Base64 只存在于已 materialize 的 provider payload 中，
  不进入日志、事件、SQLite，也不写入内存中的 canonical `AgentMessage`。

## 非目标

- 本阶段不支持远程图片 URL。
- 本阶段不支持从系统剪贴板直接粘贴图片字节。
- 本阶段不在 TUI 中渲染图片缩略图。
- 本阶段不支持 one-shot CLI 的图片参数。
- 本阶段不支持 PDF、SVG、视频或音频附件。
- 本阶段不根据文件扩展名盲目判断图片类型。
- 本阶段不为不支持图片的模型提供 OCR、文件路径或文字说明等兼容降级。
- 本阶段不解决已被上下文退休的历史图片如何被 Recall 自动重新注入。
- 本阶段不提供 v8 到 v9 的 session schema 迁移：旧 session 打开时以
  `SESSION_SCHEMA_UNSUPPORTED` 快速失败，属于预期行为。
- 本阶段不支持附加工作区之外或被 `.gitignore` 忽略的图片（`@` 候选来自
  `rg --files`，遵循 ignore 规则）。

## 核心设计结论

### 1. Prompt 文本保留完整引用关系

用户看到并编辑的文本保持为：

```text
比较 [Image #1] 和 [Image #2] 的页面差异
```

`[Image #N]` 同时是可读标签和模型引用名，但不是附件的持久主键。内部使用在 draft
及单条 committed message 生命周期内稳定的 `attachmentId` 关联占位符与图片资产，避免
通过字符串猜测附件身份。

### 2. 图片在前，完整文本在后

发送给 Chat Completions 兼容接口的用户消息采用以下顺序：

```json
[
  {
    "type": "text",
    "text": "<image name=[Image #1]>"
  },
  {
    "type": "image_url",
    "image_url": {
      "url": "data:image/png;base64,..."
    }
  },
  {
    "type": "text",
    "text": "</image>"
  },
  {
    "type": "text",
    "text": "<image name=[Image #2]>"
  },
  {
    "type": "image_url",
    "image_url": {
      "url": "data:image/png;base64,..."
    }
  },
  {
    "type": "text",
    "text": "</image>"
  },
  {
    "type": "text",
    "text": "比较 [Image #1] 和 [Image #2] 的页面差异"
  }
]
```

这种结构不依赖图片在数组中与引用文本相邻。模型通过图片块中的
`name=[Image #N]` 和最终完整 Prompt 中相同的 `[Image #N]` 建立对应关系。

本方案不发送 Codex CLI 使用的本地绝对路径：

```text
<image name=[Image #1]>
```

而不是：

```text
<image name=[Image #1] path="/Users/.../screenshot.png">
```

### 3. UI 表示与模型 wire format 分离

Prompt Input、session ledger 和模型适配器分别承担不同责任：

| 层级 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| Prompt Input | 原子占位符、光标、删除、附件选择 | Base64 和 provider payload |
| Turn/session | 稳定附件身份、资产引用、历史与完整性 | TUI 光标状态 |
| Model adapter | 加载资产、编码 data URL、生成有序 content parts | 从纯文本猜测附件 |

任何一层都不得通过正则扫描普通 `[Image #N]` 字符串来恢复已经丢失的结构化关系。

## 数据模型

### 通用类型

图片一旦通过选择阶段写入 asset store，后续 draft、Prompt 历史和 canonical message
全部只引用不可变资产，不再依赖源文件路径：

```ts
type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";

type ImageAttachmentId = string & { readonly __brand: "ImageAttachmentId" };
type ImageAssetId = string & { readonly __brand: "ImageAssetId" };

type CodePointRange = {
  start: number;
  end: number;
};

type ImageAssetRef = {
  assetId: ImageAssetId;
  mimeType: ImageMimeType;
  byteLength: number;
  width: number;
  height: number;
};
```

`CodePointRange` 一律是左闭右开 `[start, end)`。`assetId` 就是原始图片字节的 64 字符
小写十六进制 SHA-256；不再同时维护语义重复、可能漂移的 `assetId` 和 `sha256` 两个
字段。`attachmentId` 由现有 ID factory 生成 canonical lowercase UUIDv7，不接收用户
输入；它只在 draft 和单条 message 关系内提供身份。只有 digest 计算器或严格的
64-hex parser 能创建 branded `ImageAssetId`，asset path API 不接受裸字符串。

### Prompt Draft

把当前只有 `LineEditorState` 的输入状态扩展为：

```ts
type PromptDraft = {
  editor: LineEditorState;
  elements: readonly PromptElement[];
  attachments: readonly DraftImageAttachment[];
};

type PromptElement = {
  kind: "image";
  attachmentId: ImageAttachmentId;
  label: string;
  range: CodePointRange;
};

type DraftImageAttachment = {
  attachmentId: ImageAttachmentId;
  asset: ImageAssetRef;
  originalName: string;
};
```

`sourcePath` 只存在于尚未完成的附件创建操作中，不进入 `PromptDraft`。附件写入 asset
store 成功后，draft 立即切换为 `ImageAssetRef`；因此源文件随后被移动、覆盖或删除都不
影响 draft 和将来的提交。

`range` 使用 Unicode code point 索引：`line-editor.ts` 现有实现全部以 `[...value]`
展开后的 code point 为单位移动光标和删除，element range 必须使用同一单位。禁止混入
JavaScript UTF-16 code unit（`String.prototype.length` / `slice`）或 UTF-8 byte
offset，否则遇到 emoji 等增补平面字符时 range 会错位。实现前应先把"code point
索引"写入 `line-editor.ts` 的公开合同。

以下不变量必须由统一的 draft 校验器维护：

- 每个 `PromptElement.attachmentId` 恰好对应一个 attachment。
- 每个 attachment 恰好对应一个 image element。
- element 的文本范围必须完整等于 element 当前的 `label`。
- element 之间不能重叠，range 必须按位置递增。
- element label 必须是从 `[Image #1]` 开始的连续编号。
- attachment 顺序必须由对应 element 的 range 顺序派生，不能另设加入顺序。
- `assetId` 必须是 64 字符小写十六进制，所有数值字段必须是正安全整数。
- `originalName` 必须满足 NFC basename、255 UTF-8 bytes 和控制字符限制。
- 普通用户输入的字面量 `[Image #1]` 仍然只是普通文本，不自动升级成 element。
- draft 中存在附件时，任何未绑定的普通文本都不得与当前生成的 image label 完全相同；
  检测到冲突时禁止提交并提示用户改写字面量。这样 wire text 中的引用保持无歧义。

### 提交后的用户消息

`AgentMessage` 的 user 分支扩展为结构化内容：

```ts
type UserMessage = {
  role: "user";
  content: string;
  attachments?: readonly UserImageAttachment[];
};

type UserImageAttachment = {
  attachmentId: ImageAttachmentId;
  assetId: ImageAssetId;
  label: string;
  range: CodePointRange;
  mimeType: ImageMimeType;
  byteLength: number;
  width: number;
  height: number;
  originalName: string;
};
```

`content` 继续保存用户看到的完整文本，因此现有 timeline、Recall 文本和全文搜索仍有
可读内容。`attachments` 是 canonical message 的组成部分，必须参与消息哈希、context
编译校验和 session 完整性校验。没有附件时 `attachments` 字段必须缺省，禁止空数组：
同一条消息只允许一种合法编码，否则消息哈希不唯一。

提交时把 draft element 和 asset metadata 合并为 `UserImageAttachment`。提交后的 range
必须继续指向 `content` 中唯一、完整的 label；timeline、`/resume` 和模型映射都使用这组
结构化记录，禁止通过 label 正则反推 occurrence。

不应把 `sourcePath` 写进 canonical message 或 Prompt 历史。`originalName` 只保存 NFC
normalized basename，必须非空、UTF-8 不超过 255 bytes，并拒绝 `/`、`\`、NUL 和控制
字符；它属于一次 attachment，不属于内容寻址 asset。

### 图片资产

图片字节使用 workspace 级内容寻址存储：

```text
.tinker/assets/images/<assetId>
```

`assetId` 使用图片原始字节的 SHA-256。相同图片只保存一份，session 消息和 Prompt
历史都只引用该资产。Base64 只在构造 provider 请求时生成，不落盘。

选择图片时通过同一个已打开 file handle 完成常规文件检查、实际字节上限、MIME、尺寸、
静态图片约束和 SHA-256 计算，禁止先检查一个文件再重新打开另一个版本。候选 realpath
必须位于 canonical workspace root 内，符号链接不能绕过“工作区内图片”边界。

资产写入采用同目录临时文件、`0600` 权限、文件 `fsync`、no-clobber 原子发布和父目录
`fsync`；目录使用 `0700`。并发进程已经发布同一 `assetId` 时，当前进程必须重新验证
既有目标是常规文件且字节数、digest、MIME 和尺寸一致，不能覆盖或信任未知目标。asset
root 与现有 session root 一样需要拒绝 symlink 和非 canonical 路径。资产发布成功后才
允许向 Prompt Input 插入占位符。

staging 文件名固定为 `.staging-image-<uuidv7>`，正常失败/cancel 在 `finally` 用非递归
`rm` 清理。asset store 打开时只清理严格匹配该格式、是常规文件且 mtime 超过 24 小时的
staging 文件，避免与另一进程正在导入的文件竞争；时钟异常或属性不明时保留并报警。
未知文件、symlink 和已发布的 64-hex asset 永不被该清理器删除。

初版不自动回收无引用资产。自动 GC 需要同时扫描所有 session 数据库和 Prompt 历史，
并先定义 append-only Prompt 历史中哪些 entry 仍属于保留集；应单独设计，不能只按当前
session 判断。

## `@` 选择与附件创建

现有文件候选继续使用工作区文件搜索。候选选中后的行为按实际文件类型分流：

- 普通文件：保持现有行为，把工作区相对路径插入文本。
- 支持的图片：移除当前 `@查询` token，在相同位置插入新的 image element。
- 看似图片但格式不支持、包含动画或内容损坏：显示明确错误并保留当前 draft。

图片来源存在已知限制：工作区文件搜索使用 `rg --files --hidden` 并遵循
`.gitignore`，工作区之外的文件（如桌面截图）和被忽略目录中的图片都不会出现在候选
里。叠加非目标中排除的剪贴板粘贴与远程 URL，MVP 中图片必须先放进工作区内对
ripgrep 可见的路径才能附加。这是有意取舍，验收时不应视为缺陷。

### 格式和产品限制

图片识别必须读取文件头并完成格式解析，不能只检查扩展名。MVP 固定支持：

- PNG，但拒绝 APNG；
- JPEG；
- 静态 WebP，拒绝 animated WebP。

GIF、SVG 和其他格式直接拒绝。Kimi
[图片输入指南](https://platform.kimi.ai/docs/guide/use-kimi-vision-model) 虽然列出了
GIF，但动画帧、Token 成本和不同 decoder 的取帧语义都没有进入本阶段合同，因此不能
把 GIF 当作静态图悄悄接收。

图片探测不手写 JPEG/WebP decoder。MVP 固定引入
[`sharp`](https://sharp.pixelplumbing.com/install/) 并锁入 `bun.lock`；其官方安装文档明确
支持 Bun 和常见 macOS/Linux 预编译包。先用严格 magic bytes 只放行 PNG、JPEG、WebP
container，其他格式不交给 sharp；再对从同一 file handle 读出的 Buffer 使用
[metadata()](https://sharp.pixelplumbing.com/api-input/#metadata) 验证 format/media
type/width/height，再按
[constructor safety options](https://sharp.pixelplumbing.com/api-constructor/#sharp)，以
`limitInputPixels = effectiveMaxPixels`、`unlimited = false`、`failOn = "warning"` 执行
一次 `.raw().toBuffer()` 完整 decode probe，确保不只信任 header；`warning` 是 sharp 官方
对不受信输入建议的最高敏感级别。probe 产物立即释放，asset store 仍保存原始字节，不做
转码、旋转或 metadata strip。

完整 decode 只发生在 asset 首次导入。session open 与 materialization 重新校验常规文件、
长度和 digest，并用 header metadata 交叉检查 MIME/尺寸；digest 已证明字节仍是导入时
通过 full probe 的同一内容。禁止在每个 agent iteration 重复 raw decode。

动画检测不能只依赖“帧数大于 1”：单帧 animated container 也应拒绝。PNG 额外使用有
边界与 chunk-length 校验的 container parser 检测 `acTL`；WebP 检查 RIFF/VP8X animation
flag 及 `ANIM`/`ANMF` chunks，并与 sharp metadata 交叉验证。禁止用原始字节 substring
搜索 chunk 名。decoder、container parser 或二者结论冲突时快速失败。`sharp` 的 Bun
安装、macOS arm64 和 CI Linux 预编译包加载 smoke test 是阶段 B 门禁，不把 native
dependency 失败留到用户第一次附图时才发现。

默认产品限制固定如下；profile 只能进一步收紧，不能放宽本地安全上限：

| 限制 | 默认值 | 适用时机 |
| --- | ---: | --- |
| 单图原始字节 | `20 MiB` | 选择时 |
| 单条 user message 图片数 | `8` | 选择和提交时 |
| 单次 provider request 图片总数 | `8` | admission 时，包含 active history |
| 任一边像素 | `4096` | 选择时 |
| 总像素 | `8,847,360`（`4096 × 2160`） | 选择时 |
| 最终 JSON request body | `90,000,000` UTF-8 bytes | materialization 后 |

`maxLongEdge` 与 `maxPixels` 必须同时满足，横图和竖图使用相同规则。解析器还必须检查
宽高为正安全整数、格式完整且不是动画；不能为了读取尺寸而无界解压整张图片。Kimi
文档建议图片不超过 4K，并给出请求体不超过 `100M` 的限制；Tinker 使用 `90,000,000`
bytes 给 JSON、Base64 和 tool schema 留出余量，而不是把 provider 极限直接作为产品
极限。

选择阶段用 `4 * ceil(byteLength / 3)` 加固定 JSON 开销，对当前 active context 与新
draft 做累计下界预检；下界已经超限时立即拒绝，避免用户附完多张图后才得知必然无法
提交。该预检不能代替最终 JSON UTF-8 字节数检查。图片限制按 content-part occurrence
计数：同一 asset 在两条历史消息中出现两次，就占两个图片名额，请求体也包含两份 data
URL；materialization cache 只避免重复读盘和编码。

### 异步创建事务

图片选择是异步事务。Prompt Input 至少需要以下状态：

```ts
type PromptInputPhase =
  | { kind: "idle" }
  | { kind: "attaching"; operationId: string }
  | { kind: "restoring_history"; operationId: string; targetIndex: number }
  | { kind: "admitting"; submissionId: string }
  | { kind: "maintenance_offer"; reason: "budget" | "media_aggregate" }
  | {
      kind: "maintaining_context";
      strategy: "compact" | "retire" | "clear";
    };
```

进入 `attaching` 或 `restoring_history` 后冻结 editor、历史导航、提交和 `/model`，避免
资产校验期间 token range 已经变化。`Esc` 和组件卸载通过 `AbortSignal` 取消操作；迟到的
异步结果必须用 `operationId` 丢弃。附件创建流程为：

1. 对当前 model profile、draft 单图数量和 active aggregate 做同步预检，并纯计算一次
   projected insertion/renumbering，提前发现 literal-label 冲突；
2. 捕获要替换的 `@查询` code-point range；
3. 对候选执行 `lstat`、realpath containment 和 no-follow open，再比较 path/file-handle
   的 device/inode；用该 file handle 校验常规文件、字节数、MIME、尺寸和静态图片约束，
   同时计算 digest；
4. no-clobber 发布资产并得到完整 `ImageAssetRef`；
5. 生成新的 `attachmentId`，在捕获范围插入 element；
6. 重新编号，并对整个新 draft 运行不变量校验；
7. 一次性提交新 draft，然后回到 `idle`。

任一步失败或取消都恢复原 draft，不留下半个占位符。资产已经发布但 UI commit 失败时，
允许留下无引用的内容寻址文件，由未来单独设计的 GC 处理。

## Prompt Input 编辑与提交

### 原子元素

图片占位符在渲染上是固定文本，在编辑上是一个字符单元：

- `←` / `→` 一次跳过整个 element；
- 光标不能停在 `[Image #N]` 内部；
- element 末尾的 Backspace 删除整个图片；
- element 开头的 Delete 删除整个图片；
- `Ctrl+U` 或其他跨范围删除只要覆盖 element 任意部分，就删除整个 element；
- 普通插入不能发生在 element 内部；
- 删除 element 时同时删除对应 attachment。

所有文本变更和光标移动都必须走统一的 `applyEdit` / `normalizeCursor` 边界，原子更新
文本、code-point ranges、attachments 和 cursor。`moveUp` / `moveDown` 按目标视觉列
计算后也要执行 cursor normalization；若目标落入 element，吸附到距离最近的边界，
距离相等时按移动方向选择边界。不能只修左右键，否则垂直移动仍能进入 element。

### 编号与重新编号

`attachmentId` 在 draft 生命周期内保持稳定，`[Image #N]` 只是派生标签。新增、删除或
移动 element 后，按 element range 顺序生成连续标签，并原子替换 element payload。

```text
删除前：[Image #1] 和 [Image #2]
删除 #1 后：[Image #1]
```

剩余图片的 `attachmentId` 和 `assetId` 不变，只把显示及模型引用标签从
`[Image #2]` 改为 `[Image #1]`。MVP 每条消息最多 8 图，所有派生 label 等长；实现仍通过
一次结构化 edit 重算 ranges 并运行完整 draft 校验，不维护文本和 range 两套增量算法。
若未来把上限提高到 10 以上，必须先扩展 variable-width label 合同和测试。attachment
顺序永远由最终 range 顺序派生，不保存第二套“加入顺序”。

### 粘贴和 Slash command

普通文本粘贴中的 `[Image #N]` 不具备附件语义，也不支持粘贴图片字节。draft 中只要
存在附件，就不把整段输入解释为本地 slash command。未来若要让命令携带附件，必须按
命令单独定义；MVP 不允许命令路由悄悄清空附件。

### 结构化规范化

当前提交路径对字符串直接调用 `trim()`；结构化 draft 不能沿用这个行为。提交前必须用
code-point aware 的规范化函数计算首尾空白删除范围、平移 element ranges 和 cursor，
然后重新校验 draft。该函数返回 immutable submission snapshot，不先改屏幕中的原 draft；
admission 失败时因此可以逐字段原样保留。禁止先 trim 字符串再尝试从标签重建 ranges。

规范化结果至少含一个非空普通文本 code point 或一个 image element；仅空白仍为空
Prompt。若普通文本与派生 image label 冲突，规范化失败并保留 draft。

### 请求受理边界

不能在调用异步 runtime 前立即清空 Prompt Input。提交使用两阶段合同：

```ts
type AcceptedTurn = {
  turnId: string;
  userMessage: UserMessage;
  completion: Promise<RunAgentResult>;
};

function admitTurn(
  draft: PromptDraft,
  options: { signal: AbortSignal },
): Promise<AcceptedTurn>;
```

`admitTurn` 在返回前依次完成：draft 规范化与校验、目标 profile 校验、同步 context
planning、资产完整性检查、带图 candidate 的异步 materialization、必要的 provider
Token 计数、最终预算与聚合限制校验，以及 `beginTurn` 的 SQLite 原子提交。只有
`beginTurn` 成功才算 accepted。首次 dispatch 必须复用 admission 已检查的 prepared /
materialized artifact，不能提交后重新构造另一份请求；artifact fingerprint 与 admission
usage snapshot 一并交给 pending turn。

admission 前的 planning 不得提交 context revision。超预算时快速失败，并提示用户先独立
执行 `/compact` 或 `/compact retire` 后重试；不能在一个尚未 accepted 的提交里暗中改变
session 历史。现有“turn 完成后”的自动 context maintenance 保持原边界，不扩展到
admission 前。

由于带附件 draft 不走 slash-command parser，budget/media aggregate 错误必须提供独立的
maintenance offer，不能只在错误文字里让用户输入 `/compact`。offer 模态固定为：`c`
执行现有 `/compact`、`r` 执行 `/compact retire`、`n` 按 `/clear` 语义创建相同 profile
的新 session、`Esc` 返回编辑。`n` 用于图片仍位于 retirement protection floor 等无法
释放 aggregate 的情况；旧 session 继续可 `/resume`。运行期间 draft 保持冻结，操作失败
仍属于原 session；新 session 创建成功后 draft 原样保留，且所有操作都不自动重提。这样
context/session 变更仍由用户显式触发，也不会为执行命令迫使用户丢掉图片 draft。`@`
选择阶段已知 active aggregate 必然超限时也使用同一 offer，且在打开源文件前触发。
为保证 `n`，PromptDraft 的 owner 必须跨 `TuiSessionBinding` replacement 存活；不能给
PromptInput 加 session-key remount，也不能在 Header/timeline reset 时顺带重建 draft。

- admission 失败或取消：保留原 draft 和 cursor，不追加 Prompt 历史。
- accepted：清空已提交 draft，把结构化 entry 追加到 Prompt 历史，并等待
  `completion`。
- accepted 后模型或工具失败：不恢复旧 draft；session 已有可审计的 user message 和
  failed turn。
- Prompt 历史写入发生在 accepted 之后；它失败时显示警告，但不能回滚已经提交的
  session turn，也不能再次发送同一条消息。

SQLite commit 是不可逆的 acceptance point：一旦成功，后续 event append、dispatch
注册或 UI 通知失败都必须表现为 `AcceptedTurn.completion` 的失败，而不是让
`admitTurn` 以“未受理”拒绝。否则 TUI 会错误保留 draft，用户重试后形成重复 turn。
abort race 也以该点划分：commit 前观察到 abort 就保留 draft 且不建 turn；commit 后才
观察到 abort 则返回 accepted、清空 draft，并按现有 turn-cancel 合同关闭已提交 turn。

`admitting` 期间冻结编辑、历史导航、再次提交和 `/model`。这比允许用户继续编辑后再做
版本合并简单，也消除了重复提交和“清空了错误版本 draft”的竞态。

锁不能只存在于 React：`RuntimeSession` 增加 `admitting` 状态，从 candidate capture 到
commit/失败期间拒绝另一 turn、compact、retire 和 session switch；内部调度的
skills/surface commit 排队到 admission 结束，不能插入 candidate 与 commit 之间。
dispose/cancel 只能通过 admission 的 AbortController 收敛。commit 成功时在释放锁前转为
`executing`，失败时回到 `ready`。`AdmissionBaseToken` CAS 仍保留，用于检测外部写入和
遗漏的异步 mutation。

## 模型能力与 profile

不能根据模型名称猜测是否支持图片。`ModelProfile` 增加明确能力与聚合限制：

```json
{
  "model": "kimi-k3",
  "inputModalities": ["text", "image"],
  "imageInput": {
    "transport": "openai-chat-image-url-data-v1",
    "allowedMimeTypes": ["image/png", "image/jpeg", "image/webp"],
    "maxBytesPerImage": 20971520,
    "maxImagesPerMessage": 8,
    "maxImagesPerRequest": 8,
    "maxLongEdge": 4096,
    "maxPixels": 8847360,
    "maxRequestBodyBytes": 90000000,
    "planningTokensPerImage": 2048,
    "retryPolicy": "none"
  },
  "tokenEstimator": {
    "kind": "moonshot-estimate-token-count-v1",
    "timeoutMs": 30000,
    "maxRetries": 0
  }
}
```

约束如下：

- `inputModalities` 未包含 `image` 时，`@` 选中图片立即失败。
- 声明 `image` 时必须提供完整、合法的 `imageInput` 和 Token estimator；profile
  加载阶段就拒绝缺失、未知 transport、非法 MIME 或非正安全整数。
- effective MIME 集合取内置集合与 profile 集合的交集；所有 `max*` ceiling 取较小值；
  `planningTokensPerImage` 取内置 floor 与 profile 配置的较大值。profile 不能借配置
  放宽本地安全边界或降低规划 charge。
- `planningTokensPerImage` 是同步规划 charge，不是 provider 计费承诺。在真实 endpoint
  校正前，`2048` 只是显式保守起点，不能单独作为最终 admission 依据。
- Kimi transport 只发送 `image_url.url`，不发送其 schema 未声明的 `detail`。
- `tokenEstimator.kind` 显式选择计数策略，不能根据 `apiBase` 或模型名称推断。
- estimator 使用独立的 `30,000 ms` admission timeout，并与用户 AbortSignal 组合；timeout
  在 commit 前失败并保留 draft，不能继承当前 chat request 的 30 分钟 timeout。
- `tokenEstimator.timeoutMs` 必填且限制在 `1,000..60,000`；当前 profile 固定 30 秒。
- 带图 chat 与 estimator 都显式 `maxRetries = 0`。OpenAI SDK 默认 retry 不能暗中重传
  大型 Base64 body；estimate 失败保留 draft，accepted chat 失败则结束该 turn。未来只有
  endpoint 提供并验证幂等键后，才能通过新 retry policy 开启重试。
- provider 实际拒绝图片时暴露经过脱敏的 provider 错误，不重试纯文本请求。

版本所有权必须唯一：`messageProtocol.serializationVersion = "openai-chat-v2"` 负责
content part 顺序、标签 framing 和 normalized segment 合同；`imageInput.transport`
只负责 data URL 的编码与字段形状。两者和上述限制都进入 session compatibility identity
及 request configuration hash，不能各自重复定义同一排序规则。

### `/model` 和 `/resume`

当前 `/model` 的真实语义是创建新 session，不会原地迁移 active context。因此本阶段不
为旧 session 的历史图片设置“切换阻断”：旧 context 继续属于旧 session。按照前述
slash-command 合同，含附件 draft 根本不路由 `/model`；用户需先提交或删除附件，再用
`/model` 创建目标 profile 的新 session。不要增加一个实际无法从当前输入模型触发的
“带附件 draft 切换校验”分支。

`/resume` 必须按 session 保存的 compatibility identity 恢复，不能用当前默认 profile
覆盖 image transport 或 serialization version。未来若新增原地 model switch，再单独
定义 active context 的媒体兼容规则；若新增独立于文本框的 model picker，也必须先把
PromptDraft 提升到不会因 picker mount/unmount 而丢失的所有者，再定义切换行为。

### Kimi K3 接入前置条件

多模态工作不能顺便把未经验证的 K3 文本基线带进来。冻结图片 wire protocol 前，必须
先通过真实 endpoint 验证：

- text-only、tool call 的 streaming 与 non-streaming 都能走完现有 agent loop；
- tool result 后的 assistant 消息重放保留 endpoint 要求的 `reasoning_content` 等字段；
- 使用当前 Chat API 的 `max_completion_tokens`，不继续发送已标记 deprecated 的
  `max_tokens`；
- profile 中实际启用的 reasoning、temperature、tool choice 等请求字段均被 endpoint
  接受，并全部进入 request configuration hash；
- 两张视觉上可区分的图片能按 `[Image #1]` / `[Image #2]` 正确关联，而不只是“请求未
  报错”。

Kimi 的 [Chat API](https://platform.kimi.ai/docs/api/chat) 已列出 `kimi-k3`，而
[Token estimate API](https://platform.kimi.ai/docs/api/estimate) 的示例使用 K3、生成的
request enum 却未同步列出它。实现不得因此静默替换模型；聊天和估算两个 endpoint 都
必须分别实测。

## 同步规划、异步物化与模型映射

### 三段式 pipeline

当前 `ModelClient.prepare()` 是被 runtime、context planning、swap planning 和 prefix
retirement 同步调用的纯函数。图片接入后仍保持这一性质，不能在 `prepare()` 内读盘、
Base64 编码或发 Token HTTP 请求。模型请求拆成三段：

```ts
type PreparedMediaDescriptor = {
  assetId: ImageAssetId;
  label: string;
  range: CodePointRange;
  mimeType: ImageMimeType;
  byteLength: number;
  width: number;
  height: number;
  planningTokens: number;
};

type PreparedPromptSegment = {
  kind: PreparedPromptSegmentKind;
  normalizedText: string;
  media?: readonly PreparedMediaDescriptor[];
};

type PreparedModelPlan = {
  payloadTemplate: ProviderPayloadTemplate;
  promptSegments: readonly PreparedPromptSegment[];
  requestConfigHash: string;
  toolSchemaHash: string;
  requestMaxOutputTokens: number;
  mediaOccurrenceCount: number;
  assistantReplaySegments(
    message: AssistantMessage,
  ): readonly PreparedPromptSegment[];
};

type PreparedAdmissionCandidate = {
  base: AdmissionBaseToken;
  plan: PreparedModelPlan;
};

type MaterializedModelRequest = {
  payload: ProviderRequestPayload;
  promptSegments: readonly PreparedPromptSegment[];
  requestConfigHash: string;
  toolSchemaHash: string;
  requestMaxOutputTokens: number;
  bodyBytes: number;
};
```

1. `prepare(input): PreparedModelPlan`：同步、确定、无 I/O；校验 canonical media
   descriptors，生成不含 Base64、本机路径和 `originalName` 的 provider template、
   segments、现有 replay/output-limit 字段与 hashes。
2. `materialize(plan, { assetStore, cache, signal })`：仅在确定要发送或远端计数时异步
   读取资产、再次验证 digest/MIME/长度，生成 data URL 和最终 payload。
3. `request(materialized, options)`：只接受已过聚合限制的 payload，不再暗中重新映射或
   读取资产。

所有 speculative planning 只消费 `PreparedModelPlan`。同一 turn 的 materialization
cache 按 `assetId` 复用已验证 data URL，但不写回 `AgentMessage`，turn 结束即释放。错误、
事件、debug inspect 和 JSON dump 必须对 `MaterializedModelRequest` 做类型级禁止或统一
redaction，不能依赖调用者记得删 Base64。completion、cancel、fault 和 dispose 的共同
`finally` 都要 `cache.clear()`，不能只清正常完成路径。

runtime admission 把通用 model plan 包在 `PreparedAdmissionCandidate` 中；model adapter
本身不知道 session。`AdmissionBaseToken` 至少绑定 canonical message head/count、active
context revision、context surface hash 和 compatibility identity。远端 estimate 可能耗时，
`beginTurn` 必须在同一 transaction 内 CAS 该 token；任何消息、surface、skills/tool
schema 或 context revision 在 prepare 后变化，都以 `ADMISSION_STALE` 拒绝并保留 draft，
丢弃 materialized
artifact。禁止把已按旧 prefix 计数的 payload 提交到新 ledger，也不做隐藏自动重试。

`async` 函数本身不会让 Base64 和 JSON serialization 变成非阻塞。实现必须先用 asset
metadata 计算 request body 的确定下界，超限时不读取/编码；随后一次处理一个 distinct
asset，在资产之间检查 abort 并向 event loop yield，及时释放原始 Buffer。不得为了计数
再 `JSON.stringify` 一份最高 90 MB 的完整 payload：使用 marker-aware exact JSON sizer，
按 template 的真实 UTF-8 bytes 加每个 ASCII data URL 的精确 escaped length 计算
`bodyBytes`，SDK 最终只序列化一次。sizer 必须用随机 Unicode 文本、重复 asset occurrence
和小型真实 payload 对照 `Buffer.byteLength(JSON.stringify(payload), "utf8")` 锁定；对照
不一致即阻止发送。

### OpenAI Chat Completions mapping

无附件 user message 继续发送字符串 `content`。有附件时，`openai-chat-v2` 固定为：

1. 按 attachment range 顺序为每张图生成 open-tag、`image_url`、close-tag；
2. 最后追加一个包含完整 `message.content` 的 text part。

```ts
function toOpenAIUserContent(
  message: UserMessage,
  materialized: ReadonlyMap<string, string>,
) {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return message.content;
  }

  return [
    ...attachments.flatMap((attachment) => [
      { type: "text", text: `<image name=${attachment.label}>` },
      {
        type: "image_url",
        image_url: {
          url: requireMaterialized(materialized, attachment.assetId),
        },
      },
      { type: "text", text: "</image>" },
    ]),
    { type: "text", text: message.content },
  ];
}
```

`<image name=[Image #N]>` 是 Tinker 自己的普通文本协议，不是 Kimi 专用字段；标签只取
生成值，绝不拼入文件名或用户可控属性。该 framing 必须先通过真实两图关联测试，再由
mapping golden test 冻结。若测试失败，应修改 protocol version，而不是在 provider
adapter 中加不可见特殊分支。

materialization 完成后，对实际将发送的同一个 JSON 对象用上述 exact sizer 计算 UTF-8
`bodyBytes`；chat payload 和 estimator payload 分别检查自己的上限。SDK 层不得在检查后
追加字段或使用不同 JSON escaping。超限在 HTTP 前失败，并只报告总字节数、限制和图片
计数。

### Normalized segments 和 hash

带图 user segment 的 `normalizedText` 保存可见完整文本，`media` 保存有序的 asset
descriptor。prefix hash 必须哈希 `stableJsonStringify(segment)` 整体，不能只哈希
`normalizedText`。这样同文本换图、换顺序、换 MIME 或换尺寸都会使 prefix 失配，而
Base64 不会进入 hash 链。

`requestConfigHash` 至少覆盖：model、provider endpoint policy 的规范化 scheme/host/port/
base path（移除 credentials、query 和 API key）、system/tool serialization、所有实际
请求参数、`max_completion_tokens`、message protocol version、image transport、MIME 与
聚合限制、planning charge、retry policy，以及 estimator endpoint/kind/coverage version。
任一会改变 payload、预算或 anchor 可复用性的字段都不能遗漏；estimator timeout/
maxRetries 也进入 compatibility identity，避免 resume 后改变 admission 行为。

## Session ledger 与 schema

当前 `messages` 表只能保存纯文本 user content。schema v9 新增内容寻址资产元数据和
message attachment 关联，不把附件 JSON 塞进 `content`：

```sql
CREATE TABLE image_assets (
  asset_id TEXT PRIMARY KEY
    CHECK (
      length(asset_id) = 64
      AND asset_id NOT GLOB '*[^0-9a-f]*'
    ),
  mime_type TEXT NOT NULL
    CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE message_image_attachments (
  message_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL CHECK (length(attachment_id) = 36),
  asset_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  label TEXT NOT NULL CHECK (length(label) > 0),
  range_start INTEGER NOT NULL CHECK (range_start >= 0),
  range_end INTEGER NOT NULL CHECK (range_end > range_start),
  original_name TEXT NOT NULL CHECK (length(original_name) > 0),
  PRIMARY KEY (message_id, attachment_id),
  UNIQUE (message_id, position),
  UNIQUE (message_id, label),
  UNIQUE (message_id, range_start, range_end),
  FOREIGN KEY (message_id) REFERENCES messages(message_id),
  FOREIGN KEY (asset_id) REFERENCES image_assets(asset_id)
);
```

`assetId` 本身就是 digest，不再存重复的 `sha256` 列。MIME、长度和尺寸属于共享 asset；
`originalName` 属于一次 attachment，同一字节用不同文件名附加时允许共享 asset row。
attachment identity 只在 message 内有意义，因此主键以 `message_id` 为作用域。
SQL `CHECK` 只是第一层；write/read validator 仍须检查 JS safe-integer 上界、连续 position、
canonical UUIDv7 attachment ID、label/range、`originalName` 完整规则和 RFC 3339
timestamp，并确保 foreign keys 已开启。

`beginTurn` 一次接收完整 `UserMessage`，在同一 SQLite transaction 中写入 message、所需
asset metadata、attachment rows 和 turn。`buildCandidateModelRequest`、
`executeTurn` 和 admission 全部改为接收结构化 user message，禁止预算阶段只传字符串。
相同 `assetId` row 已存在时必须逐字段验证 metadata 后复用；禁止用未校验的
`INSERT OR IGNORE` 掩盖冲突。

### Canonical hash 与完整性

user message 的 hash 统一由一个共享函数生成：

```ts
canonicalUserMessageHash({
  content,
  attachments: userMessage.attachments?.map((attachment) => ({
    attachmentId: attachment.attachmentId,
    assetId: attachment.assetId,
    label: attachment.label,
    range: attachment.range,
    mimeType: attachment.mimeType,
    byteLength: attachment.byteLength,
    width: attachment.width,
    height: attachment.height,
    originalName: attachment.originalName,
  })),
});
```

函数内部先拒绝显式空 `attachments`，对非空附件按 range 导出顺序，再对省略空字段后的
对象做 `stableJsonStringify` 和 SHA-256；纯文本与带图消息因此都只有一种编码。每个
range 必须在 code-point 视图中恰好等于 label。protocol validator、内存 ledger、SQLite
写入和 resume hydration 必须调用同一函数，禁止复制公式。

session 打开时验证：关系行连续编号且与 content/range/label 一致；asset metadata 与
canonical message 一致；每个去重后的 asset 路径由已校验的 64 字符 ID 构造，目标是
常规文件，长度、MIME 和 digest 匹配。验证应异步执行并按 distinct asset 缓存，session
在验证完成前不可发送请求。active 与 retired canonical history 都在检查范围，避免
Recall 或后续策略变化时才发现历史损坏。

schema v9 是硬断代：不迁移 v8。新表必须加入 schema fingerprint 和精确
`verifySessionSchema`，并为 update/delete 安装 immutable triggers。fork 使用的
`VACUUM INTO` 会复制两张表及 triggers；两张新表都没有 `session_id`，不得误加到
`SESSION_SCOPED_TABLES` 的 identity rewrite，attachment 通过未变化的 `message_id`
继续关联已 rekey 的 message。fork 验收仍要显式验证附件行、asset metadata 与共享
workspace asset bytes。初版不支持完整 session export；未来导出必须把引用资产打包，
不能只复制 SQLite 文件。

## Context、预算与压缩

图片消息进入 canonical active history 后，每次构造包含该消息的模型上下文都重新发送
图片。不能只在首轮发送、后续 iteration 留下 `[Image #N]`。这意味着多轮累计图片会
同时消耗 Token、图片数和 request body 限制，retirement/compaction 必须看到同一组
media descriptors。

### 两层 Token 合同

`ContextMeter.measure()` 保持同步、确定且无 I/O：按 text tokens 加每张图片的
`planningTokensPerImage` 计算本地规划值，用于 candidate 比较、shadow planning、
compaction 和 retirement。该 charge 不把 Base64 字符数当视觉 Token，也不是最终
provider 计数。

发送前计数使用异步适配器：

```ts
interface InputTokenEstimator {
  readonly kind: string;
  estimate(
    request: MaterializedModelRequest,
    options: { signal: AbortSignal },
  ): Promise<InputTokenEstimate>;
}

type InputTokenEstimate = {
  inputTokens: number;
  source: "provider_estimated";
  coverage: "messages" | "full_request";
};
```

Kimi estimator 从 chat materialized payload 严格提取相同的 `model` 和 `messages`，调用
`POST /v1/tokenizers/estimate-token-count`，并校验 HTTP、响应 `error`、
`data.total_tokens` 和安全整数边界。它不能另外构造近似消息，也不能在日志中记录请求
body。真实 endpoint 未确认 tools coverage 前，固定返回 `coverage: "messages"`。

### Admission 算法

对含图的最终 candidate，顺序固定为：

1. `prepare()` 并做同步本地测量，不提交 context revision。本地 guard 已 blocked 时直接
   失败；用户可独立执行 `/compact` 或 `/compact retire` 后重试。
2. 校验图片 occurrence 数、单图 metadata 和本地 planning charge。这里的“通过”只允许
   继续 admission，不能替代 provider 计数。
3. materialize 最终 chat request，复核每个 asset 并计算精确 body bytes。带图请求无论
   是否存在 anchor 都要做这一步，因为它马上要发送，且聚合 body limit 必须在 accepted
   前确定。
4. 查找同时匹配 `requestConfigHash`、`toolSchemaHash` 和 prefix hash 的 measured anchor。
   只有最终 segments 中所有 media 都位于 `[0, anchor.segmentCount)`，anchor 后没有新增
   图片，才允许用 `anchor total + guarded local delta` 并跳过远端 estimator。
5. 没有可用 anchor、anchor 失效或 anchor 后出现图片时，对已 materialize 的同一组
   messages 调用 estimator。`coverage: "messages"` 时加 guarded local tool schema
   tokens。
6. 最终 guarded input 为以下分支之一：
   `max(localPlannedFull, anchorTotal + guardedLocalDelta)`，或
   `max(localPlannedFull, providerMessages + guardedLocalTools)`。胜出的候选决定 snapshot
   source：分别使用现有 `estimated_full`、`measured_plus_estimated_delta`，或新增的
   `provider_estimated`。
7. 用 `contextWindowTokens - requestMaxOutputTokens` 得到 input budget 并断言 guarded input
   不超限。`requestMaxOutputTokens` 必须映射为这次实际发送的
   `max_completion_tokens`，不能在预算和 payload 中维护两个值。
8. 初始 user request 通过后，在 `beginTurn` 同一 transaction 中写入 admission snapshot
   与 turn，再把步骤 3 的 exact materialized request 交给首次 dispatch。provider estimate
   不建立 measured anchor，也不更新文本 calibration。
9. chat usage 返回后，按现有 assistant replay contract 建立 measured anchor。只要被测
   prefix 含图片，就跳过 `RollingTokenCalibration` 样本；纯文本请求保持现有校准行为。

`ContextUsageSource` 因此需要增加 `provider_estimated`。运行期 estimator cache key 固定
包含 `requestConfigHash + toolSchemaHash + prefixHash + coverageVersion`，并且只在当前
进程复用；不持久化 Base64 或 estimator body。

同一 accepted turn 后续的 tool iteration 也重复上述 prepare、materialize、anchor/
estimator 和 budget gate，只是不再调用 `beginTurn`。后续 gate 失败时保留已经 accepted
的 turn 并按 runtime fault 合同结束它；不能绕过检查，也不能恢复 Prompt draft。

Kimi estimator 不可用、响应不合法或 body 超限时，在 chat 调用前快速失败。不能改用
Base64 长度猜测、不能把 estimate 冒充 `provider_measured`，也不能重试纯文本请求。

### Recall 与退休图片

prefix retirement 移出带图 user message 后，该图片不再进入 active request。Recall
返回这类历史消息时，除原文本外必须为每个附件追加确定性说明，例如：

```text
[Historical image omitted: label=[Image #1], originalName="checkout.png". Ask the user to reattach it.]
```

说明只含 label 和安全 basename，不含 asset ID、路径或字节。`originalName` 必须用 JSON
string escaping 生成，不能直接插值；这样带引号或方括号的合法文件名不能逃逸说明结构。
模型也不会把历史文本中仍存在的 `[Image #1]` 误认为当前可见图片。本阶段 Recall 不自动
重新激活 asset。

## Prompt 历史、事件与 timeline

### Prompt 历史 v2

当前 `prompt-history.jsonl` 的 JSON string 继续作为 v1 纯文本条目；不扫描其中的
`[Image #N]`。带附件 Prompt 写入完整 v2 entry：

```json
{
  "version": 2,
  "text": "比较 [Image #1] 和 [Image #2] 的页面差异",
  "elements": [
    {
      "kind": "image",
      "attachmentId": "019b1234-5678-7abc-8def-0123456789ab",
      "label": "[Image #1]",
      "range": { "start": 3, "end": 13 }
    },
    {
      "kind": "image",
      "attachmentId": "019b1234-5678-7abc-9def-0123456789ac",
      "label": "[Image #2]",
      "range": { "start": 16, "end": 26 }
    }
  ],
  "attachments": [
    {
      "attachmentId": "019b1234-5678-7abc-8def-0123456789ab",
      "asset": {
        "assetId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "mimeType": "image/png",
        "byteLength": 12345,
        "width": 1200,
        "height": 800
      },
      "originalName": "before.png"
    },
    {
      "attachmentId": "019b1234-5678-7abc-9def-0123456789ac",
      "asset": {
        "assetId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "mimeType": "image/png",
        "byteLength": 23456,
        "width": 1200,
        "height": 800
      },
      "originalName": "after.png"
    }
  ]
}
```

进入历史导航前保存当前未提交 draft 和 cursor。恢复 v2 entry 时先完整校验结构、资产和
当前 profile 的 image capability；然后为所有附件生成新的 `attachmentId`，同步 remap
elements，并把历史 draft 的 cursor 放在文本末尾。退出历史导航时恢复原未提交 draft
及其原 cursor。fresh ID 防止同一历史条目再次提交时与已有 message attachment identity
冲突。不支持图片的 profile 遇到 v2 entry 时停止导航并保留当前 draft，用户可在没有
附件 draft 的状态下执行 `/model` 后再恢复。

v2 asset verification 是异步操作：先进入 `restoring_history`，捕获 target index 和当前
draft，验证全部 distinct assets 后再一次性 commit fresh-ID draft 与导航位置。schema、
profile 或 asset 失败时保留 draft，但把导航 cursor 停在该 target，便于下一次同方向操作
越过它；取消、unmount 或迟到结果则同时保留原 draft 和原导航位置。不能先显示文本，
随后再补附件。v1 entry 不需要 I/O，可继续同步恢复。

损坏 entry 的固定行为是停在该导航位置、显示错误并保留当前 draft；不自动跳过，也不
降级成普通文本。用户再次按方向键可以返回其他位置。v2 去重比较忽略临时
`attachmentId`，按 text、labels/ranges、asset refs 和 `originalName` 做语义比较；因此
同一 Prompt 从历史恢复再提交不会仅因 fresh ID 形成相邻重复条目。

Prompt 历史只在 turn accepted 后追加。它是 workspace 级辅助历史，不是 session 真相，
v1/v2 将长期共存；旧版本对 v2 的行为不构成本实现需要兜底的 session 兼容层。

loader 不能继续把 JSON parse/schema 错误返回成 `undefined` 并静默过滤。每个非空物理行
都解析为以下记录之一，`maxEntries` 对记录而不是仅对成功条目生效：

```ts
type LoadedPromptHistoryRecord =
  | { kind: "valid"; lineNumber: number; entry: PromptHistoryEntry }
  | {
      kind: "invalid";
      lineNumber: number;
      errorCode: "INVALID_JSON" | "UNSUPPORTED_VERSION" | "INVALID_ENTRY";
    };
```

invalid record 不保留或回显原始行，只保留行号和有界错误码。这样 crash 留下的半行、未知
version 和结构损坏都能在导航时按前述合同停住，而不会凭空消失或把潜在敏感垃圾写进
错误日志。

### 安全事件投影

canonical `UserMessage` 不能直接塞进事件或 timeline view model。统一投影为：

```ts
type UserPromptProjection = {
  text: string;
  images: readonly {
    label: string;
    range: CodePointRange;
    originalName: string;
  }[];
  omittedImageCount: number;
};
```

`turn.started` 从 `userPrompt: string` 升级为 versioned `UserPromptProjection`。事件中不含
Base64、本机路径或 asset ID。实时事件消费、`ResumeProjectionReader`、observation log
和 timeline 必须共用 `projectUserMessage()`，不能各自从字符串正则解析。event schema
version 与 session schema version 分开管理，并为旧事件提供明确的纯文本 reader。

timeline 的长度限制也必须是结构化函数：`truncateUserPromptProjection(projection,
maxCodePoints)` 同时截断 text 和 images；若截断点落入 element，就退到 element 起点，
绝不留下半个 label，并增加 `omittedImageCount`。renderer 把 code-point range 显式转换为
JS string slice 所需的 code-unit offset。live event-store 和 resume reader 都先得到完整
projection，再调用同一个 truncate 函数；禁止一边直接用事件文本、另一边单独
`boundedText(content)`。

timeline 显示完整 text，用 range 高亮已绑定 label，并在相邻的非敏感说明中显示
`originalName`；普通文本中的同形 `[Image #1]` 不高亮。普通界面不显示 attachment ID
或 asset digest。

`/resume` 的 canonical truth 仍是 session ledger，不是 `events.jsonl`。session 引用的
任一 asset 缺失或损坏时，resume 在 session 可用前失败；live 与 resumed timeline 必须
产生相同投影。

## 错误处理

需要在靠近来源的位置快速失败：

| 场景 | 行为 |
| --- | --- |
| 当前 profile 不支持图片 | 选择时拒绝并保留 draft |
| 文件越界、不是常规文件或 symlink 绕过 | 拒绝附加 |
| MIME、解码、尺寸或静态约束失败 | 拒绝附加 |
| 单图、图片数或最终 body 超限 | 在对应预检/admission 阶段拒绝并报告实际值与限制 |
| 异步附件创建取消或结果过期 | 丢弃结果并恢复原 draft |
| element、range 与 attachment 不一致 | 禁止提交，报告内部状态错误 |
| session asset 缺失或 digest/metadata 不符 | 禁止打开或构造请求，报告安全 asset 摘要 |
| image profile 缺少 estimator | profile 加载时拒绝配置 |
| Kimi Token 计数失败或响应不合法 | 不提交 turn，不发送 chat，显示脱敏错误 |
| estimate 期间 admission base 变化 | `ADMISSION_STALE`，丢弃 payload 并保留 draft |
| provider 拒绝多模态 payload | 保留已接受 turn 并标记失败，不发纯文本重试 |
| 不支持图片的 profile 导航到 v2 历史 | 停止该次导航并保留当前 draft |
| v2 Prompt 历史资产损坏 | 停止该次导航并保留当前 draft |
| 打开 v8 及更早 session schema | `SESSION_SCHEMA_UNSUPPORTED`，不迁移 |

内部诊断可以记录 attachment ID、asset digest、MIME、尺寸和字节数，但不得记录 data
URL、Authorization header 或本机源路径。provider 错误正文也要经过 data URL 和凭据
redaction 后才能展示或落日志。

## 主要代码影响面

预计涉及以下模块：

- `src/tui/components/prompt-input.tsx`：结构化 draft、异步 phase、提交受理和历史恢复；
- `src/tui/line-editor.ts`：code-point 合同、原子 element、垂直光标和结构化 trim；
- `src/tui/file-mention.ts`：候选选中后的图片分流；
- `src/tui/prompt-history.ts`：v1/v2 历史、fresh ID remap 和语义去重；
- `src/tui/components/timeline.tsx`、`src/tui/app.tsx`：安全投影与 accepted 后清空；
- `src/agent/types.ts`：user message attachments 和 projection 类型；
- `src/agent/runtime-session.ts`、`src/agent/session-ledger.ts`：结构化 admission、turn
  transaction 和 materialization 生命周期；
- `src/context/*`：canonical hash、media-aware segments、anchor、预算、退休和 Recall
  omitted-media 注记；
- `src/session/session-schema.ts`、`session-store.ts`：schema v9、关联表、immutable
  triggers、fork 和资产完整性检查；
- 新的 asset store 模块：安全导入、no-clobber 发布、读取验证和 turn cache；
- `sharp` dependency 和 image probe/container parser：MIME、尺寸、完整 decode 与动画
  检测；
- `src/model/model-client.ts`：纯 `PreparedModelPlan` 与异步 materialized request 合同；
- `src/model/openai-chat-mapping.ts`、`openai-chat-model-client.ts`：`openai-chat-v2`、
  ordered content parts、`max_completion_tokens` 和 redaction；
- `src/model/token-estimator.ts`、`src/model/input-token-estimator.ts`：media planning
  charge、provider estimate source 和 calibration 隔离；
- `src/model/moonshot-input-token-estimator.ts`：Kimi estimate adapter；
- `src/cli/model-profiles.ts`、session compatibility contract：能力、限制和版本校验；
- `src/events/types.ts`、事件存储、observation formatter、`resume-projection.ts`：统一
  `UserPromptProjection` 和 event version。

## 测试边界

### Asset store 与选择

- PNG、JPEG、静态 WebP 成功；APNG、animated WebP、GIF、伪后缀和损坏图片失败。
- 单帧 APNG/animated WebP、伪造 chunk length、截断 pixel data 和 decoder/container
  结论冲突都失败；不能用 substring 假阳性判断动画。
- 单图字节、宽高、总像素、单 message 图片数分别在边界内/外。
- symlink、realpath 越界、非常规文件和 lstat/open inode race 都失败；成功 open 后路径被
  替换不改变该 handle 最终导入的字节。
- 相同字节不同文件名共享 asset，两个 attachment 保留各自 `originalName`。
- 并发发布相同 asset 不覆盖；既有目标内容不符时快速失败。
- 正常失败/cancel 清 staging；启动只删除超过 24 小时且严格匹配的常规 staging 文件，
  不碰活跃、未知、symlink 或已发布 asset。
- asset ID 含 `/`、大写或非十六进制时不能参与路径构造。
- 非 canonical UUIDv7 attachment ID 在 history/session hydration 时失败。
- 取消、组件卸载和迟到结果都不修改 draft；attaching 期间不能编辑或提交。

### Prompt Input 与历史

- 图片插入开头、中间、末尾时 ranges 正确；emoji 前后的索引仍以 code point 计算。
- 左右、上下、Home/End 和跨行移动都不能把 cursor 放进 element。
- Backspace、Delete、`Ctrl+U` 和跨范围替换整体删除 element 与 attachment。
- 删除和中间插入后，labels、ranges、cursor 和 identity 全部正确；MVP 不生成 `#9`。
- 手工输入或粘贴 label 不创建附件；与当前派生 label 冲突时提交失败。
- structure-aware trim 正确平移 ranges，不产生脱离文本的附件。
- admission 失败/取消保留 draft；accepted 后才清空和追加历史；重复提交被锁阻止。
- SQLite commit 后的 event/dispatch 初始化错误只拒绝 completion，不把 draft 当作未受理
  保留；重试不会生成重复 turn。
- abort 在 commit 前后两侧分别表现为“未受理保留 draft”和“已受理 cancelled turn”。
- estimate 期间 message/context/surface/tool 任一变化都会触发 CAS stale failure，旧 payload
  绝不提交或静默重算。
- RuntimeSession `admitting` 锁拒绝并发 turn/context/session 操作，内部 surface/skills
  mutation 排队且在失败后正确恢复 `ready`。
- budget/media error 的 maintenance offer 在不改 draft 的情况下显式执行 compact、retire
  或相同-profile clear；`Esc` 退出，失败留在旧 session，成功后也不自动重提。
- 历史恢复 fresh IDs、完整 assets 和末尾 cursor；退出导航恢复原 draft 的原 cursor。
- 损坏 v2 entry 停止导航且不降级；v1 只作为纯文本；语义去重忽略 fresh IDs。
- 不支持图片的 profile 不恢复 v2 entry，原 draft 和导航状态保持可继续操作。
- history restore 取消、unmount 和迟到验证不修改 draft/index；坏 target 可被下一次同方向
  导航越过。
- JSON 半行、未知 version 和非法 schema 作为 invalid record 保留行号，不静默跳过或回显
  原始内容。

### Session、事件与 Recall

- user message、asset rows、attachment rows 和 turn 在单 transaction 原子写入。
- hash 能发现 label、range、顺序、asset metadata、文件名或 digest 被修改。
- SQL checks、runtime validator 和 immutable triggers 分别覆盖非法/tampered rows。
- `/resume` 生成与 live 相同的 canonical request 和 timeline projection。
- session fork 保留表、triggers、附件关系并能读取 workspace assets。
- 缺失、损坏和 metadata 不一致的 asset 在 session 可用前失败。
- v8 及更早 session 以 `SESSION_SCHEMA_UNSUPPORTED` 失败。
- `turn.started`、observation 和 resume projection 不含 Base64、本机 source path 或内部 ID。
- Recall 对退休图片追加 omitted-media 注记，active image message 仍发送真实图片。
- Recall 对引号、方括号等合法文件名做 JSON escaping，不能逃逸 omitted-media 注记。
- live/resume 使用同一结构化截断；截断不会劈开 label，code-point range 高亮在 emoji 前后
  仍正确，并准确报告 `omittedImageCount`。

### Model pipeline 与映射

- speculative `prepare()` 不触发文件 I/O、Base64 或 HTTP，结果稳定可哈希。
- 无附件 user message 仍为字符串；单图、多图 mapping 顺序由 golden test 固定。
- 每张图片恰好一个 open-tag、`image_url`、close-tag，完整 Prompt 始终最后。
- 同文本换 asset、顺序、MIME 或尺寸都会改变 prefix hash；Base64 不进入 segment/hash。
- 同 turn 同 asset 只 materialize 一次；请求前再次发现 asset tamper 会失败。
- completion/cancel/fault/dispose 都清空 turn media cache；后续 turn 不复用 data URL。
- data URL MIME 与 asset 一致；Kimi payload 不发送 `detail`。
- 最终 chat/estimate JSON body 精确计数，超过 `90,000,000` bytes 时不发 HTTP。
- marker-aware sizer 对 Unicode、转义字符、重复 asset 的随机样本与真实 `JSON.stringify`
  字节数完全一致，且不会为了检查上限序列化第二份大 payload。
- OpenAI SDK fetch stub 捕获的实际 request body bytes 与 `bodyBytes` 完全一致，且检查后无
  隐式字段追加。
- materialized payload 和 provider 错误经过统一 redaction，不进入事件或日志。
- 不支持图片或 aggregate limits 不满足时在 provider 调用前失败。

### Token 与 provider

- 本地规划为每张图片加入固定 charge，breakdown 归入对应 user segment。
- measured anchor 覆盖全部图片且 delta 无新图时不调用 estimator。
- 无 anchor、anchor 失效或 delta 有新图时恰好调用一次 estimator。
- messages-only estimate 加 guarded tool tokens，并与 local full estimate 取最大值。
- provider estimate 使用独立 source，不建立 anchor，不写 calibration。
- estimator user abort/30s timeout 都在 commit 前结束 admission、保留 draft 并清 media cache。
- retryable HTTP/network fault 下 image chat 与 estimator 都只发一次请求，SDK 不自动重传
  Base64 body。
- 带图 chat usage 建立 measured anchor，但不写 `RollingTokenCalibration` 样本。
- completion reserve 与实际 `max_completion_tokens` 一致，超 context window 时不提交 turn。
- estimator 缓存不会跨 request config、protocol、transport 或 coverage version 命中。
- accepted turn 的后续 tool iteration 仍经过 materialize/budget gate；失败关闭该 turn 而不
  创建第二个 user message。

真实 Kimi K3 测试由显式环境变量开启，不进入默认离线测试，并覆盖：

- text/tool/reasoning 基线的 streaming 与 non-streaming；
- 单图描述和两张可区分图片的编号关联；
- 图片在后续 agent iteration 中重放；
- 单图、多图 `estimate-token-count` 与 chat prompt usage 对照；
- estimator 是否接受并计算 tools；
- `max_completion_tokens`、实际启用的 reasoning 字段和错误响应形态；
- 接近图片数、分辨率及 body limits 时的 chat/estimate 行为。

## 实施阶段与门禁

### 阶段 A：provider spike 与合同冻结

- 先完成 K3 text/tool/reasoning 基线，移除 `max_tokens` 依赖。
- 实测 K3 chat/estimate、两图 label 关联、tools coverage 和 body errors。
- 冻结 `openai-chat-v2`、profile 字段、默认限制和 endpoint 测试记录。

未通过两图语义关联测试，不进入正式 mapping 实现；未通过 K3 工具循环基线，不宣称
K3 多模态可用。

### 阶段 B：不可变数据链与同步规划

- 实现 asset store、canonical types/hash、schema v9、fork 与 session 完整性。
- 实现纯 `PreparedModelPlan`、media-aware normalized segments 和本地 planning charge。
- 用构造消息打通 session write/read/resume，不接 TUI。

门禁：schema/hash tamper tests、asset 并发/越界 tests、sharp 在 macOS arm64 与 CI Linux
的加载/decode smoke、`bun run check` 全部通过。

### 阶段 C：异步物化、Token admission 与 provider dispatch

- 实现 turn-scoped materialization cache、body limits 和统一 redaction。
- 实现 Kimi estimator、anchor 决策、completion reserve 和 accepted-turn 边界。
- 打通单图、多图、工具迭代及 provider failure 的 session 状态。

门禁：离线 fault injection 全过，显式真实 K3 集成测试全过，不存在纯文本 fallback。

### 阶段 D：TUI、历史和投影

- 实现 line editor elements、异步 attachment state、结构化 trim 和提交锁。
- 实现 Prompt 历史 v2、timeline/event/resume 统一投影及 Recall 注记。
- 做终端手工验收：取消、错误恢复、历史导航、maintenance offer 保留 draft、`/model`
  新 session 和 `/resume`。

门禁：`bun run check`、PTY/TUI 用例和 live/resume projection parity 全部通过。

## 实现前仍需真实验证

以下只依赖外部 endpoint，不能靠本地设计拍板：

1. K3 estimate endpoint 是否接受 `kimi-k3`，以及是否接受并计算 tools；验证前保持
   `coverage: "messages"`。
2. 普通 text tag framing 是否能让 K3 稳定建立两图编号关联；失败时 bump/fix
   `openai-chat-v2` 草案，不保留隐式兼容分支。
3. 不同尺寸图片的 estimate 与 chat prompt usage 如何变化，据此校正
   `planningTokensPerImage = 2048`；校正前远端 estimate 仍是无 anchor 请求的 admission
   必需项。
4. Chat 和 estimate 接近官方 `100M` 边界时的实际错误形态，以及本地 `90,000,000`
   bytes 是否留有足够余量。
5. K3 tool loop 对 reasoning 字段的精确重放要求，以及 streaming/non-streaming 字段是否
   完全一致。

## 当前推荐

本文其余边界作为实现基线，不再留给编码阶段临场选择：

- MVP 格式固定为 PNG、JPEG、静态 WebP；所有动画格式拒绝。
- 采用 `20 MiB` 单图、每 message/request 最多 8 图、4K/`4096 × 2160` 像素与
  `90,000,000` bytes 最终 body 上限。
- `[Image #N]` 是带持久 range 的原子 UI element；asset ID 是原始字节 SHA-256，
  attachment ID 只做关系身份。
- `prepare` 保持同步纯函数，只有 dispatch admission 可以异步 materialize 和远端计数。
- session schema v9 硬断代，`openai-chat-v2` 独立拥有 wire ordering；二者同版发布但
  不混用版本职责。
- turn 只有在校验、预算和 SQLite commit 成功后才 accepted；TUI 此后才清空与写历史。
- Prompt 历史损坏时停止并报错；恢复时 fresh IDs；不自动跳过或退化。
- `/model` 按当前实现创建新 session；附件 draft 不路由 slash command，不虚构
  active-context 原地切换。
- live event、resume、timeline 和 Recall 都消费结构化投影，不从标签字符串猜测附件。
- 含图请求不参加文本 calibration；必要 estimator 失败即停止，不做静默降级。
- workspace asset store 初版只增不删，GC 和完整 session export 另立设计。
