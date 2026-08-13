import { describe, expect, test } from "bun:test";
import { ProviderResponseError, type ModelRequestInput } from "../model/model-client";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import { RuntimeReasoningEffort } from "../model/reasoning-effort";
import { TEST_CONTEXT_BUDGET } from "./test-runtime";

const INPUT: ModelRequestInput = {
  messages: [
    { role: "system", content: "kernel" },
    { role: "user", content: "hello" },
  ],
  tools: [],
};

function sseResponse(events: unknown[]): Response {
  const body = [
    ...events.map((event) => `data: ${JSON.stringify(event)}`),
    "data: [DONE]",
    "",
  ].join("\n\n");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function textChunk(content: string): unknown {
  return {
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  };
}

const FINAL_CHUNKS: unknown[] = [
  {
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  },
  {
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [],
    usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
  },
];

function stubFetch(): typeof fetch {
  return Object.assign(async () => new Response(), {
    preconnect() {},
  });
}

function client(overrides: { stream?: boolean; fetch: typeof fetch }) {
  return new OpenAIChatModelClient({
    apiKey: "test-key",
    model: "test-model",
    contextBudget: TEST_CONTEXT_BUDGET,
    ...overrides,
  });
}

describe("OpenAIChatModelClient streaming", () => {
  test("streams by default and reassembles the full assistant message", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const textDeltas: string[] = [];
    let requestSettled = false;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return sseResponse([textChunk("Hel"), textChunk("lo"), ...FINAL_CHUNKS]);
    }) as typeof fetch;

    const streaming = client({ fetch: fetchImpl });
    const prepared = streaming.prepare(INPUT);
    const output = await streaming.request(prepared, {
      signal: new AbortController().signal,
      onTextDelta(content) {
        expect(requestSettled).toBe(false);
        textDeltas.push(content);
      },
    });
    requestSettled = true;

    expect(capturedBody).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(output.message.content).toBe("Hello");
    expect(textDeltas).toEqual(["Hel", "lo"]);
    expect(output.finishReason).toBe("stop");
    expect(output.usage).toEqual({
      promptTokens: 7,
      completionTokens: 2,
      totalTokens: 9,
    });
  });

  test("does not expose content from a chunk with an invalid tool-call fragment", async () => {
    const fetchImpl: typeof fetch = Object.assign(
      async () =>
        sseResponse([
          {
            id: "chatcmpl_test",
            object: "chat.completion.chunk",
            created: 0,
            model: "test-model",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: "must-not-leak",
                  tool_calls: [
                    {
                      index: 1,
                      id: "skipped",
                      type: "function",
                      function: { name: "Read", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
        ]),
      { preconnect() {} },
    );
    const streaming = client({ fetch: fetchImpl });
    const prepared = streaming.prepare(INPUT);
    const textDeltas: string[] = [];

    const error = await streaming
      .request(prepared, {
        signal: new AbortController().signal,
        onTextDelta: (content) => textDeltas.push(content),
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).code).toBe("invalid_provider_stream");
    expect(textDeltas).toEqual([]);
  });

  test("freezes stream flags into the prepared payload before body sizing", () => {
    const streaming = client({ fetch: stubFetch() });
    const prepared = streaming.prepare(INPUT);
    expect(prepared.payload).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  test("maps mutable reasoning effort without changing prompt identity", () => {
    const reasoningEffort = new RuntimeReasoningEffort({
      supportedEfforts: ["minimal", "balanced", "deep"],
      defaultEffort: "balanced",
    });
    const configured = new OpenAIChatModelClient({
      apiKey: "test-key",
      model: "test-model",
      contextBudget: TEST_CONTEXT_BUDGET,
      fetch: stubFetch(),
      reasoningEffort,
    });

    const initial = configured.prepare(INPUT);
    expect(initial.payload).toMatchObject({ reasoning_effort: "balanced" });

    reasoningEffort.set("deep");
    const updated = configured.prepare(INPUT);
    expect(updated.payload).toMatchObject({ reasoning_effort: "deep" });
    expect(initial.payload).toMatchObject({ reasoning_effort: "balanced" });
    expect(updated.requestConfigHash).toBe(initial.requestConfigHash);

    reasoningEffort.reset();
    expect(configured.prepare(INPUT).payload).toMatchObject({
      reasoning_effort: "balanced",
    });
  });

  test("stream=false sends a non-streaming request", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const textDeltas: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const nonStreaming = client({ stream: false, fetch: fetchImpl });
    const prepared = nonStreaming.prepare(INPUT);
    const output = await nonStreaming.request(prepared, {
      signal: new AbortController().signal,
      onTextDelta: (content) => textDeltas.push(content),
    });

    expect(capturedBody?.stream).toBeUndefined();
    expect(capturedBody?.stream_options).toBeUndefined();
    expect(output.message.content).toBe("ok");
    expect(textDeltas).toEqual([]);
  });

  test("stream mode changes the request config identity", () => {
    const fetchImpl = stubFetch();
    const streaming = client({ fetch: fetchImpl });
    const nonStreaming = client({ stream: false, fetch: fetchImpl });

    expect(streaming.prepare(INPUT).requestConfigHash).not.toBe(
      nonStreaming.prepare(INPUT).requestConfigHash,
    );
  });

  test("fast-fails a stream that ends without any chunks", async () => {
    const fetchImpl: typeof fetch = Object.assign(async () => sseResponse([]), {
      preconnect() {},
    });
    const streaming = client({ fetch: fetchImpl });
    const prepared = streaming.prepare(INPUT);

    const error = await streaming
      .request(prepared, { signal: new AbortController().signal })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).code).toBe("invalid_provider_stream");
    expect((error as ProviderResponseError).diagnostics).toEqual({
      provider: "openai-compatible",
      model: "test-model",
      path: "chunks",
    });
    expect((error as Error).message).toContain("chunks must not be empty");
  });

  test("classifies and redacts provider request errors", async () => {
    const fetchImpl: typeof fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Bearer super-secret data:image/png;base64,QUJD",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      { preconnect() {} },
    );
    const streaming = client({ fetch: fetchImpl });
    const prepared = streaming.prepare(INPUT);

    const error = await streaming
      .request(prepared, { signal: new AbortController().signal })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).code).toBe("provider_request_error");
    expect((error as ProviderResponseError).diagnostics).toEqual({
      provider: "openai-compatible",
      model: "test-model",
    });
    expect((error as Error).message).toBe(
      "400 Bearer [redacted] [redacted image data]",
    );
    expect((error as Error).message).not.toContain("super-secret");
    expect((error as Error).message).not.toContain("QUJD");
  });

  test("classifies HTTP 429 as a retryable rate-limit error", async () => {
    const fetchImpl: typeof fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "The engine is currently overloaded, please try again later",
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
      { preconnect() {} },
    );
    const streaming = client({ fetch: fetchImpl });
    const prepared = streaming.prepare(INPUT);

    const error = await streaming
      .request(prepared, { signal: new AbortController().signal })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).code).toBe("provider_rate_limited");
    expect((error as Error).message).toContain("The engine is currently overloaded");
  });

  test.each([
    500, 502, 503, 504,
  ])("classifies HTTP %i as a retryable unavailable error", async (status) => {
    let dispatches = 0;
    const fetchImpl: typeof fetch = Object.assign(
      async () => {
        dispatches += 1;
        return new Response(JSON.stringify({ error: { message: "boom" } }), {
          status,
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect() {} },
    );
    const streaming = client({ fetch: fetchImpl });
    const prepared = streaming.prepare(INPUT);

    const error = await streaming
      .request(prepared, { signal: new AbortController().signal })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).code).toBe("provider_unavailable");
    expect(dispatches).toBe(1);
  });

  test("classifies connection failures as a retryable unavailable error", async () => {
    const fetchImpl: typeof fetch = Object.assign(
      async () => {
        throw new TypeError("fetch failed");
      },
      { preconnect() {} },
    );
    const streaming = client({ fetch: fetchImpl });
    const prepared = streaming.prepare(INPUT);

    const error = await streaming
      .request(prepared, { signal: new AbortController().signal })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).code).toBe("provider_unavailable");
  });
});
