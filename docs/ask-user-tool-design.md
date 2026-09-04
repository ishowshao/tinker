# AskUser 工具设计方案

## 文档状态

- 状态：待实施
- 范围：`AskUser` 内置工具、Runtime 等待与恢复、TUI 单选交互、工具结果与事件记录
- 相关实现：`src/tools/types.ts`、`src/tools/registry.ts`、
  `src/agent/runtime-session.ts`、`src/agent/loop.ts`、`src/events/types.ts`、
  `src/observation/observation-builder.ts`、`src/tui/app.tsx`、
  `src/tui/tui-session-controller.ts`

## 一、结论

Tinker 增加内置工具 `AskUser`。当模型完成任务所需的信息存在关键歧义，且无法从当前对话或工作区中确定答案时，模型可以给出一个问题和 2～6 个选项，请用户单选。

固定交互流程如下：

```text
模型调用 AskUser
  → 工具执行暂停并等待用户
  → TUI 展示问题和选项
  → 用户选择一项，或按 Esc 不作选择
  → 工具结果进入 canonical history
  → 模型在下一次 iteration 中继续当前 turn
```

用户选择后，所选选项的 `description` 作为工具观察的主体内容返回给模型。用户按下 `Esc` 时不取消 turn，而是向模型返回“用户没有做出选择”的结果，由模型自行判断如何继续。

第一版只支持：

- 单个问题；
- 单选；
- 2～6 个选项；
- 每个选项只有 `description` 这一项必要语义；
- TUI 交互。

## 二、目标

1. 让模型在关键需求不清晰时通过结构化选项向用户提问。
2. 用户无需输入文本，只需选择一个选项或跳过选择。
3. 用户答复作为当前 tool call 的正常 completion 返回，不创建新的 user turn。
4. 等待用户期间保持当前 turn 和工具协议完整。
5. 用户按 `Esc` 只 dismiss 当前问题，不取消正在执行的 turn。
6. turn 真正取消、session dispose 或运行失败时，可靠清理 pending 问题。
7. 问题请求、选择结果和 dismiss 结果可通过 runtime 事件审计。

## 三、非目标

第一版不支持：

- 自由文本回答；
- 多选；
- 一次调用提出多个问题；
- “其他，请输入”选项；
- 默认答案或超时自动选择；
- one-shot CLI 中读取 stdin；
- 将回答保存为独立 user message；
- 将 `AskUser` 用作危险命令授权或其他安全确认机制。

危险 Bash 命令仍由 Bash guard 处理，不能使用 `AskUser` 绕过。

## 四、公开工具契约

### 4.1 工具定义

工具名称为：

```text
AskUser
```

建议描述：

```text
Ask the user one multiple-choice question when a material ambiguity prevents
correct progress. Investigate the conversation and workspace first. Provide
2-6 options, each as a complete answer the user can select. The user may select
one option or dismiss the question. If dismissed, use your own judgment and do
not immediately repeat the same question. Call AskUser alone, without other
tool calls in the same response.
```

调用原则：

- 先调查已有对话、代码和配置，再决定是否提问；
- 只有会实质影响实现结果的歧义才应提问；
- 每个选项应写成模型收到后可以直接理解的完整答案；
- 用户 dismiss 后，模型不应立即原样重复同一个问题。

### 4.2 参数 Schema

```ts
{
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "The question shown to the user."
    },
    options: {
      type: "array",
      minItems: 2,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "An answer the user can select."
          }
        },
        required: ["description"]
      }
    }
  },
  required: ["question", "options"]
}
```

Schema 不声明 `additionalProperties: false`。工具不要求模型生成选项 ID 或独立 label，也不对 description 做去重、trim 后长度限制等额外约束。

Executor 只执行保证运行安全所需的结构校验：

- 参数是对象；
- `question` 是字符串；
- `options` 是数组，且数量为 2～6；
- 每个 option 是对象并包含字符串类型的 `description`。

额外字段不影响执行，可以忽略。

### 4.3 参数示例

```json
{
  "question": "你希望配置应用到什么范围？",
  "options": [
    {
      "description": "仅应用到当前项目"
    },
    {
      "description": "应用到当前用户的所有项目"
    }
  ]
}
```

## 五、工具结果与模型观察

### 5.1 Raw result

在 `src/tools/types.ts` 增加：

```ts
export type AskUserRawResult =
  | {
      ok: true;
      outcome: "selected";
      answer: string;
    }
  | {
      ok: true;
      outcome: "dismissed";
    }
  | {
      ok: false;
      error: string;
    };
```

