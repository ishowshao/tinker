import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { EventSink } from "../events/event-sink";
import { createUuidV7 } from "../ids/uuid-v7";
import { isWorkspaceLocalCwd, type CwdState } from "./cwd-state";
import { TaskOutput, type TaskOutputSnapshot } from "./task-output";

export type ShellTaskStatus =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "killed";

export type BackgroundReason = "requested" | "foreground_timeout";

export type ShellTaskSnapshot = {
  taskId: string;
  runId: string;
  command: string;
  description: string;
  status: ShellTaskStatus;
  exitCode?: number;
  signal?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  backgroundedAt?: string;
  backgroundReason?: BackgroundReason;
  outputFilePath: string;
  outputBytes: number;
  outputLines: number;
  cwd: string;
};

export type ShellTaskInspection = {
  task: ShellTaskSnapshot;
  output: TaskOutputSnapshot;
};

export type ShellTaskHandle = {
  taskId: string;
  completion: Promise<ShellTaskSnapshot>;
};

export type StopTaskReason = "tool" | "shutdown" | "turn_cancelled";

export type StopTaskResult = {
  task: ShellTaskSnapshot;
  requestedSignal: "SIGTERM";
  escalated: boolean;
  reason: StopTaskReason;
};

export type ShutdownResult = {
  reason: "tui_exit" | "oneshot_complete";
  stoppedTaskIds: string[];
  escalatedTaskIds: string[];
};

type ManagedShellTask = {
  id: string;
  runId: string;
  command: string;
  description: string;
  status: ShellTaskStatus;
  exitCode?: number;
  signal?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  backgroundedAt?: string;
  backgroundReason?: BackgroundReason;
  outputFilePath: string;
  cwdFilePath: string;
  cwd: string;
  process: ChildProcessWithoutNullStreams;
  processGroupId: number;
  output: TaskOutput;
  completion: Promise<ShellTaskSnapshot>;
  stopPromise?: Promise<StopTaskResult>;
  terminalEventEmitted: boolean;
};

export type ShellTaskManagerOptions = {
  workspaceRoot: string;
  runId: string;
  cwdState: CwdState;
  eventSink?: EventSink;
  stopGraceMs?: number;
};

const defaultStopGraceMs = 2_000;

export class ShellTaskManager {
  private readonly tasks = new Map<string, ManagedShellTask>();
  private readonly stopGraceMs: number;
  private acceptingTasks = true;
  private shutdownPromise?: Promise<ShutdownResult>;

  constructor(private readonly options: ShellTaskManagerOptions) {
    this.stopGraceMs = options.stopGraceMs ?? defaultStopGraceMs;
    if (!Number.isInteger(this.stopGraceMs) || this.stopGraceMs < 1) {
      throw new Error("ShellTaskManager.stopGraceMs must be a positive integer.");
    }
  }

  async start(input: {
    command: string;
    description: string;
  }): Promise<ShellTaskHandle> {
    if (!this.acceptingTasks) {
      throw new Error("Cannot start a Bash task after task manager shutdown.");
    }

    const id = createUuidV7();
    const outputFilePath = path.join(
      this.options.workspaceRoot,
      ".tinker",
      "bash",
      `${id}.log`,
    );
    const cwdFilePath = path.join(
      this.options.workspaceRoot,
      ".tinker",
      "bash",
      `${id}.cwd`,
    );
    await ensureEmptyFile(cwdFilePath);

    const output = await TaskOutput.create(outputFilePath);
    if (!this.acceptingTasks) {
      await output.end();
      await unlinkIfExists(cwdFilePath);
      throw new Error("Cannot start a Bash task after task manager shutdown.");
    }

    const child = spawn("bash", ["-lc", bashWrapperScript], {
      cwd: this.options.cwdState.cwd,
      detached: true,
      env: {
        ...process.env,
        TINKER_BASH_COMMAND: input.command,
        TINKER_BASH_CWD_FILE: cwdFilePath,
      },
    });

    if (child.pid === undefined) {
      const spawnError = await waitForProcessError(child);
      await output.end();
      await unlinkIfExists(cwdFilePath);
      throw spawnError;
    }

    const task: ManagedShellTask = {
      id,
      runId: this.options.runId,
      command: input.command,
      description: input.description,
      status: "running",
      startedAt: new Date().toISOString(),
      outputFilePath,
      cwdFilePath,
      cwd: this.options.cwdState.cwd,
      process: child,
      processGroupId: child.pid,
      output,
      completion: Promise.resolve(undefined as never),
      terminalEventEmitted: false,
    };

    pipeTaskOutput(task.process.stdout, task.output);
    pipeTaskOutput(task.process.stderr, task.output);
    task.completion = this.monitorTaskSafely(task);
    this.tasks.set(id, task);

    return {
      taskId: id,
      completion: task.completion,
    };
  }

