# Session、Turn、Iteration、Frame 与 Message 概念指南

## 用途

本文用于快速回顾 Tinker 的运行身份、会话历史和工具协议结构。它描述当前已经落地的
实现，不是未来设计提案。

相关实现入口：

- `src/agent/types.ts`：Session、Turn、Iteration、ToolCall 身份。
- `src/context/protocol-frame.ts`：canonical message、ProtocolFrame、ToolResultRecord。
- `src/agent/session-ledger.ts`：user、assistant 和 tool completion 如何进入账本。
- `src/context/context-revision-compiler.ts`：canonical history 如何编译为 active context。

## 一、先记住两套相交的结构

这些概念不是一条严格的“从大到小”层级。Tinker 同时维护两套结构：

```text
执行结构：Session -> Turn -> Iteration -> ToolCall
历史结构：Session -> Frame -> Message
```

两套结构通过 `turnId`、`iterationId`、`frameId` 和 `toolCallId` 关联：

- Turn 表示一次用户请求的完整执行范围。
- Iteration 表示该 Turn 中一次完整 agent-loop 循环。
- Frame 表示一组不可拆开的 provider 协议消息。
- Message 表示 canonical conversation 中实际持久化的一条消息。

System frame 不属于任何 Turn；user frame 属于 Turn，但不属于 Iteration；assistant frame
同时属于 Turn 和 Iteration。因此不能简单理解成
`Session -> Turn -> Iteration -> Frame -> Message` 的纯树。

## 二、Session

Session 是一段可恢复的完整对话，也是 Tinker 的持久化边界。`/resume` 恢复的是原来的
Session，而不是重新拼接一段展示文本。

一个 Session 拥有：

- immutable canonical messages；
- protocol frames 和 tool results；
- turns、iterations 和 tool calls；
- active context revision；
- Recall 的历史来源和索引；
- model/profile 兼容信息及恢复状态。

Session 的完整历史不等于当前发送给模型的 active context。Swap 和 prefix retirement
只改变 active context 的呈现范围，不删除 canonical history。

## 三、Turn

Turn 是一次用户输入触发的完整 agent 执行，从接受 Prompt 开始，到以下任一状态结束：

- `completed`
- `failed`
- `cancelled`

一个 Turn 只有一条 user message，但可以包含多次模型请求、多个 tool calls 和多条 tool
observations。用户提交下一条 Prompt 时才开始新的 Turn。

例如下面所有动作都属于同一个 Turn：

```text
用户要求检查项目
-> 模型调用 Glob
-> 模型调用 Read
-> 模型返回最终分析
```

`turnNumber` 表示 Turn 在 Session 内的顺序，`turnId` 表示其稳定身份。

## 四、Iteration

Iteration 是 Turn 内一次完整的 agent-loop 循环：

```text
构造模型上下文
-> 请求模型
-> 接收 assistant message
-> 如果存在 tool calls，执行并追加全部 tool messages
```

如果 assistant message 没有 tool call，本次 Iteration 以最终回答结束；如果有 tool
calls，则在全部 tool messages 写入后结束，然后进入下一个 Iteration。

示例：

```text
Turn 1
├── Iteration 1：模型要求调用 Glob 和 Grep
├── Iteration 2：模型看到结果后要求调用 Read
└── Iteration 3：模型返回最终文本
```

`iterationNumber` 在每个 Turn 内从 1 开始，不能用 UUID 的排序替代它。

## 五、Frame

Frame 是保证 provider 消息协议完整的原子单元。当前有四种类型：

| Frame kind | 包含内容 | 初始状态 |
| --- | --- | --- |
| `system` | 一条 system message | closed |
| `user` | 一条 user message | closed |
| `assistant_text` | 一条不调用工具的 assistant message | closed |
| `tool_exchange` | assistant tool calls 及其全部 tool messages | open |

### Tool exchange frame

模型声明工具调用时，Tinker 先创建一个 open frame：

```text
Tool Exchange Frame
├── assistant message
│   ├── ToolCall A
│   └── ToolCall B
├── tool message A
└── tool message B
```

只有 A、B 都获得严格配对的 tool message 后，frame 才会变为 closed。缺失、重复、错序
或属于其他 call 的 tool message 都是协议错误。

Frame 的作用是确保 assistant tool call 骨架和全部结果不会被拆开。发送 provider、
compaction 或恢复前，都可以据此判断历史是否完整。

## 六、Message

Message 是 canonical conversation 中实际持久化的记录。当前有四种 role：

```text
system
user
assistant
tool
```

每条 message 至少包含：

- `messageId`
- `sessionId`
- `frameId`
- Session 内连续递增的 `ordinal`
- `contentSha256`
- `createdAt`

