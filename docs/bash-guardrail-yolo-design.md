# Bash 安全护栏与 /yolo 开关设计方案

## 文档状态

- 日期：2026-07-30
- 状态：已实施
- 范围：Bash 工具危险命令拦截、TUI 确认交互、one-shot 拒绝策略、`TINKER_YOLO` 环境变量、
  `--yolo` CLI flag、`/yolo` slash command

## 一、结论

Tinker 增加一条 Bash 安全护栏：执行前对命令做确定性分类，命中高置信度毁灭性模式时——

- **TUI**：暂停执行，向用户展示命令与命中原因，等待允许或拒绝；
- **one-shot（非交互）**：直接拒绝，tool result 携带重试提示。

护栏**默认生效**。放行必须显式声明，优先级从高到低：

```text
one-shot --yolo flag  >  TINKER_YOLO 环境变量  >  默认值 off（护栏生效）
```

TUI 会话内可用 `/yolo on|off` 临时切换，起始值取自上述解析结果，不持久化。

统一语义一句话：**能问就问（TUI），不能问就拒（one-shot），想放行必须显式声明。**

## 二、目标

1. 拦截确定性、高置信度的毁灭性 Bash 命令，宁漏勿冤。
2. 危险命令在 TUI 中需用户显式确认后才执行；拒绝结果回传给模型而非中断 turn。
3. one-shot 无法交互时 fail-closed，并提供 `--yolo` 显式放行。
4. `TINKER_YOLO` 环境变量提供进程级默认值，默认 off。
5. 确认请求与裁决写入 runtime 事件与诊断日志；拒绝结果同时进入 canonical tool result。

## 三、非目标

- 不做沙箱、权限系统或命令改写，只拦截极少数确定性模式。
- 不解析 shell 变量展开、子 shell、脚本文件内容；无法确定性判断的一律放行。
- 不拦截 `git reset --hard`、`git clean -fd` 等开发常用但有破坏性的命令（误报成本高）。
- 不做"总是允许此命令"的记忆机制（后续可单独评估）。
- 不持久化 `/yolo` 会话状态；新 session 回到配置默认值。
- 不新增 `.env` 文件加载器；`TINKER_YOLO` 沿用现有 process.env 配置通道
  （Bun 自动加载 cwd 的 `.env`，见 5.1）。

## 四、危险识别

新增纯函数模块 `src/tools/bash-guard.ts`：

```ts
export type BashRisk =
  | { readonly dangerous: false }
  | { readonly dangerous: true; readonly reason: string };

export function classifyBashRisk(command: string): BashRisk;
```

v1 拦截清单（每条都是在 agent 编码会话中几乎不存在合法用途的模式）：

| 类别 | 模式 |
| --- | --- |
| 毁灭性删除 | `rm -rf` / `rm -fr` 指向 `/`、`/*`、`~`、`$HOME`、workspace 根目录 |
| 写块设备 | `dd of=/dev/...`、`mkfs.*`、`wipefs` |
| fork 炸弹 | `:(){ :|:& };:` 及其空白变体 |
| 系统电源 | `shutdown`、`reboot`、`halt`、`poweroff` |
| 递归改根权限 | `chmod -R` / `chown -R` 作用于 `/` |

原则：

- **宁漏勿冤**。匹配不到即放行，护栏不是安全边界，文档与 `--help` 明确说明。
- 分类器是纯函数，不读文件系统、不展开变量，只做词法级模式匹配。
- `run_in_background: true` 的命令同样过分类器，后台执行不能绕过护栏。
- 命中时 `reason` 用一句话说明命中的规则，用于确认 UI、拒绝 observation 和事件日志。

## 五、配置解析

### 5.1 `TINKER_YOLO` 环境变量

在 `PUBLIC_CONFIG_FIELDS` 增加字段：

- `valueKind: "boolean"`（沿用现有 `true/false, 1/0, yes/no, on/off` 解析器）；
- `requiredIn: "never"`，`appliesIn: "always"`，`defaultValue: false`；
- `section: "tooling"`；非法值在启动期 fast-fail。

不设置、设为空、设为 `false/off/no/0` 均为护栏生效；仅显式 `true/on/yes/1` 放行。

