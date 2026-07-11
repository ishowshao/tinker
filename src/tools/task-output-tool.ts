import type { ShellTaskManager } from "./bash-task";
import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import { parseTaskIdArgs } from "./task-tool-args";
import { defineToolExecutor } from "./types";
import type { TaskOutputRawResult, ToolExecutionContext, ToolExecutor } from "./types";

export function createTaskOutputToolExecutor(options: {
  taskManager: ShellTaskManager;
}): ToolExecutor {
  return defineToolExecutor("task_output", {
    definition: {
      name: "TaskOutput",
      description: "Get the current status and latest output of a shell task.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: {
            type: "string",
            description: "The task ID returned by Bash or TaskList.",
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
      const parsed = parseTaskIdArgs(args, "TaskOutput");
      if (!parsed.ok) {
        return { ok: false, taskId: "", error: parsed.error };
      }

      const inspection = options.taskManager.inspectTask(parsed.taskId);
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
        outputFilePath: inspection.task.outputFilePath,
      };
    },
  });
}
