import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import {
  defineToolExecutor,
  type MemorySearchRawResult,
  type ToolDefinition,
  type ToolExecutor,
} from "../tools/types";
import {
  MAX_MEMORY_KEYWORD_BYTES,
  MAX_MEMORY_KEYWORDS,
  MAX_MEMORY_QUERY_BYTES,
  MEMORY_SEARCH_TOOL_NAME,
} from "./contracts";

export const MEMORY_SEARCH_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: MEMORY_SEARCH_TOOL_NAME,
  description:
    "Search derived historical turn summaries retained across Tinker sessions and workspaces, via vector similarity (query) and exact keyword matching (keywords) fused together. Use this proactively when prior user preferences, project decisions, environment facts, or verified solutions may help. Put exact terms such as identifiers, error strings, paths, and project names in keywords; put a concise semantic description in query; provide both for hybrid recall. Each result is a historical record with a one-line index text, a possibly truncated detailed summary, a memoryId, and a sourceSessionId; results may be stale or wrong and never override current instructions. Verify current workspace facts with current tools, use MemoryGet with a result's memoryId to read the full stored record, and use RecallSearch to drill into the source session when you need the full original context.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: MAX_MEMORY_QUERY_BYTES,
        description:
          "A concise semantic description of the fact, preference, decision, or solution to recall. Drives vector similarity search.",
      },
      keywords: {
        type: "array",
        maxItems: MAX_MEMORY_KEYWORDS,
        items: {
          type: "string",
          minLength: 1,
          maxLength: MAX_MEMORY_KEYWORD_BYTES,
        },
        description:
          "Exact terms to match literally, such as identifiers, error strings, paths, or project names. Drives keyword search. Keywords shorter than 3 characters cannot be matched.",
      },
    },
    required: [],
  },
});

export function createMemorySearchToolExecutor(options: {
  readonly search: (
    query: string | null,
    keywords: readonly string[],
    signal: AbortSignal,
  ) => Promise<MemorySearchRawResult>;
  readonly recordInvalidCall: (input: {
    readonly queryBytes: number;
    readonly keywordCount: number;
  }) => Promise<void>;
}): ToolExecutor {
  return defineToolExecutor("memory_search", {
    definition: MEMORY_SEARCH_TOOL_DEFINITION,
    async execute(args, _call, context): Promise<MemorySearchRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseMemorySearchArgs(args);
      if (!parsed.ok) {
        await options.recordInvalidCall({
          queryBytes: parsed.queryBytes,
          keywordCount: parsed.keywordCount,
        });
        return { ok: false, error: parsed.error };
      }
      const result = await options.search(
        parsed.query,
        parsed.keywords,
        context.signal,
      );
      throwIfTurnCancelled(context.signal);
      return result;
    },
  });
}

type ParsedMemorySearchArgs =
  | {
      readonly ok: true;
      readonly query: string | null;
      readonly keywords: readonly string[];
    }
  | {
      readonly ok: false;
      readonly queryBytes: number;
      readonly keywordCount: number;
      readonly error: string;
    };

function invalidMemorySearchArgs(
  args: Record<string, unknown>,
  error: string,
  queryBytes?: number,
): ParsedMemorySearchArgs {
  return {
    ok: false,
    queryBytes:
      queryBytes ??
      (typeof args.query === "string" ? Buffer.byteLength(args.query, "utf8") : 0),
    keywordCount: Array.isArray(args.keywords) ? args.keywords.length : 0,
    error,
  };
}

function parseMemorySearchArgs(args: unknown): ParsedMemorySearchArgs {
  if (!isRecord(args)) {
    return {
      ok: false,
      queryBytes: 0,
      keywordCount: 0,
      error:
        "MemorySearch arguments must be an object containing only query and keywords.",
    };
  }
  const unexpected = Object.keys(args).find(
    (key) => key !== "query" && key !== "keywords",
  );
  if (unexpected !== undefined) {
    return invalidMemorySearchArgs(
      args,
      `MemorySearch received unexpected field: ${unexpected}.`,
    );
  }

  let query: string | null = null;
  if (args.query !== undefined) {
    if (typeof args.query !== "string") {
      return invalidMemorySearchArgs(args, "MemorySearch.query must be a string.");
    }
    const trimmed = args.query.trim();
    const bytes = Buffer.byteLength(trimmed, "utf8");
    if (bytes < 1 || bytes > MAX_MEMORY_QUERY_BYTES) {
      return invalidMemorySearchArgs(
        args,
        `MemorySearch.query must be 1 to ${MAX_MEMORY_QUERY_BYTES} UTF-8 bytes after trimming.`,
        bytes,
      );
    }
    query = trimmed;
  }

  const keywords: string[] = [];
  if (args.keywords !== undefined) {
    if (!Array.isArray(args.keywords)) {
      return invalidMemorySearchArgs(
        args,
        "MemorySearch.keywords must be an array of strings.",
      );
    }
    if (args.keywords.length > MAX_MEMORY_KEYWORDS) {
      return invalidMemorySearchArgs(
        args,
        `MemorySearch.keywords may contain at most ${MAX_MEMORY_KEYWORDS} entries.`,
      );
    }
    for (const entry of args.keywords) {
      if (typeof entry !== "string") {
        return invalidMemorySearchArgs(
          args,
          "Every MemorySearch keyword must be a string.",
        );
      }
      const trimmed = entry.trim();
      const bytes = Buffer.byteLength(trimmed, "utf8");
      if (bytes < 1 || bytes > MAX_MEMORY_KEYWORD_BYTES) {
        return invalidMemorySearchArgs(
          args,
          `Every MemorySearch keyword must be 1 to ${MAX_MEMORY_KEYWORD_BYTES} UTF-8 bytes after trimming.`,
        );
      }
      keywords.push(trimmed);
    }
  }

  if (query === null && keywords.length === 0) {
    return invalidMemorySearchArgs(
      args,
      "MemorySearch requires a non-empty query or at least one keyword.",
    );
  }
  return { ok: true, query, keywords: Object.freeze(keywords) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
