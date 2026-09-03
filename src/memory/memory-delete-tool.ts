import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import type { ToolCall } from "../agent/types";
import {
  defineToolExecutor,
  type MemoryDeleteRawResult,
  type ToolDefinition,
  type ToolExecutor,
} from "../tools/types";
import { MAX_MEMORY_ID_BYTES, MEMORY_DELETE_TOOL_NAME } from "./contracts";

export const MEMORY_DELETE_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: MEMORY_DELETE_TOOL_NAME,
  description: "Delete one global memory shared across sessions and workspaces.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "string",
        minLength: 1,
        maxLength: MAX_MEMORY_ID_BYTES,
        description: "The memoryId returned by MemorySearch or MemoryGet.",
      },
    },
    required: ["id"],
  },
});

export function createMemoryDeleteToolExecutor(options: {
  readonly delete: (
    memoryId: string,
    call: ToolCall,
    signal: AbortSignal,
  ) => Promise<MemoryDeleteRawResult>;
  readonly recordInvalidCall: (call: ToolCall) => Promise<void>;
}): ToolExecutor {
  return defineToolExecutor("memory_delete", {
    definition: MEMORY_DELETE_TOOL_DEFINITION,
    async execute(args, call, context): Promise<MemoryDeleteRawResult> {
      const parsed = parseMemoryDeleteArgs(args);
      if (!parsed.ok) {
        throwIfTurnCancelled(context.signal);
        await options.recordInvalidCall(call);
        throwIfTurnCancelled(context.signal);
        return { ok: false, error: parsed.error };
      }
      const result = await options.delete(parsed.memoryId, call, context.signal);
      throwIfTurnCancelled(context.signal);
      return result;
    },
  });
}

type ParsedMemoryDeleteArgs =
  | { readonly ok: true; readonly memoryId: string }
  | { readonly ok: false; readonly error: string };

function parseMemoryDeleteArgs(args: unknown): ParsedMemoryDeleteArgs {
  if (!isRecord(args)) {
    return {
      ok: false,
      error: "MemoryDelete arguments must be an object containing only id.",
    };
  }
  const unexpected = Object.keys(args).find((key) => key !== "id");
  if (unexpected !== undefined) {
    return {
      ok: false,
      error: `MemoryDelete received unexpected field: ${unexpected}.`,
    };
  }
  if (typeof args.id !== "string") {
    return { ok: false, error: "MemoryDelete.id must be a string." };
  }
  const memoryId = args.id.trim();
  const bytes = Buffer.byteLength(memoryId, "utf8");
  if (bytes < 1 || bytes > MAX_MEMORY_ID_BYTES) {
    return {
      ok: false,
      error: `MemoryDelete.id must be 1 to ${MAX_MEMORY_ID_BYTES} UTF-8 bytes after trimming.`,
    };
  }
  return { ok: true, memoryId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
