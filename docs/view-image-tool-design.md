# ViewImage 工具设计方案

## 文档状态

本文定义 `ViewImage` 工具、图片工具结果以及 `toolResultModalities` 的确定性契约和实施范围。
文中的能力字段、注册条件、canonical representation、持久化规则和 provider adapter 边界均为
实施结论。

第一版实现 OpenAI Responses 图片工具结果。OpenAI Chat Completions 保持纯文本工具结果；未来
Anthropic Messages adapter 按本文的 canonical contract 接入，不改变 `ViewImage` 公开契约。

## 背景

Tinker 已支持用户在 Prompt 中附加图片，并通过 `ImageAssetStore`、canonical user message、请求物化和
OpenAI adapter 将图片传给模型。但模型在执行任务过程中无法主动查看本地文件系统中的图片，只能使用
`Read` 获得不适合视觉理解的文件信息，或借助外部程序间接处理。

`ViewImage` 完成两件事：

1. 安全读取并验证本地文件系统中的一张图片，将其导入内容寻址的图片资产库；
2. 将图片作为当前工具调用的结果重新输入模型。

第二项能力不是某个 API 名称的固有属性。模型可能支持用户图片输入，但当前 endpoint 或 adapter
只能提交文本工具结果。因此 Tinker 使用独立的 `toolResultModalities` 描述工具结果可携带的模态，
不通过 `api === "responses"` 等协议名称推导能力。

## 目标

- 提供模型可调用的 `ViewImage(file_path)`。
- 支持 PNG、JPEG 和 WebP，复用现有图片格式、尺寸、像素数和字节数限制。
- 图片通过 `ImageAssetStore` 内容寻址保存；canonical history 只保存 `ImageAssetRef`，不保存 Base64。
- 使用 provider-neutral 的工具结果内容块表示文本和图片。
- 通过 `toolResultModalities` 明确声明 model endpoint 接受的工具结果模态。
- 通过 adapter capability 明确声明 Tinker 已实现的 wire serialization。
- profile 声明超出 adapter 实现能力时启动失败。
- 只在 effective capabilities 同时允许图片输入和图片工具结果时注册 `ViewImage`。
- 图片进入同步 planning、异步 materialization、context admission、session resume、Recall 和压缩链路。
- TUI、one-shot CLI、event log 和 Observation 只显示安全的文本摘要，不内联图片字节或 data URL。

## 非目标

- 不修改 canonical 原图，不提供用户可控的缩放、裁剪、旋转或转码；provider request materialization
  继续执行统一图片策略要求的 EXIF 方向修正和最大长边缩放。
- 不支持 GIF、SVG、PDF、视频或任意二进制文件。
- 不允许相对路径通过 `..` 逃逸 workspace；workspace 外文件必须使用绝对路径明确指定。
- 不跟随符号链接。
- 不在终端中渲染图片；第一版只把图片发送给模型并显示文本状态。
- 不允许模型传入 URL、data URL、Base64 或已有 asset id。
- 不根据文件扩展名判断图片格式。
- 不把 `inputModalities` 与 `toolResultModalities` 合并成一个字段。
- 不因 adapter 理论上可表达某种 wire shape 就自动开启 profile 能力。
- 不为 OpenAI Chat Completions 实现图片工具结果。
- 不在第一版实现 Anthropic Messages adapter；其未来实现使用本文定义的 canonical contract。

## 模态能力契约

### Profile 能力

```ts
export type ModelInputModality = "text" | "image";
export type ToolResultModality = "text" | "image";

type ModelCapabilities = {
  readonly inputModalities: readonly ModelInputModality[];
  readonly toolResultModalities: readonly ToolResultModality[];
};
```

`inputModalities` 表示模型请求通常可接收的输入模态，覆盖用户附件和历史中的媒体内容。

`toolResultModalities` 表示当前 profile 对应的模型与 endpoint 接受哪些模态作为工具结果。该字段是
公开配置中的显式能力声明，不从 model name、provider name 或 API 名称推导。

两个数组必须非空、不能重复，并且必须包含 `"text"`。省略字段时使用保守默认值：

```json
{
  "inputModalities": ["text"],
  "toolResultModalities": ["text"]
}
```

允许图片工具结果的 profile 明确声明：

```json
{
  "api": "responses",
  "inputModalities": ["text", "image"],
  "toolResultModalities": ["text", "image"]
}
```

