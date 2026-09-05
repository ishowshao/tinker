import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import {
  defineToolExecutor,
  type MemoryGetRawResult,
  type ToolDefinition,
  type ToolExecutor,
} from "../tools/types";
import { MAX_MEMORY_ID_BYTES, MEMORY_GET_TOOL_NAME } from "./contracts";

export const MEMORY_GET_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: MEMORY_GET_TOOL_NAME,
  description:
    "Read one stored memory in full by its memoryId from a MemorySearch result. Use this when a search hit's summary is truncated or you need its exact stored text, summary, and source metadata. The record is a derived historical summary that may be stale or wrong; verify current workspace facts with current tools.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "string",
        minLength: 1,
        maxLength: MAX_MEMORY_ID_BYTES,
        description: "The memoryId of a memory returned by MemorySearch.",
      },
    },
    required: ["id"],
  },
});

export function createMemoryGetToolExecutor(options: {
  readonly get: (memoryId: string, signal: AbortSignal) => Promise<MemoryGetRawResult>;
  readonly recordInvalidCall: () => Promise<void>;
}): ToolExecutor {
  return defineToolExecutor("memory_get", {
    definition: MEMORY_GET_TOOL_DEFINITION,
    async execute(args, _call, context): Promise<MemoryGetRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseMemoryGetArgs(args);
      if (!parsed.ok) {
        await options.recordInvalidCall();
        return { ok: false, error: parsed.error };
      }
      const result = await options.get(parsed.memoryId, context.signal);
      throwIfTurnCancelled(context.signal);
      return result;
    },
  });
}

type ParsedMemoryGetArgs =
  | { readonly ok: true; readonly memoryId: string }
  | { readonly ok: false; readonly error: string };

function parseMemoryGetArgs(args: unknown): ParsedMemoryGetArgs {
  if (!isRecord(args)) {
    return {
      ok: false,
      error: "MemoryGet arguments must be an object containing only id.",
    };
  }
  const unexpected = Object.keys(args).find((key) => key !== "id");
  if (unexpected !== undefined) {
    return {
      ok: false,
      error: `MemoryGet received unexpected field: ${unexpected}.`,
    };
  }
  if (typeof args.id !== "string") {
    return {
      ok: false,
      error: "MemoryGet.id must be a string.",
    };
  }
  const memoryId = args.id.trim();
  const bytes = Buffer.byteLength(memoryId, "utf8");
  if (bytes < 1 || bytes > MAX_MEMORY_ID_BYTES) {
    return {
      ok: false,
      error: `MemoryGet.id must be 1 to ${MAX_MEMORY_ID_BYTES} UTF-8 bytes after trimming.`,
    };
  }
  return { ok: true, memoryId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
