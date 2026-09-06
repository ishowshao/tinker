import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { runAgent } from "../agent/loop";
import { TurnCancelledError } from "../agent/turn-cancellation";
import { RuntimeProviderRetry } from "../agent/runtime-provider-retry";
import { InMemorySessionLedger } from "../agent/session-ledger";
import type { AgentEvent } from "../events/types";
import { ProviderResponseError, type ModelRequestInput } from "../model/model-client";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import { sanitizedProviderError } from "../model/openai-model-utils";
import { OpenAIResponsesModelClient } from "../model/openai-responses-model-client";
import { ObservationBuilder } from "../observation/observation-builder";
import { ToolRegistry, ToolRuntime } from "../tools/registry";
import {
  createTestContextMeter,
  createTestRuntime,
  deterministicIdFactory,
  TEST_CONTEXT_BUDGET,
} from "./test-runtime";

const INPUT: ModelRequestInput = {
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
  ],
  tools: [],
};
const SERVER_ERROR = {
  code: "server_error",
  message: "The server had an error processing your request. Bearer private-token",
};

function sseResponse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function responsesClient(fetchImpl: typeof fetch, stream = true) {
  return new OpenAIResponsesModelClient({
    apiKey: "test-key",
    baseURL: "https://api.example.test/v1",
    model: "test-model",
    contextBudget: TEST_CONTEXT_BUDGET,
    fetch: fetchImpl,
    stream,
  });
}

function responseFetch(response: () => Response): typeof fetch {
  return Object.assign(async () => response(), { preconnect() {} });
}

function completedResponse() {
  return {
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

const STREAM_FAILURES = [
  {
    name: "SDK SSE error payload",
    response: () => sseResponse([{ error: SERVER_ERROR }]),
  },
  {
    name: "Responses error event",
    response: () => sseResponse([{ type: "error", ...SERVER_ERROR }]),
  },
  {
    name: "Responses failed event",
    response: () =>
      sseResponse([
        {
          type: "response.failed",
          response: { status: "failed", error: SERVER_ERROR },
        },
      ]),
  },
  {
    name: "socket reset after a text delta",
    response: () => {
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              controller.error(
                Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
              );
            } else {
              sent = true;
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
                ),
              );
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  },
];

describe("provider stream errors reach manual retry selection", () => {
  test.each(
    STREAM_FAILURES,
  )("$name retries, asks, and completes the same iteration", async ({ response }) => {
    const events: AgentEvent[] = [];
    const identity = createTestRuntime({
      async append(event) {
        events.push(event);
      },
    });
    const registry = new ToolRegistry();
    const ledger = new InMemorySessionLedger({
      sessionId: identity.runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("provider-error-retry"),
      initialToolDefinitions: registry.definitions(),
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "hello" },
    });
    const bodies: unknown[] = [];
    const model = responsesClient(
      Object.assign(
        async (_url: unknown, init?: RequestInit) => {
          bodies.push(init?.body);
          return bodies.length <= 5
            ? response()
            : sseResponse([
                { type: "response.completed", response: completedResponse() },
              ]);
        },
        { preconnect() {} },
      ),
    );
    const retry = new RuntimeProviderRetry((event) =>
      identity.runtimeSession.append(event),
    );
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new TurnCancelledError("user", "Test timed out.")),
      2000,
    );
    let questions = 0;
    try {
      const result = await runAgent({
        ledger: pending.agent,
        maxIterations: 1,
        model,
        contextMeter: createTestContextMeter(),
        tools: registry,
        toolRuntime: new ToolRuntime(registry),
        observationBuilder: new ObservationBuilder(),
        runtimeSession: identity.runtimeSession,
        turn: identity.turn,
        signal: controller.signal,
        transientRetryDelaysMs: [0, 0, 0, 0],
        requestProviderRetry: async (iteration, failure, signal) => {
          questions += 1;
          expect(failure).toMatchObject({
            code: "provider_unavailable",
            retryDisposition: "exhausted",
            attemptNumber: 5,
          });
          expect(pending.projectedMessageCount()).toBe(2);
          let unsubscribe = () => {};
          const ready = new Promise<void>((resolve) => {
            unsubscribe = retry.subscribe(() => {
              if (retry.read().pending !== undefined) resolve();
            });
          });
          const decision = retry.request(iteration, failure, signal);
          try {
            await Promise.race([ready, decision]);
            const question = retry.read().pending;
            if (question === undefined)
              throw new Error("Expected pending retry selection.");
            await retry.resolve(question.requestId, "retry");
            return await decision;
          } finally {
            unsubscribe();
          }
        },
      });
      expect(result).toMatchObject({
        status: "completed",
        lastIteration: { iterationNumber: 1 },
      });
      expect(questions).toBe(1);
      expect(bodies).toHaveLength(6);
      expect(new Set(bodies).size).toBe(1);
      expect(
        events.filter((event) => event.type === "agent.iteration.started"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "model.retry.requested"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "model.retry.resolved"),
      ).toHaveLength(1);
      expect(
        events
          .filter((event) => event.type === "model.request.failed")
          .map((event) => event.data.retryDisposition),
      ).toEqual(["scheduled", "scheduled", "scheduled", "scheduled", "exhausted"]);
    } finally {
      clearTimeout(timeout);
      controller.abort(new TurnCancelledError("user"));
    }
  });
});

