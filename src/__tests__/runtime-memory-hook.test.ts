import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRuntimeSession,
  type CompletedTurnHook,
  type CompletedTurnHookFailure,
  type CompletedTurnHookInput,
  type CreateRuntimeSessionInput,
} from "../agent/runtime-session";
import type { ModelRequestOutput, PreparedModelRequest } from "../model/model-client";
import { runtimeIdFactory } from "../ids/runtime-id";
import { SessionStore, type CompletedTurnSnapshot } from "../session/session-store";
import {
  collectingEventSink,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
} from "./test-runtime";

class CompletedModel extends TestModelClient {
  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    return testModelOutput(prepared, {
      role: "assistant",
      content: "completed answer",
    });
  }
}

class FailsOnceModel extends TestModelClient {
  private calls = 0;

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      throw new Error("provider unavailable");
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "recovered answer",
    });
  }
}

describe("RuntimeSession completed-turn hook", () => {
  test("passes the exact frozen post-commit snapshot after turn.finished", async () => {
    const fixture = await createFixture();
    let storeSnapshot: CompletedTurnSnapshot | undefined;
    const enqueued: CompletedTurnHookInput[] = [];
    const hook: CompletedTurnHook = {
      enqueue(input) {
        expect(fixture.events.events.at(-1)?.type).toBe("turn.finished");
        enqueued.push(input);
      },
      recordFailure() {
        throw new Error("Unexpected completed-turn hook failure.");
      },
    };
    try {
      const session = await createRuntimeSession(
        createInput(fixture, new CompletedModel(), hook),
        {
          loadMcpConfig: async () => undefined,
          openStore: async (input, idFactory) => {
            const store = await SessionStore.createNew({
              workspaceRoot: input.workspaceRoot,
              sessionId: input.selection.sessionId,
              modelName: input.modelName,
              systemPrompt: input.systemPrompt,
              projectInstruction: input.projectInstruction,
              idFactory,
            });
            const readSnapshot = store.readCompletedTurnSnapshot.bind(store);
            store.readCompletedTurnSnapshot = (turnId) => {
              storeSnapshot = readSnapshot(turnId);
              return storeSnapshot;
            };
            return store;
          },
        },
      );
      const result = await session.executeTurn({
        userMessage: { role: "user", content: "remember this turn" },
        signal: new AbortController().signal,
      });

      expect(result.status).toBe("completed");
      expect(enqueued).toHaveLength(1);
      if (storeSnapshot === undefined) {
        throw new Error("Expected SessionStore completed-turn snapshot.");
      }
      expect(enqueued[0]?.snapshot).toBe(storeSnapshot);
      expect(enqueued[0]?.snapshot.messages).toEqual([
        {
          ordinal: 2,
          role: "user",
          content: "remember this turn",
        },
        {
          ordinal: 3,
          role: "assistant",
          content: "completed answer",
        },
      ]);
      expect(Object.isFrozen(enqueued[0]?.snapshot)).toBe(true);
      await session.dispose({ type: "tui_exit" });
    } finally {
      await fixture.cleanup();
    }
  });

  test("isolates hook enqueue failures from the completed turn and later turns", async () => {
    const fixture = await createFixture();
    const failures: CompletedTurnHookFailure[] = [];
    const hook: CompletedTurnHook = {
      enqueue() {
        throw new Error("projection failed");
      },
      recordFailure(input) {
        failures.push(input);
      },
    };
    try {
      const session = await createRuntimeSession(
        createInput(fixture, new CompletedModel(), hook),
        { loadMcpConfig: async () => undefined },
      );
      const first = await session.executeTurn({
        userMessage: { role: "user", content: "first" },
        signal: new AbortController().signal,
      });
      const second = await session.executeTurn({
        userMessage: { role: "user", content: "second" },
        signal: new AbortController().signal,
      });

      expect(first.status).toBe("completed");
      expect(second.status).toBe("completed");
      expect(failures.map((failure) => failure.reason)).toEqual([
        "completed_turn_enqueue_failed",
        "completed_turn_enqueue_failed",
      ]);
      await session.dispose({ type: "tui_exit" });
    } finally {
      await fixture.cleanup();
    }
  });

  test("isolates snapshot failures and reports the bounded stage", async () => {
    const fixture = await createFixture();
    const failures: CompletedTurnHookFailure[] = [];
    let enqueueCalls = 0;
    const hook: CompletedTurnHook = {
      enqueue() {
        enqueueCalls += 1;
      },
      recordFailure(input) {
        failures.push(input);
      },
    };
    try {
      const session = await createRuntimeSession(
        createInput(fixture, new CompletedModel(), hook),
        {
          loadMcpConfig: async () => undefined,
          openStore: async (input, idFactory) => {
            const store = await SessionStore.createNew({
              workspaceRoot: input.workspaceRoot,
              sessionId: input.selection.sessionId,
              modelName: input.modelName,
              systemPrompt: input.systemPrompt,
              projectInstruction: input.projectInstruction,
              idFactory,
            });
            store.readCompletedTurnSnapshot = () => {
              throw new Error("corrupt completed row");
            };
            return store;
          },
        },
      );
      const result = await session.executeTurn({
        userMessage: { role: "user", content: "complete despite snapshot" },
        signal: new AbortController().signal,
      });

      expect(result.status).toBe("completed");
      expect(enqueueCalls).toBe(0);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        reason: "completed_turn_snapshot_failed",
      });
      await session.dispose({ type: "tui_exit" });
    } finally {
      await fixture.cleanup();
    }
  });

  test("does not notify failed turns", async () => {
    const fixture = await createFixture();
    const enqueued: CompletedTurnHookInput[] = [];
    const hook: CompletedTurnHook = {
      enqueue(input) {
        enqueued.push(input);
      },
      recordFailure() {},
    };
    try {
      const session = await createRuntimeSession(
        createInput(fixture, new FailsOnceModel(), hook),
        { loadMcpConfig: async () => undefined },
      );
      const failed = await session.executeTurn({
        userMessage: { role: "user", content: "fails" },
        signal: new AbortController().signal,
      });
      const completed = await session.executeTurn({
        userMessage: { role: "user", content: "recovers" },
        signal: new AbortController().signal,
      });

      expect(failed.status).toBe("failed");
      expect(completed.status).toBe("completed");
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]?.snapshot.messages[0]).toMatchObject({
        role: "user",
        content: "recovers",
      });
      await session.dispose({ type: "tui_exit" });
    } finally {
      await fixture.cleanup();
    }
  });
});

async function createFixture() {
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), "tinker-runtime-memory-hook-"),
  );
  return {
    workspaceRoot,
    sessionId: runtimeIdFactory.createSessionId(),
    events: collectingEventSink(),
    cleanup: () => rm(workspaceRoot, { recursive: true }),
  };
}

function createInput(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  modelClient: TestModelClient,
  completedTurnHook: CompletedTurnHook,
): CreateRuntimeSessionInput {
  return {
    selection: {
      mode: "new",
      sessionId: fixture.sessionId,
    },
    workspaceRoot: fixture.workspaceRoot,
    modelName: "test-model",
    maxIterations: 2,
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    modelClient,
    systemPrompt: "system",
    presentationSinks: [fixture.events],
    persistence: false,
    completedTurnHook,
  };
}
