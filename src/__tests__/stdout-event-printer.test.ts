import { describe, expect, test } from "bun:test";
import { StdoutEventPrinter } from "../events/stdout-event-printer";
import { createTestRuntime } from "./test-runtime";

describe("stdout event printer", () => {
  test("prints run cancellation separately from failures", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const printer = new StdoutEventPrinter(
      { write: (chunk: string) => output.push(chunk) },
      { write: (chunk: string) => errors.push(chunk) },
    );

    const runtime = createTestRuntime(printer);
    await runtime.runtimeSession.append({
      type: "turn.cancelled",
      ...runtime.iteration,
      data: {
        cancellation: {
          source: "user",
          phase: "tool_execution",
          iterationId: runtime.iteration.iterationId,
          iterationNumber: 1,
          toolName: "Bash",
        },
      },
    });

    expect(output.join("")).toBe(
      "turn.cancelled phase=tool_execution iteration=1 tool=Bash\n",
    );
    expect(errors).toEqual([]);
  });

  test("shows the pattern for Grep tool events", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const printer = new StdoutEventPrinter(
      { write: (chunk: string) => stdout.push(chunk) },
      { write: (chunk: string) => stderr.push(chunk) },
    );

    const runtime = createTestRuntime(printer);
    const call = runtime.toolCall({
      providerToolCallId: "provider-call-1",
      name: "Grep",
      args: { pattern: "foo" },
    });
    await runtime.runtimeSession.append({
      type: "tool.started",
      ...call,
      data: { call },
    });
    await runtime.runtimeSession.append({
      type: "tool.finished",
      ...call,
      data: { call, ok: true },
    });

    expect(stdout).toEqual([
      "tool.started name=Grep pattern=foo\n",
      "tool.finished name=Grep pattern=foo ok=true\n",
    ]);
    expect(stderr).toEqual([]);
  });

  test("prints a unified diff for Edit raw results with a patch", async () => {
    const stdout: string[] = [];
    const printer = new StdoutEventPrinter(
      { write: (chunk: string) => stdout.push(chunk) },
      { write: () => undefined },
    );

    const runtime = createTestRuntime(printer);
    const call = runtime.toolCall({
      providerToolCallId: "provider-call-1",
      name: "Edit",
      args: { file_path: "notes.txt" },
    });
    await runtime.runtimeSession.append({
      type: "tool.raw_result",
      ...call,
      data: {
        call,
        raw: {
          kind: "edit",
          ok: true,
          filePath: "notes.txt",
          patch: [
            {
              oldStart: 1,
              oldLines: 3,
              newStart: 1,
              newLines: 3,
              lines: [" alpha", "-beta", "+delta", " gamma"],
            },
          ],
          patchTruncated: false,
        },
      },
    });

    expect(stdout).toEqual([
      [
        "tool.diff name=Edit path=notes.txt +1 -1",
        "@@ -1,3 +1,3 @@",
        " alpha",
        "-beta",
        "+delta",
        " gamma",
      ].join("\n") + "\n",
    ]);
  });

  test("prints the command and output preview for Bash raw results", async () => {
    const stdout: string[] = [];
    const printer = new StdoutEventPrinter(
      { write: (chunk: string) => stdout.push(chunk) },
      { write: () => undefined },
    );

    const lines = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`);
    const runtime = createTestRuntime(printer);
    const call = runtime.toolCall({
      providerToolCallId: "provider-call-1",
      name: "Bash",
      args: { command: "bun test", description: "Run the test suite" },
    });
    await runtime.runtimeSession.append({
      type: "tool.raw_result",
      ...call,
      data: {
        call,
        raw: {
          kind: "bash",
          ok: true,
          command: "bun test",
          taskId: "task-1",
          sessionId: runtime.runtimeSession.sessionId,
          status: "completed",
          exitCode: 0,
          preview: lines.join("\n"),
          outputLines: 8,
          outputBytes: 60,
          truncated: false,
          outputFilePath: "/tmp/task-1.log",
          cwd: "/tmp",
        },
      },
    });

    expect(stdout).toEqual([
      [
        "$ bun test",
        "line 4",
        "line 5",
        "line 6",
        "line 7",
        "line 8",
        "… +3 lines (full output: /tmp/task-1.log)",
      ].join("\n") + "\n",
    ]);
  });

  test("ignores raw results without a patch", async () => {
    const stdout: string[] = [];
    const printer = new StdoutEventPrinter(
      { write: (chunk: string) => stdout.push(chunk) },
      { write: () => undefined },
    );

    const runtime = createTestRuntime(printer);
    const readCall = runtime.toolCall({
      providerToolCallId: "provider-call-1",
      name: "Read",
      args: { file_path: "notes.txt" },
    });
    await runtime.runtimeSession.append({
      type: "tool.raw_result",
      ...readCall,
      data: {
        call: readCall,
        raw: { kind: "read", ok: true, filePath: "notes.txt", content: "alpha" },
      },
    });
    const editCall = runtime.toolCall({
      providerToolCallId: "provider-call-2",
      name: "Edit",
      args: { file_path: "notes.txt" },
    });
    await runtime.runtimeSession.append({
      type: "tool.raw_result",
      ...editCall,
      data: {
        call: editCall,
        raw: {
          kind: "edit",
          ok: false,
          filePath: "notes.txt",
          error: "old_string was not found.",
        },
      },
    });

    expect(stdout).toEqual([]);
  });

  test("prints task tool results and background lifecycle events", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const printer = new StdoutEventPrinter(
      { write: (chunk: string) => stdout.push(chunk) },
      { write: (chunk: string) => stderr.push(chunk) },
    );
    const runtime = createTestRuntime(printer);
    const call = runtime.toolCall({
      providerToolCallId: "provider-call-1",
      name: "TaskStop",
      args: { task_id: "task-1" },
    });
    const task = {
      taskId: "task-1",
      origin: call,
      command: "sleep 30",
      description: "Run server",
      status: "running" as const,
      startedAt: "2026-07-10T10:00:00.000Z",
      backgroundedAt: "2026-07-10T10:00:00.010Z",
      backgroundReason: "requested" as const,
      outputFilePath: "/tmp/task-1.log",
      outputBytes: 0,
      outputLines: 0,
      cwd: "/tmp",
    };

    await runtime.runtimeSession.append({
      type: "bash.task.backgrounded",
      ...call,
      data: { task },
    });
    await runtime.runtimeSession.append({
      type: "tool.started",
      ...call,
      data: { call },
    });
    await runtime.runtimeSession.append({
      type: "tool.raw_result",
      ...call,
      data: {
        call,
        raw: {
          kind: "task_stop",
          ok: true,
          taskId: "task-1",
          status: "killed",
          task: { ...task, status: "killed", signal: "SIGTERM" },
        },
      },
    });

    const output = stdout.join("");
    expect(output).toContain("bash.task.backgrounded task=task-1 status=running");
    expect(output).toContain("tool.started name=TaskStop task=task-1");
    expect(output).toContain("task.stop task=task-1 status=killed signal=SIGTERM");
    expect(stderr).toEqual([]);
  });
});
