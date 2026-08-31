import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FatalAgentTurnError, runAgent } from "../agent/loop";
import type { AssistantTextDeltaUpdate } from "../agent/assistant-text-delta";
import type { RuntimeSessionContext } from "../agent/runtime-session";
import { InMemorySessionLedger } from "../agent/session-ledger";
import { toolResultDisplayText } from "../agent/tool-result-content";
import { TurnCancelledError } from "../agent/turn-cancellation";
import type { AgentMessage } from "../agent/types";
import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import type {
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { ProviderResponseError } from "../model/model-client";
import { ObservationBuilder } from "../observation/observation-builder";
import { SessionError } from "../session/session-errors";
import {
  RecallHistoryError,
  type SessionHistoryReader,
} from "../session/session-history-reader";
import { createRecallSearchToolExecutor } from "../tools/recall";
import { createDefaultTooling } from "../tools/registry";
import { ToolRegistry, ToolRuntime } from "../tools/registry";
import type { ToolExecutor } from "../tools/types";
import {
  createTestContextMeter,
  createTestHistoryReader,
  createTestRuntime,
  deterministicIdFactory,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

class ScriptedModel extends TestModelClient {
  calls = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.calls += 1;

    if (this.calls === 1) {
      return testModelOutput(prepared, {
        role: "assistant",
        content: "I will read README first.",
        toolCalls: [
          {
            ...requireRuntime(options).createToolCall(requireIteration(options), 1),
            providerToolCallId: "provider-call-1",
            name: "Read",
            args: { file_path: "README.md" },
          },
        ],
      });
    }

    const toolMessage = input.messages.at(-1) as AgentMessage;
    expect(toolMessage.role).toBe("tool");
    if (toolMessage.role !== "tool") {
      throw new Error("Expected a tool result message.");
    }
    expect(toolResultDisplayText(toolMessage.content)).toContain("Read succeeded");

    return testModelOutput(prepared, {
      role: "assistant",
      content: "README was read.",
    });
  }
}

class CapturingModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push({
      ...input,
      messages: [...input.messages],
      tools: [...input.tools],
    });

    return testModelOutput(prepared, {
      role: "assistant",
      content: "Second prompt answered.",
    });
  }
}

class TwoToolModel extends TestModelClient {
  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const runtime = requireRuntime(options);
    const iteration = requireIteration(options);
    return testModelOutput(prepared, {
      role: "assistant",
      toolCalls: [
        {
          ...runtime.createToolCall(iteration, 1),
          providerToolCallId: "provider-first",
          name: "First",
          args: {},
        },
        {
          ...runtime.createToolCall(iteration, 2),
          providerToolCallId: "provider-second",
          name: "Second",
          args: {},
        },
      ],
    });
  }
}

class RecallBatchModel extends TestModelClient {
  private calls = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.calls += 1;
    if (this.calls > 1) {
      return testModelOutput(prepared, {
        role: "assistant",
        content: "batch complete",
      });
    }
    const runtime = requireRuntime(options);
    const iteration = requireIteration(options);
    return testModelOutput(prepared, {
      role: "assistant",
      toolCalls: [
        {
          ...runtime.createToolCall(iteration, 1),
          providerToolCallId: "provider-recall",
          name: "RecallSearch",
          args: { query: "history" },
        },
        {
          ...runtime.createToolCall(iteration, 2),
          providerToolCallId: "provider-second",
          name: "Second",
          args: {},
        },
      ],
    });
  }
}

class ArrayEventSink implements EventSink {
  readonly events: AgentEvent[] = [];

  async append(event: AgentEvent): Promise<void> {
    this.events.push(event);
  }
}

class RetryScriptModel extends TestModelClient {
  readonly preparedRequests: PreparedModelRequest[] = [];
  readonly identities: ModelRequestOptions["identity"][] = [];

  constructor(
    private readonly steps: readonly ("reasoning_only" | "success" | Error)[],
  ) {
    super();
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.preparedRequests.push(prepared);
    this.identities.push(options.identity);
    options.onTextDelta?.(`attempt-${this.preparedRequests.length}`);
    const step = this.steps[this.preparedRequests.length - 1];
    if (step === undefined) {
      throw new Error("Unexpected provider dispatch.");
    }
    if (step instanceof Error) {
      throw step;
    }
    if (step === "reasoning_only") {
      throw reasoningOnlyError(prepared);
    }
    return testModelOutput(
      prepared,
      { role: "assistant", content: "retry succeeded" },
      "stop",
    );
  }
}

