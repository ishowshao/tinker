# Coding Agent MVP 技术方案

## 背景

第一版目标是验证一个极简 coding agent runtime 是否能稳定跑通 ReAct loop：

```text
模型 -> 工具调用 -> 工具结果 -> 模型 -> ... -> 最终回答
```

本方案不采用 LangChain `createAgent`、Vercel `ToolLoopAgent` 或 OpenAI Agents SDK 作为 agent loop。模型接口使用 OpenAI 官方 TypeScript/JavaScript SDK，通过 `baseURL` 接入 OpenAI Chat Completions 兼容 API，并在项目内包一层自己的 `ModelClient`。

## 技术栈与开发环境

第一版明确使用 Bun + TypeScript：

- Runtime：`bun`。
- Package manager：`bun`。
- Test runner：`bun test`。
- 实现语言：TypeScript。
- 模块格式：ESM。
- CLI 入口由 Bun 执行 TypeScript 源码或构建后的 JavaScript。

基础命令：

```bash
bun install
bun test
bun run typecheck
bun run tinker
bun run tinker run "Create notes.txt with one line: hello."
```

`package.json` 脚本建议：

```json
{
  "scripts": {
    "tinker": "bun src/cli/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  }
}
```

第一版不引入 Node 专用运行入口；如果某个依赖在 Bun 下存在兼容性问题，优先评估替代方案或做局部适配。

## 目标

第一版只验证 loop 的基本可靠性：

- 模型能基于用户请求决定是否调用工具。
- runtime 能执行工具并把 observation 回填给模型。
- 模型能基于工具结果继续下一步或给出最终回答。
- event log 能记录模型步骤、工具调用、原始结果和 observation。
- 模型可见工具更接近 Claude Code 的 `Read` / `Write` 命名和参数形态，同时 runtime 保留最小路径安全和覆盖保护。
- MVP 阶段提供一个简单 TUI，使用 `ink`、`react`、`@inkjs/ui` 展示输入、运行状态、工具调用 timeline 和最终回答。
- 保留 `tinker run "..."` 非交互式入口，方便测试、脚本调用和 CI 验证。

## 非目标

第一版明确不做：

- shell 工具。
- git 工具。
- patch/局部编辑工具。
- streaming。
- 并发 tool calls。
- checkpoint/resume。
- human approval。
- 多模型 fallback。
- 复杂 context compaction。
- repo map、symbol index、语义检索。
- 多会话 TUI。
- TUI 内 diff viewer。
- TUI 内滚动详情面板。
- approval UI。
- 历史 run 浏览器。

这些能力后续可以加，但不进入第一版闭环。

## 总体架构

```text
CLI
  -> TUI Runner / Run Runner
       -> AgentLoop
       -> ContextBuilder
       -> ModelClient
       -> ToolRegistry
       -> ToolRuntime
       -> ObservationBuilder
       -> EventSink
            -> JsonlEventLog
            -> TuiEventStream (only for TUI)
            -> StdoutEventPrinter (only for run)
```

各模块职责：

- `AgentLoop`：控制 ReAct 循环、步数限制、停止条件。
- `ModelClient`：封装 OpenAI SDK，隐藏 provider 请求/响应细节。
- `ToolRegistry`：注册工具 schema 和 executor。
- `ToolRuntime`：校验工具调用、执行工具、返回 raw result。
- `ObservationBuilder`：把 raw result 转成给模型看的 tool message。
- `EventSink`：接收运行事件，可以 fan-out 到 JSONL 文件、TUI 或 stdout/stderr。
- `JsonlEventLog`：以 JSONL 记录完整运行过程。
- `TuiEventStream`：TUI 入口中把运行事件推给 Ink UI 渲染；`run` 入口不启用。
- `StdoutEventPrinter`：`run` 入口中把关键事件和最终回答输出到 stdout/stderr；TUI 入口不启用。
- `ContextBuilder`：MVP 阶段只负责把已有 messages 和 tool schemas 组装成模型请求。

## 数据流

