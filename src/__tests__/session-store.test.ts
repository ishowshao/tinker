import { describe, expect, test } from "bun:test";
import { textToolResultContent } from "../agent/tool-result-content";
import { Database } from "bun:sqlite";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IterationIdentity, ToolCall, TurnIdentity } from "../agent/types";
import { runtimeIdFactory } from "../ids/runtime-id";
import { SessionError } from "../session/session-errors";
import { SessionCatalog } from "../session/session-catalog";
import { SessionStore, type CloneSessionFaultStage } from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import { finalizeTestSessionStore } from "./test-runtime";
import {
  createTempHomeRoot,
  workspaceSessionDirectory,
  workspaceSessionsRoot,
} from "./helpers/workspace-storage-test-support";

describe("SessionStore and SqliteSessionLedger", () => {
  test("clones a closed canonical session and re-keys diagnostic identity", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-clone-"));
    const homeRoot = await createTempHomeRoot();
    const sourceSessionId = runtimeIdFactory.createSessionId();
    const targetSessionId = runtimeIdFactory.createSessionId();
    let source: SessionStore | undefined;
    let target: SessionStore | undefined;
    try {
      source = await SessionStore.createNew({
        workspaceRoot: workspace,
        sessionId: sourceSessionId,
        modelName: "test-model",
        systemPrompt: "system",
        idFactory: runtimeIdFactory,
        homeRoot,
      });
      finalizeTestSessionStore(source, { systemPrompt: "system" });
      const eventSequence = source.allocateEventSequence();
      const sourceDirectory = await workspaceSessionDirectory(
        workspace,
        homeRoot,
        sourceSessionId,
      );
      await writeFile(
        path.join(sourceDirectory, "events.jsonl"),
        `${JSON.stringify({
          type: "session.started",
          sessionId: sourceSessionId,
          eventSequence,
          timestamp: "2026-07-19T00:00:00.000Z",
          data: {
            workspaceRoot: workspace,
            model: "test-model",
            maxIterations: 10,
            includeReasoningContent: false,
            contextProfile: { name: "test", maxInputTokens: 1000 },
            contextBudget: { maxInputTokens: 1000 },
            projectInstructions: {},
            literalSourceId: sourceSessionId,
          },
        })}\n`,
        { mode: 0o600 },
      );

      const sourceBefore = source.validateAll({ allowOpenTail: false });
      await source.cloneTo({ targetSessionId });
      expect(source.validateAll({ allowOpenTail: false })).toEqual(sourceBefore);

      target = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId: targetSessionId,
        homeRoot,
      });
      const targetView = target.validateAll({ allowOpenTail: false });
      expect(targetView.sessionId).toBe(targetSessionId);
      expect(targetView.messages.map((message) => message.messageId)).toEqual(
        sourceBefore.messages.map((message) => message.messageId),
      );
      expect(target.nextTurnNumber()).toBe(source.nextTurnNumber());

      const targetDirectory = await workspaceSessionDirectory(
        workspace,
        homeRoot,
        targetSessionId,
      );
      const clonedEvent = JSON.parse(
        await readFile(path.join(targetDirectory, "events.jsonl"), "utf8"),
      ) as Record<string, unknown>;
      expect(clonedEvent.sessionId).toBe(targetSessionId);
      expect((clonedEvent.data as Record<string, unknown>).literalSourceId).toBe(
        sourceSessionId,
      );
      expect(
        await readFile(path.join(targetDirectory, "observations.md"), "utf8"),
      ).toContain(`# Tinker Session ${targetSessionId}`);
    } finally {
      await target?.abandon().catch(() => undefined);
      await source?.abandon().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
    }
  });

  test("cleans every pre-publication clone fault without mutating the source", async () => {
    const fixture = await createCloneSource("tinker-clone-fault-");
    const stages: readonly CloneSessionFaultStage[] = [
      "after_staging_mkdir",
      "after_snapshot",
      "after_trigger_drop",
      "after_identity_update",
      "after_revision_hash_rewrite",
      "after_trigger_reinstall",
      "after_recall_validation",
      "after_event_rewrite",
      "after_observation_render",
      "after_artifact_validation",
      "before_publish_rename",
    ];
    try {
      const sourceView = fixture.store.validateAll({ allowOpenTail: false });
      const sourceMeta = fixture.store.readMeta();
      for (const stage of stages) {
        const targetSessionId = runtimeIdFactory.createSessionId();
        const error = await fixture.store
          .cloneTo({
            targetSessionId,
            faultInjector: (current) => {
              if (current === stage) {
                throw new Error(`injected clone fault at ${stage}`);
              }
            },
          })
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(stage);
        expect(fixture.store.validateAll({ allowOpenTail: false })).toEqual(sourceView);
        expect(fixture.store.readMeta()).toEqual(sourceMeta);
        await expectNoCloneArtifacts(
          fixture.workspace,
          fixture.homeRoot,
          targetSessionId,
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects malformed, mixed-identity, descending, and unsafe event logs", async () => {
    const cases = ["malformed", "mixed_identity", "descending", "permissions"] as const;
    for (const scenario of cases) {
      const fixture = await createCloneSource(`tinker-clone-events-${scenario}-`, {
        writeEvents: false,
      });
      const targetSessionId = runtimeIdFactory.createSessionId();
      try {
        const eventPath = path.join(fixture.sessionDirectory, "events.jsonl");
        if (scenario === "malformed") {
          await writeFile(eventPath, "{\n", { mode: 0o600 });
        } else if (scenario === "mixed_identity") {
          const sequence = fixture.store.allocateEventSequence();
          await writeFile(
            eventPath,
            `${JSON.stringify(cloneTestEvent("wrong-session", sequence))}\n`,
            { mode: 0o600 },
          );
        } else if (scenario === "descending") {
          const first = fixture.store.allocateEventSequence();
          const second = fixture.store.allocateEventSequence();
          await writeFile(
            eventPath,
            `${JSON.stringify(cloneTestEvent(fixture.sessionId, second))}\n${JSON.stringify(
              cloneTestEvent(fixture.sessionId, first),
            )}\n`,
            { mode: 0o600 },
          );
        } else {
          const sequence = fixture.store.allocateEventSequence();
          await writeFile(
            eventPath,
            `${JSON.stringify(cloneTestEvent(fixture.sessionId, sequence))}\n`,
            { mode: 0o600 },
          );
          await chmod(eventPath, 0o644);
        }

        const error = await fixture.store
          .cloneTo({ targetSessionId })
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        await expectNoCloneArtifacts(
          fixture.workspace,
          fixture.homeRoot,
          targetSessionId,
        );
        expect(fixture.store.validateAll({ allowOpenTail: false }).sessionId).toBe(
          fixture.sessionId,
        );
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("round-trips tool history and fast-fails an unknown observation format", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-store-"));
    const homeRoot = await createTempHomeRoot();
    const sessionId = runtimeIdFactory.createSessionId();
    try {
      let store = await SessionStore.createNew({
        workspaceRoot: workspace,
        sessionId,
        modelName: "test-model",
        systemPrompt: "system",
        idFactory: runtimeIdFactory,
        homeRoot,
      });
      finalizeTestSessionStore(store, { systemPrompt: "system" });
      const ledger = new SqliteSessionLedger(store, runtimeIdFactory);
      const turn: TurnIdentity = {
        sessionId,
        turnId: runtimeIdFactory.createTurnId(),
        turnNumber: 1,
      };
      const firstIteration: IterationIdentity = {
        ...turn,
        iterationId: runtimeIdFactory.createIterationId(),
        iterationNumber: 1,
      };
      const call: ToolCall = {
        ...firstIteration,
        toolCallId: runtimeIdFactory.createToolCallId(),
        toolCallNumber: 1,
        providerToolCallId: "provider-read",
        name: "Read",
        args: { file_path: "README.md" },
      };
      const memoryGetCall: ToolCall = {
        ...firstIteration,
        toolCallId: runtimeIdFactory.createToolCallId(),
        toolCallNumber: 2,
        providerToolCallId: "provider-memory-get",
        name: "MemoryGet",
        args: { id: "memory-1" },
      };
      const pending = ledger.beginTurn({
        turn,
        userMessage: { role: "user", content: "read" },
      });
      store.beginIteration(firstIteration);
      pending.agent.appendAssistant({
        iteration: firstIteration,
        message: {
          role: "assistant",
          content: "",
          reasoningContent: "",
          toolCalls: [call, memoryGetCall],
        },
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
            filePath: "README.md",
            content: "hello",
          },
          observation: textToolResultContent("Read succeeded."),
        },
        {
          call: memoryGetCall,
          kind: "returned",
          raw: {
            kind: "memory_get",
            ok: true,
            memory: {
              memoryId: "memory-1",
              text: "A derived memory.",
              summary: "A detailed historical summary.",
              sourceWorkspace: "/other",
              sourceSessionId: "source-session",
              sourceTurnId: "source-turn",
              createdAt: "2026-07-25T10:00:00.000Z",
            },
          },
          observation: textToolResultContent(
            "MemoryGet returned one derived historical memory record.",
          ),
        },
      ]);
      store.finishIterationForContinuation(firstIteration);
      const finalIteration: IterationIdentity = {
        ...turn,
        iterationId: runtimeIdFactory.createIterationId(),
        iterationNumber: 2,
      };
      store.beginIteration(finalIteration);
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

      const secondTurn: TurnIdentity = {
        sessionId,
        turnId: runtimeIdFactory.createTurnId(),
        turnNumber: 2,
      };
      const secondIteration: IterationIdentity = {
        ...secondTurn,
        iterationId: runtimeIdFactory.createIterationId(),
        iterationNumber: 1,
      };
      const secondPending = ledger.beginTurn({
        turn: secondTurn,
        userMessage: { role: "user", content: "continue" },
      });
      store.beginIteration(secondIteration);
      secondPending.agent.appendAssistant({
        iteration: secondIteration,
        message: { role: "assistant", content: "continued" },
        provider: "test",
        model: "test-model",
      });
      secondPending.finish({
        status: "completed",
        finalText: "continued",
        lastIteration: secondIteration,
      });

      const before = ledger.buildCommittedModelRequest([]);
      expect(before.request.messages[2]).toEqual({
        role: "assistant",
        content: "",
        reasoningContent: "",
        toolCalls: [call, memoryGetCall],
      });
      const lastEventSequence = store.allocateEventSequence();
      expect(lastEventSequence).toBe(1);
      await store.close("tui_exit");

      store = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId,
        homeRoot,
      });
      expect(store.readMeta()).toMatchObject({
        nextTurnNumber: 3,
        nextEventSequence: 2,
        initializationState: "ready",
      });
      expect(store.validateAll({ allowOpenTail: false }).messages).toHaveLength(8);
      const reopened = new SqliteSessionLedger(store, runtimeIdFactory);
      expect(reopened.buildCommittedModelRequest([])).toEqual(before);
      expect(store.allocateEventSequence()).toBe(2);
      expect((await stat(store.databasePath)).mode & 0o777).toBe(0o600);
      expect((await stat(store.sessionDirectory)).mode & 0o777).toBe(0o700);
      await store.close("tui_exit");

      const database = new Database(store.databasePath);
      const trigger = database
        .query(
          "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'tool_results_no_update'",
        )
        .get() as { sql: string };
      database.exec("DROP TRIGGER tool_results_no_update");
      database
        .query(
          "UPDATE tool_results SET observation_format = 'tool-observation-unknown' WHERE completion_kind = 'returned'",
        )
        .run();
      database.exec(trigger.sql);
      database.close();

      const error = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId,
        homeRoot,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("SESSION_INTEGRITY_FAILED");
      expect((error as SessionError).message).toContain("observation format");
    } finally {
      await rm(workspace, { recursive: true });
      await rm(homeRoot, { recursive: true, force: true });
    }
  });

  test("recovers only the missing tool-call suffix as interrupted", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-recovery-"));
    const homeRoot = await createTempHomeRoot();
    const sessionId = runtimeIdFactory.createSessionId();
    try {
      let store = await SessionStore.createNew({
        workspaceRoot: workspace,
        sessionId,
        modelName: "test-model",
        systemPrompt: "system",
        idFactory: runtimeIdFactory,
        homeRoot,
      });
      finalizeTestSessionStore(store, { systemPrompt: "system" });
      const ledger = new SqliteSessionLedger(store, runtimeIdFactory);
      const turn: TurnIdentity = {
        sessionId,
        turnId: runtimeIdFactory.createTurnId(),
        turnNumber: 1,
      };
      const iteration: IterationIdentity = {
        ...turn,
        iterationId: runtimeIdFactory.createIterationId(),
        iterationNumber: 1,
      };
      const calls = ["Read", "Write", "Glob"].map(
        (name, index): ToolCall => ({
          ...iteration,
          toolCallId: runtimeIdFactory.createToolCallId(),
          toolCallNumber: index + 1,
          providerToolCallId: `provider-${index + 1}`,
          name,
          args: {},
        }),
      );
      const pending = ledger.beginTurn({
        turn,
        userMessage: { role: "user", content: "run" },
      });
      store.beginIteration(iteration);
      pending.agent.appendAssistant({
        iteration,
        message: { role: "assistant", toolCalls: calls },
        provider: "test",
        model: "test-model",
      });
      pending.agent.commitToolCompletions([
        {
          call: calls[0],
          kind: "returned",
          raw: {
            kind: "read",
            ok: true,
            filePath: "README.md",
            content: "done",
          },
          observation: textToolResultContent("Read succeeded."),
        },
      ]);
      await store.abandon();

      store = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId,
        homeRoot,
      });
      const recovery = store.recoverInterruptedState(runtimeIdFactory);
      expect(recovery).toMatchObject({
        recoveredTurnId: turn.turnId,
        syntheticCompletionCount: 2,
      });
      const view = store.validateAll({ allowOpenTail: false });
      const synthetic = view.toolResults.filter(
        (result) => result.completion.kind === "synthetic",
      );
      expect(
        synthetic.map((result) =>
          result.completion.kind === "synthetic"
            ? result.completion.reason
            : "returned",
        ),
      ).toEqual(["interrupted_active", "skipped_after_interruption"]);
      expect(view.frames.at(-1)?.state).toBe("closed");
      expect(store.readMeta().nextTurnNumber).toBe(2);
      expect(
        store.loadProtocolView().messages.filter((message) => message.role === "tool"),
      ).toHaveLength(3);
      await store.close("tui_exit");
    } finally {
      await rm(workspace, { recursive: true });
      await rm(homeRoot, { recursive: true, force: true });
    }
  });

  test("marks an open turn without a frame interrupted without replaying it", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-open-turn-"));
    const homeRoot = await createTempHomeRoot();
    const sessionId = runtimeIdFactory.createSessionId();
    try {
      let store = await SessionStore.createNew({
        workspaceRoot: workspace,
        sessionId,
        modelName: "test-model",
        systemPrompt: "system",
        idFactory: runtimeIdFactory,
        homeRoot,
      });
      finalizeTestSessionStore(store, { systemPrompt: "system" });
      const ledger = new SqliteSessionLedger(store, runtimeIdFactory);
      const turn: TurnIdentity = {
        sessionId,
        turnId: runtimeIdFactory.createTurnId(),
        turnNumber: 1,
      };
      ledger.beginTurn({
        turn,
        userMessage: { role: "user", content: "persisted user fact" },
      });
      await store.abandon();

      store = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId,
        homeRoot,
      });
      expect(store.recoverInterruptedState(runtimeIdFactory)).toEqual({
        recoveredTurnId: turn.turnId,
        syntheticCompletionCount: 0,
        recallIndexRebuilt: false,
      });
      expect(store.validateAll({ allowOpenTail: false }).messages.at(-1)).toMatchObject(
        { role: "user", content: "persisted user fact" },
      );
      await store.close("tui_exit");
    } finally {
      await rm(workspace, { recursive: true });
      await rm(homeRoot, { recursive: true, force: true });
    }
  });
});

