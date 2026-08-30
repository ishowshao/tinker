import { describe, expect, test } from "bun:test";
import type {
  ModelRequestInput,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { estimatePromptSegments } from "../model/token-estimator";
import { OpenAICompatibleEmbeddingClient } from "../memory/embedding-client";
import {
  MemoryExtractionOutputError,
  MemoryExtractionRequestError,
  MemoryExtractionSkippedError,
  MemoryExtractor,
} from "../memory/memory-extractor";
import {
  TEST_CONTEXT_BUDGET,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

class ExtractionModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];
  requests = 0;

  constructor(
    private readonly responseText: string,
    private readonly requestError?: Error,
  ) {
    super();
  }

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    this.requests += 1;
    this.inputs.push(testModelRequestInput(prepared));
    if (this.requestError !== undefined) {
      throw this.requestError;
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: this.responseText,
    });
  }
}

class OversizedPreparedModel extends ExtractionModel {
  prepare(input: ModelRequestInput): PreparedModelRequest {
    const prepared = super.prepare(input);
    return Object.freeze({
      ...prepared,
      promptSegments: Object.freeze([
        ...prepared.promptSegments,
        {
          kind: "protocol" as const,
          normalizedText: "oversized ".repeat(4_000),
        },
      ]),
    });
  }
}

class BrokenPreparedModel extends ExtractionModel {
  prepare(): PreparedModelRequest {
    throw new Error("test prepare failure");
  }
}