```text
1. 用户输入进入 AgentLoop。
2. AgentLoop 构造初始 messages。
3. ModelClient 调用 Chat Completions API。
4. 如果 assistant 没有 tool_calls，返回最终回答。
5. 如果 assistant 有 tool_calls：
   - ToolRuntime 顺序执行每个 tool call。
   - EventSink 广播工具事件。
   - JsonlEventLog 记录 raw result。
   - TUI 接收 event 并展示 tool timeline。
   - ObservationBuilder 生成 tool observation。
   - AgentLoop 把 tool message 追加到 messages。
6. 继续下一轮模型调用，直到完成或达到 maxSteps。
```

## 内部消息模型

内部维护 provider-neutral 的消息结构，不让 agent runtime 直接依赖 OpenAI SDK 类型：

```ts
export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content?: string | null;
      toolCalls?: ToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
    };

export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
};
```

`ModelClient` 负责把 `AgentMessage[]` 转成 Chat Completions 的 `messages[]`，并把返回的 `tool_calls` 转回内部 `ToolCall[]`。

## ModelClient 设计

第一版使用 OpenAI 官方 SDK：

```ts
import OpenAI from "openai";

export class OpenAIChatModelClient implements ModelClient {
  private client: OpenAI;

  constructor(private options: {
    apiKey: string;
    baseURL?: string;
    model: string;
    timeoutMs?: number;
  }) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs,
    });
  }

  async step(input: ModelStepInput): Promise<ModelStepOutput> {
    const response = await this.client.chat.completions.create({
      model: this.options.model,
      messages: toOpenAIChatMessages(input.messages),
      tools: toOpenAIChatTools(input.tools),
      tool_choice: input.tools.length > 0 ? "auto" : "none",
    });

    return fromOpenAIChatCompletion(response);
  }
}
```

接口建议：

```ts
export interface ModelClient {
  step(input: ModelStepInput): Promise<ModelStepOutput>;
}

export type ModelStepInput = {
  messages: AgentMessage[];
  tools: ToolDefinition[];
};

export type ModelStepOutput = {
  message: AgentMessage;
  finishReason?: string;
  usage?: unknown;
  rawResponse?: unknown;
};
```

注意事项：

- 第一版默认模型是 `deepseek-v4-flash`。
- 第一版默认 OpenAI-compatible `baseURL` 是 `https://api.deepseek.com`。
- API key 从 `.env` 的 `API_KEY` 读取，并传给 OpenAI SDK 的 `apiKey`。
- 第三方兼容 API 未必完整支持 OpenAI 的 `tool_calls`、`usage`、`finish_reason`，所以必须在 `fromOpenAIChatCompletion` 做容错。
- tool arguments 是 JSON 字符串，解析失败时不要执行工具，应返回一个 tool error observation 给模型。
- runtime 不直接使用 OpenAI SDK 类型，避免后续迁移成本。

## AgentLoop 设计

核心循环：

```ts
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const messages: AgentMessage[] = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: input.userPrompt },
  ];

  for (let step = 1; step <= input.maxSteps; step++) {
    await input.eventSink.append({
      type: "model.step.started",
      step,
    });

    const modelOutput = await input.model.step({
      messages,
      tools: input.tools.definitions(),
    });

    messages.push(modelOutput.message);

    await input.eventSink.append({
      type: "model.step.finished",
      step,
      output: modelOutput,
    });

    const toolCalls = modelOutput.message.role === "assistant"
      ? modelOutput.message.toolCalls ?? []
      : [];

    if (toolCalls.length === 0) {
      return {
        ok: true,
        finalText: modelOutput.message.role === "assistant"
          ? modelOutput.message.content ?? ""
          : "",
        messages,
      };
    }

    for (const call of toolCalls) {
      await input.eventSink.append({
        type: "tool.started",
        step,
        call,
      });

      const raw = await input.toolRuntime.execute(call);

      await input.eventSink.append({
        type: "tool.raw_result",
        step,
        call,
        raw,
      });

      await input.eventSink.append({
        type: "tool.finished",
        step,
        call,
        ok: raw.ok,
      });

      const observation = input.observationBuilder.build({
        call,
        raw,
      });

      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: observation.content,
      });

      await input.eventSink.append({
        type: "tool.observation",
        step,
        call,
        observation,
      });
    }
  }

  return {
    ok: false,
    error: `Agent stopped after maxSteps=${input.maxSteps}`,
    messages,
  };
}
```

停止条件：

