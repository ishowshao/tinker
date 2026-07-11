import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import {
  createRuntimeSession,
  type CreateRuntimeSessionInput,
  type RuntimeSession,
} from "../agent/runtime-session";
import { cancellationError } from "../agent/turn-cancellation";
import type { EventSink } from "../events/event-sink";
import type {
  ModelClient,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
} from "../model/model-client";
import type { SessionId } from "../ids/runtime-id";
import { createDefaultTooling } from "../tools/registry";
import { collectingEventSink, deterministicIdFactory } from "./test-runtime";

class CapturingModel implements ModelClient {
  readonly inputs: ModelRequestInput[] = [];

  async request(input: ModelRequestInput): Promise<ModelRequestOutput> {
    this.inputs.push({ messages: [...input.messages], tools: [...input.tools] });
    return {
      message: {
        role: "assistant",
        content: `answer-${this.inputs.length}`,
      },
    };
  }
}

class WaitingModel implements ModelClient {
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  async request(
    _input: ModelRequestInput,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.markStarted();
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

describe("RuntimeSession lifecycle", () => {
  test("owns ordered turns, events, and cross-turn messages", async () => {
    const sink = collectingEventSink();
    const model = new CapturingModel();
    const session = await createTestSession(model, sink, "ordered");

    const first = await session.executeTurn({
      userPrompt: "first",
      signal: new AbortController().signal,
    });
    const second = await session.executeTurn({
      userPrompt: "second",
      signal: new AbortController().signal,
    });
    await session.dispose({ type: "oneshot_complete" });

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
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
        userPrompt: "   ",
        signal: new AbortController().signal,
      }),
    ).toThrow("empty prompt");

    const pending = session.executeTurn({
      userPrompt: "wait",
      signal: new AbortController().signal,
    });
    await model.started;
    expect(() =>
      session.executeTurn({
        userPrompt: "second",
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
        userPrompt: "after dispose",
        signal: new AbortController().signal,
      }),
    ).toThrow("disposed");
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

  test("disables a failed presentation sink and reports the failure to healthy sinks", async () => {
    const healthySink = collectingEventSink();
    let failedAppendCount = 0;
    const failedSink: EventSink = {
      name: "broken-presenter",
      async append() {
        failedAppendCount += 1;
        throw new Error("render failed");
      },
    };
    const model = new CapturingModel();
    const input = createInput(model, healthySink, "auxiliary-failure");
    input.presentationSinks = [failedSink, healthySink];
    const session = await createRuntimeSession(input, {
      idFactory: deterministicIdFactory("auxiliary-failure"),
      loadMcpConfig: async () => undefined,
    });

    const result = await session.executeTurn({
      userPrompt: "continue",
      signal: new AbortController().signal,
    });
    await session.dispose({ type: "oneshot_complete" });

    expect(result.status).toBe("completed");
    expect(failedAppendCount).toBe(1);
    const diagnostic = healthySink.events.find(
      (event) => event.type === "diagnostic.sink_failed",
    );
    expect(diagnostic?.data).toEqual({
      sinkName: "broken-presenter",
      failedEventType: "session.started",
      error: "render failed",
    });
    expect(healthySink.events.at(-1)?.type).toBe("session.finished");
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
      userPrompt: "hello",
      signal: new AbortController().signal,
    });
    await session.dispose({ type: "oneshot_complete" });

    expect(result.lastIteration.turnId).toMatch(uuidV7);
    expect(result.lastIteration.iterationId).toMatch(uuidV7);
    const runnerApiKeys: (keyof RuntimeSession)[] = [
      "sessionId",
      "executeTurn",
      "dispose",
    ];
    expect(runnerApiKeys).toHaveLength(3);
  });
});

async function createTestSession(
  model: ModelClient,
  sink: EventSink,
  prefix: string,
): Promise<RuntimeSession> {
  return createRuntimeSession(createInput(model, sink, prefix), {
    idFactory: deterministicIdFactory(prefix),
    loadMcpConfig: async () => undefined,
  });
}

function createInput(
  model: ModelClient,
  sink: EventSink,
  prefix: string,
): CreateRuntimeSessionInput {
  return {
    sessionId: `${prefix}-session` as SessionId,
    workspaceRoot: process.cwd(),
    modelName: "test-model",
    maxIterations: 2,
    includeReasoningContent: false,
    systemPrompt: "system",
    modelClient: model,
    presentationSinks: [sink],
    persistence: false,
  };
}