  async markBackgrounded(
    taskId: string,
    reason: BackgroundReason,
  ): Promise<ShellTaskSnapshot> {
    const task = this.requireTask(taskId);
    this.synchronizeTerminalState(task);

    if (task.backgroundedAt !== undefined) {
      return this.snapshot(task);
    }

    task.backgroundedAt = new Date().toISOString();
    task.backgroundReason = reason;
    if (isTerminalStatus(task.status)) {
      task.terminalEventEmitted = true;
    }

    const snapshot = this.snapshot(task);
    await this.options.eventSink?.append({
      type: "bash.task.backgrounded",
      task: snapshot,
    });
    return snapshot;
  }

  listBackgroundTasks(): ShellTaskSnapshot[] {
    return [...this.tasks.values()]
      .filter((task) => task.backgroundedAt !== undefined)
      .map((task) => {
        this.synchronizeTerminalState(task);
        return this.snapshot(task);
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  inspectTask(taskId: string): ShellTaskInspection | undefined {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      return undefined;
    }

    this.synchronizeTerminalState(task);
    return {
      task: this.snapshot(task),
      output: task.output.snapshot(),
    };
  }

  async stopTask(taskId: string, reason: StopTaskReason): Promise<StopTaskResult> {
    const task = this.requireTask(taskId);
    this.synchronizeTerminalState(task);

    if (task.status === "stopping") {
      throw new Error(`Task ${taskId} is already stopping.`);
    }

    if (isTerminalStatus(task.status)) {
      throw new Error(`Task ${taskId} is not running (status=${task.status}).`);
    }

    return this.beginStop(task, reason);
  }

  async cancelForegroundTask(taskId: string): Promise<ShellTaskSnapshot> {
    const task = this.requireTask(taskId);
    this.synchronizeTerminalState(task);

    if (task.backgroundedAt !== undefined) {
      throw new Error(`Cannot cancel background task as foreground: ${taskId}`);
    }

    if (isTerminalStatus(task.status) || task.status === "stopping") {
      return task.completion;
    }

    return (await this.beginStop(task, "turn_cancelled")).task;
  }

  shutdown(reason: "tui_exit" | "oneshot_complete"): Promise<ShutdownResult> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }

    this.acceptingTasks = false;
    this.shutdownPromise = this.performShutdown(reason);
    return this.shutdownPromise;
  }

  private async performShutdown(
    reason: "tui_exit" | "oneshot_complete",
  ): Promise<ShutdownResult> {
    const results = await Promise.all(
      [...this.tasks.values()].map(async (task) => {
        this.synchronizeTerminalState(task);
        if (isTerminalStatus(task.status)) {
          return undefined;
        }

        if (task.status === "stopping") {
          return (
            task.stopPromise ??
            task.completion.then((snapshot) => ({
              task: snapshot,
              requestedSignal: "SIGTERM" as const,
              escalated: false,
              reason: "shutdown" as const,
            }))
          );
        }

        return this.beginStop(task, "shutdown");
      }),
    );

    const stopped = results.filter(
      (result): result is StopTaskResult => result !== undefined,
    );
    return {
      reason,
      stoppedTaskIds: stopped.map((result) => result.task.taskId),
      escalatedTaskIds: stopped
        .filter((result) => result.escalated)
        .map((result) => result.task.taskId),
    };
  }

  private beginStop(
    task: ManagedShellTask,
    reason: StopTaskReason,
  ): Promise<StopTaskResult> {
    const stopPromise = this.performStop(task, reason);
    task.stopPromise = stopPromise;
    return stopPromise;
  }

  private async performStop(
    task: ManagedShellTask,
    reason: StopTaskReason,
  ): Promise<StopTaskResult> {
    task.status = "stopping";
    if (task.backgroundedAt !== undefined) {
      await this.options.eventSink?.append({
        type: "bash.task.stopping",
        task: this.snapshot(task),
      });
    }

    signalProcessGroup(task, "SIGTERM");
    let escalated = false;

    if (!(await completesWithin(task.completion, this.stopGraceMs))) {
      this.synchronizeTerminalState(task);
      if (!isTerminalStatus(task.status)) {
        signalProcessGroup(task, "SIGKILL");
        escalated = true;
      }
    }

    const snapshot = await task.completion;
    return {
      task: snapshot,
      requestedSignal: "SIGTERM",
      escalated,
      reason,
    };
  }

