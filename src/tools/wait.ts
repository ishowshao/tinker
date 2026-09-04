import { cancellationError, throwIfTurnCancelled } from "../agent/turn-cancellation";
import {
  defineToolExecutor,
  type ToolExecutionContext,
  type ToolExecutor,
  type WaitRawResult,
} from "./types";

const MIN_WAIT_SECONDS = 1;
const MAX_WAIT_SECONDS = 3600;

export function createWaitToolExecutor(): ToolExecutor {
  return defineToolExecutor("wait", {
    definition: {
      name: "Wait",
      description: `Wait for a given number of integer seconds before continuing, from ${MIN_WAIT_SECONDS} to ${MAX_WAIT_SECONDS}. `,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          seconds: {
            type: "integer",
            minimum: MIN_WAIT_SECONDS,
            maximum: MAX_WAIT_SECONDS,
            description: "Whole seconds to wait.",
          },
        },
        required: ["seconds"],
      },
    },
    async execute(args, _call, context: ToolExecutionContext): Promise<WaitRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseWaitArgs(args);
      if (!parsed.ok) {
        return parsed;
      }
      const startedAt = Date.now();
      await interruptibleSleep(parsed.seconds * 1_000, context.signal);
      throwIfTurnCancelled(context.signal);
      return { ok: true, seconds: parsed.seconds, waitedMs: Date.now() - startedAt };
    },
  });
}

type ParsedWaitArgs = { ok: true; seconds: number } | { ok: false; error: string };

function parseWaitArgs(args: unknown): ParsedWaitArgs {
  if (!isRecord(args)) {
    return { ok: false, error: "Wait arguments must be an object." };
  }
  const unexpected = Object.keys(args).find((key) => key !== "seconds");
  if (unexpected !== undefined) {
    return { ok: false, error: `Wait received unexpected argument: ${unexpected}.` };
  }
  if (typeof args.seconds !== "number" || !Number.isInteger(args.seconds)) {
    return { ok: false, error: "Wait seconds must be an integer." };
  }
  if (args.seconds < MIN_WAIT_SECONDS || args.seconds > MAX_WAIT_SECONDS) {
    return {
      ok: false,
      error: `Wait seconds must be between ${MIN_WAIT_SECONDS} and ${MAX_WAIT_SECONDS}.`,
    };
  }
  return { ok: true, seconds: args.seconds };
}

function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancellationError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
