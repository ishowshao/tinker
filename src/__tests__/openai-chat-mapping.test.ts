import { describe, expect, test } from "bun:test";
import {
  fromOpenAIChatCompletion,
  toOpenAIChatMessages,
} from "../model/openai-chat-mapping";
import { createTestRuntime } from "./test-runtime";

describe("openai chat mapping", () => {
  test("parses DeepSeek assistant reasoning content", () => {
    const testRuntime = createTestRuntime();
    const output = fromOpenAIChatCompletion(
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              reasoning_content: "Need to inspect the file before editing.",
              tool_calls: [
                {
                  id: "provider-call-1",
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
      },
      {
        iteration: testRuntime.iteration,
        runtimeSession: testRuntime.runtimeSession,
      },
    );

    expect(output.message).toMatchObject({
      role: "assistant",
      content: "",
      reasoningContent: "Need to inspect the file before editing.",
      toolCalls: [
        {
          providerToolCallId: "provider-call-1",
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
          id: "provider-call-1",
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
    const testRuntime = createTestRuntime();
    const [mappedMessage] = toOpenAIChatMessages(
      [
        {
          role: "assistant",
          content: "",
          reasoningContent: "Need to inspect the file before editing.",
          toolCalls: [
            testRuntime.toolCall({
              providerToolCallId: "provider-call-1",
              name: "Read",
              args: { file_path: "README.md" },
              rawArgs: '{"file_path":"README.md"}',
            }),
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
          id: "provider-call-1",
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

  test("uses provider IDs for outbound assistant and tool correlation", () => {
    const testRuntime = createTestRuntime();
    const call = testRuntime.toolCall({
      providerToolCallId: "provider-call-7",
      name: "Read",
      args: { file_path: "README.md" },
    });
    const [assistant, tool] = toOpenAIChatMessages([
      { role: "assistant", toolCalls: [call] },
      {
        role: "tool",
        toolCallId: call.toolCallId,
        providerToolCallId: call.providerToolCallId,
        name: call.name,
        content: "done",
      },
    ]);

    expect(assistant).toMatchObject({
      tool_calls: [{ id: "provider-call-7" }],
    });
    expect(tool).toMatchObject({ tool_call_id: "provider-call-7" });
  });

  test("fast-fails a provider tool call without a non-empty ID", () => {
    const testRuntime = createTestRuntime();
    expect(() =>
      fromOpenAIChatCompletion(
        {
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    type: "function",
                    function: { name: "Read", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
        {
          iteration: testRuntime.iteration,
          runtimeSession: testRuntime.runtimeSession,
        },
      ),
    ).toThrow("tool_calls[0].id");
  });
});
