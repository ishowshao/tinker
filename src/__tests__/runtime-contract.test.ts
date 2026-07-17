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

  test("excludes endpoint, key, timeout, transport, and provider label from request identity", () => {
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
    const second = openAiClient({
      apiKey: "second-key",
      baseURL: "https://second.example/other?route=2#fragment",
      timeoutMs: 200,
      providerName: "second-provider",
      fetch: stubFetch(),
    }).prepare(input);

    expect(second.requestConfigHash).toBe(first.requestConfigHash);
    expect(second.toolSchemaHash).toBe(first.toolSchemaHash);
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
