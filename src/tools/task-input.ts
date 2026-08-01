import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import type { ShellTaskManager, ShellTaskSnapshot } from "./bash-task";
import { ShellProcessWriteError } from "./shell-process";
import { defineToolExecutor } from "./types";
import type { TaskInputRawResult, ToolExecutionContext, ToolExecutor } from "./types";

type TaskInputArgs = {
  taskId: string;
  chars: string;
  waitMs: number;
};

const defaultWaitMs = 250;
const maxWaitMs = 30_000;

export function createTaskInputToolExecutor(options: {
  taskManager: ShellTaskManager;
}): ToolExecutor {
  return defineToolExecutor("task_input", {
    definition: {
      name: "TaskInput",
      description:
        "Write characters to a PTY shell task and return its current terminal screen.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: {
            type: "string",
            description: "The PTY task ID returned by Bash or TaskList.",
          },
          chars: {
            type: "string",
            description:
              "Characters to write exactly as provided. Use an empty string to poll without writing.",
          },
          wait_ms: {
            type: "integer",
            minimum: 0,
            maximum: maxWaitMs,
            description:
              "Milliseconds to wait before returning the current screen. Defaults to 250.",
          },
        },
        required: ["task_id", "chars"],
      },
    },
    async execute(
      args,
      _call,
      context: ToolExecutionContext,
    ): Promise<TaskInputRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseTaskInputArgs(args);
      if (!parsed.ok) {
        return { ok: false, taskId: "", error: parsed.error };
      }

      const { taskId, chars, waitMs } = parsed.value;
      const initial = options.taskManager.inspectTask(taskId);
      if (initial === undefined) {
        return { ok: false, taskId, error: `Unknown task ID: ${taskId}` };
      }
      if (!initial.task.tty) {
        return taskInputFailure(
          initial.task,
          `Task ${taskId} does not accept terminal input; start it with Bash tty=true.`,
        );
      }
      if (chars !== "" && initial.task.status !== "running") {
        return taskInputFailure(
          initial.task,
          `Task ${taskId} is not running (status=${initial.task.status}).`,
        );
      }

      let writtenBytes = 0;
      if (chars !== "") {
        try {
          writtenBytes = await options.taskManager.writeTaskInput(taskId, chars);
        } catch (error) {
          const current = options.taskManager.inspectTask(taskId)?.task ?? initial.task;
          return {
            ...taskInputFailure(
              current,
              error instanceof Error ? error.message : String(error),
            ),
            writtenBytes:
              error instanceof ShellProcessWriteError
                ? error.writtenBytes
                : writtenBytes,
          };
        }
      }

      throwIfTurnCancelled(context.signal);
      const waitStartedAt = Date.now();
      await waitForCollectionWindow({
        waitMs,
        completion: options.taskManager.taskCompletion(taskId),
        signal: context.signal,
      });
      throwIfTurnCancelled(context.signal);

      const inspection = await options.taskManager.inspectTaskOutput(taskId);
      if (inspection === undefined) {
        return {
          ok: false,
          taskId,
          writtenBytes,
          error: `Task disappeared while waiting for terminal output: ${taskId}`,
        };
      }
      if (
        inspection.screen === undefined ||
        inspection.screenRows === undefined ||
        inspection.screenColumns === undefined
      ) {
        throw new Error(`PTY task ${taskId} has no terminal screen.`);
      }

      return {
        ok: true,
        taskId,
        task: inspection.task,
        status: inspection.task.status,
        writtenBytes,
        waitedMs: Math.max(0, Date.now() - waitStartedAt),
        screenRows: inspection.screenRows,
        screenColumns: inspection.screenColumns,
        screen: inspection.screen,
        outputBytes: inspection.output.outputBytes,
        outputLines: inspection.output.outputLines,
        outputFilePath: inspection.task.outputFilePath,
      };
    },
  });
}

export function parseTaskInputArgs(
  args: unknown,
): { ok: true; value: TaskInputArgs } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "TaskInput arguments must be an object." };
  }

  const allowed = new Set(["task_id", "chars", "wait_ms"]);
  const unexpected = Object.keys(args).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    return {
      ok: false,
      error: `TaskInput received unexpected argument: ${unexpected}.`,
    };
  }
  if (typeof args.task_id !== "string" || args.task_id.trim() === "") {
    return { ok: false, error: "TaskInput.task_id must be a non-empty string." };
  }
  if (typeof args.chars !== "string") {
    return { ok: false, error: "TaskInput.chars must be a string." };
  }
  if (
    args.wait_ms !== undefined &&
    (!Number.isInteger(args.wait_ms) ||
      typeof args.wait_ms !== "number" ||
      args.wait_ms < 0 ||
      args.wait_ms > maxWaitMs)
  ) {
    return {
      ok: false,
      error: `TaskInput.wait_ms must be an integer between 0 and ${maxWaitMs}.`,
    };
  }

  return {
    ok: true,
    value: {
      taskId: args.task_id,
      chars: args.chars,
      waitMs: args.wait_ms ?? defaultWaitMs,
    },
  };
}

function taskInputFailure(task: ShellTaskSnapshot, error: string): TaskInputRawResult {
  return {
    ok: false,
    taskId: task.taskId,
    task,
    status: task.status,
    error,
  };
}

async function waitForCollectionWindow(input: {
  waitMs: number;
  completion: Promise<ShellTaskSnapshot>;
  signal: AbortSignal;
}): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    await Promise.race([
      input.completion.then(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, input.waitMs);
      }),
      new Promise<void>((resolve) => {
        onAbort = () => resolve();
        if (input.signal.aborted) {
          onAbort();
          return;
        }
        input.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (onAbort !== undefined) {
      input.signal.removeEventListener("abort", onAbort);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
