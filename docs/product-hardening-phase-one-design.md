# 产品加固阶段一：公共契约与发布收口实施方案

## 文档状态

- 状态：待实施。
- 日期：2026-07-22。
- 基线：Tinker `1.3.0`，commit `7822852dad23`。
- 上位路线图：[`product-hardening-roadmap.md`](product-hardening-roadmap.md)。
- 性质：阶段一的独立实施合同；实现、测试和验收应以本文为准。

本文只收口已经存在的 Tinker 产品能力，不新增 agent 能力。完成后，用户从 npm
安装得到的命令、README 描述、运行时配置、依赖状态和发布验证必须指向同一份可检查的
公共契约。

## 1. 阶段结果

阶段一完成时必须同时得到以下结果：

1. npm 包暴露的 `tinker` 入口在没有模型配置时也能直接执行 `--help`、`--version` 和
   `doctor`；未知命令或参数不会误启动 TUI。
2. README 准确描述当前命令、配置、模型 profile、图片输入和全部内置 slash commands。
3. 公共环境变量与 model profile 字段拥有代码内的单一声明源；parser、doctor、README
   校验和测试不再分别维护字段名与默认值。
4. 当前依赖 advisory 被修复，或按本文的例外合同记录；CI 和发布链持续执行安全审计。
5. Dependabot 使用 Bun 生态更新 `package.json` 与文本 `bun.lock`，任何不同步的 PR 在
   frozen install 阶段立即失败。
6. 实际 npm tarball 在干净的 macOS 和 Linux 前缀中验证入口、内置 Bun、内置 ripgrep、
   帮助、版本、doctor 和无配置失败路径。

这六项是一个整体。只增加三个 CLI 命令、只修 README，或只让当前机器上的
`release:verify` 通过，都不能判定阶段完成。

## 2. 当前基线与已确认缺口

以下结论来自本文基线的代码、测试、工作流和本地命令，不是路线图中的推测。

### 2.1 已有基础

- `package.json` 只发布 `tinker -> bin/tinker.js`，发布包内携带 `bun@1.3.14`、
  `@vscode/ripgrep@1.18.0` 和 `markdansi` patch。
- `scripts/verify-release-package.ts` 已经执行真实 `npm pack`、临时全局安装，并验证包内容、
  内置 Bun、ripgrep、license 和 patch。
- CI 已在 `ubuntu-latest`、`macos-latest` 上执行
  `bun install --frozen-lockfile` 和 `bun run check`。
- tag 驱动的 publish workflow 已执行 frozen install、完整质量门禁、tarball 验证和 npm
  trusted publishing。
- model profile parser 已经拒绝未知字段，并严格验证文本/图片 modality、图片 token
  estimator 和 context budget。

### 2.2 CLI 缺口

`src/cli/index.ts` 当前通过少量条件分支直接读取 `process.argv`：

- 没有 `--help`、`--version` 或 `doctor`；
- 除 `run`、`--profile`、`-p` 外的输入都会落入 `runTui()`；
- `tinker --unknown` 会误启动 TUI，而不是报告 usage error；
- CLI 语法、usage 文本和包版本没有独立、可测试的所有者。

### 2.3 文档与配置漂移

README 当前存在明确错误：

- 列出了代码不读取的 `TINKER_MCP_CONFIG`、`TINKER_EVENT_LOG`、
  `TINKER_SESSION_DIR`、`TINKER_INCLUDE_REASONING`、
  `TINKER_TASK_STOP_GRACE_MS` 和 `TINKER_CONTEXT_BUDGET_TOKENS`；
- `TINKER_MCP_TIMEOUT_MS` 的文档默认值是 `30000`，实现默认值是 `60000`；
- 漏掉实际必填的 `TINKER_CONTEXT_WINDOW_TOKENS`、
  `TINKER_MAX_SUPPORTED_OUTPUT_TOKENS`，以及实际字段
  `TINKER_INCLUDE_REASONING_CONTENT`、`TINKER_STREAM`；
- slash commands 漏掉 `/mcp`、`/clear` 和 `/fork`；
- profile 示例没有解释 `stream`、`inputModalities` 和图片 profile 必需的
  `tokenEstimator`；
