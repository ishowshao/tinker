import { describe, expect, test } from "bun:test";
import {
  applyAgentEvent as applyAgentEventCore,
  createInitialTuiState,
  type TuiState,
  visibleTimelineItems,
} from "../tui/event-store";
import type { AgentEvent } from "../events/types";
import type { ToolCall } from "../agent/types";
import type { ProviderResponseErrorCode } from "../model/model-client";
import {
  createTestRuntime,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
} from "./test-runtime";

const testRuntime = createTestRuntime();
const toolCalls = new Map<string, ReturnType<typeof testRuntime.toolCall>>();
let eventSequence = 0;

type TestEventInput = Record<string, unknown> & { type: string };

function applyAgentEvent(state: TuiState, input: TestEventInput): TuiState {
  if (state.activeTurn === undefined && requiresActiveTurn(input.type)) {
    state = applyAgentEventCore(
      state,
      testEvent({ type: "turn.started", input: { userPrompt: "prompt" } }),
    );
  }
  return applyAgentEventCore(state, testEvent(input));
}

function requiresActiveTurn(type: string): boolean {
  return (
    type.startsWith("model.") ||
    type.startsWith("tool.") ||
    type === "assistant.progress" ||
    type === "turn.finished" ||
    type === "turn.failed" ||
    type === "turn.cancelled"
  );
}

function testEvent(input: TestEventInput): AgentEvent {
  eventSequence += 1;
  const base = {
    sessionId: testRuntime.runtimeSession.sessionId,
    eventSequence,
    timestamp:
      stringValue(input.createdAt) ??
      stringValue(input.finishedAt) ??
      stringValue(input.cancelledAt) ??
      "2026-07-11T00:00:00.000Z",
  };

  if (input.type === "session.started") {
    return {
      ...base,
      type: "session.started",
      data: {
        workspaceRoot: "/tmp/workspace",
        model: "model",
        maxIterations: 100,
        includeReasoningContent: false,
        contextProfile: TEST_CONTEXT_PROFILE,
        contextBudget: TEST_CONTEXT_BUDGET,
        projectInstructions: {},
      },
    };
  }
  if (input.type === "turn.started") {
    const promptInput = recordValue(input.input);
    return {
      ...base,
      ...testRuntime.turn,
      type: "turn.started",
      data: {
        userPrompt: promptProjection(stringValue(promptInput.userPrompt) ?? "prompt"),
      },
    };
  }
  if (input.type === "model.request.started") {
    return {
      ...base,
      ...testRuntime.iteration,
      type: "model.request.started",
      data: {
        attemptNumber: numberValue(input.attemptNumber) ?? 1,
        maxAttempts: numberValue(input.maxAttempts) ?? 2,
      },
    };
  }
  if (input.type === "model.request.finished") {
    return {
      ...base,
      ...testRuntime.iteration,
      type: "model.request.finished",
      data: {
        attemptNumber: numberValue(input.attemptNumber) ?? 1,
        maxAttempts: numberValue(input.maxAttempts) ?? 2,
        output: input.output,
      },
    } as unknown as AgentEvent;
  }
  if (input.type === "model.request.failed") {
    const retryDelayMs = numberValue(input.retryDelayMs);
    return {
      ...base,
      ...testRuntime.iteration,
      type: "model.request.failed",
      data: {
        attemptNumber: numberValue(input.attemptNumber) ?? 1,
        maxAttempts: numberValue(input.maxAttempts) ?? 2,
        code: (stringValue(input.code) ??
          "reasoning_only_assistant") as ProviderResponseErrorCode,
        retryDisposition:
          stringValue(input.retryDisposition) === "exhausted"
            ? "exhausted"
            : "scheduled",
        ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
        provider: "test-provider",
        model: "test-model",
        error: stringValue(input.error) ?? "reasoning-only",
      },
    };
  }
  if (input.type === "assistant.progress") {
    return {
      ...base,
      ...testRuntime.iteration,
      type: "assistant.progress",
      data: { content: stringValue(input.content) ?? "" },
    };
  }
  if (
    input.type === "tool.started" ||
    input.type === "tool.raw_result" ||
    input.type === "tool.finished" ||
    input.type === "tool.observation"
  ) {
    const call = testToolCall(input.call);
    return {
      ...base,
      ...call,
      type: input.type,
      data: {
        call,
        raw: input.raw,
        ok: input.ok,
        observation: input.observation,
      },
    } as unknown as AgentEvent;
  }
  if (input.type.startsWith("bash.task.")) {
    const task = recordValue(input.task);
    const call =
      "origin" in task
        ? testToolCall(task.origin)
        : testToolCall({
            providerToolCallId: "background-origin",
            name: "Bash",
            args: {},
          });
    return {
      ...base,
      ...call,
      type: input.type,
      data: { task: { ...task, origin: call } },
    } as unknown as AgentEvent;
  }
  if (input.type === "turn.finished") {
    return {
      ...base,
      ...testRuntime.turn,
      type: "turn.finished",
      data: {
        status: "completed",
        finalText: stringValue(input.finalText) ?? "",
        lastIteration: testRuntime.iteration,
        messageCount: numberValue(input.messageCount) ?? 0,
      },
    };
  }
  if (input.type === "turn.cancelled") {
    const cancellation = recordValue(input.cancellation);
    const providerToolCallId = stringValue(cancellation.toolCallId);
    const toolName = stringValue(cancellation.toolName);
    const cancelledCall =
      providerToolCallId === undefined
        ? undefined
        : [...toolCalls.values()].find(
            (call) =>
              call.providerToolCallId === providerToolCallId &&
              (toolName === undefined || call.name === toolName),
          );
    return {
      ...base,
      ...testRuntime.iteration,
      type: "turn.cancelled",
      data: {
        cancellation: {
          ...cancellation,
          iterationId: testRuntime.iteration.iterationId,
          iterationNumber: numberValue(cancellation.iterationNumber) ?? 1,
          toolCallId: cancelledCall?.toolCallId,
        },
      },
    } as AgentEvent;
  }
  if (input.type === "turn.failed") {
    return {
      ...base,
      ...testRuntime.turn,
      type: "turn.failed",
      data: { error: stringValue(input.error) ?? "failed" },
    };
  }
  if (input.type === "context.revision.finished") {
    return {
      ...base,
      type: "context.revision.finished",
      data: recordValue(input.data),
    } as AgentEvent;
  }
  throw new Error(`Unsupported test event: ${input.type}`);
}