并在 `ToolRawResultByKind` 中增加：

```ts
ask_user: AskUserRawResult;
```

`dismissed` 是有效的用户决定，因此 `ok` 为 `true`。只有参数非法、交互能力缺失或内部状态错误等真正的工具失败才返回 `ok: false`。

### 5.2 Observation

在 `ObservationBuilder` 中增加 `ask_user` 分支。

用户选择时：

```text
User selected: 仅应用到当前项目
```

用户按 `Esc` 时：

```text
The user did not select an option. Decide how to proceed.
```

工具结果不重复问题、完整选项列表或选择下标。原始问题和选项已经存在于 assistant tool call 中，所选 `description` 就是回答主体。

## 六、工具执行模型

新增 `src/tools/ask-user.ts`，提供 `createAskUserToolExecutor()`。

在 `ToolExecutionContext` 增加可选交互能力：

```ts
export type AskUserRequest = {
  readonly question: string;
  readonly options: readonly {
    readonly description: string;
  }[];
};

export type AskUserResponse =
  | {
      readonly outcome: "selected";
      readonly answer: string;
    }
  | {
      readonly outcome: "dismissed";
    };

export type ToolExecutionContext = {
  signal: AbortSignal;
  askUser?: (request: AskUserRequest) => Promise<AskUserResponse>;
  // existing capabilities...
};
```

Executor 的执行步骤：

1. 检查 `AbortSignal`；
2. 解析并执行最小结构校验；
3. 确认 `context.askUser` 存在；
4. `await context.askUser(request)`；
5. 将 response 转换为 `AskUserRawResult`。

工具 executor 不直接依赖 Ink、stdin 或 React。交互生命周期由 `RuntimeSession` 提供。

## 七、RuntimeSession 交互桥

### 7.1 对外状态

在 `RuntimeSession` 增加：

```ts
export type AskUserSnapshot = {
  readonly pending?: {
    readonly question: string;
    readonly options: readonly {
      readonly description: string;
    }[];
  };
};

askUser(): AskUserSnapshot;
subscribeAskUser(listener: () => void): () => void;
resolveAskUser(
  response:
    | { outcome: "selected"; selectedIndex: number }
    | { outcome: "dismissed" },
): Promise<void>;
```

`selectedIndex` 只是 TUI 与 Runtime 之间的内部定位方式，不进入模型观察。Runtime 校验下标后，从 pending options 中取得对应的 `description`，并 resolve 为：

```ts
{
  outcome: "selected",
  answer: selectedOption.description
}
```

### 7.2 Pending 状态

`RuntimeSession` 保存至多一个 pending 请求，包括：

- question；
- options；
- tool call identity；
- 开始时间；
- Promise 的 resolve/reject；
- AbortSignal listener 清理函数。

建立 pending 请求后刷新 immutable snapshot 并通知订阅者。用户完成选择或 dismiss 后，必须先清除 pending 状态、移除 abort listener、记录 resolved 事件，再 resolve 工具 Promise。

如果已有 pending 请求，再建立第二个请求属于内部状态错误。

### 7.3 真正取消与 dismiss 的区别

两条路径必须严格区分：

| 操作                            | 工具结果                       | Turn 状态        |
| ------------------------------- | ------------------------------ | ---------------- |
| 选择选项                        | `ok: true, outcome: selected`  | 继续             |
| AskUser 面板按 `Esc`            | `ok: true, outcome: dismissed` | 继续             |
| 取消 turn 的 AbortSignal        | Promise reject 为 cancellation | 取消             |
| session dispose / runtime fault | Promise reject 并清理          | 按原生命周期结束 |

AbortSignal 触发时不能伪造 `dismissed`。取消是 runtime 生命周期事件，不是用户对问题的回答。

## 八、Tool batch 约束

`AskUser` 是一个决策屏障，必须是 assistant 当前响应中的唯一 tool call。

允许：

```text
assistant → AskUser
```

不允许：

```text
assistant → Edit + AskUser
assistant → AskUser + Bash
assistant → AskUser + AskUser
```

原因是同一 assistant message 已经一次性声明完整 tool batch。若在其他工具之间等待用户，用户回答无法改变该 batch 中已经声明的调用，还可能在提问前产生文件或进程副作用。

