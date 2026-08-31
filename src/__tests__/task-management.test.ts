import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCall } from "../agent/types";
import {
  createTestHistoryReader,
  createTestRuntime,
  type TestToolCallInput,
} from "./test-runtime";
import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import { ObservationBuilder } from "../observation/observation-builder";
import { TurnCancelledError } from "../agent/turn-cancellation";
import { MAX_PREVIEW_BYTES } from "../tools/bounded-output-preview";
import { createDefaultTooling as createDefaultToolingBase } from "../tools/registry";
import type {
  BashRawResult,
  TaskInputRawResult,
  TaskListRawResult,
  TaskOutputRawResult,
  TaskStopRawResult,
  ToolRawResult,
  ToolExecutionContext,
} from "../tools/types";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

const testToolContext: ToolExecutionContext = {
  signal: new AbortController().signal,
};

function createDefaultTooling(
  options: Omit<
    Parameters<typeof createDefaultToolingBase>[0],
    "runtimeSession" | "historyReader"
  > & {
    eventSink?: EventSink;
  },
) {
  const { eventSink, ...toolingOptions } = options;
  const testRuntime = createTestRuntime(eventSink);
  const tooling = createDefaultToolingBase({
    ...toolingOptions,
    runtimeSession: testRuntime.runtimeSession,
    historyReader: createTestHistoryReader(testRuntime.runtimeSession.sessionId),
  });
  return {
    ...tooling,
    runtime: {
      execute: (
        call: TestToolCallInput | ToolCall,
        context: ToolExecutionContext = testToolContext,
      ) =>
        tooling.runtime.execute(
          "sessionId" in call ? call : testRuntime.toolCall(call),
          context,
        ),
    },
    testRuntime,
  };
}

type TestTooling = ReturnType<typeof createDefaultTooling>;

class ArrayEventSink implements EventSink {
  readonly events: AgentEvent[] = [];

  async append(event: AgentEvent): Promise<void> {
    this.events.push(event);
  }
}

