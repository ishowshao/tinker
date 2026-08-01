import { describe, expect, test } from "bun:test";
import { fromOpenAIChatCompletion } from "../model/openai-chat-mapping";
import {
  accumulateOpenAIChatCompletionChunks,
  OpenAIChatCompletionStreamAccumulator,
} from "../model/openai-chat-stream";
import { ProviderResponseError } from "../model/model-client";

const PROVIDER = { provider: "test-provider", model: "test-model" };

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: null, ...extra }],
  };
}

const USAGE = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
};

const USAGE_ONLY_CHUNK = {
  object: "chat.completion.chunk",
  choices: [],
  usage: USAGE,
};

describe("accumulateOpenAIChatCompletionChunks", () => {
  test("validates and returns each raw content delta before finish", () => {
    const accumulator = new OpenAIChatCompletionStreamAccumulator(PROVIDER);

    expect(accumulator.push(chunk({ role: "assistant", content: "Hel" }))).toBe("Hel");
    expect(accumulator.push(chunk({ reasoning_content: "hidden" }))).toBeUndefined();
    expect(accumulator.push(USAGE_ONLY_CHUNK)).toBeUndefined();
    expect(accumulator.push(chunk({ content: "lo" }))).toBe("lo");

    expect(accumulator.finish()).toMatchObject({
      choices: [{ message: { content: "Hello", reasoning_content: "hidden" } }],
      usage: USAGE,
    });
  });

  test("assembles text deltas and trailing usage into a completion", () => {
    const completion = accumulateOpenAIChatCompletionChunks(
      [
        chunk({ role: "assistant", content: "Hel" }),
        chunk({ content: "lo" }),
        {
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
        USAGE_ONLY_CHUNK,
      ],
      PROVIDER,
    );

    expect(completion).toEqual({
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello" },
          finish_reason: "stop",
        },
      ],
      usage: USAGE,
    });

    const output = fromOpenAIChatCompletion(completion, PROVIDER);
    expect(output.message.content).toBe("Hello");
    expect(output.finishReason).toBe("stop");
    expect(output.usage.totalTokens).toBe(15);
  });

  test("accumulates reasoning content separately from content", () => {
    const completion = accumulateOpenAIChatCompletionChunks(
      [
        chunk({ role: "assistant", reasoning_content: "thinking " }),
        chunk({ reasoning_content: "hard" }),
        chunk({ content: "answer" }),
        USAGE_ONLY_CHUNK,
      ],
      PROVIDER,
    );

    const output = fromOpenAIChatCompletion(completion, PROVIDER);
    expect(output.message.reasoningContent).toBe("thinking hard");
    expect(output.message.content).toBe("answer");
  });

  test("preserves a consistent resolved model identity", () => {
    const completion = accumulateOpenAIChatCompletionChunks(
      [
        { ...chunk({ role: "assistant", content: "ok" }), model: "snapshot-42" },
        { ...USAGE_ONLY_CHUNK, model: "snapshot-42" },
      ],
      PROVIDER,
    );
    expect(completion.model).toBe("snapshot-42");
  });

  test("fast-fails conflicting resolved model identities", () => {
    expect(() =>
      accumulateOpenAIChatCompletionChunks(
        [
          { ...chunk({ role: "assistant", content: "ok" }), model: "snapshot-a" },
          { ...USAGE_ONLY_CHUNK, model: "snapshot-b" },
        ],
        PROVIDER,
      ),
    ).toThrow('conflicts with previously streamed model "snapshot-a"');
  });

  test("merges tool call fragments by index", () => {
    const completion = accumulateOpenAIChatCompletionChunks(
      [
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "read", arguments: "" },
            },
          ],
        }),
        chunk({
          tool_calls: [{ index: 0, function: { arguments: '{"path":' } }],
        }),
        chunk({
          tool_calls: [
            { index: 0, function: { arguments: '"a.ts"}' } },
            {
              index: 1,
              id: "call-2",
              type: "function",
              function: { name: "grep", arguments: "{}" },
            },
          ],
        }),
        USAGE_ONLY_CHUNK,
      ],
      PROVIDER,
    );

    expect(completion.choices).toEqual([
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read", arguments: '{"path":"a.ts"}' },
            },
            {
              id: "call-2",
              type: "function",
              function: { name: "grep", arguments: "{}" },
            },
          ],
        },
        finish_reason: null,
      },
    ]);
  });

  test("keeps the last non-null finish reason", () => {
    const completion = accumulateOpenAIChatCompletionChunks(
      [
        chunk({ content: "x" }),
        {
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
        USAGE_ONLY_CHUNK,
      ],
      PROVIDER,
    );
    const choice = (completion.choices as Record<string, unknown>[])[0];
    expect(choice?.finish_reason).toBe("tool_calls");
  });

  test("produces a completion without usage when the stream omits it", () => {
    const completion = accumulateOpenAIChatCompletionChunks(
      [chunk({ role: "assistant", content: "hi" })],
      PROVIDER,
    );
    expect(completion.usage).toBeUndefined();
    expect(() => fromOpenAIChatCompletion(completion, PROVIDER)).toThrow(
      "usage is required",
    );
  });

  test("does not classify reasoning without a terminal stop as retryable", () => {
    const completion = accumulateOpenAIChatCompletionChunks(
      [chunk({ role: "assistant", reasoning_content: "thinking" }), USAGE_ONLY_CHUNK],
      PROVIDER,
    );
    const choice = (completion.choices as Record<string, unknown>[])[0];
    expect(choice?.finish_reason).toBeNull();

    const error = captureError(() => fromOpenAIChatCompletion(completion, PROVIDER));
    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).code).toBe("invalid_provider_response");
    expect((error as ProviderResponseError).diagnostics).toMatchObject({
      reasoningChars: 8,
      toolCallCount: 0,
    });
  });

  test("does not classify a resource finish as reasoning-only", () => {
    const completion = accumulateOpenAIChatCompletionChunks(
      [
        chunk({ role: "assistant", reasoning_content: "thinking" }),
        chunk({}, { finish_reason: "insufficient_system_resource" }),
        USAGE_ONLY_CHUNK,
      ],
      PROVIDER,
    );
    const error = captureError(() => fromOpenAIChatCompletion(completion, PROVIDER));

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).code).toBe("invalid_provider_response");
    expect((error as ProviderResponseError).diagnostics.finishReason).toBe(
      "insufficient_system_resource",
    );
  });

  test("fast-fails an empty stream", () => {
    expect(() => accumulateOpenAIChatCompletionChunks([], PROVIDER)).toThrow(
      "chunks must not be empty",
    );
  });

  test("fast-fails a non-zero choice index", () => {
    expect(() =>
      accumulateOpenAIChatCompletionChunks(
        [
          {
            object: "chat.completion.chunk",
            choices: [{ index: 1, delta: { content: "x" } }],
          },
        ],
        PROVIDER,
      ),
    ).toThrow("choices[0].index must be 0");
  });

  test("fast-fails a tool call fragment that skips an index", () => {
    expect(() =>
      accumulateOpenAIChatCompletionChunks(
        [
          chunk({
            tool_calls: [
              { index: 1, id: "call-2", function: { name: "grep", arguments: "" } },
            ],
          }),
        ],
        PROVIDER,
      ),
    ).toThrow("skips tool call index 0");
  });

  test("fast-fails conflicting tool call ids at the same index", () => {
    expect(() =>
      accumulateOpenAIChatCompletionChunks(
        [
          chunk({ tool_calls: [{ index: 0, id: "call-1", function: { name: "a" } }] }),
          chunk({ tool_calls: [{ index: 0, id: "call-9" }] }),
        ],
        PROVIDER,
      ),
    ).toThrow('conflicts with previously streamed id "call-1"');
  });

  test("fast-fails a non-string content delta", () => {
    expect(() =>
      accumulateOpenAIChatCompletionChunks([chunk({ content: 42 })], PROVIDER),
    ).toThrow("delta.content must be a string or null");
  });

  test("replaces repeated tool call name fragments instead of concatenating", () => {
    const completion = accumulateOpenAIChatCompletionChunks(
      [
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "Read", arguments: '{"path"' },
            },
          ],
        }),
        chunk({
          tool_calls: [{ index: 0, function: { name: "Read", arguments: ':"a.ts"}' } }],
        }),
        USAGE_ONLY_CHUNK,
      ],
      PROVIDER,
    );

    const choice = (completion.choices as Record<string, unknown>[])[0];
    const message = choice?.message as Record<string, unknown>;
    expect(message.tool_calls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: { name: "Read", arguments: '{"path":"a.ts"}' },
      },
    ]);
  });

  test("omits role and type the provider never streamed so the mapper rejects them", () => {
    const withoutRole = accumulateOpenAIChatCompletionChunks(
      [chunk({ content: "hi" }), USAGE_ONLY_CHUNK],
      PROVIDER,
    );
    const roleChoice = (withoutRole.choices as Record<string, unknown>[])[0];
    expect(roleChoice?.message).toEqual({ content: "hi" });
    expect(() => fromOpenAIChatCompletion(withoutRole, PROVIDER)).toThrow(
      'must be "assistant"',
    );

    const withoutType = accumulateOpenAIChatCompletionChunks(
      [
        chunk({
          role: "assistant",
          tool_calls: [
            { index: 0, id: "call-1", function: { name: "Read", arguments: "{}" } },
          ],
        }),
        USAGE_ONLY_CHUNK,
      ],
      PROVIDER,
    );
    const typeChoice = (withoutType.choices as Record<string, unknown>[])[0];
    const typeMessage = typeChoice?.message as Record<string, unknown>;
    expect(typeMessage.tool_calls).toEqual([
      { id: "call-1", function: { name: "Read", arguments: "{}" } },
    ]);
  });

  test("fast-fails a non-assistant delta role", () => {
    expect(() =>
      accumulateOpenAIChatCompletionChunks(
        [chunk({ role: "user", content: "x" })],
        PROVIDER,
      ),
    ).toThrow('delta.role must be "assistant"');
  });
});

function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected operation to throw.");
}