`runAgent()` 应在执行 batch 中任何工具之前校验：只要 batch 包含 `AskUser`，其长度就必须为 1。违反约束时不执行该 batch 中的任何工具，并为所有已声明调用形成协议完整的失败 completion，提示模型下一次只调用 `AskUser`。不能只依赖工具描述约束模型。

## 九、事件设计

新增两个 tool-call scoped runtime event：

```ts
"tool.user_question.requested": {
  question: string;
  options: readonly { description: string }[];
};

"tool.user_question.resolved":
  | {
      outcome: "selected";
      answer: string;
      durationMs: number;
    }
  | {
      outcome: "dismissed";
      durationMs: number;
    }
  | {
      outcome: "cancelled";
      durationMs: number;
    };
```

事件用于 presentation、诊断和审计。进入 canonical model history 的回答仍然只有标准 tool completion，不能再追加一条 user message，否则会改变工具调用与工具结果的协议结构。

事件日志可以保留问题、选项和最终回答。普通 TUI timeline 是否展示完整选项由 projection policy 决定，不影响 canonical 数据。

## 十、TUI 设计

### 10.1 组件

新增：

```text
src/tui/components/ask-user.tsx
```

示例：

```text
╭─ Tinker asks ─────────────────────────────────────╮
│ 你希望配置应用到什么范围？                         │
│                                                    │
│ ❯ 仅应用到当前项目                                 │
│   应用到当前用户的所有项目                         │
│                                                    │
│ ↑/↓ 选择 · 1-2 直接选择 · Enter 确认 · Esc 跳过     │
╰────────────────────────────────────────────────────╯
```

键位：

- `↑` / `↓`：循环移动当前选项；
- `1`～`6`：直接提交对应选项；
- `Enter`：提交当前选项；
- `Esc`：dismiss 当前问题，不取消 turn。

组件不提供文本输入。

### 10.2 输入优先级

`AskUser` pending 时，选择面板独占输入区域：

- 普通 `PromptInput` 不显示或被禁用；
- slash command、历史导航、文件补全等普通输入能力不处理按键；
- Footer 显示等待用户选择的状态；
- 顶层“Esc 取消 turn”监听暂时停用；
- `AskUser` 组件负责把 `Esc` 解析为 `dismissed`。

没有 pending AskUser 时，`Esc` 保持现有的取消 turn 行为。

渲染优先级建议为：

```text
其他全屏面板
  → AskUser pending
  → Bash confirmation pending
  → model picker
  → PromptInput
```

正常运行中不应同时存在 AskUser 和 Bash confirmation；如果内部状态违反这一点，应 fast-fail，而不是让两个组件竞争键盘输入。

### 10.3 Controller 贯通

`TuiSessionBinding` 增加：

```ts
askUser(): AskUserSnapshot;
subscribeAskUser(listener: () => void): () => void;
resolveAskUser(response: AskUserResolution): Promise<void>;
```

`App` 使用 `useSyncExternalStore` 订阅 snapshot，保持与现有 Bash confirmation 相同的 React 外部状态模式。

## 十一、注册与 one-shot 行为

`createDefaultTooling()` 接受可选的 AskUser 交互能力。只有提供该能力时才注册 `AskUser` executor。

第一版：

- TUI 创建 session 时提供交互能力，因此注册 `AskUser`；
- one-shot runner 不提供交互能力，因此不注册 `AskUser`；
- one-shot 不读取 stdin，也不会因模型调用交互工具而无限等待。

这意味着 TUI 与 one-shot 的工具 surface 不同，现有 context surface 和 resume 刷新机制应按实际注册结果记录工具清单。未来如需支持 one-shot 交互，应单独设计 TTY 检测、stdin 占用和非交互 fallback，不在本方案中预留隐式行为。

## 十二、持久化与恢复

完成选择或 dismiss 后，标准 tool completion 会写入 SQLite canonical history，与其他工具结果一致。

Pending AskUser 只存在于当前进程内存中，不单独持久化。进程在等待期间退出时，该 assistant tool call 可能没有 completion；resume 继续使用现有 interrupted-frame recovery，为未完成工具调用补合成 completion。恢复后不重新弹出旧问题，避免重复等待或误把新进程中的用户输入关联到旧 Promise。

AskUser 的 raw result codec 和 session tool-result codec 必须支持 `ask_user` kind，确保已完成结果可以正常 resume、Recall 和重建 presentation。

## 十三、代码落点

