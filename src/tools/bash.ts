import { readFile } from "node:fs/promises";
import { ShellTaskManager, type ShellTask, type ShellTaskStatus } from "./bash-task";
import { isWorkspaceLocalCwd, type CwdState } from "./cwd-state";
import { buildOutputSnapshotFromText } from "./task-output-snapshot";
import type { TaskOutputSnapshot } from "./task-output";
import type { BashRawResult, ToolExecutor } from "./types";

type BashArgs = {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
};

export type BashToolOptions = {
  workspaceRoot: string;
  runId: string;
  cwdState: CwdState;
  taskManager: ShellTaskManager;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
};

const defaultForegroundTimeoutMs = 5_000;
const defaultMaxForegroundTimeoutMs = 600_000;

export function createBashToolExecutor(options: BashToolOptions): ToolExecutor {
  const maxTimeoutMs =
    options.maxTimeoutMs ??
    parsePositiveInteger(
      process.env.TINKER_BASH_MAX_TIMEOUT_MS,
      defaultMaxForegroundTimeoutMs,
    );
  const defaultTimeoutMs =
    options.defaultTimeoutMs ??
    Math.min(
      parsePositiveInteger(
        process.env.TINKER_BASH_DEFAULT_TIMEOUT_MS,
        defaultForegroundTimeoutMs,
      ),
      maxTimeoutMs,
    );

  return {
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
    async execute(args): Promise<BashRawResult> {
      const parsed = parseBashArgs(args, maxTimeoutMs);

      if (!parsed.ok) {
        return {
          ok: false,
          command: "",
          taskId: "",
          runId: options.runId,
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
      const task = await options.taskManager.start({
        command: input.command,
        description: input.description ?? input.command,
      });

      if (input.run_in_background === true) {
        return buildRunningResult({
          task,
          backgrounded: true,
        });
      }

      const completed = await waitForTask(task, foregroundTimeoutMs);
      if (completed === undefined) {
        return buildRunningResult({
          task,
          timedOut: true,
          backgrounded: true,
          backgroundedDueToTimeout: true,
          timeoutMs: foregroundTimeoutMs,
        });
      }

      const raw = await buildCompletedResult(completed);
      updateCwdStateAfterForegroundCommand({
        raw,
        task: completed,
        cwdState: options.cwdState,
        workspaceRoot: options.workspaceRoot,
      });
      return raw;
    },
  };
}

export function parseBashArgs(
  args: unknown,
  maxTimeoutMs = defaultMaxForegroundTimeoutMs,
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
  status: ShellTaskStatus;
}): { ok: boolean; status: ShellTaskStatus; interpretation?: string } {
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

async function waitForTask(
  task: ShellTask,
  timeoutMs: number,
): Promise<ShellTask | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      task.completion,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function buildRunningResult(input: {
  task: ShellTask;
  timedOut?: boolean;
  backgrounded?: boolean;
  backgroundedDueToTimeout?: boolean;
  timeoutMs?: number;
}): BashRawResult {
  const snapshot = input.task.output.snapshot();

  return {
    ok: true,
    command: input.task.command,
    taskId: input.task.id,
    runId: input.task.runId,
    status: "running",
    cwd: input.task.cwd,
    outputFilePath: input.task.outputFilePath,
    outputBytes: snapshot.outputBytes,
    outputLines: snapshot.outputLines,
    preview: snapshot.preview,
    truncated: snapshot.truncated,
    omittedLines: snapshot.omittedLines,
    timedOut: input.timedOut,
    timeoutMs: input.timeoutMs,
    backgrounded: input.backgrounded,
    backgroundedDueToTimeout: input.backgroundedDueToTimeout,
  };
}

async function buildCompletedResult(task: ShellTask): Promise<BashRawResult> {
  const snapshot = await snapshotCompletedOutput(task);
  const interpretation = interpretCommandResult({
    command: task.command,
    exitCode: task.exitCode,
    status: task.status,
  });

  return {
    ok: interpretation.ok,
    command: task.command,
    taskId: task.id,
    runId: task.runId,
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

async function snapshotCompletedOutput(task: ShellTask): Promise<TaskOutputSnapshot> {
  try {
    const content = await readFile(task.outputFilePath);
    return buildOutputSnapshotFromText(content);
  } catch {
    return task.output.snapshot();
  }
}

function updateCwdStateAfterForegroundCommand(input: {
  raw: BashRawResult;
  task: ShellTask;
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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