describe("background task management", () => {
  test("registers task tools and validates their arguments", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tasks-"));
    const tooling = createDefaultTooling({ workspaceRoot: workspace });

    try {
      const definitions = tooling.registry.definitions();
      const names = definitions.map((definition) => definition.name);
      expect(names).toContain("TaskList");
      expect(names).toContain("TaskOutput");
      expect(names).toContain("TaskInput");
      expect(names).toContain("TaskStop");
      expect(
        definitions.find((definition) => definition.name === "TaskList")?.parameters,
      ).toMatchObject({ additionalProperties: false, properties: {} });

      const invalidList = asTaskList(
        await tooling.runtime.execute({
          providerToolCallId: "call_1",
          name: "TaskList",
          args: { unexpected: true },
        }),
      );
      expect(invalidList.ok).toBe(false);
      expect(invalidList.error).toContain("unexpected");

      const invalidOutput = asTaskOutput(
        await tooling.runtime.execute({
          providerToolCallId: "call_2",
          name: "TaskOutput",
          args: {},
        }),
      );
      expect(invalidOutput.ok).toBe(false);
      expect(invalidOutput.error).toContain("TaskOutput.task_id");

      const invalidInput = asTaskInput(
        await tooling.runtime.execute({
          providerToolCallId: "call_input_invalid",
          name: "TaskInput",
          args: { task_id: "task", chars: "", wait_ms: 30_001 },
        }),
      );
      expect(invalidInput.ok).toBe(false);
      expect("error" in invalidInput ? invalidInput.error : "").toContain(
        "between 0 and 30000",
      );

      const invalidInputCases = [
        { args: null, expected: "must be an object" },
        {
          args: { task_id: "task", chars: "", extra: true },
          expected: "unexpected argument",
        },
        { args: { task_id: "", chars: "" }, expected: "non-empty string" },
        { args: { task_id: "task", chars: 1 }, expected: "chars must be a string" },
      ];
      for (const [index, testCase] of invalidInputCases.entries()) {
        const result = asTaskInput(
          await tooling.runtime.execute({
            providerToolCallId: `call_input_case_${index}`,
            name: "TaskInput",
            args: testCase.args,
          }),
        );
        expect(result.ok).toBe(false);
        expect("error" in result ? result.error : "").toContain(testCase.expected);
      }

      const unknownInput = asTaskInput(
        await tooling.runtime.execute({
          providerToolCallId: "call_input_unknown",
          name: "TaskInput",
          args: { task_id: "missing-task", chars: "" },
        }),
      );
      expect(unknownInput.ok).toBe(false);
      expect("error" in unknownInput ? unknownInput.error : "").toContain(
        "Unknown task ID: missing-task",
      );

      const unknownStop = asTaskStop(
        await tooling.runtime.execute({
          providerToolCallId: "call_3",
          name: "TaskStop",
          args: { task_id: "missing-task" },
        }),
      );
      expect(unknownStop.ok).toBe(false);
      expect(unknownStop.error).toContain("Unknown task ID: missing-task");
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("drives a Python REPL through a bounded terminal screen", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-pty-task-"));
    const confirmations: string[] = [];
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      taskStopGraceMs: 100,
      bashGuard: {
        surface: "tui",
        confirm: async (_call, request) => {
          confirmations.push(request.command);
          return "allow";
        },
      },
    });

    try {
      const repl = asBash(
        await tooling.runtime.execute({
          providerToolCallId: "call_repl",
          name: "Bash",
          args: {
            command: "python3 -q",
            description: "Start Python REPL",
            tty: true,
            timeout: 25,
          },
        }),
      );
      expect(repl.ok).toBe(true);
      expect(repl.status).toBe("running");
      expect(repl.tty).toBe(true);
      expect(repl.backgroundedDueToTimeout).toBe(true);
      expect(confirmations).toEqual([]);

      const ready = await waitForTerminalScreen(tooling, repl.taskId, ">>>");
      expect(ready.task?.tty).toBe(true);
      expect(ready.screenRows).toBe(24);
      expect(ready.screenColumns).toBe(80);
      expect(ready.screen).not.toContain("\x1b");

      const evaluated = await sendTaskInput(
        tooling,
        repl.taskId,
        "print(6 * 7)\n",
        250,
      );
      expect(evaluated.ok).toBe(true);
      if (!evaluated.ok) {
        throw new Error(evaluated.error);
      }
      expect(evaluated.writtenBytes).toBe(Buffer.byteLength("print(6 * 7)\n"));
      expect(evaluated.waitedMs).toBeGreaterThanOrEqual(200);
      expect(evaluated.status).toBe("running");
      expect(evaluated.screen).toContain("42");
      expect(evaluated.screen).toContain(">>>");
      expect(evaluated.screen).not.toContain("\x1b");
      expect(await readFile(evaluated.outputFilePath, "utf8")).toContain("42");

      const list = await listTasks(tooling);
      expect(list.tasks[0]).toMatchObject({ taskId: repl.taskId, tty: true });

      const exited = await sendTaskInput(tooling, repl.taskId, "exit()\n", 500);
      expect(exited.ok).toBe(true);
      if (!exited.ok) {
        throw new Error(exited.error);
      }
      expect(exited.status).toBe("completed");
      expect(exited.screen).toContain("42");

      const finalPoll = await sendTaskInput(tooling, repl.taskId, "", 0);
      expect(finalPoll.ok).toBe(true);
      if (!finalPoll.ok) {
        throw new Error(finalPoll.error);
      }
      expect(finalPoll.status).toBe("completed");
      expect(finalPoll.screen).toBe(exited.screen);

      const rejected = await sendTaskInput(tooling, repl.taskId, "print(1)\n", 0);
      expect(rejected.ok).toBe(false);
      expect("error" in rejected ? rejected.error : "").toContain("status=completed");
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("sends Ctrl-C to the PTY foreground process without stopping the task", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-pty-task-"));
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      taskStopGraceMs: 100,
    });

    try {
      const repl = asBash(
        await tooling.runtime.execute({
          providerToolCallId: "call_ctrl_c_repl",
          name: "Bash",
          args: {
            command: "python3 -q",
            tty: true,
            run_in_background: true,
          },
        }),
      );
      await waitForTerminalScreen(tooling, repl.taskId, ">>>");

      const sleeping = await sendTaskInput(
        tooling,
        repl.taskId,
        "import time; time.sleep(30)\n",
        25,
      );
      expect(sleeping.ok).toBe(true);
      if (!sleeping.ok) {
        throw new Error(sleeping.error);
      }
      expect(sleeping.status).toBe("running");

      const interrupted = await sendTaskInput(tooling, repl.taskId, "\u0003", 250);
      expect(interrupted.ok).toBe(true);
      if (!interrupted.ok) {
        throw new Error(interrupted.error);
      }
      expect(interrupted.status).toBe("running");
      expect(interrupted.screen).toContain("KeyboardInterrupt");
      expect(interrupted.screen).toContain(">>>");

      const exited = await sendTaskInput(tooling, repl.taskId, "exit()\n", 500);
      expect(exited.ok).toBe(true);
      if (exited.ok) {
        expect(exited.status).toBe("completed");
      }
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("stops a PTY task and preserves its final screen", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-pty-task-"));
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      taskStopGraceMs: 100,
    });
    let childPid: number | undefined;

    try {
      const repl = asBash(
        await tooling.runtime.execute({
          providerToolCallId: "call_stop_repl",
          name: "Bash",
          args: {
            command: "python3 -q",
            tty: true,
            run_in_background: true,
          },
        }),
      );
      await waitForTerminalScreen(tooling, repl.taskId, ">>>");
      const marked = await sendTaskInput(
        tooling,
        repl.taskId,
        "import subprocess as s;p=s.Popen(['sleep','30']);print('child='+str(p.pid))\n",
        250,
      );
      expect(marked.ok).toBe(true);
      if (!marked.ok) {
        throw new Error(marked.error);
      }
      childPid = Number(marked.screen.match(/child=(\d+)/)?.[1]);
      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);

      const stopped = await stopTask(tooling, repl.taskId);
      expect(stopped.ok).toBe(true);
      expect(stopped.task).toMatchObject({ status: "killed", tty: true });
      expect(stopped.task?.signal).toBe("SIGTERM");
      await waitForProcessExit(childPid);

      const finalOutput = asTaskOutput(
        await tooling.runtime.execute({
          providerToolCallId: "call_stop_repl_output",
          name: "TaskOutput",
          args: { task_id: repl.taskId },
        }),
      );
      expect(finalOutput.status).toBe("killed");
      expect(finalOutput.screen).toContain(`child=${childPid}`);
      expect(finalOutput.screenRows).toBe(24);
      expect(finalOutput.screenColumns).toBe(80);
    } finally {
      await tooling.dispose();
      killProcessIfAlive(childPid);
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects pipe input and cancellation only stops the current PTY wait", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-pty-task-"));
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      taskStopGraceMs: 100,
    });

    try {
      const pipe = await startBackgroundSleep(tooling, "call_pipe");
      const pipeInput = await sendTaskInput(tooling, pipe.taskId, "hello\n", 0);
      expect(pipeInput.ok).toBe(false);
      expect("error" in pipeInput ? pipeInput.error : "").toContain("Bash tty=true");
      await stopTask(tooling, pipe.taskId);

      const repl = asBash(
        await tooling.runtime.execute({
          providerToolCallId: "call_cancel_repl",
          name: "Bash",
          args: {
            command: "python3 -q",
            tty: true,
            run_in_background: true,
          },
        }),
      );
      await waitForTerminalScreen(tooling, repl.taskId, ">>>");

      const controller = new AbortController();
      const pending = tooling.runtime.execute(
        {
          providerToolCallId: "call_cancel_input",
          name: "TaskInput",
          args: { task_id: repl.taskId, chars: "", wait_ms: 30_000 },
        },
        { signal: controller.signal },
      );
      await Bun.sleep(20);
      controller.abort(new TurnCancelledError("user"));
      expect(pending).rejects.toBeInstanceOf(TurnCancelledError);
      expect(tooling.taskManager.inspectTask(repl.taskId)?.task.status).toBe("running");

      const evaluated = await sendTaskInput(
        tooling,
        repl.taskId,
        "print('still alive')\n",
        250,
      );
      expect(evaluated.ok).toBe(true);
      if (!evaluated.ok) {
        throw new Error(evaluated.error);
      }
      expect(evaluated.screen).toContain("still alive");
      await sendTaskInput(tooling, repl.taskId, "exit()\n", 500);
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("lists only backgrounded tasks and updates natural completion", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tasks-"));
    const events = new ArrayEventSink();
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      eventSink: events,
      taskStopGraceMs: 50,
    });

    try {
      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Bash",
        args: { command: "echo foreground" },
      });
      expect((await listTasks(tooling)).tasks).toEqual([]);

      const background = asBash(
        await tooling.runtime.execute({
          providerToolCallId: "call_2",
          name: "Bash",
          args: {
            command: "echo ready; sleep 0.05; echo done",
            description: "Run short background task",
            run_in_background: true,
          },
        }),
      );

      const running = await listTasks(tooling);
      expect(running.tasks).toHaveLength(1);
      expect(running.tasks[0]).toMatchObject({
        taskId: background.taskId,
        status: "running",
        backgroundReason: "requested",
        description: "Run short background task",
        origin: {
          sessionId: tooling.testRuntime.runtimeSession.sessionId,
          providerToolCallId: "call_2",
          name: "Bash",
        },
      });

      const currentOutput = await waitForOutput(tooling, background.taskId, "ready");
      expect(currentOutput.outputFilePath).toBe(background.outputFilePath);
      expect(currentOutput.preview).toContain("ready");

      const completed = await waitForStatus(tooling, background.taskId, "completed");
      expect(completed.exitCode).toBe(0);
      expect(completed.endedAt).toBeString();

      const finalOutput = asTaskOutput(
        await tooling.runtime.execute({
          providerToolCallId: "call_3",
          name: "TaskOutput",
          args: { task_id: background.taskId },
        }),
      );
      expect(finalOutput.preview).toContain("done");
      expect(await readFile(background.outputFilePath, "utf8")).toBe("ready\ndone\n");

      await waitForEvent(events, "bash.task.finished");
      const eventTypes = events.events.map((event) => event.type);
      expect(eventTypes).toContain("bash.task.backgrounded");
      expect(eventTypes).toContain("bash.task.finished");
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("bounds running and completed TaskOutput with the same preview as Bash", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tasks-"));
    const tooling = createDefaultTooling({ workspaceRoot: workspace });
    const releaseFileName = "release-long-output";
    const python =
      'import sys; sys.stdout.write("HEAD-" + "x" * 1048576 + "-TAIL"); sys.stdout.flush()';
    const backgroundCommand = `python3 -c '${python}'; while [ ! -f ${releaseFileName} ]; do sleep 0.01; done; printf '\\n'`;
    const foregroundCommand = `python3 -c '${python}'; printf '\\n'`;

    try {
      const background = asBash(
        await tooling.runtime.execute({
          providerToolCallId: "call_long_background",
          name: "Bash",
          args: {
            command: backgroundCommand,
            run_in_background: true,
          },
        }),
      );
      const running = await waitForOutput(tooling, background.taskId, "-TAIL");

      expect(running.status).toBe("running");
      expect(running.truncated).toBe(true);
      expect(running.outputLines).toBe(1);
      expect(running.preview).toStartWith("HEAD-");
      expect(running.preview).toEndWith("-TAIL");
      expect(Buffer.byteLength(running.preview ?? "", "utf8")).toBeLessThanOrEqual(
        MAX_PREVIEW_BYTES,
      );

      await writeFile(path.join(workspace, releaseFileName), "", "utf8");
      await waitForStatus(tooling, background.taskId, "completed");

      const outputCall = tooling.testRuntime.toolCall({
        providerToolCallId: "call_long_task_output",
        name: "TaskOutput",
        args: { task_id: background.taskId },
      });
      const completedOutput = asTaskOutput(await tooling.runtime.execute(outputCall));
      const foreground = asBash(
        await tooling.runtime.execute({
          providerToolCallId: "call_long_foreground",
          name: "Bash",
          args: { command: foregroundCommand },
        }),
      );
      const completeLog = await readFile(background.outputFilePath, "utf8");
      const observation = new ObservationBuilder().build({
        call: outputCall,
        raw: completedOutput,
      });

      expect(completedOutput.status).toBe("completed");
      expect(completedOutput.outputBytes).toBe(Buffer.byteLength(completeLog, "utf8"));
      expect(completedOutput.outputLines).toBe(1);
      expect(completedOutput.truncated).toBe(true);
      expect(completedOutput.omittedLines).toBeUndefined();
      expect(completeLog).toBe(`HEAD-${"x".repeat(1024 * 1024)}-TAIL\n`);
      expect(
        Buffer.byteLength(completedOutput.preview ?? "", "utf8"),
      ).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
      expect(completedOutput.preview).toBe(foreground.preview);
      expect(completedOutput.truncated).toBe(foreground.truncated);
      expect(completedOutput.omittedLines).toBe(foreground.omittedLines);
      expect(observation.displayText).toContain(`preview:\n${completedOutput.preview}`);
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("marks a foreground timeout as a background task", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tasks-"));
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      taskStopGraceMs: 50,
    });

    try {
      const background = asBash(
        await tooling.runtime.execute({
          providerToolCallId: "call_1",
          name: "Bash",
          args: { command: "sleep 30", timeout: 1 },
        }),
      );
      expect(background.backgroundedDueToTimeout).toBe(true);

      const list = await listTasks(tooling);
      expect(list.tasks[0]).toMatchObject({
        taskId: background.taskId,
        status: "running",
        backgroundReason: "foreground_timeout",
      });

      const stopped = await stopTask(tooling, background.taskId);
      expect(stopped.ok).toBe(true);
      expect(stopped.status).toBe("killed");
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("stops a process group without leaving shell grandchildren", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tasks-"));
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      taskStopGraceMs: 100,
    });
    let parentPid: number | undefined;
    let childPid: number | undefined;

    try {
      const background = asBash(
        await tooling.runtime.execute({
          providerToolCallId: "call_1",
          name: "Bash",
          args: {
            command: 'sleep 30 & child=$!; echo "parent=$$ child=$child"; wait',
            run_in_background: true,
          },
        }),
      );
      const output = await waitForOutput(tooling, background.taskId, "parent=");
      const match = output.preview?.match(/parent=(\d+) child=(\d+)/);
      expect(match).not.toBeNull();
      parentPid = Number(match?.[1]);
      childPid = Number(match?.[2]);
      expect(isProcessAlive(parentPid)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);

      const stopped = await stopTask(tooling, background.taskId);
      expect(stopped.ok).toBe(true);
      expect(stopped.task?.status).toBe("killed");
      expect(stopped.task?.signal).toBe("SIGTERM");
      expect(stopped.escalated).toBe(false);
      await waitForProcessExit(parentPid);
      await waitForProcessExit(childPid);

      const repeated = await stopTask(tooling, background.taskId);
      expect(repeated.ok).toBe(false);
      expect(repeated.error).toContain("status=killed");
    } finally {
      await tooling.dispose();
      killProcessIfAlive(parentPid);
      killProcessIfAlive(childPid);
      await rm(workspace, { recursive: true });
    }
  });

  test("escalates to SIGKILL when a task ignores SIGTERM", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tasks-"));
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      taskStopGraceMs: 50,
    });

    try {
      const background = asBash(
        await tooling.runtime.execute({
          providerToolCallId: "call_1",
          name: "Bash",
          args: {
            command: "trap '' TERM; echo ready; while true; do sleep 1; done",
            run_in_background: true,
          },
        }),
      );
      await waitForOutput(tooling, background.taskId, "ready");

      const stopped = await stopTask(tooling, background.taskId);
      expect(stopped.ok).toBe(true);
      expect(stopped.escalated).toBe(true);
      expect(stopped.task?.status).toBe("killed");
      expect(stopped.task?.signal).toBe("SIGKILL");
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("shutdown stops every running task and is idempotent", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tasks-"));
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      taskStopGraceMs: 50,
    });

    try {
      const first = await startBackgroundSleep(tooling, "call_1");
      const second = await startBackgroundSleep(tooling, "call_2");

      await tooling.dispose("tui_exit");
      await tooling.dispose("tui_exit");

      expect(tooling.taskManager.inspectTask(first.taskId)?.task.status).toBe("killed");
      expect(tooling.taskManager.inspectTask(second.taskId)?.task.status).toBe(
        "killed",
      );

      const rejected = await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Bash",
        args: { command: "echo too-late" },
      });
      expect(rejected.ok).toBe(false);
      expect("error" in rejected ? rejected.error : "").toContain(
        "after task manager shutdown",
      );
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("renders model observations for task tools", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tasks-"));
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      taskStopGraceMs: 50,
    });
    const observations = new ObservationBuilder();

    try {
      const background = await startBackgroundSleep(tooling, "call_1");
      const listCall = tooling.testRuntime.toolCall({
        providerToolCallId: "call_2",
        name: "TaskList",
        args: {},
      });
      const list = await tooling.runtime.execute(listCall);
      expect(observations.build({ call: listCall, raw: list }).displayText).toContain(
        `taskId=${background.taskId}`,
      );

      const stopCall = tooling.testRuntime.toolCall({
        providerToolCallId: "call_3",
        name: "TaskStop",
        args: { task_id: background.taskId },
      });
      const stopped = await tooling.runtime.execute(stopCall);
      const stopObservation = observations.build({ call: stopCall, raw: stopped });
      expect(stopObservation.displayText).toContain("Task stopped.");
      expect(stopObservation.displayText).toContain("signal=SIGTERM");
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });
});