以下配置合法，表示模型接受用户图片，但工具结果只能是文本：

```json
{
  "inputModalities": ["text", "image"],
  "toolResultModalities": ["text"]
}
```

以下配置非法：

```json
{
  "inputModalities": ["text"],
  "toolResultModalities": ["text", "image"]
}
```

约束固定为：

```text
toolResultModalities 包含 image
=> inputModalities 必须包含 image
```

配置解析阶段违反该约束时直接失败。

### Adapter 能力与严格验证

每个 model adapter 声明 Tinker 已实现的工具结果序列化能力：

```ts
type ModelAdapterCapabilities = {
  readonly toolResultModalities: readonly ToolResultModality[];
};
```

第一版能力矩阵：

| Adapter                  | Adapter tool result modalities |
| ------------------------ | ------------------------------ |
| `openai-responses`       | `text`, `image`                |
| `openai-chat`            | `text`                         |
| future Anthropic adapter | `text`, `image`                |

创建 model client 时执行严格验证：

```text
profile.toolResultModalities ⊆ adapter.toolResultModalities
```

如果 profile 声明 `"image"`，而 adapter 只实现 `"text"`，启动直接失败：

```text
Profile "<name>" declares image tool results, but adapter "<adapter>" does not support them.
```

不静默取交集，不让配置中的图片能力悄悄失效。adapter capability 只证明 Tinker 会正确编码请求；
endpoint 是否真正实现该能力由 profile 显式声明并通过 provider 集成测试确认。

`ModelClient` 暴露已验证后的能力：

```ts
interface ModelClient {
  readonly inputModalities: readonly ModelInputModality[];
  readonly toolResultModalities: readonly ToolResultModality[];
  // existing members...
}
```

### Effective capability 与工具注册

`ViewImage` 的注册条件固定为：

```ts
const supportsViewImage =
  modelClient.inputModalities.includes("image") &&
  modelClient.toolResultModalities.includes("image");
```

满足条件时 runtime registry 注册 `ViewImage`；否则工具不存在于模型可见 schema，也不能通过内部名称
旁路调用。注册逻辑不检查 `api`、provider 或 model name。

工具集合在 session compatibility 中是 profile 能力的结果。resume 时必须验证
`toolResultModalities` 与创建 session 时一致，避免历史中已有图片工具结果却由纯文本 adapter 重放。

### 环境变量模式

第一版只在 `models.json` profile 中公开 `toolResultModalities`。未使用 profile 的环境变量模式保持：

```text
inputModalities = ["text"]
toolResultModalities = ["text"]
```

因此环境变量模式不注册 `ViewImage`。后续若公开环境变量，必须使用同一解析器和同一严格验证规则，
不能形成第二套能力推导逻辑。

## Tool Schema

模型可见定义：

```ts
{
  name: "ViewImage",
  description:
    "View one local image and return it to the model. Supports PNG, JPEG, and WebP. " +
    "Relative paths resolve within the workspace; absolute paths may point outside it. " +
    "Symbolic links are not supported.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      file_path: {
        type: "string",
        description: "Workspace-relative path or absolute path to one image file."
      }
    },
    required: ["file_path"]
  }
}
```

不增加 `detail`、`crop`、`resize`、`page`、`url`、`asset_id` 或多路径参数。第一版 OpenAI
Responses mapping 固定使用 `detail: "auto"`；该 wire 选择不是工具参数，也不进入 canonical history。

## 路径与图片安全

`ViewImage` 使用与现有文件工具一致的路径范围，并复用 `ImageAssetStore` 的安全读取、图片验证和资产
发布能力：

- `file_path` 必须是非空字符串。
- 相对路径以 workspace root 解析，并且不得通过 `..` 逃逸 workspace。
- 绝对路径可以指向 workspace 外；调用方通过绝对路径明确选择该文件。
- 路径条目必须是普通文件，符号链接直接拒绝。
- 打开文件时使用 `O_NOFOLLOW`（平台支持时）并校验打开前后的 device/inode。
- 对 workspace 外绝对路径同样执行 `lstat`、`realpath`、非符号链接和打开后 inode 校验，但不执行
  workspace containment 检查。
