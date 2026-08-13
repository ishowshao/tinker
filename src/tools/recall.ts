import { Buffer } from "node:buffer";
import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import {
  MessageSourceParseError,
  parseMessageSource,
  type MessageSource,
} from "../context/context-source";
import { SessionError } from "../session/session-errors";
import {
  RecallHistoryError,
  type RecallRole,
  type RecallSearchFilters,
  type SessionHistoryReader,
} from "../session/session-history-reader";
import {
  defineToolExecutor,
  ToolExecutionFatalError,
  type RecallRawResult,
  type RecallToolErrorCode,
  type ToolExecutionContext,
  type ToolDefinition,
  type ToolExecutor,
} from "./types";

export const RECALL_SEARCH_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: "RecallSearch",
  description:
    "Search immutable model-visible history from the current session. Matches literal substrings: use a short distinctive anchor such as a path, symbol, project, command fragment, or error text, not a whole natural-language question. Results are historical snapshots and may differ from the current workspace. Use RecallGet with a returned source to retrieve exact content, and Read/Grep for current files.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", maxLength: 1024 },
      roles: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "string", enum: ["user", "assistant", "tool"] },
      },
      tool_names: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
      turn_from: { type: "integer", minimum: 1 },
      turn_to: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      offset: { type: "integer", minimum: 0, default: 0 },
      snapshot_through_ordinal: { type: "integer", minimum: 1 },
    },
    required: ["query"],
  },
});

export const RECALL_GET_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: "RecallGet",
  description:
    "Retrieve exact immutable model-visible historical content from the current session using a ctx://message/<UUID> source returned by RecallSearch. Results are historical snapshots and may differ from the current workspace; use Read/Grep for current files.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      source: { type: "string" },
      byte_offset: { type: "integer", minimum: 0, default: 0 },
      byte_limit: {
        type: "integer",
        minimum: 256,
        maximum: 20_000,
        default: 12_000,
      },
    },
    required: ["source"],
  },
});

export const RECALL_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  RECALL_SEARCH_TOOL_DEFINITION,
  RECALL_GET_TOOL_DEFINITION,
]);

type RecallSearchArgs = {
  mode: "search";
  query: string;
  roles?: RecallRole[];
  toolNames?: string[];
  turnFrom?: number;
  turnTo?: number;
  limit: number;
  offset: number;
  snapshotThroughOrdinal?: number;
};

type RecallGetArgs = {
  mode: "get";
  source: MessageSource;
  byteOffset: number;
  byteLimit: number;
};

type ParsedRecallArgs = RecallSearchArgs | RecallGetArgs;

type ParseResult =
  | { ok: true; value: ParsedRecallArgs }
  | {
      ok: false;
      mode: "search" | "get";
      errorCode: "RECALL_ARGS_INVALID" | "RECALL_SOURCE_INVALID";
      error: string;
    };

export function createRecallSearchToolExecutor(options: {
  historyReader: SessionHistoryReader;
}): ToolExecutor {
  return createRecallToolExecutor("search", options);
}

export function createRecallGetToolExecutor(options: {
  historyReader: SessionHistoryReader;
}): ToolExecutor {
  return createRecallToolExecutor("get", options);
}