- 没有说明图片只能由 TUI 的 `@` 工作区文件选择器附加，且只接受 PNG、JPEG、静态
  WebP；one-shot、剪贴板图片、远程 URL、GIF 和动画图片均不支持；
- “any OpenAI-compatible API” 和 “defaults to DeepSeek” 不是当前代码或真实资格矩阵能
  保证的产品承诺。

环境变量解析还分散在 `src/cli/config.ts`、`src/model/model-context-profile.ts`、
`src/cli/model-profiles.ts`、MCP 和多个 tool 模块中。部分无效值 fast-fail，
`TINKER_WEBFETCH_REFINE_THRESHOLD` 的无效值却会静默回退默认值，行为不一致。

### 2.4 依赖与自动更新缺口

在基线运行 `bun audit` 得到：

| 严重度 | Advisory | 当前依赖路径 |
| --- | --- | --- |
| high | `GHSA-v2hh-gcrm-f6hx` | `fast-uri@3.1.3`，来自 MCP SDK/Ajv，同时出现在 ESLint/Ajv 路径 |
| moderate | `GHSA-frvp-7c67-39w9` | `@hono/node-server<2.0.5`，来自 MCP SDK |

审计结果是实施起点，不是永久快照；落地时必须重新运行审计并以当时 lockfile 的完整依赖
路径为准。

