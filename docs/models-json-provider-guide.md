# `.tinker/models.json` Provider 配置指南

本文汇总不同模型 provider 在 Tinker `.tinker/models.json` 中的推荐配置，重点说明各
provider 的 API adapter、模型能力，以及 `reasoning.supportedEfforts` 和
`reasoning.defaultEffort` 应如何依据官方枚举与映射关系填写。

各 provider 章节中的能力和参数信息以其官方文档为依据；推荐配置则结合 Tinker 当前的
请求与会话实现。后续可以在本文中继续增加其他 provider 章节。

## DeepSeek

本节覆盖 DeepSeek 官方 API 当前提供的两个 V4 模型：

- `deepseek-v4-flash`
- `deepseek-v4-pro`

> 本节中的模型能力、参数枚举和映射关系来自 DeepSeek 官方文档。配置建议则结合了
> Tinker 当前的运行方式；“推荐使用 Responses API”是 Tinker 的集成建议，不代表
> DeepSeek 宣布 Chat Completions 已弃用。

### 推荐配置

建议将两个模型都配置为 Tinker 的 `responses` adapter：

```json
{
  "default": "deepseek-v4-pro",
  "profiles": {
    "deepseek-v4-flash": {
      "model": "deepseek-v4-flash",
      "api": "responses",
      "apiBase": "https://api.deepseek.com",
      "apiKey": "your-deepseek-api-key",
      "contextWindowTokens": 1048576,
      "maxSupportedOutputTokens": 393216,
      "reasoning": {
        "supportedEfforts": ["none", "low", "high", "max"],
        "defaultEffort": "high"
      },
      "stream": true,
      "inputModalities": ["text"]
    },
    "deepseek-v4-pro": {
      "model": "deepseek-v4-pro",
      "api": "responses",
      "apiBase": "https://api.deepseek.com",
      "apiKey": "your-deepseek-api-key",
      "contextWindowTokens": 1048576,
      "maxSupportedOutputTokens": 393216,
      "reasoning": {
        "supportedEfforts": ["none", "low", "high", "max"],
        "defaultEffort": "high"
      },
      "stream": true,
      "inputModalities": ["text"]
    }
  }
}
```

启动时指向该文件：

```bash
export TINKER_MODELS=.tinker/models.json
tinker
```

也可以显式选择模型：

```bash
tinker --profile deepseek-v4-flash
tinker --profile deepseek-v4-pro
```

请保护配置文件权限，因为 `apiKey` 会以明文保存在 JSON 中。Tinker 当前不会在
`models.json` 的字符串值内自动展开 `$DEEPSEEK_API_KEY` 一类环境变量，因此不要把
`"$DEEPSEEK_API_KEY"` 当成密钥引用。

### 为什么推荐 Responses API

DeepSeek 官方 Responses API 同时支持 `deepseek-v4-flash` 和
`deepseek-v4-pro`，并原生支持以下请求字段：

```json
{
  "reasoning": {
    "effort": "high"
  }
}
```

Tinker 在 profile 中设置：

```json
{
  "api": "responses",
  "reasoning": {
    "supportedEfforts": ["none", "low", "high", "max"],
    "defaultEffort": "high"
  }
}
```

后，会把当前选择直接发送为：

```json
{
  "reasoning": {
    "effort": "<当前 effort>"
  }
}
```

这比 Chat Completions 更适合 Tinker 的 provider-neutral 配置方式，原因是：

1. Thinking 开关和推理强度统一由标准的 `reasoning.effort` 表达；
2. `none` 可以直接关闭 Thinking，不需要 DeepSeek 专有的
   `thinking: {"type":"disabled"}`；
3. DeepSeek Responses API 是无状态接口，而 Tinker 本身会提交完整输入历史并发送
   `store: false`，两者契合；
4. 不需要为 DeepSeek 额外注入 Chat Completions 的 `thinking` 扩展字段；
5. DeepSeek 官方特别说明 V4 Flash 原生支持 Responses API，并针对 Codex 类 Agent
   场景做了适配。

DeepSeek 不支持 Responses API 的 `previous_response_id`、`conversation` 和持久化
`store`。这不会阻止 Tinker 使用该接口，因为 Tinker 使用无状态完整历史请求，不依赖
服务端 response chaining。

