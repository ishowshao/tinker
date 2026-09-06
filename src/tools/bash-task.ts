import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  RuntimeSessionContext,
  SessionDisposeReason,
} from "../agent/runtime-session";
import type { ToolCallIdentity } from "../agent/types";
import { createUuidV7 } from "../ids/uuid-v7";
import { isWorkspaceLocalCwd, type CwdState } from "./cwd-state";
import {
  type ProcessExitResult,
  type ShellProcessHandle,
  type ShellProcessMode,
  spawnShellProcess,
} from "./shell-process";
import { TaskOutput, type TaskOutputSnapshot } from "./task-output";
import type { TaskOutputRangeRequest } from "./task-output-range";
import { createTerminalScreen, type TerminalScreen } from "./terminal-screen";
import { resolveWorkspaceStorageRoot } from "../session/workspace-storage";

export type ShellTaskStatus =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "killed";

export type BackgroundReason = "requested" | "foreground_timeout";

export type ShellTaskOrigin = ToolCallIdentity;

export type ShellTaskSnapshot = {
  taskId: string;
  origin: ShellTaskOrigin;
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
  tty: boolean;
};

export type ShellTaskInspection = {
  task: ShellTaskSnapshot;
  output: TaskOutputSnapshot;
  screenRows?: number;
  screenColumns?: number;
  screen?: string;
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
  reason: SessionDisposeReason["type"];
  stoppedTaskIds: string[];
  escalatedTaskIds: string[];
};

type ManagedShellTask = {
  id: string;
  origin: ShellTaskOrigin;
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
  mode: ShellProcessMode;
  process: ShellProcessHandle;
  processGroupId: number;
  output: TaskOutput;
  terminalScreen?: TerminalScreen;
  finalScreen?: string;
  completion: Promise<ShellTaskSnapshot>;
  stopPromise?: Promise<StopTaskResult>;
  terminalEventEmitted: boolean;
};

export type ShellTaskManagerOptions = {
  workspaceRoot: string;
  cwdState: CwdState;
  runtimeSession: RuntimeSessionContext;
  stopGraceMs?: number;
  homeRoot?: string;
};

const defaultStopGraceMs = 2_000;

export class ShellTaskManager {
  private readonly tasks = new Map<string, ManagedShellTask>();
  private readonly stopGraceMs: number;
  private acceptingTasks = true;
  private shutdownPromise?: Promise<ShutdownResult>;
  private bashDirectoryPromise?: Promise<string>;

  constructor(private readonly options: ShellTaskManagerOptions) {
    this.stopGraceMs = options.stopGraceMs ?? defaultStopGraceMs;
    if (!Number.isInteger(this.stopGraceMs) || this.stopGraceMs < 1) {
      throw new Error("ShellTaskManager.stopGraceMs must be a positive integer.");
    }
  }

  private bashDirectory(): Promise<string> {
    this.bashDirectoryPromise ??= resolveWorkspaceStorageRoot(
      this.options.workspaceRoot,
      this.options.homeRoot,
    ).then((storageRoot) => path.join(storageRoot, "bash"));
    return this.bashDirectoryPromise;
  }

  async start(input: {
    command: string;
    description: string;
    origin: ShellTaskOrigin;
    tty: boolean;
    cols?: number;
    rows?: number;
  }): Promise<ShellTaskHandle> {
    if (!this.acceptingTasks) {
      throw new Error("Cannot start a Bash task after task manager shutdown.");
    }

    const id = createUuidV7();
    const bashDirectory = await this.bashDirectory();
    const outputFilePath = path.join(bashDirectory, `${id}.log`);
    const cwdFilePath = path.join(bashDirectory, `${id}.cwd`);
    await ensureEmptyFile(cwdFilePath);

    const output = await TaskOutput.create(outputFilePath);
    if (!this.acceptingTasks) {
      await output.end();
      await unlinkIfExists(cwdFilePath);
      throw new Error("Cannot start a Bash task after task manager shutdown.");
    }

    const terminalScreen = input.tty ? createTerminalScreen(input) : undefined;
    let shellProcess: ShellProcessHandle;
    try {
      shellProcess = await spawnShellProcess({
        mode: input.tty ? "pty" : "pipe",
        command: input.command,
        cwd: this.options.cwdState.cwd,
        cwdFilePath,
        cols: terminalScreen?.columns,
        rows: terminalScreen?.rows,
        onOutput(bytes) {
          output.write(Buffer.from(bytes));
          if (terminalScreen !== undefined) {
            void terminalScreen.write(bytes).catch(() => undefined);
          }
        },
      });
    } catch (error) {
      terminalScreen?.dispose();
      await output.end();
      await unlinkIfExists(cwdFilePath);
      throw error;
    }

    const task: ManagedShellTask = {
      id,
      origin: input.origin,
      command: input.command,
      description: input.description,
      status: "running",
      startedAt: new Date().toISOString(),
      outputFilePath,
      cwdFilePath,
      cwd: this.options.cwdState.cwd,
      mode: shellProcess.mode,
      process: shellProcess,
      processGroupId: shellProcess.pid,
      output,
      terminalScreen,
      completion: Promise.resolve(undefined as never),
      terminalEventEmitted: false,
    };

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
    await this.options.runtimeSession.append({
      type: "bash.task.backgrounded",
      ...task.origin,
      data: { task: snapshot },
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
    return this.inspection(task);
  }

  async inspectTaskOutput(
    taskId: string,
    range?: TaskOutputRangeRequest,
    signal?: AbortSignal,
  ): Promise<ShellTaskInspection | undefined> {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      return undefined;
    }

    this.synchronizeTerminalState(task);
    if (isTerminalStatus(task.status)) {
      await task.completion;
    } else {
      await task.terminalScreen?.flush();
    }
    const inspection = this.inspection(task);
    if (range !== undefined && task.mode !== "pty") {
      const output = await task.output.readRange(range, signal);
      return {
        ...inspection,
        task: {
          ...inspection.task,
          outputBytes: output.outputBytes,
          outputLines: output.outputLines,
        },
        output,
      };
    }
    return inspection;
  }

  taskCompletion(taskId: string): Promise<ShellTaskSnapshot> {
    return this.requireTask(taskId).completion;
  }

  async writeTaskInput(taskId: string, chars: string): Promise<number> {
    const task = this.requireTask(taskId);
    this.synchronizeTerminalState(task);
    if (task.mode !== "pty" || task.process.write === undefined) {
      throw new Error(
        `Task ${taskId} does not accept terminal input; start it with Bash tty=true.`,
      );
    }
    if (task.status !== "running") {
      throw new Error(`Task ${taskId} is not running (status=${task.status}).`);
    }

    return task.process.write(chars);
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

  shutdown(reason: SessionDisposeReason["type"]): Promise<ShutdownResult> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }

    this.acceptingTasks = false;
    this.shutdownPromise = this.performShutdown(reason);
    return this.shutdownPromise;
  }

