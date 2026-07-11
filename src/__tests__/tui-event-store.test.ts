import { describe, expect, test } from "bun:test";
import {
  applyAgentEvent as applyAgentEventCore,
  createInitialTuiState,
  type TuiState,
} from "../tui/event-store";
import type { AgentEvent } from "../events/types";
import type { ToolCall } from "../agent/types";
import { createTestRuntime } from "./test-runtime";

const testRuntime = createTestRuntime();
const toolCalls = new Map<string, ReturnType<typeof testRuntime.toolCall>>();
let eventSequence = 0;

type TestEventInput = Record<string, unknown> & { type: string };

function applyAgentEvent(state: TuiState, input: TestEventInput): TuiState {
  return applyAgentEventCore(state, testEvent(input));
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
      },
    };
  }
  if (input.type === "turn.started") {
    const promptInput = recordValue(input.input);
    return {
      ...base,
      ...testRuntime.turn,
      type: "turn.started",
      data: { userPrompt: stringValue(promptInput.userPrompt) ?? "prompt" },
    };
  }
  if (input.type === "model.request.started") {
    return {
      ...base,
      ...testRuntime.iteration,
      type: "model.request.started",
      data: {},
    };
  }
  if (input.type === "model.request.finished") {
    return {
      ...base,
      ...testRuntime.iteration,
      type: "model.request.finished",
      data: { output: input.output },
    } as unknown as AgentEvent;
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
      data: { result: input.result },
    } as AgentEvent;
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
  throw new Error(`Unsupported test event: ${input.type}`);
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
    expect(state.timeline).toEqual([]);

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
    expect(state.timeline.at(-1)?.text).toBe("TaskList -> 2 tasks, 1 running");

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
    expect(state.timeline.at(-1)?.text).toBe("TaskOutput task-1 -> running, 2 lines");
    expect(state.timeline.at(-1)?.bash?.outputPreview).toEqual(["starting", "ready"]);
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
    expect(state.timeline.at(-1)?.text).toContain("README.md");
    expect(state.timeline.at(-1)?.status).toBe("ok");

    state = applyAgentEvent(state, {
      type: "turn.finished",
      finishedAt: "2026-07-06T00:03:27.000Z",
      result: { status: "completed", finalText: "done", messages: [] },
    });
    expect(state.status).toBe("done");
    expect(state.workedForMs).toBe(207_000);
    expect(state.finalText).toBe("done");
    expect(state.timeline.at(-1)?.label).toBe("assistant");
    expect(state.timeline.at(-1)?.text).toBe("done");
    expect(state.timeline.at(-1)?.status).toBe("text");

    state = applyAgentEvent(state, {
      type: "turn.failed",
      error: "failed",
    });
    expect(state.status).toBe("failed");
    expect(state.error).toBe("failed");
    expect(state.timeline.at(-1)?.label).toBe("error");
    expect(state.timeline.at(-1)?.text).toBe("failed");
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
      result: { status: "completed", finalText: "first done", messages: [] },
    });
    state = applyAgentEvent(state, {
      type: "turn.started",
      sessionId: "run-1",
      createdAt: "2026-07-06T00:01:00.000Z",
      input: { userPrompt: "second" },
    });

    expect(state.status).toBe("running");
    expect(state.workedForMs).toBeUndefined();
    expect(state.timeline.map((item) => item.text)).toEqual([
      "first",
      "first done",
      "second",
    ]);
    expect(state.timeline.map((item) => item.label)).toEqual([
      "prompt",
      "assistant",
      "prompt",
    ]);
    expect(new Set(state.timeline.map((item) => item.id)).size).toBe(3);
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
    expect(state.timeline.at(-1)?.status).toBe("cancelled");
    expect(state.timeline.at(-1)?.text).toContain("cancelled");

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
    expect(state.timeline.at(-1)?.status).toBe("cancelled");
    expect(state.timeline.at(-1)?.text).toContain("Bash");
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

    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]?.text).toBe("model iteration 1 -> 2 tool calls");
    expect(state.timeline[0]?.status).toBe("ok");

    state = applyAgentEvent(state, {
      type: "assistant.progress",
      iterationNumber: 1,
      content: "I will inspect the matching tests.",
    });
    expect(state.timeline).toHaveLength(2);
    expect(state.timeline[1]).toMatchObject({
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

    expect(state.timeline).toHaveLength(3);
    expect(state.timeline[2]?.text).toBe("Glob **/*.test.ts -> 5 matches");
    expect(state.timeline[2]?.status).toBe("ok");
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
    expect(state.timeline.at(-1)?.text).toBe("Grep foo");
    expect(state.timeline.at(-1)?.status).toBe("running");

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
    expect(state.timeline.at(-1)?.text).toBe("Grep foo -> 2 files");

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
    expect(state.timeline.at(-1)?.text).toBe("Grep foo -> 7 lines");

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
    expect(state.timeline.at(-1)?.text).toBe("Grep foo -> 9 matches across 2 files");

    state = applyAgentEvent(state, {
      type: "tool.finished",
      iterationNumber: 1,
      call: { providerToolCallId: "call_1", name: "Grep", args: { pattern: "foo" } },
      ok: true,
    });
    expect(state.timeline.at(-1)?.status).toBe("ok");
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
    expect(state.timeline.at(-1)?.text).toBe("Bash Show working tree status");
    expect(state.timeline.at(-1)?.bash).toEqual({ command: "git status" });

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

    expect(state.timeline.at(-1)?.text).toBe("Bash Show working tree status -> exit 0");
    expect(state.timeline.at(-1)?.bash).toEqual({
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

    expect(state.timeline.at(-1)?.bash?.outputPreview).toEqual([
      "line 8",
      "line 9",
      "line 10",
      "line 11",
      "line 12",
    ]);
    expect(state.timeline.at(-1)?.bash?.omittedOutputLines).toBe(7);
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

    expect(state.timeline.at(-1)?.bash?.outputPreview).toHaveLength(15);
    expect(state.timeline.at(-1)?.bash?.outputPreview?.at(0)).toBe("line 6");
    expect(state.timeline.at(-1)?.bash?.omittedOutputLines).toBe(5);
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

    expect(state.timeline.at(-1)?.bash?.outputPreview).toEqual(["green  text"]);
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

    expect(state.timeline.at(-1)?.bash).toEqual({ command: "false" });
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

    expect(state.timeline.at(-1)?.text).toBe("Edit notes.txt -> +1 -1");
    expect(state.timeline.at(-1)?.diff).toEqual(patch);
    expect(state.timeline.at(-1)?.diffTruncated).toBe(false);
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

    expect(state.timeline.at(-1)?.text).toBe("Write fresh.txt -> +1 -0 (new file)");
    expect(state.timeline.at(-1)?.diff).toHaveLength(1);
  });
});
