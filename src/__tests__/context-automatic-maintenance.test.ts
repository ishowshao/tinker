import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeSession } from "../agent/runtime-session";
import { isContextPressureNotice } from "../agent/context-pressure-notice";
import type { AgentMessage, AssistantMessage } from "../agent/types";
import { toolResultDisplayText } from "../agent/tool-result-content";
import {
  I4_ACTIVE_RECALL_QUALIFICATION,
  I4_SWAP_ONLY_QUALIFICATION_ID,
  RECALL_SESSION_SELECTION_CONTINUITY,
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
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

class ToolObservationModel extends TestModelClient {
  requestCount = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    const input = testModelRequestInput(prepared);
    // Pressure notices are runtime-injected user messages; scripted fixtures
    // ignore them when deciding the next scripted step.
    const last = input.messages
      .filter((entry) => !isContextPressureNotice(entry))
      .at(-1);
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

class FinalResponsePressureModel extends TestModelClient {
  requestCount = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    if (this.requestCount === 1) {
      if (options.identity === undefined) {
        throw new Error("Turn-close pressure fixture has no model identity.");
      }
      const { iteration, runtimeSession } = options.identity;
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...runtimeSession.createToolCall(iteration, 1),
            providerToolCallId: "turn-close-pressure-read",
            name: "Read",
            args: { file_path: "large.txt" },
          },
        ],
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "final-response-pressure ".repeat(6_000),
    });
  }
}

class MultiObservationModel extends TestModelClient {
  requestCount = 0;
  readonly requestedMessages: AgentMessage[][] = [];

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    const input = testModelRequestInput(prepared);
    this.requestedMessages.push([...input.messages]);
    if (this.requestCount <= 2) {
      if (options.identity === undefined) {
        throw new Error("Active-turn maintenance fixture has no model identity.");
      }
      const { iteration, runtimeSession } = options.identity;
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...runtimeSession.createToolCall(iteration, 1),
            providerToolCallId: `active-read-${this.requestCount}`,
            name: "Read",
            args: { file_path: "large.txt" },
          },
        ],
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "active turn complete",
    });
  }
}

class ActiveRetirementModel extends TestModelClient {
  toolMode = false;
  private activeRequestCount = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    if (!this.toolMode) {
      return testModelOutput(prepared, {
        role: "assistant",
        content: "history-".repeat(3_750),
      });
    }
    this.activeRequestCount += 1;
    if (this.activeRequestCount === 1) {
      if (options.identity === undefined) {
        throw new Error("Active retirement fixture has no model identity.");
      }
      const { iteration, runtimeSession } = options.identity;
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...runtimeSession.createToolCall(iteration, 1),
            providerToolCallId: "active-retirement-read",
            name: "Read",
            args: { file_path: "large.txt" },
          },
        ],
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "retirement complete",
    });
  }
}

