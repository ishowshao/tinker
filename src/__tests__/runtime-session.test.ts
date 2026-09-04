import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeSession, type RuntimeSession } from "../agent/runtime-session";
import { DEFAULT_PUBLIC_TOOLING_CONFIG } from "../cli/public-config-contract";
import { createDefaultTooling } from "../tools/registry";
import {
  CapturingModel,
  createInput,
  createTestSession,
  WaitingModel,
} from "./helpers/runtime-session-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";
import { collectingEventSink, deterministicIdFactory } from "./test-runtime";

isolateTinkerHome();

describe("RuntimeSession lifecycle", () => {
  test("passes resolved tooling config to built-in and MCP composition", async () => {
    const toolingConfig = Object.freeze({
      ...DEFAULT_PUBLIC_TOOLING_CONFIG,
      mcpTimeoutMs: 1234,
      mcpMaxObservationChars: 5678,
      webFetchRefineThreshold: 99,
    });
    let builtInConfig: unknown;
    let mcpOptions: { timeoutMs?: number; maxObservationChars?: number } | undefined;
    const input = {
      ...createInput(new CapturingModel(), collectingEventSink(), "tooling-config"),
      toolingConfig,
    };
    const session = await createRuntimeSession(input, {
      createTooling: (options) => {
        builtInConfig = options.toolingConfig;
        return createDefaultTooling(options);
      },
      loadMcpConfig: async () => ({ servers: new Map() }),
      createMcpManager: async (options) => {
        mcpOptions = options;
        return {
          executors: [],
          inventory: { servers: [] },
          dispose: async () => undefined,
        };
      },
    });

    await session.dispose({ type: "oneshot_complete" });
    expect(builtInConfig).toBe(toolingConfig);
    expect(mcpOptions).toMatchObject({
      timeoutMs: 1234,
      maxObservationChars: 5678,
    });
  });

  test("owns ordered turns, events, and cross-turn messages", async () => {
    const sink = collectingEventSink();
    const model = new CapturingModel();
    const session = await createTestSession(model, sink, "ordered");

    const first = await session.executeTurn({
      userMessage: { role: "user", content: "first" },
      signal: new AbortController().signal,
    });
    const second = await session.executeTurn({
      userMessage: { role: "user", content: "second" },
      signal: new AbortController().signal,
    });
    await session.dispose({ type: "oneshot_complete" });

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(first).not.toHaveProperty("messages");
    expect(second).not.toHaveProperty("messages");
    expect(
      sink.events
        .filter((event) => event.type === "turn.started")
        .map((event) => event.turnNumber),
    ).toEqual([1, 2]);
    expect(sink.events.map((event) => event.eventSequence)).toEqual(
      sink.events.map((_, index) => index + 1),
    );
    expect(model.inputs[1]?.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "first" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "second" },
    ]);
    expect(sink.events.at(-1)).toMatchObject({
      type: "session.finished",
      data: { reason: "oneshot_complete" },
    });
  });

  test("fast-fails empty and concurrent turns without allocating identities", async () => {
    const sink = collectingEventSink();
    const model = new WaitingModel();
    const session = await createTestSession(model, sink, "concurrent");

    expect(() =>
      session.executeTurn({
        userMessage: { role: "user", content: "   " },
        signal: new AbortController().signal,
      }),
    ).toThrow("must not be empty");

    const pending = session.executeTurn({
      userMessage: { role: "user", content: "wait" },
      signal: new AbortController().signal,
    });
    await model.started;
    expect(() =>
      session.executeTurn({
        userMessage: { role: "user", content: "second" },
        signal: new AbortController().signal,
      }),
    ).toThrow("executing");

    const firstDispose = session.dispose({ type: "tui_exit" });
    const secondDispose = session.dispose({ type: "runner_failed", error: "late" });
    expect(firstDispose).toBe(secondDispose);
    const result = await pending;
    await firstDispose;

    expect(result.status).toBe("cancelled");
    expect(result.status === "cancelled" ? result.cancellation.source : undefined).toBe(
      "session_dispose",
    );
    expect(sink.events.at(-1)).toMatchObject({
      type: "session.finished",
      data: { reason: "tui_exit" },
    });
    expect(() =>
      session.executeTurn({
        userMessage: { role: "user", content: "after dispose" },
        signal: new AbortController().signal,
      }),
    ).toThrow("disposed");
  });

  test("rejects an oversized prompt before allocating a turn or calling provider", async () => {
    const sink = collectingEventSink();
    const model = new CapturingModel();
    const session = await createTestSession(model, sink, "admission-budget");

    let caught: unknown;
    try {
      await session.executeTurn({
        userMessage: { role: "user", content: "x".repeat(1_000_000) },
        signal: new AbortController().signal,
      });
    } catch (error) {
      caught = error;
    }
    await session.dispose({ type: "oneshot_complete" });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      "Model request blocked before provider call",
    );
    expect(model.inputs).toHaveLength(0);
    expect(sink.events.some((event) => event.type === "turn.started")).toBe(false);
    expect(sink.events.some((event) => event.type === "model.request.started")).toBe(
      false,
    );
  });

  test("rolls back tooling and finishes a successfully started session", async () => {
    const sink = collectingEventSink();
    let toolingDisposed = false;

    const initializationError = await createRuntimeSession(
      createInput(new CapturingModel(), sink, "rollback"),
      {
        createTooling: (options) => {
          const tooling = createDefaultTooling(options);
          const dispose = tooling.dispose.bind(tooling);
          tooling.dispose = async (reason) => {
            toolingDisposed = true;
            await dispose(reason);
          };
          return tooling;
        },
        loadMcpConfig: async () => {
          throw new Error("bad mcp config");
        },
      },
    ).catch((error: unknown) => error);

    expect(initializationError).toBeInstanceOf(Error);
    expect((initializationError as Error).message).toContain("bad mcp config");
    expect(toolingDisposed).toBe(true);
    expect(sink.events.map((event) => event.type)).toEqual([
      "session.started",
      "session.finished",
    ]);
    expect(sink.events[1]).toMatchObject({
      data: { reason: "initialization_failed", error: "bad mcp config" },
    });
  });

  test("fast-fails an unusable persistence path before requesting the model", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-events-"));
    const directoryAsLog = path.join(workspace, "events-as-directory");
    await mkdir(directoryAsLog);
    const sink = collectingEventSink();
    const model = new CapturingModel();
    const input = createInput(model, sink, "persistence-failure");
    input.workspaceRoot = workspace;
    input.persistence = {
      eventLogPath: directoryAsLog,
      observationLogPath: path.join(workspace, "observations.md"),
    };

    const error = await createRuntimeSession(input, {
      idFactory: deterministicIdFactory("persistence-failure"),
      loadMcpConfig: async () => undefined,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(model.inputs).toHaveLength(0);
    expect(sink.events[0]?.type).toBe("session.started");
  });

  test("returns only the runner-facing API and uses UUIDv7 production IDs", async () => {
    const session = await createRuntimeSession(
      createInput(new CapturingModel(), collectingEventSink(), crypto.randomUUID()),
      { loadMcpConfig: async () => undefined },
    );
    const uuidV7 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const result = await session.executeTurn({
      userMessage: { role: "user", content: "hello" },
      signal: new AbortController().signal,
    });
    await session.dispose({ type: "oneshot_complete" });

    expect(result.lastIteration.turnId).toMatch(uuidV7);
    expect(result.lastIteration.iterationId).toMatch(uuidV7);
    const runnerApiKeys: (keyof RuntimeSession)[] = [
      "sessionId",
      "mcp",
      "executeTurn",
      "compactContext",
      "dispose",
    ];
    expect(runnerApiKeys).toHaveLength(5);
  });
});
