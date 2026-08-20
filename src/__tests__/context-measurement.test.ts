import { describe, expect, test } from "bun:test";
import { ContextMeter, type MeasuredContextAnchor } from "../agent/context-meter";
import type {
  ModelRequestInput,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { ContextBudgetExceededError } from "../model/model-request-preflight";
import { imageAssetIdForBytes } from "../image/image-types";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import {
  CALIBRATION_WINDOW_SIZE,
  estimatePromptSegments,
  INITIAL_CORRECTION_FACTOR,
  RollingTokenCalibration,
} from "../model/token-estimator";
import { createModelRefiner } from "../tools/web-fetch/refiner";
import {
  prepareTestModelRequest,
  TEST_CONTEXT_BUDGET,
  testModelOutput,
  TestModelClient,
} from "./test-runtime";

describe("prepared model requests", () => {
  test("sends the measured payload with the derived output limit", async () => {
    let capturedBody: unknown;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      capturedBody =
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      return providerResponse();
    }) as typeof fetch;
    const client = new OpenAIChatModelClient({
      apiKey: "test-key",
      model: "test-model",
      contextBudget: TEST_CONTEXT_BUDGET,
      stream: false,
      fetch: fetchImpl,
    });
    const input: ModelRequestInput = {
      messages: [
        { role: "system", content: "kernel" },
        { role: "user", content: "hello" },
      ],
      tools: [testTool({ z: { type: "string" }, a: { type: "number" } })],
    };

    const prepared = client.prepare(input);
    expect(prepared.requestMaxOutputTokens).toBe(
      TEST_CONTEXT_BUDGET.requestMaxOutputTokens,
    );
    expect(prepared.promptSegments.map((segment) => segment.kind)).toEqual([
      "tool_schema",
      "kernel",
      "user",
    ]);
    expect(prepared.payload).toMatchObject({
      max_completion_tokens: TEST_CONTEXT_BUDGET.requestMaxOutputTokens,
      model: "test-model",
      tool_choice: "auto",
    });

    await client.request(prepared, { signal: new AbortController().signal });
    expect(capturedBody).toEqual(prepared.payload);
  });

  test("canonicalizes schema keys and rejects foreign prepared requests", async () => {
    const first = new OpenAIChatModelClient({
      apiKey: "test-key",
      model: "test-model",
      contextBudget: TEST_CONTEXT_BUDGET,
      fetch: (async () => providerResponse()) as unknown as typeof fetch,
    });
    const second = new OpenAIChatModelClient({
      apiKey: "test-key",
      model: "test-model",
      contextBudget: TEST_CONTEXT_BUDGET,
      fetch: (async () => providerResponse()) as unknown as typeof fetch,
    });
    const messages: ModelRequestInput["messages"] = [
      { role: "user", content: "hello" },
    ];
    const left = first.prepare({
      messages,
      tools: [testTool({ z: { type: "string" }, a: { type: "number" } })],
    });
    const right = first.prepare({
      messages,
      tools: [testTool({ a: { type: "number" }, z: { type: "string" } })],
    });

    expect(left.payload).toEqual(right.payload);
    expect(left.toolSchemaHash).toBe(right.toolSchemaHash);
    expect(left.requestConfigHash).toBe(right.requestConfigHash);
    const foreignError = await second
      .request(left, { signal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(foreignError).toBeInstanceOf(Error);
    expect((foreignError as Error).message).toContain(
      "was not prepared by this client",
    );
  });

  test("omits tool choice when no tools are present", () => {
    const client = new OpenAIChatModelClient({
      apiKey: "test-key",
      model: "test-model",
      contextBudget: TEST_CONTEXT_BUDGET,
    });
    const prepared = client.prepare({
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });
    expect(prepared.payload).not.toHaveProperty("tools");
    expect(prepared.payload).not.toHaveProperty("tool_choice");
  });
});

describe("token estimator", () => {
  test("uses code points and keeps an integer semantic breakdown", () => {
    const estimate = estimatePromptSegments([
      { kind: "user", normalizedText: "a汉😀" },
    ]);
    expect(estimate).toEqual({
      kernelTokens: 0,
      userTokens: 3,
      assistantTokens: 0,
      toolTokens: 0,
      toolSchemaTokens: 0,
      protocolTokens: 8,
      textAndProtocolTokens: 11,
      imageTokens: 0,
      totalTokens: 11,
    });
    expect(
      estimate.kernelTokens +
        estimate.userTokens +
        estimate.assistantTokens +
        estimate.toolTokens +
        estimate.toolSchemaTokens +
        estimate.protocolTokens,
    ).toBe(estimate.totalTokens);
  });

  test("calibrates from the largest of the newest eight ratios", () => {
    const calibration = new RollingTokenCalibration();
    expect(calibration.correctionFactor()).toBe(INITIAL_CORRECTION_FACTOR);

    calibration.record(200, 100);
    expect(calibration.correctionFactor()).toBeCloseTo(2.1);
    for (let index = 0; index < CALIBRATION_WINDOW_SIZE; index += 1) {
      calibration.record(100, 100);
    }
    expect(calibration.sampleCount()).toBe(CALIBRATION_WINDOW_SIZE);
    expect(calibration.correctionFactor()).toBe(1.1);

    calibration.record(500, 100);
    expect(calibration.correctionFactor()).toBeCloseTo(5.25);
    calibration.clear();
    expect(calibration.sampleCount()).toBe(0);
    expect(calibration.correctionFactor()).toBe(INITIAL_CORRECTION_FACTOR);
  });
});

describe("ContextMeter", () => {
  test("restores an exact measured anchor with zero delta", () => {
    let persistedAnchor: MeasuredContextAnchor | undefined;
    const original = new ContextMeter(TEST_CONTEXT_BUDGET, {
      onMeasuredAnchor: (anchor) => {
        persistedAnchor = anchor;
      },
    });
    const firstInput: ModelRequestInput = {
      messages: [
        { role: "system", content: "kernel" },
        { role: "user", content: "first" },
      ],
      tools: [],
    };
    const first = prepareTestModelRequest(firstInput);
    original.measure(first);
    const assistant = { role: "assistant" as const, content: "answer" };
    const output = testModelOutput(first, assistant);
    original.recordProviderUsage(first, output);
    if (persistedAnchor === undefined) {
      throw new Error("Expected a measured context anchor.");
    }

    const restoredRequest = prepareTestModelRequest({
      messages: [...firstInput.messages, assistant],
      tools: [],
    });
    const restored = new ContextMeter(TEST_CONTEXT_BUDGET);
    expect(restored.restoreExactMeasuredAnchor(restoredRequest, persistedAnchor)).toBe(
      true,
    );
    const snapshot = restored.measure(restoredRequest);
    expect(snapshot).toMatchObject({
      source: "measured_plus_estimated_delta",
      usedInputTokens: output.usage.totalTokens,
      rawDeltaTokens: 0,
      guardedDeltaTokens: 0,
      calibrationSampleCount: 0,
      lastProviderUsage: output.usage,
    });
  });

  test("rejects a restored anchor when the full prefix does not match", () => {
    let persistedAnchor: MeasuredContextAnchor | undefined;
    const original = new ContextMeter(TEST_CONTEXT_BUDGET, {
      onMeasuredAnchor: (anchor) => {
        persistedAnchor = anchor;
      },
    });
    const first = prepareTestModelRequest({
      messages: [{ role: "user", content: "original" }],
      tools: [],
    });
    original.measure(first);
    original.recordProviderUsage(
      first,
      testModelOutput(first, { role: "assistant", content: "answer" }),
    );
    if (persistedAnchor === undefined) {
      throw new Error("Expected a measured context anchor.");
    }

    const changed = prepareTestModelRequest({
      messages: [
        { role: "user", content: "changed" },
        { role: "assistant", content: "answer" },
      ],
      tools: [],
    });
    const restored = new ContextMeter(TEST_CONTEXT_BUDGET);
    expect(restored.restoreExactMeasuredAnchor(changed, persistedAnchor)).toBe(false);
    expect(restored.measure(changed).source).toBe("estimated_full");
  });

  test("uses provider total as an append-only anchor and estimates only delta", () => {
    const meter = new ContextMeter(TEST_CONTEXT_BUDGET);
    const firstInput: ModelRequestInput = {
      messages: [
        { role: "system", content: "kernel" },
        { role: "user", content: "first" },
      ],
      tools: [],
    };
    const first = prepareTestModelRequest(firstInput);
    const firstPreflight = meter.measure(first);
    expect(firstPreflight.source).toBe("estimated_full");

    const assistant = { role: "assistant" as const, content: "answer" };
    const output = testModelOutput(first, assistant);
    const measured = meter.recordProviderUsage(first, output);
    expect(measured.source).toBe("provider_measured");
    expect(measured.usedInputTokens).toBe(output.usage.totalTokens);
    expect(measured.calibrationSampleCount).toBe(1);

    const second = prepareTestModelRequest({
      messages: [
        ...firstInput.messages,
        assistant,
        { role: "user", content: "second" },
      ],
      tools: [],
    });
    const secondPreflight = meter.measure(second);
    expect(secondPreflight.source).toBe("measured_plus_estimated_delta");
    expect(secondPreflight.rawDeltaTokens).toBeGreaterThan(0);
    expect(secondPreflight.usedInputTokens).toBe(
      output.usage.totalTokens + (secondPreflight.guardedDeltaTokens ?? 0),
    );
  });

  test("falls back to a full estimate when the anchored prefix changes", () => {
    const meter = new ContextMeter(TEST_CONTEXT_BUDGET);
    const first = prepareTestModelRequest({
      messages: [{ role: "user", content: "original" }],
      tools: [],
    });
    meter.measure(first);
    meter.recordProviderUsage(
      first,
      testModelOutput(first, { role: "assistant", content: "answer" }),
    );

    const rebuilt = prepareTestModelRequest({
      messages: [
        { role: "user", content: "changed" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "next" },
      ],
      tools: [],
    });
    expect(meter.measure(rebuilt).source).toBe("estimated_full");
  });

  test("starts a rebuilt revision with a full estimate while preserving calibration", () => {
    const meter = new ContextMeter(TEST_CONTEXT_BUDGET);
    const first = prepareTestModelRequest({
      messages: [{ role: "user", content: "original" }],
      tools: [],
    });
    meter.measure(first);
    meter.recordProviderUsage(
      first,
      testModelOutput(first, { role: "assistant", content: "answer" }),
    );

    meter.startRevision({
      reason: "context_rebuilt",
      requestConfigHash: first.requestConfigHash,
      toolSchemaHash: first.toolSchemaHash,
    });
    const rebuilt = prepareTestModelRequest({
      messages: [{ role: "user", content: "swapped placeholder" }],
      tools: [],
    });
    expect(meter.measure(rebuilt)).toMatchObject({
      source: "estimated_full",
      calibrationSampleCount: 1,
    });
    expect(meter.measure(rebuilt).lastProviderUsage).toBeUndefined();
    expect(() =>
      meter.recordProviderUsage(
        first,
        testModelOutput(first, { role: "assistant", content: "stale" }),
      ),
    ).toThrow("before measuring");
  });

  test("blocks a guarded estimate above the strict input budget", () => {
    const meter = new ContextMeter(TEST_CONTEXT_BUDGET);
    const prepared = prepareTestModelRequest({
      messages: [{ role: "user", content: "x".repeat(1_000_000) }],
      tools: [],
    });
    const snapshot = meter.measure(prepared);
    expect(snapshot.pressure).toBe("blocked");
    expect(() => meter.assertWithinBudget(snapshot)).toThrow(
      ContextBudgetExceededError,
    );
  });

  test("does not apply text calibration to fixed image buckets", () => {
    const meter = new ContextMeter(TEST_CONTEXT_BUDGET);
    const base = prepareTestModelRequest({
      messages: [{ role: "user", content: "image" }],
      tools: [],
    });
    const prepared = Object.freeze({
      ...base,
      promptSegments: Object.freeze([
        Object.freeze({
          kind: "user" as const,
          normalizedText: "",
          media: Object.freeze([
            Object.freeze({
              assetId: `sha256:${"0".repeat(64)}` as never,
              label: "[Image #1]",
              range: Object.freeze({ start: 0, end: 10 }),
              mimeType: "image/png" as const,
              byteLength: 1,
              sourceWidth: 2048,
              sourceHeight: 2048,
              width: 2048,
              height: 2048,
              planningTokens: 5504,
            }),
          ]),
        }),
      ]),
      mediaOccurrenceCount: 1,
    });
    const snapshot = meter.measure(prepared);
    expect(snapshot.rawFullEstimate).toMatchObject({
      textAndProtocolTokens: 8,
      imageTokens: 5504,
      totalTokens: 5512,
    });
    expect(snapshot.usedInputTokens).toBe(5514);
  });

  test("adds a new image bucket directly to a measured-anchor delta", () => {
    const meter = new ContextMeter(TEST_CONTEXT_BUDGET);
    const firstInput: ModelRequestInput = {
      messages: [{ role: "user", content: "first" }],
      tools: [],
    };
    const first = prepareTestModelRequest(firstInput);
    meter.measure(first);
    const assistant = { role: "assistant" as const, content: "answer" };
    const output = testModelOutput(first, assistant);
    meter.recordProviderUsage(first, output);

    const second = Object.freeze({
      ...first,
      promptSegments: Object.freeze([
        ...first.promptSegments,
        ...first.assistantReplaySegments(assistant),
        Object.freeze({
          kind: "user" as const,
          normalizedText: "see [Image #1]",
          media: Object.freeze([
            Object.freeze({
              assetId: imageAssetIdForBytes(Buffer.from("anchor-image")),
              label: "[Image #1]",
              range: Object.freeze({ start: 4, end: 14 }),
              mimeType: "image/png" as const,
              byteLength: 1,
              sourceWidth: 400,
              sourceHeight: 300,
              width: 400,
              height: 300,
              planningTokens: 384,
            }),
          ]),
        }),
      ]),
      mediaOccurrenceCount: 1,
    });
    const snapshot = meter.measure(second);
    expect(snapshot.source).toBe("measured_plus_estimated_delta");
    expect(snapshot.rawFullEstimate?.imageTokens).toBe(384);
    expect(snapshot.guardedDeltaTokens).toBe(
      Math.ceil(((snapshot.rawDeltaTokens ?? 0) - 384) * snapshot.correctionFactor) +
        384,
    );
  });
});

describe("WebFetch model refiner", () => {
  test("uses the same hard preflight before an internal model request", async () => {
    class RefinerModel extends TestModelClient {
      calls = 0;

      async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
        this.calls += 1;
        return testModelOutput(prepared, {
          role: "assistant",
          content: "refined",
        });
      }
    }

    const model = new RefinerModel();
    const refiner = createModelRefiner({
      createModelClient: () => model,
      contextBudget: TEST_CONTEXT_BUDGET,
      maxContentChars: 1_000_000,
    });
    const error = await refiner
      .refine(
        {
          url: "https://example.com",
          prompt: "summarize",
          content: "x".repeat(1_000_000),
        },
        { signal: new AbortController().signal },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContextBudgetExceededError);
    expect(model.calls).toBe(0);
  });
});

function testTool(properties: Record<string, unknown>) {
  return {
    name: "TestTool",
    description: "A deterministic test tool",
    parameters: { type: "object", properties },
  };
}

function providerResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_test",
      object: "chat.completion",
      created: 0,
      model: "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok", refusal: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 1,
        total_tokens: 6,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