由于 CLI 实际运行在 Bun 上，Bun 会自动加载 cwd 下的 `.env` 文件进 `process.env`，
因此在项目根目录 `.env` 中写 `TINKER_YOLO=on` 即可生效，无需新增加载器；
shell export 与 `.env` 文件两种来源走同一解析路径，语义一致。

### 5.2 `--yolo` CLI flag

- 仅挂在 `tinker run`（one-shot）命令上，声明进 `public-cli-contract.ts`，
  `--help` 文案注明"跳过危险命令确认，自行承担风险"。
- 是布尔 flag，只存在"显式给出"与"未给出"两态；给出即覆盖 `TINKER_YOLO=false`。
- TUI 不提供启动 flag；会话内用 `/yolo` 切换。

### 5.3 解析结果

配置层产出 `bashGuardMode: "guard" | "yolo"`，随 `RunnerConfig` / tooling 配置传入
runtime。优先级：one-shot `--yolo` > `TINKER_YOLO` > 默认 `guard`。

## 六、确认通道

### 6.1 执行上下文扩展

```ts
// src/tools/types.ts
export type ToolExecutionContext = {
  signal: AbortSignal;
  confirmBashCommand?: (request: {
    command: string;
    reason: string;
  }) => Promise<"allow" | "deny">;
};
```

- Bash executor 在 spawn 前调用 `classifyBashRisk`；未命中 → 直接执行。
- 命中且 `confirmBashCommand` 存在 → await 裁决；`allow` 继续执行，`deny` 返回
  拒绝结果的 raw result。
- 命中且 `confirmBashCommand` 缺席（one-shot 或 yolo 未开启的非交互路径）→
  按注入策略直接拒绝或直接执行，二选一由组合根决定，executor 内部不做隐式判断。

### 6.2 拒绝语义

拒绝不是异常。返回 failed tool result，observation 写明：

```text
Command denied: <reason>. The user declined this command.（TUI）
Command denied: <reason>. Non-interactive mode cannot confirm; rerun with --yolo.（one-shot）
```

模型收到拒绝后自行调整策略，turn 不中断、不进入失败恢复路径。

### 6.3 取消语义

turn 取消（Esc / AbortSignal）时，pending 的确认 Promise 一并 reject 为取消，
不产生裁决事件之外的副作用。

### 6.4 审计事件

新增两个 runtime event，写入 `events.jsonl`、observation log 与 presentation sink：

- `tool.confirmation.requested`：command、reason、tool call id；
- `tool.confirmation.resolved`：decision（`allow` / `deny` / `cancelled`）、耗时。

yolo 模式或 one-shot 策略性拒绝同样发 `tool.confirmation.resolved`
（decision 分别为 `allow` 由策略旁路 / `deny` 由策略决定），保证审计链完整。
TUI projection 把这两个事件渲染进时间线。

这里沿用仓库现有持久化边界：SQLite 保存 canonical conversation/tool result 与
`next_event_sequence`，不新增通用 event 表；`events.jsonl` 是完整审计流。用户拒绝还会以
failed Bash raw result 进入 SQLite，允许/yolo 裁决则从 `events.jsonl` 追溯。

## 七、TUI 行为

### 7.1 确认交互

- 确认请求到达时，状态行区域切换为确认面板：显示完整命令、命中原因，
  提示 `y 允许 / n 拒绝 / Esc 取消 turn`。
- 确认期间锁定普通输入与 slash 补全；只允许裁决按键。
- 裁决后面板消失，时间线追加一条裁决记录（允许/拒绝及原因）。

### 7.2 `/yolo` slash command

- `/yolo on`：本会话不再确认，危险命令直接执行；
- `/yolo off`：恢复护栏确认；
- `/yolo` 无参：在本地展示当前模式与来源（默认/`TINKER_YOLO`/会话内切换），
  不运行 agent；
- 解析落点 `src/tui/slash-commands.ts`，新增 `{ type: "yolo", enabled: boolean }`
  与 `{ type: "yolo_status" }`；
- 状态行在 yolo 开启时显示 `yolo` 标记，提醒用户当前处于免责模式。

### 7.3 会话状态

模式保存在 `RuntimeSession` 内存状态，随 `session.finished` 消亡；`/status`
展示当前模式。resume 的 session 按配置默认值重新开始，不继承退出前的 `/yolo` 状态。

## 八、One-shot 行为

- 默认（无 `--yolo`、`TINKER_YOLO` 未开启）：命中危险命令 → 策略性拒绝，
  observation 提示 `rerun with --yolo`，turn 继续；
