export function parseTaskIdArgs(
  args: unknown,
  toolName: "TaskOutput" | "TaskStop",
): { ok: true; taskId: string } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: `${toolName} arguments must be an object.` };
  }

  const unexpected = Object.keys(args).filter((key) => key !== "task_id");
  if (unexpected.length > 0) {
    return {
      ok: false,
      error: `${toolName} received unexpected argument: ${unexpected[0]}.`,
    };
  }

  if (typeof args.task_id !== "string" || args.task_id.trim() === "") {
    return {
      ok: false,
      error: `${toolName}.task_id must be a non-empty string.`,
    };
  }

  return { ok: true, taskId: args.task_id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
