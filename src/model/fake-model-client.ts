import type { AgentMessage } from "../agent/types";
import type { ModelClient, ModelStepInput, ModelStepOutput } from "./model-client";
import { createUuidV7 } from "../ids/uuid-v7";

export class FakeModelClient implements ModelClient {
  private steps = 0;

  constructor(private readonly mode: string) {}

  async step(input: ModelStepInput): Promise<ModelStepOutput> {
    this.steps += 1;

    if (this.mode === "write-notes") {
      return this.writeNotes(input);
    }

    return {
      message: {
        role: "assistant",
        content: `Fake model received: ${lastUserMessage(input.messages)}`,
      },
      finishReason: "stop",
    };
  }

  private writeNotes(input: ModelStepInput): ModelStepOutput {
    const sawToolResult = input.messages.some((message) => message.role === "tool");

    if (!sawToolResult) {
      return {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: createUuidV7(),
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
