# 项目指令自动加载技术方案

## 背景

Tinker 当前的系统提示词由 `src/cli/config.ts` 中的 `SYSTEM_PROMPT()` 生成。
`runOneShot()` 和 `runTui()` 在创建 `RuntimeSession` 时把它作为 `systemPrompt`
传入，随后 `SessionLedger` 将它保存为 session 的第一条 system message。
`ContextBuilder` 只负责把 ledger 中的 canonical message 投影成模型请求，不负责
从工作区读取额外上下文。

因此，仓库根目录即使存在 `AGENTS.md` 或 `CLAUDE.md`，模型也不会自动看到它们。
仅在 `ContextBuilder` 或每次请求前临时读取文件也不可取：这会绕过 session ledger、
context preflight 和 runtime contract，使同一 session 的 system context 随工作区变化，
并破坏 `/resume` 的可复现性。

## 目标

- 创建新 session 时，自动发现 workspace 根目录的 `AGENTS.md` 或
  `CLAUDE.md`，每个 session 最多加载其中一个。
- `AGENTS.md` 优先；只有它不存在时才回退加载 `CLAUDE.md`。
- 项目指令作为 session system context 的一部分参与 token 统计、预算预检、持久化
  和 runtime contract 校验。
- session 创建成功后使用指令快照；文件后续变化只影响新 session，不静默改变当前
  session。
- TUI 和 one-shot CLI 使用完全相同的加载逻辑。
- 文件不存在时零配置正常运行；文件存在但不可安全读取时 fast-fail。

## 非目标

- 第一版不递归加载子目录中的 `AGENTS.md` / `CLAUDE.md`。
- 第一版不搜索 workspaceRoot 祖先目录或用户主目录中的全局指令。
- 不监听文件变化，不在 turn 之间热更新 system context。
- 不解析 Markdown 标题或尝试理解、重排、合并指令语义。
- 不实现 include/import 语法，也不自动读取文件中提到的其他文档。
- 不把项目指令作为普通 user message、tool observation 或 Recall 结果注入。

限制第一版为 workspace 根目录是有意的：Tinker 的 session、工具安全边界和持久化
目录都以固定的 `workspaceRoot` 为准，而 Bash 的当前目录可以在运行中变化。若根据
Bash cwd 动态切换嵌套指令，同一 session 的模型上下文会产生隐式变化，还需要定义
文件工具对不同子树的适用范围，这应作为后续独立能力设计。

## 核心语义

### 发现范围

对已经 `realpath()` 规范化的 `workspaceRoot`，按以下优先级检查精确路径：

1. `<workspaceRoot>/AGENTS.md`
2. `<workspaceRoot>/CLAUDE.md`

文件名大小写敏感，不支持 `agents.md`、`.claude.md` 等别名。不使用 `Glob`，也不
沿目录树搜索，以保证启动成本和行为确定。若 `AGENTS.md` 存在，则选中它并停止
发现，不再读取或校验 `CLAUDE.md`；只有 `AGENTS.md` 返回 `ENOENT` 时才检查
`CLAUDE.md`。

### 选择规则与优先级

最终 system prompt 的顺序固定为：

1. Tinker 内置 runtime 指令；
2. 唯一选中的项目指令文件。

当两个文件同时存在时只加载 `AGENTS.md`，无论两者内容相同还是不同；不会合并、
比较或去重两份内容。`CLAUDE.md` 只是没有 `AGENTS.md` 时的兼容回退。

项目指令与 Tinker 的工具协议、安全边界或 runtime 不变量冲突时，内置 runtime
约束仍然不可被覆盖。该边界需要由合成 prompt 明确告诉模型。

### session 快照

项目指令在新 session 初始化前读取一次，并合成为唯一的 system prompt。该完整文本
进入现有 canonical system frame，因此自然参与：

- `ModelClient.prepare()` 的 token 估算；
- `ContextMeter` 的 initial / preflight 预算校验；
- `systemPromptSha256` 和 runtime contract；
- `SessionStore` 的消息持久化和 `/resume` 重建；
- Recall 的现有 system-message 可见性规则。

当前 session 创建后，即使用户修改或删除指令文件，也继续使用创建时快照。新建
session 才重新加载最新文件。

## 模块设计

新增 `src/instructions/project-instructions.ts`，把文件发现、校验和 prompt 合成从 CLI
配置中分离：

```ts
export type ProjectInstructionFileName = "CLAUDE.md" | "AGENTS.md";

export type LoadedProjectInstruction = {
  fileName: ProjectInstructionFileName;
  absolutePath: string;
  content: string;
  contentSha256: string;
  byteLength: number;
};

export type ProjectInstructionsSnapshot = {
  workspaceRoot: string;
  instruction?: LoadedProjectInstruction;
};

export async function loadProjectInstructions(
  workspaceRoot: string,
): Promise<ProjectInstructionsSnapshot>;

export function buildSystemPrompt(input: {
  workspaceRoot: string;
  runtimeInstructions: string;
  projectInstructions: ProjectInstructionsSnapshot;
}): string;
```