function createRecallToolExecutor(
  mode: "search" | "get",
  options: { historyReader: SessionHistoryReader },
): ToolExecutor {
  return defineToolExecutor("recall", {
    definition:
      mode === "search" ? RECALL_SEARCH_TOOL_DEFINITION : RECALL_GET_TOOL_DEFINITION,
    async execute(
      args,
      _call,
      context: ToolExecutionContext,
    ): Promise<RecallRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = mode === "search" ? parseSearchArgs(args) : parseGetArgs(args);
      if (!parsed.ok) {
        return recallFailure(parsed.mode, parsed.errorCode, parsed.error);
      }

      try {
        if (parsed.value.mode === "get") {
          const page = options.historyReader.get({
            source: parsed.value.source,
            byteOffset: parsed.value.byteOffset,
            byteLimit: parsed.value.byteLimit,
          });
          throwIfTurnCancelled(context.signal);
          return { ok: true, mode: "get", historical: true, page };
        }

        const input = parsed.value;
        const page = options.historyReader.search({
          query: input.query,
          ...(input.roles === undefined ? {} : { roles: input.roles }),
          ...(input.toolNames === undefined ? {} : { toolNames: input.toolNames }),
          ...(input.turnFrom === undefined ? {} : { turnFrom: input.turnFrom }),
          ...(input.turnTo === undefined ? {} : { turnTo: input.turnTo }),
          limit: input.limit,
          offset: input.offset,
          ...(input.snapshotThroughOrdinal === undefined
            ? {}
            : { snapshotThroughOrdinal: input.snapshotThroughOrdinal }),
        });
        throwIfTurnCancelled(context.signal);
        const filters: RecallSearchFilters = Object.freeze({
          ...(input.roles === undefined
            ? {}
            : { roles: Object.freeze([...input.roles]) }),
          ...(input.toolNames === undefined
            ? {}
            : { toolNames: Object.freeze([...input.toolNames]) }),
          ...(input.turnFrom === undefined ? {} : { turnFrom: input.turnFrom }),
          ...(input.turnTo === undefined ? {} : { turnTo: input.turnTo }),
        });
        return {
          ok: true,
          mode: "search",
          historical: true,
          query: input.query,
          filters,
          page,
        };
      } catch (error) {
        if (error instanceof RecallHistoryError) {
          return recallFailure(parsed.value.mode, error.code, error.message);
        }
        if (error instanceof SessionError) {
          throw new ToolExecutionFatalError("Recall required history storage failed.", {
            cause: error,
          });
        }
        throw error;
      }
    },
  });
}

function parseSearchArgs(args: unknown): ParseResult {
  if (!isRecord(args)) {
    return argsFailure("search", "RecallSearch arguments must be an object.");
  }
  const allowed = new Set([
    "query",
    "roles",
    "tool_names",
    "turn_from",
    "turn_to",
    "limit",
    "offset",
    "snapshot_through_ordinal",
  ]);
  const unexpected = Object.keys(args).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    return argsFailure(
      "search",
      `RecallSearch received unexpected field: ${unexpected}.`,
    );
  }
  if (
    typeof args.query !== "string" ||
    args.query.trim() === "" ||
    Buffer.byteLength(args.query, "utf8") > 1024
  ) {
    return argsFailure(
      "search",
      "RecallSearch query must be non-empty and at most 1024 UTF-8 bytes.",
    );
  }

  const roles = parseRoles(args.roles);
  if (!roles.ok) {
    return argsFailure("search", roles.error);
  }
  const toolNames = parseToolNames(args.tool_names);
  if (!toolNames.ok) {
    return argsFailure("search", toolNames.error);
  }
  if (
    toolNames.value !== undefined &&
    roles.value !== undefined &&
    (roles.value.length !== 1 || roles.value[0] !== "tool")
  ) {
    return argsFailure(
      "search",
      "RecallSearch.tool_names requires roles to be omitted or contain only tool.",
    );
  }

  const turnFrom = optionalInteger(args.turn_from, "RecallSearch.turn_from", 1);
  if (!turnFrom.ok) {
    return argsFailure("search", turnFrom.error);
  }
  const turnTo = optionalInteger(args.turn_to, "RecallSearch.turn_to", 1);
  if (!turnTo.ok) {
    return argsFailure("search", turnTo.error);
  }
  if (
    turnFrom.value !== undefined &&
    turnTo.value !== undefined &&
    turnFrom.value > turnTo.value
  ) {
    return argsFailure("search", "RecallSearch.turn_from must not exceed turn_to.");
  }
  const limit = optionalInteger(args.limit, "RecallSearch.limit", 1, 20);
  if (!limit.ok) {
    return argsFailure("search", limit.error);
  }
  const offset = optionalInteger(args.offset, "RecallSearch.offset", 0);
  if (!offset.ok) {
    return argsFailure("search", offset.error);
  }
  const snapshot = optionalInteger(
    args.snapshot_through_ordinal,
    "RecallSearch.snapshot_through_ordinal",
    1,
  );
  if (!snapshot.ok) {
    return argsFailure("search", snapshot.error);
  }

  return {
    ok: true,
    value: {
      mode: "search",
      query: args.query,
      ...(roles.value === undefined ? {} : { roles: roles.value }),
      ...(toolNames.value === undefined ? {} : { toolNames: toolNames.value }),
      ...(turnFrom.value === undefined ? {} : { turnFrom: turnFrom.value }),
      ...(turnTo.value === undefined ? {} : { turnTo: turnTo.value }),
      limit: limit.value ?? 10,
      offset: offset.value ?? 0,
      ...(snapshot.value === undefined
        ? {}
        : { snapshotThroughOrdinal: snapshot.value }),
    },
  };
}

