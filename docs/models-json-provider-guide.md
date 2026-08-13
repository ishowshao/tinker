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

### Flash 与 Pro 如何选择

| Profile             | 官方定位                                                    | 建议用途                                 |
| ------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| `deepseek-v4-flash` | 更小、更快、更经济；简单 Agent 任务接近 Pro                 | 高频日常操作、简单代码任务、成本敏感场景 |
| `deepseek-v4-pro`   | 更强的世界知识、复杂推理、数学、STEM、编程与 Agentic Coding | 默认主力模型、复杂仓库任务、困难推理     |

如果只配置一个模型：

- 更看重复杂任务质量：选择 Pro；
- 更看重速度和成本：选择 Flash。

两者的 `supportedEfforts` 和 `defaultEffort` 无需区别配置。

### 不推荐的配置

#### 把 `xhigh` 当作最高档

```json
{
  "supportedEfforts": ["low", "high", "xhigh"],
  "defaultEffort": "xhigh"
}
```

该配置会把默认请求映射到 DeepSeek 的 `high`，而不是 `max`。如果希望默认使用最高档，
应明确配置：

```json
{
  "supportedEfforts": ["low", "high", "max"],
  "defaultEffort": "max"
}
```

#### 省略 `reasoning`

省略整个 `reasoning` 对象时，Tinker 不发送 effort 参数，并禁用该 profile 的
`/reasoning` 命令。DeepSeek 会使用自己的默认行为，即 Thinking 开启、effort 为
`high`，但 Tinker 用户无法在 session 中切换档位。

#### 使用 Chat Completions 却期待 `none` 自动关闭 Thinking

Tinker 的 Chat Completions adapter 只会发送：

```json
{ "reasoning_effort": "none" }
```

而 DeepSeek Chat Completions 官方使用独立的专有字段：

```json
{ "thinking": { "type": "disabled" } }
```

当前 `models.json` 没有 provider-specific `extra_body` 配置用于注入该字段。因此，如果
需要在 Tinker 中通过 `/reasoning none` 可靠关闭 DeepSeek Thinking，应使用本文推荐的
Responses adapter。

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


