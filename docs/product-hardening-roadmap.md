# Product Hardening Roadmap

## 文档状态

- 日期：2026-07-23
- 基线：Tinker v1.3.0
- 性质：下一阶段实施路线图，不替代各阶段技术设计
- 目标：把已经落地的运行时能力收敛成容易配置、可验证兼容、可稳定交付的产品能力

本路线图不规划 permission、approval、sandbox 或 workspace trust 系统，也不默认启动
structured checkpoint、跨 session 记忆、多 agent 或云同步。

## 阶段一：公共契约与发布收口

独立实施方案：[`product-hardening-phase-one-design.md`](product-hardening-phase-one-design.md)。

### 目标

让 npm 安装后的入口、配置说明和实际运行契约保持一致，并修复当前依赖维护与安全审计
链路中的明确缺口。

### 验收重点

- 提供可从发布包直接运行的 `tinker --help` 和 `tinker --version`。
- README 中的命令、环境变量、模型 profile、图片输入和 slash commands 与当前代码一致。
- 配置文档与配置 parser 共享可校验的字段契约，避免再次漂移。
- 处理当前依赖审计结果；无法立即消除的 advisory 必须记录影响范围和处理决定。
- Dependabot 更新能够同步提交 Bun lockfile，并通过 frozen install 和完整 CI。
- 在干净的 macOS、Linux 安装前缀中验证 npm tarball、内置 Bun、ripgrep 和启动入口。

## 阶段二：Provider 资格矩阵

### 目标

把宽泛的 OpenAI-compatible 兼容表述收紧为经过真实运行验证的能力矩阵，并让不同模型的
能力边界、配置要求和失败方式清晰可见。

### 验收重点

- 为实际支持的 provider/profile 标明 tested、best-effort 或 unsupported 状态。
- 文本、tool call、stream、usage、取消和 reasoning-only 恢复均有真实 provider smoke。
- 图片 profile 额外验证图片请求、token estimator、预算预检和 tool iteration 重放。
- profile 明确声明输入模态和必要能力；缺失配置在 session 创建前 fast-fail。
- 真实验证不记录凭据、完整请求正文或 provider 原始敏感响应。

## 阶段三：TUI 增量输出

### 目标

把已经默认启用的流式传输转换成用户可见的增量反馈，同时保持 canonical history、事件和
resume 语义不变。

### 验收重点

- 文本和 reasoning delta 只进入临时 presentation state，完整响应通过校验后才写入 canonical history。
- 未完整组装的 tool call 不进入执行链，参数和 provider tool-call ID 继续严格校验。
- 取消、provider 失败或 TUI 退出不会留下半截 assistant message，也不会在恢复后重复内容。
- 完成态继续使用当前 timeline renderer；`/resume` 只重建最终 canonical 内容。
- 通过组件测试、真实 PTY 和资格矩阵内 provider 的流式 smoke。

## 阶段四：Chrome 一阶段交付

### 目标

把已经完成真实 Chrome 验收的一阶段原型变成可独立安装、诊断、升级和卸载的交付单元，
暂不扩大浏览器工具能力。

### 验收重点

- `tinker-chrome` 具备独立的包、版本、CLI 入口和发布流程。
- 安装、诊断、升级和卸载覆盖扩展、Native Host manifest、runtime registry 与本地配置。
- Tinker、MCP、Native Host 和扩展之间的版本不兼容会明确 fast-fail。
- 安装文档直接说明 Chrome 扩展能力、可读取的数据范围和本地组件边界。
- 在干净 macOS 环境完成安装、打开页面、读取摘要、断线重连和卸载 smoke。
- Chrome 未启动、扩展未安装或 bridge 离线时，MCP 仍能初始化并返回稳定错误。

## 阶段五：浏览器交互

### 目标

在 Chrome 一阶段交付稳定后，为扩展自己打开的页面增加确定性的页面快照和元素操作，
形成可用于常见网页任务的最小交互闭环。

### 验收重点

- 页面快照返回有界内容和稳定元素引用，不向模型暴露完整 DOM 或任意 JavaScript 执行。
- 第一批操作覆盖 click、type、press、select 和 scroll，并继续限制在扩展拥有的页面。
- 页面导航、刷新和 DOM 变化会使过期引用明确失效，不静默操作错误元素。
- 每次操作区分 `not_started`、`performed` 和 `unknown`，断线或超时不伪造成功。
- 操作结果经过有界 observation 返回 Tinker，不改变 agent loop 或 MCP 的现有所有权。
- 通过协议测试、扩展集成测试和真实 Chrome 端到端任务验证。

## 实施顺序与统一门禁

阶段一是其余阶段的公共前置。阶段二完成后再实施阶段三，以资格矩阵约束增量流的真实
provider 行为。阶段四可以在阶段二、三之外独立推进；阶段五必须等待阶段四完成。

每个阶段都遵循以下门禁：

1. 先写或更新独立技术设计，冻结外部行为、所有权和失败语义。
2. `bun run check` 必须完整通过。
3. 涉及 TUI、provider 或 Chrome 的阶段必须完成对应的真实运行验证。
4. 完成后更新本文档的状态和实测结果，再进入后续阶段。
