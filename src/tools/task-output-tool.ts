import type { ShellTaskManager } from "./bash-task";
import { parseTaskIdArgs } from "./task-tool-args";
import type { TaskOutputRawResult, ToolExecutor } from "./types";

export function createTaskOutputToolExecutor(options: {
  taskManager: ShellTaskManager;
}): ToolExecutor {
  return {
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
    async execute(args): Promise<TaskOutputRawResult> {
      const parsed = parseTaskIdArgs(args, "TaskOutput");
      if (!parsed.ok) {
        return { ok: false, taskId: "", error: parsed.error };
      }

      const inspection = options.taskManager.inspectTask(parsed.taskId);
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
  };
}