function promptProjection(text: string) {
  return { version: 1 as const, text, images: [], omittedImageCount: 0 };
}

function testToolCall(value: unknown): ToolCall {
  const input = recordValue(value);
  if (typeof input.toolCallId === "string") {
    return input as ToolCall;
  }
  const providerToolCallId = stringValue(input.providerToolCallId) ?? "provider-call";
  const name = stringValue(input.name) ?? "TestTool";
  const key = `${providerToolCallId}:${name}:${JSON.stringify(input.args)}`;
  const existing = toolCalls.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const call = testRuntime.toolCall({
    providerToolCallId,
    name,
    args: input.args,
  });
  toolCalls.set(key, call);
  return call;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

describe("tui event store", () => {
  test("tracks background task lifecycle outside the agent timeline", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });
    const task = {
      taskId: "task-1",
      origin: testRuntime.toolCall({
        providerToolCallId: "task-origin",
        name: "Bash",
        args: {},
      }),
      command: "bun run dev",
      description: "Start development server",
      status: "running" as const,
      startedAt: "2026-07-10T10:00:00.000Z",
      backgroundedAt: "2026-07-10T10:00:00.010Z",
      backgroundReason: "requested" as const,
      outputFilePath: "/tmp/task-1.log",
      outputBytes: 0,
      outputLines: 0,
      cwd: "/tmp/workspace",
    };

    state = applyAgentEvent(state, { type: "bash.task.backgrounded", task });
    expect(state.backgroundTasks).toEqual([task]);
    expect(visibleTimelineItems(state)).toEqual([]);

    state = applyAgentEvent(state, {
      type: "bash.task.stopping",
      task: { ...task, status: "stopping" },
    });
    expect(state.backgroundTasks[0]?.status).toBe("stopping");

    state = applyAgentEvent(state, {
      type: "bash.task.finished",
      task: {
        ...task,
        status: "killed",
        signal: "SIGTERM",
        endedAt: "2026-07-10T10:01:00.000Z",
      },
    });
    expect(state.backgroundTasks[0]).toMatchObject({
      status: "killed",
      signal: "SIGTERM",
      endedAt: "2026-07-10T10:01:00.000Z",
    });
  });

  test("summarizes task management tool results", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    const listCall = { providerToolCallId: "call_1", name: "TaskList", args: {} };
    state = applyAgentEvent(state, {
      type: "tool.started",
      iterationNumber: 1,
      call: listCall,
    });
    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call: listCall,
      raw: { kind: "task_list", ok: true, tasks: [{}, {}], runningCount: 1 },
    });
    expect(visibleTimelineItems(state).at(-1)?.text).toBe(
      "TaskList -> 2 tasks, 1 running",
    );

    const outputCall = {
      providerToolCallId: "call_2",
      name: "TaskOutput",
      args: { task_id: "task-1" },
    };
    state = applyAgentEvent(state, {
      type: "tool.started",
      iterationNumber: 1,
      call: outputCall,
    });
    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call: outputCall,
      raw: {
        kind: "task_output",
        ok: true,
        taskId: "task-1",
        status: "running",
        command: "bun run dev",
        outputLines: 2,
        outputBytes: 20,
        preview: "starting\nready",
        outputFilePath: "/tmp/task-1.log",
      },
    });
    expect(visibleTimelineItems(state).at(-1)?.text).toBe(
      "TaskOutput task-1 -> running, 2 lines",
    );
    expect(visibleTimelineItems(state).at(-1)?.bash?.outputPreview).toEqual([
      "starting",
      "ready",
    ]);
  });

  test("tracks run, tool, final and failure state", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    state = applyAgentEvent(state, {
      type: "turn.started",
      sessionId: "run-1",
      createdAt: "2026-07-06T00:00:00.000Z",
      input: {},
    });
    expect(state.status).toBe("running");

    state = applyAgentEvent(state, {
      type: "tool.started",
      iterationNumber: 1,
      call: {
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "README.md" },
      },
    });
    state = applyAgentEvent(state, {
      type: "tool.finished",
      iterationNumber: 1,
      call: {
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "README.md" },
      },
      ok: true,
    });
    expect(visibleTimelineItems(state).at(-1)?.text).toContain("README.md");
    expect(visibleTimelineItems(state).at(-1)?.status).toBe("ok");

    state = applyAgentEvent(state, {
      type: "turn.finished",
      finishedAt: "2026-07-06T00:03:27.000Z",
      finalText: "done",
      messageCount: 5,
    });
    expect(state.status).toBe("done");
    expect(state.workedForMs).toBe(207_000);
    expect(state.finalText).toBe("done");
    expect(visibleTimelineItems(state).at(-1)?.label).toBe("assistant");
    expect(visibleTimelineItems(state).at(-1)?.text).toBe("done");
    expect(visibleTimelineItems(state).at(-1)?.status).toBe("text");

    state = applyAgentEvent(state, {
      type: "turn.failed",
      error: "failed",
    });
    expect(state.status).toBe("failed");
    expect(state.error).toBe("failed");
    expect(visibleTimelineItems(state).at(-1)?.label).toBe("error");
    expect(visibleTimelineItems(state).at(-1)?.text).toBe("failed");
  });

  test("starts a new prompt while preserving previous final answers", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    state = applyAgentEvent(state, {
      type: "turn.started",
      sessionId: "run-1",
      createdAt: "2026-07-06T00:00:00.000Z",
      input: { userPrompt: "first" },
    });
    state = applyAgentEvent(state, {
      type: "turn.finished",
      finishedAt: "2026-07-06T00:00:30.000Z",
      finalText: "first done",
      messageCount: 3,
    });
    state = applyAgentEvent(state, {
      type: "turn.started",
      sessionId: "run-1",
      createdAt: "2026-07-06T00:01:00.000Z",
      input: { userPrompt: "second" },
    });

    expect(state.status).toBe("running");
    expect(state.workedForMs).toBeUndefined();
    expect(visibleTimelineItems(state).map((item) => item.text)).toEqual([
      "first",
      "first done",
      "second",
    ]);
    expect(visibleTimelineItems(state).map((item) => item.label)).toEqual([
      "prompt",
      "assistant",
      "prompt",
    ]);
    expect(new Set(visibleTimelineItems(state).map((item) => item.id)).size).toBe(3);
  });

  test("records only the terminal cancelled state from events", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    state = applyAgentEvent(state, {
      type: "model.request.started",
      iterationNumber: 1,
    });
    expect(state.status).toBe("running");

    state = applyAgentEvent(state, {
      type: "turn.cancelled",
      cancelledAt: "2026-07-10T00:00:00.000Z",
      cancellation: {
        source: "user",
        phase: "model_request",
        iterationNumber: 1,
      },
    });

    expect(state.status).toBe("cancelled");
    expect(visibleTimelineItems(state).at(-1)?.status).toBe("cancelled");
    expect(visibleTimelineItems(state).at(-1)?.text).toContain("cancelled");

    state = applyAgentEvent(state, {
      type: "tool.started",
      iterationNumber: 2,
      call: {
        providerToolCallId: "call_1",
        name: "Bash",
        args: { command: "sleep 30" },
      },
    });
    state = applyAgentEvent(state, {
      type: "turn.cancelled",
      cancelledAt: "2026-07-10T00:00:01.000Z",
      cancellation: {
        source: "user",
        phase: "tool_execution",
        iterationNumber: 2,
        toolCallId: "call_1",
        toolName: "Bash",
      },
    });
    expect(visibleTimelineItems(state).at(-1)?.status).toBe("cancelled");
    expect(visibleTimelineItems(state).at(-1)?.text).toContain("Bash");
  });

  test("updates model and tool timeline items with useful summaries", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    state = applyAgentEvent(state, {
      type: "model.request.started",
      iterationNumber: 1,
    });
    state = applyAgentEvent(state, {
      type: "model.request.finished",
      iterationNumber: 1,
      output: {
        message: {
          role: "assistant",
          toolCalls: [
            {
              providerToolCallId: "call_1",
              name: "Glob",
              args: { pattern: "**/*.test.ts" },
            },
            {
              providerToolCallId: "call_2",
              name: "Glob",
              args: { pattern: "**/*.test.tsx" },
            },
          ],
        },
      },
    });

    expect(visibleTimelineItems(state)).toHaveLength(2);
    expect(visibleTimelineItems(state)[1]?.text).toBe(
      "model iteration 1 -> 2 tool calls",
    );
    expect(visibleTimelineItems(state)[1]?.status).toBe("ok");

    state = applyAgentEvent(state, {
      type: "assistant.progress",
      iterationNumber: 1,
      content: "I will inspect the matching tests.",
    });
    expect(visibleTimelineItems(state)).toHaveLength(3);
    expect(visibleTimelineItems(state)[2]).toMatchObject({
      label: "assistant",
      text: "I will inspect the matching tests.",
      status: "text",
    });

    state = applyAgentEvent(state, {
      type: "tool.started",
      iterationNumber: 1,
      call: {
        providerToolCallId: "call_1",
        name: "Glob",
        args: { pattern: "**/*.test.ts" },
      },
    });
    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call: {
        providerToolCallId: "call_1",
        name: "Glob",
        args: { pattern: "**/*.test.ts" },
      },
      raw: {
        kind: "glob",
        ok: true,
        pattern: "**/*.test.ts",
        matchCount: 5,
        matches: [],
      },
    });
    state = applyAgentEvent(state, {
      type: "tool.finished",
      iterationNumber: 1,
      call: {
        providerToolCallId: "call_1",
        name: "Glob",
        args: { pattern: "**/*.test.ts" },
      },
      ok: true,
    });

    expect(visibleTimelineItems(state)).toHaveLength(4);
    expect(visibleTimelineItems(state)[3]?.text).toBe("Glob **/*.test.ts -> 5 matches");
    expect(visibleTimelineItems(state)[3]?.status).toBe("ok");
  });

  test("updates one model item while a reasoning-only retry is running", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    state = applyAgentEvent(state, {
      type: "model.request.started",
      iterationNumber: 1,
      attemptNumber: 1,
    });
    const initialModelItem = visibleTimelineItems(state)[1];
    expect(initialModelItem?.text).toBe("model iteration 1");

    state = applyAgentEvent(state, {
      type: "model.request.failed",
      iterationNumber: 1,
      attemptNumber: 1,
      retryDisposition: "scheduled",
    });
    expect(visibleTimelineItems(state)[1]).toMatchObject({
      id: initialModelItem?.id,
      ref: initialModelItem?.ref,
      text: "model iteration 1 · retrying (attempt 2/2)",
      status: "running",
    });

    state = applyAgentEvent(state, {
      type: "model.request.started",
      iterationNumber: 1,
      attemptNumber: 2,
    });
    expect(visibleTimelineItems(state)).toHaveLength(2);
    expect(visibleTimelineItems(state)[1]).toMatchObject({
      id: initialModelItem?.id,
      ref: initialModelItem?.ref,
      text: "model iteration 1 · retrying (attempt 2/2)",
      status: "running",
    });

    state = applyAgentEvent(state, {
      type: "model.request.finished",
      iterationNumber: 1,
      attemptNumber: 2,
      output: {
        message: { role: "assistant", content: "done" },
      },
    });
    expect(visibleTimelineItems(state)).toHaveLength(2);
    expect(visibleTimelineItems(state)[1]).toMatchObject({
      id: initialModelItem?.id,
      ref: initialModelItem?.ref,
      text: "model iteration 1 -> assistant response",
      status: "ok",
    });
  });

  test("settles the retrying model item when both attempts fail", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });
    state = applyAgentEvent(state, {
      type: "model.request.started",
      attemptNumber: 1,
    });
    state = applyAgentEvent(state, {
      type: "model.request.failed",
      attemptNumber: 1,
      retryDisposition: "scheduled",
    });
    state = applyAgentEvent(state, {
      type: "model.request.started",
      attemptNumber: 2,
    });
    state = applyAgentEvent(state, {
      type: "model.request.failed",
      attemptNumber: 2,
      retryDisposition: "exhausted",
    });
    state = applyAgentEvent(state, {
      type: "turn.failed",
      error: "reasoning retry exhausted",
    });

    const items = visibleTimelineItems(state);
    const modelItems = items.filter((item) => item.ref?.startsWith("model-request-"));
    expect(modelItems).toHaveLength(1);
    expect(modelItems[0]).toMatchObject({
      text: "model iteration 1 · retrying (attempt 2/2)",
      status: "failed",
    });
    expect(items.at(-1)).toMatchObject({
      label: "error",
      text: "reasoning retry exhausted",
      status: "failed",
    });
  });

  test("shows the backoff wait while a transient retry is scheduled", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    state = applyAgentEvent(state, {
      type: "model.request.started",
      iterationNumber: 1,
      attemptNumber: 1,
      maxAttempts: 6,
    });
    state = applyAgentEvent(state, {
      type: "model.request.failed",
      iterationNumber: 1,
      attemptNumber: 1,
      maxAttempts: 6,
      code: "provider_rate_limited",
      retryDisposition: "scheduled",
      retryDelayMs: 2_000,
      error: "429 The engine is currently overloaded",
    });

    expect(visibleTimelineItems(state)[1]).toMatchObject({
      text: "model iteration 1 · rate limited · retrying in 2s (attempt 2/6)",
      status: "running",
    });

    state = applyAgentEvent(state, {
      type: "model.request.started",
      iterationNumber: 1,
      attemptNumber: 2,
      maxAttempts: 6,
    });
    expect(visibleTimelineItems(state)[1]).toMatchObject({
      text: "model iteration 1 · retrying (attempt 2/6)",
      status: "running",
    });
  });

  test("summarizes Grep tool calls per output mode", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    state = applyAgentEvent(state, {
      type: "tool.started",
      iterationNumber: 1,
      call: { providerToolCallId: "call_1", name: "Grep", args: { pattern: "foo" } },
    });
    expect(visibleTimelineItems(state).at(-1)?.text).toBe("Grep foo");
    expect(visibleTimelineItems(state).at(-1)?.status).toBe("running");

    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call: { providerToolCallId: "call_1", name: "Grep", args: { pattern: "foo" } },
      raw: {
        kind: "grep",
        ok: true,
        pattern: "foo",
        mode: "files_with_matches",
        filenames: ["a.ts", "b.ts"],
        numFiles: 2,
      },
    });
    expect(visibleTimelineItems(state).at(-1)?.text).toBe("Grep foo -> 2 files");

    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call: { providerToolCallId: "call_1", name: "Grep", args: { pattern: "foo" } },
      raw: {
        kind: "grep",
        ok: true,
        pattern: "foo",
        mode: "content",
        filenames: ["a.ts"],
        numFiles: 1,
        numLines: 7,
      },
    });
    expect(visibleTimelineItems(state).at(-1)?.text).toBe("Grep foo -> 7 lines");

    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call: { providerToolCallId: "call_1", name: "Grep", args: { pattern: "foo" } },
      raw: {
        kind: "grep",
        ok: true,
        pattern: "foo",
        mode: "count",
        filenames: ["a.ts", "b.ts"],
        numFiles: 2,
        numMatches: 9,
      },
    });
    expect(visibleTimelineItems(state).at(-1)?.text).toBe(
      "Grep foo -> 9 matches across 2 files",
    );

    state = applyAgentEvent(state, {
      type: "tool.finished",
      iterationNumber: 1,
      call: { providerToolCallId: "call_1", name: "Grep", args: { pattern: "foo" } },
      ok: true,
    });
    expect(visibleTimelineItems(state).at(-1)?.status).toBe("ok");
  });

  test("shows a bounded notice after a context surface refresh", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    state = applyAgentEvent(state, {
      type: "context.revision.finished",
      data: {
        strategy: "surface_refresh",
        reason: "resume",
        baseRevisionNumber: 1,
        revisionNumber: 2,
        changed: ["project_instruction", "tool_definitions"],
        toolCountBefore: 10,
        toolCountAfter: 11,
        measuredAnchorCleared: true,
        durationMs: 1.25,
      },
    });

    const items = visibleTimelineItems(state);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: "context",
      text: "runtime context refreshed on resume -> project instruction, tool definitions",
      status: "info",
    });
  });
});

