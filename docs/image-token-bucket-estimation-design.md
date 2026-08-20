# 图片固定规格与 Token 分档估算方案

## 文档状态

本文是以本地、确定性的图片 Token 分档估算替代
`moonshot-estimate-token-count-v1` 的候选实现合同。

本文只修改图片请求的缩放与上下文估算策略，不改变图片附件的交互、canonical message、
资产存储、Prompt 占位符或 provider wire format。实现后，本文取代
`multimodal-image-input-design.md` 中以下合同：

- 图片 profile 必须配置 `tokenEstimator`；
- 图片请求发送前必须调用 Moonshot Token estimate endpoint；
- `planningTokensPerImage = 2048` 的单一图片规划值；
- estimator endpoint/model/timeout 进入 session compatibility 和 request config hash。

旧文档的其他图片输入合同继续有效，除非与本文直接冲突。

## 背景

Tinker 当前要求支持图片的 model profile 配置：

```json
{
  "inputModalities": ["text", "image"],
  "tokenEstimator": {
    "kind": "moonshot-estimate-token-count-v1",
    "model": "kimi-k3",
    "apiBase": "https://api.moonshot.cn/v1",
    "apiKey": "...",
    "timeoutMs": 30000,
    "maxRetries": 0
  }
}
```

首次带图请求在 provider dispatch 前会把完整图片再次发送到
`/tokenizers/estimate-token-count`。这能够取得 Kimi estimator 的计数，但有以下问题：

1. 图片在 estimator 和实际模型请求中上传两次；
2. admission 增加一次网络往返，并依赖第二套 endpoint 和凭据；
3. estimator 超时或不可用会阻止实际模型请求；
4. Moonshot 的图片计数不是其他 provider 的精准计数；
5. 图片视觉 Token 主要由处理后的尺寸或 patch 数决定，逐请求远端计算的收益有限；
6. Tinker 已经在成功请求后接收 provider 的实际 usage，并能用 measured anchor 计量后续上下文。

Codex 的实现提供了更简单的参考：限制进入模型的图片尺寸和 patch 数，使用本地图片成本
估算，并在请求成功后以 provider usage 驱动上下文管理，而不是在每次图片请求前调用独立
Token endpoint。

## 目标

- 将模型请求中的图片长边限制为 `2048px`，保持宽高比且禁止放大。
- 根据处理后图片的长边选择经过离线验证的 Token 档位。
- Token 档位向上取整，作为跨 provider 的保守图片成本。
- 删除图片输入对 `moonshot-estimate-token-count-v1` 的运行时依赖。
- 删除图片 profile 对第二套 estimator endpoint、模型和凭据的要求。
- 保持 context planning 同步、确定、无网络 I/O。
- 保留 provider 实际 usage、rolling calibration 和 measured anchor 机制。
- canonical asset 继续保存原图；缩放只发生在 provider request materialization 阶段。

## 非目标

- 不承诺本地档位等于任意 provider 的计费 Token。
- 不根据模型名称自动选择不同的图片估算表。
- 不使用 PNG/JPEG/WebP 文件字节数估算视觉 Token。
- 不根据图片内容复杂度调整 Token。
- 不把 Base64 字符数当作模型视觉 Token。
- 不在本阶段支持 `detail: original` 或绕过 `2048px` 上限的 profile 配置。
- 不移除 provider usage 或上下文超限保护。
- 不改变原图导入时用于解码安全的字节数、像素数和格式限制。

## 实测依据

### 测试方法

2026-07 使用本地配置的真实 endpoint 测试：

- Moonshot：`POST /v1/tokenizers/estimate-token-count`，model 为 `kimi-k3`；
- GPT：OpenAI Responses 兼容 endpoint，model 为 `gpt-5.6-sol`；
- 图片为真实网页截图，按目标规格等比例裁切/缩放为方图；
- 使用相同提示词分别发送纯文本请求与附图请求；
- 图片 Token 取“附图 input tokens - 纯文本 input tokens”；
- `detail: auto` 与 `detail: high` 均进行了测试。

统一提示词：

```text
Inspect the attached image and reply with exactly OK.
```

### 结果

