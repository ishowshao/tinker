import { describe, expect, test } from "bun:test";
import type { RuntimeSession, SessionDisposeReason } from "../agent/runtime-session";
import type { SessionId } from "../ids/runtime-id";
import type { SessionCatalog } from "../session/session-catalog";
import { TuiProjectionStore } from "../tui/tui-projection-store";
import {
  DefaultTuiSessionController,
  managedTuiBinding,
} from "../tui/tui-session-controller";
import { createTestRuntime } from "./test-runtime";

describe("DefaultTuiSessionController", () => {
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
    await controller.resume(target.runtime.sessionId);
    expect(current.disposals).toEqual([{ type: "session_switch" }]);
    expect(target.disposals).toEqual([]);
    expect(controller.getBinding().sessionId).toBe(target.runtime.sessionId);
    expect(notifications).toBe(1);
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
} {
  const disposals: SessionDisposeReason[] = [];
  const runtime: RuntimeSession = {
    sessionId,
    resumed: false,
    recovery: { syntheticCompletionCount: 0, recallIndexRebuilt: false },
    skills: () => ({ skills: [], shadowedNames: [] }),
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
    canSwitchSession: () => canSwitchSession,
    dispose: async (reason) => {
      disposals.push(reason);
    },
  };
  return { runtime, disposals };
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

function emptyCatalog(): SessionCatalog {
  return {
    list: async () => [],
    delete: async () => undefined,
  } as unknown as SessionCatalog;
}
