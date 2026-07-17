import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { Database } from "bun:sqlite";
import { FatalAgentTurnError } from "../agent/loop";
import {
  createRuntimeSession,
  type CreateRuntimeSessionInput,
  RuntimeEventAppendError,
  type RuntimeSession,
} from "../agent/runtime-session";
import { InMemorySessionLedger } from "../agent/session-ledger";
import { materializeAgentMessages } from "../context/protocol-frame";
import { cancellationError } from "../agent/turn-cancellation";
import type { EventSink } from "../events/event-sink";
import type {
  ModelClient,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { toOpenAIChatMessages } from "../model/openai-chat-mapping";
import type { SessionId } from "../ids/runtime-id";
import { SessionError } from "../session/session-errors";
import type { SessionHistoryReader } from "../session/session-history-reader";
import type { SessionStore } from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import { createDefaultTooling } from "../tools/registry";
import {
  collectingEventSink,
  deterministicIdFactory,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

class CapturingModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push({ messages: [...input.messages], tools: [...input.tools] });
    return testModelOutput(prepared, {
      role: "assistant",
      content: `answer-${this.inputs.length}`,
    });
  }
}

class WaitingModel extends TestModelClient {
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  async request(
    _prepared: PreparedModelRequest,
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

class FailingToolCallModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push({ messages: [...input.messages], tools: [...input.tools] });

    if (this.inputs.length === 1) {
      if (options.identity === undefined) {
        throw new Error("Expected model request identity.");
      }
      const { iteration, runtimeSession } = options.identity;
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...runtimeSession.createToolCall(iteration, 1),
            providerToolCallId: "provider-read",
            name: "Read",
            args: { file_path: "README.md" },
          },
          {
            ...runtimeSession.createToolCall(iteration, 2),
            providerToolCallId: "provider-glob",
            name: "Glob",
            args: { pattern: "*" },
          },
        ],
      });
    }

    return testModelOutput(prepared, {
      role: "assistant",
      content: "recovered",
    });
  }
}

class FatalRecallModel extends TestModelClient {
  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    if (options.identity === undefined) {
      throw new Error("Expected model request identity.");
    }
    const { iteration, runtimeSession } = options.identity;
    return testModelOutput(prepared, {
      role: "assistant",
      toolCalls: [
        {
          ...runtimeSession.createToolCall(iteration, 1),
          providerToolCallId: "provider-recall",
          name: "Recall",
          args: { mode: "search", query: "history" },
        },
        {
          ...runtimeSession.createToolCall(iteration, 2),
          providerToolCallId: "provider-write",
          name: "Write",
          args: { file_path: "should-not-exist.txt", content: "unsafe" },
        },
      ],
    });
  }
}

class FailsThenCompletesModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push({ messages: [...input.messages], tools: [...input.tools] });
    if (this.inputs.length === 1) {
      throw new Error("model unavailable");
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "recovered",
    });
  }
}

class CancelsThenCompletesModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];
  readonly firstStarted: Promise<void>;
  private markFirstStarted!: () => void;

  constructor() {
    super();
    this.firstStarted = new Promise((resolve) => {
      this.markFirstStarted = resolve;
    });
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push({ messages: [...input.messages], tools: [...input.tools] });
    if (this.inputs.length > 1) {
      return testModelOutput(prepared, {
        role: "assistant",
        content: "after cancellation",
      });
    }

    this.markFirstStarted();
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

class RejectsInvariantThenCompletesModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push({ messages: [...input.messages], tools: [...input.tools] });
    if (this.inputs.length > 1) {
      return testModelOutput(prepared, {
        role: "assistant",
        content: "clean recovery",
      });
    }
    if (options.identity === undefined) {
      throw new Error("Expected model request identity.");
    }

    const call = options.identity.runtimeSession.createToolCall(
      options.identity.iteration,
      1,
    );
    return testModelOutput(prepared, {
      role: "assistant",
      content: "invalid transient assistant",
      toolCalls: [
        {
          ...call,
          toolCallNumber: 2,
          providerToolCallId: "invalid-provider-call",
          name: "Read",
          args: { file_path: "README.md" },
        },
      ],
    });
  }
}

