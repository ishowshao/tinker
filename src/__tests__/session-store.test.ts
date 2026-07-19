import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmod,
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

describe("SessionStore and SqliteSessionLedger", () => {
  test("clones a closed canonical session and re-keys diagnostic identity", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-clone-"));
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
      });
      finalizeTestSessionStore(source, { systemPrompt: "system" });
      const eventSequence = source.allocateEventSequence();
      const sourceDirectory = path.join(
        workspace,
        ".tinker",
        "sessions",
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
      });
      const targetView = target.validateAll({ allowOpenTail: false });
      expect(targetView.sessionId).toBe(targetSessionId);
      expect(targetView.messages.map((message) => message.messageId)).toEqual(
        sourceBefore.messages.map((message) => message.messageId),
      );
      expect(target.nextTurnNumber()).toBe(source.nextTurnNumber());

      const clonedEvent = JSON.parse(
        await readFile(
          path.join(workspace, ".tinker", "sessions", targetSessionId, "events.jsonl"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(clonedEvent.sessionId).toBe(targetSessionId);
      expect((clonedEvent.data as Record<string, unknown>).literalSourceId).toBe(
        sourceSessionId,
      );
      expect(
        await readFile(
          path.join(
            workspace,
            ".tinker",
            "sessions",
            targetSessionId,
            "observations.md",
          ),
          "utf8",
        ),
      ).toContain(`# Tinker Session ${targetSessionId}`);
    } finally {
      await target?.abandon().catch(() => undefined);
      await source?.abandon().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
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
        await expectNoCloneArtifacts(fixture.workspace, targetSessionId);
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
        await expectNoCloneArtifacts(fixture.workspace, targetSessionId);
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
    const sessionId = runtimeIdFactory.createSessionId();
    try {
      let store = await SessionStore.createNew({
        workspaceRoot: workspace,
        sessionId,
        modelName: "test-model",
        systemPrompt: "system",
        idFactory: runtimeIdFactory,
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
      const pending = ledger.beginTurn({ turn, userPrompt: "read" });
      store.beginIteration(firstIteration);
      pending.agent.appendAssistant({
        iteration: firstIteration,
        message: {
          role: "assistant",
          content: "",
          reasoningContent: "",
          toolCalls: [call],
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
          observation: "Read succeeded.",
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
        userPrompt: "continue",
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
        toolCalls: [call],
      });
      const lastEventSequence = store.allocateEventSequence();
      expect(lastEventSequence).toBe(1);
      await store.close("tui_exit");

      store = await SessionStore.openExisting({ workspaceRoot: workspace, sessionId });
      expect(store.readMeta()).toMatchObject({
        nextTurnNumber: 3,
        nextEventSequence: 2,
        initializationState: "ready",
      });
      expect(store.validateAll({ allowOpenTail: false }).messages).toHaveLength(7);
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
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("SESSION_INTEGRITY_FAILED");
      expect((error as SessionError).message).toContain("observation format");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("recovers only the missing tool-call suffix as interrupted", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-recovery-"));
    const sessionId = runtimeIdFactory.createSessionId();
    try {
      let store = await SessionStore.createNew({
        workspaceRoot: workspace,
        sessionId,
        modelName: "test-model",
        systemPrompt: "system",
        idFactory: runtimeIdFactory,
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
      const pending = ledger.beginTurn({ turn, userPrompt: "run" });
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
          observation: "Read succeeded.",
        },
      ]);
      await store.abandon();

      store = await SessionStore.openExisting({ workspaceRoot: workspace, sessionId });
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
    }
  });

  test("marks an open turn without a frame interrupted without replaying it", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-open-turn-"));
    const sessionId = runtimeIdFactory.createSessionId();
    try {
      let store = await SessionStore.createNew({
        workspaceRoot: workspace,
        sessionId,
        modelName: "test-model",
        systemPrompt: "system",
        idFactory: runtimeIdFactory,
      });
      finalizeTestSessionStore(store, { systemPrompt: "system" });
      const ledger = new SqliteSessionLedger(store, runtimeIdFactory);
      const turn: TurnIdentity = {
        sessionId,
        turnId: runtimeIdFactory.createTurnId(),
        turnNumber: 1,
      };
      ledger.beginTurn({ turn, userPrompt: "persisted user fact" });
      await store.abandon();

      store = await SessionStore.openExisting({ workspaceRoot: workspace, sessionId });
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
    }
  });
});

async function createCloneSource(
  prefix: string,
  options: { writeEvents?: boolean } = {},
) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), prefix));
  const sessionId = runtimeIdFactory.createSessionId();
  const store = await SessionStore.createNew({
    workspaceRoot: workspace,
    sessionId,
    modelName: "test-model",
    systemPrompt: "system",
    idFactory: runtimeIdFactory,
  });
  finalizeTestSessionStore(store, { systemPrompt: "system" });
  const sessionDirectory = path.join(workspace, ".tinker", "sessions", sessionId);
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
    sessionId,
    sessionDirectory,
    store,
    cleanup: async () => {
      await store.abandon().catch(() => undefined);
      await rm(workspace, { recursive: true });
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
  targetSessionId: ReturnType<typeof runtimeIdFactory.createSessionId>,
): Promise<void> {
  const sessionsRoot = path.join(workspace, ".tinker", "sessions");
  expect(await readdir(sessionsRoot)).not.toContain(targetSessionId);
  expect(
    (await readdir(sessionsRoot)).filter((name) => name.startsWith(".cloning-")),
  ).toEqual([]);
  expect(
    (await new SessionCatalog({ workspaceRoot: workspace }).list()).map(
      (summary) => summary.sessionId,
    ),
  ).not.toContain(targetSessionId);
}
