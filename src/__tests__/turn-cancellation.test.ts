import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../agent/loop";
import { InMemorySessionLedger } from "../agent/session-ledger";
import { toolResultDisplayText } from "../agent/tool-result-content";
import { cancellationError, TurnCancelledError } from "../agent/turn-cancellation";
import type { EventSink } from "../events/event-sink";
import { ObservationTextLog } from "../events/observation-text-log";
import type { AgentEvent } from "../events/types";
import type {
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { toOpenAIChatMessages } from "../model/openai-chat-mapping";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling, ToolRegistry, ToolRuntime } from "../tools/registry";
import { ripGrep } from "../tools/ripgrep";
import type { BashRawResult, ToolExecutor } from "../tools/types";
import {
  createTestContextMeter,
  createTestHistoryReader,
  createTestRuntime,
  deterministicIdFactory,
  TEST_CONTEXT_BUDGET,
  TestModelClient,
  testModelOutput,
} from "./test-runtime";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

class ArrayEventSink implements EventSink {
  readonly events: AgentEvent[] = [];

  async append(event: AgentEvent): Promise<void> {
    this.events.push(event);
  }
}

class WaitingModel extends TestModelClient {
  readonly started: Promise<void>;
  private start!: () => void;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.start = resolve;
    });
  }

  async request(
    _prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.start();
    return await new Promise<ModelRequestOutput>((_resolve, reject) => {
      const onAbort = () => reject(cancellationError(options.signal));
      if (options.signal.aborted) {
        onAbort();
        return;
      }

      options.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

class ToolBatchModel extends TestModelClient {
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
          providerToolCallId: "provider-read",
          name: "Read",
          args: {},
        },
        {
          ...runtimeSession.createToolCall(iteration, 2),
          providerToolCallId: "provider-grep",
          name: "Grep",
          args: {},
        },
        {
          ...runtimeSession.createToolCall(iteration, 3),
          providerToolCallId: "provider-glob",
          name: "Glob",
          args: {},
        },
      ],
    });
  }
}

