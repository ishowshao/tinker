import type { ShellTaskManager } from "./bash-task";
import { parseTaskIdArgs } from "./task-tool-args";
import type { TaskStopRawResult, ToolExecutor } from "./types";

export function createTaskStopToolExecutor(options: {
  taskManager: ShellTaskManager;
}): ToolExecutor {
  return {
    definition: {
      name: "TaskStop",
      description: "Stop a running background shell task.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: {
            type: "string",
            description: "The running task ID to stop.",
          },
        },
        required: ["task_id"],
      },
    },
    async execute(args): Promise<TaskStopRawResult> {
      const parsed = parseTaskIdArgs(args, "TaskStop");
      if (!parsed.ok) {
        return { ok: false, taskId: "", error: parsed.error };
      }

      try {
        const result = await options.taskManager.stopTask(parsed.taskId, "tool");
        return {
          ok: true,
          taskId: parsed.taskId,
          task: result.task,
          status: result.task.status,
          requestedSignal: result.requestedSignal,
          escalated: result.escalated,
        };
      } catch (error) {
        const inspection = options.taskManager.inspectTask(parsed.taskId);
        return {
          ok: false,
          taskId: parsed.taskId,
          task: inspection?.task,
          status: inspection?.task.status,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