| 图片规格  | Moonshot / `kimi-k3` 图片增量 | `gpt-5.6-sol` 图片增量 |
| --------- | ----------------------------: | ---------------------: |
| 512×512   |                           369 |                    308 |
| 1024×1024 |                         1,379 |                    692 |
| 1536×1536 |                         3,035 |                    692 |
| 2048×2048 |                         5,486 |                    692 |

补充观察：

- Moonshot 图片 Token 基本随像素面积或 patch 数线性增长；
- GPT 在本次 endpoint 上从 `1024×1024` 到 `2048×2048` 保持为 692 Token；
- 两张内容复杂度和 PNG 文件大小差异明显的 `2048×2048` 截图，在两个 provider 上分别
  得到完全相同的图片 Token；
- 两个 provider 的 `detail: auto` 与 `detail: high` 结果相同；
- `2048×2048` 下，Moonshot 的 5,486 Token 约为 GPT 的 7.9 倍；
- Moonshot estimator 适合描述 Kimi 的视觉成本，但不适合作为跨 provider 的“精准”计数器。

这些结果支持使用尺寸档位和保守上界，而不是逐请求远端估算。

## 核心设计

### 1. 原图与请求派生图分离

asset store 继续以原始字节的 SHA-256 作为 `assetId`，保存并验证用户导入的原始图片。
不得在导入时覆盖原图，也不得让缩放后的字节改变 canonical attachment identity。

provider request materialization 负责：

1. 从 asset store 读取并验证原图；
2. 根据 EXIF orientation 得到视觉方向正确的宽高；
3. 必要时生成最大长边为 2048 的派生图片；
4. 将派生字节编码为 data URL；
5. 将最终尺寸提供给图片 Token 分档函数。

因此，canonical history 仍引用原图，而实际 provider payload 和 Token 估算使用同一个派生
结果。

### 2. 最大长边限制

固定请求策略：

```ts
const MAX_PROVIDER_IMAGE_LONG_EDGE = 2048;
```

设视觉方向修正后的原图尺寸为 `width × height`：

```ts
const longEdge = Math.max(width, height);
```

当 `longEdge <= 2048` 时：

- 不调整像素尺寸；
- 不放大小图；
- 仍可因 orientation 或安全编码需要重新编码，但不能改变宽高比。

当 `longEdge > 2048` 时：

```ts
const scale = 2048 / longEdge;
const targetWidth = Math.max(1, Math.round(width * scale));
const targetHeight = Math.max(1, Math.round(height * scale));
```

必须满足：

```text
max(targetWidth, targetHeight) <= 2048
```

如果 rounding 使长边意外超过 2048，实现必须再钳制到 2048。缩放使用高质量 downsampling，
禁止裁切、拉伸或改变宽高比。

示例：

| 原尺寸    | 请求尺寸  |
| --------- | --------- |
| 400×300   | 400×300   |
| 1024×768  | 1024×768  |
| 2048×2048 | 2048×2048 |
| 4096×2048 | 2048×1024 |
| 1000×4000 | 512×2048  |

这里的 `2048px` 是 provider 请求上限，不替代导入阶段的 decoder 安全限制。原图只有先通过
现有格式、字节数、像素数、动画和完整解码检查，才允许进入 asset store 和后续缩放。

### 3. 四档 Token 映射

根据处理后图片的长边向上选择档位：

```ts
const IMAGE_TOKEN_BUCKETS = Object.freeze([
  { maxLongEdge: 512, planningTokens: 384 },
  { maxLongEdge: 1024, planningTokens: 1408 },
  { maxLongEdge: 1536, planningTokens: 3072 },
  { maxLongEdge: 2048, planningTokens: 5504 },
] as const);
```

档位值在 Moonshot 实测值上向上取整：

| 档位 | Moonshot 实测 | 本地 planning 值 | 余量 |
| ---- | ------------: | ---------------: | ---: |
| 512  |           369 |              384 |   15 |
| 1024 |         1,379 |            1,408 |   29 |
| 1536 |         3,035 |            3,072 |   37 |
| 2048 |         5,486 |            5,504 |   18 |

选择函数必须是纯函数：

```ts
function imagePlanningTokens(width: number, height: number): number {
  const longEdge = Math.max(width, height);
  const bucket = IMAGE_TOKEN_BUCKETS.find(
    (candidate) => longEdge <= candidate.maxLongEdge,
  );
  if (bucket === undefined) {
    throw new Error(
      "Materialized image exceeds the provider image size policy.",
    );
  }
  return bucket.planningTokens;
}
```