### Reasoning effort 的官方枚举与映射

#### DeepSeek 实际提供的三档 Thinking 强度

DeepSeek 官方说明，V4 Flash 和 V4 Pro 的实际 Thinking 强度相同，均为：

| DeepSeek 实际档位 | 官方建议用途    |
| ----------------- | --------------- |
| `low`             | 简单任务        |
| `high`            | 日常 Agent 任务 |
| `max`             | 更复杂的任务    |

Thinking 默认开启，默认强度为 `high`。

#### Responses API 接受的完整枚举

DeepSeek Responses API 的 `reasoning.effort` 接受：

```text
none, minimal, low, medium, high, xhigh, max
```

但是这些请求值不会形成七种不同的实际计算档位。官方映射为：

| Responses 请求值 | Thinking 状态 | DeepSeek 实际档位 |
| ---------------- | ------------- | ----------------- |
| `none`           | 关闭          | 不进行 Thinking   |
| `minimal`        | 开启          | `low`             |
| `low`            | 开启          | `low`             |
| `medium`         | 开启          | `high`            |
| `high`           | 开启          | `high`            |
| `xhigh`          | 开启          | `high`            |
| `max`            | 开启          | `max`             |

其中最容易配置错误的是：

```text
xhigh -> high
max   -> max
```

在 DeepSeek 官方 API 中，真正的最高档是 `max`，不是 `xhigh`。

### Tinker 应该暴露哪些 effort

#### 推荐：只暴露四个语义不同的值

建议配置：

```json
{
  "reasoning": {
    "supportedEfforts": ["none", "low", "high", "max"],
    "defaultEffort": "high"
  }
}
```

理由是这四个值分别对应四种不同的服务端行为：

1. `none`：关闭 Thinking；
2. `low`：低强度 Thinking；
3. `high`：高强度 Thinking；
4. `max`：最大强度 Thinking。

Tinker 的 `supportedEfforts` 是展示给用户的 provider 能力菜单，不只是“服务端不会拒绝
的字符串列表”。省略 `minimal`、`medium` 和 `xhigh` 可以避免向用户展示多个实际效果
相同的选项。

在 TUI 中可以使用：

```text
/reasoning
/reasoning none
/reasoning low
/reasoning high
/reasoning max
/reasoning reset
```

`/reasoning reset` 会恢复 profile 中的 `defaultEffort`，这里即 `high`。运行时选择只对
当前 session runtime 生效，不会改写 `models.json`。

#### 可选：完整暴露所有兼容枚举

如果配置目的不是简化用户选择，而是精确展示 DeepSeek Responses API 接受的全部
OpenAI-compatible 值，也可以写成：

```json
{
  "reasoning": {
    "supportedEfforts": [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "defaultEffort": "high"
  }
}
```

这样配置是有效的，但用户需要知道：

- `minimal` 与 `low` 最终都执行 `low`；
- `medium`、`high` 与 `xhigh` 最终都执行 `high`；
- 只有 `max` 才执行最高档。

因此不建议把完整兼容枚举作为 Tinker 的默认 DeepSeek 示例。

### 字段说明

#### `model`

使用 DeepSeek 官方稳定 API 名称：

```json
"model": "deepseek-v4-flash"
```

或：

```json
"model": "deepseek-v4-pro"
```

DeepSeek 官方首页当前说明，这两个稳定名称分别指向
DeepSeek-V4-Flash-0731 和 DeepSeek-V4-Pro-0813。具体后端版本可以升级，但稳定 API
名称不变。

#### `api`

推荐：

```json
"api": "responses"
```

这会让 Tinker 请求 DeepSeek 的 `/responses` 接口，并使用
`reasoning: {"effort": ...}`。

#### `apiBase`

使用官方 API root：

```json
"apiBase": "https://api.deepseek.com"
```

不要追加 `/responses`，因为 Tinker 的 OpenAI SDK adapter 会添加 endpoint route。也不必
为了 Responses API 添加 `/v1`。

#### `contextWindowTokens`

两款 V4 模型的上下文长度均为 1M；在 Tinker 中按 `1024 * 1024` tokens 配置：

```json
"contextWindowTokens": 1048576
```

#### `maxSupportedOutputTokens`

两款模型的最大输出为 384K；在 Tinker 中按 `384 * 1024` tokens 配置：