| 文件                                       | 变更                                                             |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `src/tools/ask-user.ts`                    | 新增工具定义、参数解析和 executor                                |
| `src/tools/types.ts`                       | 增加 AskUser request/response/raw result 与 execution capability |
| `src/tools/registry.ts`                    | 按是否提供交互能力条件注册 `AskUser`                             |
| `src/agent/runtime-session.ts`             | pending 状态、订阅、resolve/dismiss、取消清理和事件              |
| `src/agent/loop.ts`                        | `AskUser` 独占 tool batch 校验                                   |
| `src/observation/observation-builder.ts`   | selected/dismissed observation                                   |
| `src/events/types.ts`                      | question requested/resolved 事件                                 |
| `src/events/stdout-event-printer.ts`       | 事件与 raw result 的穷尽处理                                     |
| `src/session/session-tool-result-codec.ts` | `ask_user` raw result 编解码                                     |
| `src/session/resume-projection.ts`         | 已完成 AskUser 的恢复投影                                        |
| `src/tui/components/ask-user.tsx`          | 单选交互组件                                                     |
| `src/tui/app.tsx`                          | snapshot 订阅、渲染优先级和 Esc 路由                             |
| `src/tui/tui-session-controller.ts`        | AskUser Runtime API 贯通到 binding                               |
| `src/tui/event-store.ts` / projection      | 请求与结果的 timeline 表示                                       |
| `src/cli/tui-runner.tsx`                   | 为 TUI session 启用 AskUser 能力                                 |

实际实施时还需更新所有对 `ToolRawResult` 和 `AgentEvent` 做穷尽匹配的位置。

## 十四、测试计划

### 14.1 工具单元测试

- 合法的 2 项和 6 项参数进入交互回调；
- options 少于 2 项或多于 6 项时返回失败；
- question、options 或 description 类型错误时返回失败；
- option 中存在额外字段时仍可执行；
- selected response 返回对应 description；
- dismissed response 返回成功的 dismissed raw result；
- 缺少交互能力时确定性失败；
- AbortSignal 已取消或等待期间取消时按 turn cancellation 退出。

### 14.2 RuntimeSession 测试

- 调用后 snapshot 出现 pending question；
- 用户按下选项后 pending 清除、事件完整、工具继续；
- selectedIndex 越界时拒绝 resolve，pending 保持可回答；
- dismiss 后 turn 不取消，模型获得下一次 iteration；
- dismiss 与 turn cancellation 不混淆；
- turn cancellation、dispose 和 runtime fault 均清理 pending Promise；
- 同时建立第二个 pending request 时失败；
- listener 在 requested 和 resolved 时收到通知。

### 14.3 Agent Loop 与协议测试

- `AskUser` 是唯一 tool call 时正常执行并继续下一 iteration；
- `AskUser + Edit`、`Bash + AskUser`、两个 `AskUser` 均在任何工具执行前被拒绝；
- 非法 batch 为每个 call 形成合法 completion，不留下 open tool frame；
- selected 和 dismissed completion 都能进入 canonical history；
- 中断 frame 的 resume recovery 不重新打开旧问题。

### 14.4 TUI 组件测试

- 默认选中第一项；
- 上下键循环移动；
- Enter 提交当前项；
- 数字键提交对应项；
- 超出选项数量的数字键无效果；
- `Esc` 调用 dismiss，不触发 turn abort；
- pending 时普通 PromptInput 不接收输入；
- 问题解决后恢复普通输入。

### 14.5 CLI 与端到端测试

- TUI 工具定义中包含 `AskUser`；
- one-shot 工具定义中不包含 `AskUser`；
- PTY 测试覆盖模型提问、方向键选择、数字键选择和 Esc dismiss；
- 选择后模型能读取 answer 并继续完成 turn；
- dismiss 后模型收到未选择观察并继续完成 turn；
- 等待期间使用真正的 turn cancellation 路径仍能安全结束。

## 十五、验收标准

1. 模型可在 TUI 中调用 `AskUser` 提出一个含 2～6 项的单选问题。
2. 用户可用方向键与 Enter、或数字键完成选择。
3. 选择结果以所选 `description` 为主体返回模型。
4. 用户按 `Esc` 时问题被 dismiss，当前 turn 继续，模型收到未选择观察。
5. 真正的 turn cancellation 仍能中止等待并清理所有 pending 状态。
6. `AskUser` 不与其他工具共享同一 tool batch。
7. one-shot 不注册该工具，也不会等待 stdin。
8. canonical history、事件、session resume 和 Recall 中不存在未配对的已完成工具调用。
9. `bun run check` 全部通过。
