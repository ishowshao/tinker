import { describe, expect, test } from "bun:test";
import {
  fromOpenAIChatCompletion,
  toOpenAIChatMessages,
} from "../model/openai-chat-mapping";

describe("openai chat mapping", () => {
  test("parses DeepSeek assistant reasoning content", () => {
    const output = fromOpenAIChatCompletion({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            reasoning_content: "Need to inspect the file before editing.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "Read",
                  arguments: '{"file_path":"README.md"}',
                },
              },
            ],
          },
        },
      ],
      usage: { total_tokens: 12 },
    });

    expect(output.message).toEqual({
      role: "assistant",
      content: "",
      reasoningContent: "Need to inspect the file before editing.",
      toolCalls: [
        {
          id: "call_1",
          name: "Read",
          args: { file_path: "README.md" },
          rawArgs: '{"file_path":"README.md"}',
        },
      ],
    });

    const [mappedMessage] = toOpenAIChatMessages([output.message]);
    const mappedRecord = mappedMessage as unknown as Record<string, unknown>;

    expect(mappedRecord).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "Read",
            arguments: '{"file_path":"README.md"}',
          },
        },
      ],
    });
    expect("reasoning_content" in mappedRecord).toBe(false);
  });

  test("includes DeepSeek assistant reasoning content when enabled", () => {
    const [mappedMessage] = toOpenAIChatMessages(
      [
        {
          role: "assistant",
          content: "",
          reasoningContent: "Need to inspect the file before editing.",
          toolCalls: [
            {
              id: "call_1",
              name: "Read",
              args: { file_path: "README.md" },
              rawArgs: '{"file_path":"README.md"}',
            },
          ],
        },
      ],
      { includeReasoningContent: true },
    );
    const mappedRecord = mappedMessage as unknown as Record<string, unknown>;

    expect(mappedRecord).toEqual({
      role: "assistant",
      content: "",
      reasoning_content: "Need to inspect the file before editing.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "Read",
            arguments: '{"file_path":"README.md"}',
          },
        },
      ],
    });
  });

  test("omits reasoning_content when assistant reasoning is absent", () => {
    const [mappedMessage] = toOpenAIChatMessages([
      {
        role: "assistant",
        content: "Done.",
      },
    ]);
    const mappedRecord = mappedMessage as unknown as Record<string, unknown>;

    expect(mappedRecord).toEqual({
      role: "assistant",
      content: "Done.",
      tool_calls: undefined,
    });
    expect("reasoning_content" in mappedRecord).toBe(false);
  });
});
