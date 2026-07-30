import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
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
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import { runtimeIdFactory, type SessionId } from "../ids/runtime-id";
import { SessionError } from "../session/session-errors";
import type { SessionHistoryReader } from "../session/session-history-reader";
import { SessionStore } from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import { createDefaultTooling } from "../tools/registry";
import { DEFAULT_PUBLIC_TOOLING_CONFIG } from "../cli/public-config-contract";
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

class DangerousConfirmationModel extends TestModelClient {
  private requestCount = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    if (this.requestCount === 1) {
      if (options.identity === undefined) {
        throw new Error("Expected runtime identity for Bash confirmation.");
      }
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...options.identity.runtimeSession.createToolCall(
              options.identity.iteration,
              1,
            ),
            providerToolCallId: "provider-dangerous",
            name: "Bash",
            args: { command: "reboot" },
          },
        ],
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "used a safer approach",
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
  test("pauses TUI Bash execution for a decision and audits the denial", async () => {
    const sink = collectingEventSink();
    const input = {
      ...createInput(new DangerousConfirmationModel(), sink, "bash-confirm"),
      bashGuard: {
        mode: "guard" as const,
        source: "default" as const,
        surface: "tui" as const,
      },
    };
    const session = await createRuntimeSession(input, {
      idFactory: deterministicIdFactory("bash-confirm"),
      loadMcpConfig: async () => undefined,
    });
    let markPending: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      markPending = resolve;
    });
    const unsubscribe = session.subscribeBashGuard(() => {
      if (session.bashGuard().pending !== undefined) {
        markPending?.();
      }
    });

    try {
      const completion = session.executeTurn({
        userMessage: { role: "user", content: "do it" },
        signal: new AbortController().signal,
      });
      await pending;
      expect(session.bashGuard()).toMatchObject({
        mode: "guard",
        pending: {
          command: "reboot",
          reason: "system power command reboot",
        },
      });

      await session.resolveBashConfirmation("deny");
      expect(await completion).toMatchObject({
        status: "completed",
        finalText: "used a safer approach",
      });
      expect(
        sink.events
          .filter((event) => event.type.startsWith("tool.confirmation."))
          .map((event) => ({
            type: event.type,
            decision:
              event.type === "tool.confirmation.resolved"
                ? event.data.decision
                : undefined,
          })),
      ).toEqual([
        { type: "tool.confirmation.requested", decision: undefined },
        { type: "tool.confirmation.resolved", decision: "deny" },
      ]);
    } finally {
      unsubscribe();
      await session.dispose({ type: "oneshot_complete" });
      await rm(input.workspaceRoot, { recursive: true });
    }
  });

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
        userMessage: { role: "user", content: "recall then write" },
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FatalAgentTurnError);
    expect(executedTools).toEqual(["Recall"]);
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
        maxAttempts: 2,
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
        path.join(workspace, ".tinker", "sessions", sessionId, "session.sqlite"),
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
        path.join(workspace, ".tinker", "sessions", sessionId, "session.sqlite"),
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
    } finally {
      controller.abort();
      await turn;
      await session.dispose({ type: "tui_exit" });
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
    } finally {
      await session.dispose({ type: "tui_exit" });
    }
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