class RetryThenWaitingModel extends TestModelClient {
  calls = 0;
  readonly secondStarted: Promise<void>;
  private markSecondStarted!: () => void;

  constructor() {
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
      throw reasoningOnlyError(prepared);
    }
    this.markSecondStarted();
    return await new Promise<ModelRequestOutput>((_resolve, reject) => {
      const onAbort = () => reject(new Error("Second model attempt was aborted."));
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

class LateDeltaModel extends TestModelClient {
  readonly lateDelivered: Promise<void>;
  private markLateDelivered!: () => void;

  constructor() {
    super();
    this.lateDelivered = new Promise((resolve) => {
      this.markLateDelivered = resolve;
    });
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    options.onTextDelta?.("before-settle");
    setTimeout(() => {
      options.onTextDelta?.("after-settle");
      this.markLateDelivered();
    }, 0);
    return testModelOutput(prepared, {
      role: "assistant",
      content: "before-settle",
    });
  }
}

describe("runAgent", () => {
  test("runs assistant tool call observation final-answer loop", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-agent-"));

    try {
      await writeFile(path.join(workspace, "README.md"), "# Tinker\n", "utf8");

      const events = new ArrayEventSink();
      const identity = createTestRuntime(events);
      const runtimeSession = identity.runtimeSession;
      const turn = identity.turn;
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        runtimeSession,
        historyReader: createTestHistoryReader(runtimeSession.sessionId),
      });
      const ledger = new InMemorySessionLedger({
        sessionId: runtimeSession.sessionId,
        systemPrompt: "system",
        idFactory: deterministicIdFactory("agent-loop"),
        initialToolDefinitions: tooling.registry.definitions(),
      });
      const pendingTurn = ledger.beginTurn({
        turn,
        userMessage: { role: "user", content: "Read README.md" },
      });
      const result = await runAgent({
        ledger: pendingTurn.agent,
        maxIterations: 4,
        model: new ScriptedModel(),
        contextMeter: createTestContextMeter(),
        tools: tooling.registry,
        toolRuntime: tooling.runtime,
        observationBuilder: new ObservationBuilder(),
        runtimeSession,
        turn,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe("completed");
      expect(result.status === "completed" ? result.finalText : "").toBe(
        "README was read.",
      );
      const progressEvent = events.events.find(
        (event) => event.type === "assistant.progress",
      );
      expect(progressEvent).toMatchObject({
        type: "assistant.progress",
        data: { content: "I will read README first." },
      });
      expect(events.events.map((event) => event.type)).toContain("tool.observation");
      expect(events.events.map((event) => event.type)).toContain(
        "model.request.finished",
      );
      pendingTurn.finish(result);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("continues from initial messages when provided", async () => {
    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    const runtimeSession = identity.runtimeSession;
    const turn = identity.turn;
    const tooling = createDefaultTooling({
      workspaceRoot: process.cwd(),
      runtimeSession,
      historyReader: createTestHistoryReader(runtimeSession.sessionId),
    });
    const model = new CapturingModel();
    const idFactory = deterministicIdFactory("initial-history");
    const ledger = new InMemorySessionLedger({
      sessionId: runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory,
      initialToolDefinitions: tooling.registry.definitions(),
    });
    const previousTurn = {
      sessionId: runtimeSession.sessionId,
      turnId: idFactory.createTurnId(),
      turnNumber: 1,
    };
    const previousIteration = {
      ...previousTurn,
      iterationId: idFactory.createIterationId(),
      iterationNumber: 1,
    };
    const firstTurn = ledger.beginTurn({
      turn: previousTurn,
      userMessage: { role: "user", content: "First prompt" },
    });
    firstTurn.agent.appendAssistant({
      iteration: previousIteration,
      message: { role: "assistant", content: "First prompt answered." },
      provider: "test",
      model: "test-model",
    });
    firstTurn.finish({
      status: "completed",
      finalText: "First prompt answered.",
      lastIteration: previousIteration,
    });
    const initialMessages: AgentMessage[] = ledger.buildCommittedModelRequest(
      tooling.registry.definitions(),
    ).request.messages;
    const secondTurn = ledger.beginTurn({
      turn,
      userMessage: { role: "user", content: "Second prompt" },
    });

    const result = await runAgent({
      ledger: secondTurn.agent,
      maxIterations: 4,
      model,
      contextMeter: createTestContextMeter(),
      tools: tooling.registry,
      toolRuntime: tooling.runtime,
      observationBuilder: new ObservationBuilder(),
      runtimeSession,
      turn,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("completed");
    expect(events.events.map((event) => event.type)).toEqual([
      "agent.iteration.started",
      "context.usage.updated",
      "model.request.started",
      "model.request.finished",
      "context.usage.updated",
      "agent.iteration.finished",
    ]);
    expect(
      events.events
        .filter((event) => event.type === "context.usage.updated")
        .map((event) => event.data.phase),
    ).toEqual(["preflight", "measured"]);
    expect(model.inputs[0]?.messages).toEqual([
      ...initialMessages,
      { role: "user", content: "Second prompt" },
    ]);
    secondTurn.finish(result);
    expect(
      ledger.buildCommittedModelRequest(tooling.registry.definitions()).request
        .messages,
    ).toEqual([
      ...initialMessages,
      { role: "user", content: "Second prompt" },
      { role: "assistant", content: "Second prompt answered." },
    ]);
    expect(result).not.toHaveProperty("messages");
  });

  test("retries one reasoning-only response with the same prepared request", async () => {
    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    let prepareDispatchCalls = 0;
    const textDeltas: AssistantTextDeltaUpdate[] = [];
    const runtimeSession: RuntimeSessionContext = {
      ...identity.runtimeSession,
      updateAssistantTextDelta(update) {
        textDeltas.push(update);
      },
      prepareModelDispatch() {
        prepareDispatchCalls += 1;
      },
    };
    const registry = new ToolRegistry();
    const ledger = new InMemorySessionLedger({
      sessionId: runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("reasoning-retry"),
      initialToolDefinitions: registry.definitions(),
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "hello" },
    });
    const model = new RetryScriptModel(["reasoning_only", "success"]);

    const result = await runAgent({
      ledger: pending.agent,
      maxIterations: 2,
      model,
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession,
      turn: identity.turn,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: "completed", finalText: "retry succeeded" });
    expect(model.preparedRequests).toHaveLength(2);
    expect(model.preparedRequests[1]).toBe(model.preparedRequests[0]);
    expect(model.identities[1]?.iteration).toBe(model.identities[0]?.iteration);
    expect(model.identities[1]?.runtimeSession).toBe(
      model.identities[0]?.runtimeSession,
    );
    expect(prepareDispatchCalls).toBe(1);
    expect(
      textDeltas.map((update) => ({
        attemptNumber: update.attemptNumber,
        content: update.content,
        iterationId: update.iterationId,
      })),
    ).toEqual([
      {
        attemptNumber: 1,
        content: "attempt-1",
        iterationId: identity.iteration.iterationId,
      },
      {
        attemptNumber: 2,
        content: "attempt-2",
        iterationId: identity.iteration.iterationId,
      },
    ]);

    const requestEvents = events.events.filter((event) =>
      event.type.startsWith("model.request."),
    );
    expect(requestEvents.map((event) => event.type)).toEqual([
      "model.request.started",
      "model.request.failed",
      "model.request.started",
      "model.request.finished",
    ]);
    expect(requestEvents.map((event) => event.data)).toMatchObject([
      { attemptNumber: 1, maxAttempts: 6 },
      {
        attemptNumber: 1,
        maxAttempts: 6,
        code: "reasoning_only_assistant",
        retryDisposition: "scheduled",
        provider: "test",
        model: "test-model",
        diagnostics: {
          finishReason: "stop",
          contentChars: 0,
          reasoningChars: 16,
          toolCallCount: 0,
          usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
        },
      },
      { attemptNumber: 2, maxAttempts: 6 },
      { attemptNumber: 2, maxAttempts: 6 },
    ]);
    expect(JSON.stringify(requestEvents)).not.toContain("hidden reasoning");
    expect(
      events.events
        .filter((event) => event.type === "context.usage.updated")
        .map((event) => event.data.phase),
    ).toEqual(["preflight", "measured"]);

    pending.finish(result);
    expect(
      ledger.buildCommittedModelRequest(registry.definitions()).request.messages,
    ).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "retry succeeded" },
    ]);
  });

  test("ignores text deltas delivered after an attempt settles", async () => {
    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    const textDeltas: AssistantTextDeltaUpdate[] = [];
    const runtimeSession: RuntimeSessionContext = {
      ...identity.runtimeSession,
      updateAssistantTextDelta(update) {
        textDeltas.push(update);
      },
    };
    const registry = new ToolRegistry();
    const ledger = new InMemorySessionLedger({
      sessionId: runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("late-text-delta"),
      initialToolDefinitions: registry.definitions(),
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "hello" },
    });
    const model = new LateDeltaModel();

    const result = await runAgent({
      ledger: pending.agent,
      maxIterations: 2,
      model,
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession,
      turn: identity.turn,
      signal: new AbortController().signal,
    });
    await model.lateDelivered;

    expect(result.status).toBe("completed");
    expect(textDeltas.map((update) => update.content)).toEqual(["before-settle"]);
    pending.finish(result);
  });

  test("exhausts two reasoning-only attempts without committing an assistant", async () => {
    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    const registry = new ToolRegistry();
    const ledger = new InMemorySessionLedger({
      sessionId: identity.runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("reasoning-exhausted"),
      initialToolDefinitions: registry.definitions(),
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "hello" },
    });
    const model = new RetryScriptModel(["reasoning_only", "reasoning_only"]);

    const result = await runAgent({
      ledger: pending.agent,
      maxIterations: 2,
      model,
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: identity.runtimeSession,
      turn: identity.turn,
      signal: new AbortController().signal,
    });

    expect(model.preparedRequests).toHaveLength(2);
    expect(result).toEqual({
      status: "failed",
      error:
        "Provider returned reasoning without final text or tool calls in both attempts (provider=test, model=test-model).",
      lastIteration: identity.iteration,
    });
    expect(
      events.events
        .filter((event) => event.type === "model.request.failed")
        .map((event) => event.data.retryDisposition),
    ).toEqual(["scheduled", "exhausted"]);
    expect(pending.projectedMessageCount()).toBe(2);
    expect(
      pending.agent.buildModelRequest(registry.definitions()).request.messages,
    ).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ]);
  });