`.github/dependabot.yml` 当前把根目录声明为 `package-ecosystem: npm`。GitHub
[当前已经原生支持](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories#bun)
Bun 1.1.39 及以上的文本 `bun.lock`，因此本项目应使用 `package-ecosystem: bun`，不再增加
机器人提交后的自制 lockfile 修复 bot。

### 2.5 发布验证缺口

当前 `release:verify` 只证明 `tinker run` 能通过内置 Bun 启动并在缺少
`TINKER_MODEL` 时失败。它还没有验证：

- `--help`、`--version` 和 `doctor`；
- 未知命令的 exit code；
- 一份合法配置能否让 doctor 完成离线检查；
- 同一份真实 tarball 在 macOS 和 Linux 上均可安装运行。

publish workflow 只在 Ubuntu 执行 tarball 验证；普通 CI 的 macOS job 只从源码运行质量
门禁，不能替代安装后验证。

## 3. 范围与非目标

### 3.1 本阶段范围

- 顶层 CLI 语法、帮助、版本、doctor、错误输出和 exit code。
- Tinker 主程序使用的公共环境变量与 model profile JSON 契约。
- README 中与已实现功能直接相关的用户说明。
- Bun lockfile、依赖审计、Dependabot 和发布包 smoke。
- macOS、Linux 的 npm 全局安装场景；两者都通过 Node 启动器拉起包内 Bun。

### 3.2 非目标

- 不引入 permission、approval、sandbox 或 workspace trust。
- 不实现 provider 资格矩阵，不为某个 provider 增加兼容逻辑，也不做真实 provider smoke；
  这些属于阶段二。
- 不增加 TUI 增量输出、Chrome 交付或浏览器交互。
- 不改变 canonical history、session schema、context revision、Recall 或 MCP 协议。
- 不新增图片格式、图片来源或 one-shot 图片参数。
- 不实现 `doctor --fix`，不修改用户文件，不启动 provider 请求或 MCP server。
- 不为 README 中从未生效的旧变量增加 alias 或兼容读取。
- 不承诺 Windows。Windows 可由将来独立阶段设计和验证。

## 4. 顶层 CLI 与 one-shot Prompt 输入

独立技术方案：
[`product-hardening-phase-one-cli-design.md`](product-hardening-phase-one-cli-design.md)。

该文档冻结 Commander 选型、完整命令语法、help/version/exit code、解析与副作用边界，以及
one-shot Prompt 的三个互斥来源：单个引用参数、`--stdin` 和 `--file <path>`。阶段一实现
不得继续使用 variadic argv 拼接 Prompt，也不得在上位方案中另建一套 CLI 合同。

## 5. `tinker doctor` 合同

`doctor` 的命令语法、只读检查顺序、脱敏、输出和退出码也由上述独立 CLI 方案统一定义。
本方案只保留阶段门槛：doctor 不调用 provider、token estimator 或 MCP server，不创建
session 或 workspace 文件，并复用 production config/project parsers。

## 6. 公共配置单一声明源

### 6.1 设计决定

新增 `src/cli/public-config-contract.ts`，用不可变声明描述公共字段：

```ts
type PublicConfigField = {
  name: string;
  valueKind: "non-empty-string" | "positive-integer" | "boolean";
  requiredIn: "always" | "env-mode" | "never";
  defaultValue?: string | number | boolean;
  secret: boolean;
  section: "model" | "workspace" | "tooling";
  description: string;
};
```

实际类型可按实现需要拆分，但以下约束不可改变：

- 字段名、类型、默认值、是否 secret 和适用模式只声明一次；
- runner parser 和 tool config parser 使用该声明，不再各自直接读取、各自容错；
- model profile 的 known keys、默认值和 primitive 类型也来自同模块的 profile contract；
- cross-field 规则保留为明确函数，例如 output 不得大于 context、image 必须携带 estimator；
- README 中的环境变量表和 profile 字段表由声明确定性生成或校验；
- 无效的已声明字段统一在 session 创建前 fast-fail，不再静默回退。

不要为了“共享 schema”引入第二套只供文档使用的 JSON Schema。运行时声明就是主契约；如
未来需要导出 JSON Schema，应从它派生。

### 6.2 公共环境变量

阶段一把当前实际入口中的环境变量分成三组。

#### 启动与模型

| 变量 | 合同 |
| --- | --- |
| `TINKER_MODELS` | 可选 profile JSON 路径；相对路径相对进程 cwd；设置后进入 profile mode |
| `TINKER_MODEL` | env mode 必填 |
| `TINKER_BASE_URL` | env mode 必填，secret=false |
| `TINKER_API_KEY` | env mode 必填，secret=true |
| `TINKER_CONTEXT_WINDOW_TOKENS` | env mode 必填正整数 |
| `TINKER_MAX_SUPPORTED_OUTPUT_TOKENS` | env mode 必填正整数，且不得大于 context window |
| `TINKER_INCLUDE_REASONING_CONTENT` | env mode 可选布尔值，默认 `false` |
| `TINKER_STREAM` | env mode 可选布尔值，默认 `true` |
| `TINKER_WEBFETCH_REFINE_MODEL` | env mode 可选；当前必须与主 model 相同 |
| `TINKER_WORKSPACE` | 可选，默认进程 cwd；runner 最终要求 realpath 存在 |
| `TINKER_MAX_ITERATIONS` | 可选正整数，默认 `512` |

布尔环境值继续接受大小写不敏感的 `true/false`、`1/0`、`yes/no`、`on/off`。不增加其他
宽松写法。

#### Tooling

| 变量 | 默认值 | 合同 |
| --- | ---: | --- |
| `EXA_API_KEY` | 未设置 | 设置后启用 WebSearch，并可供 WebFetch Exa backend 使用；secret |
| `TINKER_MCP_TIMEOUT_MS` | `60000` | MCP tool call 正整数超时 |
| `TINKER_MCP_MAX_OBSERVATION_CHARS` | `40000` | 单次 MCP model-visible 输出正整数上限 |
| `TINKER_BASH_DEFAULT_TIMEOUT_MS` | `5000` | Bash 默认前台超时，正整数且不得大于 max |
| `TINKER_BASH_MAX_TIMEOUT_MS` | `600000` | Bash 前台超时上限，正整数 |
| `TINKER_GREP_TIMEOUT_MS` | `20000` | bundled ripgrep 调用正整数超时 |
| `TINKER_GREP_MAX_BUFFER_BYTES` | `20000000` | ripgrep 输出 buffer 正整数上限 |
| `TINKER_WEBFETCH_REFINE_THRESHOLD` | `2000` | WebFetch 进入 refiner 的正整数阈值 |
| `TINKER_RIPGREP_PATH` | 包内路径 | 仅用于显式诊断覆盖；普通安装不需要设置 |

这些值由 CLI composition root 一次解析，再通过 `RunnerConfig`/tooling options 传给相应
组件。生产 tool executor 不应在 session 已创建后继续零散读取 `process.env`。

#### 非公共内部变量

测试注入、子进程私有协议和 live-smoke 开关不是产品配置，包括但不限于
`TINKER_TEST_FAKE_MODEL`、`TINKER_BASH_COMMAND`、`TINKER_BASH_CWD_FILE` 和
`TINKER_LIVE_K3_IMAGE`。它们不得进入 README 公共配置表或 doctor 的普通配置摘要，也
不得因为本阶段而获得兼容承诺。

README 中现有但代码从未支持的变量直接删除，不增加 deprecated alias。session、event、
observation 和 prompt history 继续位于 workspace 的 `.tinker/` 固定结构；MCP 配置继续是
workspace 根的 `.mcp.json`，project slash commands 继续是 `.tinker.json`。

### 6.3 Model profile JSON

顶层合同保持：

```json
{
  "default": "profile-name",
  "profiles": {
    "profile-name": {}
  }
}
```

每个 profile 的字段合同为：

| 字段 | 必填 | 默认值/约束 |
| --- | --- | --- |
| `model` | 是 | 非空字符串 |
| `apiBase` | 是 | 非空字符串 |
| `apiKey` | 是 | 非空字符串，secret |
| `contextWindowTokens` | 是 | 正整数 |
| `maxSupportedOutputTokens` | 是 | 正整数且不大于 context window |
| `includeReasoningContent` | 否 | `false`，必须是 JSON boolean |
| `stream` | 否 | `true`，必须是 JSON boolean |
| `inputModalities` | 否 | 默认 `["text"]`；只允许规范化后的 text 或 text+image |
| `tokenEstimator` | 条件必填 | profile 声明 image 时必填 |

`tokenEstimator` 当前只接受：

```json
{
  "kind": "moonshot-estimate-token-count-v1",
  "model": "kimi-k3",
  "apiBase": "https://api.example/v1",
  "apiKey": "secret",
  "timeoutMs": 30000,
  "maxRetries": 0
}
```

其中 `model`、`apiBase`、`apiKey` 必须为非空字符串，`timeoutMs` 必须在 1000 至 60000
之间，`maxRetries` 必须精确为 `0`。顶层、profile 和 estimator 的未知字段继续 fast-fail。
本文不把 estimator 写成 provider 资格承诺；它只是当前图片 profile 的配置合同。

### 6.4 README 同步机制

新增 `scripts/check-public-contract-docs.ts` 和 `bun run docs:check`：

- 检查 README 的 CLI 命令表、公共环境变量表、profile 字段表与代码声明一致；
- 检查 README 的内置 slash command 名称和顺序与 `SLASH_COMMANDS` 一致；
- 不通过脆弱的全文关键字搜索推断一致性；为受控表格使用明确 marker 或结构化 renderer；
- `bun run check` 必须包含 `bun run docs:check`，本地和 CI 使用同一门禁。

固定 prose 仍由人维护。生成/校验只覆盖适合机械同步的字段，不自动重写 README 的产品
说明。

## 7. README 收口内容

README 至少完成以下修改：

1. **Quick Start**：npm 安装后使用 `tinker`；源码开发才使用 `bun run tinker`。源码 Bun
   必须不低于 `package.json` 的 `dependencies.bun` 基线，而不是要求与其精确相等。补充
   `tinker --help`、`tinker doctor`。
2. **Commands**：区分发布给用户的 CLI 与仓库开发 scripts，不再把二者混成同一命令面。
3. **Configuration**：使用第 6 节的真实字段、模式、默认值和路径解析规则；明确 secret
   会发送给对应外部服务但 doctor 不打印。
4. **Profiles**：分别提供最小 text profile 和 image profile 示例；同时展示 TUI 的顶层
   `--profile` 与 one-shot 的 `run --profile`；示例 secret 使用明显 placeholder，不提供真实
   key。
5. **Image Input**：说明只在声明 image 的 profile 中启用；通过 TUI `@` 选择 workspace
   内且未被搜索规则排除的文件；格式、动画、数量/尺寸限制可链接
   `multimodal-image-input-design.md`，README 保留用户必须知道的最小约束。
6. **Slash Commands**：以实现顺序列全 `/status`、`/skills`、`/mcp`、`/compact`、
   `/clear`、`/fork`、`/view`、`/copy`、`/model`、`/resume`、`/session`、`/quit`。
7. **Provider 表述**：阶段一只写“使用 OpenAI-compatible Chat Completions transport；实际
   provider 支持范围以资格矩阵为准”。在阶段二矩阵落地前，不声称 any provider 或默认
   DeepSeek。
8. **Persistence**：删除不存在的 session/event path overrides，说明 `.tinker` 是
   workspace-local private runtime data。
9. **Quality Gate**：准确写明 `bun run check` 还包含 benchmark smoke 和 docs contract
   check。

README 不复制设计文档中的内部协议细节，也不把尚未实现的 roadmap 能力写成现有功能。

## 8. 依赖安全与维护合同

### 8.1 审计处理顺序

实施时对每条 advisory 按以下顺序处理：

1. 运行 `bun audit`，记录 advisory、严重度、受影响版本和所有依赖路径。
2. 优先升级直接依赖到兼容版本，让正常 resolver 选择已修复的 transitive dependency。
3. 若直接依赖尚未发布修复，再评估最小 `overrides`；只有 upstream 声明兼容且完整质量门禁
   通过时才允许使用。
4. 不通过修改 audit 命令、忽略 exit code 或全局 suppress 来获得绿色结果。

完成门槛：`critical` 和 `high` 必须为零。`moderate` 默认也应清零；仅在没有修复版本、
受影响代码路径对 Tinker 确认不可达且有明确复查日期时允许临时例外。

### 8.2 未解决 advisory 记录

如确需例外，新增 `docs/dependency-security.md`，每条必须记录：

- advisory ID、严重度、受影响 package/version 和完整依赖路径；
- runtime、development 或发布包可达性；
- Tinker 是否调用受影响 API，以及证据文件/测试；
- 采用升级、override、不可达接受或等待 upstream 的决定；
- owner、记录日期、最迟复查日期和移除条件。

“transitive dependency” 或“只在开发环境”本身不是接受理由。advisory 一旦消失，应删除
例外条目，而不是永久保留历史 suppress。

### 8.3 CI 门禁

新增 package script `security:audit` 并由 `bun run check` 调用。若 Bun audit 不能表达经过
批准的单条临时例外，使用仓库内的小型 wrapper 精确匹配 advisory ID 和到期日期；禁止
宽泛忽略某个 severity。

阶段一落地 PR 必须附上修复前后 `bun audit` 摘要。发布 guide 的 completion checklist
增加安全审计项。

### 8.4 Dependabot

将根更新项从：

```yaml
package-ecosystem: npm
```

改为：

```yaml
package-ecosystem: bun
```

继续保留 runtime/development 分组和 GitHub Actions 更新项。验收不能只检查 YAML 语法，
必须观察或手动触发一条真实依赖更新 PR，并确认：

- `package.json` 与文本 `bun.lock` 同时更新；
- PR 中没有新增 `package-lock.json`、`yarn.lock` 或 `pnpm-lock.yaml`；
- `bun install --frozen-lockfile` 通过；
- 完整 CI 与 security audit 通过。

如果 GitHub 实际执行结果与官方 Bun 支持不一致，先保留失败证据并阻止合并，再调整
Dependabot 配置；不要增加一个会向任意 Dependabot PR 推送代码的高权限 workflow。

## 9. 发布包与跨平台验证

### 9.1 扩展 `release:verify`

`scripts/verify-release-package.ts` 继续以真实 `npm pack` 结果为唯一被测制品，并新增：

1. 从 tarball 安装到新的临时 prefix，HOME 和 workspace 也使用新目录。
2. PATH 只保留测试所需 Node 和基础系统路径，不暴露 system Bun 或 system ripgrep。
3. 执行独立
   [`CLI 技术方案`](product-hardening-phase-one-cli-design.md#124-入口进程与发布包)
   定义的 help、version、argument/stdin/file、doctor 和 usage-error smoke。
4. 验证安装包只有 `tinker` 一个 bin，且所需源文件、license、patch 和 bundled
   dependencies 均存在，禁止路径规则继续成立。

脚本使用 `try/finally` 清理临时目录；失败信息必须包含被测命令、exit code 和经过脱敏的
stdout/stderr，便于 CI 诊断。

### 9.2 CI 结构

在 `.github/workflows/ci.yml` 增加独立 `package-smoke` matrix：

```text
ubuntu-latest -> frozen install -> release:verify
macos-latest  -> frozen install -> release:verify
```

它与源码 `check` 分开命名，使失败能区分“代码质量门禁”和“发布包装/平台门禁”。发布前
`main` 的两套平台 job 都必须绿色。

publish workflow 继续在被 tag 的 Ubuntu source 上重新执行 `check` 和
`release:verify`，不能因为主分支曾经通过而删除发布时复验。macOS tarball smoke 由 tag
所指 commit 在进入 tag 前的 main CI 证明；release guide 必须明确这一证据链。

### 9.3 干净环境定义

测试环境必须满足：

- 新的 install prefix、HOME、workspace；
- 清除全部公共 `TINKER_*` 和 `EXA_API_KEY`，再按具体 case 注入最小值；
- 不从仓库 `node_modules/.bin`、全局 Bun 或全局 `rg` 取 executable；
- 不复用已有 `.tinker`、`.mcp.json`、`.tinker.json` 或 model profile 文件；
- 不访问真实 provider。

只在开发 checkout 中运行 `bun src/cli/index.ts` 不属于发布包验证。

## 10. 实施拆分与顺序

阶段内按以下顺序落地。每一步都保持可测试，不把所有变化堆到最后一次联调。

### P1.1 冻结公共声明

- 建立 `public-config-contract.ts`；
- 把现有 env/profile parser 迁移到声明源；
- 把 model/profile config resolution 上移到 CLI composition root，让 TUI/one-shot runner
  接收 resolved config；
- 把 tool env 解析上移到 CLI composition root；
- 统一无效值 fast-fail；
- 扩展 config/model-profile 测试。

完成信号：旧 parser 测试保持通过，新增字段清单/默认值/cross-field 测试通过；生产 tool
模块不再自行解释公共 env，TUI/one-shot runner 不再自行加载 model profiles 或重复解析
runner config。

### P1.2 CLI 与 doctor

- 硬前置：P1.1 必须已经把 config resolution 上移到 CLI composition root，并让
  TUI/one-shot runner 接收 resolved config；禁止在 CLI 与 runner 各解析一次；
- 完整实施
  [`product-hardening-phase-one-cli-design.md`](product-hardening-phase-one-cli-design.md)；
- 不在本方案中另行解释 Prompt source、Commander 或 doctor 细节。

完成信号：独立 CLI 方案的完成定义全部满足。

### P1.3 README 契约同步

- 修正 README 五类已知漂移；
- 增加结构化 docs checker；
- 将 `docs:check` 纳入总门禁。

完成信号：任意删除/改名公共字段或 slash command 而不更新 README 时，测试必然失败。

### P1.4 依赖与 Dependabot

- 修复当前 audit；
- 必要时写有期限的精确例外；
- 将 Dependabot 切到 Bun ecosystem；
- 将 security audit 纳入门禁。

完成信号：没有未记录 advisory，真实 Bun Dependabot PR 同步 lockfile 并通过 frozen CI。

### P1.5 发布包 matrix

- 扩展 `release:verify`；
- 新增 macOS/Linux package-smoke jobs；
- 更新 `docs/releasing.md` 的门禁和 checklist。

完成信号：同一 commit 在两个平台均从真实 tarball 的干净 prefix 通过 smoke。

### P1.6 总验收与路线图回填

- 完整运行第 11 节验证；
- 在本文件“实施结果”记录 commit、CI run 和 audit 结果；
- 更新上位 roadmap，把阶段一标记完成并链接本文；
- 更新 CHANGELOG 的用户可见变化。

在 P1.6 以前，roadmap 不得写“阶段一已完成”。

## 11. 验证矩阵

### 11.1 本地确定性门禁

```bash
bun install --frozen-lockfile
bun run check
bun run release:verify
git diff --check
```

`bun run check` 最终必须包含 typecheck、format check、lint、全部测试、benchmark smoke、
docs contract check 和 security audit。命令应完整等待结束，不能只看到 typecheck 通过就
报告成功。

### 11.2 CLI matrix

执行独立
[`CLI 技术方案的测试方案`](product-hardening-phase-one-cli-design.md#12-测试方案)，包括
Commander parser、三种 Prompt source、doctor、进程入口和真实发布包。本文不复制该
matrix。

### 11.3 配置 matrix

- env mode 的必填、默认、boolean aliases、正整数边界和 context/output 关系；
- profile mode 优先级、default 选择、TUI 顶层 `--profile`、one-shot `run --profile`、
  未知/重复/缺字段；
- text 与 image profile，完整/不完整 estimator，未知 modality；
- 所有公共 tooling env 的默认、合法和非法值；
- README 自动校验对字段名、默认值、secret 标记和 slash command 漂移敏感。

### 11.4 包与平台 matrix

| 平台 | tarball | clean prefix | bundled Bun | bundled rg | CLI/doctor |
| --- | --- | --- | --- | --- | --- |
| `ubuntu-latest` | 必须 | 必须 | 必须 | 必须 | 必须 |
| `macos-latest` | 必须 | 必须 | 必须 | 必须 | 必须 |

### 11.5 安全 matrix

- `bun audit` 没有 critical/high；moderate 为零或存在未过期的精确记录；
- runtime 与 dev dependency 路径都纳入判断；
- Dependabot Bun PR 同步 `bun.lock`；
- frozen install、完整 check、package smoke 都在更新 PR 上通过。

## 12. 文件级改动指引

预期主要触点如下，实施中可以按职责微调文件名，但不得把所有逻辑塞进 `index.ts`：

| 文件 | 责任 |
| --- | --- |
| `src/cli/public-config-contract.ts` | 公共 env/profile 声明、共享 primitive parser metadata |
| `src/cli/config.ts` | 从共享合同构造完整 RunnerConfig，不再散落默认值 |
| `src/cli/model-profiles.ts` | profile JSON 与 cross-field 校验，复用共享 keys/defaults |
| [`CLI 方案涉及的 src/cli 文件`](product-hardening-phase-one-cli-design.md#11-模块拆分) | Commander、Prompt source、package metadata、doctor 与入口 dispatch |
| `src/cli/tui-runner.tsx`、`run-runner.ts` | 接收已解析配置，不改变 runtime ownership |
| `src/tools/*`、`src/mcp/*` | 接收 composition root 传入的公共 tool config |
| `scripts/check-public-contract-docs.ts` | 机械检查 README 公共表面 |
| `scripts/verify-release-package.ts` | 真实 tarball 的扩展 smoke |
| [`CLI 方案涉及的测试`](product-hardening-phase-one-cli-design.md#12-测试方案) | parser、Prompt source、doctor、入口与 tarball smoke |
| `src/__tests__/config.test.ts` | env/tooling 统一 parser |
| `src/__tests__/model-profiles.test.ts` | profile/schema 合同 |
| `README.md` | 当前用户合同 |
| `.github/dependabot.yml` | Bun 生态更新 |
| `.github/workflows/ci.yml` | 双平台 package smoke |
| `package.json`、`bun.lock` | scripts、审计修复和锁定结果 |
| `docs/releasing.md` | 发布前双平台证据与安全门禁 |

本阶段不应修改 `src/agent`、`src/context`、`src/session` 的语义。若实现发现必须改变这些
层，先停下并修订本文边界，不能以“配置重构”为名顺便改变 canonical runtime。

## 13. 完成定义

只有以下项目全部满足，阶段一才可标记完成：

- [ ] 独立 CLI 技术方案的完成定义全部满足。
- [ ] 公共 env/profile 字段有单一声明源，tooling 不再散落解释公共 env。
- [ ] README 命令、配置、profile、图片和 slash commands 与实现一致。
- [ ] docs contract check 已进入 `bun run check`。
- [ ] 当前 audit 已修复或存在合规、未过期的精确例外；无 critical/high。
- [ ] Dependabot 使用 Bun ecosystem，并以真实 PR 证明同步文本 `bun.lock`。
- [ ] macOS、Linux 都从真实 npm tarball 的干净 prefix 通过 package smoke。
- [ ] `bun run check`、`bun run release:verify`、`git diff --check` 完整通过。
- [ ] `docs/releasing.md`、CHANGELOG 和上位 roadmap 已回填。

## 14. 实施结果

待 P1.6 回填：

- 完成 commit：待定。
- CI run：待定。
- `bun audit`：待定。
- macOS package smoke：待定。
- Linux package smoke：待定。
- Dependabot Bun lockfile PR：待定。
