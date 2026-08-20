import { describe, expect, test } from "bun:test";
import {
  fromOpenAIResponse,
  toOpenAIResponsesInput,
  toOpenAIResponsesTools,
} from "../model/openai-responses-mapping";
import { ProviderResponseError } from "../model/model-client";
import { createTestRuntime } from "./test-runtime";

describe("OpenAI Responses mapping", () => {
  test("maps canonical messages to stateless Responses items", () => {
    const testRuntime = createTestRuntime();
    const call = testRuntime.toolCall({
      providerToolCallId: "call_provider_7",
      name: "Read",
      args: { file_path: "README.md" },
      rawArgs: '{"file_path":"README.md"}',
    });

    expect(
      toOpenAIResponsesInput([
        { role: "system", content: "kernel" },
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: "I will inspect it.",
          reasoningContent: "private reasoning is not replayed",
          toolCalls: [call],
        },
        {
          role: "tool",
          toolCallId: call.toolCallId,
          providerToolCallId: call.providerToolCallId,
          name: call.name,
          content: "file contents",
        },
      ]),
    ).toEqual([
      { type: "message", role: "system", content: "kernel" },
      { type: "message", role: "user", content: "inspect" },
      {
        type: "message",
        role: "assistant",
        content: "I will inspect it.",
      },
      {
        type: "function_call",
        call_id: "call_provider_7",
        name: "Read",
        arguments: '{"file_path":"README.md"}',
      },
      {
        type: "function_call_output",
        call_id: "call_provider_7",
        output: "file contents",
      },
    ]);
  });

  test("maps function tools to the flat Responses shape", () => {
    expect(
      toOpenAIResponsesTools([
        {
          name: "Read",
          description: "Read a file.",
          parameters: {
            type: "object",
            properties: { file_path: { type: "string" } },
          },
        },
      ]),
    ).toEqual([
      {
        type: "function",
        name: "Read",
        description: "Read a file.",
        parameters: {
          type: "object",
          properties: { file_path: { type: "string" } },
        },
        strict: false,
      },
    ]);
  });

  test("combines message, reasoning, and function-call output items", () => {
    const testRuntime = createTestRuntime();
    const output = fromOpenAIResponse(
      response({
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            content: [{ type: "reasoning_text", text: "Need to inspect the file." }],
          },
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "I will inspect it.",
                annotations: [],
              },
            ],
          },
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "Read",
            arguments: '{"file_path":"README.md"}',
            status: "completed",
          },
        ],
      }),
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
      content: "I will inspect it.",
      reasoningContent: "Need to inspect the file.",
      toolCalls: [
        {
          providerToolCallId: "call_1",
          name: "Read",
          args: { file_path: "README.md" },
          rawArgs: '{"file_path":"README.md"}',
        },
      ],
    });
    expect(output.finishReason).toBe("tool_calls");
    expect(output.usage).toEqual({
      promptTokens: 20,
      completionTokens: 8,
      totalTokens: 28,
      promptCacheHitTokens: 5,
      promptCacheMissTokens: 15,
      reasoningTokens: 3,
    });
  });

  test("accepts encrypted reasoning and unknown compatible output items", () => {
    const output = fromOpenAIResponse(
      response({
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            encrypted_content: "opaque",
          },
          { type: "future_provider_item", value: true },
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "done", annotations: [] }],
          },
        ],
      }),
      { provider: "test-provider", model: "test-model" },
    );

    expect(output.message).toEqual({
      role: "assistant",
      content: "done",
      reasoningContent: null,
      toolCalls: undefined,
    });
    expect(output.finishReason).toBe("stop");
  });

  test("uses incomplete_details as the finish reason", () => {
    const output = fromOpenAIResponse(
      response({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "partial", annotations: [] }],
          },
        ],
      }),
      { provider: "test-provider", model: "test-model" },
    );

    expect(output.finishReason).toBe("max_output_tokens");
    expect(output.message.content).toBe("partial");
  });

  test("classifies a reasoning-only terminal response", () => {
    const error = captureError(() =>
      fromOpenAIResponse(
        response({
          output: [
            {
              type: "reasoning",
              id: "rs_1",
              summary: [{ type: "summary_text", text: "No final answer was emitted." }],
            },
          ],
        }),
        { provider: "test-provider", model: "test-model" },
      ),
    );

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).code).toBe("reasoning_only_assistant");
    expect((error as Error).message).not.toContain("No final answer");
  });

  test("fast-fails a function call without identity context", () => {
    expect(() =>
      fromOpenAIResponse(
        response({
          output: [
            {
              type: "function_call",
              call_id: "call_1",
              name: "Read",
              arguments: "{}",
            },
          ],
        }),
        { provider: "test-provider", model: "test-model" },
      ),
    ).toThrow("iteration identity");
  });

  test("fast-fails internally inconsistent usage", () => {
    expect(() =>
      fromOpenAIResponse(
        response({
          usage: {
            input_tokens: 20,
            output_tokens: 8,
            total_tokens: 29,
          },
        }),
        { provider: "test-provider", model: "test-model" },
      ),
    ).toThrow("must equal usage.input_tokens + usage.output_tokens");

    expect(() =>
      fromOpenAIResponse(
        response({
          usage: {
            input_tokens: 20,
            output_tokens: 8,
            output_tokens_details: { reasoning_tokens: 9 },
            total_tokens: 28,
          },
        }),
        { provider: "test-provider", model: "test-model" },
      ),
    ).toThrow("must not exceed usage.output_tokens");
  });
});

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    incomplete_details: null,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done", annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens: 8,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 28,
    },
    ...overrides,
  };
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    throw new Error("Expected function to throw.");
  } catch (error) {
    return error;
  }
}