describe("bash detail in timeline", () => {
  test("attaches the command on tool.started and the output preview on raw result", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    const call = {
      providerToolCallId: "call_1",
      name: "Bash",
      args: { command: "git status", description: "Show working tree status" },
    };

    state = applyAgentEvent(state, { type: "tool.started", iterationNumber: 1, call });
    expect(visibleTimelineItems(state).at(-1)?.text).toBe(
      "Bash Show working tree status",
    );
    expect(visibleTimelineItems(state).at(-1)?.bash).toEqual({ command: "git status" });

    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call,
      raw: {
        kind: "bash",
        ok: true,
        command: "git status",
        status: "completed",
        exitCode: 0,
        preview: "On branch main\nnothing to commit, working tree clean",
        outputLines: 2,
        outputBytes: 52,
        truncated: false,
        outputFilePath: "/tmp/task-1.log",
      },
    });

    expect(visibleTimelineItems(state).at(-1)?.text).toBe(
      "Bash Show working tree status -> exit 0",
    );
    expect(visibleTimelineItems(state).at(-1)?.bash).toEqual({
      command: "git status",
      outputPreview: ["On branch main", "nothing to commit, working tree clean"],
      omittedOutputLines: 0,
      outputFilePath: "/tmp/task-1.log",
    });
  });

  test("caps successful output at 5 tail lines and reports omitted lines", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    const call = {
      providerToolCallId: "call_1",
      name: "Bash",
      args: { command: "bun test" },
    };
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);

    state = applyAgentEvent(state, { type: "tool.started", iterationNumber: 1, call });
    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call,
      raw: {
        kind: "bash",
        ok: true,
        command: "bun test",
        status: "completed",
        exitCode: 0,
        preview: lines.join("\n"),
        outputLines: 12,
        outputBytes: 100,
        truncated: false,
        outputFilePath: "/tmp/task-2.log",
      },
    });

    expect(visibleTimelineItems(state).at(-1)?.bash?.outputPreview).toEqual([
      "line 8",
      "line 9",
      "line 10",
      "line 11",
      "line 12",
    ]);
    expect(visibleTimelineItems(state).at(-1)?.bash?.omittedOutputLines).toBe(7);
  });

  test("widens the output preview to 15 tail lines on failure", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    const call = {
      providerToolCallId: "call_1",
      name: "Bash",
      args: { command: "bun test" },
    };
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);

    state = applyAgentEvent(state, { type: "tool.started", iterationNumber: 1, call });
    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call,
      raw: {
        kind: "bash",
        ok: false,
        command: "bun test",
        status: "failed",
        exitCode: 1,
        preview: lines.join("\n"),
        outputLines: 20,
        outputBytes: 160,
        truncated: false,
        outputFilePath: "/tmp/task-3.log",
      },
    });

    expect(visibleTimelineItems(state).at(-1)?.bash?.outputPreview).toHaveLength(15);
    expect(visibleTimelineItems(state).at(-1)?.bash?.outputPreview?.at(0)).toBe(
      "line 6",
    );
    expect(visibleTimelineItems(state).at(-1)?.bash?.omittedOutputLines).toBe(5);
  });

  test("strips ANSI escapes and control characters from the output preview", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    const call = {
      providerToolCallId: "call_1",
      name: "Bash",
      args: { command: "ls" },
    };

    state = applyAgentEvent(state, { type: "tool.started", iterationNumber: 1, call });
    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call,
      raw: {
        kind: "bash",
        ok: true,
        command: "ls",
        status: "completed",
        exitCode: 0,
        preview: "\u001b[32mgreen\u001b[0m\ttext\u0007",
        outputLines: 1,
        outputBytes: 20,
        truncated: false,
        outputFilePath: "/tmp/task-4.log",
      },
    });

    expect(visibleTimelineItems(state).at(-1)?.bash?.outputPreview).toEqual([
      "green  text",
    ]);
  });

  test("keeps the started command when the raw result carries no bash detail", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    const call = {
      providerToolCallId: "call_1",
      name: "Bash",
      args: { command: "false" },
    };

    state = applyAgentEvent(state, { type: "tool.started", iterationNumber: 1, call });
    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call,
      raw: {
        kind: "bash",
        ok: false,
        command: "",
        error: "Bash.command must be a non-empty string.",
      },
    });

    expect(visibleTimelineItems(state).at(-1)?.bash).toEqual({ command: "false" });
  });
});