describe("SessionCatalog listing", () => {
  test("list returns the 20 most recent sessions while listAll returns every candidate", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-catalog-"));
    const homeRoot = await createTempHomeRoot();
    try {
      const sessionIds = [];
      for (let index = 0; index < 25; index += 1) {
        sessionIds.push(
          await createInterruptedCatalogSession(workspace, homeRoot, index),
        );
      }
      const catalog = new SessionCatalog({ workspaceRoot: workspace, homeRoot });
      const all = await catalog.listAll();
      const listed = await catalog.list();

      expect(all.map((summary) => summary.sessionId)).toEqual(
        [...sessionIds].reverse(),
      );
      expect(listed.map((summary) => summary.sessionId)).toEqual(
        all.slice(0, 20).map((summary) => summary.sessionId),
      );
      for (const summary of listed) {
        const complete = all.find(
          (candidate) => candidate.sessionId === summary.sessionId,
        );
        expect(complete).toMatchObject({
          status: summary.status,
          turnCount: summary.turnCount,
          modelName: summary.modelName,
          updatedAt: summary.updatedAt,
          ...(summary.firstUserPromptPreview === undefined
            ? {}
            : { firstUserPromptPreview: summary.firstUserPromptPreview }),
        });
      }
      for (const summary of all) {
        expect(summary.status).toBe("interrupted");
        expect(summary.turnCount).toBe(1);
        expect(summary.modelName).toBe("test-model");
      }
      expect(all.at(-1)?.firstUserPromptPreview).toBe("catalog prompt 0");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
    }
  });

  test("keeps a corrupt session as an unavailable summary without blocking the list", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-catalog-corrupt-"));
    const homeRoot = await createTempHomeRoot();
    try {
      const healthyId = await createInterruptedCatalogSession(workspace, homeRoot, 0);
      const corruptId = runtimeIdFactory.createSessionId();
      const corruptDirectory = await workspaceSessionDirectory(
        workspace,
        homeRoot,
        corruptId,
      );
      await mkdir(corruptDirectory, { recursive: true });
      await writeFile(path.join(corruptDirectory, "session.sqlite"), "not sqlite", {
        mode: 0o600,
      });

      const all = await new SessionCatalog({
        workspaceRoot: workspace,
        homeRoot,
      }).listAll();
      expect(all.map((summary) => summary.sessionId)).toHaveLength(2);
      const healthy = all.find((summary) => summary.sessionId === healthyId);
      const corrupt = all.find((summary) => summary.sessionId === corruptId);
      expect(healthy?.status).toBe("interrupted");
      expect(corrupt?.status).toBe("unavailable");
      expect(corrupt?.turnCount).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
    }
  });
});