- 只相信内容探测结果，不相信扩展名。
- 完整解码验证必须成功。
- MIME 必须是 `image/png`、`image/jpeg` 或 `image/webp`。
- 单图字节数、长边和总像素数复用 `IMAGE_INPUT_POLICY`。
- 图片资产以 SHA-256 `assetId` 发布到当前 workspace 的 `.tinker/assets/images`，使用 staging、原子 link
  和完整性复核。

`ImageAssetStore` 增加适用于工具调用的导入入口，例如 `importFile()`。现有用户附件选择继续调用
`importWorkspaceFile()` 并保持 workspace-only 契约；`ViewImage` 调用新入口。两个入口共享打开文件、竞态
检查、图片探测、policy 校验和 asset publish 实现，只有路径范围不同。

## 执行流程

新增 `src/tools/view-image.ts`，导出：

```ts
createViewImageToolExecutor({
  imageAssetStore,
});
```

执行顺序固定为：

1. 检查取消信号。
2. 校验参数对象及唯一的 `file_path`。
3. 调用 `imageAssetStore.importFile(file_path, { signal })`。
4. import 内完成相对路径范围约束、绝对路径解析、非符号链接检查、竞态检查、字节限制和完整图片解码。
5. 在资产发布前后遵守现有取消边界；取消时不提交 tool completion。
6. 资产成功发布后返回结构化 raw result。
7. `ObservationBuilder` 从 raw result 构造一个文本块和一个图片块。
8. ledger 在一次提交中持久化完整工具消息和 raw result。
9. 下一次 iteration 的 request planning 将该图片作为一次 media occurrence 计入。
10. materialization 从 `ImageAssetStore` 重新读取并校验图片，再由 adapter 生成 provider wire shape。

图片资产发布成功但 completion 提交前发生取消或进程中断时，允许留下无引用的内容寻址资产；它不进入
canonical history，也不会被后续模型请求自动使用。这与用户附件 import 的 orphan 语义一致。

### Raw Result

在 `src/tools/types.ts` 增加：

```ts
export type ViewImageRawResult = {
  ok: boolean;
  filePath: string;
  originalName?: string;
  asset?: ImageAssetRef;
  error?: string;
};
```

并在 `ToolRawResultByKind` 增加：

```ts
view_image: ViewImageRawResult;
```

成功结果必须包含完整 `asset` 和规范化后的 basename `originalName`。失败结果只包含安全错误文本，不包含
部分图片字节、data URL 或 staging path。raw result 可以进入 event log 和 SQLite，因为它只含引用和元数据。

## Canonical 工具结果

### Provider-neutral 内容块

工具消息从纯字符串扩展为内容块：

```ts
export type ToolResultTextContent = {
  readonly type: "text";
  readonly text: string;
};

export type ToolResultImageContent = {
  readonly type: "image";
  readonly asset: ImageAssetRef;
};

export type ToolResultContent = ToolResultTextContent | ToolResultImageContent;

export type ToolMessage = {
  readonly role: "tool";
  readonly toolCallId: ToolCallId;
  readonly providerToolCallId: string;
  readonly name: string;
  readonly content: readonly ToolResultContent[];
};
```

所有工具消息统一使用非空内容块数组。现有文本工具结果转换为单个 `text` block；不保留
`string | blocks` 双表示，避免 canonical history 出现两种等价编码。

`ViewImage` 成功 observation 固定为：

```ts
[
  {
    type: "text",
    text:
      "Viewed image <filePath> " +
      "(<mimeType>, <width>x<height>, <byteLength> bytes, asset=<shortAssetId>).",
  },
  {
    type: "image",
    asset,
  },
];
```

失败 observation 只有一个文本块：

```text
ViewImage failed for <filePath>: <error>
```

失败结果绝不附带图片块。文本摘要提供 timeline、Recall、压缩和不支持图像渲染的界面所需信息；图片块
提供给模型 adapter。两个块共同属于同一个 tool call completion。

### ObservationBuilder 接口

`ToolObservation` 改为：

```ts
type ToolObservation = {
  readonly content: readonly ToolResultContent[];
  readonly displayText: string;
};
```

`displayText` 是内容块的确定性文本投影：按顺序保留 text block，并为 image block 追加 asset 摘要。
它用于 TUI、stdout 和诊断事件，不作为 provider 请求的 canonical source。

ledger 的 `ToolCompletionInput.observation` 改为内容块数组。`observationSha256` 对规范化后的完整 block
数组计算，不只 hash `displayText`。`rawSha256` 继续独立覆盖 raw result。

