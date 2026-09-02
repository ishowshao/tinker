import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import { parseMessageId, type MessageId } from "../ids/runtime-id";
import {
  defineToolExecutor,
  ToolExecutionFatalError,
  type ContextMaintenanceHandle,
  type ContextStatusRawResult,
  type ContextSwapCandidatesRawResult,
  type ContextSwapRawResult,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutor,
} from "./types";

const DEFAULT_CANDIDATE_LIMIT = 20;
const MAX_CANDIDATE_LIMIT = 50;
const MAX_SWAP_CANDIDATES = 16;

export const CONTEXT_STATUS_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: "ContextStatus",
  description:
    "Inspect the current model-input token pressure without changing context. When pressure is high or critical, use ContextSwapCandidates to review eligible historical tool observations before choosing what to swap.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
});

export const CONTEXT_SWAP_CANDIDATES_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: "ContextSwapCandidates",
  description:
    "List currently eligible historical tool observations that can be replaced by compact Recall-backed placeholders. Results are ordered oldest first. Use candidate IDs with ContextSwap; listing does not change context.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_CANDIDATE_LIMIT,
        default: DEFAULT_CANDIDATE_LIMIT,
      },
      offset: {
        type: "integer",
        minimum: 0,
        default: 0,
      },
    },
  },
});

export const CONTEXT_SWAP_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: "ContextSwap",
  description:
    "Schedule selected ContextSwapCandidates for replacement by compact Recall-backed placeholders. The swap runs after this iteration's tool frame closes and preserves canonical history for RecallGet. Pass only candidate IDs returned by ContextSwapCandidates.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      candidate_ids: {
        type: "array",
        minItems: 1,
        maxItems: MAX_SWAP_CANDIDATES,
        uniqueItems: true,
        items: {
          type: "string",
          pattern:
            "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        },
      },
    },
    required: ["candidate_ids"],
  },
});

export const CONTEXT_MAINTENANCE_TOOL_DEFINITIONS: readonly ToolDefinition[] =
  Object.freeze([
    CONTEXT_STATUS_TOOL_DEFINITION,
    CONTEXT_SWAP_CANDIDATES_TOOL_DEFINITION,
    CONTEXT_SWAP_TOOL_DEFINITION,
  ]);

export function createContextStatusToolExecutor(): ToolExecutor {
  return defineToolExecutor("context_maintenance", {
    definition: CONTEXT_STATUS_TOOL_DEFINITION,
    async execute(args, _call, context): Promise<ContextStatusRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseEmptyArgs(args, "ContextStatus");
      if (!parsed.ok) {
        return { ok: false, operation: "status", error: parsed.error };
      }
      const result = await requireContextMaintenance(context).status(_call);
      throwIfTurnCancelled(context.signal);
      return result;
    },
  });
}

export function createContextSwapCandidatesToolExecutor(): ToolExecutor {
  return defineToolExecutor("context_maintenance", {
    definition: CONTEXT_SWAP_CANDIDATES_TOOL_DEFINITION,
    async execute(args, call, context): Promise<ContextSwapCandidatesRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseCandidatePageArgs(args);
      if (!parsed.ok) {
        return { ok: false, operation: "candidates", error: parsed.error };
      }
      const result = await requireContextMaintenance(context).candidates(call, {
        limit: parsed.limit,
        offset: parsed.offset,
      });
      throwIfTurnCancelled(context.signal);
      return result;
    },
  });
}

export function createContextSwapToolExecutor(): ToolExecutor {
  return defineToolExecutor("context_maintenance", {
    definition: CONTEXT_SWAP_TOOL_DEFINITION,
    async execute(args, call, context): Promise<ContextSwapRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseSwapArgs(args);
      if (!parsed.ok) {
        return {
          ok: false,
          operation: "swap",
          scheduled: [],
          rejected: [],
          error: parsed.error,
        };
      }
      const result = await requireContextMaintenance(context).swap(call, {
        candidateIds: parsed.candidateIds,
      });
      throwIfTurnCancelled(context.signal);
      return result;
    },
  });
}

function requireContextMaintenance(
  context: ToolExecutionContext,
): ContextMaintenanceHandle {
  if (context.contextMaintenance === undefined) {
    throw new ToolExecutionFatalError(
      "Context maintenance tools have no active runtime coordinator.",
    );
  }
  return context.contextMaintenance;
}

function parseEmptyArgs(
  args: unknown,
  toolName: string,
): { ok: true } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: `${toolName} arguments must be an object.` };
  }
  const unexpected = Object.keys(args)[0];
  return unexpected === undefined
    ? { ok: true }
    : {
        ok: false,
        error: `${toolName} received unexpected field: ${unexpected}.`,
      };
}

function parseCandidatePageArgs(
  args: unknown,
): { ok: true; limit: number; offset: number } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return {
      ok: false,
      error: "ContextSwapCandidates arguments must be an object.",
    };
  }
  const unexpected = Object.keys(args).find(
    (key) => key !== "limit" && key !== "offset",
  );
  if (unexpected !== undefined) {
    return {
      ok: false,
      error: `ContextSwapCandidates received unexpected field: ${unexpected}.`,
    };
  }
  const limit = args.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const offset = args.offset ?? 0;
  if (!isIntegerInRange(limit, 1, MAX_CANDIDATE_LIMIT)) {
    return {
      ok: false,
      error: `ContextSwapCandidates.limit must be an integer from 1 to ${MAX_CANDIDATE_LIMIT}.`,
    };
  }
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
    return {
      ok: false,
      error: "ContextSwapCandidates.offset must be a non-negative integer.",
    };
  }
  return { ok: true, limit: limit as number, offset: offset as number };
}

function parseSwapArgs(
  args: unknown,
): { ok: true; candidateIds: readonly MessageId[] } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "ContextSwap arguments must be an object." };
  }
  const unexpected = Object.keys(args).find((key) => key !== "candidate_ids");
  if (unexpected !== undefined) {
    return {
      ok: false,
      error: `ContextSwap received unexpected field: ${unexpected}.`,
    };
  }
  if (
    !Array.isArray(args.candidate_ids) ||
    args.candidate_ids.length < 1 ||
    args.candidate_ids.length > MAX_SWAP_CANDIDATES
  ) {
    return {
      ok: false,
      error: `ContextSwap.candidate_ids must contain 1 to ${MAX_SWAP_CANDIDATES} message IDs.`,
    };
  }

  const candidateIds: MessageId[] = [];
  const seen = new Set<string>();
  for (const candidate of args.candidate_ids) {
    if (typeof candidate !== "string") {
      return {
        ok: false,
        error: "ContextSwap.candidate_ids must contain only message ID strings.",
      };
    }
    let candidateId: MessageId;
    try {
      candidateId = parseMessageId(candidate);
    } catch {
      return {
        ok: false,
        error: "ContextSwap.candidate_ids contains an invalid message ID.",
      };
    }
    if (!seen.has(candidateId)) {
      seen.add(candidateId);
      candidateIds.push(candidateId);
    }
  }
  return { ok: true, candidateIds: Object.freeze(candidateIds) };
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