async function startBackgroundSleep(
  tooling: TestTooling,
  callId: string,
): Promise<BashRawResult> {
  return asBash(
    await tooling.runtime.execute({
      providerToolCallId: callId,
      name: "Bash",
      args: { command: "sleep 30", run_in_background: true },
    }),
  );
}

async function listTasks(tooling: TestTooling): Promise<TaskListRawResult> {
  return asTaskList(
    await tooling.runtime.execute({
      providerToolCallId: crypto.randomUUID(),
      name: "TaskList",
      args: {},
    }),
  );
}

async function stopTask(
  tooling: TestTooling,
  taskId: string,
): Promise<TaskStopRawResult> {
  return asTaskStop(
    await tooling.runtime.execute({
      providerToolCallId: crypto.randomUUID(),
      name: "TaskStop",
      args: { task_id: taskId },
    }),
  );
}

async function sendTaskInput(
  tooling: TestTooling,
  taskId: string,
  chars: string,
  waitMs: number,
): Promise<TaskInputRawResult> {
  return asTaskInput(
    await tooling.runtime.execute({
      providerToolCallId: crypto.randomUUID(),
      name: "TaskInput",
      args: { task_id: taskId, chars, wait_ms: waitMs },
    }),
  );
}

async function waitForTerminalScreen(
  tooling: TestTooling,
  taskId: string,
  expected: string,
): Promise<TaskOutputRawResult> {
  const deadline = Date.now() + 2_000;
  let last: TaskOutputRawResult | undefined;

  while (Date.now() < deadline) {
    last = asTaskOutput(
      await tooling.runtime.execute({
        providerToolCallId: crypto.randomUUID(),
        name: "TaskOutput",
        args: { task_id: taskId },
      }),
    );
    if (last.screen?.includes(expected)) {
      return last;
    }
    await Bun.sleep(10);
  }

  throw new Error(
    `Timed out waiting for task ${taskId} screen ${JSON.stringify(expected)}. Last screen: ${last?.screen}`,
  );
}

