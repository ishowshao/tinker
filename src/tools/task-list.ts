import type { ShellTaskManager } from "./bash-task";
import type { TaskListRawResult, ToolExecutor } from "./types";

export function createTaskListToolExecutor(options: {
  taskManager: ShellTaskManager;
}): ToolExecutor {
  return {
    definition: {
      name: "TaskList",
      description: "List background shell tasks in the current session.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    async execute(args): Promise<TaskListRawResult> {
      if (!isRecord(args)) {
        return {
          ok: false,
          runningCount: 0,
          tasks: [],
          error: "TaskList arguments must be an object.",
        };
      }

      const unexpected = Object.keys(args)[0];
      if (unexpected !== undefined) {
        return {
          ok: false,
          runningCount: 0,
          tasks: [],
          error: `TaskList received unexpected argument: ${unexpected}.`,
        };
      }

      const tasks = options.taskManager.listBackgroundTasks();
      return {
        ok: true,
        runningCount: tasks.filter(
          (task) => task.status === "running" || task.status === "stopping",
        ).length,
        tasks,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
