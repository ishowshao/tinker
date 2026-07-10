import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCall } from "../agent/types";
import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling as createDefaultToolingBase } from "../tools/registry";
import type {
  BashRawResult,
  TaskListRawResult,
  TaskOutputRawResult,
  TaskStopRawResult,
  ToolRawResult,
  ToolExecutionContext,
} from "../tools/types";

const testToolContext: ToolExecutionContext = {
  signal: new AbortController().signal,
};

function createDefaultTooling(options: Parameters<typeof createDefaultToolingBase>[0]) {
  const tooling = createDefaultToolingBase(options);
  return {
    ...tooling,
    runtime: {
      execute: (call: ToolCall, context: ToolExecutionContext = testToolContext) =>
        tooling.runtime.execute(call, context),
    },
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
      expect(names).toContain("TaskStop");
      expect(
        definitions.find((definition) => definition.name === "TaskList")?.parameters,
      ).toMatchObject({ additionalProperties: false, properties: {} });

      const invalidList = asTaskList(
        await tooling.runtime.execute({
          id: "call_1",
          name: "TaskList",
          args: { unexpected: true },
        }),
      );
      expect(invalidList.ok).toBe(false);
      expect(invalidList.error).toContain("unexpected");

      const invalidOutput = asTaskOutput(
        await tooling.runtime.execute({
          id: "call_2",
          name: "TaskOutput",
          args: {},
        }),
      );
      expect(invalidOutput.ok).toBe(false);
      expect(invalidOutput.error).toContain("TaskOutput.task_id");

      const unknownStop = asTaskStop(
        await tooling.runtime.execute({
          id: "call_3",
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
        id: "call_1",
        name: "Bash",
        args: { command: "echo foreground" },
      });
      expect((await listTasks(tooling)).tasks).toEqual([]);

      const background = asBash(
        await tooling.runtime.execute({
          id: "call_2",
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
      });

      const currentOutput = await waitForOutput(tooling, background.taskId, "ready");
      expect(currentOutput.outputFilePath).toBe(background.outputFilePath);
      expect(currentOutput.preview).toContain("ready");

      const completed = await waitForStatus(tooling, background.taskId, "completed");
      expect(completed.exitCode).toBe(0);
      expect(completed.endedAt).toBeString();

      const finalOutput = asTaskOutput(
        await tooling.runtime.execute({
          id: "call_3",
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

  test("marks a foreground timeout as a background task", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tasks-"));
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      taskStopGraceMs: 50,
    });

    try {
      const background = asBash(
        await tooling.runtime.execute({
          id: "call_1",
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
          id: "call_1",
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
          id: "call_1",
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
        id: "call_3",
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
      const listCall = { id: "call_2", name: "TaskList", args: {} };
      const list = await tooling.runtime.execute(listCall);
      expect(observations.build({ call: listCall, raw: list }).content).toContain(
        `taskId=${background.taskId}`,
      );

      const stopCall = {
        id: "call_3",
        name: "TaskStop",
        args: { task_id: background.taskId },
      };
      const stopped = await tooling.runtime.execute(stopCall);
      const stopObservation = observations.build({ call: stopCall, raw: stopped });
      expect(stopObservation.content).toContain("Task stopped.");
      expect(stopObservation.content).toContain("signal=SIGTERM");
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
      id: callId,
      name: "Bash",
      args: { command: "sleep 30", run_in_background: true },
    }),
  );
}

async function listTasks(tooling: TestTooling): Promise<TaskListRawResult> {
  return asTaskList(
    await tooling.runtime.execute({
      id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
      name: "TaskStop",
      args: { task_id: taskId },
    }),
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
        id: crypto.randomUUID(),
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

function asTaskOutput(raw: ToolRawResult): TaskOutputRawResult {
  expect("taskId" in raw).toBe(true);
  return raw as TaskOutputRawResult;
}

function asTaskStop(raw: ToolRawResult): TaskStopRawResult {
  expect("taskId" in raw).toBe(true);
  return raw as TaskStopRawResult;
}
