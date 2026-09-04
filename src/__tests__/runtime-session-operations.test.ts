import { describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimeSession } from "../agent/runtime-session";
import { cancellationError } from "../agent/turn-cancellation";
import { runtimeIdFactory } from "../ids/runtime-id";
import type {
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { RuntimeReasoningEffort } from "../model/reasoning-effort";
import { SessionStore } from "../session/session-store";
import {
  CapturingModel,
  createInput,
  WaitingModel,
} from "./helpers/runtime-session-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";
import { collectingEventSink, TestModelClient, testModelOutput } from "./test-runtime";

isolateTinkerHome();

class ReasoningWaitingModel extends WaitingModel {
  readonly reasoningEffort = new RuntimeReasoningEffort({
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  });
}

class BackgroundTaskModel extends TestModelClient {
  private requestCount = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    if (this.requestCount === 1) {
      const identity = options.identity;
      if (identity === undefined) {
        throw new Error("Expected runtime identity for background Bash.");
      }
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...identity.runtimeSession.createToolCall(identity.iteration, 1),
            providerToolCallId: "provider-background",
            name: "Bash",
            args: { command: "sleep 30", run_in_background: true },
          },
        ],
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "background started",
    });
  }
}

class UndoMutationModel extends TestModelClient {
  calls = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      if (options.identity === undefined) {
        throw new Error("Expected runtime identity for undo mutations.");
      }
      const { iteration, runtimeSession } = options.identity;
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...runtimeSession.createToolCall(iteration, 1),
            providerToolCallId: "provider-undo-delete",
            name: "Delete",
            args: { file_path: "original.bin" },
          },
          {
            ...runtimeSession.createToolCall(iteration, 2),
            providerToolCallId: "provider-undo-write",
            name: "Write",
            args: { file_path: "created.txt", content: "created\n" },
          },
        ],
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "mutations complete",
    });
  }
}

class UndoTerminalModel extends TestModelClient {
  readonly secondStarted: Promise<void>;
  private markSecondStarted!: () => void;
  private calls = 0;

