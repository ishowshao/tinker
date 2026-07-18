import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextMeter } from "../agent/context-meter";
import { createRuntimeSession } from "../agent/runtime-session";
import type { IterationIdentity, TurnIdentity } from "../agent/types";
import type { ToolCall } from "../agent/types";
import { ContextManager, ContextManagerError } from "../context/context-manager";
import { ContextBuilder } from "../agent/context-builder";
import { ContextRevisionCompiler } from "../context/context-revision-compiler";
import {
  contextSurfaceChangeManifestHash,
  contextSurfaceChanges,
  createContextSurface,
} from "../context/context-surface";
import {
  canonicalSequenceHash,
  renderedMessageHash,
} from "../context/compiled-context-hash";
import { CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION } from "../context/recall-retirement-contract";
import { recallFirstRetirementPolicyV1 } from "../context/context-policy";
import { PrefixRetirementPlanner } from "../context/prefix-retirement-planner";
import { runtimeIdFactory } from "../ids/runtime-id";
import { CommittedPrefixAuditor } from "../model/committed-prefix-auditor";
import type { ModelRequestOutput, PreparedModelRequest } from "../model/model-client";
import { estimatePromptSegments } from "../model/token-estimator";
import {
  SessionStore,
  type CommitPrefixRetirementRevisionFaultStage,
} from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import type { ToolDefinition } from "../tools/types";
import {
  finalizeTestSessionStore,
  prepareTestModelRequest,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  collectingEventSink,
  testModelOutput,
} from "./test-runtime";

const recallTools: readonly ToolDefinition[] = [
  {
    name: "Read",
    description: "Read a file",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "Recall",
    description: "Search or retrieve historical session messages",
    parameters: { type: "object", properties: {} },
  },
];

