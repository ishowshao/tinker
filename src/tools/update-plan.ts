import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import {
  defineToolExecutor,
  type PlanStep,
  type ToolExecutionContext,
  type ToolExecutor,
  type UpdatePlanRawResult,
} from "./types";

const MAX_PLAN_ITEMS = 12;
const MAX_STEP_LENGTH = 200;
const MAX_EXPLANATION_LENGTH = 500;
const STATUSES = new Set(["pending", "in_progress", "completed"]);

export function createUpdatePlanToolExecutor(): ToolExecutor {
  return defineToolExecutor("update_plan", {
    definition: {
      name: "UpdatePlan",
      description:
        "Replace the current task plan with a complete ordered list of steps and their progress. Use an optional explanation when revising the approach. At most one step may be in_progress.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          explanation: {
            type: "string",
            maxLength: MAX_EXPLANATION_LENGTH,
            description: "Optional explanation for this plan update.",
          },
          plan: {
            type: "array",
            maxItems: MAX_PLAN_ITEMS,
            description: "The complete ordered task plan.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                step: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_STEP_LENGTH,
                  description: "Task step text.",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "Step status.",
                },
              },
              required: ["step", "status"],
            },
          },
        },
        required: ["plan"],
      },
    },
    async execute(
      args,
      _call,
      context: ToolExecutionContext,
    ): Promise<UpdatePlanRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseUpdatePlanArgs(args);
      if (!parsed.ok) {
        return parsed;
      }
      throwIfTurnCancelled(context.signal);
      return {
        ok: true,
        ...(parsed.explanation === undefined
          ? {}
          : { explanation: parsed.explanation }),
        plan: parsed.plan,
      };
    },
  });
}

type ParsedUpdatePlanArgs =
  | { ok: true; explanation?: string; plan: PlanStep[] }
  | { ok: false; error: string };

function parseUpdatePlanArgs(args: unknown): ParsedUpdatePlanArgs {
  if (!isRecord(args)) {
    return failure("UpdatePlan arguments must be an object.");
  }
  const unexpected = Object.keys(args).find(
    (key) => key !== "explanation" && key !== "plan",
  );
  if (unexpected !== undefined) {
    return failure(`UpdatePlan received unexpected argument: ${unexpected}.`);
  }
  if (!Array.isArray(args.plan)) {
    return failure("UpdatePlan plan must be an array.");
  }
  if (args.plan.length > MAX_PLAN_ITEMS) {
    return failure(`UpdatePlan accepts at most ${MAX_PLAN_ITEMS} steps.`);
  }

  let explanation: string | undefined;
  if (args.explanation !== undefined) {
    if (typeof args.explanation !== "string") {
      return failure("UpdatePlan explanation must be a string.");
    }
    explanation = args.explanation.trim();
    if (explanation.length > MAX_EXPLANATION_LENGTH) {
      return failure(
        `UpdatePlan explanation must be at most ${MAX_EXPLANATION_LENGTH} characters.`,
      );
    }
    if (explanation === "") {
      explanation = undefined;
    }
  }

  const plan: PlanStep[] = [];
  let inProgressCount = 0;
  for (const [index, item] of args.plan.entries()) {
    if (!isRecord(item)) {
      return failure(`UpdatePlan plan[${index}] must be an object.`);
    }
    const unexpectedItemKey = Object.keys(item).find(
      (key) => key !== "step" && key !== "status",
    );
    if (unexpectedItemKey !== undefined) {
      return failure(
        `UpdatePlan plan[${index}] received unexpected field: ${unexpectedItemKey}.`,
      );
    }
    if (typeof item.step !== "string" || item.step.trim() === "") {
      return failure(`UpdatePlan plan[${index}].step must be a non-empty string.`);
    }
    const step = item.step.trim();
    if (step.length > MAX_STEP_LENGTH) {
      return failure(
        `UpdatePlan plan[${index}].step must be at most ${MAX_STEP_LENGTH} characters.`,
      );
    }
    if (typeof item.status !== "string" || !STATUSES.has(item.status)) {
      return failure(
        `UpdatePlan plan[${index}].status must be pending, in_progress, or completed.`,
      );
    }
    if (item.status === "in_progress") {
      inProgressCount += 1;
    }
    plan.push({ step, status: item.status as PlanStep["status"] });
  }
  if (inProgressCount > 1) {
    return failure("UpdatePlan allows at most one in_progress step.");
  }

  return {
    ok: true,
    ...(explanation === undefined ? {} : { explanation }),
    plan,
  };
}

function failure(error: string): ParsedUpdatePlanArgs {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
