import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IterationIdentity, ToolCall, TurnIdentity } from "../agent/types";
import { runtimeIdFactory } from "../ids/runtime-id";
import { SessionStore, createRuntimeContract } from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import { TEST_CONTEXT_BUDGET, TEST_CONTEXT_PROFILE } from "./test-runtime";

describe("SessionStore and SqliteSessionLedger", () => {
  test("round-trips empty assistant tool-call text across turns and resume", async () => {
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
      store.finalizeRuntimeContract(testContract());
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
      store.finalizeRuntimeContract(testContract());
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
      store.assertRuntimeContract(testContract());
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
      store.finalizeRuntimeContract(testContract());
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

function testContract() {
  return createRuntimeContract({
    modelName: "test-model",
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    systemPrompt: "system",
    toolSchemaSha256: "a".repeat(64),
    requestConfigSha256: "b".repeat(64),
  });
}
