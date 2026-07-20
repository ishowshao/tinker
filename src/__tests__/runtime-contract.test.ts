import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runtimeIdFactory } from "../ids/runtime-id";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import {
  createSessionCompatibilityContract,
  SessionStore,
  type SessionCompatibilityContract,
} from "../session/session-store";
import type { ToolDefinition } from "../tools/types";
import {
  finalizeTestSessionStore,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
} from "./test-runtime";

describe("runtime compatibility boundary", () => {
  test("stores only history-protocol compatibility fields and compares them exactly", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-contract-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const store = await SessionStore.createNew({
      workspaceRoot: workspace,
      sessionId,
      modelName: "test-model",
      systemPrompt: "system",
      idFactory: runtimeIdFactory,
    });
    try {
      finalizeTestSessionStore(store, {
        systemPrompt: "system",
        modelName: "test-model",
        profileName: "primary",
      });
      const current = compatibilityContract();
      expect(Object.keys(current)).toEqual([
        "modelName",
        "profileName",
        "includeReasoningContent",
        "contextProfile",
        "messageProtocol",
        "imageInput",
      ]);
      for (const excluded of [
        "version",
        "contextBudget",
        "systemPromptSha256",
        "toolSchemaSha256",
        "requestConfigSha256",
        "observationFormat",
        "apiBase",
        "apiKey",
        "timeoutMs",
        "maxIterations",
      ]) {
        expect(current).not.toHaveProperty(excluded);
      }
      expect(() => store.assertSessionCompatibility(current)).not.toThrow();

      const mismatches: readonly [string, SessionCompatibilityContract][] = [
        ["modelName", compatibilityContract({ modelName: "other-model" })],
        ["profileName", compatibilityContract({ profileName: "secondary" })],
        [
          "includeReasoningContent",
          compatibilityContract({ includeReasoningContent: true }),
        ],
        [
          "contextProfile",
          compatibilityContract({
            contextProfile: {
              ...TEST_CONTEXT_PROFILE,
              contextWindowTokens: TEST_CONTEXT_PROFILE.contextWindowTokens + 1,
            },
          }),
        ],
        [
          "messageProtocol",
          compatibilityContract({
            messageProtocol: {
              adapter: "fake",
              serializationVersion: "test-model-v2",
            },
          }),
        ],
        [
          "imageInput",
          compatibilityContract({
            imageInput: {
              ...current.imageInput,
              inputModalities: ["text", "image"],
              tokenEstimator: {
                kind: "moonshot-estimate-token-count-v1",
                coverageVersion: "full-request-v1",
                model: "kimi-k3",
                endpoint:
                  "https://api.moonshot.test/v1/tokenizers/estimate-token-count",
                timeoutMs: 30_000,
                maxRetries: 0,
              },
            },
          }),
        ],
      ];
      for (const [field, mismatch] of mismatches) {
        expect(() => store.assertSessionCompatibility(mismatch)).toThrow(field);
      }
      expect(() =>
        store.assertSessionCompatibility(
          createSessionCompatibilityContract({
            modelName: "test-model",
            includeReasoningContent: false,
            contextProfile: TEST_CONTEXT_PROFILE,
            messageProtocol: {
              adapter: "fake",
              serializationVersion: "test-model-v1",
            },
          }),
        ),
      ).toThrow("profileName");
    } finally {
      await store.close("tui_exit").catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("binds payload and endpoint policy but excludes credentials and timeout from request identity", () => {
    const input = {
      messages: [{ role: "system" as const, content: "system" }],
      tools: [TOOL],
    };
    const first = openAiClient({
      apiKey: "first-key",
      baseURL: "https://first.example/v1",
      timeoutMs: 100,
      providerName: "first-provider",
      fetch: stubFetch(),
    }).prepare(input);
    const equivalent = openAiClient({
      apiKey: "second-key",
      baseURL: "https://first.example/v1?route=2#fragment",
      timeoutMs: 200,
      providerName: "second-provider",
      fetch: stubFetch(),
    }).prepare(input);
    const otherEndpoint = openAiClient({
      baseURL: "https://second.example/other",
      fetch: stubFetch(),
    }).prepare(input);

    expect(equivalent.requestConfigHash).toBe(first.requestConfigHash);
    expect(equivalent.toolSchemaHash).toBe(first.toolSchemaHash);
    expect(otherEndpoint.requestConfigHash).not.toBe(first.requestConfigHash);
    expect(
      openAiClient({ stream: false, fetch: stubFetch() }).prepare(input)
        .requestConfigHash,
    ).not.toBe(first.requestConfigHash);
    expect(
      openAiClient({ model: "other-model" }).prepare(input).requestConfigHash,
    ).not.toBe(first.requestConfigHash);
    expect(
      openAiClient({ includeReasoningContent: true }).prepare(input).requestConfigHash,
    ).not.toBe(first.requestConfigHash);
    expect(
      openAiClient({
        contextBudget: {
          ...TEST_CONTEXT_BUDGET,
          requestMaxOutputTokens: TEST_CONTEXT_BUDGET.requestMaxOutputTokens - 1,
        },
      }).prepare(input).requestConfigHash,
    ).not.toBe(first.requestConfigHash);

    const estimator = {
      kind: "moonshot-estimate-token-count-v1" as const,
      model: "kimi-k3",
      apiBase: "https://api.moonshot.test/v1",
      apiKey: "first-estimator-key",
      timeoutMs: 30_000,
      maxRetries: 0 as const,
    };
    const imageFirst = openAiClient({
      inputModalities: ["text", "image"],
      tokenEstimator: estimator,
    }).prepare(input);
    const imageWithOtherCredential = openAiClient({
      inputModalities: ["text", "image"],
      tokenEstimator: { ...estimator, apiKey: "second-estimator-key" },
    }).prepare(input);
    expect(imageWithOtherCredential.requestConfigHash).toBe(
      imageFirst.requestConfigHash,
    );
    expect(
      openAiClient({
        inputModalities: ["text", "image"],
        tokenEstimator: {
          ...estimator,
          apiBase: "https://other.moonshot.test/v1",
        },
      }).prepare(input).requestConfigHash,
    ).not.toBe(imageFirst.requestConfigHash);
    expect(
      openAiClient({
        inputModalities: ["text", "image"],
        tokenEstimator: { ...estimator, model: "other-estimator-model" },
      }).prepare(input).requestConfigHash,
    ).not.toBe(imageFirst.requestConfigHash);
    expect(
      openAiClient({
        inputModalities: ["text", "image"],
        tokenEstimator: { ...estimator, timeoutMs: 20_000 },
      }).prepare(input).requestConfigHash,
    ).not.toBe(imageFirst.requestConfigHash);
  });
});

const TOOL: ToolDefinition = {
  name: "Read",
  description: "Read a file",
  parameters: { type: "object", properties: {} },
};

function compatibilityContract(
  overrides: Partial<SessionCompatibilityContract> = {},
): SessionCompatibilityContract {
  return createSessionCompatibilityContract({
    modelName: overrides.modelName ?? "test-model",
    profileName: overrides.profileName ?? "primary",
    includeReasoningContent: overrides.includeReasoningContent ?? false,
    contextProfile: overrides.contextProfile ?? TEST_CONTEXT_PROFILE,
    messageProtocol: overrides.messageProtocol ?? {
      adapter: "fake",
      serializationVersion: "test-model-v1",
    },
    inputModalities: overrides.imageInput?.inputModalities,
    tokenEstimator: overrides.imageInput?.tokenEstimator,
  });
}

function openAiClient(
  overrides: Partial<ConstructorParameters<typeof OpenAIChatModelClient>[0]> = {},
): OpenAIChatModelClient {
  return new OpenAIChatModelClient({
    apiKey: "test-key",
    model: "test-model",
    contextBudget: TEST_CONTEXT_BUDGET,
    ...overrides,
  });
}

function stubFetch(): typeof fetch {
  return Object.assign(async () => new Response(), {
    preconnect() {},
  });
}