```json
"maxSupportedOutputTokens": 393216
```

这是模型能力上限，不代表每次都应生成 384K tokens。输入和输出仍共享 1M context
window。这里的 `K` 和 `M` 均按 1024 换算，因此分别填写 `393216` 和 `1048576`，不要写
成十进制的 `384000` 和 `1000000`。

Tinker 当前还有独立的产品级单次输出预算上限：`128 * 1024 = 131072` tokens。因此即使
profile 声明模型支持 393216，当前 Tinker 实际发送的 `max_output_tokens` 仍会取两者较小
值，即最多 131072。这里仍应填写 provider 的真实能力上限，而不是把字段改成当前
Tinker 产品上限。

#### `inputModalities`

DeepSeek 官方 Responses API 目前不支持实际图片或文件输入；`input_image` 只会被替换为
占位文本。因此配置为：

```json
"inputModalities": ["text"]
```

不要为这两个 profile 声明 `image`。

#### `includeReasoningContent`

这是 Tinker 的 Chat Completions 兼容选项，Responses adapter 会忽略它。使用本文推荐
配置时可以直接省略。

### 如果必须使用 Chat Completions

DeepSeek Chat Completions 的官方原生 reasoning effort 为：

```text
low, high, max
```

兼容输入 `medium` 和 `xhigh` 都会映射到 `high`。可使用下面的受限配置：

```json
{
  "model": "deepseek-v4-pro",
  "api": "chat-completions",
  "apiBase": "https://api.deepseek.com",
  "apiKey": "your-deepseek-api-key",
  "contextWindowTokens": 1048576,
  "maxSupportedOutputTokens": 393216,
  "reasoning": {
    "supportedEfforts": ["low", "high", "max"],
    "defaultEffort": "high"
  },
  "includeReasoningContent": true,
  "stream": true,
  "inputModalities": ["text"]
}
```

但应注意两个限制：

1. DeepSeek 官方要求通过 `thinking: {"type":"enabled"}` 或
   `thinking: {"type":"disabled"}` 单独控制 Thinking；Tinker 当前 profile schema 不提供
   通用 `extra_body` 字段；
2. Thinking 模式下发生工具调用时，DeepSeek 官方要求在后续请求中完整回传该 assistant
   message 的 `reasoning_content`，所以 Chat Completions 配置需要
   `includeReasoningContent: true`。

这也是本文优先推荐 Responses API 的主要原因。

## Kimi

本节仅覆盖 Kimi 当前最新模型：

- `kimi-k3`

Kimi 官方公开 API 当前主要提供 OpenAI-compatible Chat Completions，并在 API 端点列表中
列出 `/v1/chat/completions`，未提供 `/v1/responses`。因此 K3 在 Tinker 中应使用
`chat-completions` adapter。

### 推荐配置

Kimi K3 原生支持文本和图片输入。图片 profile 在 Tinker 中必须同时配置 Moonshot 官方
Token 估算接口：

```json
{
  "default": "kimi-k3",
  "profiles": {
    "kimi-k3": {
      "model": "kimi-k3",
      "api": "chat-completions",
      "apiBase": "https://api.moonshot.cn/v1",
      "apiKey": "your-moonshot-api-key",
      "contextWindowTokens": 1048576,
      "maxSupportedOutputTokens": 1048576,
      "reasoning": {
        "supportedEfforts": ["low", "high", "max"],
        "defaultEffort": "max"
      },
      "includeReasoningContent": true,
      "stream": true,
      "inputModalities": ["text", "image"],
      "tokenEstimator": {
        "kind": "moonshot-estimate-token-count-v1",
        "model": "kimi-k3",
        "apiBase": "https://api.moonshot.cn/v1",
        "apiKey": "your-moonshot-api-key",
        "timeoutMs": 30000,
        "maxRetries": 0
      }
    }
  }
}
```

启动时指向该文件：

```bash
export TINKER_MODELS=.tinker/models.json
tinker
```

请保护配置文件权限。Tinker 当前不会在 `models.json` 的字符串值内自动展开
`$MOONSHOT_API_KEY` 一类环境变量；主模型和 Token estimator 的 `apiKey` 都必须填写实际
凭据。

如果不需要图片输入，可以把：

```json
"inputModalities": ["text", "image"]
```

改为：