### Canonical hash

新增共享函数：

```ts
canonicalToolResultContentHash(content: readonly ToolResultContent[]): string
```

函数必须：

- 拒绝空数组和空文本块；
- 验证 `ImageAssetRef` 的 asset id、MIME、字节数和尺寸；
- 拒绝连续 text blocks，构造阶段先合并它们；
- 按数组顺序对稳定 JSON 编码计算 SHA-256；
- 由内存 ledger、SQLite writer、resume hydration 和 protocol validator 共同调用。

`CanonicalMessageRecord` 的 tool 分支保存 `content: readonly ToolResultContent[]`，其
`contentSha256` 使用上述共享函数。禁止将 Base64 或 provider wire item 写入 canonical record。

## Session 持久化与兼容性

### Schema

现有 `image_assets` 表继续作为共享图片元数据表。新增按顺序保存工具结果 block 的关系表：

```sql
CREATE TABLE tool_message_content_blocks (
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'image')),
  text_content TEXT,
  asset_id TEXT,
  PRIMARY KEY (message_id, position),
  FOREIGN KEY (message_id) REFERENCES messages(message_id),
  FOREIGN KEY (asset_id) REFERENCES image_assets(asset_id),
  CHECK (
    (kind = 'text' AND text_content IS NOT NULL AND length(text_content) > 0 AND asset_id IS NULL)
    OR
    (kind = 'image' AND text_content IS NULL AND asset_id IS NOT NULL)
  )
);
```

`messages.content` 对 tool message 保存确定性的 `displayText` 投影，供现有目录查询和 UI projection 使用；
`tool_message_content_blocks` 是 tool result provider 内容的 source of truth。写入时在同一 transaction 中：

1. upsert 并逐字段验证所需 `image_assets`；
2. 写入 tool message 及文本投影；
3. 连续写入 block rows；
4. 写入 `tool_results` raw result 和完整 observation hash；
5. 关闭对应 protocol frame。

纯文本历史 session 在 schema 升级时，每条 tool message 生成一个 position 0 的 text block。迁移必须是单一
transaction，并通过 schema fingerprint 和 immutable triggers 验证。若当前 session schema 继续采用硬断代
策略，则提升 schema version 并明确拒绝旧 schema；不得在 hydration 时临时猜测缺失 block。

resume 时验证：

- block position 从 0 连续递增；
- 每条 tool message 至少有一个 block；
- text/image 列约束与 kind 一致；
- `messages.content` 等于 blocks 的确定性 `displayText`；
- `contentSha256` 与 canonical block hash 一致；
- 每个 image block 的 asset metadata 与 `image_assets` 一致；
- 每个 distinct asset 的文件存在且通过 `ImageAssetStore.readVerified()`；
- tool result observation hash 与完整 blocks 一致。

session 在验证完成前不能发送模型请求。

### Session compatibility contract

现有 image compatibility 扩展为统一的多模态请求合同：

```ts
type SessionMediaCompatibility = {
  readonly policyVersion: string;
  readonly policySha256: string;
  readonly inputModalities: readonly ModelInputModality[];
  readonly toolResultModalities: readonly ToolResultModality[];
};
```

compatibility hash 必须包含 `toolResultModalities`、adapter serialization version 和图片 policy。
图片 policy 使用当前 `image-input-policy-v2`，不再包含 provider token estimator endpoint、model、凭据或
timeout。`ViewImage` 不建立第二套图片策略或 compatibility 字段。
resume 或 fork 打开 session 时逐字段严格比较。历史中没有 `ViewImage` 调用也不放宽比较，因为工具 schema、
context hash 和未来可执行能力已经改变。

## Provider 映射

### OpenAI Responses