async function waitForOutput(
  tooling: TestTooling,
  taskId: string,
  expected: string,
): Promise<TaskOutputRawResult> {
  const deadline = Date.now() + 2_000;
  let last: TaskOutputRawResult | undefined;

  while (Date.now() < deadline) {
    last = asTaskOutput(
      await tooling.runtime.execute({
        providerToolCallId: crypto.randomUUID(),
        name: "TaskOutput",
        args: { task_id: taskId },
      }),
    );
    if (last.preview?.includes(expected)) {
      return last;
    }
    await Bun.sleep(10);
  }

  throw new Error(
    `Timed out waiting for task ${taskId} output ${JSON.stringify(expected)}. Last preview: ${last?.preview}`,
  );
}

async function waitForStatus(
  tooling: TestTooling,
  taskId: string,
  expected: "completed" | "failed" | "killed",
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const task = tooling.taskManager.inspectTask(taskId)?.task;
    if (task?.status === expected) {
      return task;
    }
    await Bun.sleep(10);
  }

  throw new Error(`Timed out waiting for task ${taskId} status=${expected}.`);
}

async function waitForEvent(
  sink: ArrayEventSink,
  expected: AgentEvent["type"],
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (sink.events.some((event) => event.type === expected)) {
      return;
    }
    await Bun.sleep(10);
  }

  throw new Error(`Timed out waiting for event ${expected}.`);
}

