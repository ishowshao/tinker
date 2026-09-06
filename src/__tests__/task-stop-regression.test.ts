import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultTooling } from "../tools/registry";
import { ObservationBuilder } from "../observation/observation-builder";
import { createTestHistoryReader, createTestRuntime } from "./test-runtime";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

test.each([
  "tool",
  "shutdown",
  "turn_cancelled",
] as const)("%s stops a nested child ignoring SIGTERM after the wrapper exits", async (reason) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-stop-nested-"));
  const runtime = createTestRuntime();
  const tooling = createDefaultTooling({
    workspaceRoot: workspace,
    runtimeSession: runtime.runtimeSession,
    historyReader: createTestHistoryReader(runtime.runtimeSession.sessionId),
    taskStopGraceMs: 100,
  });
  let groupId: number | undefined;
  let childPid: number | undefined;
  try {
    const task = await tooling.taskManager.start({
      command:
        'echo "parent=$$"; bash -c \'trap "" TERM; echo "child=$$"; while true; do sleep 1; done\'',
      description: "Nested child ignores termination",
      tty: false,
      origin: runtime.toolCall({ name: "Bash", args: {} }),
    });
    if (reason !== "turn_cancelled") {
      await tooling.taskManager.markBackgrounded(task.taskId, "requested");
    }
    await until(() => {
      const preview = tooling.taskManager.inspectTask(task.taskId)?.output.preview;
      const parent = preview?.match(/parent=(\d+)/);
      const child = preview?.match(/child=(\d+)/);
      if (parent) groupId = Number(parent[1]);
      if (child) childPid = Number(child[1]);
      return childPid !== undefined;
    });

    if (reason === "tool") {
      const call = runtime.toolCall({
        name: "TaskStop",
        args: { task_id: task.taskId },
      });
      const stopped = await within(
        tooling.runtime.execute(call, { signal: new AbortController().signal }),
      );
      expect(stopped).toMatchObject({
        ok: true,
        kind: "task_stop",
        status: "killed",
        escalated: true,
      });
      expect(
        new ObservationBuilder().build({ call, raw: stopped }).displayText,
      ).toContain("escalated=true");
    } else if (reason === "shutdown") {
      const stopped = await within(tooling.taskManager.shutdown("tui_exit"));
      expect(stopped.escalatedTaskIds).toEqual([task.taskId]);
    } else {
      const stopped = await within(
        tooling.taskManager.cancelForegroundTask(task.taskId),
      );
      expect(stopped.status).toBe("killed");
    }

    await until(() => !isAlive(childPid));
    const output = await within(tooling.taskManager.inspectTaskOutput(task.taskId));
    expect(output?.output.preview).toContain(`child=${childPid}`);
    expect(output?.task.status).toBe("killed");
  } finally {
    // Kill before dispose so a failing regression cannot hang the test runner.
    if (groupId !== undefined) {
      try {
        process.kill(-groupId, "SIGKILL");
      } catch {
        // The process group normally no longer exists after a successful stop.
      }
    }
    await within(tooling.dispose());
    await rm(workspace, { recursive: true, force: true });
  }
});

test("TaskStop bounds output draining when an escaped child retains the pipes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-stop-pipes-"));
  const runtime = createTestRuntime();
  const tooling = createDefaultTooling({
    workspaceRoot: workspace,
    runtimeSession: runtime.runtimeSession,
    historyReader: createTestHistoryReader(runtime.runtimeSession.sessionId),
    taskStopGraceMs: 100,
  });
  let childPid: number | undefined;
  let groupId: number | undefined;
  try {
    const childScript =
      'import os,time; print("escaped="+str(os.getpid()), flush=True); time.sleep(60)';
    const launcher = `import subprocess,sys; subprocess.Popen([sys.executable, "-c", ${JSON.stringify(childScript)}], start_new_session=True)`;
    const task = await tooling.taskManager.start({
      command: `echo "parent=$$"; python3 -c '${launcher}'`,
      description: "Escaped child retains output pipes",
      tty: false,
      origin: runtime.toolCall({ name: "Bash", args: {} }),
    });
    await tooling.taskManager.markBackgrounded(task.taskId, "requested");
    await until(() => {
      const preview = tooling.taskManager.inspectTask(task.taskId)?.output.preview;
      const parent = preview?.match(/parent=(\d+)/);
      const child = preview?.match(/escaped=(\d+)/);
      if (parent) groupId = Number(parent[1]);
      if (child) childPid = Number(child[1]);
      return childPid !== undefined && groupId !== undefined && !isAlive(groupId);
    });
    expect(tooling.taskManager.inspectTask(task.taskId)?.task.status).toBe("running");

    const call = runtime.toolCall({ name: "TaskStop", args: { task_id: task.taskId } });
    const stopped = await within(
      tooling.runtime.execute(call, { signal: new AbortController().signal }),
    );
    expect(stopped).toMatchObject({
      ok: false,
      kind: "task_stop",
      status: "failed",
      escalated: false,
    });
    expect(
      new ObservationBuilder().build({ call, raw: stopped }).displayText,
    ).toContain("Descendant processes may still be running");
    expect(isAlive(childPid)).toBe(true);
    const output = await within(tooling.taskManager.inspectTaskOutput(task.taskId));
    expect(output?.output.preview).toContain(`escaped=${childPid}`);
    expect(output?.task.error).toContain("output remained open");
  } finally {
    for (const pid of [groupId === undefined ? undefined : -groupId, childPid]) {
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Cleanup also runs after the tested operation has killed the group.
        }
      }
    }
    await within(tooling.dispose());
    await rm(workspace, { recursive: true, force: true });
  }
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Task condition timed out");
    await Bun.sleep(10);
  }
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Task operation timed out")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
