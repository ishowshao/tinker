import { readFile } from "node:fs/promises";
import { cancellationError, throwIfTurnCancelled } from "../agent/turn-cancellation";
import {
  ShellTaskManager,
  type ShellTaskHandle,
  type ShellTaskInspection,
  type ShellTaskSnapshot,
} from "./bash-task";
import { isWorkspaceLocalCwd, type CwdState } from "./cwd-state";
import { buildOutputSnapshotFromText } from "./task-output-snapshot";
import { defineToolExecutor } from "./types";
import type { TaskOutputSnapshot } from "./task-output";
import type { BashRawResult, ToolExecutionContext, ToolExecutor } from "./types";
import { DEFAULT_PUBLIC_TOOLING_CONFIG } from "../cli/public-config-contract";

type BashArgs = {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
};

export type BashToolOptions = {
  workspaceRoot: string;
  cwdState: CwdState;
  taskManager: ShellTaskManager;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
};

export function createBashToolExecutor(options: BashToolOptions): ToolExecutor {
  const maxTimeoutMs =
    options.maxTimeoutMs ?? DEFAULT_PUBLIC_TOOLING_CONFIG.bashMaxTimeoutMs;
  const defaultTimeoutMs =
    options.defaultTimeoutMs ?? DEFAULT_PUBLIC_TOOLING_CONFIG.bashDefaultTimeoutMs;
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new Error(
      `Bash default timeout must not exceed max timeout; received ${defaultTimeoutMs} > ${maxTimeoutMs}.`,
    );
  }

  return defineToolExecutor("bash", {
    definition: {
      name: "Bash",
      description: "Run a shell command in the local workspace.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
          timeout: {
            type: "integer",
            minimum: 1,
            maximum: maxTimeoutMs,
            description: "Optional foreground timeout in milliseconds.",
          },
          description: {
            type: "string",
            description: "Clear 5-10 word description of what this command does.",
          },
          run_in_background: {
            type: "boolean",
            description: "Run the command in the background and return immediately.",
          },
        },
        required: ["command"],
      },
    },
    async execute(args, call, context: ToolExecutionContext): Promise<BashRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseBashArgs(args, maxTimeoutMs);

      if (!parsed.ok) {
        return {
          ok: false,
          command: "",
          taskId: "",
          sessionId: call.sessionId,
          status: "failed",
          cwd: options.cwdState.cwd,
          outputFilePath: "",
          outputBytes: 0,
          outputLines: 0,
          preview: "",
          truncated: false,
          error: parsed.error,
        };
      }

      const input = parsed.value;
      const foregroundTimeoutMs = input.timeout ?? defaultTimeoutMs;
      throwIfTurnCancelled(context.signal);
      const task = await options.taskManager.start({
        command: input.command,
        description: input.description ?? input.command,
        origin: call,
      });

      if (input.run_in_background === true) {
        // Starting and publishing an explicit background task is one commit
        // boundary. Cancellation is observed after its result is recorded.
        await options.taskManager.markBackgrounded(task.taskId, "requested");
        const inspection = requireTaskInspection(options.taskManager, task.taskId);
        if (inspection.task.status !== "running") {
          return buildCompletedResult(inspection.task, inspection.output);
        }

        return buildRunningResult({
          inspection,
          backgrounded: true,
        });
      }

      const waitResult = await waitForTask(task, foregroundTimeoutMs, context.signal);
      if (waitResult.type === "cancelled") {
        await options.taskManager.cancelForegroundTask(task.taskId);
        throw cancellationError(context.signal);
      }

      if (waitResult.type === "timeout") {
        // Timeout wins ownership. Marking the task backgrounded and returning
        // its task ID is an uninterrupted commit boundary.
        await options.taskManager.markBackgrounded(task.taskId, "foreground_timeout");
        const inspection = requireTaskInspection(options.taskManager, task.taskId);
        if (inspection.task.status !== "running") {
          return buildCompletedResult(inspection.task, inspection.output);
        }

        return buildRunningResult({
          inspection,
          timedOut: true,
          backgrounded: true,
          backgroundedDueToTimeout: true,
          timeoutMs: foregroundTimeoutMs,
        });
      }

      const inspection = requireTaskInspection(options.taskManager, task.taskId);
      const raw = await buildCompletedResult(waitResult.task, inspection.output);
      updateCwdStateAfterForegroundCommand({
        raw,
        task: waitResult.task,
        cwdState: options.cwdState,
        workspaceRoot: options.workspaceRoot,
      });
      return raw;
    },
  });
}

export function parseBashArgs(
  args: unknown,
  maxTimeoutMs = DEFAULT_PUBLIC_TOOLING_CONFIG.bashMaxTimeoutMs,
): { ok: true; value: BashArgs } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "Bash arguments must be an object." };
  }

  if (typeof args.command !== "string" || args.command.trim() === "") {
    return { ok: false, error: "Bash.command must be a non-empty string." };
  }

  const timeout = parseOptionalTimeout(args.timeout, maxTimeoutMs);
  if (!timeout.ok) {
    return timeout;
  }

  if (args.description !== undefined && typeof args.description !== "string") {
    return { ok: false, error: "Bash.description must be a string." };
  }

  if (
    args.run_in_background !== undefined &&
    typeof args.run_in_background !== "boolean"
  ) {
    return { ok: false, error: "Bash.run_in_background must be a boolean." };
  }

  return {
    ok: true,
    value: {
      command: args.command,
      timeout: timeout.value,
      description:
        args.description === undefined || args.description.trim() === ""
          ? undefined
          : args.description,
      run_in_background: args.run_in_background,
    },
  };
}

