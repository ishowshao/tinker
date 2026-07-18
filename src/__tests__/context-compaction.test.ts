import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextMeter } from "../agent/context-meter";
import {
  RuntimeEventAppendError,
  createRuntimeSession,
} from "../agent/runtime-session";
import type { IterationIdentity, ToolCall, TurnIdentity } from "../agent/types";
import { ContextManager, ContextManagerError } from "../context/context-manager";
import {
  canonicalSequenceHash,
  renderedMessageHash,
} from "../context/compiled-context-hash";
import {
  contextSurfaceChangeManifestHash,
  contextSurfaceChanges,
  createContextSurface,
} from "../context/context-surface";
import { ContextRevisionCompiler } from "../context/context-revision-compiler";
import { CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION } from "../context/recall-retirement-contract";
import { swapOnlyPolicyV1 } from "../context/context-policy";
import { SwapPlanner } from "../context/swap-planner";
import { runtimeIdFactory } from "../ids/runtime-id";
import { CommittedPrefixAuditor } from "../model/committed-prefix-auditor";
import type {
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import {
  SessionStore,
  type CommitSurfaceRefreshFaultStage,
  type CommitSwapRevisionFaultStage,
} from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import type { ToolDefinition } from "../tools/types";
import {
  collectingEventSink,
  finalizeTestSessionStore,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
} from "./test-runtime";

const tools: readonly ToolDefinition[] = [
  {
    name: "Read",
    description: "Read a file",
    parameters: { type: "object", properties: {} },
  },
];

describe("I2 deterministic context compaction", () => {
  test("commits monotonic swap revisions, inherits overrides, resumes, and preserves Recall", async () => {
    const fixture = await createFixture("tinker-i2-chain-");
    try {
      const firstObservation = `historical-v1-${"a".repeat(10_000)}`;
      appendReadTurn(fixture, firstObservation);
      appendTextTurns(fixture, 8);
      const canonicalBeforeFirstCompact = readCanonicalStorage(
        fixture.store.databasePath,
      );
      expect(
        fixture.store.historyReader().search({
          query: "historical-v1",
          limit: 20,
          offset: 0,
        }).hits,
      ).toHaveLength(1);

      const first = await fixture.manager.compact({
        kind: "benchmark_forced",
        targetTokens: 0,
      });
      expect(first).toMatchObject({
        status: "compacted",
        outcome: "insufficient_candidates",
        previousRevisionNumber: 1,
        revisionNumber: 2,
        addedOverrideCount: 1,
        activeOverrideCount: 1,
      });
      if (first.status !== "compacted") {
        throw new Error("Expected the first compaction to commit revision 2.");
      }
      expect(fixture.model.requestCount).toBe(0);
      expect(fixture.usages.at(-1)?.source).toBe("estimated_full");

      const firstSnapshot = fixture.store.loadContextSnapshot();
      expect(firstSnapshot.revision).toMatchObject({
        kind: "swap_only",
        revisionNumber: 2,
        activeOverrideCount: 1,
      });
      expect(firstSnapshot.activeOverrides).toHaveLength(1);
      expect(readCanonicalStorage(fixture.store.databasePath)).toEqual(
        canonicalBeforeFirstCompact,
      );
      const firstOverride = firstSnapshot.activeOverrides[0];
      if (firstOverride === undefined) {
        throw new Error("Expected the first stored override.");
      }
      const recalled = fixture.store.historyReader().get({
        source: firstOverride.source,
        byteOffset: 0,
        byteLimit: Buffer.byteLength(firstObservation),
      });
      expect(recalled.content).toBe(firstObservation);
      expect(
        fixture.store.historyReader().search({
          query: "historical-v1",
          limit: 20,
          offset: 0,
        }).hits[0],
      ).toMatchObject({
        source: firstOverride.source,
        contentSha256: firstOverride.originalContentSha256,
      });
      expect(
        fixture.ledger
          .buildCommittedModelRequest(tools)
          .request.messages.find(
            (message) =>
              message.role === "tool" && message.content.includes(firstOverride.source),
          ),
      ).toBeDefined();

      const secondObservation = `historical-v2-${"b".repeat(11_000)}`;
      appendReadTurn(fixture, secondObservation);
      appendTextTurns(fixture, 8);
      const second = await fixture.manager.compact({
        kind: "benchmark_forced",
        targetTokens: 0,
      });
      expect(second).toMatchObject({
        status: "compacted",
        previousRevisionNumber: 2,
        revisionNumber: 3,
        addedOverrideCount: 1,
        activeOverrideCount: 2,
      });

      const secondSnapshot = fixture.store.loadContextSnapshot();
      expect(secondSnapshot.activeOverrides).toHaveLength(2);
      expect(secondSnapshot.activeOverrides[0]).toEqual(firstOverride);
      const inspection = new Database(fixture.store.databasePath, {
        readwrite: true,
      });
      expect(
        inspection.query("SELECT COUNT(*) AS count FROM context_revisions").get(),
      ).toEqual({ count: 3 });
      expect(
        inspection.query("SELECT COUNT(*) AS count FROM context_overrides").get(),
      ).toEqual({ count: 2 });
      expect(() =>
        inspection.query("UPDATE context_revisions SET created_at = created_at").run(),
      ).toThrow("context_revisions are immutable");
      expect(() => inspection.query("DELETE FROM context_overrides").run()).toThrow(
        "context_overrides are immutable",
      );
      expect(() =>
        inspection
          .query("UPDATE session_meta SET active_revision_id = ? WHERE singleton = 1")
          .run(first.previousRevisionId),
      ).toThrow("invalid session metadata transition");
      expect(() =>
        inspection
          .query(
            `INSERT INTO context_measurement_state (
              singleton, session_id, revision_id, total_tokens, prompt_tokens,
              completion_tokens, segment_count, prefix_hash, request_config_hash,
              tool_schema_hash, updated_at
            ) VALUES (1, ?, ?, 2, 1, 1, 1, ?, ?, ?, ?)`,
          )
          .run(
            fixture.sessionId,
            first.previousRevisionId,
            "1".repeat(64),
            "2".repeat(64),
            "3".repeat(64),
            "2026-07-17T00:00:00.000Z",
          ),
      ).toThrow("context measurement revision is not active");
      inspection.close();

      const beforeResume = fixture.ledger.buildCommittedModelRequest(tools).request;
      await fixture.store.close("tui_exit");
      fixture.closed = true;
      const reopened = await SessionStore.openExisting({
        workspaceRoot: fixture.workspace,
        sessionId: fixture.sessionId,
      });
      try {
        const resumed = new SqliteSessionLedger(reopened, runtimeIdFactory);
        expect(resumed.buildCommittedModelRequest(tools).request).toEqual(beforeResume);
        const resumedSnapshot = reopened.loadContextSnapshot();
        expect(resumedSnapshot.revision.revisionNumber).toBe(3);
        expect(resumedSnapshot.activeOverrides).toHaveLength(2);
        expect(
          reopened.historyReader().search({
            query: "historical-v1",
            limit: 20,
            offset: 0,
          }).hits[0],
        ).toMatchObject({
          source: firstOverride.source,
          contentSha256: firstOverride.originalContentSha256,
        });
        for (const override of resumedSnapshot.activeOverrides) {
          expect(
            reopened.historyReader().get({
              source: override.source,
              byteOffset: 0,
              byteLimit: override.originalBytes,
            }).contentSha256,
          ).toBe(override.originalContentSha256);
        }
      } finally {
        await reopened.close("tui_exit");
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("rolls back revision, overrides, active ID, and measured anchor at every transaction fault stage", async () => {
    const fixture = await createFixture("tinker-i2-rollback-");
    try {
      appendReadTurn(fixture, `rollback-source-${"x".repeat(10_000)}`);
      appendTextTurns(fixture, 8);
      const built = fixture.ledger.buildCommittedModelRequest(tools);
      const prepared = fixture.model.prepare(built.request);
      const usage = fixture.meter.measure(prepared);
      const planning = new SwapPlanner(fixture.model).plan({
        active: built.compiled,
        revision: built.revision,
        surface: built.surface,
        activeOverrides: built.activeOverrides,
        canonical: built.canonical,
        activePrepared: prepared,
        activeUsage: usage,
        tools,
        policy: swapOnlyPolicyV1,
        trigger: "benchmark_forced",
        forcedTargetTokens: 0,
      });
      const plan = planning.plan;
      if (plan === undefined) {
        throw new Error("Expected a fault-injection swap plan.");
      }
      const candidate = new ContextRevisionCompiler().compileProspective({
        active: built.compiled,
        canonical: built.canonical,
        activeOverrides: built.activeOverrides,
        addedOverrides: plan.addedOverrides,
        activeSurface: built.surface,
      });
      fixture.store.writeMeasuredContextAnchor({
        totalTokens: 30,
        promptTokens: 20,
        completionTokens: 10,
        segmentCount: 1,
        prefixHash: "1".repeat(64),
        requestConfigHash: "2".repeat(64),
        toolSchemaHash: "3".repeat(64),
      });
      const baseRevisionId = built.revision.revisionId;

      const faultStages: readonly CommitSwapRevisionFaultStage[] = [
        "before_revision_insert",
        "after_revision_insert",
        "after_first_override_insert",
        "after_overrides_insert",
        "after_measurement_delete",
        "after_active_update",
      ];
      for (const faultStage of faultStages) {
        expect(() =>
          fixture.store.commitSwapRevision(
            {
              revisionId: runtimeIdFactory.createContextRevisionId(),
              expectedBaseRevisionId: baseRevisionId,
              expectedBaseRevisionNumber: built.revision.revisionNumber,
              expectedCanonicalThroughOrdinal: built.compiled.canonicalThroughOrdinal,
              expectedBaseActiveOverrideManifestSha256:
                built.revision.activeOverrideManifestSha256,
              policyVersion: "swap-only-v1",
              rendererFormat: "swap-observation-v1",
              planHash: plan.planHash,
              addedOverrides: plan.addedOverrides,
              nextActiveOverrideManifestSha256: plan.nextActiveOverrideManifestSha256,
              canonicalSequenceSha256: canonicalSequenceHash(built.canonical),
              renderedMessageSha256: renderedMessageHash(candidate.entries),
            },
            {
              faultInjector: (stage) => {
                if (stage === faultStage) {
                  throw new Error(`injected failure at ${faultStage}`);
                }
              },
            },
          ),
        ).toThrow("commit_context_revision");

        const after = fixture.store.loadContextSnapshot();
        expect(after.revision.revisionId).toBe(baseRevisionId);
        expect(after.revision.revisionNumber).toBe(1);
        expect(after.activeOverrides).toHaveLength(0);
        expect(fixture.store.readActiveMeasuredContextAnchor()).toBeDefined();
        const inspection = new Database(fixture.store.databasePath, {
          readonly: true,
        });
        expect(
          inspection.query("SELECT COUNT(*) AS count FROM context_revisions").get(),
        ).toEqual({ count: 1 });
        expect(
          inspection.query("SELECT COUNT(*) AS count FROM context_overrides").get(),
        ).toEqual({ count: 0 });
        inspection.close();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("rolls back surface refresh at every fault stage and inherits the active swap view", async () => {
    const fixture = await createFixture("tinker-surface-rollback-");
    try {
      appendReadTurn(fixture, `surface-source-${"s".repeat(10_000)}`);
      appendTextTurns(fixture, 8);
      const compacted = await fixture.manager.compact({
        kind: "benchmark_forced",
        targetTokens: 0,
      });
      expect(compacted).toMatchObject({
        status: "compacted",
        revisionNumber: 2,
        activeOverrideCount: 1,
      });

      const base = fixture.store.loadContextSnapshot();
      const canonicalBefore = readCanonicalStorage(fixture.store.databasePath);
      const prepared = fixture.model.prepare({
        messages: [{ role: "system", content: "system-v2" }],
        tools: [...tools],
      });
      const surface = createContextSurface({
        surfaceId: runtimeIdFactory.createContextSurfaceId(),
        sessionId: fixture.sessionId,
        systemPrompt: "system-v2",
        recallContractVersion: CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
        toolDefinitions: tools,
        prepared,
        createdAt: "2026-07-17T00:00:00.000Z",
      });
      const compiler = new ContextRevisionCompiler();
      const candidate = compiler.compileProspective({
        active: compiler.compileActive(base),
        canonical: base.canonical,
        activeOverrides: base.activeOverrides,
        addedOverrides: [],
        activeSurface: base.surface,
        surface,
      });
      const changes = contextSurfaceChanges(base.surface, surface);
      const commitInput = {
        expectedBaseRevisionId: base.revision.revisionId,
        expectedBaseRevisionNumber: base.revision.revisionNumber,
        expectedCanonicalThroughOrdinal: base.canonical.messages.length,
        expectedBaseActiveOverrideManifestSha256:
          base.revision.activeOverrideManifestSha256,
        surface,
        changes,
        changeManifestSha256: contextSurfaceChangeManifestHash(changes),
        canonicalSequenceSha256: canonicalSequenceHash(base.canonical),
        renderedMessageSha256: renderedMessageHash(candidate.entries),
      } as const;
      fixture.store.writeMeasuredContextAnchor(measuredAnchor());

      const faultStages: readonly CommitSurfaceRefreshFaultStage[] = [
        "before_surface_insert",
        "after_surface_insert",
        "after_revision_insert",
        "after_measurement_delete",
        "after_active_update",
      ];
      for (const faultStage of faultStages) {
        expect(() =>
          fixture.store.commitSurfaceRefresh(
            {
              ...commitInput,
              revisionId: runtimeIdFactory.createContextRevisionId(),
            },
            {
              faultInjector: (stage) => {
                if (stage === faultStage) {
                  throw new Error(`injected failure at ${faultStage}`);
                }
              },
            },
          ),
        ).toThrow("commit_context_surface");

        const after = fixture.store.loadContextSnapshot();
        expect(after.revision.revisionId).toBe(base.revision.revisionId);
        expect(after.surface.surfaceId).toBe(base.surface.surfaceId);
        expect(after.activeOverrides).toEqual(base.activeOverrides);
        expect(fixture.store.readActiveMeasuredContextAnchor()).toBeDefined();
        const inspection = new Database(fixture.store.databasePath, {
          readonly: true,
        });
        expect(
          inspection.query("SELECT COUNT(*) AS count FROM context_surfaces").get(),
        ).toEqual({ count: 1 });
        expect(
          inspection.query("SELECT COUNT(*) AS count FROM context_revisions").get(),
        ).toEqual({ count: 2 });
        inspection.close();
      }

      const committed = fixture.store.commitSurfaceRefresh({
        ...commitInput,
        revisionId: runtimeIdFactory.createContextRevisionId(),
      });
      expect(committed).toMatchObject({
        kind: "surface_refresh",
        revisionNumber: 3,
        activeOverrideCount: 1,
        activeOverrideManifestSha256: base.revision.activeOverrideManifestSha256,
      });
      const afterCommit = fixture.store.loadContextSnapshot();
      expect(afterCommit.surface).toEqual(surface);
      expect(afterCommit.activeOverrides).toEqual(base.activeOverrides);
      expect(fixture.store.readActiveMeasuredContextAnchor()).toBeUndefined();
      expect(readCanonicalStorage(fixture.store.databasePath)).toEqual(canonicalBefore);
      expect(
        fixture.ledger.buildCommittedModelRequest(tools).request.messages[0],
      ).toEqual({ role: "system", content: "system-v2" });
    } finally {
      await fixture.cleanup();
    }
  });

  test("keeps no-op compaction on revision 1 without clearing measurement", async () => {
    const fixture = await createFixture("tinker-i2-noop-");
    try {
      fixture.store.writeMeasuredContextAnchor(measuredAnchor());
      const belowTarget = await fixture.manager.compact({ kind: "manual" });
      expect(belowTarget).toMatchObject({
        status: "unchanged",
        outcome: "below_target",
        revisionNumber: 1,
        activeOverrideCount: 0,
      });
      const noCandidates = await fixture.manager.compact({
        kind: "benchmark_forced",
        targetTokens: 0,
      });
      expect(noCandidates).toMatchObject({
        status: "unchanged",
        outcome: "no_eligible_candidates",
        revisionNumber: 1,
        activeOverrideCount: 0,
      });
      expect(fixture.store.readActiveMeasuredContextAnchor()).toEqual(measuredAnchor());
      const inspection = new Database(fixture.store.databasePath, {
        readonly: true,
      });
      expect(
        inspection.query("SELECT COUNT(*) AS count FROM context_revisions").get(),
      ).toEqual({ count: 1 });
      inspection.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("keeps the committed revision after activation fails and resumes it", async () => {
    const fixture = await createFixture("tinker-i2-post-commit-", {
      meter: new FailingRevisionContextMeter(),
    });
    try {
      appendReadTurn(fixture, `post-commit-source-${"z".repeat(10_000)}`);
      appendTextTurns(fixture, 8);
      fixture.store.writeMeasuredContextAnchor(measuredAnchor());

      let failure: unknown;
      try {
        await fixture.manager.compact({
          kind: "benchmark_forced",
          targetTokens: 0,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ContextManagerError);
      if (!(failure instanceof ContextManagerError)) {
        throw new Error("Expected a ContextManager activation failure.");
      }
      expect(failure).toMatchObject({
        stage: "activate",
        fatal: true,
        committed: true,
      });
      const committed = fixture.store.loadContextSnapshot();
      expect(committed.revision).toMatchObject({
        kind: "swap_only",
        revisionNumber: 2,
        activeOverrideCount: 1,
      });
      expect(fixture.store.readActiveMeasuredContextAnchor()).toBeUndefined();
      const requestBeforeResume =
        fixture.ledger.buildCommittedModelRequest(tools).request;

      await fixture.store.close("runner_failed");
      fixture.closed = true;
      const reopened = await SessionStore.openExisting({
        workspaceRoot: fixture.workspace,
        sessionId: fixture.sessionId,
      });
      try {
        const resumed = new SqliteSessionLedger(reopened, runtimeIdFactory);
        expect(resumed.buildCommittedModelRequest(tools).request).toEqual(
          requestBeforeResume,
        );
        expect(reopened.loadContextSnapshot().revision.revisionNumber).toBe(2);
        expect(reopened.readActiveMeasuredContextAnchor()).toBeUndefined();
      } finally {
        await reopened.close("tui_exit");
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("runs the RuntimeSession manual API with bounded events and no model request", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-i2-runtime-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const sink = collectingEventSink();
    const model = new RuntimeCompactionModel();
    await writeFile(path.join(workspace, "large.txt"), "r".repeat(12_000));
    const session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId },
        workspaceRoot: workspace,
        modelName: "test-model",
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
        manualCompactionTrigger: () => ({
          kind: "benchmark_forced",
          targetTokens: 0,
        }),
      },
    );
    try {
      await session.executeTurn({
        userPrompt: "read the large file",
        signal: new AbortController().signal,
      });
      for (let index = 0; index < 8; index += 1) {
        await session.executeTurn({
          userPrompt: `tail ${index}`,
          signal: new AbortController().signal,
        });
      }
      const requestCountBefore = model.requestCount;
      const result = await session.compactContext();
      expect(result).toMatchObject({
        status: "compacted",
        previousRevisionNumber: 1,
        revisionNumber: 2,
        addedOverrideCount: 1,
      });
      expect(model.requestCount).toBe(requestCountBefore);
      expect(
        sink.events
          .filter((event) => event.type.startsWith("context.revision."))
          .map((event) => event.type),
      ).toEqual(["context.revision.started", "context.revision.finished"]);
      const revisionUsage = sink.events.find(
        (
          event,
        ): event is Extract<
          (typeof sink.events)[number],
          { type: "context.usage.updated" }
        > => event.type === "context.usage.updated" && event.data.phase === "revision",
      );
      expect(revisionUsage?.data.snapshot.source).toBe("estimated_full");
      const serializedEvents = JSON.stringify(
        sink.events.filter((event) => event.type.startsWith("context.revision.")),
      );
      expect(serializedEvents).not.toContain("large.txt");
      expect(serializedEvents).not.toContain("ctx://message/");
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("keeps the new revision durable when the finished event fails", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-i2-event-fault-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const model = new RuntimeCompactionModel();
    const eventTypes: string[] = [];
    await writeFile(path.join(workspace, "large.txt"), "e".repeat(12_000));
    const session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId },
        workspaceRoot: workspace,
        modelName: "test-model",
        maxIterations: 2,
        includeReasoningContent: false,
        contextProfile: TEST_CONTEXT_PROFILE,
        contextBudget: TEST_CONTEXT_BUDGET,
        systemPrompt: "system",
        modelClient: model,
        persistence: false,
      },
      {
        loadMcpConfig: async () => undefined,
        manualCompactionTrigger: () => ({
          kind: "benchmark_forced",
          targetTokens: 0,
        }),
        createEventSink: () => ({
          name: "required-event-fault",
          append: async (event) => {
            eventTypes.push(event.type);
            if (event.type === "context.revision.finished") {
              throw new Error("injected finished event failure");
            }
          },
        }),
      },
    );
    try {
      await session.executeTurn({
        userPrompt: "read the large file",
        signal: new AbortController().signal,
      });
      for (let index = 0; index < 8; index += 1) {
        await session.executeTurn({
          userPrompt: `tail ${index}`,
          signal: new AbortController().signal,
        });
      }

      let failure: unknown;
      try {
        await session.compactContext();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(RuntimeEventAppendError);
      expect(eventTypes).toContain("context.revision.started");
      expect(eventTypes).toContain("context.revision.finished");
      expect(() =>
        session.executeTurn({
          userPrompt: "must not execute",
          signal: new AbortController().signal,
        }),
      ).toThrow("faulted");
    } finally {
      await session
        .dispose({ type: "runner_failed", error: "event fault" })
        .catch(() => undefined);
    }

    const reopened = await SessionStore.openExisting({
      workspaceRoot: workspace,
      sessionId,
    });
    try {
      expect(reopened.loadContextSnapshot().revision).toMatchObject({
        kind: "swap_only",
        revisionNumber: 2,
        activeOverrideCount: 1,
      });
      expect(reopened.readActiveMeasuredContextAnchor()).toBeUndefined();
    } finally {
      await reopened.close("tui_exit");
      await rm(workspace, { recursive: true });
    }
  });
});

async function createFixture(prefix: string, options: { meter?: ContextMeter } = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), prefix));
  const sessionId = runtimeIdFactory.createSessionId();
  const store = await SessionStore.createNew({
    workspaceRoot: workspace,
    sessionId,
    modelName: "test-model",
    systemPrompt: "system",
    idFactory: runtimeIdFactory,
  });
  const model = new PreparingModel();
  finalizeTestSessionStore(store, {
    systemPrompt: "system",
    tools,
    modelClient: model,
  });
  const ledger = new SqliteSessionLedger(store, runtimeIdFactory);
  const meter = options.meter ?? new ContextMeter(TEST_CONTEXT_BUDGET);
  const usages: ReturnType<ContextMeter["measure"]>[] = [];
  const manager = new ContextManager({
    store,
    ledger,
    model,
    contextMeter: meter,
    committedPrefixAuditor: new CommittedPrefixAuditor(),
    idFactory: runtimeIdFactory,
    tools: () => tools,
    onUsageUpdated: async (usage) => {
      usages.push(usage);
    },
  });
  const fixture = {
    workspace,
    sessionId,
    store,
    ledger,
    model,
    meter,
    manager,
    usages,
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

function readCanonicalStorage(databasePath: string): {
  messages: readonly Record<string, unknown>[];
  toolResults: readonly Record<string, unknown>[];
  recallDocuments: readonly Record<string, unknown>[];
  recallIndex: readonly Record<string, unknown>[];
} {
  const database = new Database(databasePath, { readonly: true });
  try {
    return {
      messages: database
        .query("SELECT * FROM messages ORDER BY ordinal")
        .all() as Record<string, unknown>[],
      toolResults: database
        .query("SELECT * FROM tool_results ORDER BY tool_message_id")
        .all() as Record<string, unknown>[],
      recallDocuments: database
        .query("SELECT * FROM recall_documents ORDER BY docid")
        .all() as Record<string, unknown>[],
      recallIndex: database
        .query("SELECT rowid, content FROM message_fts ORDER BY rowid")
        .all() as Record<string, unknown>[],
    };
  } finally {
    database.close();
  }
}

function measuredAnchor() {
  return {
    totalTokens: 30,
    promptTokens: 20,
    completionTokens: 10,
    segmentCount: 1,
    prefixHash: "1".repeat(64),
    requestConfigHash: "2".repeat(64),
    toolSchemaHash: "3".repeat(64),
  } as const;
}

function appendReadTurn(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  observation: string,
): void {
  const turn = nextTurn(fixture);
  const firstIteration = nextIteration(turn, 1);
  const call: ToolCall = {
    ...firstIteration,
    toolCallId: runtimeIdFactory.createToolCallId(),
    toolCallNumber: 1,
    providerToolCallId: `provider-${turn.turnNumber}`,
    name: "Read",
    args: { file_path: `history-${turn.turnNumber}.txt` },
  };
  const pending = fixture.ledger.beginTurn({ turn, userPrompt: "read history" });
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
  const finalIteration = nextIteration(turn, 2);
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

function appendTextTurns(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) {
    const turn = nextTurn(fixture);
    const iteration = nextIteration(turn, 1);
    const pending = fixture.ledger.beginTurn({
      turn,
      userPrompt: `tail-${turn.turnNumber}`,
    });
    fixture.store.beginIteration(iteration);
    pending.agent.appendAssistant({
      iteration,
      message: { role: "assistant", content: "done" },
      provider: "test",
      model: "test-model",
    });
    pending.finish({
      status: "completed",
      finalText: "done",
      lastIteration: iteration,
    });
  }
}

function nextTurn(fixture: Awaited<ReturnType<typeof createFixture>>): TurnIdentity {
  const turn = {
    sessionId: fixture.sessionId,
    turnId: runtimeIdFactory.createTurnId(),
    turnNumber: fixture.nextTurnNumber,
  };
  fixture.nextTurnNumber += 1;
  return turn;
}

function nextIteration(turn: TurnIdentity, iterationNumber: number): IterationIdentity {
  return {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber,
  };
}

class PreparingModel extends OpenAIChatModelClient {
  requestCount = 0;

  constructor() {
    super({
      apiKey: "test-no-network",
      baseURL: "https://example.invalid/v1",
      model: "test-model",
      contextBudget: TEST_CONTEXT_BUDGET,
    });
  }

  override async request(...args: Parameters<OpenAIChatModelClient["request"]>) {
    this.requestCount += 1;
    return super.request(...args);
  }
}

class FailingRevisionContextMeter extends ContextMeter {
  constructor() {
    super(TEST_CONTEXT_BUDGET);
  }

  override startRevision(input: Parameters<ContextMeter["startRevision"]>[0]): void {
    void input;
    throw new Error("injected post-commit activation failure");
  }
}

class RuntimeCompactionModel extends TestModelClient {
  requestCount = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    if (this.requestCount === 1) {
      if (options.identity === undefined) {
        throw new Error("Expected runtime identity for the Read call.");
      }
      const { iteration, runtimeSession } = options.identity;
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...runtimeSession.createToolCall(iteration, 1),
            providerToolCallId: "provider-read-large",
            name: "Read",
            args: { file_path: "large.txt" },
          },
        ],
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "done",
    });
  }
}