规则是“长边所在区间对应的方形上界”，而不是按真实面积插值：

| 最终尺寸 | 档位 | planning tokens |
| -------- | ---: | --------------: |
| 400×300  |  512 |             384 |
| 800×600  | 1024 |           1,408 |
| 1200×700 | 1536 |           3,072 |
| 1800×900 | 2048 |           5,504 |
| 2048×512 | 2048 |           5,504 |

这种规则会高估极端宽图或高图，但保持简单、确定和保守。不得通过宽高面积比例向下插值，
因为不同 provider 存在固定开销、tile 档位和内部缩放行为。

### 4. 图片档位不参与文本 correction factor

档位来自真实图片请求的离线测量并已经向上取整，不应再被用于修正文本 tokenizer 误差的
rolling correction factor 放大。

本地 full estimate 应拆成：

```ts
const guardedTextAndProtocolTokens = Math.ceil(
  rawTextAndProtocolTokens * correctionFactor,
);
const imageTokens = sum(media.map((item) => item.planningTokens));
const usedInputTokens = guardedTextAndProtocolTokens + imageTokens;
```

不能继续使用：

```ts
Math.ceil((rawTextTokens + imageTokens) * correctionFactor);
```

否则初始 `1.25` correction factor 会把已验证的 5,504 图片上界再次放大到 6,880，混淆文本
估算误差与图片尺寸预算。

`RawContextBreakdown` 应继续把图片成本归属到图片所在 message 的角色分类，以维持现有 UI
breakdown；同时增加足够的信息，让总量计算可以区分：

- 需要 calibration 的 text/protocol/tool schema Token；
- 不参与 calibration 的固定 image Token。

### 5. provider usage 仍是真实锚点

本地分档只用于 provider dispatch 前的 planning 和 admission，不替代 provider 返回的 usage。
请求成功后继续：

1. 记录 provider 的 `promptTokens`、`completionTokens` 和 `totalTokens`；
2. 建立 measured context anchor；
3. 后续纯追加上下文使用 `measured anchor + guarded local delta`；
4. 由实际 usage 校正上下文压力和 compaction/retirement 决策。

rolling text calibration 不应使用带图请求作为文本校准样本，因为无法从 provider 汇总 usage
中可靠拆分文本和图片。现有“只有 `mediaOccurrenceCount === 0` 才记录 calibration sample”的
规则继续保留。

当 anchor 后新增图片时，新增图片直接使用对应本地档位，不再调用远端 estimator。

## 请求物化与缓存

### 派生图缓存

同一原始 asset 可能在一个 turn 的多次 agent iteration 中重复发送。实现可以缓存派生图，
但缓存身份必须至少包含：

```text
assetId
image policy version
max long edge
resize algorithm/version
output encoding policy/version
```

缓存不得改变 canonical asset，也不得依赖用户最初选择的文件路径。缓存命中后仍应保证其
内容和 metadata 与缓存键一致。

缓存可以是：

- 单次 turn/session 的内存缓存；或
- 位于私有 `.tinker` 目录的 content-addressed 派生资产缓存。

MVP 可先使用有界内存缓存。无论是否缓存，Base64 都不得进入 SQLite、事件、日志或 canonical
`AgentMessage`。

### 输出格式

实现应优先保持原 MIME 类型，以减少 provider wire format 变化。若缩放库不能安全保持格式，
允许输出 PNG、JPEG 或静态 WebP 中的受支持格式，但编码策略必须固定并进入 image policy
version/hash。

Token 档位只由最终尺寸决定，不由编码格式或压缩质量决定。请求 body byte 上限仍独立执行，
不能因 Token 档位通过而忽略 Base64 payload 大小。

## Profile 合同

图片能力仍由以下字段显式声明：

```json
{
  "inputModalities": ["text", "image"]
}
```

实现后：

- `inputModalities` 包含 `image` 时不再要求 `tokenEstimator`；
- 图片支持仍不能通过模型名称、provider URL 或 profile 名称推断；
- 图片尺寸与 Token 档位是 Tinker 固定产品策略，不开放为 profile 配置；
- `tokenEstimator` 从公开 model profile schema、生成文档和示例中删除；
- 配置中出现未知的 `tokenEstimator` 时应按既有 unknown-field 策略处理，而不是静默继续调用。

