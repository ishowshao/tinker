import { describe, expect, test } from "bun:test";
import { ProviderResponseError, type ModelRequestInput } from "../model/model-client";
import { OpenAIResponsesModelClient } from "../model/openai-responses-model-client";
import { TEST_CONTEXT_BUDGET } from "./test-runtime";

const INPUT: ModelRequestInput = {
  messages: [
    { role: "system", content: "kernel" },
    { role: "user", content: "hello" },
  ],
  tools: [],
};

describe("OpenAIResponsesModelClient streaming", () => {
  test("streams by default and consumes the terminal response snapshot", async () => {
    let capturedURL: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    let requestSettled = false;
    const textDeltas: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedURL =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return sseResponse([
        { type: "response.created", sequence_number: 0, response: {} },
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "Hel",
        },
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "lo",
        },
        {
          type: "response.completed",
          sequence_number: 3,
          response: terminalResponse("Hello"),
        },
      ]);
    }) as typeof fetch;
    const client = responsesClient({ fetch: fetchImpl });
    const prepared = client.prepare(INPUT);
    const output = await client.request(prepared, {
      signal: new AbortController().signal,
      onTextDelta(content) {
        expect(requestSettled).toBe(false);
        textDeltas.push(content);
      },
    });
    requestSettled = true;

    expect(capturedURL).toBe("https://api.example.test/v1/responses");
    expect(capturedBody).toMatchObject({
      model: "test-model",
      stream: true,
      store: false,
      input: [
        { type: "message", role: "system", content: "kernel" },
        { type: "message", role: "user", content: "hello" },
      ],
    });
    expect(textDeltas).toEqual(["Hel", "lo"]);
    expect(output.message.content).toBe("Hello");
    expect(output.finishReason).toBe("stop");
    expect(output.usage).toMatchObject({
      promptTokens: 7,
      completionTokens: 2,
      totalTokens: 9,
    });
  });

  test("stream=false sends a non-streaming request", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(terminalResponse("ok")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = responsesClient({ stream: false, fetch: fetchImpl });
    const output = await client.request(client.prepare(INPUT), {
      signal: new AbortController().signal,
    });

    expect(capturedBody?.stream).toBeUndefined();
    expect(capturedBody?.store).toBe(false);
    expect(output.message.content).toBe("ok");
  });

  test("freezes flat function tools into the prepared payload", () => {
    const prepared = responsesClient({ fetch: stubFetch() }).prepare({
      ...INPUT,
      tools: [
        {
          name: "Read",
          description: "Read a file.",
          parameters: { type: "object" },
        },
      ],
    });

    expect(prepared.payload).toMatchObject({
      tools: [
        {
          type: "function",
          name: "Read",
          description: "Read a file.",
          parameters: { type: "object" },
          strict: false,
        },
      ],
      tool_choice: "auto",
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.payload)).toBe(true);
  });

  test("stream mode changes the request config identity", () => {
    const fetchImpl = stubFetch();
    expect(
      responsesClient({ fetch: fetchImpl }).prepare(INPUT).requestConfigHash,
    ).not.toBe(
      responsesClient({ stream: false, fetch: fetchImpl }).prepare(INPUT)
        .requestConfigHash,
    );
  });

  test("fast-fails a stream without a terminal response event", async () => {
    const fetchImpl: typeof fetch = Object.assign(
      async () =>
        sseResponse([{ type: "response.created", sequence_number: 0, response: {} }]),
      { preconnect() {} },
    );
    const client = responsesClient({ fetch: fetchImpl });

    const error = await client
      .request(client.prepare(INPUT), {
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).code).toBe("invalid_provider_stream");
    expect((error as Error).message).toContain("terminal response event");
  });

  test("does not expose a malformed output-text delta", async () => {
    const fetchImpl: typeof fetch = Object.assign(
      async () =>
        sseResponse([
          {
            type: "response.output_text.delta",
            sequence_number: 0,
            delta: 7,
          },
        ]),
      { preconnect() {} },
    );
    const client = responsesClient({ fetch: fetchImpl });
    const textDeltas: string[] = [];

    const error = await client
      .request(client.prepare(INPUT), {
        signal: new AbortController().signal,
        onTextDelta: (content) => textDeltas.push(content),
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).code).toBe("invalid_provider_stream");
    expect(textDeltas).toEqual([]);
  });

  test("classifies HTTP 429 as a retryable rate-limit error", async () => {
    const fetchImpl: typeof fetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      { preconnect() {} },
    );
    const client = responsesClient({ fetch: fetchImpl });

    const error = await client
      .request(client.prepare(INPUT), {
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).code).toBe("provider_rate_limited");
  });

  test("routes Responses payloads through the configured token estimator", async () => {
    let capturedURL: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        capturedURL =
          typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ data: { total_tokens: 11 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect() {} },
    );
    const client = responsesClient({
      fetch: fetchImpl,
      tokenEstimator: {
        kind: "moonshot-estimate-token-count-v1",
        model: "estimator-model",
        apiBase: "https://estimator.example.test/v1",
        apiKey: "estimator-key",
        timeoutMs: 30_000,
        maxRetries: 0,
      },
    });
    const prepared = client.prepare({
      ...INPUT,
      tools: [
        {
          name: "Read",
          description: "Read a file.",
          parameters: { type: "object" },
        },
      ],
    });
    const estimate = await client.inputTokenEstimator!.estimate(
      Object.freeze({ ...prepared, bodyBytes: 1 }),
      { signal: new AbortController().signal },
    );

    expect(capturedURL).toBe(
      "https://estimator.example.test/v1/tokenizers/estimate-token-count",
    );
    expect(capturedBody).toEqual({
      model: "estimator-model",
      messages: [
        { role: "system", content: "kernel" },
        { role: "user", content: "hello" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "Read",
            description: "Read a file.",
            parameters: { type: "object" },
          },
        },
      ],
    });
    expect(estimate).toEqual({
      inputTokens: 11,
      source: "provider_estimated",
      coverage: "full_request",
    });
  });
});

function responsesClient(
  overrides: Partial<ConstructorParameters<typeof OpenAIResponsesModelClient>[0]> & {
    fetch: typeof fetch;
  },
): OpenAIResponsesModelClient {
  return new OpenAIResponsesModelClient({
    apiKey: "test-key",
    baseURL: "https://api.example.test/v1",
    model: "test-model",
    contextBudget: TEST_CONTEXT_BUDGET,
    ...overrides,
  });
}

function terminalResponse(text: string): Record<string, unknown> {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    incomplete_details: null,
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 7,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 9,
    },
  };
}

function sseResponse(events: unknown[]): Response {
  const body = events
    .map((event) => {
      const type = (event as { type?: unknown }).type;
      return `event: ${String(type)}\ndata: ${JSON.stringify(event)}`;
    })
    .join("\n\n");
  return new Response(`${body}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function stubFetch(): typeof fetch {
  return Object.assign(async () => new Response(), {
    preconnect() {},
  });
}
