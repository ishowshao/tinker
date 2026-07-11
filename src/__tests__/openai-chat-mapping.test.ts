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
        usage: {
          prompt_tokens: 9,
          completion_tokens: 3,
          total_tokens: 12,
        },
      },
      {
        identity: {
          iteration: testRuntime.iteration,
          runtimeSession: testRuntime.runtimeSession,
        },
        provider: "test-provider",
        model: "test-model",
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
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
        {
          identity: {
            iteration: testRuntime.iteration,
            runtimeSession: testRuntime.runtimeSession,
          },
          provider: "test-provider",
          model: "test-model",
        },
      ),
    ).toThrow("tool_calls[0].id");
  });

  test("normalizes provider usage", () => {
    const output = fromOpenAIChatCompletion(
      {
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "done" },
          },
        ],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 3,
          total_tokens: 12,
        },
      },
      { provider: "test-provider", model: "test-model" },
    );

    expect(output.usage).toEqual({
      promptTokens: 9,
      completionTokens: 3,
      totalTokens: 12,
    });
  });

  test("normalizes cache and reasoning usage variants", () => {
    const deepSeek = fromOpenAIChatCompletion(
      completionWithUsage({
        prompt_tokens: 90,
        completion_tokens: 10,
        total_tokens: 100,
        prompt_cache_hit_tokens: 70,
        prompt_cache_miss_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 6 },
      }),
      { provider: "deepseek", model: "test-model" },
    );
    expect(deepSeek.usage).toEqual({
      promptTokens: 90,
      completionTokens: 10,
      totalTokens: 100,
      promptCacheHitTokens: 70,
      promptCacheMissTokens: 20,
      reasoningTokens: 6,
    });

    const openAi = fromOpenAIChatCompletion(
      completionWithUsage({
        prompt_tokens: 90,
        completion_tokens: 10,
        total_tokens: 100,
        prompt_tokens_details: { cached_tokens: 70 },
      }),
      { provider: "openai", model: "test-model" },
    );
    expect(openAi.usage).toMatchObject({
      promptCacheHitTokens: 70,
      promptCacheMissTokens: 20,
    });
  });

  test("requires internally consistent provider usage before parsing tool calls", () => {
    expect(() =>
      fromOpenAIChatCompletion(completionWithUsage(undefined), {
        provider: "test-provider",
        model: "test-model",
      }),
    ).toThrow("usage is required");

    for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
      const usage: Record<string, unknown> = {
        prompt_tokens: 9,
        completion_tokens: 3,
        total_tokens: 12,
      };
      delete usage[field];
      expect(() =>
        fromOpenAIChatCompletion(completionWithUsage(usage), {
          provider: "test-provider",
          model: "test-model",
        }),
      ).toThrow(`usage.${field} is required`);
    }

    expect(() =>
      fromOpenAIChatCompletion(
        completionWithUsage({
          prompt_tokens: 9,
          completion_tokens: 3,
          total_tokens: 11,
        }),
        { provider: "test-provider", model: "test-model" },
      ),
    ).toThrow("usage.total_tokens must equal");
  });

  test("fast-fails inconsistent optional usage details", () => {
    expect(() =>
      fromOpenAIChatCompletion(
        completionWithUsage({
          prompt_tokens: 9,
          completion_tokens: 3,
          total_tokens: 12,
          prompt_cache_hit_tokens: 4,
        }),
        { provider: "test-provider", model: "test-model" },
      ),
    ).toThrow("prompt_cache_miss_tokens must be provided together");

    expect(() =>
      fromOpenAIChatCompletion(
        completionWithUsage({
          prompt_tokens: 9,
          completion_tokens: 3,
          total_tokens: 12,
          prompt_cache_hit_tokens: 4,
          prompt_cache_miss_tokens: 5,
          prompt_tokens_details: { cached_tokens: 3 },
        }),
        { provider: "test-provider", model: "test-model" },
      ),
    ).toThrow("conflicts with usage.prompt_tokens_details.cached_tokens");

    expect(() =>
      fromOpenAIChatCompletion(
        completionWithUsage({
          prompt_tokens: 9,
          completion_tokens: 3,
          total_tokens: 12,
          completion_tokens_details: { reasoning_tokens: 4 },
        }),
        { provider: "test-provider", model: "test-model" },
      ),
    ).toThrow("reasoning_tokens must not exceed usage.completion_tokens");
  });

  test("fast-fails malformed provider responses with provider and model context", () => {
    expect(() =>
      fromOpenAIChatCompletion(
        { choices: [] },
        { provider: "test-provider", model: "test-model" },
      ),
    ).toThrow(
      "Invalid provider response (provider=test-provider, model=test-model): choices[0] is missing",
    );

    expect(() =>
      fromOpenAIChatCompletion(
        { choices: [{ finish_reason: "stop" }] },
        { provider: "test-provider", model: "test-model" },
      ),
    ).toThrow("choices[0].message must be a non-empty object");

    expect(() =>
      fromOpenAIChatCompletion(
        {
          choices: [
            {
              message: { role: "assistant", content: "" },
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
        { provider: "test-provider", model: "test-model" },
      ),
    ).toThrow("choices[0].message has neither non-empty text nor tool calls");

    expect(() =>
      fromOpenAIChatCompletion(
        {
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "custom",
                    function: { name: "Read", arguments: "{}" },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
        {
          identity: createTestRuntime(),
          provider: "test-provider",
          model: "test-model",
        },
      ),
    ).toThrow('choices[0].message.tool_calls[0].type must be "function"');

    expect(() =>
      fromOpenAIChatCompletion(
        {
          choices: [
            {
              message: { role: "assistant", content: "done" },
            },
          ],
          usage: {
            prompt_tokens: 9,
            completion_tokens: 3,
            total_tokens: "12",
          },
        },
        { provider: "test-provider", model: "test-model" },
      ),
    ).toThrow("usage.total_tokens must be a non-negative integer");
  });
});

function completionWithUsage(usage: unknown): Record<string, unknown> {
  return {
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: "done" },
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  };
}