- assistant 没有 `toolCalls`：正常结束。
- 达到 `maxSteps`：失败结束。
- `ModelClient` 抛出不可恢复错误：失败结束。
- 工具执行异常：转换成 tool observation，继续交给模型处理。

第一版不做自动 retry。SDK 自带的网络重试可以保留，但 agent runtime 不额外重试推理步骤。

## 工具设计

第一版只提供两个模型可见工具，并尽量贴近 Claude Code 的工具命名和参数形态：

```text
Read(file_path, offset?, limit?)
Write(file_path, content)
```

这样做的理由是：工具名和参数本身是 prompt surface。现代 coding 模型对 `Read`、`Write`、`Edit`、`Bash`、`Glob`、`Grep` 这组 coding-agent 工具有较强先验。第一版虽然只实现文件读写，但模型可见接口先向这组惯例靠拢。

runtime 内部可以继续使用 `readFile`、`writeFile`、`ReadFileRawResult` 等工程命名；模型只看到 `Read` / `Write`。

### Read

输入：

```ts
{
  file_path: string;
  offset?: number;
  limit?: number;
}
```

行为：

- 允许 workspace 内的相对路径或绝对路径。
- 拒绝逃逸 workspace 的路径。
- 文件不存在返回 `ok: false`。
- 目录路径返回 `ok: false`。
- 返回文件内容、字节数、行数、sha256。
- `offset` 表示从第几行开始读取，第一版使用 1-based line number。
- `limit` 表示最多读取多少行。
- 未传 `offset` 时从第 1 行开始。
- 未传 `limit` 时读取到文件末尾，但仍受最大输出字节数保护。
- 内容超过最大输出字节数时截断，并在 observation 中说明。
- 读取成功后，runtime 记录该文件的 read snapshot：`normalized absolute path -> sha256`。`Write` 用它判断是否允许覆盖已有文件。

raw result：

```ts
export type ReadFileRawResult = {
  ok: boolean;
  filePath: string;
  absolutePath?: string;
  content?: string;
  sizeBytes?: number;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  sha256?: string;
  truncated?: boolean;
  displayedBytes?: number;
  error?: string;
};
```

### Write

输入：

```ts
{
  file_path: string;
  content: string;
}
```

行为：

- 允许 workspace 内的相对路径或绝对路径。
- 拒绝路径逃逸 workspace。
- 如果目标文件不存在，允许创建文件。
- 如果目标文件已存在，必须满足：
  - 当前 run 内曾经成功 `Read` 过同一个 normalized absolute path。
  - 当前文件 sha256 与最近一次 successful `Read` snapshot 一致。
- 如果目标文件已存在但没有 read snapshot，拒绝写入，并通过 observation 提醒模型先调用 `Read`。
- 如果目标文件在 `Read` 后发生变化，拒绝写入，并通过 observation 提醒模型重新读取。
- 自动创建父目录可以暂不支持，第一版更保守：父目录不存在则失败。
- 写入成功后返回 old sha256、new sha256、写入字节数。

raw result：

```ts
export type WriteFileRawResult = {
  ok: boolean;
  filePath: string;
  absolutePath?: string;
  bytesWritten?: number;
  oldSha256?: string | null;
  newSha256?: string;
  requiredReadBeforeWrite?: boolean;
  currentSha256?: string;
  lastReadSha256?: string;
  error?: string;
};
```

## EventSink 与 EventLog

第一版把事件输出抽象成 `EventSink`：

```ts
export interface EventSink {
  append(event: AgentEvent): Promise<void>;
}
```

`AgentLoop` 只依赖 `EventSink`，不直接依赖 TUI 或 JSONL 文件。入口层可以传入 `CompositeEventSink`：

```text
TUI entry:
  CompositeEventSink
    -> JsonlEventLog
    -> TuiEventStream

run entry:
  CompositeEventSink
    -> JsonlEventLog
    -> StdoutEventPrinter
```

这样 runtime 只产生事件，TUI、日志和 stdout 输出只是事件消费者。

JSONL 文件默认写到：

```text
.tinker/runs/<run-id>.jsonl
```

事件类型：

