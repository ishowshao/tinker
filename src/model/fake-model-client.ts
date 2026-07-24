import type { AgentMessage, AssistantMessage } from "../agent/types";
import { cancellationError } from "../agent/turn-cancellation";
import type { ModelContextBudget } from "./model-context-profile";
import type {
  ModelClient,
  ModelMessageProtocol,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
  PreparedPromptSegment,
} from "./model-client";
import { sha256, stableJsonStringify } from "./model-request-preflight";
import { estimatePromptSegments } from "./token-estimator";

export class FakeModelClient implements ModelClient {
  readonly inputModalities = Object.freeze(["text"] as const);
  readonly messageProtocol: ModelMessageProtocol = Object.freeze({
    adapter: "fake",
    serializationVersion: "fake-v1",
  });
  private steps = 0;
  private readonly preparedInputs = new WeakMap<object, ModelRequestInput>();

  constructor(
    private readonly mode: string,
    private readonly options: {
      model: string;
      contextBudget: ModelContextBudget;
    },
  ) {}

  prepare(input: ModelRequestInput): PreparedModelRequest {
    const toolSegments = input.tools.map(
      (tool): PreparedPromptSegment => ({
        kind: "tool_schema",
        normalizedText: stableJsonStringify(tool),
      }),
    );
    const messageSegments = input.messages.map(toPromptSegment);
    const requestConfigHash = sha256(
      stableJsonStringify({
        adapter: this.messageProtocol.adapter,
        serializationVersion: this.messageProtocol.serializationVersion,
        mode: this.mode,
        model: this.options.model,
        requestMaxOutputTokens: this.options.contextBudget.requestMaxOutputTokens,
      }),
    );
    const prepared: PreparedModelRequest = Object.freeze({
      provider: "fake",
      model: this.options.model,
      payload: Object.freeze({
        messages: Object.freeze([...input.messages]),
        tools: Object.freeze([...input.tools]),
        maxTokens: this.options.contextBudget.requestMaxOutputTokens,
      }),
      promptSegments: Object.freeze([...toolSegments, ...messageSegments]),
      requestConfigHash,
      toolSchemaHash: sha256(
        toolSegments.map((segment) => segment.normalizedText).join("\n"),
      ),
      requestMaxOutputTokens: this.options.contextBudget.requestMaxOutputTokens,
      mediaOccurrenceCount: 0,
      assistantReplaySegments: (message: AssistantMessage) => [
        toPromptSegment(message),
      ],
    });
    this.preparedInputs.set(prepared, {
      messages: [...input.messages],
      tools: [...input.tools],
    });
    return prepared;
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const input = this.preparedInputs.get(prepared);
    if (input === undefined) {
      throw new Error("Fake model request was not prepared by this client.");
    }
    this.steps += 1;

    if (this.mode === "write-notes") {
      return this.writeNotes(input, prepared, options);
    }
    if (this.mode === "wait-for-cancel") {
      return waitForCancellation(options.signal);
    }
    if (this.mode === "recall-smoke") {
      return this.recallSmoke(input, prepared, options);
    }
    if (this.mode === "pty-echo-history") {
      return this.ptyEchoHistory(input, prepared);
    }
    if (this.mode === "pty-cancel-then-echo") {
      return this.ptyCancelThenEcho(input, prepared, options);
    }
    if (this.mode === "pty-tool-chain") {
      return this.ptyToolChain(input, prepared, options);
    }
    if (this.mode === "pty-background-task") {
      return this.ptyBackgroundTask(input, prepared, options);
    }
    if (this.mode === "pty-resume") {
      return this.ptyResume(input, prepared, options);
    }
    if (this.mode === "pty-interrupted-tool") {
      return this.ptyInterruptedTool(input, prepared, options);
    }
    if (this.mode === "pty-fail-once") {
      return this.ptyFailOnce(input, prepared);
    }

    return outputWithUsage(
      prepared,
      {
        role: "assistant",
        content: `Fake model received: ${lastUserMessage(input.messages)}`,
      },
      "stop",
    );
  }