`SYSTEM_PROMPT()` 应拆成不访问文件系统的 `RUNTIME_INSTRUCTIONS(workspaceRoot)`，
再由 `buildSystemPrompt()` 负责加入项目指令。loader 保持纯读取，不依赖 runner、
ledger 或 model client，便于用临时目录做单元测试。

合成后的文本建议使用稳定、不可混淆的边界：

```text
<tinker_runtime_instructions>
...内置指令...
</tinker_runtime_instructions>

<project_instructions>
The following file contains trusted project instructions for this workspace.
They do not override Tinker's runtime, tool protocol, or safety constraints.

<instruction_file path="AGENTS.md">
...原始内容...
</instruction_file>
</project_instructions>
```

文件内容保持原样，只统一由合成器确保边界之间有一个换行。path 使用相对
workspace 的固定文件名，不把机器上的绝对路径重复写入 prompt。XML-like 标签只是
稳定边界，不对文件内容做 XML escaping；模型看到的是文本协议，不是 XML parser
输入。

## 文件读取与 fast-fail 规则

`loadProjectInstructions()` 先读取 `AGENTS.md`，仅在其不存在时读取
`CLAUDE.md`，并执行以下规则：

- `ENOENT`：视为文件不存在，继续。
- 必须是普通文件；目录、FIFO、socket 或设备文件直接报错。
- 符号链接允许，但 `realpath()` 后的目标必须仍位于 `workspaceRoot` 内；越界链接报错。
- 使用 UTF-8 读取；出现 NUL 字节时报错，避免把二进制文件注入 prompt。
- 空文件或仅空白文件视为存在但无有效指令，fast-fail，促使仓库状态保持明确。
- 每个文件设置独立字节上限，建议默认 `64 KiB`；超过上限报错并指出文件和限制。
- 非 `ENOENT` 的权限、I/O、竞态错误不降级为“未配置”，直接终止 session 初始化。

若 `AGENTS.md` 存在但内容无效、不可读或超限，必须针对 `AGENTS.md` fast-fail，
不能静默回退到 `CLAUDE.md`。回退只表示文件名兼容，不是错误恢复机制。

第一版不增加环境变量或 CLI flag。固定上限和固定文件名能减少配置面；确有大型指令
文件需求时，再通过显式配置设计扩展，而不是先加入没有验证价值的开关。

为避免 `stat -> read` 的明显竞态，可先 `open()` 文件，再对同一 handle `stat()`、
按上限读取并关闭。读取后再校验实际 byte length；任何失败都应带相对文件名和具体
原因。

## RuntimeSession 与 `/resume`

这里是实现时最重要的边界。当前 TUI 的 `createSession(mode, sessionId, sink)` 无论
`new` 还是 `resume` 都重新调用 `SYSTEM_PROMPT(workspaceRoot)`，而
`SessionStore.assertRuntimeContract()` 会比较 `systemPromptSha256`。如果直接把当前
文件内容加入该函数，修改 `AGENTS.md` 会导致历史 session 永久无法 resume。

应把创建输入改成按 mode 区分：

```ts
type CreateRuntimeSessionInput = CommonRuntimeSessionInput &
  (
    | {
        selection: { mode: "new"; sessionId: SessionId };
        systemPrompt: string;
      }
    | {
        selection: { mode: "resume"; sessionId: SessionId };
      }
  );
```

- `new`：runner 先加载项目指令并构造 system prompt，然后创建 store。
- `resume`：runner 不读取当前项目指令；`RuntimeSession` 从已打开的
  `SessionStore` canonical system frame 读取保存的完整 prompt。
- runtime contract 比较时，resume 使用保存的 prompt 计算
  `systemPromptSha256`，仍然校验 model、context profile、tool schema、request config
  等当前运行条件。
- 若存储中缺少唯一、closed、ordinal=1 的 system frame，立即以
  `SESSION_RECOVERY_FAILED` 失败，不从当前文件重建。

`SessionStore` 可新增窄接口 `readStoredSystemPrompt(): string`，内部同时校验 frame、
message role、origin 和 content hash。不要让 runner 直接查询 SQLite，也不要把完整
system prompt 写进 event log 或 TUI；它可能包含私有仓库指令。

one-shot 只创建新 session，因此启动时加载一次即可。TUI 在启动新 session 时加载；
切换到历史 session 时直接使用历史快照。未来若支持 TUI 内“新建 session”，每次新建
都重新读取文件。

## 初始化顺序

### 新 session