export function interpretCommandResult(input: {
  command: string;
  exitCode?: number;
  status: BashRawResult["status"];
}): { ok: boolean; status: BashRawResult["status"]; interpretation?: string } {
  if (input.status === "running") {
    return { ok: true, status: "running" };
  }

  if (input.status === "killed") {
    return { ok: false, status: "killed" };
  }

  const exitCode = input.exitCode ?? 1;
  if (exitCode === 0) {
    return { ok: true, status: "completed" };
  }

  const commandName = lastPipelineCommandName(input.command);
  const interpretation = interpretInformationalExitCode(commandName, exitCode);
  if (interpretation !== undefined) {
    return {
      ok: true,
      status: "completed",
      interpretation,
    };
  }

  return { ok: false, status: "failed" };
}

type ForegroundWaitResult =
  | { type: "completed"; task: ShellTaskSnapshot }
  | { type: "timeout" }
  | { type: "cancelled" };

async function waitForTask(
  task: ShellTaskHandle,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ForegroundWaitResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    return await Promise.race([
      task.completion.then(
        (snapshot): ForegroundWaitResult => ({
          type: "completed",
          task: snapshot,
        }),
      ),
      new Promise<ForegroundWaitResult>((resolve) => {
        timeout = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
      }),
      new Promise<ForegroundWaitResult>((resolve) => {
        onAbort = () => resolve({ type: "cancelled" });
        if (signal.aborted) {
          onAbort();
          return;
        }

        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function buildRunningResult(input: {
  inspection: ShellTaskInspection;
  timedOut?: boolean;
  backgrounded?: boolean;
  backgroundedDueToTimeout?: boolean;
  timeoutMs?: number;
}): BashRawResult {
  const { task, output } = input.inspection;

  return {
    ok: true,
    command: task.command,
    taskId: task.taskId,
    sessionId: task.origin.sessionId,
    status: "running",
    cwd: task.cwd,
    outputFilePath: task.outputFilePath,
    outputBytes: output.outputBytes,
    outputLines: output.outputLines,
    preview: output.preview,
    truncated: output.truncated,
    omittedLines: output.omittedLines,
    timedOut: input.timedOut,
    timeoutMs: input.timeoutMs,
    backgrounded: input.backgrounded,
    backgroundedDueToTimeout: input.backgroundedDueToTimeout,
  };
}

async function buildCompletedResult(
  task: ShellTaskSnapshot,
  fallbackOutput: TaskOutputSnapshot,
): Promise<BashRawResult> {
  if (task.status === "running" || task.status === "stopping") {
    throw new Error(`Bash task ${task.taskId} completed with status=${task.status}.`);
  }

  const snapshot = await snapshotCompletedOutput(task, fallbackOutput);
  const interpretation = interpretCommandResult({
    command: task.command,
    exitCode: task.exitCode,
    status: task.status,
  });

  return {
    ok: interpretation.ok,
    command: task.command,
    taskId: task.taskId,
    sessionId: task.origin.sessionId,
    status: interpretation.status,
    exitCode: task.exitCode,
    signal: task.signal,
    cwd: task.cwd,
    outputFilePath: task.outputFilePath,
    outputBytes: snapshot.outputBytes,
    outputLines: snapshot.outputLines,
    preview: snapshot.preview,
    truncated: snapshot.truncated,
    omittedLines: snapshot.omittedLines,
    returnCodeInterpretation: interpretation.interpretation,
    error: task.error,
  };
}

async function snapshotCompletedOutput(
  task: ShellTaskSnapshot,
  fallback: TaskOutputSnapshot,
): Promise<TaskOutputSnapshot> {
  try {
    const content = await readFile(task.outputFilePath);
    return buildOutputSnapshotFromText(content);
  } catch {
    return fallback;
  }
}

function updateCwdStateAfterForegroundCommand(input: {
  raw: BashRawResult;
  task: ShellTaskSnapshot;
  cwdState: CwdState;
  workspaceRoot: string;
}): void {
  if (
    input.raw.ok &&
    input.raw.status === "completed" &&
    isWorkspaceLocalCwd(input.workspaceRoot, input.task.cwd)
  ) {
    input.cwdState.cwd = input.task.cwd;
  }
}

function requireTaskInspection(
  taskManager: ShellTaskManager,
  taskId: string,
): ShellTaskInspection {
  const inspection = taskManager.inspectTask(taskId);
  if (inspection === undefined) {
    throw new Error(`Bash task disappeared from task manager: ${taskId}`);
  }

  return inspection;
}

function parseOptionalTimeout(
  value: unknown,
  maxTimeoutMs: number,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }

  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    return { ok: false, error: "Bash.timeout must be a positive integer." };
  }

  if (value > maxTimeoutMs) {
    return {
      ok: false,
      error: `Bash.timeout must be less than or equal to ${maxTimeoutMs}.`,
    };
  }

  return { ok: true, value };
}

function lastPipelineCommandName(command: string): string | undefined {
  const segments = command.split("|");
  const lastSegment = segments.at(-1)?.trim();
  if (lastSegment === undefined || lastSegment === "") {
    return undefined;
  }

  const firstToken = lastSegment.match(/^[\s([{]*([^\s;&|)]+)/)?.[1];
  if (firstToken === undefined) {
    return undefined;
  }

  return firstToken.split("/").at(-1);
}

function interpretInformationalExitCode(
  commandName: string | undefined,
  exitCode: number,
): string | undefined {
  if (exitCode !== 1 || commandName === undefined) {
    return undefined;
  }

  const interpretations = new Map<string, string>([
    ["grep", "No matches found."],
    ["rg", "No matches found."],
    ["find", "Some directories were inaccessible."],
    ["diff", "Files differ."],
    ["test", "Condition is false."],
    ["[", "Condition is false."],
  ]);

  return interpretations.get(commandName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