  private ptyEchoHistory(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
  ): ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_FIRST") {
      return textOutput(prepared, "PTY_TURN_ONE_DONE");
    }
    if (prompt === "PTY_SECOND") {
      requireMessage(input.messages, "user", "PTY_FIRST");
      requireMessage(input.messages, "assistant", "PTY_TURN_ONE_DONE");
      return textOutput(prepared, "PTY_TURN_TWO_DONE");
    }
    throw new Error(`Unexpected pty-echo-history prompt: ${JSON.stringify(prompt)}.`);
  }

  private ptyCancelThenEcho(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> | ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_CANCEL_BLOCK") {
      return waitForCancellation(options.signal);
    }
    if (prompt === "PTY_AFTER_CANCEL") {
      requireMessage(input.messages, "user", "PTY_CANCEL_BLOCK");
      return textOutput(prepared, "PTY_AFTER_CANCEL_DONE");
    }
    throw new Error(
      `Unexpected pty-cancel-then-echo prompt: ${JSON.stringify(prompt)}.`,
    );
  }

  private ptyToolChain(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    requireTools(input, ["Write", "Edit", "Bash"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_TOOL_FAILURE") {
      const bash = toolMessagesAfterLastUser(input.messages).find(
        (message) => message.name === "Bash",
      );
      if (bash === undefined) {
        return toolCallOutput(prepared, options, "Bash", {
          command: "printf 'PTY_TOOL_FAILURE_OUTPUT\\n' >&2; exit 7",
          description: "Produce expected PTY failure",
        });
      }
      if (
        !bash.content.includes("Bash failed") ||
        !bash.content.includes("exitCode=7") ||
        !bash.content.includes("PTY_TOOL_FAILURE_OUTPUT")
      ) {
        throw new Error("PTY Bash failure branch returned an unexpected result.");
      }
      return textOutput(prepared, "PTY_TOOL_FAILURE_HANDLED");
    }
    if (prompt === "PTY_AFTER_TOOL_FAILURE") {
      requireToolMessage(input.messages, "Bash", "exitCode=7");
      requireMessage(input.messages, "assistant", "PTY_TOOL_FAILURE_HANDLED");
      return textOutput(prepared, "PTY_AFTER_TOOL_FAILURE_DONE");
    }
    if (prompt === "PTY_TOOL_CHAIN_VERIFY") {
      requireToolMessage(input.messages, "Write", "Write succeeded");
      requireToolMessage(input.messages, "Edit", "Edit succeeded");
      requireToolMessage(input.messages, "Bash", "PTY_BASH_OK:beta");
      requireMessage(input.messages, "assistant", "PTY_TOOL_CHAIN_DONE");
      return textOutput(prepared, "PTY_TOOL_CHAIN_VERIFIED");
    }
    if (prompt !== "PTY_TOOL_CHAIN_START") {
      throw new Error(`Unexpected pty-tool-chain prompt: ${JSON.stringify(prompt)}.`);
    }

    const tools = toolMessagesAfterLastUser(input.messages);
    const write = tools.find((message) => message.name === "Write");
    if (write === undefined) {
      return toolCallOutput(prepared, options, "Write", {
        file_path: "pty-tool-chain.txt",
        content: "alpha\n",
      });
    }
    if (!write.content.includes("Write succeeded")) {
      throw new Error("PTY Write tool did not succeed.");
    }

    const edit = tools.find((message) => message.name === "Edit");
    if (edit === undefined) {
      return toolCallOutput(prepared, options, "Edit", {
        file_path: "pty-tool-chain.txt",
        old_string: "alpha",
        new_string: "beta",
      });
    }
    if (!edit.content.includes("Edit succeeded")) {
      throw new Error("PTY Edit tool did not succeed.");
    }

    const bash = tools.find((message) => message.name === "Bash");
    if (bash === undefined) {
      return toolCallOutput(prepared, options, "Bash", {
        command: "printf 'PTY_BASH_OK:%s\\n' \"$(cat pty-tool-chain.txt)\"",
        description: "Verify edited PTY fixture",
      });
    }
    if (
      !bash.content.includes("Bash completed") ||
      !bash.content.includes("PTY_BASH_OK:beta")
    ) {
      throw new Error("PTY Bash tool did not verify the edited file.");
    }
    return textOutput(prepared, "PTY_TOOL_CHAIN_DONE");
  }

  private ptyBackgroundTask(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    requireTools(input, ["Bash", "TaskOutput", "TaskStop"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt !== "PTY_BACKGROUND_STOP" && prompt !== "PTY_BACKGROUND_QUIT") {
      throw new Error(
        `Unexpected pty-background-task prompt: ${JSON.stringify(prompt)}.`,
      );
    }

    const tools = toolMessagesAfterLastUser(input.messages);
    const bash = tools.find((message) => message.name === "Bash");
    if (bash === undefined) {
      return toolCallOutput(prepared, options, "Bash", {
        command:
          "printf '%s\\n' \"$$\" > pty-background.pid; printf 'PTY_BACKGROUND_READY\\n'; while :; do sleep 1; done",
        description: "Run PTY background fixture",
        run_in_background: true,
      });
    }
    if (!bash.content.includes("Bash command is running in background")) {
      throw new Error("PTY Bash task did not enter the background.");
    }
    const taskId = requireObservationValue(bash.content, "taskId");

    if (prompt === "PTY_BACKGROUND_QUIT") {
      return textOutput(prepared, "PTY_BACKGROUND_RUNNING");
    }

    const outputs = tools.filter((message) => message.name === "TaskOutput");
    const output = outputs.at(-1);
    if (output === undefined || !output.content.includes("PTY_BACKGROUND_READY")) {
      if (outputs.length >= 20) {
        throw new Error("PTY background task did not produce its ready marker.");
      }
      return toolCallOutput(prepared, options, "TaskOutput", {
        task_id: taskId,
      });
    }
    if (!output.content.includes(`taskId=${taskId}`)) {
      throw new Error("PTY TaskOutput returned the wrong task.");
    }

    const stop = tools.find((message) => message.name === "TaskStop");
    if (stop === undefined) {
      return toolCallOutput(prepared, options, "TaskStop", {
        task_id: taskId,
      });
    }
    if (
      !stop.content.includes(`taskId=${taskId}`) ||
      !stop.content.includes("status=killed")
    ) {
      throw new Error("PTY TaskStop did not kill the background task.");
    }
    return textOutput(prepared, "PTY_BACKGROUND_STOPPED");
  }

  private ptyResume(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    requireTools(input, ["Write"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_RESUME_CONTINUE") {
      requireMessage(input.messages, "user", "PTY_RESUME_SEED");
      requireMessage(input.messages, "assistant", "PTY_RESUME_SEED_DONE");
      requireToolMessage(input.messages, "Write", "Write succeeded");
      return textOutput(prepared, "PTY_RESUME_CONTINUED");
    }
    if (prompt !== "PTY_RESUME_SEED") {
      throw new Error(`Unexpected pty-resume prompt: ${JSON.stringify(prompt)}.`);
    }
    const write = toolMessagesAfterLastUser(input.messages).find(
      (message) => message.name === "Write",
    );
    if (write === undefined) {
      return toolCallOutput(prepared, options, "Write", {
        file_path: "pty-resume.txt",
        content: "PTY_RESUME_SIDE_EFFECT\n",
      });
    }
    if (!write.content.includes("Write succeeded")) {
      throw new Error("PTY resume seed Write did not succeed.");
    }
    return textOutput(prepared, "PTY_RESUME_SEED_DONE");
  }

  private ptyInterruptedTool(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> | ModelRequestOutput {
    requireTools(input, ["Write"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_INTERRUPT_RECOVER") {
      requireMessage(input.messages, "user", "PTY_INTERRUPT_START");
      requireToolMessage(input.messages, "Write", "Write succeeded");
      return textOutput(prepared, "PTY_INTERRUPT_RECOVERED");
    }
    if (prompt !== "PTY_INTERRUPT_START") {
      throw new Error(
        `Unexpected pty-interrupted-tool prompt: ${JSON.stringify(prompt)}.`,
      );
    }
    const write = toolMessagesAfterLastUser(input.messages).find(
      (message) => message.name === "Write",
    );
    if (write === undefined) {
      return toolCallOutput(prepared, options, "Write", {
        file_path: "pty-interrupted.txt",
        content: "PTY_INTERRUPT_SIDE_EFFECT\n",
      });
    }
    if (!write.content.includes("Write succeeded")) {
      throw new Error("PTY interrupted Write did not succeed.");
    }
    return waitForCancellation(options.signal);
  }

  private ptyFailOnce(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
  ): ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_FAIL_FIRST") {
      throw new Error("PTY_FAKE_PROVIDER_FAILURE");
    }
    if (prompt === "PTY_FAIL_RECOVER") {
      requireMessage(input.messages, "user", "PTY_FAIL_FIRST");
      return textOutput(prepared, "PTY_FAIL_RECOVERED");
    }
    throw new Error(`Unexpected pty-fail-once prompt: ${JSON.stringify(prompt)}.`);
  }

  private writeNotes(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    const sawToolResult = input.messages.some((message) => message.role === "tool");

    if (!sawToolResult) {
      if (options.identity === undefined) {
        throw new Error("Fake tool call requires an iteration identity context.");
      }
      return outputWithUsage(
        prepared,
        {
          role: "assistant",
          content: "I will create notes.txt.",
          toolCalls: [
            {
              ...options.identity.runtimeSession.createToolCall(
                options.identity.iteration,
                1,
              ),
              providerToolCallId: "fake-write-notes-1",
              name: "Write",
              args: {
                file_path: "notes.txt",
                content: "hello.\n",
              },
            },
          ],
        },
        "tool_calls",
      );
    }

    return outputWithUsage(
      prepared,
      {
        role: "assistant",
        content: "Created notes.txt with one line: hello.",
      },
      "stop",
    );
  }

  private recallSmoke(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    if (options.identity === undefined) {
      throw new Error("Fake Recall call requires an iteration identity context.");
    }
    const lastUserIndex = lastMessageIndex(input.messages, "user");
    const latestRecallResult = input.messages
      .slice(lastUserIndex + 1)
      .reverse()
      .find(
        (message): message is Extract<AgentMessage, { role: "tool" }> =>
          message.role === "tool" && message.name === "Recall",
      );
    if (latestRecallResult === undefined) {
      return outputWithUsage(
        prepared,
        {
          role: "assistant",
          toolCalls: [
            {
              ...options.identity.runtimeSession.createToolCall(
                options.identity.iteration,
                1,
              ),
              providerToolCallId: "fake-recall-search-1",
              name: "Recall",
              args: { mode: "search", query: "recall-smoke-marker" },
            },
          ],
        },
        "tool_calls",
      );
    }
    if (latestRecallResult.content.startsWith("Recall searched")) {
      const source = latestRecallResult.content.match(
        /^source=(ctx:\/\/message\/[0-9a-f-]+)$/m,
      )?.[1];
      if (source === undefined) {
        throw new Error("Fake Recall search did not return a source.");
      }
      return outputWithUsage(
        prepared,
        {
          role: "assistant",
          toolCalls: [
            {
              ...options.identity.runtimeSession.createToolCall(
                options.identity.iteration,
                1,
              ),
              providerToolCallId: "fake-recall-get-1",
              name: "Recall",
              args: { mode: "get", source },
            },
          ],
        },
        "tool_calls",
      );
    }
    if (!latestRecallResult.content.includes("recall-smoke-marker")) {
      throw new Error("Fake Recall get did not recover the expected marker.");
    }
    return outputWithUsage(
      prepared,
      {
        role: "assistant",
        content: "Recall search and get completed.",
      },
      "stop",
    );
  }
}

function outputWithUsage(
  prepared: PreparedModelRequest,
  message: AssistantMessage,
  finishReason: string,
): ModelRequestOutput {
  const promptTokens = estimatePromptSegments(prepared.promptSegments).totalTokens;
  const completionTokens = Math.max(
    1,
    estimatePromptSegments(prepared.assistantReplaySegments(message)).totalTokens,
  );
  return {
    message,
    finishReason,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}

function textOutput(
  prepared: PreparedModelRequest,
  content: string,
): ModelRequestOutput {
  return outputWithUsage(
    prepared,
    {
      role: "assistant",
      content,
    },
    "stop",
  );
}

function toolCallOutput(
  prepared: PreparedModelRequest,
  options: ModelRequestOptions,
  name: string,
  args: Readonly<Record<string, unknown>>,
): ModelRequestOutput {
  if (options.identity === undefined) {
    throw new Error(`Fake ${name} call requires an iteration identity context.`);
  }
  const identity = options.identity;
  return outputWithUsage(
    prepared,
    {
      role: "assistant",
      toolCalls: [
        {
          ...identity.runtimeSession.createToolCall(identity.iteration, 1),
          providerToolCallId: `fake-${name.toLowerCase()}-${identity.iteration.iterationNumber}`,
          name,
          args,
        },
      ],
    },
    "tool_calls",
  );
}

function waitForCancellation(signal: AbortSignal): Promise<ModelRequestOutput> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(cancellationError(signal));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function lastUserMessage(messages: AgentMessage[]): string {
  const users = messages.filter(
    (message): message is { role: "user"; content: string } => message.role === "user",
  );
  return users.at(-1)?.content ?? "";
}

function toolMessagesAfterLastUser(
  messages: AgentMessage[],
): Array<Extract<AgentMessage, { role: "tool" }>> {
  return messages
    .slice(lastMessageIndex(messages, "user") + 1)
    .filter(
      (message): message is Extract<AgentMessage, { role: "tool" }> =>
        message.role === "tool",
    );
}

function requireMessage(
  messages: AgentMessage[],
  role: "user" | "assistant",
  content: string,
): void {
  const found = messages.some(
    (message) =>
      message.role === role &&
      typeof message.content === "string" &&
      message.content.includes(content),
  );
  if (!found) {
    throw new Error(`Fake PTY context is missing ${role} content ${content}.`);
  }
}

function requireToolMessage(
  messages: AgentMessage[],
  name: string,
  content: string,
): void {
  const found = messages.some(
    (message) =>
      message.role === "tool" &&
      message.name === name &&
      message.content.includes(content),
  );
  if (!found) {
    throw new Error(`Fake PTY context is missing ${name} tool content ${content}.`);
  }
}

function requireTools(input: ModelRequestInput, names: readonly string[]): void {
  const available = new Set(input.tools.map((tool) => tool.name));
  const missing = names.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Fake PTY model is missing tools: ${missing.join(", ")}.`);
  }
}

function requireObservationValue(content: string, name: string): string {
  const value = content.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`Fake PTY tool observation is missing ${name}.`);
  }
  return value;
}

function lastMessageIndex(
  messages: AgentMessage[],
  role: AgentMessage["role"],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) {
      return index;
    }
  }
  return -1;
}

function toPromptSegment(message: AgentMessage): PreparedPromptSegment {
  return {
    kind:
      message.role === "system"
        ? "kernel"
        : message.role === "user"
          ? "user"
          : message.role,
    normalizedText: stableJsonStringify(message),
  };
}