```text
runner resolve + realpath workspaceRoot
  -> loadProjectInstructions(workspaceRoot)
  -> buildSystemPrompt(...)
  -> createRuntimeSession(mode=new, systemPrompt)
  -> open SessionStore and write canonical system frame
  -> initialize built-in and MCP tools
  -> prepare system prompt + tool schema
  -> finalize runtime contract
  -> initial context measurement
  -> ready
```

项目文件读取必须发生在 session store 创建前。这样加载失败不会留下半初始化的
`.tinker/sessions/<sessionId>` 目录。

### resume session

```text
runner resolve + realpath workspaceRoot
  -> createRuntimeSession(mode=resume, no systemPrompt)
  -> open and lock SessionStore
  -> readStoredSystemPrompt()
  -> initialize tools
  -> prepare stored prompt + current tool schema
  -> assert runtime contract
  -> recover ledger and context anchor
  -> ready
```

## 可观察性

在 `session.started` 事件中增加不含正文的摘要：

```ts
projectInstructions: {
  instruction: { path: "AGENTS.md", byteLength: 2345, sha256: "..." },
}
```

未加载任何文件时不设置 `instruction`。这使日志可以回答“本 session 到底加载了
什么”，又不泄露正文。resume 的 `session.resumed` 可增加
`projectInstructionFile` 文件名，来源于持久化快照元数据，而不是当前磁盘。

建议在 session metadata 中保存上述 manifest（文件名、byte length、content hash），
与完整 system message 分开。manifest 只用于诊断，不作为第二份正文来源；system
message 仍是恢复模型上下文的唯一事实源。

第一版无需增加 TUI 常驻区域。初始化错误直接沿现有 runner error 路径展示；后续可在
`/context` 中展示已加载文件名和快照 hash。

## 测试方案

新增 `src/__tests__/project-instructions.test.ts`：

- 两个文件都不存在时返回空 snapshot。
- 只存在其中一个时正确加载。
- 两者存在时只加载 `AGENTS.md`，不读取 `CLAUDE.md`。
- 两者内容相同时仍然只加载 `AGENTS.md`。
- `AGENTS.md` 存在但无效时 fast-fail，不回退到有效的 `CLAUDE.md`。
- prompt 中只包含一个项目指令来源边界。
- 空白文件、NUL、超限文件、目录和越界 symlink 均 fast-fail。
- 权限或普通 I/O 错误不会被当作文件缺失。
- snapshot 内容和 hash 在加载后保持不变。

扩展 `config.test.ts` 或新增 prompt composer 测试：

- 没有项目文件时仍保留全部现有 runtime 指令。
- 项目文本不会改变工具指令的结构和 workspaceRoot。
- 合成结果稳定，相同输入产生相同 system prompt hash。

扩展 `runtime-session.test.ts` / `session-resume.test.ts`：

- 新 session 的首次 model request 只包含一个 system message，且正文包含项目指令。
- 项目指令 token 被 initial context snapshot 计入。
- 创建 session 后修改 `AGENTS.md`，当前 session 的后续 turn 不变化。
- 关闭后修改或删除项目文件，历史 session 仍能使用保存快照 resume。
- 新 session 能看到修改后的文件。
- 保存的 system frame 缺失或损坏时 resume fast-fail。
- model 或 tool contract 改变仍按现有规则拒绝 resume，不能因使用保存 prompt 而放宽。

runner 集成测试覆盖 one-shot 和 TUI 共用 loader，且加载失败发生在
`session.started` 和数据库创建之前。最终运行 `bun run check`。

## 实施步骤

1. 新增 project-instructions loader、类型、限制和 prompt composer，并完成独立测试。
2. 将 `SYSTEM_PROMPT()` 拆为 runtime 指令与合成器；one-shot 新 session 接入 loader。
3. 把 `CreateRuntimeSessionInput` 改为 new/resume discriminated union，增加
   `SessionStore.readStoredSystemPrompt()`。
4. 调整 TUI session factory：new 加载当前文件，resume 使用存储快照。
5. 增加 project-instruction manifest 持久化和无正文事件摘要。
6. 补齐 session、resume、context measurement 和 runner 集成测试，运行完整质量门。

建议按以上顺序一次性切换，不保留“resume 时重新读取当前文件”的兼容 fallback。
存储状态不满足新不变量时应明确失败，避免把历史 session 在不知情的情况下换成另一套
项目规则。

## 后续扩展

根目录版本稳定后，可以独立设计分层指令：从 workspaceRoot 到目标文件父目录收集
嵌套 `AGENTS.md`，按浅到深覆盖，并把适用指令绑定到具体 tool call 的路径范围。
这不能简单依赖 Bash cwd，因为一个 model iteration 可能同时读取或编辑多个目录。
合理的后续模型应是“workspace session snapshot + 路径作用域指令”，而不是每次 cwd
变化就重写全局 system prompt。
