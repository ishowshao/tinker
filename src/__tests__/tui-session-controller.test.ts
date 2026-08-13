import { describe, expect, test } from "bun:test";
import type { RuntimeSession, SessionDisposeReason } from "../agent/runtime-session";
import type { SessionId } from "../ids/runtime-id";
import type { SessionCatalog, SessionSummary } from "../session/session-catalog";
import { TuiProjectionStore } from "../tui/tui-projection-store";
import {
  DefaultTuiSessionController,
  managedTuiBinding,
} from "../tui/tui-session-controller";
import { createTestRuntime } from "./test-runtime";

describe("DefaultTuiSessionController", () => {
  test("lists every stored session candidate through catalog listAll", async () => {
    const current = fakeRuntime("019f53e0-0000-7000-8000-000000000099" as SessionId);
    const summaries = [
      catalogSummary("019f53e0-0000-7000-8000-0000000000aa" as SessionId),
      catalogSummary("019f53e0-0000-7000-8000-0000000000bb" as SessionId),
    ];
    const calls: { list: number; listAll: Array<SessionId | undefined> } = {
      list: 0,
      listAll: [],
    };
    const catalog = {
      list: async () => {
        calls.list += 1;
        return summaries.slice(0, 1);
      },
      listAll: async (currentSessionId?: SessionId) => {
        calls.listAll.push(currentSessionId);
        return summaries;
      },
      delete: async () => undefined,
    } as unknown as SessionCatalog;
    const controller = new DefaultTuiSessionController(
      binding(current.runtime),
      catalog,
      async () => {
        throw new Error("not used");
      },
      async () => {
        throw new Error("not used");
      },
      async () => {
        throw new Error("not used");
      },
    );

    expect(await controller.listSessions()).toEqual(summaries);
    expect(calls.listAll).toEqual([current.runtime.sessionId]);
    expect(calls.list).toBe(0);
  });

  test("serializes undo against other session operations", async () => {
    const current = fakeRuntime("current-session" as SessionId);
    let releaseUndo!: () => void;
    const undoStarted = Promise.withResolvers<void>();
    current.runtime.undoLatestFileMutationTurn = async () => {
      undoStarted.resolve();
      await new Promise<void>((resolve) => {
        releaseUndo = resolve;
      });
      return {
        status: "restored",
        turnNumber: 3,
        restoredFileCount: 1,
        deletedFileCount: 0,
      };
    };
    const controller = new DefaultTuiSessionController(
      binding(current.runtime),
      emptyCatalog(),
      async () => {
        throw new Error("not used");
      },
      async () => {
        throw new Error("not used");
      },
      async () => {
        throw new Error("must not create");
      },
    );

    const undo = controller.undo();
    await undoStarted.promise;
    expect(controller.clear()).rejects.toThrow(
      "Another session operation is already running.",
    );
    releaseUndo();
    expect(await undo).toEqual({
      status: "restored",
      turnNumber: 3,
      restoredFileCount: 1,
      deletedFileCount: 0,
    });
  });

  test("keeps the current binding when target preparation fails", async () => {
    const current = fakeRuntime("current-session" as SessionId);
    const controller = new DefaultTuiSessionController(
      binding(current.runtime),
      emptyCatalog(),
      async () => {
        throw new Error("target mismatch");
      },
      async () => {
        throw new Error("not used");
      },
      async () => {
        throw new Error("not used");
      },
    );
    const error = await controller
      .resume("target-session" as SessionId)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(controller.getBinding().sessionId).toBe("current-session" as SessionId);
    expect(current.disposals).toEqual([]);
  });

  test("prepares the target before disposing and swapping the current session", async () => {
    const current = fakeRuntime("current-session" as SessionId);
    const target = fakeRuntime("target-session" as SessionId);
    let notifications = 0;
    const commits: SessionId[] = [];
    const controller = new DefaultTuiSessionController(
      binding(current.runtime),
      emptyCatalog(),
      async () => binding(target.runtime),
      async () => {
        throw new Error("not used");
      },
      async () => {
        throw new Error("not used");
      },
    );
    controller.subscribe(() => {
      notifications += 1;
    });
    await controller.resume(target.runtime.sessionId, () => {
      commits.push(controller.getBinding().sessionId);
    });
    expect(current.disposals).toEqual([{ type: "session_switch" }]);
    expect(target.disposals).toEqual([]);
    expect(controller.getBinding().sessionId).toBe(target.runtime.sessionId);
    expect(notifications).toBe(1);
    expect(commits).toEqual([current.runtime.sessionId]);
  });

  test("clones before opening the target and switches through the resume binding", async () => {
    const current = fakeRuntime("current-session" as SessionId);
    let openedSessionId: SessionId | undefined;
    let target: ReturnType<typeof fakeRuntime> | undefined;
    const controller = new DefaultTuiSessionController(
      binding(current.runtime),
      emptyCatalog(),
      async (sessionId) => {
        openedSessionId = sessionId;
        target = fakeRuntime(sessionId);
        return binding(target.runtime);
      },
      async () => {
        throw new Error("not used");
      },
      async () => {
        throw new Error("not used");
      },
    );

    const targetSessionId = await controller.fork();

    expect(current.clones).toEqual([targetSessionId]);
    expect(openedSessionId).toBe(targetSessionId);
    expect(controller.getBinding().sessionId).toBe(targetSessionId);
    expect(current.disposals).toEqual([{ type: "session_switch" }]);
    expect(target?.disposals).toEqual([]);
  });

  test("keeps the source binding when a published clone cannot be activated", async () => {
    const current = fakeRuntime("current-session" as SessionId);
    const controller = new DefaultTuiSessionController(
      binding(current.runtime),
      emptyCatalog(),
      async () => {
        throw new Error("clone activation failed");
      },
      async () => {
        throw new Error("not used");
      },
      async () => {
        throw new Error("not used");
      },
    );

    expect(controller.fork()).rejects.toThrow("clone activation failed");
    expect(current.clones).toHaveLength(1);
    expect(controller.getBinding().sessionId).toBe(current.runtime.sessionId);
    expect(current.disposals).toEqual([]);
  });

  test("closes the clone and keeps the source binding when source disposal fails", async () => {
    const current = fakeRuntime("current-session" as SessionId);
    current.runtime.dispose = async (reason) => {
      current.disposals.push(reason);
      throw new Error("source dispose failed");
    };
    let target: ReturnType<typeof fakeRuntime> | undefined;
    const controller = new DefaultTuiSessionController(
      binding(current.runtime),
      emptyCatalog(),
      async (sessionId) => {
        target = fakeRuntime(sessionId);
        return binding(target.runtime);
      },
      async () => {
        throw new Error("not used");
      },
      async () => {
        throw new Error("not used");
      },
    );

    let committed = false;
    expect(
      controller.fork(() => {
        committed = true;
      }),
    ).rejects.toThrow("source dispose failed");
    expect(controller.getBinding().sessionId).toBe(current.runtime.sessionId);
    expect(current.disposals).toEqual([{ type: "session_switch" }]);
    expect(target?.disposals).toEqual([
      { type: "runner_failed", error: "source dispose failed" },
    ]);
    expect(committed).toBe(false);
  });

  test("clears into a fresh session while preserving the current profile", async () => {
    const current = fakeRuntime("current-session" as SessionId);
    const target = fakeRuntime("fresh-session" as SessionId);
    const currentBinding = binding(current.runtime, "deepseek");
    const targetBinding = binding(target.runtime, "deepseek");
    let receivedProfile: string | undefined;
    let notifications = 0;
    const controller = new DefaultTuiSessionController(
      currentBinding,
      emptyCatalog(),
      async () => {
        throw new Error("not used");
      },
      async () => {
        throw new Error("not used");
      },
      async (active) => {
        receivedProfile = active.profileName;
        return targetBinding;
      },
    );
    controller.subscribe(() => {
      notifications += 1;
    });

    await controller.clear();

    expect(receivedProfile).toBe("deepseek");
    expect(current.disposals).toEqual([{ type: "session_switch" }]);
    expect(target.disposals).toEqual([]);
    expect(controller.getBinding().sessionId).toBe(target.runtime.sessionId);
    expect(notifications).toBe(1);
  });

  test("keeps the current session when fresh session creation fails", async () => {
    const current = fakeRuntime("current-session" as SessionId);
    const controller = new DefaultTuiSessionController(
      binding(current.runtime),
      emptyCatalog(),
      async () => {
        throw new Error("not used");
      },
      async () => {
        throw new Error("not used");
      },
      async () => {
        throw new Error("fresh session failed");
      },
    );

    expect(controller.clear()).rejects.toThrow("fresh session failed");
    expect(controller.getBinding().sessionId).toBe(current.runtime.sessionId);
    expect(current.disposals).toEqual([]);
  });

  test("rejects clear while the current runtime cannot switch sessions", async () => {
    const current = fakeRuntime("current-session" as SessionId, false);
    let createCount = 0;
    const controller = new DefaultTuiSessionController(
      binding(current.runtime),
      emptyCatalog(),
      async () => {
        throw new Error("not used");
      },
      async () => {
        throw new Error("not used");
      },
      async () => {
        createCount += 1;
        throw new Error("must not create");
      },
    );

    expect(controller.clear()).rejects.toThrow(
      "Cannot clear the session while a turn, context operation, or background task is active.",
    );
    expect(createCount).toBe(0);
    expect(current.disposals).toEqual([]);
  });
});