describe("provider error classification boundaries", () => {
  test.each([
    "chat",
    "responses",
  ] as const)("%s SDK preserves structured SSE errors without HTTP status", async (adapter) => {
    for (const [code, expected] of [
      ["server_error", "provider_unavailable"],
      ["rate_limit_exceeded", "provider_rate_limited"],
      ["invalid_api_key", "provider_request_error"],
      ["insufficient_quota", "provider_request_error"],
      ["unknown_error", "provider_request_error"],
    ] as const) {
      const fetchImpl = responseFetch(() =>
        sseResponse([{ error: { ...SERVER_ERROR, code } }]),
      );
      const model =
        adapter === "responses"
          ? responsesClient(fetchImpl)
          : new OpenAIChatModelClient({
              apiKey: "test-key",
              baseURL: "https://api.example.test/v1",
              model: "test-model",
              contextBudget: TEST_CONTEXT_BUDGET,
              fetch: fetchImpl,
            });
      const error = await model
        .request(model.prepare(INPUT), { signal: new AbortController().signal })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderResponseError);
      expect((error as ProviderResponseError).code).toBe(expected);
      expect((error as Error).message).toContain("Bearer [redacted]");
      expect((error as Error).message).not.toContain("private-token");
    }
  });

  test.each([
    "event",
    "failed-stream",
    "failed-json",
  ] as const)("Responses %s uses payload codes and keeps malformed errors non-retryable", async (shape) => {
    for (const [code, expected] of [
      ["server_error", "provider_unavailable"],
      ["rate_limit_exceeded", "provider_rate_limited"],
      ["invalid_prompt", "provider_request_error"],
      ["image_content_policy_violation", "provider_request_error"],
      ["unknown_error", "provider_request_error"],
      [
        123,
        shape === "event" ? "invalid_provider_stream" : "invalid_provider_response",
      ],
    ] as const) {
      const payload = { ...SERVER_ERROR, code };
      const failed = { status: "failed", error: payload };
      const model = responsesClient(
        responseFetch(() =>
          shape === "failed-json"
            ? Response.json(failed)
            : sseResponse([
                shape === "event"
                  ? { type: "error", ...payload }
                  : { type: "response.failed", response: failed },
              ]),
        ),
        shape !== "failed-json",
      );
      const error = await model
        .request(model.prepare(INPUT), { signal: new AbortController().signal })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderResponseError);
      expect((error as ProviderResponseError).code).toBe(expected);
      expect((error as Error).message).not.toContain("private-token");
    }
  });

  test.each([
    400, 401, 403, 404, 422,
  ])("HTTP %i overrides retryable payload codes", async (status) => {
    const model = responsesClient(
      responseFetch(() => Response.json({ error: SERVER_ERROR }, { status })),
    );
    const error = await model
      .request(model.prepare(INPUT), { signal: new AbortController().signal })
      .catch((caught: unknown) => caught);
    expect((error as ProviderResponseError).code).toBe("provider_request_error");
  });

  test("classifies known transport causes without retrying arbitrary errors or aborts", () => {
    for (const code of [
      "ECONNRESET",
      "EPIPE",
      "ETIMEDOUT",
      "ERR_STREAM_PREMATURE_CLOSE",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ]) {
      const socketError = Object.assign(new Error("socket failed"), { code });
      expect(sanitizedProviderError(socketError, "test", "test").code).toBe(
        "provider_unavailable",
      );
      expect(
        sanitizedProviderError(
          new TypeError("terminated", { cause: socketError }),
          "test",
          "test",
        ).code,
      ).toBe("provider_unavailable");
      const abort = Object.assign(new Error("cancelled", { cause: socketError }), {
        name: "AbortError",
      });
      expect(sanitizedProviderError(abort, "test", "test").code).toBe(
        "provider_request_error",
      );
      const auth = Object.assign(new Error("auth failed", { cause: socketError }), {
        code: "invalid_api_key",
      });
      expect(sanitizedProviderError(auth, "test", "test").code).toBe(
        "provider_request_error",
      );
    }
    const cycle = new Error("cycle");
    cycle.cause = cycle;
    for (const error of [
      cycle,
      new Error("The server had an error processing your request."),
      new TypeError("terminated"),
      new SyntaxError("invalid JSON"),
    ]) {
      expect(sanitizedProviderError(error, "test", "test").code).toBe(
        "provider_request_error",
      );
    }
  });

  test("recognizes a real Bun socket closure after receiving SSE headers", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.once("data", () => {
        socket.write(
          'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 9999\r\n\r\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        );
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing test server address.");
      const model = new OpenAIResponsesModelClient({
        apiKey: "test-key",
        baseURL: `http://127.0.0.1:${address.port}`,
        model: "test-model",
        contextBudget: TEST_CONTEXT_BUDGET,
      });
      const error = await model
        .request(model.prepare(INPUT), {
          signal: AbortSignal.timeout(2000),
          onTextDelta() {
            for (const socket of sockets) socket.destroy();
          },
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderResponseError);
      expect((error as ProviderResponseError).code).toBe("provider_unavailable");
      expect((error as Error).cause).toMatchObject({ code: "ECONNRESET" });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