```ts
export type AgentEvent =
  | { type: "run.started"; runId: string; createdAt: string; input: unknown }
  | { type: "model.step.started"; step: number }
  | { type: "model.step.finished"; step: number; output: unknown }
  | { type: "tool.started"; step: number; call: ToolCall }
  | { type: "tool.raw_result"; step: number; call: ToolCall; raw: unknown }
  | { type: "tool.finished"; step: number; call: ToolCall; ok: boolean }
  | { type: "tool.observation"; step: number; call: ToolCall; observation: unknown }
  | { type: "run.finished"; result: unknown }
  | { type: "run.failed"; error: string };
```

MVP 不做 replay，但 event 格式要为后续 replay/resume 留空间。

## TUI 设计

MVP 阶段引入 `ink`、`react`、`@inkjs/ui`，但 TUI 不拥有 agent state，也不直接驱动模型步骤。TUI 只负责：

- 收集用户输入。
- 启动一次 agent run。
- 订阅 `AgentEvent`。
- 渲染运行状态、工具调用 timeline 和最终回答。
- 支持 `Ctrl+C` 取消当前进程。

第一版 TUI 信息结构：

```text
Header:
  model / workspace / run id

Input:
  one-line prompt

Timeline:
  model step started / finished
  tool Read file_path succeeded / failed
  tool Write file_path succeeded / failed

Footer:
  idle / running / done / failed
```

TUI 使用原则：

- `AgentLoop` 不 import `ink`、`react` 或 `@inkjs/ui`。
- TUI 组件只消费 `AgentEvent` 和 `RunAgentResult`。
- 不把 React state 当作 agent state。
- event log 仍然落 JSONL，TUI 只是实时视图。
- TUI 输出可以简洁，不做复杂布局。

建议组件：

```text
src/tui/
  app.tsx
  event-store.ts
  components/
    header.tsx
    prompt-input.tsx
    timeline.tsx
    footer.tsx
```

依赖：

```text
ink
react
@inkjs/ui
```

测试依赖：

```text
ink-testing-library
node-pty
```

`node-pty` 是 PTY 测试依赖的包名；测试默认仍通过 `bun test` 启动。

## CLI 入口设计

MVP 提供两个入口，入口形态决定是否启动 TUI：

```bash
tinker
```

启动交互式 TUI，用户在 TUI 中输入 prompt。

```bash
tinker run "Create notes.txt with one line: hello."
```

非交互式 one-shot 运行，不启动 Ink。这个入口用于测试、脚本调用和 CI。

`run` 输出要求：

- 不使用 ANSI 动态刷新。
- 每个重要事件输出一行稳定文本。
- 最终回答输出到 stdout。
- 错误输出到 stderr。
- 进程退出码表达成功或失败。

示例：

```text
run.started runId=...
model.step.started step=1
tool.started name=Write path=notes.txt
tool.finished name=Write ok=true
run.finished ok=true

Created notes.txt with one line: hello.
```

## 自动化验收与测试策略

第一版验收分成 runtime、run 入口和 TUI 三层。TUI 的视觉布局需要人工确认，但基础行为必须能由自动化测试和 Codex CLI 自测覆盖。

统一使用 Bun 执行测试：

```bash
bun test
bun run typecheck
```

### Runtime 与 run 入口

自动化测试重点：

- `AgentLoop` 使用 fake `ModelClient` 跑通 `assistant -> tool call -> tool observation -> final answer`。
- `Read` / `Write` 工具覆盖成功、文件不存在、路径逃逸、未 `Read` 覆盖已有文件、`Read` 后文件变化导致 `Write` 拒绝。
- `run` 入口不 import 或启动 Ink。
- `run` 入口 stdout/stderr 输出稳定文本。
- `run` 入口成功返回退出码 `0`，失败返回非 `0`。
- JSONL event log 包含 `run.started`、`model.step.started`、`tool.started`、`tool.finished`、`tool.observation`、`run.finished` 或 `run.failed`。

### TUI 自动化验收

TUI 自动化验收不检查完整 layout snapshot，只检查关键语义是否可见、交互是否可用。

建议测试依赖：

```text
ink-testing-library
node-pty
```

`ink-testing-library` 用于组件级测试：

- 使用 fake `AgentEvent[]` 渲染 `Header`，断言显示 model、workspace、run id。
- 使用 fake `AgentEvent[]` 渲染 `Timeline`，断言显示 `Read`、`Write`、`file_path`、成功/失败状态。
- 渲染最终回答组件，断言 final answer 出现在最后一帧。
- 渲染失败事件，断言错误信息可见。