文本工具结果继续映射为字符串；含图片的工具结果映射为 content list：

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": [
    {
      "type": "input_text",
      "text": "Viewed image screenshots/home.png (image/png, 1440x900, 123456 bytes, asset=abc123…)."
    },
    {
      "type": "input_image",
      "image_url": "data:image/png;base64,...",
      "detail": "auto"
    }
  ]
}
```

mapping 遵守以下规则：

- `call_id` 使用 `providerToolCallId`。
- text block 映射为 `input_text`。
- image block 映射为 `input_image`，`detail` 固定为 `auto`。
- prepare 阶段只产生 asset marker 和 normalized media descriptor，不读取文件。
- materialize 阶段通过 `ImageAssetStore.readVerified()` 生成 data URL。
- materialized payload、data URL 和原始字节不进入 canonical history、event 或日志。
- adapter 遇到未声明或未实现的 block modality 时在 dispatch 前 fast-fail。

OpenAI Responses serialization version 必须提升，使 resume compatibility 能识别旧版只接受字符串
`function_call_output.output` 的映射。

### OpenAI Chat Completions

`openai-chat` 的 adapter capability 固定为：

```ts
toolResultModalities: ["text"];
```

其 tool message mapping 继续输出字符串。由于 profile/adapter 验证和工具注册已阻止图片 block 到达该
adapter，mapping 内仍保留防御性断言；遇到 image block 必须报错，不能丢弃图片或只发送文本摘要。

### Anthropic Messages

未来 Anthropic adapter 将同一 canonical tool message 映射为：

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_123",
      "content": [
        {
          "type": "text",
          "text": "Viewed image screenshots/home.png (...)"
        },
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "..."
          }
        }
      ]
    }
  ]
}
```

Anthropic wire shape只存在于该 adapter；canonical history 不保存 `tool_result`、`tool_use_id` wrapper
或 `source` 对象。

## Planning、物化与请求限制

图片统计从“user attachments”推广为“所有 active message image blocks”。每个 user attachment 和每个
工具 image block 都是一个 media occurrence；相同 `assetId` 在历史中出现两次仍计两次。

现有三段式 pipeline 保持：

1. `prepare()`：同步、确定、无 I/O，生成 normalized segments 和 media descriptors；
2. admission：按最终 provider 尺寸对应的本地图片 Token 档位计算 planning charge，不执行网络 I/O；
3. `materialize()`：异步读取并验证资产，生成最终 data URL 和精确 request body。

`PreparedPromptSegment` 的 media descriptor 增加来源信息：

```ts
type PreparedMediaOccurrence = {
  readonly asset: ImageAssetRef;
  readonly source: "user_attachment" | "tool_result";
  readonly messageOrdinal: number;
  readonly blockPosition: number;
  readonly width: number;
  readonly height: number;
  readonly planningTokens: number;
};
```

`width`、`height` 和 `planningTokens` 使用 `image-input-policy-v2` 的统一规则：先根据原图和 EXIF
orientation 计算视觉尺寸，再等比例限制到最大长边 `2048px`，最后按处理后长边选择
`384 / 1,408 / 3,072 / 5,504` 档位。工具图片不得使用固定单值、文件字节数、Base64 长度或独立的
provider estimator 估算。

每个 occurrence 独立计费。相同 `assetId` 在多个 message 或 block 中出现时，物化读取可以去重，Token
计量不能去重。图片 Token 不参与文本 rolling correction factor：

```ts
const guardedTokens =
  Math.ceil(breakdown.textAndProtocolTokens * correctionFactor) +
  breakdown.imageTokens;
```

该计算必须由 normal admission、active-turn maintenance、swap planner 和 prefix-retirement planner 共享，
不能让 revision planner 回退为 `Math.ceil(totalTokens * correctionFactor)`。当前模型请求成功后仍使用
provider usage 建立 measured anchor；旧 anchor 后新增的 `ViewImage` 图片先作为本地 bucket delta，下一次
成功请求再由 provider 实测 usage 吸收。含图片请求不作为文本 calibration sample。

所有图片统一受以下限制：

- `maxBytesPerImage`
- `maxImagesPerMessage`
- `maxImagesPerRequest`
- `maxLongEdge`
- `maxPixels`
- `maxRequestBodyBytes`
- `maxProviderLongEdge`
- `imageTokenBuckets`

一个含图片的 tool message 受 `maxImagesPerMessage` 约束；`ViewImage` 第一版每次只产生一张图。
request body 上限按最终 materialized payload 的精确字节数校验，不按原文件大小近似。

若 active history 已含图片工具结果，后续每次 iteration 都重新发送该图片，直到其所在 protocol frame 被
retire 或 compact。不能在首轮发送后把图片悄悄降级成文本摘要。

## Context、压缩与 Recall

### Protocol frame

`ViewImage` completion 与产生它的 assistant tool call 仍属于同一个 `tool_exchange` frame。图片 block 不改变
frame 原子性：assistant call 和对应 tool result 必须共同保留、共同退休，不能只移除图片块。