```json
"inputModalities": ["text"]
```

并删除整个 `tokenEstimator` 对象。

### API adapter

K3 应配置为：

```json
"api": "chat-completions"
```

Kimi 官方 API 概述当前公开的模型推理端点是：

```text
POST /v1/chat/completions
```

官方端点列表未列出 `/v1/responses`，K3 文档和示例也都使用 Chat Completions。因此不要
为 K3 profile 配置 Tinker 的 `responses` adapter。

Tinker 的 Chat Completions adapter 会发送 K3 官方要求的顶层字段：

```json
{
  "reasoning_effort": "max"
}
```

并在流式请求中发送 `stream_options.include_usage: true`，以取得完整 usage。

### Reasoning effort

Kimi K3 始终启用推理，并且 Preserved Thinking 始终开启。它不支持关闭 Thinking，也不
应传入旧模型使用的 `thinking` 参数。

官方 `reasoning_effort` 只有三档：

```text
low, high, max
```

默认值是 `max`，没有额外的兼容映射。因此 Tinker 应直接配置：

```json
{
  "reasoning": {
    "supportedEfforts": ["low", "high", "max"],
    "defaultEffort": "max"
  }
}
```

Tinker 会把 `/reasoning` 当前选择原样发送到 Chat Completions 请求顶层：

```text
/reasoning low  -> reasoning_effort: "low"
/reasoning high -> reasoning_effort: "high"
/reasoning max  -> reasoning_effort: "max"
```

Kimi 官方说明，切换 reasoning effort 会破坏前缀缓存命中。因此可以使用
`/reasoning` 切换档位，但为了保持缓存稳定，宜在会话开始前确定所需档位。

### Preserved Thinking 与 `includeReasoningContent`

K3 的多轮对话和工具调用必须把 API 返回的完整 assistant message 原样加入后续
`messages`，其中包括：

- `content`
- `reasoning_content`
- 存在工具调用时的 `tool_calls`

因此 K3 profile 必须配置：

```json
"includeReasoningContent": true
```

Tinker 会解析 Kimi 返回的 `reasoning_content`，并在后续 Chat Completions 历史中回传。
如果省略该字段，它在 Tinker profile 中默认是 `false`，不符合 K3 Preserved Thinking 的
官方上下文要求。

### 上下文与最大输出

Kimi K3 的上下文窗口为 1M tokens，在 Tinker 中按 `1024 * 1024` 配置：

```json
"contextWindowTokens": 1048576
```

Kimi 官方 Chat Completions schema 说明：

- `max_completion_tokens` 默认是 `131072`；
- 最大可设置为 `1048576`；
- input tokens 与 `max_completion_tokens` 之和不能超过 1M context window。

因此模型能力字段配置为：

```json
"maxSupportedOutputTokens": 1048576
```

Tinker 当前产品级单次输出预算上限也是 `128 * 1024 = 131072` tokens，所以实际发送给
K3 的 `max_completion_tokens` 为 `131072`，与 K3 官方默认值一致。这里仍填写 provider
支持的最大值 `1048576`，而不是 Tinker 当前的请求上限。

### 输入模态与 Token estimator

K3 原生支持视觉理解。Tinker 当前 profile 只表达 `text` 和 `image`，因此配置为：

```json
"inputModalities": ["text", "image"]
```

Kimi K3 还支持视频，但 Tinker 当前没有 `video` input modality，不能在 profile 中声明或
通过 Tinker 附加视频。

Tinker 的图片输入是 base64 data URL，属于 Kimi 官方支持的图片传输方式。Tinker 接受
PNG、JPEG 和静态 WebP；这是 Kimi 支持格式的安全子集。公网图片 URL 不在 Tinker 图片
附件流程内，而 Kimi 官方也要求视觉输入使用 base64 或其文件服务，不支持直接传公网
图片 URL。

图片会动态消耗 tokens，所以 Tinker 要求 image profile 配置独立 estimator：

```json
{
  "tokenEstimator": {
    "kind": "moonshot-estimate-token-count-v1",
    "model": "kimi-k3",
    "apiBase": "https://api.moonshot.cn/v1",
    "apiKey": "your-moonshot-api-key",
    "timeoutMs": 30000,
    "maxRetries": 0
  }
}
```

它会调用 Moonshot 官方端点：