新的图片 profile 示例：

```json
{
  "model": "kimi-k3",
  "apiBase": "https://api.example.com/v1",
  "apiKey": "...",
  "contextWindowTokens": 1048576,
  "maxSupportedOutputTokens": 131072,
  "inputModalities": ["text", "image"]
}
```

## Session compatibility 与版本

此次变更会同时改变 provider payload 字节和上下文 planning，必须升级：

```ts
IMAGE_INPUT_POLICY_VERSION = "image-input-policy-v2";
```

`IMAGE_INPUT_POLICY` 及其 hash 至少覆盖：

- 最大 provider 图片长边 `2048`；
- 是否禁止放大；
- 保持宽高比的缩放规则；
- rounding 规则；
- resize algorithm/version；
- 输出编码策略/version；
- 四个尺寸边界；
- 四个 planning Token 值；
- 图片 Token 不参与 text correction factor；
- MIME、单图字节、图片数量和 request body 限制；
- retry policy。

新 session compatibility 不再记录 estimator identity。API key 从来不应进入 compatibility。

旧 session 的处理需要显式决定并测试：

1. **推荐方案：旧格式可解码，但按 compatibility mismatch 拒绝直接恢复执行。** 用户仍可查看
   旧 session；要继续执行则创建使用 v2 policy 的新 session。
2. 如果产品要求原 session 无缝恢复，必须提供明确迁移，把旧 estimator identity 替换成 v2
   image policy identity，并接受恢复后 payload/planning 行为改变。不得静默迁移。

实现阶段不能仅从类型中删除 `tokenEstimator`，还必须更新 SQLite decode/validation、resume
兼容性检查和测试 fixture。

## 删除范围

实施本方案后，应删除或退役以下运行时能力：

- `MoonshotInputTokenEstimator`；
- `moonshot-estimate-token-count-v1` 类型与 compatibility；
- `InputTokenEstimator` 远端图片 admission 抽象（若无其他调用方）；
- Responses payload 到 Chat estimator payload 的转换器；
- estimator endpoint cache key 和网络结果 cache；
- 图片请求首次 dispatch 前的 estimator HTTP 调用；
- model client 中“图片能力必须有 estimator”的构造检查；
- model profile 中 estimator model/base URL/API key/timeout/retry 字段；
- session compatibility 中 estimator identity；
- README 和生成的公开配置合同中的 estimator 配置说明；
- 只为真实 estimator gate 存在的 smoke test 分支。

保留：

- 本地 `estimatePromptSegments`；
- context budget preflight；
- request body byte 限制；
- provider usage 记录；
- measured anchor；
- rolling text calibration；
- 图片数量、格式、解码和完整性校验；
- 图片请求 `maxRetries = 0` 策略，除非另有独立设计修改。

## 失败语义

以下错误必须在 provider dispatch 前失败：

- 原始 asset 缺失或完整性验证失败；
- 图片解码或 orientation 处理失败；
- 缩放失败；
- 缩放后尺寸违反 2048 长边限制；
- 无法映射到 Token 档位；
- materialized request body 超过 byte 上限；
- 本地估算后的请求超过 context input budget。

这些错误是图片物化或 model request admission 失败，不应伪装成 provider 错误，也不应把已经
成功读取的 `ViewImage` 工具结果改写成“工具执行失败”。

如果 provider 尽管通过本地估算仍返回 context-window exceeded：

- 记录标准 provider/turn error；
- 不自动重发大型图片请求；
- 不静默删除图片；
- 后续可由统一 context revision/compaction 设计提供恢复，但不在本文中增加专属图片事务。

## 测试要求

### 单元测试

1. 长边不超过 2048 时禁止放大。
2. 横图、竖图和方图超过上限时保持宽高比缩小。
3. rounding 后长边永不超过 2048。
4. EXIF rotation 后使用视觉方向正确的尺寸。
5. 档位边界：`512/513`、`1024/1025`、`1536/1537`、`2048`。
6. `2049` 的 materialized descriptor 必须失败。
7. 极端宽高比按长边档位保守估算。
8. 图片 Token 不乘 text correction factor。
9. 多图 Token 是各自档位之和。
10. Base64 字节数不进入视觉 Token 估算。
11. request body byte 上限仍对派生图 payload 生效。
12. 原始 asset 字节和 `assetId` 不因派生图而改变。