class HugeObservationModel extends TestModelClient {
  calls = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.calls += 1;
    if (options.identity === undefined) {
      throw new Error("Expected model request identity.");
    }
    if (this.calls > 1) {
      return testModelOutput(prepared, {
        role: "assistant",
        content: "should not be reached",
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      toolCalls: [
        {
          ...options.identity.runtimeSession.createToolCall(
            options.identity.iteration,
            1,
          ),
          providerToolCallId: "provider-huge-read",
          name: "Read",
          args: { file_path: "huge.txt" },
        },
      ],
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

  test("keeps history protocol-valid after tool execution throws", async () => {
    const sink = collectingEventSink();
    const model = new FailingToolCallModel();
    const input = createInput(model, sink, "tool-failure");
    let ledger: InMemorySessionLedger | undefined;
    const session = await createRuntimeSession(input, {
      idFactory: deterministicIdFactory("tool-failure"),
      loadMcpConfig: async () => undefined,
      createTooling: (options) => {
        const tooling = createDefaultTooling(options);
        tooling.runtime.execute = async () => {
          throw new Error("tool transport broke");
        };
        return tooling;
      },
      createLedger: (store, idFactory) => {
        ledger = new InMemorySessionLedger({
          sessionId: store.sessionId,
          idFactory,
          initialView: store.loadProtocolView(),
          committer: store,
        });
        return ledger;
      },
    });

    const failed = await session.executeTurn({
      userPrompt: "use tools",
      signal: new AbortController().signal,
    });
    const failedMessages = requireLedger(ledger).buildCommittedModelRequest([]).request
      .messages;
    const recovered = await session.executeTurn({
      userPrompt: "continue",
      signal: new AbortController().signal,
    });
    await session.dispose({ type: "oneshot_complete" });

    expect(failed.status).toBe("failed");
    expect(recovered.status).toBe("completed");
    const failedToolMessages = failedMessages.filter(
      (message) => message.role === "tool",
    );
    expect(failedToolMessages).toHaveLength(2);
    expect(failedToolMessages[0]?.content).toContain(
      "Tool execution failed: tool transport broke",
    );
    expect(failedToolMessages[1]?.content).toContain("skipped");
    expect(() => toOpenAIChatMessages(failedMessages)).not.toThrow();
    expect(model.inputs[1]?.messages).toEqual([
      ...failedMessages,
      { role: "user", content: "continue" },
    ]);
  });

  test("faults without executing a second tool when ledger completion commit fails", async () => {
    const sink = collectingEventSink();
    const model = new FailingToolCallModel();
    let toolExecutions = 0;
    const session = await createRuntimeSession(
      createInput(model, sink, "completion-write-failure"),
      {
        idFactory: deterministicIdFactory("completion-write-failure"),
        loadMcpConfig: async () => undefined,
        createLedger: (store, idFactory) =>
          new InMemorySessionLedger({
            sessionId: store.sessionId,
            idFactory,
            initialView: store.loadProtocolView(),
            committer: {
              commit(mutation) {
                if (mutation.kind === "commit_tool_completions") {
                  throw new Error("simulated sqlite write failure");
                }
                store.commit(mutation);
              },
            },
          }),
        createTooling: (options) => {
          const tooling = createDefaultTooling(options);
          tooling.runtime.execute = async (call) => {
            toolExecutions += 1;
            return {
              kind: "generic",
              ok: false,
              toolName: call.name,
              error: "fixture",
            };
          };
          return tooling;
        },
      },
    );

    const error = await session
      .executeTurn({
        userPrompt: "use tools",
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("commit failed");
    expect(toolExecutions).toBe(1);
    expect(() =>
      session.executeTurn({
        userPrompt: "after fault",
        signal: new AbortController().signal,
      }),
    ).toThrow("faulted");
    await session
      .dispose({ type: "runner_failed", error: "expected test fault" })
      .catch(() => undefined);
  });

  test("persists a terminal failed turn before faulting on required Recall storage", async () => {
    const sink = collectingEventSink();
    let store: SessionStore | undefined;
    const executedTools: string[] = [];
    const session = await createRuntimeSession(
      createInput(new FatalRecallModel(), sink, "fatal-recall"),
      {
        idFactory: deterministicIdFactory("fatal-recall"),
        loadMcpConfig: async () => undefined,
        createLedger: (openedStore, idFactory) => {
          store = openedStore;
          return new SqliteSessionLedger(openedStore, idFactory);
        },
        createTooling: (options) => {
          const fatalReader: SessionHistoryReader = {
            sessionId: options.runtimeSession.sessionId,
            search() {
              throw new SessionError(
                "SESSION_READ_FAILED",
                "recall_search",
                "simulated history I/O failure",
              );
            },
            get() {
              throw new Error("Unexpected Recall get.");
            },
          };
          const tooling = createDefaultTooling({
            ...options,
            historyReader: fatalReader,
          });
          const execute = tooling.runtime.execute.bind(tooling.runtime);
          tooling.runtime.execute = async (call, context) => {
            executedTools.push(call.name);
            return execute(call, context);
          };
          return tooling;
        },
      },
    );

    const error = await session
      .executeTurn({
        userPrompt: "recall then write",
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FatalAgentTurnError);
    expect(executedTools).toEqual(["Recall"]);
    expect(() =>
      session.executeTurn({
        userPrompt: "after fault",
        signal: new AbortController().signal,
      }),
    ).toThrow("faulted");

    const database = new Database(requireStore(store).databasePath, { readonly: true });
    expect(database.query("SELECT status FROM turns").get()).toEqual({
      status: "failed",
    });
    expect(database.query("SELECT outcome FROM iterations").get()).toEqual({
      outcome: "failed",
    });
    expect(
      database
        .query(
          `SELECT tr.synthetic_reason
           FROM tool_results tr
           JOIN messages m ON m.message_id = tr.tool_message_id
           ORDER BY m.ordinal`,
        )
        .all(),
    ).toEqual([
      { synthetic_reason: "failed_active" },
      { synthetic_reason: "skipped_after_failure" },
    ]);
    database.close();
    expect(sink.events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
    await session
      .dispose({ type: "runner_failed", error: "expected fatal Recall failure" })
      .catch(() => undefined);
  });

  test("commits user-only deltas after structured model failure", async () => {
    const sink = collectingEventSink();
    const model = new FailsThenCompletesModel();
    const session = await createTestSession(model, sink, "model-failure");

    const failed = await session.executeTurn({
      userPrompt: "first failed prompt",
      signal: new AbortController().signal,
    });
    const recovered = await session.executeTurn({
      userPrompt: "continue",
      signal: new AbortController().signal,
    });
    await session.dispose({ type: "oneshot_complete" });

    expect(failed).toMatchObject({ status: "failed", error: "model unavailable" });
    expect(recovered.status).toBe("completed");
    expect(model.inputs[1]?.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "first failed prompt" },
      { role: "user", content: "continue" },
    ]);
  });

  test("commits user-only deltas after cancellation", async () => {
    const sink = collectingEventSink();
    const model = new CancelsThenCompletesModel();
    const session = await createTestSession(model, sink, "model-cancelled");
    const controller = new AbortController();

    const pending = session.executeTurn({
      userPrompt: "cancel this",
      signal: controller.signal,
    });
    await model.firstStarted;
    controller.abort();
    const cancelled = await pending;
    const recovered = await session.executeTurn({
      userPrompt: "continue",
      signal: new AbortController().signal,
    });
    await session.dispose({ type: "oneshot_complete" });

    expect(cancelled.status).toBe("cancelled");
    expect(recovered.status).toBe("completed");
    expect(model.inputs[1]?.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "cancel this" },
      { role: "user", content: "continue" },
    ]);
  });

  test("keeps the accepted user fact after an invalid assistant candidate", async () => {
    const sink = collectingEventSink();
    const model = new RejectsInvariantThenCompletesModel();
    let ledger: InMemorySessionLedger | undefined;
    const session = await createRuntimeSession(
      createInput(model, sink, "unexpected-reject"),
      {
        idFactory: deterministicIdFactory("unexpected-reject"),
        loadMcpConfig: async () => undefined,
        createLedger: (store, idFactory) => {
          ledger = new InMemorySessionLedger({
            sessionId: store.sessionId,
            idFactory,
            initialView: store.loadProtocolView(),
            committer: store,
          });
          return ledger;
        },
      },
    );

    const invalid = await session.executeTurn({
      userPrompt: "bad turn",
      signal: new AbortController().signal,
    });
    expect(invalid).toMatchObject({ status: "failed" });
    expect(invalid.status === "failed" ? invalid.error : "").toContain(
      "invalid frame identity",
    );
    expect(
      requireLedger(ledger).buildCommittedModelRequest([]).request.messages,
    ).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "bad turn" },
    ]);

    const recovered = await session.executeTurn({
      userPrompt: "clean turn",
      signal: new AbortController().signal,
    });
    await session.dispose({ type: "oneshot_complete" });

    expect(recovered.status).toBe("completed");
    expect(model.inputs[1]?.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "bad turn" },
      { role: "user", content: "clean turn" },
    ]);
    expect(sink.events.some((event) => event.type === "turn.failed")).toBe(true);
  });

  test("keeps canonical facts and faults the session when a terminal sink fails", async () => {
    const events = collectingEventSink();
    let ledger: InMemorySessionLedger | undefined;
    const session = await createRuntimeSession(
      createInput(new CapturingModel(), events, "terminal-sink-failure"),
      {
        idFactory: deterministicIdFactory("terminal-sink-failure"),
        loadMcpConfig: async () => undefined,
        createLedger: (store, idFactory) => {
          ledger = new InMemorySessionLedger({
            sessionId: store.sessionId,
            idFactory,
            initialView: store.loadProtocolView(),
            committer: store,
          });
          return ledger;
        },
        createEventSink: () => ({
          name: "terminal-failure",
          async append(event) {
            await events.append(event);
            if (event.type === "turn.finished") {
              throw new Error("terminal storage unavailable");
            }
          },
        }),
      },
    );

    const error = await session
      .executeTurn({
        userPrompt: "do not commit",
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeEventAppendError);
    expect(
      materializeAgentMessages(
        requireLedger(ledger).snapshot({ allowFaulted: true }).messages,
      ),
    ).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "do not commit" },
      { role: "assistant", content: "answer-1" },
    ]);
    expect(() =>
      session.executeTurn({
        userPrompt: "after fault",
        signal: new AbortController().signal,
      }),
    ).toThrow("faulted");
    const disposeError = await session
      .dispose({ type: "runner_failed", error: "sink failed" })
      .catch((caught: unknown) => caught);
    expect(disposeError).toBeInstanceOf(RuntimeEventAppendError);
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

  test("rejects an oversized prompt before allocating a turn or calling provider", async () => {
    const sink = collectingEventSink();
    const model = new CapturingModel();
    const session = await createTestSession(model, sink, "admission-budget");

    let caught: unknown;
    try {
      await session.executeTurn({
        userPrompt: "x".repeat(1_000_000),
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

  test("keeps tool protocol delta when the next iteration is blocked", async () => {
    const sink = collectingEventSink();
    const model = new HugeObservationModel();
    let ledger: InMemorySessionLedger | undefined;
    const session = await createRuntimeSession(
      createInput(model, sink, "tool-budget"),
      {
        idFactory: deterministicIdFactory("tool-budget"),
        loadMcpConfig: async () => undefined,
        createLedger: (store, idFactory) => {
          ledger = new InMemorySessionLedger({
            sessionId: store.sessionId,
            idFactory,
            initialView: store.loadProtocolView(),
            committer: store,
          });
          return ledger;
        },
        createTooling: (options) => {
          const tooling = createDefaultTooling(options);
          tooling.runtime.execute = async () => ({
            kind: "read",
            ok: true,
            filePath: "huge.txt",
            content: "x".repeat(1_000_000),
            sha256: "0".repeat(64),
            sizeBytes: 1_000_000,
            totalLines: 1,
            startLine: 1,
            endLine: 1,
          });
          return tooling;
        },
      },
    );

    const result = await session.executeTurn({
      userPrompt: "read the huge fixture",
      signal: new AbortController().signal,
    });
    await session.dispose({ type: "oneshot_complete" });

    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.error : "").toContain(
      "Model request blocked before provider call",
    );
    expect(model.calls).toBe(1);
    expect(
      sink.events.filter((event) => event.type === "model.request.started"),
    ).toHaveLength(1);
    expect(
      materializeAgentMessages(requireLedger(ledger).snapshot().messages).filter(
        (message) => message.role === "tool",
      ),
    ).toHaveLength(1);
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
      "compactContext",
      "dispose",
    ];
    expect(runnerApiKeys).toHaveLength(4);
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

function requireLedger(
  ledger: InMemorySessionLedger | undefined,
): InMemorySessionLedger {
  if (ledger === undefined) {
    throw new Error("Expected an in-memory ledger fixture.");
  }
  return ledger;
}

function requireStore(store: SessionStore | undefined): SessionStore {
  if (store === undefined) {
    throw new Error("Expected a SessionStore fixture.");
  }
  return store;
}

function createInput(
  model: ModelClient,
  sink: EventSink,
  prefix: string,
): CreateRuntimeSessionInput {
  return {
    selection: {
      mode: "new",
      sessionId: `${prefix}-${crypto.randomUUID()}` as SessionId,
    },
    workspaceRoot: mkdtempSync(path.join(os.tmpdir(), "tinker-runtime-test-")),
    modelName: "test-model",
    maxIterations: 2,
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    systemPrompt: "system",
    modelClient: model,
    presentationSinks: [sink],
    persistence: false,
  };
}
