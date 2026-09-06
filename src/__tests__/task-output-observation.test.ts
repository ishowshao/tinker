import { describe, expect, test } from "bun:test";
import { ObservationBuilder } from "../observation/observation-builder";
import type { ShellTaskSnapshot } from "../tools/bash-task";
import type { TaskInputRawResult, TaskOutputRawResult } from "../tools/types";
import { createTestRuntime } from "./test-runtime";

const call = createTestRuntime().toolCall({
  name: "TaskOutput",
  args: { task_id: "task-output-test" },
});

function taskOutput(
  taskOverrides: Partial<ShellTaskSnapshot> = {},
): TaskOutputRawResult {
  const task: ShellTaskSnapshot = {
    taskId: "task-output-test",
    origin: call,
    command: "test-command",
    description: "Test task output observation",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    outputFilePath: "/tmp/task-output-test.log",
    outputBytes: 6,
    outputLines: 1,
    cwd: "/tmp",
    tty: false,
    ...taskOverrides,
  };
  return {
    ok: true,
    taskId: task.taskId,
    task,
    status: task.status,
    command: task.command,
    outputBytes: task.outputBytes,
    outputLines: task.outputLines,
    outputFilePath: task.outputFilePath,
    preview: "ready",
    truncated: false,
    ...(task.tty ? { screenRows: 24, screenColumns: 80, screen: "prompt>" } : {}),
  };
}

function observe(raw: TaskOutputRawResult) {
  return new ObservationBuilder().build({
    call,
    raw: { kind: "task_output", ...raw },
  });
}

describe.each([false, true])("TaskOutput termination details (tty=%s)", (tty) => {
  test.each([
    { status: "completed", exitCode: 0 },
    { status: "failed", exitCode: 2 },
    { status: "killed", signal: "SIGTERM" },
    { status: "failed", error: "Output collection failed." },
    { status: "failed", exitCode: 2, error: "Output cleanup failed." },
  ] satisfies Partial<ShellTaskSnapshot>[])("reports %j", (termination) => {
    const raw = taskOutput({ tty, ...termination });
    const observation = observe(raw);
    const expectedDetails = Object.entries(termination)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    expect(observation.displayText).toContain(`\n${expectedDetails}\ncommand=`);
    expect(observation.displayText).toStartWith("Task output retrieved.");
    expect(observation.content).toEqual([
      { type: "text", text: observation.displayText },
    ]);
    for (const key of ["exitCode", "signal", "error"] as const) {
      if (!(key in termination)) {
        expect(observation.displayText).not.toContain(`\n${key}=`);
      }
    }
  });

  test.each([
    "running",
    "stopping",
  ] as const)("does not invent termination details for %s tasks", (status) => {
    const text = observe(taskOutput({ tty, status })).displayText;
    expect(text).toContain(`status=${status}`);
    expect(text).not.toContain("exitCode=");
    expect(text).not.toContain("signal=");
    expect(text).not.toContain("error=");
  });
});

describe("TaskInput log statistics", () => {
  test.each([
    ["", "Terminal screen polled."],
    ["ok\n", "Terminal input sent."],
  ])("aligns polling and input observations for chars=%j", (chars, summary) => {
    const output = taskOutput({ tty: true, outputBytes: 60_000, outputLines: 1_000 });
    if (output.task === undefined) {
      throw new Error("Expected a task snapshot.");
    }
    const inputCall = createTestRuntime().toolCall({
      name: "TaskInput",
      args: { task_id: output.taskId, chars },
    });
    const raw: TaskInputRawResult = {
      ok: true,
      taskId: output.taskId,
      task: output.task,
      status: output.task.status,
      writtenBytes: Buffer.byteLength(chars),
      waitedMs: 250,
      screenRows: 24,
      screenColumns: 80,
      screen: "prompt>",
      outputBytes: output.task.outputBytes,
      outputLines: output.task.outputLines,
      outputFilePath: output.task.outputFilePath,
    };
    const original = structuredClone(raw);
    const observation = new ObservationBuilder().build({
      call: inputCall,
      raw: { kind: "task_input", ...raw },
    });

    expect(observation.displayText).toBe(
      [
        summary,
        "taskId=task-output-test",
        "status=running",
        `writtenBytes=${Buffer.byteLength(chars)}`,
        "waitedMs=250",
        "screen=80x24",
        "outputFilePath=/tmp/task-output-test.log",
        "logBytes=60000",
        "logLines=1000",
        "current screen:",
        "prompt>",
      ].join("\n"),
    );
    const logMetadata = (text: string) =>
      text.split("\n").filter((line) => /^log(Bytes|Lines)=/.test(line));
    expect(logMetadata(observation.displayText)).toEqual(
      logMetadata(observe(output).displayText),
    );
    expect(observation.content).toEqual([
      { type: "text", text: observation.displayText },
    ]);
    expect(raw).toEqual(original);
  });
});

