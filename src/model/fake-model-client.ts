import type { AgentMessage, AssistantMessage } from "../agent/types";
import { cancellationError } from "../agent/turn-cancellation";
import type { ModelContextBudget } from "./model-context-profile";
import type {
  ModelClient,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
  PreparedPromptSegment,
} from "./model-client";
import { sha256, stableJsonStringify } from "./model-request-preflight";
import { estimatePromptSegments } from "./token-estimator";

export class FakeModelClient implements ModelClient {
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
        adapter: "fake-v1",
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

    return outputWithUsage(
      prepared,
      {
        role: "assistant",
        content: `Fake model received: ${lastUserMessage(input.messages)}`,
      },
      "stop",
    );
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
