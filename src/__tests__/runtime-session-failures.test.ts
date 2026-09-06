import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FatalAgentTurnError } from "../agent/loop";
import {
  createRuntimeSession,
  RuntimeEventAppendError,
} from "../agent/runtime-session";
import { InMemorySessionLedger } from "../agent/session-ledger";
import { toolResultDisplayText } from "../agent/tool-result-content";
import { cancellationError } from "../agent/turn-cancellation";
import { materializeAgentMessages } from "../context/protocol-frame";
import type { EventSink } from "../events/event-sink";
import type {
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { toOpenAIChatMessages } from "../model/openai-chat-mapping";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import { SessionError } from "../session/session-errors";
import type { SessionHistoryReader } from "../session/session-history-reader";
import { resolveSessionDatabasePath, SessionStore } from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import { createDefaultTooling } from "../tools/registry";
import {
  CapturingModel,
  createInput,
  createTestSession,
} from "./helpers/runtime-session-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";
import {
  collectingEventSink,
  deterministicIdFactory,
  TEST_CONTEXT_BUDGET,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

isolateTinkerHome();

class DeltaEmittingModel extends TestModelClient {
  sawDeltaCallback = false;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.sawDeltaCallback = options.onTextDelta !== undefined;
    options.onTextDelta?.("## First\nbody\n\n## Second\n");
    options.onTextDelta?.("tail");
    return testModelOutput(prepared, {
      role: "assistant",
      content: "## First\nbody\n\n## Second\ntail",
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
          name: "RecallSearch",
          args: { query: "history" },
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

function sseResponse(events: readonly unknown[]): Response {
  return new Response(
    [
      ...events.map((event) => `data: ${JSON.stringify(event)}`),
      "data: [DONE]",
      "",
    ].join("\n\n"),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function streamChunk(delta: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

function streamFinish(finishReason: string): Record<string, unknown> {
  return {
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
}

function streamUsage(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [],
    usage,
  };
}

describe("RuntimeSession failure boundaries", () => {
  test("keeps history protocol-valid after tool execution throws", async () => {
    const sink = collectingEventSink();
    const model = new FailingToolCallModel();
    const input = {
      ...createInput(model, sink, "tool-failure"),
      enableProviderRetryPrompt: true,
    };
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
          initialSnapshot: store.loadContextSnapshot(),
          committer: store,
        });
        return ledger;
      },
    });

    const failed = await session.executeTurn({
      userMessage: { role: "user", content: "use tools" },
      signal: new AbortController().signal,
    });
    const failedMessages = materializeAgentMessages(
      requireLedger(ledger).snapshot().messages,
    );
    const recovered = await session.executeTurn({
      userMessage: { role: "user", content: "continue" },
      signal: new AbortController().signal,
    });
    await session.dispose({ type: "oneshot_complete" });

    expect(failed.status).toBe("failed");
    expect(sink.events.some((event) => event.type === "model.retry.requested")).toBe(
      false,
    );
    expect(recovered.status).toBe("completed");
    const failedToolMessages = failedMessages.filter(
      (message) => message.role === "tool",
    );
    expect(failedToolMessages).toHaveLength(2);
    expect(toolResultDisplayText(failedToolMessages[0].content)).toContain(
      "Tool execution failed: tool transport broke",
    );
    expect(toolResultDisplayText(failedToolMessages[1].content)).toContain("skipped");
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
            initialSnapshot: store.loadContextSnapshot(),
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
        userMessage: { role: "user", content: "use tools" },
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("commit failed");
    expect(toolExecutions).toBe(1);
    expect(() =>
      session.executeTurn({
        userMessage: { role: "user", content: "after fault" },
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
              throw new Error("Unexpected RecallGet.");
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
        userMessage: { role: "user", content: "recall then write" },
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FatalAgentTurnError);
    expect(executedTools).toEqual(["RecallSearch"]);
    expect(() =>
      session.executeTurn({
        userMessage: { role: "user", content: "after fault" },
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
      userMessage: { role: "user", content: "first failed prompt" },
      signal: new AbortController().signal,
    });
    const recovered = await session.executeTurn({
      userMessage: { role: "user", content: "continue" },
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

  test("persists a redacted reasoning-only attempt and only the retry assistant", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-reasoning-retry-runtime-"),
    );
    const eventLogPath = path.join(workspace, "events.jsonl");
    const observationLogPath = path.join(workspace, "observations.md");
    const requestBodies: string[] = [];
    let dispatchCount = 0;
    const secretReasoning = "secret provider reasoning";
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      dispatchCount += 1;
      if (typeof init?.body !== "string") {
        throw new Error("Expected a serialized OpenAI request body.");
      }
      requestBodies.push(init.body);
      if (dispatchCount === 1) {
        return sseResponse([
          streamChunk({ role: "assistant", reasoning_content: secretReasoning }),
          streamFinish("stop"),
          streamUsage({
            prompt_tokens: 7,
            completion_tokens: 3,
            total_tokens: 10,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 7,
            completion_tokens_details: { reasoning_tokens: 3 },
          }),
        ]);
      }
      return sseResponse([
        streamChunk({ role: "assistant", content: "retry answer" }),
        streamFinish("stop"),
        streamUsage({
          prompt_tokens: 7,
          completion_tokens: 2,
          total_tokens: 9,
          prompt_cache_hit_tokens: 7,
          prompt_cache_miss_tokens: 0,
        }),
      ]);
    }) as typeof fetch;
    const model = new OpenAIChatModelClient({
      apiKey: "test-key",
      model: "test-model",
      contextBudget: TEST_CONTEXT_BUDGET,
      fetch: fetchImpl,
    });
    const sink = collectingEventSink();
    const input = createInput(model, sink, "reasoning-retry-runtime");
    input.workspaceRoot = workspace;
    input.persistence = { eventLogPath, observationLogPath };
    const sessionId = input.selection.sessionId;
    const session = await createRuntimeSession(input, {
      idFactory: deterministicIdFactory("reasoning-retry-runtime"),
      loadMcpConfig: async () => undefined,
    });

    try {
      const result = await session.executeTurn({
        userMessage: { role: "user", content: "hello" },
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({
        status: "completed",
        finalText: "retry answer",
      });
      await session.dispose({ type: "oneshot_complete" });

      expect(dispatchCount).toBe(2);
      expect(requestBodies[1]).toBe(requestBodies[0]);
      const serializedEvents = await readFile(eventLogPath, "utf8");
      const events = serializedEvents
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        events
          .filter((event) => String(event.type).startsWith("model.request."))
          .map((event) => event.type),
      ).toEqual([
        "model.request.started",
        "model.request.failed",
        "model.request.started",
        "model.request.finished",
      ]);
      const failed = events.find((event) => event.type === "model.request.failed") as
        | { data?: Record<string, unknown> }
        | undefined;
      expect(failed?.data).toMatchObject({
        attemptNumber: 1,
        maxAttempts: 6,
        code: "reasoning_only_assistant",
        retryDisposition: "scheduled",
        diagnostics: {
          finishReason: "stop",
          contentChars: 0,
          reasoningChars: secretReasoning.length,
          toolCallCount: 0,
          usage: {
            promptTokens: 7,
            completionTokens: 3,
            totalTokens: 10,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 7,
            reasoningTokens: 3,
          },
        },
      });
      expect(serializedEvents).not.toContain(secretReasoning);

      const observations = await readFile(observationLogPath, "utf8");
      expect(observations).toContain("retry answer");
      expect(observations).not.toContain("reasoning-only");
      expect(observations).not.toContain(secretReasoning);

      const database = new Database(
        await resolveSessionDatabasePath(workspace, sessionId),
        { readonly: true },
      );
      expect(
        database
          .query(
            "SELECT role, content, reasoning_content FROM messages ORDER BY ordinal",
          )
          .all(),
      ).toEqual([
        { role: "system", content: "system", reasoning_content: null },
        { role: "user", content: "hello", reasoning_content: null },
        {
          role: "assistant",
          content: "retry answer",
          reasoning_content: null,
        },
      ]);
      database.close();
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("fails one turn after two provider-mapped reasoning-only responses", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-reasoning-exhausted-runtime-"),
    );
    let dispatchCount = 0;
    const fetchImpl: typeof fetch = Object.assign(
      async () => {
        dispatchCount += 1;
        return sseResponse([
          streamChunk({
            role: "assistant",
            reasoning_content: "private reasoning",
          }),
          streamFinish("stop"),
          streamUsage({
            prompt_tokens: 7,
            completion_tokens: 3,
            total_tokens: 10,
            completion_tokens_details: { reasoning_tokens: 3 },
          }),
        ]);
      },
      { preconnect() {} },
    );
    const model = new OpenAIChatModelClient({
      apiKey: "test-key",
      model: "test-model",
      contextBudget: TEST_CONTEXT_BUDGET,
      fetch: fetchImpl,
    });
    const sink = collectingEventSink();
    const input = createInput(model, sink, "reasoning-exhausted-runtime");
    input.workspaceRoot = workspace;
    const sessionId = input.selection.sessionId;
    const session = await createRuntimeSession(input, {
      idFactory: deterministicIdFactory("reasoning-exhausted-runtime"),
      loadMcpConfig: async () => undefined,
    });

    try {
      const result = await session.executeTurn({
        userMessage: { role: "user", content: "hello" },
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({
        status: "failed",
        error:
          "Provider returned reasoning without final text or tool calls in both attempts (provider=openai-compatible, model=test-model).",
      });
      expect(dispatchCount).toBe(2);
      expect(
        sink.events
          .filter((event) => event.type.startsWith("model.request."))
          .map((event) => event.type),
      ).toEqual([
        "model.request.started",
        "model.request.failed",
        "model.request.started",
        "model.request.failed",
      ]);
      expect(
        sink.events
          .filter((event) => event.type === "model.request.failed")
          .map((event) => event.data.retryDisposition),
      ).toEqual(["scheduled", "exhausted"]);
      expect(sink.events.at(-1)).toMatchObject({
        type: "turn.failed",
        data: { error: result.status === "failed" ? result.error : "" },
      });

      await session.dispose({ type: "oneshot_complete" });
      const database = new Database(
        await resolveSessionDatabasePath(workspace, sessionId),
        { readonly: true },
      );
      expect(
        database.query("SELECT role, content FROM messages ORDER BY ordinal").all(),
      ).toEqual([
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ]);
      database.close();
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("commits user-only deltas after cancellation", async () => {
    const sink = collectingEventSink();
    const model = new CancelsThenCompletesModel();
    const session = await createTestSession(model, sink, "model-cancelled");
    const controller = new AbortController();

    const pending = session.executeTurn({
      userMessage: { role: "user", content: "cancel this" },
      signal: controller.signal,
    });
    await model.firstStarted;
    controller.abort();
    const cancelled = await pending;
    const recovered = await session.executeTurn({
      userMessage: { role: "user", content: "continue" },
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
            initialSnapshot: store.loadContextSnapshot(),
            committer: store,
          });
          return ledger;
        },
      },
    );

    const invalid = await session.executeTurn({
      userMessage: { role: "user", content: "bad turn" },
      signal: new AbortController().signal,
    });
    expect(invalid).toMatchObject({ status: "failed" });
    expect(invalid.status === "failed" ? invalid.error : "").toContain(
      "invalid frame identity",
    );
    expect(materializeAgentMessages(requireLedger(ledger).snapshot().messages)).toEqual(
      [
        { role: "system", content: "system" },
        { role: "user", content: "bad turn" },
      ],
    );

    const recovered = await session.executeTurn({
      userMessage: { role: "user", content: "clean turn" },
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
            initialSnapshot: store.loadContextSnapshot(),
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
        userMessage: { role: "user", content: "do not commit" },
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
        userMessage: { role: "user", content: "after fault" },
        signal: new AbortController().signal,
      }),
    ).toThrow("faulted");
    const disposeError = await session
      .dispose({ type: "runner_failed", error: "sink failed" })
      .catch((caught: unknown) => caught);
    expect(disposeError).toBeInstanceOf(RuntimeEventAppendError);
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
            initialSnapshot: store.loadContextSnapshot(),
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
      userMessage: { role: "user", content: "read the huge fixture" },
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
      userMessage: { role: "user", content: "continue" },
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

  test("isolates and disables a failed assistant text delta sink", async () => {
    const events = collectingEventSink();
    const model = new DeltaEmittingModel();
    let updateCount = 0;
    const input = createInput(model, events, "assistant-delta-failure");
    input.assistantTextDeltaSink = {
      updateAssistantTextDelta() {
        updateCount += 1;
        throw new Error("render failed");
      },
    };
    const session = await createRuntimeSession(input, {
      idFactory: deterministicIdFactory("assistant-delta-failure"),
      loadMcpConfig: async () => undefined,
    });

    const result = await session.executeTurn({
      userMessage: { role: "user", content: "continue" },
      signal: new AbortController().signal,
    });
    await session.dispose({ type: "oneshot_complete" });

    expect(result).toMatchObject({
      status: "completed",
      finalText: "## First\nbody\n\n## Second\ntail",
    });
    expect(model.sawDeltaCallback).toBe(true);
    expect(updateCount).toBe(1);
    expect(events.events.every((event) => !event.type.includes("delta"))).toBe(true);
  });

  test("does not install a text delta callback without a presentation sink", async () => {
    const model = new DeltaEmittingModel();
    const session = await createTestSession(
      model,
      collectingEventSink(),
      "assistant-delta-absent",
    );

    const result = await session.executeTurn({
      userMessage: { role: "user", content: "continue" },
      signal: new AbortController().signal,
    });
    await session.dispose({ type: "oneshot_complete" });

    expect(result.status).toBe("completed");
    expect(model.sawDeltaCallback).toBe(false);
  });
});