function fakeRuntime(
  sessionId: SessionId,
  canSwitchSession = true,
): {
  runtime: RuntimeSession;
  disposals: SessionDisposeReason[];
  clones: SessionId[];
} {
  const disposals: SessionDisposeReason[] = [];
  const clones: SessionId[] = [];
  const runtime: RuntimeSession = {
    sessionId,
    resumed: false,
    recovery: { syntheticCompletionCount: 0, recallIndexRebuilt: false },
    skills: () => ({ skills: [], shadowedNames: [] }),
    mcp: () => ({ servers: [] }),
    reasoningEffort: () => undefined,
    setReasoningEffort: () => {
      throw new Error("not used");
    },
    resetReasoningEffort: () => {
      throw new Error("not used");
    },
    supportsImageInput: () => false,
    importImage: async () => {
      throw new Error("not used");
    },
    verifyImageAssets: async () => undefined,
    admitTurn: async ({ userMessage }) => ({
      turnId: createTestRuntime().turn.turnId,
      userMessage,
      completion: Promise.resolve({
        status: "completed",
        finalText: "done",
        lastIteration: createTestRuntime().iteration,
      }),
    }),
    executeTurn: async () => ({
      status: "completed",
      finalText: "done",
      lastIteration: createTestRuntime().iteration,
    }),
    compactContext: async () => {
      throw new Error("not used");
    },
    retireContext: async () => {
      throw new Error("not used");
    },
    undoLatestFileMutationTurn: async () => ({ status: "nothing" }),
    cloneSession: async (targetSessionId) => {
      clones.push(targetSessionId);
    },
    canSwitchSession: () => canSwitchSession,
    bashGuard: () => ({ mode: "guard", source: "default" }),
    subscribeBashGuard: () => () => undefined,
    setYoloMode: () => undefined,
    resolveBashConfirmation: async () => undefined,
    dispose: async (reason) => {
      disposals.push(reason);
    },
  };
  return { runtime, disposals, clones };
}

function binding(runtime: RuntimeSession, profileName?: string) {
  return managedTuiBinding({
    runtimeSession: runtime,
    modelName: "test-model",
    workspaceRoot: "/tmp/tinker",
    ...(profileName === undefined ? {} : { profileName }),
    projectionStore: new TuiProjectionStore({
      sessionId: runtime.sessionId,
      modelName: "test-model",
      workspaceRoot: "/tmp/tinker",
    }),
  });
}

function catalogSummary(sessionId: SessionId): SessionSummary {
  return {
    sessionId,
    modelName: "test-model",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    turnCount: 1,
    firstUserPromptPreview: "stored prompt",
    status: "resumable",
    databaseBytes: 1_024,
  };
}

function emptyCatalog(): SessionCatalog {
  return {
    list: async () => [],
    listAll: async () => [],
    delete: async () => undefined,
  } as unknown as SessionCatalog;
}