除 system message 外，其他消息都关联 `turnId`。Assistant 和 tool message 还关联
`iterationId`。

`ordinal` 表示 canonical message 的确定顺序；`messageId` 只表示身份。

## 七、Assistant message、ToolCall、Tool message

### Assistant message

Assistant message 是模型返回的消息，可以包含：

- 普通文本；
- reasoning content；
- 一个或多个 ToolCall；
- 文本和 ToolCall 同时存在。

没有 ToolCall 时，它构成 `assistant_text` frame；包含 ToolCall 时，它是
`tool_exchange` frame 的第一条 message。

### ToolCall

ToolCall 不是独立 message，而是嵌在 assistant message 中的结构化调用请求。它包含：

- Tinker 内部的 `toolCallId`；
- provider 返回的 `providerToolCallId`；
- tool name 和 args；
- 所属 Session、Turn、Iteration；
- Iteration 内的 `toolCallNumber`。

一次 assistant message 可以声明多个 ToolCall。

### Tool message

Tool message 是工具执行后写回 canonical conversation、下一次模型请求可见的 observation。
它通过 `toolCallId` 和 `providerToolCallId` 与对应 ToolCall 一一配对。

```text
assistant message 中的 ToolCall
                 |
                 v
          对应的 tool message
```

## 八、ToolResultRecord

ToolResultRecord 不是另一条 conversation message，而是 Tinker 内部保存的结构化工具结果。

两者职责不同：

| 对象 | 用途 |
| --- | --- |
| Tool message | 模型可见的 observation 文本 |
| ToolResultRecord | raw result、completion 类型、hash 和关联身份 |

例如 Read 的 ToolResultRecord 可以保留 `filePath`、行号、文件 hash 和 raw kind；对应的
tool message 保存实际呈现给模型的文件内容。两者与 ToolCall 必须通过 ID 和 hash 相互匹配。

## 九、完整示例

```text
Session
├── System Frame
│   └── system message
│
└── Turn 1
    ├── User Frame
    │   └── user message
    │
    ├── Iteration 1
    │   └── Tool Exchange Frame
    │       ├── assistant message
    │       │   ├── ToolCall: Glob
    │       │   └── ToolCall: Grep
    │       ├── tool message: Glob result
    │       └── tool message: Grep result
    │
    ├── Iteration 2
    │   └── Tool Exchange Frame
    │       ├── assistant message
    │       │   └── ToolCall: Read
    │       └── tool message: Read result
    │
    └── Iteration 3
        └── Assistant Text Frame
            └── assistant final message
```

下一条用户输入会创建 Turn 2，而不是继续 Turn 1。

## 十、与 Compact 的关系

### Observation swap

Swap 的候选不是整个 frame，而是 closed `tool_exchange` frame 中满足策略要求的单条
tool message。

Swap：

- 不删除 Turn 或 Frame；
- 不修改 canonical message；
- 只在 active context 中用确定性 placeholder 替换该 tool message 的 content；
- 保留 source 和 hash，可通过 Recall 获取原 observation。

### Prefix retirement

Prefix retirement 的选择单位是完整 closed Turn 的连续旧前缀，不会单独退休某个 frame。

Retirement：

- 让被选中 Turn 的全部 frames/messages 退出 active context；
- 不删除 SQLite 中的 canonical history；
- 保留最近策略要求的 Turn；
- 退休内容仍可通过 Recall 搜索和读取。

因此可以记成：

```text
Swap：处理单条大型 tool message 的表示
Retirement：处理一段完整旧 Turn 的 active 范围
```

## 十一、快速对照

| 名词 | 最简定义 | 关键边界 |
| --- | --- | --- |
| Session | 可恢复的完整对话 | 持久化和 resume 边界 |
| Turn | 一次用户 Prompt 的完整执行 | completed/failed/cancelled |
| Iteration | Turn 内一次模型与工具循环 | 一次 assistant response |
| Frame | 不可拆开的协议消息单元 | open/closed |
| Message | canonical history 中的一条消息 | 全局 ordinal |
| ToolCall | assistant 提出的结构化工具请求 | 嵌在 assistant message 中 |
| Tool message | 工具执行后的模型可见结果 | 与 ToolCall 一一配对 |
| ToolResultRecord | 工具结果的内部结构化记录 | raw result 与 hash |
| Context revision | canonical history 的活动呈现版本 | swap/retirement 不删除历史 |

最重要的记忆点：

> Turn 管一次用户请求，Iteration 管一次 agent 循环，Frame 管协议完整性，Message 保存事实；
> ToolCall 是请求，tool message 是结果，ToolResultRecord 是结果的内部结构化记录。