function parseGetArgs(args: unknown): ParseResult {
  if (!isRecord(args)) {
    return argsFailure("get", "RecallGet arguments must be an object.");
  }
  const allowed = new Set(["source", "byte_offset", "byte_limit"]);
  const unexpected = Object.keys(args).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    return argsFailure("get", `RecallGet received unexpected field: ${unexpected}.`);
  }
  if (typeof args.source !== "string") {
    return sourceFailure("RecallGet.source must be a string.");
  }
  let source: MessageSource;
  try {
    parseMessageSource(args.source);
    source = args.source as MessageSource;
  } catch (error) {
    if (error instanceof MessageSourceParseError) {
      return sourceFailure(error.message);
    }
    throw error;
  }
  const byteOffset = optionalInteger(args.byte_offset, "RecallGet.byte_offset", 0);
  if (!byteOffset.ok) {
    return argsFailure("get", byteOffset.error);
  }
  const byteLimit = optionalInteger(
    args.byte_limit,
    "RecallGet.byte_limit",
    256,
    20_000,
  );
  if (!byteLimit.ok) {
    return argsFailure("get", byteLimit.error);
  }
  return {
    ok: true,
    value: {
      mode: "get",
      source,
      byteOffset: byteOffset.value ?? 0,
      byteLimit: byteLimit.value ?? 12_000,
    },
  };
}

function parseRoles(
  value: unknown,
): { ok: true; value?: RecallRole[] } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) => entry !== "user" && entry !== "assistant" && entry !== "tool",
    ) ||
    new Set(value).size !== value.length
  ) {
    return {
      ok: false,
      error:
        "RecallSearch.roles must be a non-empty, unique list of user, assistant, or tool.",
    };
  }
  return { ok: true, value: value as RecallRole[] };
}

function parseToolNames(
  value: unknown,
): { ok: true; value?: string[] } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16 ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "") ||
    new Set(value).size !== value.length
  ) {
    return {
      ok: false,
      error:
        "RecallSearch.tool_names must contain 1 to 16 unique, non-empty tool names.",
    };
  }
  return { ok: true, value: value as string[] };
}

function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return {
      ok: false,
      error: `${name} must be a safe integer from ${minimum} to ${maximum}.`,
    };
  }
  return { ok: true, value };
}

function recallFailure(
  mode: "search" | "get",
  errorCode: RecallToolErrorCode,
  error: string,
): RecallRawResult {
  return { ok: false, mode, errorCode, error };
}

function argsFailure(mode: "search" | "get", error: string): ParseResult {
  return { ok: false, mode, errorCode: "RECALL_ARGS_INVALID", error };
}

function sourceFailure(error: string): ParseResult {
  return { ok: false, mode: "get", errorCode: "RECALL_SOURCE_INVALID", error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