describe("edit diff in timeline", () => {
  test("attaches diff hunks and change counts from Edit raw results", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    const call = {
      providerToolCallId: "call_1",
      name: "Edit",
      args: { file_path: "notes.txt" },
    };
    const patch = [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [" alpha", "-beta", "+delta", " gamma"],
      },
    ];

    state = applyAgentEvent(state, { type: "tool.started", iterationNumber: 1, call });
    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call,
      raw: {
        kind: "edit",
        ok: true,
        filePath: "notes.txt",
        patch,
        patchTruncated: false,
      },
    });

    expect(visibleTimelineItems(state).at(-1)?.text).toBe("Edit notes.txt -> +1 -1");
    expect(visibleTimelineItems(state).at(-1)?.diff).toEqual(patch);
    expect(visibleTimelineItems(state).at(-1)?.diffTruncated).toBe(false);
  });

  test("marks new files in Write summaries", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    const call = {
      providerToolCallId: "call_1",
      name: "Write",
      args: { file_path: "fresh.txt" },
    };

    state = applyAgentEvent(state, { type: "tool.started", iterationNumber: 1, call });
    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call,
      raw: {
        kind: "write",
        ok: true,
        filePath: "fresh.txt",
        created: true,
        patch: [
          { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+hello"] },
        ],
        patchTruncated: false,
      },
    });

    expect(visibleTimelineItems(state).at(-1)?.text).toBe(
      "Write fresh.txt -> +1 -0 (new file)",
    );
    expect(visibleTimelineItems(state).at(-1)?.diff).toHaveLength(1);
  });
});

