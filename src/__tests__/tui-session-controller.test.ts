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
});

function fakeRuntime(sessionId: SessionId): {
  runtime: RuntimeSession;
  disposals: SessionDisposeReason[];
} {
  const disposals: SessionDisposeReason[] = [];
  const runtime: RuntimeSession = {
    sessionId,
    resumed: false,
    recovery: { syntheticCompletionCount: 0, recallIndexRebuilt: false },
    executeTurn: async () => ({
      status: "completed",
      finalText: "done",
      lastIteration: createTestRuntime().iteration,
    }),
    canSwitchSession: () => true,
    dispose: async (reason) => {
      disposals.push(reason);
    },
  };
  return { runtime, disposals };
}

function binding(runtime: RuntimeSession) {
  return managedTuiBinding({
    runtimeSession: runtime,
    modelName: "test-model",
    workspaceRoot: "/tmp/tinker",
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
