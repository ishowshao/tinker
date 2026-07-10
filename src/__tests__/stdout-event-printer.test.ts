import { describe, expect, test } from "bun:test";
import { StdoutEventPrinter } from "../events/stdout-event-printer";

describe("stdout event printer", () => {
  test("shows the pattern for Grep tool events", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const printer = new StdoutEventPrinter(
      { write: (chunk: string) => stdout.push(chunk) },
      { write: (chunk: string) => stderr.push(chunk) },
    );

    await printer.append({
      type: "tool.started",
      step: 1,
      call: { id: "call_1", name: "Grep", args: { pattern: "foo" } },
    });
    await printer.append({
      type: "tool.finished",
      step: 1,
      call: { id: "call_1", name: "Grep", args: { pattern: "foo" } },
      ok: true,
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

    await printer.append({
      type: "tool.raw_result",
      step: 1,
      call: { id: "call_1", name: "Edit", args: { file_path: "notes.txt" } },
      raw: {
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
    await printer.append({
      type: "tool.raw_result",
      step: 1,
      call: {
        id: "call_1",
        name: "Bash",
        args: { command: "bun test", description: "Run the test suite" },
      },
      raw: {
        ok: true,
        command: "bun test",
        status: "completed",
        exitCode: 0,
        preview: lines.join("\n"),
        outputLines: 8,
        outputBytes: 60,
        truncated: false,
        outputFilePath: "/tmp/task-1.log",
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

    await printer.append({
      type: "tool.raw_result",
      step: 1,
      call: { id: "call_1", name: "Read", args: { file_path: "notes.txt" } },
      raw: { ok: true, filePath: "notes.txt", content: "alpha" },
    });
    await printer.append({
      type: "tool.raw_result",
      step: 1,
      call: { id: "call_2", name: "Edit", args: { file_path: "notes.txt" } },
      raw: { ok: false, filePath: "notes.txt", error: "old_string was not found." },
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
    const task = {
      taskId: "task-1",
      runId: "run-1",
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

    await printer.append({ type: "bash.task.backgrounded", task });
    const call = {
      id: "call_1",
      name: "TaskStop",
      args: { task_id: "task-1" },
    };
    await printer.append({ type: "tool.started", step: 1, call });
    await printer.append({
      type: "tool.raw_result",
      step: 1,
      call,
      raw: {
        ok: true,
        taskId: "task-1",
        status: "killed",
        task: { ...task, status: "killed", signal: "SIGTERM" },
      },
    });

    const output = stdout.join("");
    expect(output).toContain("bash.task.backgrounded task=task-1 status=running");
    expect(output).toContain("tool.started name=TaskStop task=task-1");
    expect(output).toContain("task.stop task=task-1 status=killed signal=SIGTERM");
    expect(stderr).toEqual([]);
  });
});
