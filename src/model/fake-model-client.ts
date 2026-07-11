import type { AgentMessage } from "../agent/types";
import type {
  ModelClient,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
} from "./model-client";

export class FakeModelClient implements ModelClient {
  private steps = 0;

  constructor(private readonly mode: string) {}

  async request(
    input: ModelRequestInput,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.steps += 1;

    if (this.mode === "write-notes") {
      return this.writeNotes(input, options);
    }

    return {
      message: {
        role: "assistant",
        content: `Fake model received: ${lastUserMessage(input.messages)}`,
      },
      finishReason: "stop",
    };
  }

  private writeNotes(
    input: ModelRequestInput,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    const sawToolResult = input.messages.some((message) => message.role === "tool");

    if (!sawToolResult) {
      if (options.identity === undefined) {
        throw new Error("Fake tool call requires an iteration identity context.");
      }
      return {
        message: {
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
        finishReason: "tool_calls",
      };
    }

    return {
      message: {
        role: "assistant",
        content: "Created notes.txt with one line: hello.",
      },
      finishReason: "stop",
    };
  }
}

function lastUserMessage(messages: AgentMessage[]): string {
  const users = messages.filter(
    (message): message is { role: "user"; content: string } => message.role === "user",
  );
  return users.at(-1)?.content ?? "";
}
