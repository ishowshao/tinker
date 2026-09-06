import type { ShellTaskManager } from "./bash-task";
import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import { parseTaskIdArgs } from "./task-tool-args";
import { defineToolExecutor } from "./types";
import type { TaskStopRawResult, ToolExecutionContext, ToolExecutor } from "./types";

export function createTaskStopToolExecutor(options: {
  taskManager: ShellTaskManager;
}): ToolExecutor {
  return defineToolExecutor("task_stop", {
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
    async execute(
      args,
      _call,
      context: ToolExecutionContext,
    ): Promise<TaskStopRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseTaskIdArgs(args, "TaskStop");
      if (!parsed.ok) {
        return { ok: false, taskId: "", error: parsed.error };
      }

      try {
        const result = await options.taskManager.stopTask(parsed.taskId, "tool");
        return {
          ok: result.task.error === undefined,
          taskId: parsed.taskId,
          task: result.task,
          status: result.task.status,
          requestedSignal: result.requestedSignal,
          escalated: result.escalated,
          ...(result.task.error === undefined ? {} : { error: result.task.error }),
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
  });
}