  test("does not retry an ordinary provider failure after reasoning-only", async () => {
    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    const registry = new ToolRegistry();
    const ledger = new InMemorySessionLedger({
      sessionId: identity.runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("reasoning-then-error"),
      initialToolDefinitions: registry.definitions(),
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "hello" },
    });
    const model = new RetryScriptModel([
      "reasoning_only",
      new Error("provider transport failed"),
    ]);

    const result = await runAgent({
      ledger: pending.agent,
      maxIterations: 2,
      model,
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: identity.runtimeSession,
      turn: identity.turn,
      signal: new AbortController().signal,
    });

    expect(model.preparedRequests).toHaveLength(2);
    expect(result).toMatchObject({
      status: "failed",
      error: "provider transport failed",
    });
    expect(
      events.events
        .filter((event) => event.type === "model.request.failed")
        .map((event) => [event.data.code, event.data.retryDisposition]),
    ).toEqual([
      ["reasoning_only_assistant", "scheduled"],
      ["provider_request_error", "not_retryable"],
    ]);
  });

  test("does not retry an ordinary provider response error on attempt one", async () => {
    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    const registry = new ToolRegistry();
    const ledger = new InMemorySessionLedger({
      sessionId: identity.runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("ordinary-provider-error"),
      initialToolDefinitions: registry.definitions(),
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "hello" },
    });
    const model = new RetryScriptModel([
      new ProviderResponseError(
        "invalid_provider_response",
        "Invalid provider response.",
        {
          provider: "test",
          model: "test-model",
          path: "choices[0].message",
        },
      ),
      "success",
    ]);

    const result = await runAgent({
      ledger: pending.agent,
      maxIterations: 2,
      model,
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: identity.runtimeSession,
      turn: identity.turn,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "Invalid provider response.",
    });
    expect(model.preparedRequests).toHaveLength(1);
    expect(
      events.events.find((event) => event.type === "model.request.failed"),
    ).toMatchObject({
      data: {
        attemptNumber: 1,
        code: "invalid_provider_response",
        retryDisposition: "not_retryable",
      },
    });
  });

  test("retries a transient rate-limit failure after a backoff delay", async () => {
    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    const registry = new ToolRegistry();
    const ledger = new InMemorySessionLedger({
      sessionId: identity.runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("transient-retry"),
      initialToolDefinitions: registry.definitions(),
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "hello" },
    });
    const model = new RetryScriptModel([rateLimitedError(), "success"]);

    const result = await runAgent({
      ledger: pending.agent,
      maxIterations: 2,
      model,
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: identity.runtimeSession,
      turn: identity.turn,
      signal: new AbortController().signal,
      transientRetryDelaysMs: [5, 10, 20, 40],
    });

    expect(result).toMatchObject({ status: "completed", finalText: "retry succeeded" });
    expect(model.preparedRequests).toHaveLength(2);

    const requestEvents = events.events.filter((event) =>
      event.type.startsWith("model.request."),
    );
    expect(requestEvents.map((event) => event.type)).toEqual([
      "model.request.started",
      "model.request.failed",
      "model.request.started",
      "model.request.finished",
    ]);
    expect(requestEvents.map((event) => event.data)).toMatchObject([
      { attemptNumber: 1, maxAttempts: 6 },
      {
        attemptNumber: 1,
        maxAttempts: 6,
        code: "provider_rate_limited",
        retryDisposition: "scheduled",
        retryDelayMs: 5,
        provider: "test",
        model: "test-model",
      },
      { attemptNumber: 2, maxAttempts: 6 },
      { attemptNumber: 2, maxAttempts: 6 },
    ]);
  });

  test("exhausts transient retries and fails with the provider error", async () => {
    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    const registry = new ToolRegistry();
    const ledger = new InMemorySessionLedger({
      sessionId: identity.runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("transient-exhausted"),
      initialToolDefinitions: registry.definitions(),
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "hello" },
    });
    const model = new RetryScriptModel([
      rateLimitedError(),
      rateLimitedError(),
      rateLimitedError(),
      rateLimitedError(),
      rateLimitedError(),
    ]);

    const result = await runAgent({
      ledger: pending.agent,
      maxIterations: 2,
      model,
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: identity.runtimeSession,
      turn: identity.turn,
      signal: new AbortController().signal,
      transientRetryDelaysMs: [1, 1, 1, 1],
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "429 The engine is currently overloaded, please try again later",
    });
    expect(model.preparedRequests).toHaveLength(5);
    expect(
      events.events
        .filter((event) => event.type === "model.request.started")
        .map((event) => event.data.attemptNumber),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(
      events.events
        .filter((event) => event.type === "model.request.failed")
        .map((event) => [event.data.retryDisposition, event.data.retryDelayMs]),
    ).toEqual([
      ["scheduled", 1],
      ["scheduled", 1],
      ["scheduled", 1],
      ["scheduled", 1],
      ["exhausted", undefined],
    ]);
    expect(pending.projectedMessageCount()).toBe(2);
  });

  test("tracks reasoning-only and transient retry budgets independently", async () => {
    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    const registry = new ToolRegistry();
    const ledger = new InMemorySessionLedger({
      sessionId: identity.runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("mixed-retry-budgets"),
      initialToolDefinitions: registry.definitions(),
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "hello" },
    });
    const model = new RetryScriptModel([
      "reasoning_only",
      rateLimitedError(),
      "reasoning_only",
      "success",
    ]);

    const result = await runAgent({
      ledger: pending.agent,
      maxIterations: 2,
      model,
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: identity.runtimeSession,
      turn: identity.turn,
      signal: new AbortController().signal,
      transientRetryDelaysMs: [1, 1, 1, 1],
    });

    expect(result).toMatchObject({
      status: "failed",
      error:
        "Provider returned reasoning without final text or tool calls in both attempts (provider=test, model=test-model).",
    });
    expect(model.preparedRequests).toHaveLength(3);
    expect(
      events.events
        .filter((event) => event.type === "model.request.failed")
        .map((event) => [event.data.code, event.data.retryDisposition]),
    ).toEqual([
      ["reasoning_only_assistant", "scheduled"],
      ["provider_rate_limited", "scheduled"],
      ["reasoning_only_assistant", "exhausted"],
    ]);
  });

  test("cancels the turn during a transient backoff wait", async () => {
    const controller = new AbortController();
    const events = new ArrayEventSink();
    const cancellingSink: EventSink = {
      async append(event) {
        await events.append(event);
        if (
          event.type === "model.request.failed" &&
          event.data.retryDisposition === "scheduled"
        ) {
          controller.abort(new TurnCancelledError("user"));
        }
      },
    };
    const identity = createTestRuntime(cancellingSink);
    const registry = new ToolRegistry();
    const ledger = new InMemorySessionLedger({
      sessionId: identity.runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("transient-cancel"),
      initialToolDefinitions: registry.definitions(),
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "hello" },
    });
    const model = new RetryScriptModel([rateLimitedError(), "success"]);

    const result = await runAgent({
      ledger: pending.agent,
      maxIterations: 2,
      model,
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: identity.runtimeSession,
      turn: identity.turn,
      signal: controller.signal,
      transientRetryDelaysMs: [60_000, 60_000, 60_000, 60_000],
    });

    expect(result.status).toBe("cancelled");
    expect(model.preparedRequests).toHaveLength(1);
    expect(
      events.events.filter((event) => event.type === "model.request.started"),
    ).toHaveLength(1);
  });

  test("honors cancellation scheduled between reasoning-only attempts", async () => {
    const controller = new AbortController();
    const events = new ArrayEventSink();
    const cancellingSink: EventSink = {
      async append(event) {
        await events.append(event);
        if (
          event.type === "model.request.failed" &&
          event.data.retryDisposition === "scheduled"
        ) {
          controller.abort(new TurnCancelledError("user"));
        }
      },
    };
    const identity = createTestRuntime(cancellingSink);
    const registry = new ToolRegistry();
    const ledger = new InMemorySessionLedger({
      sessionId: identity.runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("reasoning-cancel"),
      initialToolDefinitions: registry.definitions(),
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "hello" },
    });
    const model = new RetryScriptModel(["reasoning_only", "success"]);

    const result = await runAgent({
      ledger: pending.agent,
      maxIterations: 2,
      model,
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: identity.runtimeSession,
      turn: identity.turn,
      signal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(model.preparedRequests).toHaveLength(1);
    expect(
      events.events.filter((event) => event.type === "model.request.started"),
    ).toHaveLength(1);
  });

  test("cancels an in-flight second attempt without recording another failure", async () => {
    const controller = new AbortController();
    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    const registry = new ToolRegistry();
    const ledger = new InMemorySessionLedger({
      sessionId: identity.runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("reasoning-second-cancel"),
      initialToolDefinitions: registry.definitions(),
    });
    const pendingTurn = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "hello" },
    });
    const model = new RetryThenWaitingModel();

    const pending = runAgent({
      ledger: pendingTurn.agent,
      maxIterations: 2,
      model,
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: identity.runtimeSession,
      turn: identity.turn,
      signal: controller.signal,
    });
    await model.secondStarted;
    controller.abort(new TurnCancelledError("user"));
    const result = await pending;

    expect(result.status).toBe("cancelled");
    expect(model.calls).toBe(2);
    expect(
      events.events
        .filter((event) => event.type === "model.request.failed")
        .map((event) => event.data.retryDisposition),
    ).toEqual(["scheduled"]);
    expect(
      events.events
        .filter((event) => event.type === "model.request.started")
        .map((event) => event.data.attemptNumber),
    ).toEqual([1, 2]);
  });

  test("does not start the next tool when the completion write barrier fails", async () => {
    const identity = createTestRuntime();
    const calls = { first: 0, second: 0 };
    const registry = new ToolRegistry();
    registry.register(
      testTool("First", () => {
        calls.first += 1;
      }),
    );
    registry.register(
      testTool("Second", () => {
        calls.second += 1;
      }),
    );
    const ledger = new InMemorySessionLedger({
      sessionId: identity.runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("barrier"),
      initialToolDefinitions: registry.definitions(),
      committer: {
        commit(mutation) {
          if (mutation.kind === "commit_tool_completions") {
            throw new Error("completion persistence failed");
          }
        },
      },
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "run both" },
    });

    const error = await runAgent({
      ledger: pending.agent,
      maxIterations: 2,
      model: new TwoToolModel(),
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: identity.runtimeSession,
      turn: identity.turn,
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(calls).toEqual({ first: 1, second: 0 });
    expect(
      ledger.snapshot({ allowFaulted: true, allowOpenTail: true }).toolResults,
    ).toHaveLength(0);
  });

  test("closes the tool frame and skips later side effects on fatal Recall storage failure", async () => {
    const identity = createTestRuntime();
    let secondCalls = 0;
    const reader = testHistoryReader(identity.runtimeSession.sessionId, () => {
      throw new SessionError(
        "SESSION_READ_FAILED",
        "recall_search",
        "history storage failed",
      );
    });
    const registry = new ToolRegistry();
    registry.register(createRecallSearchToolExecutor({ historyReader: reader }));
    registry.register(
      testTool("Second", () => {
        secondCalls += 1;
      }),
    );
    const ledger = new InMemorySessionLedger({
      sessionId: identity.runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("fatal-recall"),
      initialToolDefinitions: registry.definitions(),
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "recall then mutate" },
    });

    const error = await runAgent({
      ledger: pending.agent,
      maxIterations: 2,
      model: new RecallBatchModel(),
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: identity.runtimeSession,
      turn: identity.turn,
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FatalAgentTurnError);
    expect(secondCalls).toBe(0);
    const view = ledger.snapshot({ allowOpenTail: false });
    expect(view.frames.at(-1)?.state).toBe("closed");
    expect(
      view.toolResults.map((result) =>
        result.completion.kind === "synthetic" ? result.completion.reason : "returned",
      ),
    ).toEqual(["failed_active", "skipped_after_failure"]);
  });

  test("continues the batch after an ordinary Recall miss", async () => {
    const identity = createTestRuntime();
    let secondCalls = 0;
    const reader = testHistoryReader(identity.runtimeSession.sessionId, () => {
      throw new RecallHistoryError("RECALL_SOURCE_NOT_FOUND", "ordinary history miss");
    });
    const registry = new ToolRegistry();
    registry.register(createRecallSearchToolExecutor({ historyReader: reader }));
    registry.register(
      testTool("Second", () => {
        secondCalls += 1;
      }),
    );
    const ledger = new InMemorySessionLedger({
      sessionId: identity.runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("ordinary-recall"),
      initialToolDefinitions: registry.definitions(),
    });
    const pending = ledger.beginTurn({
      turn: identity.turn,
      userMessage: { role: "user", content: "recall then continue" },
    });
    const result = await runAgent({
      ledger: pending.agent,
      maxIterations: 2,
      model: new RecallBatchModel(),
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: identity.runtimeSession,
      turn: identity.turn,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("completed");
    expect(secondCalls).toBe(1);
    expect(
      ledger
        .snapshot({ allowOpenTail: false })
        .toolResults.map((entry) => entry.completion.kind),
    ).toEqual(["returned", "returned"]);
    pending.finish(result);
  });
});

function testTool(name: string, execute: () => void): ToolExecutor {
  return {
    definition: {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    },
    async execute() {
      execute();
      return {
        kind: "generic",
        ok: false,
        toolName: name,
        error: "expected fixture result",
      };
    },
  };
}

function rateLimitedError(): ProviderResponseError {
  return new ProviderResponseError(
    "provider_rate_limited",
    "429 The engine is currently overloaded, please try again later",
    { provider: "test", model: "test-model" },
  );
}

function reasoningOnlyError(prepared: PreparedModelRequest): ProviderResponseError {
  return new ProviderResponseError(
    "reasoning_only_assistant",
    `Invalid provider response (provider=${prepared.provider}, model=${prepared.model}): choices[0].message contains reasoning but neither non-empty final text nor tool calls.`,
    {
      provider: prepared.provider,
      model: prepared.model,
      path: "choices[0].message",
      finishReason: "stop",
      contentChars: 0,
      reasoningChars: "hidden reasoning".length,
      toolCallCount: 0,
      usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
    },
  );
}

function requireRuntime(options: ModelRequestOptions): RuntimeSessionContext {
  if (options.identity === undefined) {
    throw new Error("Expected model request identity.");
  }
  return options.identity.runtimeSession;
}

function requireIteration(options: ModelRequestOptions) {
  if (options.identity === undefined) {
    throw new Error("Expected model request identity.");
  }
  return options.identity.iteration;
}

function testHistoryReader(
  sessionId: SessionHistoryReader["sessionId"],
  search: SessionHistoryReader["search"],
): SessionHistoryReader {
  return {
    sessionId,
    search,
    get() {
      throw new Error("Unexpected RecallGet.");
    },
  };
}