  private async performShutdown(
    reason: SessionDisposeReason["type"],
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
      await this.options.runtimeSession.append({
        type: "bash.task.stopping",
        ...task.origin,
        data: { task: this.snapshot(task) },
      });
    }

    signalProcessGroup(task, "SIGTERM");
    let escalated = false;

    if (!(await completesWithin(task.completion, this.stopGraceMs))) {
      this.synchronizeTerminalState(task);
      if (!isTerminalStatus(task.status)) {
        escalated = signalProcessGroup(task, "SIGKILL");
        if (
          !(await completesWithin(task.completion, this.stopGraceMs)) &&
          !task.process.outputClosed
        ) {
          task.error =
            "Task output remained open after forced termination; closed local output streams. Descendant processes may still be running.";
          task.process.close();
        }
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
      if (task.terminalScreen !== undefined) {
        try {
          await task.terminalScreen.flush();
          task.finalScreen = task.terminalScreen.text();
        } catch {
          // The original monitor error remains the primary task failure.
        }
        task.terminalScreen.dispose();
      }
      task.process.close();
      await unlinkIfExists(task.cwdFilePath);

      const snapshot = this.snapshot(task);
      if (task.backgroundedAt !== undefined && !task.terminalEventEmitted) {
        task.terminalEventEmitted = true;
        await this.options.runtimeSession.append({
          type: "bash.task.finished",
          ...task.origin,
          data: { task: snapshot },
        });
      }
      return snapshot;
    }
  }

  private async monitorTask(task: ManagedShellTask): Promise<ShellTaskSnapshot> {
    const result = await task.process.wait();

    await task.process.waitForOutputClose();
    this.applyTermination(task, result);
    await task.output.end();
    if (task.terminalScreen !== undefined) {
      await task.terminalScreen.flush();
      task.finalScreen = task.terminalScreen.text();
      task.terminalScreen.dispose();
    }
    task.process.close();
    await this.updateCwdFromFile(task);
    await unlinkIfExists(task.cwdFilePath);

    const snapshot = this.snapshot(task);
    if (task.backgroundedAt !== undefined && !task.terminalEventEmitted) {
      task.terminalEventEmitted = true;
      await this.options.runtimeSession.append({
        type: "bash.task.finished",
        ...task.origin,
        data: { task: snapshot },
      });
    }

    return snapshot;
  }

  private applyTermination(task: ManagedShellTask, result: ProcessExitResult): void {
    if (isTerminalStatus(task.status)) {
      return;
    }

    task.endedAt ??= new Date().toISOString();
    if (result.error !== undefined || task.error !== undefined) {
      task.status = "failed";
      task.error ??= result.error;
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
    // An exited wrapper can leave children holding its output descriptors open.
    // Keep the task stoppable until both process exit and output closure occur.
    if (isTerminalStatus(task.status) || !task.process.outputClosed) {
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
      origin: task.origin,
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
      tty: task.mode === "pty",
    };
  }

  private inspection(task: ManagedShellTask): ShellTaskInspection {
    const screen =
      task.mode === "pty"
        ? (task.finalScreen ?? task.terminalScreen?.text() ?? "")
        : undefined;
    return {
      task: this.snapshot(task),
      output: task.output.snapshot(),
      ...(screen === undefined
        ? {}
        : {
            screenRows: task.terminalScreen?.rows,
            screenColumns: task.terminalScreen?.columns,
            screen,
          }),
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

function signalProcessGroup(
  task: ManagedShellTask,
  signal: "SIGTERM" | "SIGKILL",
): boolean {
  try {
    process.kill(-task.processGroupId, signal);
    return true;
  } catch (error) {
    if (!isNoSuchProcess(error)) {
      throw error;
    }
    return false;
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
