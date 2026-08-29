import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IterationIdentity, ToolCall, TurnIdentity } from "../agent/types";
import { textToolResultContent } from "../agent/tool-result-content";
import { runtimeIdFactory } from "../ids/runtime-id";
import { SessionStore } from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import { finalizeTestSessionStore } from "./test-runtime";

describe("SessionStore completed-turn snapshots", () => {
  test("reads only one completed turn into frozen role-specific records", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-completed-snapshot-"),
    );
    const sessionId = runtimeIdFactory.createSessionId();
    let store: SessionStore | undefined;
    try {
      store = await SessionStore.createNew({
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
      const memoryCall: ToolCall = {
        ...firstIteration,
        toolCallId: runtimeIdFactory.createToolCallId(),
        toolCallNumber: 1,
        providerToolCallId: "provider-memory",
        name: "MemorySearch",
        args: { query: "prior preference" },
      };
      const readCall: ToolCall = {
        ...firstIteration,
        toolCallId: runtimeIdFactory.createToolCallId(),
        toolCallNumber: 2,
        providerToolCallId: "provider-read",
        name: "Read",
        args: { file_path: "README.md" },
      };
      const pending = ledger.beginTurn({
        turn,
        userMessage: {
          role: "user",
          content: "Use the prior preference [Image #1].",
        },
      });
      store.beginIteration(firstIteration);
      pending.agent.appendAssistant({
        iteration: firstIteration,
        message: {
          role: "assistant",
          content: null,
          reasoningContent: "I should check both memory and current files.",
          toolCalls: [memoryCall, readCall],
        },
        provider: "test",
        model: "test-model",
      });
      pending.agent.commitToolCompletions([
        {
          call: memoryCall,
          kind: "returned",
          raw: {
            kind: "memory_search",
            ok: true,
            degraded: null,
            matches: [
              {
                memoryId: "memory-1",
                text: "A derived memory.",
                summary: "",
                score: 0.9,
                via: ["vector"],
                sourceWorkspace: "/other",
                sourceSessionId: "source-session",
                createdAt: "2026-07-25T10:00:00.000Z",
              },
            ],
          },
          observation: textToolResultContent(
            "MemorySearch returned one derived memory.",
          ),
        },
        {
          call: readCall,
          kind: "returned",
          raw: {
            kind: "read",
            ok: true,
            filePath: "README.md",
            content: "current contents",
          },
          observation: textToolResultContent("Read succeeded with current contents."),
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
        message: {
          role: "assistant",
          content: "Final verified answer.",
        },
        provider: "test",
        model: "test-model",
      });

      expect(() => store!.readCompletedTurnSnapshot(turn.turnId)).toThrow(
        "is not completed",
      );
      pending.finish({
        status: "completed",
        finalText: "Final verified answer.",
        lastIteration: finalIteration,
      });

      const loadProtocolView = store.loadProtocolView.bind(store);
      store.loadProtocolView = () => {
        throw new Error("completed snapshot must not load the whole session");
      };
      const snapshot = store.readCompletedTurnSnapshot(turn.turnId);
      store.loadProtocolView = loadProtocolView;

      expect(snapshot.messages).toEqual([
        {
          ordinal: 2,
          role: "user",
          content: "Use the prior preference [Image #1].",
        },
        {
          ordinal: 3,
          role: "assistant",
          content: null,
          reasoningContent: "I should check both memory and current files.",
        },
        {
          ordinal: 4,
          role: "tool",
          name: "MemorySearch",
          content: "MemorySearch returned one derived memory.",
        },
        {
          ordinal: 5,
          role: "tool",
          name: "Read",
          content: "Read succeeded with current contents.",
        },
        {
          ordinal: 6,
          role: "assistant",
          content: "Final verified answer.",
        },
      ]);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.messages)).toBe(true);
      expect(snapshot.messages.every((message) => Object.isFrozen(message))).toBe(true);
      expect(
        snapshot.messages.every((message) => typeof message.ordinal === "number"),
      ).toBe(true);
      await store.close("tui_exit");
      store = undefined;
    } finally {
      await store?.abandon().catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });
});