### Context swap

`view_image` 成功 raw result 必须显式进入 `SWAPPABLE_RAW_KINDS`，并由专门的确定性分支生成 placeholder；
不能假设新增 tool kind 会被现有 renderer 自动支持。context swap renderer 不把图片复制到 swap override。
已经被模型消费且满足现有候选条件的图片工具结果转换为确定性文本：

```text
[Tool image omitted from compacted context: ViewImage screenshots/home.png,
image/png, 1440x900, asset=abc123…. Use ViewImage again if the current image is required.]
```

该文本是 active request 的 revision override，不修改 canonical message，也不删除资产。swap hash 必须覆盖
该文本以及原 canonical image content hash。swap 的节省量和 prospective request Token 必须基于完整
text/image blocks 重新 prepare 和计量，不能只比较 `messages.content` 的文本投影字节数。

当前 active turn 中刚返回、尚未被模型消费的 `ViewImage` frame 不可 swap。active-turn maintenance 只能
换出更旧、已经消费过的 observation，不能先把当前图片降级成 placeholder 再让模型继续，否则模型从未
真正收到该图片。

### Prefix retirement 与 Recall

图片工具结果随完整 frame 退休后不再进入 active provider request。Recall 返回历史 tool message 时显示文本
block，并为每个 image block追加：

```text
[Historical tool image omitted: image/png, 1440x900, asset=abc123….]
```

Recall 第一版不把历史图片重新注入模型。模型若仍需查看原文件，应再次调用 `ViewImage(file_path)`；若文件
已变化，新调用产生新 `assetId`，准确反映当前磁盘内容。

### 工具 iteration 后的 context maintenance

`ViewImage` completion 原子提交后、下一次 agent iteration 构建请求前，runtime 使用包含新 tool image 的
最新 active context 重新计量。若达到 context pressure trigger，并且当前 profile 已启用自动维护，顺序固定为：

1. 先尝试 swap 更旧、已消费且 allowlisted 的 tool observations；
2. swap 后仍不能达到目标且允许自动 prefix retirement 时，退休更旧的完整 closed turns；
3. 保留当前未消费的 assistant call 与 `ViewImage` completion；
4. 下一 iteration 从最新 revision 重新 prepare、计量并执行 hard-budget preflight。

维护是为当前图片腾出旧历史空间，不保证任何图片请求必然可发送。以下情况可能仍无法降到 input budget：

- 当前未消费 frame、受保护 suffix 或 hot tail 本身已过大；
- 没有足够的可 swap observation 或可退休 closed turn；
- profile 未启用自动维护；
- 图片 occurrence 数或 materialized request body 先触发独立上限。

此时不得删除当前图片、只发送文本摘要、缩小到 policy 之外的规格或绕过 admission。下一 iteration 在
provider dispatch 前失败，已提交的 canonical tool completion 和 asset ref 保留，turn 按现有失败合同结束。

## TUI、CLI 与事件

- `tool.started` 显示 `ViewImage` 和模型提供的文件路径。
- `tool.raw_result` 保存 raw metadata，但 event projection 不包含 bytes 或 data URL。
- `tool.finished` 沿用 `ok` 状态。
- timeline 成功摘要显示 path、MIME、尺寸和字节数。
- one-shot stdout 使用同一 `displayText`。
- TUI 不读取 asset bytes，也不尝试终端图片协议渲染。
- resumed timeline 从持久化 block 和 raw result 构建，与 live timeline 保持一致。
- 调试日志、错误对象和 provider diagnostics 必须继续执行现有请求 body 清理规则。

## 错误处理

以下均为普通工具失败，返回纯文本 observation：

- 参数不是对象、存在额外字段或 `file_path` 为空；
- 相对路径通过 `..` 逃逸 workspace；
- 文件不存在或父路径不是目录；
- 路径是目录、符号链接或其他非普通文件；
- 文件在验证与打开之间变化；
- 文件为空或超过字节限制；
- MIME 不受支持；
- 图片 header、完整解码、尺寸或像素数校验失败；
- asset publish 或完整性验证失败。

以下属于 runtime/configuration failure，不降级为普通 `ViewImage` 失败：

- profile 能力超出 adapter capability；
- canonical image block 到达纯文本 adapter；
- session compatibility 不匹配；
- resume 时 canonical block、asset metadata 或 asset bytes 损坏；
- materialization 时已提交的 asset 缺失或校验失败；
- 图片 occurrence、body limit 或 context admission 失败。