- `--yolo` 或 `TINKER_YOLO=on`：命中也直接执行，仅写审计事件；
- 未命中命令的行为在任何配置下与现状完全一致。

## 九、代码落点

| 文件 | 变更 |
| --- | --- |
| `src/tools/bash-guard.ts` | 新增：纯函数分类器 |
| `src/tools/types.ts` | `ToolExecutionContext` 增加 `confirmBashCommand` |
| `src/tools/bash.ts` | spawn 前接分类器与确认回调 |
| `src/tools/registry.ts` | `createDefaultTooling` 贯通确认/策略选项 |
| `src/agent/runtime-session.ts` | 会话级 yolo 状态、确认桥接、`setYoloMode` API |
| `src/events/types.ts` | `tool.confirmation.requested` / `tool.confirmation.resolved` |
| `src/cli/public-config-contract.ts` | `TINKER_YOLO` 字段 |
| `src/cli/public-cli-contract.ts` / `command-line.ts` | `run --yolo` flag |
| `src/cli/config.ts` / `main.ts` / `run-runner.ts` | 优先级解析与策略注入 |
| `src/tui/slash-commands.ts` / `app.tsx` / 确认组件 | `/yolo` 与确认面板 |
| `src/tui/event-store.ts` / projection | 裁决事件的时间线渲染与状态行 `yolo` 标记 |
| `docs/`（public contract 渲染产物） | `docs:check` 同步更新 |

## 十、测试计划

### 10.1 分类器单元测试（`bash-guard`）

- 每条 v1 规则的命中变体（空格、`sudo` 前缀、不同引号）；
- 误报面：`rm -rf ./node_modules`、`rm -rf /tmp/xxx`（非根绝对路径）、
  `dd if=... of=./disk.img`、`shutdown` 出现在参数文本中（如 `echo shutdown`）均放行；
- 空命令、纯空白命令放行。

### 10.2 Executor 测试（`bash`）

- 命中 + 回调 allow → 正常执行；
- 命中 + 回调 deny → failed result 含拒绝文案，进程未 spawn；
- 命中 + 无回调 → 按注入策略拒绝或执行；
- 未命中 → 不触发回调；
- 确认 pending 时取消 signal → 确认 reject，进程未 spawn；
- `run_in_background` 命中同样被拦截。

### 10.3 CLI 与配置测试

- `TINKER_YOLO` 各布尔写法与非法值 fast-fail；
- `--yolo` 覆盖 `TINKER_YOLO=false`；
- one-shot 默认拒绝文案含 `--yolo` 提示；
- public contract 文档渲染（`docs:check`）。

### 10.4 TUI 组件测试

- `/yolo` 三种形式的解析与展示；
- 确认面板渲染命令与原因，`y`/`n` 裁决后消失；
- 确认期间普通输入被锁定；
- yolo 开启时状态行出现标记；
- 裁决事件写入时间线。

### 10.5 门禁

实现期间：`bun test src/__tests__/bash-guard.test.ts src/__tests__/tools.test.ts`
（及新增测试文件）。完成后：`bun run check`。

## 十一、手工验收

1. 默认启动 TUI，让 agent 执行 `rm -rf ~`，确认面板出现；`n` 后模型收到拒绝并改策略。
2. `/yolo on` 后再次执行，直接运行且状态行显示 `yolo`；`/yolo off` 恢复确认。
3. `TINKER_YOLO=off` 启动，行为与默认一致；`TINKER_YOLO=on` 启动，不弹确认。
4. one-shot 传入会触发 `rm -rf /` 的 prompt，命令被拒绝且提示 `--yolo`；
   加 `--yolo` 后同一 prompt 直接执行。
5. 让 agent 执行 `rm -rf ./node_modules`，任何模式下都不触发确认。
6. 确认面板 pending 时按 Esc，命令未执行，turn 正常取消。
7. 查看 `events.jsonl`，确认请求与裁决事件成对出现。

## 十二、完成条件

- 护栏默认生效，仅高置信度毁灭性模式触发确认。
- TUI 确认、one-shot 拒绝、`--yolo`/`TINKER_YOLO`/`/yolo` 三层放行语义一致。
- 拒绝以 tool result 回传模型，不中断 turn。
- 确认请求与裁决事件可审计。
- `bun run check` 全部通过。
