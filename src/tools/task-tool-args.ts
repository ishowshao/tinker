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

export function parseTaskOutputArgs(args: unknown):
  | {
      ok: true;
      taskId: string;
      range?: { offset: number; limit: number };
    }
  | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "TaskOutput arguments must be an object." };
  }
  const { offset, limit, ...rest } = args;
  const parsed = parseTaskIdArgs(rest, "TaskOutput");
  if (!parsed.ok) return parsed;
  for (const [name, value] of Object.entries({ offset, limit })) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || (value as number) < 1)
    ) {
      return {
        ok: false,
        error: `TaskOutput.${name} must be a positive safe integer.`,
      };
    }
  }
  if (offset === undefined && limit === undefined) return parsed;
  return {
    ...parsed,
    range: {
      offset: (offset as number | undefined) ?? 1,
      limit: (limit as number | undefined) ?? 200,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
