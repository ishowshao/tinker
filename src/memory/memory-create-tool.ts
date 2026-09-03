import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import type { ToolCall } from "../agent/types";
import {
  defineToolExecutor,
  type MemoryCreateRawResult,
  type ToolDefinition,
  type ToolExecutor,
} from "../tools/types";
import {
  MAX_MEMORY_SUMMARY_BYTES,
  MAX_MEMORY_TEXT_BYTES,
  MEMORY_CREATE_TOOL_NAME,
} from "./contracts";

export const MEMORY_CREATE_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: MEMORY_CREATE_TOOL_NAME,
  description: "Create one global memory shared across sessions and workspaces.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: {
        type: "string",
        minLength: 1,
        maxLength: MAX_MEMORY_TEXT_BYTES,
        description: "A one-line searchable index for this memory.",
      },
      summary: {
        type: "string",
        maxLength: MAX_MEMORY_SUMMARY_BYTES,
        description:
          "Optional details, reasons, constraints, and scope for the memory.",
      },
    },
    required: ["text"],
  },
});

export function createMemoryCreateToolExecutor(options: {
  readonly create: (
    text: string,
    summary: string,
    call: ToolCall,
    signal: AbortSignal,
  ) => Promise<MemoryCreateRawResult>;
  readonly recordInvalidCall: (call: ToolCall) => Promise<void>;
}): ToolExecutor {
  return defineToolExecutor("memory_create", {
    definition: MEMORY_CREATE_TOOL_DEFINITION,
    async execute(args, call, context): Promise<MemoryCreateRawResult> {
      const parsed = parseMemoryCreateArgs(args);
      if (!parsed.ok) {
        throwIfTurnCancelled(context.signal);
        await options.recordInvalidCall(call);
        throwIfTurnCancelled(context.signal);
        return { ok: false, error: parsed.error };
      }
      const result = await options.create(
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

type ParsedMemoryCreateArgs =
  | { readonly ok: true; readonly text: string; readonly summary: string }
  | { readonly ok: false; readonly error: string };

function parseMemoryCreateArgs(args: unknown): ParsedMemoryCreateArgs {
  if (!isRecord(args)) {
    return {
      ok: false,
      error:
        "MemoryCreate arguments must be an object containing only text and summary.",
    };
  }
  const unexpected = Object.keys(args).find(
    (key) => key !== "text" && key !== "summary",
  );
  if (unexpected !== undefined) {
    return {
      ok: false,
      error: `MemoryCreate received unexpected field: ${unexpected}.`,
    };
  }
  if (typeof args.text !== "string") {
    return { ok: false, error: "MemoryCreate.text must be a string." };
  }
  const text = args.text.trim();
  const textBytes = Buffer.byteLength(text, "utf8");
  if (textBytes < 1 || textBytes > MAX_MEMORY_TEXT_BYTES) {
    return {
      ok: false,
      error: `MemoryCreate.text must be 1 to ${MAX_MEMORY_TEXT_BYTES} UTF-8 bytes after trimming.`,
    };
  }
  if (args.summary !== undefined && typeof args.summary !== "string") {
    return { ok: false, error: "MemoryCreate.summary must be a string." };
  }
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (Buffer.byteLength(summary, "utf8") > MAX_MEMORY_SUMMARY_BYTES) {
    return {
      ok: false,
      error: `MemoryCreate.summary must be at most ${MAX_MEMORY_SUMMARY_BYTES} UTF-8 bytes after trimming.`,
    };
  }
  return { ok: true, text, summary };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