  private async monitorTaskSafely(task: ManagedShellTask): Promise<ShellTaskSnapshot> {
    try {
      return await this.monitorTask(task);
    } catch (error) {
      task.status = "failed";
      task.endedAt ??= new Date().toISOString();
      task.error = error instanceof Error ? error.message : String(error);

      try {
        await task.output.end();
      } catch (outputError) {
        task.error = `${task.error}; output cleanup failed: ${
          outputError instanceof Error ? outputError.message : String(outputError)
        }`;
      }
      await unlinkIfExists(task.cwdFilePath);

      return this.snapshot(task);
    }
  }

  private async monitorTask(task: ManagedShellTask): Promise<ShellTaskSnapshot> {
    const exit = waitForProcessExit(task.process);
    const close = waitForProcessClose(task.process);
    const result = await exit;

    this.applyTermination(task, result);
    await close;
    await task.output.end();
    await this.updateCwdFromFile(task);
    await unlinkIfExists(task.cwdFilePath);

    const snapshot = this.snapshot(task);
    if (task.backgroundedAt !== undefined && !task.terminalEventEmitted) {
      task.terminalEventEmitted = true;
      await this.options.eventSink?.append({
        type: "bash.task.finished",
        task: snapshot,
      });
    }

    return snapshot;
  }

  private applyTermination(task: ManagedShellTask, result: ProcessExitResult): void {
    if (isTerminalStatus(task.status)) {
      return;
    }

    task.endedAt ??= new Date().toISOString();
    if (result.error !== undefined) {
      task.status = "failed";
      task.error = result.error;
      return;
    }

    if (result.signal !== null) {
      task.status = "killed";
      task.signal = result.signal;
      return;
    }

    task.exitCode = result.code ?? 1;
    task.status = task.exitCode === 0 ? "completed" : "failed";
  }

  private synchronizeTerminalState(task: ManagedShellTask): void {
    if (isTerminalStatus(task.status)) {
      return;
    }

    if (task.process.signalCode !== null) {
      this.applyTermination(task, {
        code: null,
        signal: task.process.signalCode,
      });
      return;
    }

    if (task.process.exitCode !== null) {
      this.applyTermination(task, {
        code: task.process.exitCode,
        signal: null,
      });
    }
  }

  private snapshot(task: ManagedShellTask): ShellTaskSnapshot {
    const output = task.output.snapshot();
    return {
      taskId: task.id,
      runId: task.runId,
      command: task.command,
      description: task.description,
      status: task.status,
      exitCode: task.exitCode,
      signal: task.signal,
      error: task.error,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      backgroundedAt: task.backgroundedAt,
      backgroundReason: task.backgroundReason,
      outputFilePath: task.outputFilePath,
      outputBytes: output.outputBytes,
      outputLines: output.outputLines,
      cwd: task.cwd,
    };
  }

  private requireTask(taskId: string): ManagedShellTask {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      throw new Error(`Unknown task ID: ${taskId}`);
    }

    return task;
  }

  private async updateCwdFromFile(task: ManagedShellTask): Promise<void> {
    try {
      const cwd = (await readFile(task.cwdFilePath, "utf8")).trim();
      if (cwd !== "" && isWorkspaceLocalCwd(this.options.workspaceRoot, cwd)) {
        task.cwd = cwd;
      }
    } catch {
      return;
    }
  }
}

type ProcessExitResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
};

function waitForProcessExit(
  process: ChildProcessWithoutNullStreams,
): Promise<ProcessExitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProcessExitResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    process.once("error", (error) => {
      finish({ code: null, signal: null, error: error.message });
    });
    process.once("exit", (code, signal) => {
      finish({ code, signal });
    });
  });
}

function waitForProcessError(process: ChildProcessWithoutNullStreams): Promise<Error> {
  return new Promise((resolve) => {
    process.once("error", resolve);
  });
}

function waitForProcessClose(process: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    process.once("error", finish);
    process.once("close", finish);
  });
}

function signalProcessGroup(
  task: ManagedShellTask,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    process.kill(-task.processGroupId, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) {
      throw error;
    }
  }
}

async function completesWithin(
  completion: Promise<ShellTaskSnapshot>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      completion.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function isTerminalStatus(status: ShellTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

function pipeTaskOutput(stream: NodeJS.ReadableStream, output: TaskOutput): void {
  stream.on("data", (chunk: Buffer | string) => {
    output.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
}

async function ensureEmptyFile(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const file = await open(filePath, "w");
  await file.close();
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isNoSuchProcess(error: unknown): boolean {
  return errorCode(error) === "ESRCH";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

const bashWrapperScript = `
eval "$TINKER_BASH_COMMAND"
exit_code=$?
pwd -P > "$TINKER_BASH_CWD_FILE"
exit "$exit_code"
`;