```text
POST /v1/tokenizers/estimate-token-count
```

并读取响应中的 `data.total_tokens`。估算请求使用同一个 `kimi-k3` 模型名，并携带实际
messages 与 tools，从而覆盖图片在内的完整请求输入。

### 其他与 Tinker 相关的官方约束

- K3 支持 streaming；本文配置使用 `"stream": true`。
- K3 的 `temperature=1.0`、`top_p=0.95`、`n=1`、
  `presence_penalty=0`、`frequency_penalty=0` 是固定值。Tinker 不发送这些字段，符合官方
  建议。
- K3 支持 `tool_choice` 的 `auto`、`none` 和 `required`。Tinker 的普通 Agent 请求使用
  `auto`，属于官方支持范围。
- K3 的 reasoning tokens 和最终 `content` 共同受 `max_completion_tokens` 限制。

## OpenAI

本节使用 OpenAI 当前 GPT-5.6 系列作为配置示例：

- `gpt-5.6`：指向 GPT-5.6 Sol 的稳定别名
- `gpt-5.6-terra`
- `gpt-5.6-luna`

三款模型都支持 Chat Completions 和 Responses API。Tinker 推荐使用 Responses API。

### 推荐配置

```json
{
  "default": "openai-gpt-5.6",
  "profiles": {
    "openai-gpt-5.6": {
      "model": "gpt-5.6",
      "api": "responses",
      "apiBase": "https://api.openai.com/v1",
      "apiKey": "your-openai-api-key",
      "contextWindowTokens": 1050000,
      "maxSupportedOutputTokens": 128000,
      "reasoning": {
        "supportedEfforts": ["none", "low", "medium", "high", "xhigh", "max"],
        "defaultEffort": "medium"
      },
      "stream": true,
      "inputModalities": ["text"]
    },
    "openai-gpt-5.6-terra": {
      "model": "gpt-5.6-terra",
      "api": "responses",
      "apiBase": "https://api.openai.com/v1",
      "apiKey": "your-openai-api-key",
      "contextWindowTokens": 1050000,
      "maxSupportedOutputTokens": 128000,
      "reasoning": {
        "supportedEfforts": ["none", "low", "medium", "high", "xhigh", "max"],
        "defaultEffort": "medium"
      },
      "stream": true,
      "inputModalities": ["text"]
    },
    "openai-gpt-5.6-luna": {
      "model": "gpt-5.6-luna",
      "api": "responses",
      "apiBase": "https://api.openai.com/v1",
      "apiKey": "your-openai-api-key",
      "contextWindowTokens": 1050000,
      "maxSupportedOutputTokens": 128000,
      "reasoning": {
        "supportedEfforts": ["none", "low", "medium", "high", "xhigh", "max"],
        "defaultEffort": "medium"
      },
      "stream": true,
      "inputModalities": ["text"]
    }
  }
}
```

启动时指向配置文件：

```bash
export TINKER_MODELS=.tinker/models.json
tinker
```

请保护配置文件权限。Tinker 当前不会在 `models.json` 的字符串值内自动展开
`$OPENAI_API_KEY`，`apiKey` 必须填写实际凭据。

### API adapter

推荐配置：

```json
"api": "responses"
```

Tinker 会通过 OpenAI SDK 调用 `/v1/responses`，发送完整输入历史并使用 `store: false`。
这不依赖 OpenAI 服务端保存 response，也不需要 `previous_response_id`。

如果使用只支持 Chat Completions 的其他 OpenAI 模型，也可以把 adapter 改为：

```json
"api": "chat-completions"
```

### Reasoning effort

GPT-5.6 Sol、Terra 和 Luna 使用相同的 reasoning effort 枚举：

```text
none, low, medium, high, xhigh, max
```

默认值均为 `medium`，没有 provider 映射。因此推荐原样配置全部六档：

```json
{
  "reasoning": {
    "supportedEfforts": ["none", "low", "medium", "high", "xhigh", "max"],
    "defaultEffort": "medium"
  }
}
```

Tinker 的 `/reasoning` 会直接选择 Responses 请求中的 `reasoning.effort`。如果改用其他
OpenAI 模型，应按该模型实际支持的枚举和默认值调整这两个字段，不能直接沿用 GPT-5.6
配置。

### 上下文与最大输出

