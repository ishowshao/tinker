import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeSession } from "../agent/runtime-session";
import type { AssistantMessage } from "../agent/types";
import {
  I4_ACTIVE_RECALL_QUALIFICATION,
  I4_SWAP_ONLY_QUALIFICATION_ID,
  selectContextAutomation,
} from "../context/context-automation-policy";
import { createContextSurface } from "../context/context-surface";
import { CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION } from "../context/recall-retirement-contract";
import { runtimeIdFactory } from "../ids/runtime-id";
import type {
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { deriveModelContextBudget } from "../model/model-context-profile";
import { RECALL_TOOL_DEFINITIONS } from "../tools/recall";
import {
  collectingEventSink,
  prepareTestModelRequest,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

class ToolObservationModel extends TestModelClient {
  requestCount = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    const input = testModelRequestInput(prepared);
    const last = input.messages.at(-1);
    let message: AssistantMessage;
    if (last?.role === "user") {
      if (options.identity === undefined) {
        throw new Error("Automatic maintenance fixture has no model identity.");
      }
      const { iteration, runtimeSession } = options.identity;
      message = {
        role: "assistant",
        toolCalls: [
          {
            ...runtimeSession.createToolCall(iteration, 1),
            providerToolCallId: `automatic-read-${this.requestCount}`,
            name: "Read",
            args: { file_path: "large.txt" },
          },
        ],
      };
    } else if (last?.role === "tool") {
      message = { role: "assistant", content: "turn complete" };
    } else {
      throw new Error(`Unexpected automatic fixture role ${last?.role ?? "none"}.`);
    }
    return testModelOutput(prepared, message);
  }
}

class FailingModel extends TestModelClient {
  async request(): Promise<ModelRequestOutput> {
    throw new Error("synthetic provider failure");
  }
}

describe("I4 automatic context maintenance", () => {
  test("commits at most one swap and one retirement after a closed pressured turn", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-i4-auto-"));
    await writeFile(path.join(workspace, "large.txt"), "x".repeat(12 * 1_024));
    const sink = collectingEventSink();
    const model = new ToolObservationModel();
    let pressureArmed = false;
    const session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId: runtimeIdFactory.createSessionId() },
        workspaceRoot: workspace,
        modelName: "test-model",
        profileName: "test-profile",
        maxIterations: 2,
        includeReasoningContent: false,
        contextProfile: TEST_CONTEXT_PROFILE,
        contextBudget: TEST_CONTEXT_BUDGET,
        systemPrompt: "system",
        modelClient: model,
        presentationSinks: [sink],
        persistence: false,
      },
      {
        idFactory: runtimeIdFactory,
        loadMcpConfig: async () => undefined,
        selectShadowPlanning: () =>
          pressureArmed ? { trigger: "runtime_pressure" } : undefined,
        automaticCompactionTrigger: () => ({
          kind: "benchmark_forced",
          targetTokens: 1,
        }),
        automaticRetirementTrigger: () => ({
          kind: "benchmark_forced",
          targetTokens: 1,
        }),
      },
    );

    try {
      for (let turn = 1; turn <= 9; turn += 1) {
        const result = await session.executeTurn({
          userMessage: { role: "user", content: `fixture turn ${turn}` },
          signal: new AbortController().signal,
        });
        expect(result.status).toBe("completed");
      }
      pressureArmed = true;
      const result = await session.executeTurn({
        userMessage: { role: "user", content: "fixture turn 10" },
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("completed");

      const automaticStarted = sink.events.filter(
        (event) =>
          event.type === "context.revision.started" &&
          event.data.reason === "runtime_pressure",
      );
      expect(
        automaticStarted.map((event) =>
          event.type === "context.revision.started" ? event.data.strategy : "",
        ),
      ).toEqual(["swap", "retire_prefix"]);
      expect(automaticStarted).toHaveLength(2);

      const automaticFinished = sink.events.filter(
        (event) =>
          event.type === "context.revision.finished" &&
          event.data.reason === "runtime_pressure",
      );
      expect(automaticFinished).toHaveLength(2);
      expect(automaticFinished[0]?.data).toMatchObject({
        strategy: "swap",
        qualificationId: "deepseek-v4-flash-floor-v1",
      });
      expect(automaticFinished[1]?.data).toMatchObject({
        strategy: "retire_prefix",
        qualificationId: "deepseek-v4-flash-floor-v1",
        retiredTurnCount: 2,
      });
      expect(model.requestCount).toBe(20);
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("reports a nonfatal automatic planning failure and returns to ready", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-i4-auto-fail-"));
    await writeFile(path.join(workspace, "large.txt"), "x".repeat(12 * 1_024));
    const sink = collectingEventSink();
    const model = new ToolObservationModel();
    let pressureArmed = true;
    const session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId: runtimeIdFactory.createSessionId() },
        workspaceRoot: workspace,
        modelName: "test-model",
        profileName: "test-profile",
        maxIterations: 2,
        includeReasoningContent: false,
        contextProfile: TEST_CONTEXT_PROFILE,
        contextBudget: TEST_CONTEXT_BUDGET,
        systemPrompt: "system",
        modelClient: model,
        presentationSinks: [sink],
        persistence: false,
      },
      {
        loadMcpConfig: async () => undefined,
        selectShadowPlanning: () =>
          pressureArmed ? { trigger: "runtime_pressure" } : undefined,
        selectContextAutomation: () => ({
          automaticSwapOnly: true,
          automaticPrefixRetirement: false,
          reason: "swap_only_qualified",
          qualificationId: "test-floor-v1",
        }),
        automaticCompactionTrigger: () => ({
          kind: "benchmark_forced",
          targetTokens: -1,
        }),
      },
    );

    try {
      expect(
        (
          await session.executeTurn({
            userMessage: { role: "user", content: "trigger invalid automatic plan" },
            signal: new AbortController().signal,
          })
        ).status,
      ).toBe("completed");
      const failure = sink.events.find(
        (event) =>
          event.type === "context.revision.failed" &&
          event.data.reason === "runtime_pressure",
      );
      expect(failure?.data).toMatchObject({
        strategy: "swap",
        stage: "plan",
        errorCode: "invalid_target",
        qualificationId: "test-floor-v1",
      });

      pressureArmed = false;
      expect(
        (
          await session.executeTurn({
            userMessage: {
              role: "user",
              content: "prove the session returned to ready",
            },
            signal: new AbortController().signal,
          })
        ).status,
      ).toBe("completed");
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("does not mutate context after a failed turn", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-i4-auto-turn-fail-"),
    );
    const sink = collectingEventSink();
    const session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId: runtimeIdFactory.createSessionId() },
        workspaceRoot: workspace,
        modelName: "test-model",
        profileName: "test-profile",
        maxIterations: 1,
        includeReasoningContent: false,
        contextProfile: TEST_CONTEXT_PROFILE,
        contextBudget: TEST_CONTEXT_BUDGET,
        systemPrompt: "system",
        modelClient: new FailingModel(),
        presentationSinks: [sink],
        persistence: false,
      },
      {
        loadMcpConfig: async () => undefined,
        selectShadowPlanning: () => ({ trigger: "runtime_pressure" }),
        automaticCompactionTrigger: () => ({
          kind: "benchmark_forced",
          targetTokens: 1,
        }),
      },
    );

    try {
      const result = await session.executeTurn({
        userMessage: { role: "user", content: "fail after pressure was observed" },
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("failed");
      expect(
        sink.events.some(
          (event) =>
            event.type === "context.revision.started" &&
            event.data.reason === "runtime_pressure",
        ),
      ).toBe(false);
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("maintains a pressured snapshot during resume without a provider request", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-i4-auto-resume-"));
    await writeFile(path.join(workspace, "large.txt"), "x".repeat(32 * 1_024));
    const sink = collectingEventSink();
    const sessionId = runtimeIdFactory.createSessionId();
    const contextProfile = {
      contextWindowTokens: 256 * 1_024,
      maxSupportedOutputTokens: 64 * 1_024,
    } as const;
    const contextBudget = deriveModelContextBudget(contextProfile);
    const firstModel = new ToolObservationModel();
    const first = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId },
        workspaceRoot: workspace,
        modelName: "test-model",
        profileName: "test-profile",
        maxIterations: 2,
        includeReasoningContent: false,
        contextProfile,
        contextBudget,
        systemPrompt: "system",
        modelClient: firstModel,
        presentationSinks: [sink],
        persistence: false,
      },
      {
        loadMcpConfig: async () => undefined,
        selectShadowPlanning: () => undefined,
      },
    );

    try {
      for (let turn = 1; turn <= 16; turn += 1) {
        expect(
          (
            await first.executeTurn({
              userMessage: { role: "user", content: `resume pressure fixture ${turn}` },
              signal: new AbortController().signal,
            })
          ).status,
        ).toBe("completed");
      }
      await first.dispose({ type: "tui_exit" });

      const resumedModel = new ToolObservationModel();
      const resumed = await createRuntimeSession(
        {
          selection: { mode: "resume", sessionId },
          workspaceRoot: workspace,
          modelName: "test-model",
          profileName: "test-profile",
          maxIterations: 2,
          includeReasoningContent: false,
          contextProfile,
          contextBudget,
          systemPrompt: "system",
          modelClient: resumedModel,
          presentationSinks: [sink],
          persistence: false,
        },
        {
          loadMcpConfig: async () => undefined,
          automaticCompactionTrigger: () => ({
            kind: "benchmark_forced",
            targetTokens: 1,
          }),
          automaticRetirementTrigger: () => ({
            kind: "benchmark_forced",
            targetTokens: 1,
          }),
        },
      );
      try {
        const resumeMaintenance = sink.events.filter(
          (event) =>
            event.type === "context.revision.finished" &&
            event.data.reason === "runtime_pressure",
        );
        expect(
          resumeMaintenance.map((event) =>
            event.type === "context.revision.finished" ? event.data.strategy : "",
          ),
        ).toEqual(["swap", "retire_prefix"]);
        expect(resumedModel.requestCount).toBe(0);
        expect(resumed.canSwitchSession()).toBe(true);
      } finally {
        await resumed.dispose({ type: "tui_exit" });
      }
    } finally {
      await first.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("enables both modes only for the qualified Recall contract and tool", () => {
    const prepared = prepareTestModelRequest({
      messages: [{ role: "system", content: "system" }],
      tools: [...RECALL_TOOL_DEFINITIONS],
    });
    const surface = createContextSurface({
      surfaceId: runtimeIdFactory.createContextSurfaceId(),
      sessionId: runtimeIdFactory.createSessionId(),
      systemPrompt: "system",
      recallContractVersion: CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
      toolDefinitions: [...RECALL_TOOL_DEFINITIONS],
      prepared,
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    expect(
      selectContextAutomation({ profileName: "deepseek-v4-flash", surface }),
    ).toEqual({
      automaticSwapOnly: true,
      automaticPrefixRetirement: true,
      reason: "qualified",
      qualificationId: "deepseek-v4-flash-floor-v1",
    });
    expect(selectContextAutomation({ surface })).toEqual({
      automaticSwapOnly: false,
      automaticPrefixRetirement: false,
      reason: "unprofiled_model",
    });
    expect(
      selectContextAutomation(
        { profileName: "deepseek-v4-flash", surface },
        { ...I4_ACTIVE_RECALL_QUALIFICATION, passed: false },
      ),
    ).toEqual({
      automaticSwapOnly: true,
      automaticPrefixRetirement: false,
      reason: "swap_only_qualified",
      qualificationId: I4_SWAP_ONLY_QUALIFICATION_ID,
    });

    const changedRecall = {
      ...RECALL_TOOL_DEFINITIONS[0],
      description: `${RECALL_TOOL_DEFINITIONS[0].description} changed`,
    };
    const changedPrepared = prepareTestModelRequest({
      messages: [{ role: "system", content: "system" }],
      tools: [changedRecall, RECALL_TOOL_DEFINITIONS[1]],
    });
    const changedSurface = createContextSurface({
      surfaceId: runtimeIdFactory.createContextSurfaceId(),
      sessionId: runtimeIdFactory.createSessionId(),
      systemPrompt: "system",
      recallContractVersion: CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
      toolDefinitions: [changedRecall, RECALL_TOOL_DEFINITIONS[1]],
      prepared: changedPrepared,
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    expect(
      selectContextAutomation({
        profileName: "deepseek-v4-flash",
        surface: changedSurface,
      }),
    ).toEqual({
      automaticSwapOnly: false,
      automaticPrefixRetirement: false,
      reason: "recall_tool_mismatch",
    });
  });
});