describe("TaskOutput output representations", () => {
  test("explains byte-limited ranges without implying head/tail omission", () => {
    const raw = taskOutput();
    raw.outputLines = 1_000;
    raw.range = {
      offset: 100,
      limit: 500,
      displayedStartLine: 100,
      displayedEndLine: 280,
    };
    raw.truncated = true;
    raw.omittedLines = 319;
    raw.preview = "100: first\n...";
    const observation = observe(raw);
    expect(observation.displayText).toContain(
      "outputLines=1000\ntruncated=true\nomittedLines=319",
    );
    expect(observation.displayText).toContain(
      "offset=100\nlimit=500\ndisplayedLines=100-280",
    );
    expect(observation.displayText).toContain(
      "Requested output shortened by byte limits.",
    );
    expect(observation.displayText).toEndWith(`output:\n${raw.preview}`);
    expect(observation.content).toEqual([
      { type: "text", text: observation.displayText },
    ]);
  });

  test("preserves the ordinary log preview and its metadata", () => {
    const raw = taskOutput();
    raw.outputBytes = 60_000;
    raw.outputLines = 1_000;
    raw.truncated = true;
    raw.omittedLines = 800;
    raw.preview = "first line\n... omitted ...\nlast line";

    expect(observe(raw).displayText).toBe(
      [
        "Task output retrieved.",
        "taskId=task-output-test",
        "status=running",
        "command=test-command",
        "tty=false",
        "outputFilePath=/tmp/task-output-test.log",
        "outputBytes=60000",
        "outputLines=1000",
        "truncated=true",
        "omittedLines=800",
        "preview:",
        raw.preview,
      ].join("\n"),
    );
  });

  test.each([
    false,
    true,
  ])("separates the PTY screen from log preview metadata (truncated=%s)", (truncated) => {
    const raw = taskOutput({ tty: true, status: "completed", exitCode: 0 });
    raw.outputBytes = 60_000;
    raw.outputLines = 1_000;
    raw.truncated = truncated;
    raw.omittedLines = truncated ? 800 : undefined;
    raw.preview = "Raw log preview must not be rendered.";
    const original = structuredClone(raw);
    const observation = observe(raw);

    expect(observation.displayText).toBe(
      [
        "Task output retrieved.",
        "taskId=task-output-test",
        "status=completed",
        "exitCode=0",
        "command=test-command",
        "tty=true",
        "outputFilePath=/tmp/task-output-test.log",
        "logBytes=60000",
        "logLines=1000",
        "screen=80x24",
        "current screen:",
        "prompt>",
      ].join("\n"),
    );
    expect(observation.content).toEqual([
      { type: "text", text: observation.displayText },
    ]);
    expect(raw).toEqual(original);
  });

  test("retains untruncated ordinary preview metadata", () => {
    const text = observe(taskOutput()).displayText;
    expect(text).toContain("truncated=false\npreview:\nready");
    expect(text).not.toContain("omittedLines=");
  });

  test("distinguishes a lookup failure from a failed shell task", () => {
    const observation = observe({
      ok: false,
      taskId: "missing",
      error: "Unknown task ID: missing",
    });
    expect(observation.displayText).toBe(
      "TaskOutput failed for missing: Unknown task ID: missing",
    );
    expect(observation.content).toEqual([
      { type: "text", text: observation.displayText },
    ]);
  });
});