示例测试意图：

```ts
const events: AgentEvent[] = [
  { type: "model.step.started", step: 1 },
  {
    type: "tool.started",
    step: 1,
    call: {
      id: "call_1",
      name: "Read",
      args: { file_path: "README.md" },
    },
  },
  {
    type: "tool.finished",
    step: 1,
    call: {
      id: "call_1",
      name: "Read",
      args: { file_path: "README.md" },
    },
    ok: true,
  },
];

const { lastFrame } = render(<Timeline events={events} />);

expect(lastFrame()).toContain("Read");
expect(lastFrame()).toContain("README.md");
expect(lastFrame()).toContain("ok");
```

`event-store.ts` 必须尽量保持为纯 TS 状态转换层，单独测试：

- `run.started` 设置 run metadata。
- `model.step.started` 更新 running 状态。
- `tool.started` 追加 timeline item。
- `tool.finished` 更新对应 timeline item 的状态。
- `run.finished` 设置 final answer 和 done 状态。
- `run.failed` 设置 failed 状态和错误信息。

### TUI PTY smoke

使用 `node-pty` 启动真实 TUI。PTY smoke 不依赖真实 LLM，测试时应通过测试配置注入 fake `ModelClient` 或 fake runner，保证输出稳定：

```bash
TINKER_TEST_FAKE_MODEL=write-notes bun run tinker
```

自动输入一条 prompt，并断言终端输出中出现关键文本：

```text
running
Write
notes.txt
done
```

PTY smoke 只检查基础可用性：

- `tinker` 能启动。
- 能输入一条 prompt。
- 能看到工具调用状态。
- 能看到最终完成状态。
- `Ctrl+C` 能退出进程。

不做以下自动断言：

- 精确对齐。
- 全屏 layout。
- 颜色。
- spinner 帧。
- 复杂终端宽度下的换行。

这些留给人工手动测试。

## 路径安全

所有文件工具共用 `resolveWorkspacePath`：

- 相对路径以 workspace root 为基准解析，并拒绝通过 `..` 越出 workspace。
- 绝对路径按原路径解析，可以指向 workspace 外的文件或目录。
- 搜索结果位于 workspace 内时显示相对路径，位于 workspace 外时显示绝对路径。

```ts
export function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    return path.resolve(inputPath);
  }

  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, inputPath);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Path escapes workspace.");
  }

  return resolved;
}
```

相对路径暂不额外处理 symlink escape。

## System Prompt MVP

```text
You are a coding agent running in a local workspace.

You can use tools to read and write files.
Use Read before Write when modifying an existing file.
Write may fail if the file was not read first or changed after it was read. If that happens, call Read again and retry with the updated content.

Do not claim to run commands, tests, formatters, linters, or git operations.
You only have Read and Write.

When you are done, respond with a concise summary of what you did.
```

## 配置

第一版使用 `.env` 保存 API key。用户本地 `.env` 已按以下格式配置：

```text
API_KEY=<secret>
```

实现时只读取 key 名，不要把真实 value 写入文档、日志或 event log。`.env` 不进入版本控制。

建议支持环境变量：

```text
API_KEY
OPENAI_BASE_URL
TINKER_MODEL
TINKER_WORKSPACE
TINKER_MAX_STEPS
```

默认值：

```text
OPENAI_BASE_URL = https://api.deepseek.com
TINKER_MODEL = deepseek-v4-flash
TINKER_WORKSPACE = process.cwd()
TINKER_MAX_STEPS = 12
Read max displayed bytes = 20000
```

测试专用环境变量：

```text
TINKER_TEST_FAKE_MODEL
```

`TINKER_TEST_FAKE_MODEL` 只用于自动化测试和 PTY smoke，生产入口不依赖它。

## 建议目录结构