GPT-5.6 Sol、Terra 和 Luna 的配置均为：

```json
"contextWindowTokens": 1050000,
"maxSupportedOutputTokens": 128000
```

这里使用 OpenAI 给出的准确十进制 token 数值，不把 `1.05M` 或 `128K` 按 1024 重新
换算。Tinker 当前产品级输出上限是 131072 tokens，因此对这些模型实际发送的
`max_output_tokens` 是模型上限 128000。

### 输入模态

本文推荐配置使用：

```json
"inputModalities": ["text"]
```

GPT-5.6 系列支持图片输入，Tinker 的 Chat Completions 和 Responses adapter 也可以发送
用户附加的本地图片。不过 Tinker 的 image profile 当前必须配置独立
`tokenEstimator`，现有 estimator 是 Moonshot 协议，不是 OpenAI 官方 Token 估算接口。
因此纯 OpenAI profile 建议先保持 text-only，避免为了输入预算估算把完整请求额外发送给
另一个 provider。

Tinker 当前的工具结果以文本 Observation 返回。即使工具自身产生截图或其他媒体，也不会
作为多模态 tool result 发送给模型；这不影响普通文本工具调用。

## Azure OpenAI

Azure OpenAI v1 API 可以直接使用 Tinker 当前的 OpenAI SDK adapter。推荐使用支持
Responses API 的 Azure OpenAI 模型部署和 API key 鉴权。

### 推荐配置

下面假设 Azure 中已部署 GPT-5.6，并将 deployment 命名为 `my-gpt-5-6`：

```json
{
  "default": "azure-openai-gpt-5.6",
  "profiles": {
    "azure-openai-gpt-5.6": {
      "model": "my-gpt-5-6",
      "api": "responses",
      "apiBase": "https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1/",
      "apiKey": "your-azure-openai-api-key",
      "contextWindowTokens": 1050000,
      "maxSupportedOutputTokens": 128000,
      "reasoning": {
        "supportedEfforts": ["none", "low", "medium", "high", "xhigh", "max"],
        "defaultEffort": "medium"
      },
      "stream": true,
      "inputModalities": ["text"]
    }
  }
}
```

也可以使用 Foundry resource endpoint：

```text
https://YOUR-RESOURCE-NAME.services.ai.azure.com/openai/v1/
```

### `model` 使用 deployment name

Azure OpenAI profile 的 `model` 必须填写 Azure 中的模型 deployment name，不一定等于
底层 OpenAI model ID。例如部署名称是 `my-gpt-5-6`，就应配置：

```json
"model": "my-gpt-5-6"
```

不要因为底层模型是 GPT-5.6 就自动改成 `"gpt-5.6"`。只有 deployment 本身也使用这个
名称时，两者才相同。

### `apiBase` 使用 Azure v1 endpoint

Azure OpenAI Responses profile 应使用：

```text
https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1/
```

不要添加 `/responses`，Tinker 的 SDK adapter 会自动添加 endpoint route。v1 inference
endpoint 也不需要在 URL 中配置旧式日期版本的 `api-version`。

### 模型能力配置

`contextWindowTokens`、`maxSupportedOutputTokens`、`supportedEfforts` 和
`defaultEffort` 应按 Azure deployment 对应的底层模型填写。上面的示例部署 GPT-5.6，
所以与 OpenAI 官方 GPT-5.6 profile 使用相同的能力值。

Azure 的模型版本、region 和 deployment 必须支持 Responses API。如果所部署模型只支持
Chat Completions，可以将 profile 的 adapter 改为：

```json
"api": "chat-completions"
```

### 鉴权

本文配置使用 Azure OpenAI API key：

```json
"apiKey": "your-azure-openai-api-key"
```

Azure v1 endpoint 可以由标准 OpenAI SDK 使用该凭据。Tinker 的 `models.json` 当前要求
`apiKey` 是静态字符串，因此本文不配置 Microsoft Entra ID token provider 或 managed
identity。

### 输入模态

Azure OpenAI 示例同样使用：

```json
"inputModalities": ["text"]
```

如果 deployment 支持图片，Tinker transport 可以发送用户图片，但 image profile 仍需要
Tinker 支持的独立 `tokenEstimator`。在没有与 Azure deployment 对应的 estimator 配置
前，建议保持 text-only。