工具执行成功只表示图片已经成为 canonical completion；下一轮请求仍可能因累计图片数、context token 或
request body 超限而在 provider dispatch 前失败。此时保留已提交 completion，并按现有 runtime fault 合同结束 turn。

## 主要代码影响面

### 配置与 model client

- `src/cli/model-profiles.ts`
  - 新增 `ToolResultModality` 和 `toolResultModalities` 解析、默认值及交叉约束。
- `src/cli/config.ts`
  - 将 profile 能力传入 model client factory。
- `src/model/model-client.ts`
  - 暴露 `toolResultModalities`。
- OpenAI client constructors
  - 声明 adapter capability 并严格验证 profile capability。
- `docs/models-json-provider-guide.md`
  - 记录字段语义、默认值和 Responses 图片 profile 示例。

### 工具与 observation

- `src/tools/view-image.ts`
  - 实现参数校验和 asset import。
- `src/tools/types.ts`
  - 增加 `ViewImageRawResult` 和 `view_image` kind。
- `src/tools/registry.ts` 及 CLI composition root
  - 仅按 effective capabilities 注册工具并注入 `ImageAssetStore`。
- `src/observation/observation-builder.ts`
  - 返回 provider-neutral blocks 和 `displayText`。

### Canonical、session 与 context

- `src/agent/types.ts`
  - `ToolMessage.content` 改为 `ToolResultContent[]`。
- `src/context/protocol-frame.ts`
  - canonical tool record、completion input 和 hash 支持 blocks。
- `src/agent/session-ledger.ts`
  - 原子提交并验证多模态工具结果。
- `src/session/session-store.ts`
  - schema、block rows、asset refs、resume 与 compatibility validation。
- `src/context/*`
  - token measurement、swap、retirement、Recall 和 protocol validator 支持图片 block；
  - `view_image` raw result 显式加入 swap allowlist 并使用图片专用 placeholder；
  - swap 与 retirement planner 使用“guarded text/protocol + fixed image buckets”，不对图片 Token 应用
    text correction factor。

### Provider mapping 与 materialization

- `src/model/openai-responses-mapping.ts`
  - `function_call_output.output` 支持 `input_text`/`input_image` list。
- `src/model/openai-chat-mapping.ts`
  - 纯文本映射及 image block 防御性拒绝。
- `src/model/openai-model-utils.ts` 和两个 model clients
  - 从所有 message 类型收集 media occurrence，物化 asset 并执行 body limit。

## 测试边界

### Profile 与注册

- `toolResultModalities` 缺省为 `["text"]`。
- 拒绝空数组、重复值、未知值和缺少 `text`。
- 拒绝 tool result image 不在 input modalities 中。
- 拒绝 image profile 配合纯文本 adapter。
- image/image 能力注册 `ViewImage`；其他组合不注册。
- 注册逻辑不依赖 API 或 provider 名称。
- resume 时 `toolResultModalities` 不一致直接失败。

### 工具执行

- PNG、JPEG、WebP 成功并返回正确 metadata。
- 相同内容重复查看复用相同 `assetId`。
- 拒绝相对路径逃逸和符号链接；接受 workspace 外的绝对路径。
- 拒绝目录、不存在文件、空文件、伪造扩展名、损坏图片和不支持格式。
- 覆盖字节、长边和像素限制。
- 覆盖取消发生在读取前、读取中和 publish 边界。
- raw result 与事件中不出现图片 bytes 或 data URL。

### Canonical 与 session

- 文本工具结果规范化为单 text block。
- `ViewImage` 成功生成 text + image blocks；失败只有 text block。
- block hash 对顺序、文本和 asset metadata 敏感。
- SQLite round-trip、resume 和 fork 保留完整 blocks。
- 拒绝 block gap、空 blocks、错误 kind/column、metadata 冲突和损坏 asset。
- live 与 resumed timeline 的 `displayText` 一致。
- protocol frame 始终保持 assistant call 与 tool completion 成对。

### Provider 与预算

