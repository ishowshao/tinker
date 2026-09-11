import { defineToolExecutor, type ToolExecutor } from "../tools/types";
import { boundedMemoryError } from "./contracts";
import { ensureMemoryDirectory } from "./memory-files";
import { searchMemoryFiles, type MemorySearchInput } from "./memory-search";

export function createMemorySearchToolExecutor(options: {
  homeRoot?: string;
}): ToolExecutor {
  return defineToolExecutor("memory_search", {
    definition: {
      name: "MemorySearch",
      description:
        "Search historical session records and saved notes across workspaces when earlier decisions, preferences, or work may help. Matches any keyword literally, ignoring case, within individual lines. Returns passages grouped by file with line numbers; > marks matching lines and … separates passages. Use Read with offset and limit to expand a passage. Continue using nextOffset with the same keywords and context.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          keywords: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
            description:
              "Literal keywords; any one can match. No regular expressions or multiline keywords. A line matching multiple keywords counts once.",
          },
          context: {
            type: "integer",
            minimum: 0,
            description:
              "Lines before and after each matching line. Defaults to 3. Overlapping passages are merged.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            description:
              "Maximum selected matching lines, excluding context. Defaults to 20.",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description:
              "Matching lines to skip. Defaults to 0. Use nextOffset to continue; file changes between searches can affect pagination.",
          },
        },
        required: ["keywords"],
      },
    },
    async execute(args, _call, context) {
      context.signal.throwIfAborted();
      try {
        const input = parseArgs(args);
        const directory = await ensureMemoryDirectory(options.homeRoot);
        return await searchMemoryFiles(directory, input, context.signal);
      } catch (error) {
        context.signal.throwIfAborted();
        return { ok: false, error: boundedMemoryError(error) };
      }
    },
  });
}

function parseArgs(args: unknown): MemorySearchInput {
  if (args === null || typeof args !== "object" || Array.isArray(args))
    throw new Error(
      "MemorySearch requires keywords, with optional context, limit and offset.",
    );
  const value = args as Record<string, unknown>;
  for (const name of Object.keys(value)) {
    if (!["keywords", "context", "limit", "offset"].includes(name))
      throw new Error(`MemorySearch received unexpected field: ${name}.`);
  }
  if (!Array.isArray(value.keywords) || value.keywords.length === 0)
    throw new Error("MemorySearch.keywords must be a non-empty array of strings.");
  const keywords = value.keywords.map((word: unknown) => {
    if (typeof word !== "string" || word.trim() === "" || /[\r\n]/.test(word))
      throw new Error("MemorySearch keywords must be non-empty single-line strings.");
    return word.trim();
  });
  const integers = { context: 3, limit: 20, offset: 0 };
  for (const name of ["context", "limit", "offset"] as const) {
    const number = value[name];
    if (number === undefined) continue;
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < (name === "limit" ? 1 : 0)
    )
      throw new Error(
        `MemorySearch.${name} must be a safe integer >= ${name === "limit" ? 1 : 0}.`,
      );
    integers[name] = number;
  }
  return { keywords, ...integers };
}