  constructor(private readonly outcome: "failed" | "cancelled") {
    super();
    this.secondStarted = new Promise((resolve) => {
      this.markSecondStarted = resolve;
    });
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      if (options.identity === undefined) {
        throw new Error("Expected runtime identity for terminal undo mutation.");
      }
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...options.identity.runtimeSession.createToolCall(
              options.identity.iteration,
              1,
            ),
            providerToolCallId: "provider-terminal-undo-write",
            name: "Write",
            args: { file_path: "terminal.txt", content: this.outcome },
          },
        ],
      });
    }

    this.markSecondStarted();
    if (this.outcome === "failed") {
      throw new Error("terminal model failure");
    }
    return new Promise((_resolve, reject) => {
      const abort = () => reject(cancellationError(options.signal));
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

describe("RuntimeSession operations", () => {
  test("clones an idle runtime without requesting the model", async () => {
    const model = new CapturingModel();
    const input = createInput(model, collectingEventSink(), "runtime-clone");
    const session = await createRuntimeSession(input, {
      loadMcpConfig: async () => undefined,
    });
    const targetSessionId = runtimeIdFactory.createSessionId();
    let target: SessionStore | undefined;
    try {
      await session.cloneSession(targetSessionId);
      target = await SessionStore.openExisting({
        workspaceRoot: input.workspaceRoot,
        sessionId: targetSessionId,
      });
      expect(target.validateAll({ allowOpenTail: false }).sessionId).toBe(
        targetSessionId,
      );
      expect(model.inputs).toHaveLength(0);
    } finally {
      await target?.abandon().catch(() => undefined);
      await session.dispose({ type: "tui_exit" });
    }
  });

  test("rejects cloning while a turn is active", async () => {
    const model = new WaitingModel();
    const input = createInput(model, collectingEventSink(), "clone-active-turn");
    const session = await createRuntimeSession(input, {
      loadMcpConfig: async () => undefined,
    });
    const controller = new AbortController();
    const turn = session.executeTurn({
      userMessage: { role: "user", content: "wait" },
      signal: controller.signal,
    });
    await model.started;
    try {
      expect(session.cloneSession(runtimeIdFactory.createSessionId())).rejects.toThrow(
        "Cannot clone the session while a turn, context operation, or background task is active.",
      );
      expect(session.undoLatestFileMutationTurn()).rejects.toThrow(
        "Cannot undo while a turn or context operation is active.",
      );
    } finally {
      controller.abort();
      await turn;
      await session.dispose({ type: "tui_exit" });
    }
  });

  test("changes reasoning effort only for the idle runtime activation", async () => {
    const model = new ReasoningWaitingModel();
    const input = createInput(model, collectingEventSink(), "runtime-reasoning-effort");
    const session = await createRuntimeSession(input, {
      loadMcpConfig: async () => undefined,
    });
    const controller = new AbortController();
    try {
      expect(session.reasoningEffort()).toEqual({
        supportedEfforts: ["low", "medium", "high"],
        defaultEffort: "medium",
        effort: "medium",
        source: "profile_default",
      });
      expect(session.setReasoningEffort("high")).toMatchObject({
        effort: "high",
        source: "session_override",
      });
      expect(() => session.setReasoningEffort("deep")).toThrow(
        "Available efforts: low, medium, high",
      );

      const turn = session.executeTurn({
        userMessage: { role: "user", content: "wait" },
        signal: controller.signal,
      });
      await model.started;
      expect(() => session.setReasoningEffort("low")).toThrow(
        "Cannot change reasoning effort",
      );
      controller.abort();
      await turn;

      expect(session.resetReasoningEffort()).toMatchObject({
        effort: "medium",
        source: "profile_default",
      });
    } finally {
      controller.abort();
      await session.dispose({ type: "tui_exit" });
      await rm(input.workspaceRoot, { recursive: true });
    }
  });

  test("rejects cloning while a background task is running", async () => {
    const input = createInput(
      new BackgroundTaskModel(),
      collectingEventSink(),
      "clone-background-task",
    );
    const session = await createRuntimeSession(input, {
      loadMcpConfig: async () => undefined,
    });
    try {
      expect(
        await session.executeTurn({
          userMessage: { role: "user", content: "start background work" },
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ status: "completed" });
      expect(session.cloneSession(runtimeIdFactory.createSessionId())).rejects.toThrow(
        "Cannot clone the session while a turn, context operation, or background task is active.",
      );
      expect(session.undoLatestFileMutationTurn()).rejects.toThrow(
        "Cannot undo while a background task is active.",
      );
    } finally {
      await session.dispose({ type: "tui_exit" });
    }
  });

  test("completes and restores active-runtime undo without events or model calls", async () => {
    const model = new UndoMutationModel();
    const sink = collectingEventSink();
    const input = {
      ...createInput(model, sink, "runtime-turn-undo"),
      enableTurnUndo: true,
    };
    const originalBytes = Buffer.from([0xff, 0x00, 0x61, 0x80]);
    await writeFile(path.join(input.workspaceRoot, "original.bin"), originalBytes);
    const session = await createRuntimeSession(input, {
      loadMcpConfig: async () => undefined,
    });

    try {
      expect(
        await session.executeTurn({
          userMessage: { role: "user", content: "change files" },
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ status: "completed" });
      expect(
        readFile(path.join(input.workspaceRoot, "original.bin")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await readFile(path.join(input.workspaceRoot, "created.txt"), "utf8"),
      ).toBe("created\n");
      await session.compactContext();
      const eventCount = sink.events.length;
      const modelCallCount = model.calls;

      expect(await session.undoLatestFileMutationTurn()).toEqual({
        status: "restored",
        turnNumber: 1,
        restoredFileCount: 1,
        deletedFileCount: 1,
      });
      expect(await readFile(path.join(input.workspaceRoot, "original.bin"))).toEqual(
        originalBytes,
      );
      expect(
        readFile(path.join(input.workspaceRoot, "created.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(model.calls).toBe(modelCallCount);
      expect(sink.events).toHaveLength(eventCount);
      expect(await session.undoLatestFileMutationTurn()).toEqual({
        status: "nothing",
      });
    } finally {
      await session.dispose({ type: "tui_exit" });
      await rm(input.workspaceRoot, { recursive: true });
    }
  });

  test("keeps file mutations from failed and cancelled turns undoable", async () => {
    for (const outcome of ["failed", "cancelled"] as const) {
      const model = new UndoTerminalModel(outcome);
      const input = {
        ...createInput(model, collectingEventSink(), `runtime-undo-${outcome}`),
        enableTurnUndo: true,
      };
      const session = await createRuntimeSession(input, {
        loadMcpConfig: async () => undefined,
      });
      const controller = new AbortController();

      try {
        const completion = session.executeTurn({
          userMessage: { role: "user", content: outcome },
          signal: controller.signal,
        });
        await model.secondStarted;
        if (outcome === "cancelled") {
          controller.abort();
        }
        expect(await completion).toMatchObject({ status: outcome });
        expect(
          await readFile(path.join(input.workspaceRoot, "terminal.txt"), "utf8"),
        ).toBe(outcome);
        expect(await session.undoLatestFileMutationTurn()).toMatchObject({
          status: "restored",
          deletedFileCount: 1,
        });
        expect(
          readFile(path.join(input.workspaceRoot, "terminal.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await session.dispose({ type: "tui_exit" });
        await rm(input.workspaceRoot, { recursive: true });
      }
    }
  });
});