- Responses 映射生成 `function_call_output` content list 和 `detail: "auto"`。
- Chat adapter 遇到 image block 明确失败，不静默丢图。
- prepare 不读取文件，materialize 才读取并复核。
- 相同 asset 多次出现按 occurrence 计数。
- user image 与 tool image 共同受 request image count 和 body limit 约束。
- tool image 根据处理后尺寸使用与 user image 相同的四档 planning Token。
- normal admission、active-turn maintenance、swap 和 retirement 都不对图片 Token 应用 text correction factor。
- measured anchor 后新增 tool image 作为 bucket delta，下一次成功请求建立包含图片实测成本的新 anchor。
- 含图片请求不记录文本 calibration sample。
- 当前未消费的 `ViewImage` frame 不进入 swap 候选；已消费的历史 `view_image` 可以生成确定性 placeholder。
- pressure 时先 swap 旧 observation，必要时再 retire 旧 closed turns；仍超预算时下一 iteration preflight 失败。
- context swap 和 retirement 后图片不再进入 materialized request。
- request payload、diagnostics 和 snapshot 中不持久化 Base64。

### 真实 provider 验证

合入前必须用明确开启 `toolResultModalities: ["text", "image"]` 的 OpenAI Responses profile 完成真实测试：

1. assistant 调用 `ViewImage`；
2. endpoint 接受含 `input_text` 和 `input_image` 的 `function_call_output.output`；
3. 模型能准确描述一张包含可辨识内容的 fixture；
4. streaming 与 non-streaming 各执行一次；
5. 同一 session 的后续 iteration 能重放图片工具结果；
6. 本地图片分档、provider usage 和 measured anchor 路径覆盖该请求，且没有 token-estimator 网络调用；
7. event log、SQLite、console 和错误日志中不存在 data URL 或 Base64。

第三方 Responses-compatible endpoint 只有通过相同验证后才能在其 profile 中声明 image tool result。

## 实施阶段

### 阶段 A：能力与 canonical contract

- 增加 `toolResultModalities` profile 字段和 adapter capability。
- 完成严格验证、session compatibility 和条件注册。
- 将所有 tool message 统一迁移为非空内容块数组。
- 完成 schema、hash、resume 和 protocol validator 更新。

### 阶段 B：ViewImage 与资产链路

- 实现 `ViewImage` executor 和 raw result。
- 复用 `ImageAssetStore` 导入与完整性验证。
- 实现多模态 `ObservationBuilder`、event projection 和 timeline 文本。
- 完成工具、路径、取消和持久化测试。

### 阶段 C：Responses mapping 与 admission

- 扩展 Responses tool output mapping。
- 将 media collection 从 user attachment 推广到所有 message image blocks。
- 完成本地图片分档 planning、materialization、body limit、swap、retirement 和 Recall。
- 统一 ContextMeter、swap planner 与 retirement planner 的图片 Token guard 公式。
- 将 `view_image` 显式接入 swap allowlist 和图片 placeholder renderer，并保护当前未消费 frame。
- 提升 adapter serialization 和图片 policy compatibility version。

### 阶段 D：真实验证与文档

- 运行 OpenAI Responses streaming/non-streaming provider 测试。
- 更新 provider guide 和示例 profile。
- 运行 `bun run check`，并确认 benchmark smoke gate 通过。

## 验收标准

实现只有同时满足以下条件才算完成：

1. `toolResultModalities` 是 profile 和 session compatibility 中的显式确定性能力。
2. profile、adapter 和 `inputModalities` 的不一致均在启动或 resume 时 fast-fail。
3. `ViewImage` 只在 image input 与 image tool result 同时有效时出现。
4. canonical history 保存 provider-neutral text/image blocks 和 `ImageAssetRef`，从不保存 Base64。
5. OpenAI Responses 能把图片作为当前 tool call 的 output 发送并由模型识别。
6. Chat Completions 不会收到、丢弃或伪装图片工具结果。
7. session resume、fork、context planning、压缩、retirement 和 Recall 对图片工具结果保持确定性。
8. user image 与 tool image 使用相同的 v2 尺寸策略和四档图片 Token，图片 Token 不参与文本 correction factor。
9. 工具 iteration 后会先通过旧 observation swap 和旧 closed-turn retirement 为当前未消费图片腾空间；
   无法降到预算时在 provider dispatch 前确定性失败，且不丢失 canonical completion。
10. 所有图片限制同时覆盖用户附件和工具结果图片。
11. TUI、stdout、event、SQLite diagnostics 和错误日志不泄漏图片 data URL。
12. 单元测试、集成测试、真实 provider 验证和 `bun run check` 全部通过。