### 集成测试

1. 不配置 `tokenEstimator` 的 image profile 可以启动并发送图片。
2. 图片请求不产生 `/tokenizers/estimate-token-count` HTTP 调用。
3. 大图在实际 chat/Responses payload 中被缩放到 2048 范围内。
4. 小图 payload 保持原尺寸。
5. 同一图片跨工具 iteration 重放时使用一致的派生尺寸与 planning Token。
6. 请求成功后 provider usage 建立 measured anchor。
7. anchor 后新增图片使用本地档位 delta。
8. context preflight 能用本地分档阻止明显超预算的多图请求。
9. Chat Completions 与 Responses adapter 使用同一图片策略。
10. resume 对 v1/v2 image policy compatibility 给出确定结果。

### 真实 endpoint 回归

保留一个显式 opt-in、不会进入默认测试的 live smoke：

- 四个方形规格至少各测一张图；
- 至少测试一张横图和一张竖图；
- 记录 provider 返回的实际 usage；
- 验证本地 planning Token 不低于选定的保守基准；
- provider 模型或视觉实现升级后重新运行；
- 只有新实测值超过现有档位时才升级 policy version 和档位值。

live smoke 不再调用 Moonshot estimator 作为生产 admission；它只是离线校准与回归工具。

## 风险与权衡

### 保守高估

GPT 在 `2048×2048` 的本次实测为 692 Token，而统一档位为 5,504，约高估 7.95 倍。
这会让图片较多的 GPT 请求更早触发上下文压力。

该权衡当前可接受，因为：

- 目标是移除 provider 专属远端 estimator；
- Kimi 实测确实接近 5,486；
- Tinker 的大上下文 profile 为这种保守误差提供了空间；
- 成功请求后实际 provider usage 会建立 measured anchor；
- 规则简单、可解释且不会因 estimator endpoint 故障阻塞请求。

如果将来保守高估成为实际问题，应通过显式、版本化的 provider capability 设计引入多套
离线表，而不是恢复逐请求远端 estimator，或根据 model 字符串做隐式猜测。

### 长边方形上界高估极端宽高比

`2048×512` 会使用 `2048×2048` 档位。它并不精准，但避免依赖未知 provider 的 tile 和
内部缩放规则。只有取得足够的横竖图实测数据后，才考虑增加二维 bucket 或 patch 公式。

### provider 行为变化

离线数据不是永久事实。provider 可能更新视觉 tokenizer、缩放策略或 usage 口径。因此图片
策略必须版本化，并保留 opt-in live regression。档位应作为安全产品常量维护，而不是声称
是 provider 的公开计费公式。

## 实施顺序

1. 增加 v2 image policy、四档映射及边界测试。
2. 在 request materialization 中实现长边 2048 的等比例缩放和派生 metadata。
3. 让 prepared media descriptor 使用最终尺寸对应的 planning Token。
4. 将 context estimate 拆成“受 calibration 保护的文本”与“不参与 calibration 的图片”。
5. 删除 agent loop 中的图片远端 estimator admission 分支。
6. 删除 model client 的 estimator 构造和图片必配检查。
7. 删除 profile schema、公开配置合同和 README 中的 `tokenEstimator`。
8. 更新 session compatibility、decode、resume 和 policy hash。
9. 更新图片 pipeline、context measurement 和 live smoke 测试。
10. 删除无调用方的 Moonshot estimator 与 Responses-to-Chat 转换代码。
11. 运行 `bun run check`。

## 验收标准

方案完成必须同时满足：

- image profile 只需 `inputModalities: ["text", "image"]`；
- 正常图片请求不会调用任何 Token estimate endpoint；
- provider 收到的每张图片长边不超过 2048，且小图不被放大；
- 本地图片 Token 严格来自最终尺寸对应的四档映射；
- 图片 Token 不参与 text correction factor；
- provider usage 和 measured anchor 继续工作；
- 原始 asset、canonical message、事件和 SQLite 中不出现派生 Base64；
- session compatibility 能识别 v1 与 v2 图片策略差异；
- 所有新增和现有质量门禁通过。
