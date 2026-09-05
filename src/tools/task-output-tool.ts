import type { ShellTaskInspection, ShellTaskManager } from "./bash-task";
import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import { parseTaskOutputArgs } from "./task-tool-args";
import { defineToolExecutor } from "./types";
import type { TaskOutputRawResult, ToolExecutionContext, ToolExecutor } from "./types";

export function createTaskOutputToolExecutor(options: {
  taskManager: ShellTaskManager;
}): ToolExecutor {
  return defineToolExecutor("task_output", {
    definition: {
      name: "TaskOutput",
      description:
        "Get a shell task's status and output. Defaults to a head/tail log preview or current PTY screen. For non-PTY tasks, offset/limit selects consecutive numbered log lines instead; PTY tasks ignore these parameters. truncated means content within the requested range was shortened by byte limits, not that other log lines exist. When polling a running log, reread its last line because it may still be growing.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: {
            type: "string",
            description: "The task ID returned by Bash or TaskList.",
          },
          offset: {
            type: "integer",
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
            description:
              "1-based starting log line. Supplying offset or limit selects consecutive lines; default offset is 1. Ignored for PTY tasks.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
            description:
              "Maximum number of consecutive log lines to read (default 200 in range mode), subject to byte limits. Ignored for PTY tasks.",
          },
        },
        required: ["task_id"],
      },
    },
    async execute(
      args,
      _call,
      context: ToolExecutionContext,
    ): Promise<TaskOutputRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseTaskOutputArgs(args);
      if (!parsed.ok) {
        return { ok: false, taskId: "", error: parsed.error };
      }

      let inspection: ShellTaskInspection | undefined;
      try {
        inspection = await options.taskManager.inspectTaskOutput(
          parsed.taskId,
          parsed.range,
          context.signal,
        );
      } catch (error) {
        throwIfTurnCancelled(context.signal);
        return {
          ok: false,
          taskId: parsed.taskId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      throwIfTurnCancelled(context.signal);
      if (inspection === undefined) {
        return {
          ok: false,
          taskId: parsed.taskId,
          error: `Unknown task ID: ${parsed.taskId}`,
        };
      }

      return {
        ok: true,
        taskId: parsed.taskId,
        task: inspection.task,
        status: inspection.task.status,
        command: inspection.task.command,
        outputBytes: inspection.output.outputBytes,
        outputLines: inspection.output.outputLines,
        preview: inspection.output.preview,
        truncated: inspection.output.truncated,
        omittedLines: inspection.output.omittedLines,
        range: inspection.output.range,
        outputFilePath: inspection.task.outputFilePath,
        screenRows: inspection.screenRows,
        screenColumns: inspection.screenColumns,
        screen: inspection.screen,
      };
    },
  });
}