describe("delete summaries in timeline", () => {
  test("shows deleted on success without attaching a diff", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    const call = {
      providerToolCallId: "call_1",
      name: "Delete",
      args: { file_path: "obsolete.ts" },
    };

    state = applyAgentEvent(state, { type: "tool.started", iterationNumber: 1, call });
    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call,
      raw: {
        kind: "delete",
        ok: true,
        filePath: "obsolete.ts",
        absolutePath: "/tmp/workspace/obsolete.ts",
      },
    });

    expect(visibleTimelineItems(state).at(-1)?.text).toBe(
      "Delete obsolete.ts -> deleted",
    );
    expect(visibleTimelineItems(state).at(-1)?.diff).toBeUndefined();
  });

  test("shows the Delete failure reason", () => {
    let state = createInitialTuiState({
      sessionId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    const call = {
      providerToolCallId: "call_1",
      name: "Delete",
      args: { file_path: "missing.ts" },
    };

    state = applyAgentEvent(state, { type: "tool.started", iterationNumber: 1, call });
    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      iterationNumber: 1,
      call,
      raw: {
        kind: "delete",
        ok: false,
        filePath: "missing.ts",
        error: "File does not exist.",
      },
    });

    expect(visibleTimelineItems(state).at(-1)?.text).toBe(
      "Delete missing.ts -> File does not exist.",
    );
    expect(visibleTimelineItems(state).at(-1)?.diff).toBeUndefined();
  });
});
