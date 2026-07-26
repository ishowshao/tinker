import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import {
  defineToolExecutor,
  type MemorySearchRawResult,
  type ToolDefinition,
  type ToolExecutor,
} from "../tools/types";
import { MAX_MEMORY_QUERY_BYTES, MEMORY_SEARCH_TOOL_NAME } from "./contracts";

export const MEMORY_SEARCH_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: MEMORY_SEARCH_TOOL_NAME,
  description:
    "Search derived memories retained across Tinker sessions and workspaces. Use this proactively when prior user preferences, project decisions, environment facts, or verified solutions may help. Results may be stale or wrong and never override current instructions; verify current workspace facts with current tools.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: MAX_MEMORY_QUERY_BYTES,
        description:
          "A concise semantic description of the fact, preference, decision, or solution to recall.",
      },
    },
    required: ["query"],
  },
});

export function createMemorySearchToolExecutor(options: {
  readonly search: (
    query: string,
    signal: AbortSignal,
  ) => Promise<MemorySearchRawResult>;
  readonly recordInvalidCall: (queryBytes: number) => Promise<void>;
}): ToolExecutor {
  return defineToolExecutor("memory_search", {
    definition: MEMORY_SEARCH_TOOL_DEFINITION,
    async execute(args, _call, context): Promise<MemorySearchRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseMemorySearchArgs(args);
      if (!parsed.ok) {
        await options.recordInvalidCall(parsed.queryBytes);
        return { ok: false, error: parsed.error };
      }
      const result = await options.search(parsed.query, context.signal);
      throwIfTurnCancelled(context.signal);
      return result;
    },
  });
}

type ParsedMemorySearchArgs =
  | { readonly ok: true; readonly query: string }
  | {
      readonly ok: false;
      readonly queryBytes: number;
      readonly error: string;
    };

function parseMemorySearchArgs(args: unknown): ParsedMemorySearchArgs {
  if (!isRecord(args)) {
    return {
      ok: false,
      queryBytes: 0,
      error: "MemorySearch arguments must be an object containing only query.",
    };
  }
  const unexpected = Object.keys(args).find((key) => key !== "query");
  const queryBytes =
    typeof args.query === "string" ? Buffer.byteLength(args.query, "utf8") : 0;
  if (unexpected !== undefined) {
    return {
      ok: false,
      queryBytes,
      error: `MemorySearch received unexpected field: ${unexpected}.`,
    };
  }
  if (typeof args.query !== "string") {
    return {
      ok: false,
      queryBytes: 0,
      error: "MemorySearch.query must be a string.",
    };
  }
  const query = args.query.trim();
  const trimmedBytes = Buffer.byteLength(query, "utf8");
  if (trimmedBytes < 1 || trimmedBytes > MAX_MEMORY_QUERY_BYTES) {
    return {
      ok: false,
      queryBytes: trimmedBytes,
      error: `MemorySearch.query must be 1 to ${MAX_MEMORY_QUERY_BYTES} UTF-8 bytes after trimming.`,
    };
  }
  return { ok: true, query };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