```text
package.json
bun.lock
tsconfig.json
.gitignore
src/
  agent/
    loop.ts
    types.ts
    runner.ts
  model/
    model-client.ts
    openai-chat-model-client.ts
    openai-chat-mapping.ts
  tools/
    registry.ts
    read.ts
    write.ts
    path-safety.ts
    types.ts
  observation/
    observation-builder.ts
  events/
    event-sink.ts
    composite-event-sink.ts
    jsonl-event-log.ts
    tui-event-stream.ts
    stdout-event-printer.ts
    types.ts
  tui/
    app.tsx
    event-store.ts
    components/
      header.tsx
      prompt-input.tsx
      timeline.tsx
      footer.tsx
  cli/
    index.ts
    run-runner.ts
    tui-runner.ts
  __tests__/
    agent-loop.test.ts
    tools.test.ts
    run-runner.test.ts
    tui-event-store.test.ts
    tui-components.test.tsx
    tui-pty-smoke.test.ts
```

## 验收用例

### 1. 读取文件并总结

用户输入：

```text
Read README.md and summarize it.
```

预期：

- 模型调用 `Read`。
- runtime 返回文件 observation。
- 模型输出总结。

### 2. 新建文件

用户输入：

```text
Create notes.txt with one line: hello.
```

预期：

- 模型调用 `Write`。
- 文件写入成功。
- 模型输出简短完成说明。

### 3. 修改已有 JSON 文件

用户输入：

```text
Change package.json name to tinker-agent.
```

预期：

- 模型先调用 `Read`。
- 模型基于内容调用 `Write`。
- runtime 使用最近一次 successful `Read` snapshot 做覆盖保护。
- 最终文件是合法 JSON。

### 4. 读取不存在文件

用户输入：

```text
Read missing.txt.
```

预期：

- 工具返回失败 observation。
- 模型解释文件不存在。

### 5. run 非交互入口

命令：

```bash
tinker run "Create notes.txt with one line: hello."
```

预期：

- 不启动 Ink。
- stdout/stderr 输出稳定文本事件。
- 最终回答输出到 stdout。
- 成功时退出码为 `0`。
- 失败时退出码非 `0`。

### 6. TUI 入口

命令：

```bash
tinker
```

自动化预期：

- 启动 Ink TUI。
- PTY smoke 可以输入一条 prompt。
- TUI 输出中出现 model step、`Read` / `Write` 工具调用状态和最终回答的关键文本。
- `Ctrl+C` 可以退出进程。

人工预期：

- 布局清晰可读。
- Header、输入区、timeline、footer 的视觉层级合理。
- 文本在常见终端宽度下不明显重叠或截断。
- 颜色、spinner、状态文案不影响阅读。

## 第一版实现顺序

1. 初始化 Bun + TypeScript 项目：`package.json`、`bun.lock`、`tsconfig.json`。
2. 定义 types。
3. 实现 `EventSink`、`CompositeEventSink`、JSONL event log。
4. 实现 path safety。
5. 实现模型可见 `Read`、`Write` 工具。
6. 实现 tool registry/runtime。
7. 实现 observation builder。
8. 实现 OpenAI Chat Completions ModelClient。
9. 实现 AgentLoop。
10. 实现 run runner。
11. 实现 Ink TUI runner。
12. 跑 `bun test`、`bun run typecheck` 和验收用例。

## 评审点

- `Write` 覆盖已有文件时，是否必须要求当前 run 内成功 `Read` 过同一路径。
- `Read` 的 `offset` 是否使用 1-based line number，是否需要兼容 0-based。
- `Read` 的 `limit` 默认值是否应该限制行数，而不是只依赖最大输出字节数。
- 是否第一版就用 `realpath` 防止 symlink escape。
- event log 是否应该默认写入 `.tinker/runs`，还是允许关闭。
- raw response 是否进入 event log；如果进入，需要注意 API 响应里可能包含敏感信息。
- 是否第一版就引入 zod 做工具参数校验。
- 是否允许模型一次返回多个 tool calls；如果允许，第一版按顺序执行。
- 是否支持 `developer` role，还是内部只保留 `system` 并在 OpenAI mapping 层转成 `developer`。
- `run` 模式输出是否使用稳定文本，还是直接输出 JSONL。
- `@inkjs/ui` 是否作为第一版直接依赖，还是只使用 `ink` 原生组件。
- `ink`、`openai`、`node-pty` 在 Bun 下的兼容性是否满足 MVP；如果 `node-pty` PTY smoke 在 Bun 下不稳定，是否允许测试脚本局部使用 Node 执行。