describe("turn cancellation", () => {
  test("passes the turn signal to the OpenAI request", async () => {
    let receivedSignal: AbortSignal | null | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      receivedSignal = init?.signal;
      return new Response(
        JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok", refusal: null },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 1,
            total_tokens: 6,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const controller = new AbortController();
    const client = new OpenAIChatModelClient({
      apiKey: "test-key",
      model: "test-model",
      contextBudget: TEST_CONTEXT_BUDGET,
      stream: false,
      fetch: fetchImpl,
    });

    const prepared = client.prepare({
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });
    await client.request(prepared, { signal: controller.signal });

    expect(receivedSignal).toBeDefined();
    controller.abort(new TurnCancelledError("user"));
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("cancels a streaming OpenAI request after receiving a partial chunk", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-cancel-openai-stream-"),
    );
    const controller = new AbortController();
    let publishPartialChunk!: () => void;
    const partialChunkPublished = new Promise<void>((resolve) => {
      publishPartialChunk = resolve;
    });
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) {
        throw new Error("Expected an OpenAI request signal.");
      }

      const encoder = new TextEncoder();
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(streamController) {
          if (sent) {
            return;
          }
          sent = true;
          streamController.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: "chatcmpl_partial",
                object: "chat.completion.chunk",
                created: 0,
                model: "test-model",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "partial" },
                    finish_reason: null,
                  },
                ],
              })}\n\n`,
            ),
          );
          publishPartialChunk();
          signal.addEventListener(
            "abort",
            () => streamController.error(signal.reason),
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const model = new OpenAIChatModelClient({
      apiKey: "test-key",
      model: "test-model",
      contextBudget: TEST_CONTEXT_BUDGET,
      fetch: fetchImpl,
    });
    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    const runtimeSession = identity.runtimeSession;
    const turn = identity.turn;
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      runtimeSession,
      historyReader: createTestHistoryReader(runtimeSession.sessionId),
    });

    try {
      const ledger = new InMemorySessionLedger({
        sessionId: runtimeSession.sessionId,
        systemPrompt: "system",
        idFactory: deterministicIdFactory("cancel-openai-stream"),
        initialToolDefinitions: tooling.registry.definitions(),
      });
      const pendingTurn = ledger.beginTurn({
        turn,
        userMessage: { role: "user", content: "wait" },
      });
      const pending = runAgent({
        ledger: pendingTurn.agent,
        maxIterations: 2,
        model,
        contextMeter: createTestContextMeter(),
        tools: tooling.registry,
        toolRuntime: tooling.runtime,
        observationBuilder: new ObservationBuilder(),
        runtimeSession,
        turn,
        signal: controller.signal,
      });

      await partialChunkPublished;
      controller.abort(new TurnCancelledError("user"));
      const result = await pending;

      expect(result.status).toBe("cancelled");
      expect(result.status === "cancelled" ? result.cancellation.phase : "").toBe(
        "model_request",
      );
      expect(pendingTurn.projectedMessageCount()).toBe(2);
      pendingTurn.finish(result);
      expect(events.events.map((event) => event.type)).toEqual([
        "agent.iteration.started",
        "context.usage.updated",
        "model.request.started",
      ]);
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("cancels an in-flight model request without recording a failure", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-cancel-model-"));
    const controller = new AbortController();
    const model = new WaitingModel();
    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    const runtimeSession = identity.runtimeSession;
    const turn = identity.turn;
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      runtimeSession,
      historyReader: createTestHistoryReader(runtimeSession.sessionId),
    });

    try {
      const ledger = new InMemorySessionLedger({
        sessionId: runtimeSession.sessionId,
        systemPrompt: "system",
        idFactory: deterministicIdFactory("cancel-model"),
        initialToolDefinitions: tooling.registry.definitions(),
      });
      const pendingTurn = ledger.beginTurn({
        turn,
        userMessage: { role: "user", content: "wait" },
      });
      const pending = runAgent({
        ledger: pendingTurn.agent,
        maxIterations: 2,
        model,
        contextMeter: createTestContextMeter(),
        tools: tooling.registry,
        toolRuntime: tooling.runtime,
        observationBuilder: new ObservationBuilder(),
        runtimeSession,
        turn,
        signal: controller.signal,
      });

      await model.started;
      controller.abort(new TurnCancelledError("user"));
      const result = await pending;

      expect(result.status).toBe("cancelled");
      expect(result.status === "cancelled" ? result.cancellation.phase : "").toBe(
        "model_request",
      );
      expect(pendingTurn.projectedMessageCount()).toBe(2);
      pendingTurn.finish(result);
      expect(
        ledger
          .buildCommittedModelRequest(tooling.registry.definitions())
          .request.messages.at(-1),
      ).toEqual({ role: "user", content: "wait" });
      expect(events.events.map((event) => event.type)).toEqual([
        "agent.iteration.started",
        "context.usage.updated",
        "model.request.started",
      ]);
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("fast-fails ToolRuntime before invoking a tool", async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    registry.register(
      testExecutor("Read", async () => {
        calls += 1;
        return { kind: "read", ok: true, filePath: "test.txt" };
      }),
    );
    const controller = new AbortController();
    controller.abort(new TurnCancelledError("user"));
    const testRuntime = createTestRuntime();

    expect(
      new ToolRuntime(registry).execute(
        testRuntime.toolCall({
          providerToolCallId: "provider-call-1",
          name: "Read",
          args: {},
        }),
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(TurnCancelledError);
    expect(calls).toBe(0);
  });

  test("completes a cancelled tool batch with protocol-valid tool messages", async () => {
    const controller = new AbortController();
    const registry = new ToolRegistry();
    let thirdToolCalls = 0;

    registry.register(
      testExecutor("Read", async () => ({
        kind: "read",
        ok: true,
        filePath: "first.txt",
        content: "first",
      })),
    );
    registry.register(
      testExecutor("Grep", async (_args, _call, context) => {
        controller.abort(new TurnCancelledError("user"));
        throw cancellationError(context.signal);
      }),
    );
    registry.register(
      testExecutor("Glob", async () => {
        thirdToolCalls += 1;
        return {
          kind: "glob",
          ok: true,
          pattern: "*",
          searchPath: ".",
          matches: [],
          matchCount: 0,
        };
      }),
    );

    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    const runtimeSession = identity.runtimeSession;
    const turn = identity.turn;
    const ledger = new InMemorySessionLedger({
      sessionId: runtimeSession.sessionId,
      systemPrompt: "system",
      idFactory: deterministicIdFactory("cancel-tools"),
      initialToolDefinitions: registry.definitions(),
    });
    const pendingTurn = ledger.beginTurn({
      turn,
      userMessage: { role: "user", content: "run tools" },
    });
    const result = await runAgent({
      ledger: pendingTurn.agent,
      maxIterations: 2,
      model: new ToolBatchModel(),
      contextMeter: createTestContextMeter(),
      tools: registry,
      toolRuntime: new ToolRuntime(registry),
      observationBuilder: new ObservationBuilder(),
      runtimeSession,
      turn,
      signal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(thirdToolCalls).toBe(0);
    pendingTurn.finish(result);
    const messages = ledger.buildCommittedModelRequest(registry.definitions()).request
      .messages;
    const toolMessages = messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(toolResultDisplayText(toolMessages[0].content)).toContain("Read succeeded");
    expect(toolResultDisplayText(toolMessages[1].content)).toContain(
      "cancelled by the user",
    );
    expect(toolResultDisplayText(toolMessages[2].content)).toContain("skipped");
    expect(() => toOpenAIChatMessages(messages)).not.toThrow();

    const eventTypes = events.events.map((event) => event.type);
    expect(eventTypes).toContain("tool.finished");
    expect(
      events.events.some(
        (event) =>
          event.type === "tool.started" &&
          event.data.call.providerToolCallId === "provider-glob",
      ),
    ).toBe(false);
  });

  test("kills a foreground Bash process group and keeps it out of TaskList", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-cancel-bash-"));
    const testRuntime = createTestRuntime();
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      runtimeSession: testRuntime.runtimeSession,
      historyReader: createTestHistoryReader(testRuntime.runtimeSession.sessionId),
      taskStopGraceMs: 50,
    });
    const controller = new AbortController();
    const pidFile = path.join(workspace, "pids.txt");
    let parentPid = 0;
    let childPid = 0;

    try {
      const pending = tooling.runtime.execute(
        testRuntime.toolCall({
          providerToolCallId: "call_bash",
          name: "Bash",
          args: {
            command:
              'sleep 30 & child=$!; printf "%s %s" "$$" "$child" > pids.txt; wait',
          },
        }),
        { signal: controller.signal },
      );

      [parentPid, childPid] = await waitForProcessIds(pidFile);
      expect(isProcessAlive(parentPid)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);

      controller.abort(new TurnCancelledError("user"));
      expect(pending).rejects.toBeInstanceOf(TurnCancelledError);
      await waitForProcessExit(parentPid);
      await waitForProcessExit(childPid);
      expect(tooling.taskManager.listBackgroundTasks()).toEqual([]);
    } finally {
      await tooling.dispose();
      killProcessIfAlive(parentPid);
      killProcessIfAlive(childPid);
      await rm(workspace, { recursive: true });
    }
  });

  test("finishes explicit background publication before observing abort", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-cancel-bg-"));
    const testRuntime = createTestRuntime();
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      runtimeSession: testRuntime.runtimeSession,
      historyReader: createTestHistoryReader(testRuntime.runtimeSession.sessionId),
      taskStopGraceMs: 50,
    });
    const controller = new AbortController();

    try {
      const pending = tooling.runtime.execute(
        testRuntime.toolCall({
          providerToolCallId: "call_background",
          name: "Bash",
          args: { command: "sleep 30", run_in_background: true },
        }),
        { signal: controller.signal },
      );
      controller.abort(new TurnCancelledError("user"));

      const raw = (await pending) as BashRawResult;
      expect(raw.ok).toBe(true);
      expect(raw.status).toBe("running");
      expect(tooling.taskManager.listBackgroundTasks()[0]?.taskId).toBe(raw.taskId);
      await tooling.taskManager.stopTask(raw.taskId, "tool");
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("finishes timeout background publication after timeout wins", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-cancel-timeout-"));
    const controller = new AbortController();
    const eventSink: EventSink = {
      async append(event) {
        if (
          event.type === "bash.task.backgrounded" &&
          event.data.task.backgroundReason === "foreground_timeout"
        ) {
          controller.abort(new TurnCancelledError("user"));
        }
      },
    };
    const identity = createTestRuntime(eventSink);
    const runtimeSession = identity.runtimeSession;
    const iteration = identity.iteration;
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      runtimeSession,
      historyReader: createTestHistoryReader(runtimeSession.sessionId),
      taskStopGraceMs: 50,
    });

    try {
      const raw = (await tooling.runtime.execute(
        {
          ...runtimeSession.createToolCall(iteration, 1),
          providerToolCallId: "call_timeout",
          name: "Bash",
          args: { command: "sleep 30", timeout: 1 },
        },
        { signal: controller.signal },
      )) as BashRawResult;

      expect(controller.signal.aborted).toBe(true);
      expect(raw.ok).toBe(true);
      expect(raw.backgroundedDueToTimeout).toBe(true);
      expect(tooling.taskManager.listBackgroundTasks()[0]?.taskId).toBe(raw.taskId);
      await tooling.taskManager.stopTask(raw.taskId, "tool");
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("aborts the ripgrep child process", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-cancel-rg-"));
    const executable = path.join(workspace, "slow-rg");
    const controller = new AbortController();

    try {
      await writeFile(executable, "#!/bin/sh\nexec sleep 30\n", "utf8");
      await chmod(executable, 0o755);

      const pending = ripGrep(["anything", workspace], {
        command: executable,
        signal: controller.signal,
      });
      await Bun.sleep(20);
      controller.abort(new TurnCancelledError("user"));

      expect(pending).rejects.toBeInstanceOf(TurnCancelledError);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("writes a human-readable run cancellation block", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-cancel-log-"));
    const logPath = path.join(workspace, "run.md");

    try {
      const identity = createTestRuntime(new ObservationTextLog(logPath));
      const runtimeSession = identity.runtimeSession;
      const iteration = identity.iteration;
      await runtimeSession.append({
        type: "turn.cancelled",
        ...iteration,
        data: {
          cancellation: {
            source: "user",
            phase: "tool_execution",
            iterationId: iteration.iterationId,
            iterationNumber: iteration.iterationNumber,
            toolName: "Bash",
          },
        },
      });

      const content = await readFile(logPath, "utf8");
      expect(content).toContain("## Cancelled");
      expect(content).toContain("Phase: tool_execution");
      expect(content).toContain("Tool: Bash");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

function testExecutor(name: string, execute: ToolExecutor["execute"]): ToolExecutor {
  return {
    definition: {
      name,
      description: `Test ${name}`,
      parameters: { type: "object", properties: {} },
    },
    execute,
  };
}

async function waitForProcessIds(filePath: string): Promise<[number, number]> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(filePath, "utf8");
      const match = /^([1-9]\d*) ([1-9]\d*)$/.exec(content);
      if (match) {
        const parentPid = Number(match[1]);
        const childPid = Number(match[2]);
        if (Number.isSafeInteger(parentPid) && Number.isSafeInteger(childPid)) {
          return [parentPid, childPid];
        }
      }
    } catch {
      // The shell has not created the PID file yet.
    }
    await Bun.sleep(10);
  }

  throw new Error(`Timed out waiting for process IDs in file: ${filePath}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await Bun.sleep(10);
  }

  throw new Error(`Process ${pid} is still alive.`);
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function killProcessIfAlive(pid: number): void {
  if (!isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!isNoSuchProcess(error)) {
      throw error;
    }
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}
