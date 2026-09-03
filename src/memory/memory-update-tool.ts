import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import type { ToolCall } from "../agent/types";
import {
  defineToolExecutor,
  type MemoryUpdateRawResult,
  type ToolDefinition,
  type ToolExecutor,
} from "../tools/types";
import {
  MAX_MEMORY_ID_BYTES,
  MAX_MEMORY_SUMMARY_BYTES,
  MAX_MEMORY_TEXT_BYTES,
  MEMORY_UPDATE_TOOL_NAME,
} from "./contracts";

export const MEMORY_UPDATE_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: MEMORY_UPDATE_TOOL_NAME,
  description: "Replace one global memory shared across sessions and workspaces.",
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
      text: {
        type: "string",
        minLength: 1,
        maxLength: MAX_MEMORY_TEXT_BYTES,
        description: "The complete replacement one-line searchable index.",
      },
      summary: {
        type: "string",
        maxLength: MAX_MEMORY_SUMMARY_BYTES,
        description:
          "The complete replacement details, reasons, constraints, and scope.",
      },
    },
    required: ["id", "text", "summary"],
  },
});

export function createMemoryUpdateToolExecutor(options: {
  readonly update: (
    memoryId: string,
    text: string,
    summary: string,
    call: ToolCall,
    signal: AbortSignal,
  ) => Promise<MemoryUpdateRawResult>;
  readonly recordInvalidCall: (call: ToolCall) => Promise<void>;
}): ToolExecutor {
  return defineToolExecutor("memory_update", {
    definition: MEMORY_UPDATE_TOOL_DEFINITION,
    async execute(args, call, context): Promise<MemoryUpdateRawResult> {
      const parsed = parseMemoryUpdateArgs(args);
      if (!parsed.ok) {
        throwIfTurnCancelled(context.signal);
        await options.recordInvalidCall(call);
        throwIfTurnCancelled(context.signal);
        return { ok: false, error: parsed.error };
      }
      const result = await options.update(
        parsed.memoryId,
        parsed.text,
        parsed.summary,
        call,
        context.signal,
      );
      throwIfTurnCancelled(context.signal);
      return result;
    },
  });
}

type ParsedMemoryUpdateArgs =
  | {
      readonly ok: true;
      readonly memoryId: string;
      readonly text: string;
      readonly summary: string;
    }
  | { readonly ok: false; readonly error: string };

function parseMemoryUpdateArgs(args: unknown): ParsedMemoryUpdateArgs {
  if (!isRecord(args)) {
    return {
      ok: false,
      error:
        "MemoryUpdate arguments must be an object containing only id, text, and summary.",
    };
  }
  const unexpected = Object.keys(args).find(
    (key) => key !== "id" && key !== "text" && key !== "summary",
  );
  if (unexpected !== undefined) {
    return {
      ok: false,
      error: `MemoryUpdate received unexpected field: ${unexpected}.`,
    };
  }
  if (typeof args.id !== "string") {
    return { ok: false, error: "MemoryUpdate.id must be a string." };
  }
  const memoryId = args.id.trim();
  const idBytes = Buffer.byteLength(memoryId, "utf8");
  if (idBytes < 1 || idBytes > MAX_MEMORY_ID_BYTES) {
    return {
      ok: false,
      error: `MemoryUpdate.id must be 1 to ${MAX_MEMORY_ID_BYTES} UTF-8 bytes after trimming.`,
    };
  }
  if (typeof args.text !== "string") {
    return { ok: false, error: "MemoryUpdate.text must be a string." };
  }
  const text = args.text.trim();
  const textBytes = Buffer.byteLength(text, "utf8");
  if (textBytes < 1 || textBytes > MAX_MEMORY_TEXT_BYTES) {
    return {
      ok: false,
      error: `MemoryUpdate.text must be 1 to ${MAX_MEMORY_TEXT_BYTES} UTF-8 bytes after trimming.`,
    };
  }
  if (typeof args.summary !== "string") {
    return { ok: false, error: "MemoryUpdate.summary must be a string." };
  }
  const summary = args.summary.trim();
  if (Buffer.byteLength(summary, "utf8") > MAX_MEMORY_SUMMARY_BYTES) {
    return {
      ok: false,
      error: `MemoryUpdate.summary must be at most ${MAX_MEMORY_SUMMARY_BYTES} UTF-8 bytes after trimming.`,
    };
  }
  return { ok: true, memoryId, text, summary };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