async function createInterruptedCatalogSession(
  workspace: string,
  homeRoot: string,
  index: number,
) {
  const sessionId = runtimeIdFactory.createSessionId();
  const store = await SessionStore.createNew({
    workspaceRoot: workspace,
    sessionId,
    modelName: "test-model",
    systemPrompt: "system",
    idFactory: runtimeIdFactory,
    homeRoot,
  });
  finalizeTestSessionStore(store, { systemPrompt: "system" });
  const ledger = new SqliteSessionLedger(store, runtimeIdFactory);
  ledger.beginTurn({
    turn: {
      sessionId,
      turnId: runtimeIdFactory.createTurnId(),
      turnNumber: 1,
    },
    userMessage: { role: "user", content: `catalog prompt ${index}` },
  });
  await store.abandon();
  const database = new Database(
    path.join(
      await workspaceSessionDirectory(workspace, homeRoot, sessionId),
      "session.sqlite",
    ),
  );
  database.run("UPDATE session_meta SET updated_at = ? WHERE singleton = 1", [
    `2026-08-01T00:00:${String(index).padStart(2, "0")}.000Z`,
  ]);
  database.close();
  return sessionId;
}

async function createCloneSource(
  prefix: string,
  options: { writeEvents?: boolean } = {},
) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), prefix));
  const homeRoot = await createTempHomeRoot();
  const sessionId = runtimeIdFactory.createSessionId();
  const store = await SessionStore.createNew({
    workspaceRoot: workspace,
    sessionId,
    modelName: "test-model",
    systemPrompt: "system",
    idFactory: runtimeIdFactory,
    homeRoot,
  });
  finalizeTestSessionStore(store, { systemPrompt: "system" });
  const sessionDirectory = await workspaceSessionDirectory(
    workspace,
    homeRoot,
    sessionId,
  );
  if (options.writeEvents !== false) {
    const sequence = store.allocateEventSequence();
    await writeFile(
      path.join(sessionDirectory, "events.jsonl"),
      `${JSON.stringify(cloneTestEvent(sessionId, sequence))}\n`,
      { mode: 0o600 },
    );
  }
  return {
    workspace,
    homeRoot,
    sessionId,
    sessionDirectory,
    store,
    cleanup: async () => {
      await store.abandon().catch(() => undefined);
      await rm(workspace, { recursive: true });
      await rm(homeRoot, { recursive: true, force: true });
    },
  };
}

function cloneTestEvent(sessionId: string, eventSequence: number) {
  return {
    type: "diagnostic.sink_failed",
    sessionId,
    eventSequence,
    timestamp: "2026-07-19T00:00:00.000Z",
    data: {
      sinkName: "test",
      failedEventType: "turn.started",
      error: "fixture",
    },
  };
}

async function expectNoCloneArtifacts(
  workspace: string,
  homeRoot: string,
  targetSessionId: ReturnType<typeof runtimeIdFactory.createSessionId>,
): Promise<void> {
  const sessionsRoot = await workspaceSessionsRoot(workspace, homeRoot);
  expect(await readdir(sessionsRoot)).not.toContain(targetSessionId);
  expect(
    (await readdir(sessionsRoot)).filter((name) => name.startsWith(".cloning-")),
  ).toEqual([]);
  expect(
    (await new SessionCatalog({ workspaceRoot: workspace, homeRoot }).list()).map(
      (summary) => summary.sessionId,
    ),
  ).not.toContain(targetSessionId);
}