describe("I4 automatic context maintenance", () => {
  test("maintains context when the final response crosses the pressure threshold", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-turn-close-swap-"));
    await writeFile(path.join(workspace, "large.txt"), "x".repeat(40 * 1_024));
    const sink = collectingEventSink();
    const model = new FinalResponsePressureModel();
    const contextProfile = {
      contextWindowTokens: 128 * 1_024,
      maxSupportedOutputTokens: 64 * 1_024,
    } as const;
    const session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId: runtimeIdFactory.createSessionId() },
        workspaceRoot: workspace,
        modelName: "test-model",
        profileName: "test-profile",
        maxIterations: 2,
        includeReasoningContent: false,
        contextProfile,
        contextBudget: deriveModelContextBudget(contextProfile),
        systemPrompt: "system",
        modelClient: model,
        presentationSinks: [sink],
        persistence: false,
      },
      {
        loadMcpConfig: async () => undefined,
        selectShadowPlanning: () => undefined,
        automaticCompactionTrigger: () => ({
          kind: "benchmark_forced",
          targetTokens: 1,
        }),
      },
    );

    try {
      const result = await session.executeTurn({
        userMessage: { role: "user", content: "create turn-close pressure" },
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("completed");
      expect(model.requestCount).toBe(2);

      const turnCloseUsage = sink.events.find(
        (
          event,
        ): event is Extract<
          (typeof sink.events)[number],
          { type: "context.usage.updated" }
        > =>
          event.type === "context.usage.updated" && event.data.phase === "turn_close",
      );
      expect(turnCloseUsage?.data.snapshot.pressure).toBe("triggered");
      const automaticSwap = sink.events.find(
        (event) =>
          event.type === "context.revision.finished" &&
          event.data.strategy === "swap" &&
          event.data.reason === "runtime_pressure",
      );
      expect(automaticSwap?.data).toMatchObject({
        strategy: "swap",
        addedOverrideCount: 1,
      });
      const turnFinished = sink.events.find((event) => event.type === "turn.finished");
      expect(turnFinished?.eventSequence).toBeLessThan(
        automaticSwap?.eventSequence ?? 0,
      );
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("swaps consumed observations before the active turn completes", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-active-turn-swap-"));
    await writeFile(path.join(workspace, "large.txt"), "x".repeat(110 * 1_024));
    const sink = collectingEventSink();
    const model = new MultiObservationModel();
    const contextProfile = {
      contextWindowTokens: 128 * 1_024,
      maxSupportedOutputTokens: 64 * 1_024,
    } as const;
    const session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId: runtimeIdFactory.createSessionId() },
        workspaceRoot: workspace,
        modelName: "test-model",
        profileName: "test-profile",
        maxIterations: 3,
        includeReasoningContent: false,
        contextProfile,
        contextBudget: deriveModelContextBudget(contextProfile),
        systemPrompt: "system",
        modelClient: model,
        presentationSinks: [sink],
        persistence: false,
      },
      { loadMcpConfig: async () => undefined },
    );

    try {
      const result = await session.executeTurn({
        userMessage: { role: "user", content: "read the large file twice" },
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("completed");
      expect(model.requestCount).toBe(3);
      const activeSwap = sink.events.find(
        (event) =>
          event.type === "context.revision.finished" &&
          event.data.strategy === "swap" &&
          event.data.reason === "runtime_pressure" &&
          event.data.revisionNumber !== undefined,
      );
      expect(activeSwap?.data).toMatchObject({
        strategy: "swap",
        addedOverrideCount: 1,
      });
      const thirdRequestTools = model.requestedMessages[2]?.filter(
        (message) => message.role === "tool",
      );
      expect(thirdRequestTools).toHaveLength(2);
      expect(
        thirdRequestTools?.filter(
          (message) =>
            message.role === "tool" &&
            toolResultDisplayText(message.content).startsWith(
              "[Tinker historical tool observation swapped]",
            ),
        ),
      ).toHaveLength(1);
      const turnFinished = sink.events.find((event) => event.type === "turn.finished");
      expect(activeSwap?.eventSequence).toBeLessThan(turnFinished?.eventSequence ?? 0);
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("retires every eligible closed turn behind an active-turn anchor", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-active-turn-retire-"),
    );
    await writeFile(path.join(workspace, "large.txt"), "x".repeat(110 * 1_024));
    const sink = collectingEventSink();
    const model = new ActiveRetirementModel();
    const contextProfile = {
      contextWindowTokens: 128 * 1_024,
      maxSupportedOutputTokens: 64 * 1_024,
    } as const;
    const session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId: runtimeIdFactory.createSessionId() },
        workspaceRoot: workspace,
        modelName: "test-model",
        profileName: "test-profile",
        maxIterations: 2,
        includeReasoningContent: false,
        contextProfile,
        contextBudget: deriveModelContextBudget(contextProfile),
        systemPrompt: "system",
        modelClient: model,
        presentationSinks: [sink],
        persistence: false,
      },
      {
        loadMcpConfig: async () => undefined,
      },
    );

    try {
      for (let turn = 1; turn <= 3; turn += 1) {
        expect(
          (
            await session.executeTurn({
              userMessage: { role: "user", content: `history turn ${turn}` },
              signal: new AbortController().signal,
            })
          ).status,
        ).toBe("completed");
      }
      model.toolMode = true;
      const result = await session.executeTurn({
        userMessage: { role: "user", content: "start the active retirement turn" },
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("completed");
      const retirement = sink.events.find(
        (event) =>
          event.type === "context.revision.finished" &&
          event.data.strategy === "retire_prefix" &&
          event.data.reason === "runtime_pressure" &&
          event.data.revisionNumber !== undefined,
      );
      expect(retirement?.data).toMatchObject({
        strategy: "retire_prefix",
        retiredTurnCount: 3,
      });
      const turnFinished = sink.events
        .filter((event) => event.type === "turn.finished")
        .at(-1);
      expect(retirement?.eventSequence).toBeLessThan(turnFinished?.eventSequence ?? 0);
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

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
        qualificationId: RECALL_SESSION_SELECTION_CONTINUITY.decisionId,
      });
      expect(automaticFinished[1]?.data).toMatchObject({
        strategy: "retire_prefix",
        qualificationId: RECALL_SESSION_SELECTION_CONTINUITY.decisionId,
        retiredTurnCount: 9,
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
        // Pressure notices add canonical user frames during pressured turns,
        // which can shift retirement eligibility; the resume maintenance must
        // still begin with a swap and may retire the newly complete prefix.
        const resumeStrategies = resumeMaintenance.map((event) =>
          event.type === "context.revision.finished" ? event.data.strategy : "",
        );
        expect(resumeStrategies[0]).toBe("swap");
        expect(
          resumeStrategies.every(
            (strategy) => strategy === "swap" || strategy === "retire_prefix",
          ),
        ).toBe(true);
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

  test("binds continuity to the reviewed surface without qualifying the old report", () => {
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
      reason: "explicit_continuity",
      qualificationId: RECALL_SESSION_SELECTION_CONTINUITY.decisionId,
    });
    // Old measured evidence does not qualify the description-cleaned surface,
    // and copying it must not inherit the explicit continuity decision.
    for (const passed of [false, true]) {
      expect(
        selectContextAutomation(
          { profileName: "deepseek-v4-flash", surface },
          { ...I4_ACTIVE_RECALL_QUALIFICATION, passed },
        ),
      ).toEqual({
        automaticSwapOnly: false,
        automaticPrefixRetirement: false,
        reason: "recall_tool_mismatch",
      });
    }
    // Synthetic current-surface evidence exercises ordinary gate branches only.
    const syntheticEvidence = {
      ...I4_ACTIVE_RECALL_QUALIFICATION,
      recallToolDefinitionSha256:
        RECALL_SESSION_SELECTION_CONTINUITY.recallToolDefinitionSha256,
    };
    expect(
      selectContextAutomation(
        { profileName: "deepseek-v4-flash", surface },
        { ...syntheticEvidence, passed: true },
      ),
    ).toMatchObject({
      automaticSwapOnly: true,
      automaticPrefixRetirement: true,
      reason: "qualified",
    });
    expect(selectContextAutomation({ surface })).toEqual({
      automaticSwapOnly: false,
      automaticPrefixRetirement: false,
      reason: "unprofiled_model",
    });
    expect(
      selectContextAutomation(
        { profileName: "deepseek-v4-flash", surface },
        { ...syntheticEvidence, passed: false },
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
