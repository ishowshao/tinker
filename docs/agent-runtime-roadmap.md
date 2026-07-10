# Agent Runtime 后续规划

## 背景

Tinker 已经具备基础 agent loop、文件读写与搜索、Bash、Web、MCP、事件日志和
TUI，可以完成日常编码任务。下一阶段不继续扩张工具数量，优先补齐长任务控制、
会话恢复和上下文管理能力，让现有闭环更稳定、更适合持续使用。

本文只记录近期选定的五个高优先级功能及实施顺序，不作为详细技术设计。每项功能
在实施前再编写对应设计方案和测试计划，按阶段独立交付，不一次性全部开发。

## 目标

1. 后台进程可查询、查看输出和主动终止。
2. 用户可以通过 `Esc` 中断当前 agent turn，而不退出 TUI。
3. Tinker 退出重启后，可以通过 `/resume` 恢复历史 session。
4. TUI 可以统计和展示当前 context window 使用情况。
5. 支持自动 compaction，并提供 `/compact` 手动压缩命令。

## 非目标

- 不在本阶段引入多 agent、子 agent 或并行任务调度。
- 不实现向量检索、长期记忆或跨项目知识库。
- 不要求后台 OS 进程在 Tinker 退出后继续运行或在重启后恢复。
- 不实现 session 分支、云同步或多人共享。
- 不追求所有模型都具备完全精确的本地 token 计算能力。

## 阶段一：后台进程管理

详细设计见 [`background-task-management-design.md`](background-task-management-design.md)。

当前 `Bash` 可以启动后台任务，并将任务保存在 `ShellTaskManager` 中，但模型和用户
缺少稳定的后续管理入口。

第一版增加以下能力：

- 列出当前 session 中的后台任务及其状态。
- 按 task ID 获取最新输出和完整输出文件路径。
- 按 task ID 主动终止运行中的任务。
- TUI 展示任务 ID、命令摘要、状态、启动时间和退出结果。
- Tinker 正常退出时明确处理仍在运行的子进程，避免遗留不可见进程。

建议增加 `TaskList`、`TaskOutput`、`TaskStop` 三个工具，并复用现有
`ShellTaskManager` 和 `.tinker/bash/` 输出文件。

验收标准：agent 启动开发服务器后，可以继续执行其他工作，随后查询输出并可靠地
终止该服务器；不存在已经退出但仍显示为 `running` 的任务。

## 阶段二：Esc 中断当前执行

`Esc` 的语义固定为“取消当前 turn”，不是退出 TUI，也不是撤销已经完成的文件改动。

取消信号需要贯穿以下链路：

```text
TUI -> runAgent -> ModelClient / ToolRuntime -> Bash child process
```

第一版行为：

- 模型请求尚未完成时，`Esc` 取消本次请求。
- 前台 Bash 正在执行时，`Esc` 终止对应进程。
- 普通工具执行时，在安全边界检查取消信号并尽快结束。
- 已经完成的工具结果和文件修改继续保留。
- 取消记录为独立的 `run.cancelled` 事件，不与普通失败混淆。
- 取消完成后输入框重新可用，用户可以继续当前 session。

后台任务不因取消其他 turn 而自动终止，必须通过 `TaskStop` 明确处理。

验收标准：模型请求和前台命令都能被 `Esc` 及时中断，没有孤立子进程，取消后可以
立即提交下一条请求。

## 阶段三：Session 持久化与 `/resume`

现有 JSONL event log 用于观测和排查，不直接承担 session 恢复职责。新增独立的
`SessionStore`，保存可重新构造模型上下文和 TUI 历史的状态。

Session 至少记录：

- schema version、session ID、workspace、model、创建时间和更新时间。
- 用户、assistant 和 tool messages。
- 已生成的 compaction summary。
- context 使用统计和最近一次运行状态。

命令行为：

- `/resume`：列出当前 workspace 最近的 sessions。
- `/resume <session-id>`：恢复指定 session。
- 恢复后重新显示历史对话，并在后续请求中继续使用原有消息上下文。
- session 文件损坏或版本不支持时 fast-fail，并指出具体文件和原因。

Session 建议存放在 `.tinker/sessions/<session-id>/`。写入采用临时文件加原子替换，
避免进程退出时留下半个状态文件。

验收标准：完成若干轮对话后退出 Tinker，重新启动并执行 `/resume <session-id>`，
模型能够基于退出前的上下文继续工作。

## 阶段四：Context Window 统计和展示

Context 统计为自动 compaction 提供触发依据，同时让用户知道当前 session 是否接近
模型上限。

第一版需要：

- 为模型配置 context window 上限。
- 规范化模型返回的 prompt、completion 和 total token usage。
- 在 provider 不返回 usage 时使用估算值，并在 UI 中明确标记为 estimated。
- TUI footer 展示当前输入 context、上限和使用百分比。
- `/status` 输出 session、model、context usage、compaction 次数和后台任务数量。
- 将 usage 写入事件日志和 session 状态，便于后续分析。

展示重点是当前下一次模型请求会占用的输入 context，不把整个 session 的累计输出
token 与 context window 占用混为一谈。

验收标准：多轮工具调用后，TUI 中的 context 使用量持续更新；真实 usage 可用时
优先使用真实值，估算模式有清楚标识。

## 阶段五：自动 Compaction 和 `/compact`

Compaction 只压缩已经完成的历史步骤，不拆开 assistant tool call 与对应 tool
result，也不在工具执行到一半时运行。

压缩后必须保留：

- system prompt 和稳定运行约束。
- 最近若干轮原始消息。
- 当前未完成的用户目标和任务状态。
- 关键技术决策、修改过的文件、重要错误和验证结果。
- 仍在运行的后台任务信息。

第一版行为：

- context 使用量达到可配置阈值后，在下一次模型请求前自动压缩。
- `/compact` 在空闲状态下手动触发压缩。
- 压缩开始和结束产生独立事件，并展示压缩前后 token 数量。
- summary 写入 session，因此 `/resume` 后继续使用已经压缩的上下文。
- 压缩失败时保留原始消息；接近硬上限且无法压缩时返回明确错误。

初始自动阈值建议设为 context window 的 75%，同时保留环境变量或配置项用于调整。

验收标准：长 session 达到阈值后可以继续对话，模型仍能复述关键决策和未完成目标；
手动 `/compact` 与自动压缩使用同一条实现路径。

## 建议实施顺序

```text
后台进程管理
  -> Esc 中断当前执行
  -> SessionStore 与 /resume
  -> Context Window 统计和展示
  -> 自动 compaction 与 /compact
```

前两个阶段共同建立运行控制能力；SessionStore 为 compaction summary 提供持久化
位置；context 统计为自动 compaction 提供可靠触发条件。每个阶段完成并通过真实
TUI 验证后，再进入下一阶段。