async function waitForProcessExit(pid: number | undefined): Promise<void> {
  if (pid === undefined) {
    throw new Error("Expected a process ID.");
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await Bun.sleep(10);
  }

  throw new Error(`Process ${pid} is still alive.`);
}

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid)) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function killProcessIfAlive(pid: number | undefined): void {
  if (!isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid as number, "SIGKILL");
  } catch {
    return;
  }
}

function asBash(raw: ToolRawResult): BashRawResult {
  expect("taskId" in raw).toBe(true);
  return raw as BashRawResult;
}

function asTaskList(raw: ToolRawResult): TaskListRawResult {
  expect("tasks" in raw).toBe(true);
  return raw as TaskListRawResult;
}

function asTaskOutput(
  raw: ToolRawResult,
): Extract<ToolRawResult, { kind: "task_output" }> {
  expect("taskId" in raw).toBe(true);
  return raw as Extract<ToolRawResult, { kind: "task_output" }>;
}

function asTaskInput(raw: ToolRawResult): TaskInputRawResult {
  expect(raw.kind).toBe("task_input");
  return raw as TaskInputRawResult;
}

function asTaskStop(raw: ToolRawResult): TaskStopRawResult {
  expect("taskId" in raw).toBe(true);
  return raw as TaskStopRawResult;
}
