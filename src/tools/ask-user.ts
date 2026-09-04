import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import {
  defineToolExecutor,
  type AskUserRawResult,
  type AskUserRequest,
  type ToolExecutionContext,
  type ToolExecutor,
} from "./types";

export function createAskUserToolExecutor(): ToolExecutor {
  return defineToolExecutor("ask_user", {
    definition: {
      name: "AskUser",
      description:
        "Ask the user one multiple-choice question when a material ambiguity prevents correct progress. Investigate the conversation and workspace first. Provide 2-6 options, each as a complete answer the user can select. The user may select one option or dismiss the question. If dismissed, use your own judgment and do not immediately repeat the same question. Call AskUser alone, without other tool calls in the same response.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question shown to the user.",
          },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 6,
            items: {
              type: "object",
              properties: {
                description: {
                  type: "string",
                  description: "An answer the user can select.",
                },
              },
              required: ["description"],
            },
          },
        },
        required: ["question", "options"],
      },
    },
    async execute(
      args,
      _call,
      context: ToolExecutionContext,
    ): Promise<AskUserRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseAskUserArgs(args);
      if (!parsed.ok) {
        return parsed;
      }
      if (context.askUser === undefined) {
        return { ok: false, error: "AskUser interaction is unavailable." };
      }
      const response = await context.askUser(parsed.request);
      throwIfTurnCancelled(context.signal);
      return response.outcome === "selected"
        ? { ok: true, outcome: "selected", answer: response.answer }
        : { ok: true, outcome: "dismissed" };
    },
  });
}

function parseAskUserArgs(
  args: unknown,
): { ok: true; request: AskUserRequest } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "AskUser arguments must be an object." };
  }
  if (typeof args.question !== "string") {
    return { ok: false, error: "AskUser question must be a string." };
  }
  if (!Array.isArray(args.options)) {
    return { ok: false, error: "AskUser options must be an array." };
  }
  if (args.options.length < 2 || args.options.length > 6) {
    return { ok: false, error: "AskUser options must contain between 2 and 6 items." };
  }
  const options: { description: string }[] = [];
  for (const [index, option] of args.options.entries()) {
    if (!isRecord(option) || typeof option.description !== "string") {
      return {
        ok: false,
        error: `AskUser option ${index + 1} must be an object with a string description.`,
      };
    }
    options.push({ description: option.description });
  }
  return {
    ok: true,
    request: Object.freeze({
      question: args.question,
      options: Object.freeze(options.map((option) => Object.freeze(option))),
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