describe("I3 Recall-first prefix retirement", () => {
  test("retires the maximal complete prefix, preserves Recall, and resumes the exact active suffix", async () => {
    const fixture = await createFixture("tinker-i3-retire-");
    try {
      appendTextTurns(fixture, 12, (turnNumber) =>
        turnNumber === 1
          ? `retired-marker-${"x".repeat(2_000)}`
          : `turn-${turnNumber}-${"y".repeat(200)}`,
      );
      const canonicalBefore = canonicalStorage(fixture.store.databasePath);
      const searchBefore = fixture.store.historyReader().search({
        query: "retired-marker",
        limit: 10,
        offset: 0,
      });
      expect(searchBefore.hits).toHaveLength(1);
      const source = searchBefore.hits[0]?.source;
      if (source === undefined) throw new Error("Retired marker source is missing.");
      const getBefore = fixture.store.historyReader().get({
        source,
        byteOffset: 0,
        byteLimit: 4_096,
      });

      const result = await fixture.manager.retirePrefix({
        kind: "benchmark_forced",
        targetTokens: 1,
      });
      expect(result).toMatchObject({
        status: "retired",
        outcome: "retirement_floor",
        previousRevisionNumber: 1,
        revisionNumber: 2,
        retiredTurnCount: 4,
        retiredFrameCount: 8,
        retiredMessageCount: 8,
        activeOverrideCount: 0,
      });
      if (result.status !== "retired") {
        throw new Error("Expected prefix retirement to commit.");
      }
      const snapshot = fixture.store.loadContextSnapshot();
      const compiled = new ContextRevisionCompiler().compileActive(snapshot);
      expect(snapshot.revision).toMatchObject({
        kind: "prefix_retirement",
        keepFromOrdinal: 10,
        retiredThroughOrdinal: 9,
      });
      expect(compiled.entries.map((entry) => entry.ordinal)).toEqual([
        1,
        ...Array.from({ length: 16 }, (_, index) => index + 10),
      ]);
      expect(
        compiled.entries.some((entry) =>
          JSON.stringify(entry.message).includes("retired-marker"),
        ),
      ).toBe(false);
      expect(canonicalStorage(fixture.store.databasePath)).toEqual(canonicalBefore);
      expect(
        fixture.store.historyReader().search({
          query: "retired-marker",
          limit: 10,
          offset: 0,
        }),
      ).toEqual(searchBefore);
      expect(
        fixture.store.historyReader().get({
          source,
          byteOffset: 0,
          byteLimit: 4_096,
        }),
      ).toEqual(getBefore);
      expect(fixture.model.requestCount).toBe(0);

      const expectedMessages = compiled.entries.map((entry) => entry.message);
      await fixture.store.close("tui_exit");
      fixture.closed = true;
      const reopened = await SessionStore.openExisting({
        workspaceRoot: fixture.workspace,
        sessionId: fixture.sessionId,
      });
      try {
        const resumed = new ContextRevisionCompiler().compileActive(
          reopened.loadContextSnapshot(),
        );
        expect(resumed.entries.map((entry) => entry.message)).toEqual(expectedMessages);
        expect(
          reopened.historyReader().get({
            source,
            byteOffset: 0,
            byteLimit: 4_096,
          }),
        ).toEqual(getBefore);
      } finally {
        await reopened.close("tui_exit");
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("returns no_complete_prefix when fewer than nine active turns exist", async () => {
    const fixture = await createFixture("tinker-i3-protected-");
    try {
      appendTextTurns(fixture, 8, (turnNumber) => `turn-${turnNumber}`);
      const before = fixture.store.loadContextSnapshot();
      const result = await fixture.manager.retirePrefix({
        kind: "benchmark_forced",
        targetTokens: 1,
      });
      expect(result).toMatchObject({
        status: "unchanged",
        outcome: "no_complete_prefix",
        keepFromOrdinal: 1,
      });
      expect(fixture.store.loadContextSnapshot().revision.revisionId).toBe(
        before.revision.revisionId,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test("selects the first boundary that reaches a forced target", async () => {
    const fixture = await createFixture("tinker-i3-minimal-boundary-");
    try {
      appendTextTurns(
        fixture,
        12,
        (turnNumber) => `turn-${turnNumber}-${"m".repeat(200)}`,
      );
      const built = fixture.ledger.buildCommittedModelRequest(recallTools);
      const prepared = fixture.model.prepare(built.request);
      const usage = fixture.meter.measure(prepared);
      const turns = fixture.store.loadClosedTurnBoundaries();
      const expectedBoundary = turns[2];
      if (expectedBoundary === undefined) {
        throw new Error("Expected a third closed turn.");
      }
      const compiler = new ContextRevisionCompiler();
      const projected = compiler.compileProspective({
        active: built.compiled,
        canonical: built.canonical,
        activeOverrides: built.activeOverrides,
        addedOverrides: [],
        activeSurface: built.surface,
        keepFromOrdinal: expectedBoundary.firstOrdinal,
      });
      const projectedRequest = new ContextBuilder().build({
        canonical: built.canonical,
        revision: built.revision,
        surface: built.surface,
        activeOverrides: [],
        compiled: projected,
        tools: recallTools,
      });
      const targetTokens = Math.ceil(
        estimatePromptSegments(
          fixture.model.prepare(projectedRequest.request).promptSegments,
        ).totalTokens * usage.correctionFactor,
      );
      const result = new PrefixRetirementPlanner(fixture.model).plan({
        active: built.compiled,
        revision: built.revision,
        surface: built.surface,
        activeOverrides: built.activeOverrides,
        canonical: built.canonical,
        closedTurns: turns,
        activePrepared: prepared,
        activeUsage: usage,
        tools: recallTools,
        policy: recallFirstRetirementPolicyV1,
        trigger: "benchmark_forced",
        forcedTargetTokens: targetTokens,
      });
      expect(result.outcome).toBe("target_reached");
      if (!("plan" in result)) throw new Error("Expected a retirement plan.");
      expect(result.plan.nextKeepFromOrdinal).toBe(expectedBoundary.firstOrdinal);
      expect(result.plan.retiredTurnCount).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  test("keeps retired overrides as audit rows across append, swap, and repeated retirement", async () => {
    const fixture = await createFixture("tinker-i3-override-chain-");
    try {
      appendReadTurn(fixture, `old-observation-${"o".repeat(10_000)}`);
      appendTextTurns(fixture, 8, (turnNumber) => `tail-${turnNumber}`);
      const firstSwap = await fixture.manager.compact({
        kind: "benchmark_forced",
        targetTokens: 1,
      });
      expect(firstSwap).toMatchObject({
        status: "compacted",
        addedOverrideCount: 1,
        activeOverrideCount: 1,
      });

      appendTextTurns(fixture, 4, (turnNumber) => `after-swap-${turnNumber}`);
      const firstRetirement = await fixture.manager.retirePrefix({
        kind: "benchmark_forced",
        targetTokens: 1,
      });
      expect(firstRetirement).toMatchObject({
        status: "retired",
        retiredTurnCount: 5,
        activeOverrideCount: 0,
      });
      const firstKeep = fixture.store.loadContextSnapshot().revision.keepFromOrdinal;
      expect(overrideCount(fixture.store.databasePath)).toBe(1);

      const refreshBase = fixture.store.loadContextSnapshot();
      const refreshPrepared = fixture.model.prepare({
        messages: [{ role: "system", content: "system-v2" }],
        tools: [...recallTools],
      });
      const refreshedSurface = createContextSurface({
        surfaceId: runtimeIdFactory.createContextSurfaceId(),
        sessionId: fixture.sessionId,
        systemPrompt: "system-v2",
        recallContractVersion: CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
        toolDefinitions: recallTools,
        prepared: refreshPrepared,
        createdAt: "2026-07-18T00:00:00.000Z",
      });
      const refreshChanges = contextSurfaceChanges(
        refreshBase.surface,
        refreshedSurface,
      );
      const refreshCompiler = new ContextRevisionCompiler();
      const refreshCandidate = refreshCompiler.compileProspective({
        active: refreshCompiler.compileActive(refreshBase),
        canonical: refreshBase.canonical,
        activeOverrides: refreshBase.activeOverrides,
        addedOverrides: [],
        activeSurface: refreshBase.surface,
        surface: refreshedSurface,
      });
      const refreshRevision = fixture.store.commitSurfaceRefresh({
        revisionId: runtimeIdFactory.createContextRevisionId(),
        expectedBaseRevisionId: refreshBase.revision.revisionId,
        expectedBaseRevisionNumber: refreshBase.revision.revisionNumber,
        expectedCanonicalThroughOrdinal: refreshBase.canonical.messages.length,
        expectedBaseActiveOverrideManifestSha256:
          refreshBase.revision.activeOverrideManifestSha256,
        surface: refreshedSurface,
        changes: refreshChanges,
        changeManifestSha256: contextSurfaceChangeManifestHash(refreshChanges),
        canonicalSequenceSha256: canonicalSequenceHash(refreshBase.canonical),
        renderedMessageSha256: renderedMessageHash(refreshCandidate.entries),
      });
      expect(refreshRevision).toMatchObject({
        kind: "surface_refresh",
        keepFromOrdinal: firstKeep,
        activeOverrideCount: 0,
      });

      appendReadTurn(fixture, `new-observation-${"n".repeat(10_000)}`);
      appendTextTurns(fixture, 8, (turnNumber) => `new-tail-${turnNumber}`);
      const secondSwap = await fixture.manager.compact({
        kind: "benchmark_forced",
        targetTokens: 1,
      });
      expect(secondSwap).toMatchObject({
        status: "compacted",
        addedOverrideCount: 1,
        activeOverrideCount: 1,
      });
      expect(fixture.store.loadContextSnapshot().revision.keepFromOrdinal).toBe(
        firstKeep,
      );
      expect(overrideCount(fixture.store.databasePath)).toBe(2);

      const secondRetirement = await fixture.manager.retirePrefix({
        kind: "benchmark_forced",
        targetTokens: 1,
      });
      expect(secondRetirement).toMatchObject({
        status: "retired",
        activeOverrideCount: 0,
      });
      if (secondRetirement.status !== "retired") {
        throw new Error("Expected repeated prefix retirement.");
      }
      expect(secondRetirement.keepFromOrdinal).toBeGreaterThan(firstKeep);
      expect(overrideCount(fixture.store.databasePath)).toBe(2);
      expect(fixture.store.loadContextSnapshot().activeOverrides).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("runs the RuntimeSession retirement API without a provider request and continues the session", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-i3-runtime-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const sink = collectingEventSink();
    const model = new RuntimeRetirementModel();
    const session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId },
        workspaceRoot: workspace,
        modelName: "test-model",
        maxIterations: 1,
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
        manualRetirementTrigger: () => ({
          kind: "benchmark_forced",
          targetTokens: 1,
        }),
      },
    );
    try {
      for (let index = 0; index < 10; index += 1) {
        await session.executeTurn({
          userPrompt: `runtime-turn-${index}-${"r".repeat(100)}`,
          signal: new AbortController().signal,
        });
      }
      const requestCountBefore = model.requestCount;
      const result = await session.retireContext();
      expect(result).toMatchObject({
        status: "retired",
        previousRevisionNumber: 1,
        revisionNumber: 2,
        retiredTurnCount: 2,
      });
      expect(model.requestCount).toBe(requestCountBefore);
      const revisionEvents = sink.events.filter((event) =>
        event.type.startsWith("context.revision."),
      );
      expect(revisionEvents.map((event) => event.type)).toEqual([
        "context.revision.started",
        "context.revision.finished",
      ]);
      expect(JSON.stringify(revisionEvents)).not.toContain("runtime-turn-0");
      await session.executeTurn({
        userPrompt: "continue-after-retirement",
        signal: new AbortController().signal,
      });
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
    }
    const reopened = await SessionStore.openExisting({
      workspaceRoot: workspace,
      sessionId,
    });
    try {
      expect(reopened.loadContextSnapshot().revision).toMatchObject({
        kind: "prefix_retirement",
        revisionNumber: 2,
      });
    } finally {
      await reopened.close("tui_exit");
      await rm(workspace, { recursive: true });
    }
  });

  test("keeps a committed retirement active when runtime activation fails", async () => {
    const fixture = await createFixture("tinker-i3-activation-fault-");
    try {
      appendTextTurns(
        fixture,
        10,
        (turnNumber) => `turn-${turnNumber}-${"q".repeat(100)}`,
      );
      fixture.store.writeMeasuredContextAnchor({
        totalTokens: 30,
        promptTokens: 20,
        completionTokens: 10,
        segmentCount: 1,
        prefixHash: "1".repeat(64),
        requestConfigHash: "2".repeat(64),
        toolSchemaHash: "3".repeat(64),
      });
      const manager = new ContextManager({
        store: fixture.store,
        ledger: fixture.ledger,
        model: fixture.model,
        contextMeter: fixture.meter,
        committedPrefixAuditor: new CommittedPrefixAuditor(),
        idFactory: runtimeIdFactory,
        tools: () => recallTools,
        onUsageUpdated: async () => {
          throw new Error("activation event failed");
        },
      });

      const error = await manager
        .retirePrefix({ kind: "benchmark_forced", targetTokens: 1 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ContextManagerError);
      expect(error).toMatchObject({
        stage: "activate",
        fatal: true,
        committed: true,
      });
      expect(fixture.store.loadContextSnapshot().revision).toMatchObject({
        kind: "prefix_retirement",
        revisionNumber: 2,
      });
      expect(fixture.store.readActiveMeasuredContextAnchor()).toBeUndefined();
      expect(revisionCount(fixture.store.databasePath)).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  for (const stage of [
    "before_revision_insert",
    "after_revision_insert",
    "after_override_readback",
    "after_measurement_delete",
    "after_active_update",
    "after_snapshot_readback",
  ] satisfies readonly CommitPrefixRetirementRevisionFaultStage[]) {
    test(`rolls back the retirement transaction at ${stage}`, async () => {
      const fixture = await createFixture(`tinker-i3-fault-${stage}-`);
      try {
        appendTextTurns(
          fixture,
          10,
          (turnNumber) => `turn-${turnNumber}-${"z".repeat(100)}`,
        );
        const plan = retirementPlan(fixture);
        fixture.store.writeMeasuredContextAnchor({
          totalTokens: 30,
          promptTokens: 20,
          completionTokens: 10,
          segmentCount: 1,
          prefixHash: "1".repeat(64),
          requestConfigHash: "2".repeat(64),
          toolSchemaHash: "3".repeat(64),
        });
        const base = fixture.store.loadContextSnapshot();
        expect(() =>
          fixture.store.commitPrefixRetirementRevision(commitInput(plan), {
            faultInjector(point) {
              if (point === stage) throw new Error(`fault:${stage}`);
            },
          }),
        ).toThrow();
        const after = fixture.store.loadContextSnapshot();
        expect(after.revision.revisionId).toBe(base.revision.revisionId);
        expect(after.revision.revisionNumber).toBe(1);
        expect(fixture.store.readActiveMeasuredContextAnchor()).toBeDefined();
        expect(revisionCount(fixture.store.databasePath)).toBe(1);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

async function createFixture(prefix: string) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), prefix));
  const sessionId = runtimeIdFactory.createSessionId();
  const store = await SessionStore.createNew({
    workspaceRoot: workspace,
    sessionId,
    modelName: "test-model",
    systemPrompt: "system",
    idFactory: runtimeIdFactory,
  });
  const model = new RetirementModel();
  finalizeTestSessionStore(store, {
    systemPrompt: "system",
    tools: recallTools,
    modelClient: model,
  });
  const ledger = new SqliteSessionLedger(store, runtimeIdFactory);
  const meter = new ContextMeter(TEST_CONTEXT_BUDGET);
  const manager = new ContextManager({
    store,
    ledger,
    model,
    contextMeter: meter,
    committedPrefixAuditor: new CommittedPrefixAuditor(),
    idFactory: runtimeIdFactory,
    tools: () => recallTools,
    onUsageUpdated: async () => undefined,
  });
  const fixture = {
    workspace,
    sessionId,
    store,
    ledger,
    model,
    meter,
    manager,
    nextTurnNumber: 1,
    closed: false,
    cleanup: async () => {
      if (!fixture.closed) {
        await store.close("runner_failed").catch(() => undefined);
      }
      await rm(workspace, { recursive: true });
    },
  };
  return fixture;
}

function appendTextTurns(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  count: number,
  prompt: (turnNumber: number) => string,
): void {
  for (let index = 0; index < count; index += 1) {
    const turn: TurnIdentity = {
      sessionId: fixture.sessionId,
      turnId: runtimeIdFactory.createTurnId(),
      turnNumber: fixture.nextTurnNumber,
    };
    fixture.nextTurnNumber += 1;
    const iteration: IterationIdentity = {
      ...turn,
      iterationId: runtimeIdFactory.createIterationId(),
      iterationNumber: 1,
    };
    const pending = fixture.ledger.beginTurn({
      turn,
      userPrompt: prompt(turn.turnNumber),
    });
    fixture.store.beginIteration(iteration);
    pending.agent.appendAssistant({
      iteration,
      message: {
        role: "assistant",
        content: `completed-turn-${turn.turnNumber}-${"a".repeat(100)}`,
      },
      provider: "test",
      model: "test-model",
    });
    pending.finish({
      status: "completed",
      finalText: `completed-turn-${turn.turnNumber}`,
      lastIteration: iteration,
    });
  }
}

function appendReadTurn(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  observation: string,
): void {
  const turn: TurnIdentity = {
    sessionId: fixture.sessionId,
    turnId: runtimeIdFactory.createTurnId(),
    turnNumber: fixture.nextTurnNumber,
  };
  fixture.nextTurnNumber += 1;
  const firstIteration: IterationIdentity = {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 1,
  };
  const call: ToolCall = {
    ...firstIteration,
    toolCallId: runtimeIdFactory.createToolCallId(),
    toolCallNumber: 1,
    providerToolCallId: `provider-${turn.turnNumber}`,
    name: "Read",
    args: { file_path: `history-${turn.turnNumber}.txt` },
  };
  const pending = fixture.ledger.beginTurn({
    turn,
    userPrompt: `read-${turn.turnNumber}`,
  });
  fixture.store.beginIteration(firstIteration);
  pending.agent.appendAssistant({
    iteration: firstIteration,
    message: { role: "assistant", toolCalls: [call] },
    provider: "test",
    model: "test-model",
  });
  pending.agent.commitToolCompletions([
    {
      call,
      kind: "returned",
      raw: {
        kind: "read",
        ok: true,
        filePath: `history-${turn.turnNumber}.txt`,
        startLine: 1,
        endLine: 100,
        sha256: "a".repeat(64),
        sizeBytes: Buffer.byteLength(observation),
        content: observation,
      },
      observation,
    },
  ]);
  fixture.store.finishIterationForContinuation(firstIteration);
  const finalIteration: IterationIdentity = {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 2,
  };
  fixture.store.beginIteration(finalIteration);
  pending.agent.appendAssistant({
    iteration: finalIteration,
    message: { role: "assistant", content: "done" },
    provider: "test",
    model: "test-model",
  });
  pending.finish({
    status: "completed",
    finalText: "done",
    lastIteration: finalIteration,
  });
}

function retirementPlan(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const built = fixture.ledger.buildCommittedModelRequest(recallTools);
  const prepared = fixture.model.prepare(built.request);
  const usage = fixture.meter.measure(prepared);
  const result = new PrefixRetirementPlanner(fixture.model).plan({
    active: built.compiled,
    revision: built.revision,
    surface: built.surface,
    activeOverrides: built.activeOverrides,
    canonical: built.canonical,
    closedTurns: fixture.store.loadClosedTurnBoundaries(),
    activePrepared: prepared,
    activeUsage: usage,
    tools: recallTools,
    policy: recallFirstRetirementPolicyV1,
    trigger: "benchmark_forced",
    forcedTargetTokens: 1,
  });
  if (!("plan" in result)) throw new Error("Expected a retirement plan.");
  return result.plan;
}

function commitInput(plan: ReturnType<typeof retirementPlan>) {
  return {
    revisionId: runtimeIdFactory.createContextRevisionId(),
    expectedBaseRevisionId: plan.baseRevisionId,
    expectedBaseRevisionNumber: plan.baseRevisionNumber,
    expectedBaseKeepFromOrdinal: plan.baseKeepFromOrdinal,
    expectedCanonicalThroughOrdinal: plan.baseCanonicalThroughOrdinal,
    expectedSurfaceSha256: plan.baseSurfaceSha256,
    expectedBaseActiveOverrideManifestSha256: plan.baseActiveOverrideManifestSha256,
    policyVersion: plan.policyVersion,
    planHash: plan.planHash,
    nextKeepFromOrdinal: plan.nextKeepFromOrdinal,
    retiredThroughOrdinal: plan.retiredThroughOrdinal,
    retiredTurnCount: plan.retiredTurnCount,
    retiredFrameCount: plan.retiredFrameCount,
    retiredMessageCount: plan.retiredMessageCount,
    nextActiveOverrideCount: plan.nextActiveOverrideCount,
    nextActiveOverrideManifestSha256: plan.nextActiveOverrideManifestSha256,
    canonicalSequenceSha256: plan.canonicalSequenceSha256,
    renderedMessageSha256: plan.renderedMessageSha256,
  };
}

function canonicalStorage(databasePath: string) {
  const database = new Database(databasePath, { readonly: true });
  try {
    return {
      messages: database.query("SELECT * FROM messages ORDER BY ordinal").all(),
      frames: database
        .query("SELECT * FROM protocol_frames ORDER BY first_ordinal")
        .all(),
      toolResults: database.query("SELECT * FROM tool_results").all(),
      recall: database
        .query("SELECT rowid, content FROM message_fts ORDER BY rowid")
        .all(),
    };
  } finally {
    database.close();
  }
}

function revisionCount(databasePath: string): number {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database
      .query("SELECT COUNT(*) AS count FROM context_revisions")
      .get() as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

function overrideCount(databasePath: string): number {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database
      .query("SELECT COUNT(*) AS count FROM context_overrides")
      .get() as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

class RetirementModel extends TestModelClient {
  requestCount = 0;

  override prepare(
    input: Parameters<TestModelClient["prepare"]>[0],
  ): PreparedModelRequest {
    return prepareTestModelRequest(input);
  }

  async request(): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    throw new Error("Prefix retirement must not call the model.");
  }
}

class RuntimeRetirementModel extends TestModelClient {
  requestCount = 0;

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    return testModelOutput(prepared, {
      role: "assistant",
      content: "runtime turn complete",
    });
  }
}
