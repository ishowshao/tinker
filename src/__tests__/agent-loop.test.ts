import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FatalAgentTurnError, runAgent } from "../agent/loop";
import type { RuntimeSessionContext } from "../agent/runtime-session";
import { InMemorySessionLedger } from "../agent/session-ledger";
import type { AgentMessage } from "../agent/types";
import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import type {
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { ObservationBuilder } from "../observation/observation-builder";
import { SessionError } from "../session/session-errors";
import {
  RecallHistoryError,
  type SessionHistoryReader,
} from "../session/session-history-reader";
import { createRecallToolExecutor } from "../tools/recall";
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
    expect(toolMessage.content).toContain("Read succeeded");

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
          name: "Recall",
          args: { mode: "search", query: "history" },
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
    registry.register(createRecallToolExecutor({ historyReader: reader }));
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
    registry.register(createRecallToolExecutor({ historyReader: reader }));
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
      throw new Error("Unexpected Recall get.");
    },
  };
}