describe("MemoryExtractor", () => {
  test("uses an independent no-tool request and accepts a skip or a single record", async () => {
    const cases = [
      { output: { text: "", summary: "" }, expected: null },
      {
        output: {
          text: "Tinker memory v2: schema v2 implemented in src/memory.",
          summary:
            "User asked to implement the memory v2 design; bun run check passed at that point.",
        },
        expected: {
          text: "Tinker memory v2: schema v2 implemented in src/memory.",
          summary:
            "User asked to implement the memory v2 design; bun run check passed at that point.",
        },
      },
    ];
    for (const entry of cases) {
      const model = new ExtractionModel(JSON.stringify(entry.output));
      const extractor = new MemoryExtractor(model, TEST_CONTEXT_BUDGET);
      const result = await extractor.extract(
        '{"workspaceRoot":"/workspace","messages":[]}',
        new AbortController().signal,
      );

      expect(result.memory).toEqual(entry.expected);
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(model.requests).toBe(1);
      expect(model.inputs[0]?.tools).toEqual([]);
      expect(model.inputs[0]?.responseFormat).toEqual({ type: "json_object" });
      expect(model.inputs[0]?.messages[0]?.content).toContain(
        'Skip by returning {"text":"","summary":""}',
      );
      expect(model.inputs[0]?.messages[0]?.content).toContain(
        "This is a historical record",
      );
      expect(model.inputs[0]?.messages[0]?.content).toContain(
        "Never store keys, tokens, cookies, passwords",
      );
      expect(model.inputs[0]?.messages[1]?.content).toContain(
        '"workspaceRoot":"/workspace"',
      );
    }
  });

  test("strictly rejects malformed or oversized extraction output as a whole", async () => {
    const invalidOutputs = [
      "not json",
      "[]",
      JSON.stringify({ memories: [] }),
      JSON.stringify({ text: "x", summary: "", extra: true }),
      JSON.stringify({ text: "x" }),
      JSON.stringify({ summary: "" }),
      JSON.stringify({ text: 1, summary: "" }),
      JSON.stringify({ text: "x", summary: ["not a string"] }),
      JSON.stringify({ text: "x".repeat(513), summary: "" }),
      JSON.stringify({ text: "x", summary: "s".repeat(4_097) }),
    ];
    for (const output of invalidOutputs) {
      const extractor = new MemoryExtractor(
        new ExtractionModel(output),
        TEST_CONTEXT_BUDGET,
      );
      expect(
        extractor.extract("{}", new AbortController().signal),
      ).rejects.toBeInstanceOf(MemoryExtractionOutputError);
    }
  });

  test("trims accepted fields and enforces the UTF-8 byte limits", async () => {
    const extractor = new MemoryExtractor(
      new ExtractionModel(
        JSON.stringify({
          text: `  ${"记".repeat(170)}  `,
          summary: "  summary with surrounding whitespace  ",
        }),
      ),
      TEST_CONTEXT_BUDGET,
    );
    const result = await extractor.extract("{}", new AbortController().signal);
    expect(result.memory).toEqual({
      text: "记".repeat(170),
      summary: "summary with surrounding whitespace",
    });

    const tooLarge = new MemoryExtractor(
      new ExtractionModel(
        JSON.stringify({
          text: "记".repeat(171),
          summary: "",
        }),
      ),
      TEST_CONTEXT_BUDGET,
    );
    expect(tooLarge.extract("{}", new AbortController().signal)).rejects.toThrow(
      "1 to 512 UTF-8 bytes",
    );
  });

  test("treats whitespace-only text as a skip and accepts an empty summary", async () => {
    for (const output of [
      { text: "   ", summary: "ignored" },
      { text: "Tinker memory browser shows stored summaries.", summary: "" },
    ]) {
      const extractor = new MemoryExtractor(
        new ExtractionModel(JSON.stringify(output)),
        TEST_CONTEXT_BUDGET,
      );
      const result = await extractor.extract("{}", new AbortController().signal);
      if (output.text.trim() === "") {
        expect(result.memory).toBeNull();
      } else {
        expect(result.memory).toEqual({ text: output.text, summary: "" });
      }
    }
  });

  test("skips oversized prepared requests before provider dispatch", async () => {
    const model = new OversizedPreparedModel('{"text":"","summary":""}');
    const extractor = new MemoryExtractor(model, {
      ...TEST_CONTEXT_BUDGET,
      inputBudgetTokens: 100,
    });
    const error = await extractor
      .extract("tiny evidence", new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MemoryExtractionSkippedError);
    expect(error).toMatchObject({
      code: "extraction_input_too_large",
    });
    expect(model.requests).toBe(0);
  });

  test("skips failed preflight before provider dispatch", async () => {
    const model = new BrokenPreparedModel('{"text":"","summary":""}');
    const error = await new MemoryExtractor(model, TEST_CONTEXT_BUDGET)
      .extract("evidence", new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "extraction_preflight_failed",
      inputTokens: 0,
    });
    expect(model.requests).toBe(0);
  });

  test("preserves the known local estimate on request and output failures", async () => {
    const requestError = await new MemoryExtractor(
      new ExtractionModel("unused", new Error("provider failure")),
      TEST_CONTEXT_BUDGET,
    )
      .extract("evidence", new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(requestError).toBeInstanceOf(MemoryExtractionRequestError);
    if (!(requestError instanceof MemoryExtractionRequestError)) {
      throw new Error("Expected a memory extraction request error.");
    }
    expect(requestError.inputTokens).toBeGreaterThan(0);

    const outputError = await new MemoryExtractor(
      new ExtractionModel("not json"),
      TEST_CONTEXT_BUDGET,
    )
      .extract("evidence", new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(outputError).toBeInstanceOf(MemoryExtractionOutputError);
    if (!(outputError instanceof MemoryExtractionOutputError)) {
      throw new Error("Expected a memory extraction output error.");
    }
    expect(outputError.inputTokens).toBeGreaterThan(0);
  });

  test("allows dispatch when the corrected local estimate equals the input budget", async () => {
    const model = new ExtractionModel('{"text":"","summary":""}');
    const firstExtractor = new MemoryExtractor(model, TEST_CONTEXT_BUDGET);
    const first = await firstExtractor.extract(
      "budget boundary",
      new AbortController().signal,
    );
    const boundaryModel = new ExtractionModel('{"text":"","summary":""}');
    const boundaryExtractor = new MemoryExtractor(boundaryModel, {
      ...TEST_CONTEXT_BUDGET,
      inputBudgetTokens: first.inputTokens,
    });

    expect(
      boundaryExtractor.extract("budget boundary", new AbortController().signal),
    ).resolves.toMatchObject({ inputTokens: first.inputTokens });
    expect(boundaryModel.requests).toBe(1);
  });

  test("does not invoke a model input-token estimator", async () => {
    let estimatorCalls = 0;
    const model = new ExtractionModel('{"text":"","summary":""}') as ExtractionModel & {
      inputTokenEstimator: {
        kind: string;
        compatibility: {
          kind: "moonshot-estimate-token-count-v1";
          coverageVersion: "full-request-v1";
          model: string;
          endpoint: string;
          timeoutMs: number;
          maxRetries: 0;
        };
        estimate: () => Promise<never>;
      };
    };
    model.inputTokenEstimator = {
      kind: "test-estimator",
      compatibility: {
        kind: "moonshot-estimate-token-count-v1",
        coverageVersion: "full-request-v1",
        model: "estimator",
        endpoint: "https://example.test/tokenizers/estimate-token-count",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
      estimate: async () => {
        estimatorCalls += 1;
        throw new Error("must not be called");
      },
    };

    const result = await new MemoryExtractor(model, TEST_CONTEXT_BUDGET).extract(
      "{}",
      new AbortController().signal,
    );
    expect(result.memory).toBeNull();
    expect(estimatorCalls).toBe(0);
  });

  test("uses prepared prompt segments for the local estimate", async () => {
    const model = new ExtractionModel('{"text":"","summary":""}');
    const extractor = new MemoryExtractor(model, TEST_CONTEXT_BUDGET);
    const result = await extractor.extract("{}", new AbortController().signal);
    const input = model.inputs[0];
    const prepared = model.prepare(input);
    const raw = estimatePromptSegments(prepared.promptSegments).totalTokens;
    expect(result.inputTokens).toBe(Math.ceil(raw * 1.25));
  });
});

describe("OpenAICompatibleEmbeddingClient", () => {
  const config = Object.freeze({
    name: "test-space",
    kind: "openai-compatible" as const,
    model: "embedding-test",
    apiBase: "https://embedding.example.test/v1",
    apiKey: "embedding-secret",
    dimensions: 3,
  });

  test("sends one batch request and maps vectors by exact response index", async () => {
    let calls = 0;
    let requestUrl = "";
    let requestBody: unknown;
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls += 1;
      requestUrl = input instanceof Request ? input.url : String(input);
      if (typeof init?.body !== "string") {
        throw new Error("Expected an embedding JSON request body.");
      }
      requestBody = JSON.parse(init.body) as unknown;
      return jsonResponse({
        object: "list",
        model: config.model,
        usage: { prompt_tokens: 2, total_tokens: 2 },
        data: [
          { object: "embedding", index: 1, embedding: [0, 1, 0] },
          { object: "embedding", index: 0, embedding: [1, 0, 0] },
        ],
      });
    }) as unknown as typeof fetch;
    const client = new OpenAICompatibleEmbeddingClient(config, {
      fetch: fetcher,
    });
    const vectors = await client.embed(
      ["first", "second"],
      new AbortController().signal,
    );

    expect(calls).toBe(1);
    expect(requestUrl).toBe("https://embedding.example.test/v1/embeddings");
    expect(requestBody).toMatchObject({
      model: "embedding-test",
      input: ["first", "second"],
    });
    expect(vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  test("rejects response count and index mismatches", async () => {
    for (const data of [
      undefined,
      [{ object: "embedding", index: 0, embedding: [1, 0, 0] }],
      [
        { object: "embedding", index: 0, embedding: [1, 0, 0] },
        { object: "embedding", index: 0, embedding: [0, 1, 0] },
      ],
    ]) {
      const client = new OpenAICompatibleEmbeddingClient(config, {
        fetch: (async () =>
          jsonResponse({
            object: "list",
            model: config.model,
            usage: { prompt_tokens: 2, total_tokens: 2 },
            data,
          })) as unknown as typeof fetch,
      });
      expect(
        client.embed(["first", "second"], new AbortController().signal),
      ).rejects.toMatchObject({
        code: "memory_embedding_response_invalid",
      });
    }
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
