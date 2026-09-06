import path from "node:path";
import { stat } from "node:fs/promises";
import { glob, type Path } from "glob";
import { cancellationError, throwIfTurnCancelled } from "../agent/turn-cancellation";
import { resolveWorkspacePath, toDisplayPath } from "./path-safety";
import { defineToolExecutor } from "./types";
import type { GlobRawResult, ToolExecutionContext, ToolExecutor } from "./types";

type GlobArgs = {
  pattern: string;
  path?: string;
  head_limit: number;
  offset: number;
};

export type GlobToolOptions = {
  workspaceRoot: string;
};

const ignoredDirectories = ["node_modules", ".git"];
const defaultHeadLimit = 200;
const maxHeadLimit = 500;

export function createGlobToolExecutor(options: GlobToolOptions): ToolExecutor {
  return defineToolExecutor("glob", {
    definition: {
      name: "Glob",
      description:
        "Find regular files by glob pattern, including symbolic links to regular files. Directory links and broken links are excluded. node_modules and .git are skipped during traversal; to search inside either, set path directly to that directory.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pattern: {
            type: "string",
            description: 'Glob pattern such as "**/*.ts" or "src/**/*.tsx".',
          },
          path: {
            type: "string",
            description:
              "Optional workspace-relative or absolute search directory. Defaults to the workspace root.",
          },
          head_limit: {
            type: "integer",
            minimum: 1,
            maximum: maxHeadLimit,
            description:
              "Maximum paths to return. Defaults to 200; must be between 1 and 500.",
          },
          offset: {
            type: "integer",
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
            description:
              "Skip the first N sorted matches. Defaults to 0. To continue, pass nextOffset from the previous result with the same pattern and path.",
          },
        },
        required: ["pattern"],
      },
    },
    async execute(args, _call, context: ToolExecutionContext): Promise<GlobRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseGlobArgs(args);

      if (!parsed.ok) {
        return {
          ok: false,
          pattern:
            isRecord(args) && typeof args.pattern === "string"
              ? args.pattern
              : undefined,
          searchPath:
            isRecord(args) && args.path !== undefined
              ? typeof args.path === "string"
                ? args.path
                : "(invalid path)"
              : ".",
          ignored: ignoredDirectories,
          error: parsed.error,
        };
      }

      const input = parsed.value;
      let absoluteSearchPath: string;

      try {
        absoluteSearchPath = resolveWorkspacePath(
          options.workspaceRoot,
          input.path ?? ".",
        );
      } catch (error) {
        return {
          ok: false,
          pattern: input.pattern,
          searchPath: input.path ?? ".",
          ignored: ignoredDirectories,
          error: errorMessage(error),
        };
      }

      const searchPath = toDisplayPath(options.workspaceRoot, absoluteSearchPath);

      const directoryCheck = await ensureDirectory(absoluteSearchPath);
      throwIfTurnCancelled(context.signal);
      if (!directoryCheck.ok) {
        return {
          ok: false,
          pattern: input.pattern,
          searchPath,
          absoluteSearchPath,
          ignored: ignoredDirectories,
          error: directoryCheck.error,
        };
      }

      try {
        const matches = await glob(input.pattern, {
          cwd: absoluteSearchPath,
          nodir: true,
          dot: true,
          follow: false,
          withFileTypes: true,
          signal: context.signal,
          ignore: ["**/node_modules/**", "**/.git/**"],
        });
        const displayMatches = await toDisplayMatches({
          workspaceRoot: options.workspaceRoot,
          matches,
          signal: context.signal,
        });
        const page = displayMatches.slice(
          input.offset,
          input.offset + input.head_limit,
        );
        const hasMore = input.offset + page.length < displayMatches.length;

        return {
          ok: true,
          pattern: input.pattern,
          searchPath,
          absoluteSearchPath,
          matches: page,
          matchCount: page.length,
          totalMatches: displayMatches.length,
          returnedCount: page.length,
          appliedOffset: input.offset,
          hasMore,
          ...(hasMore ? { nextOffset: input.offset + page.length } : {}),
          ignored: ignoredDirectories,
        };
      } catch (error) {
        if (context.signal.aborted) {
          throw cancellationError(context.signal, error);
        }

        return {
          ok: false,
          pattern: input.pattern,
          searchPath,
          absoluteSearchPath,
          ignored: ignoredDirectories,
          error: errorMessage(error),
        };
      }
    },
  });
}

function parseGlobArgs(
  args: unknown,
): { ok: true; value: GlobArgs } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "Glob arguments must be an object." };
  }

  if (typeof args.pattern !== "string" || args.pattern.trim() === "") {
    return { ok: false, error: "Glob.pattern must be a non-empty string." };
  }

  if (path.isAbsolute(args.pattern)) {
    return { ok: false, error: "Glob.pattern must be relative to Glob.path." };
  }

  if (hasParentDirectorySegment(args.pattern)) {
    return { ok: false, error: "Glob.pattern must not contain '..' segments." };
  }

  if (args.path !== undefined && typeof args.path !== "string") {
    return { ok: false, error: "Glob.path must be a string." };
  }

  if (
    args.head_limit !== undefined &&
    (typeof args.head_limit !== "number" ||
      !Number.isSafeInteger(args.head_limit) ||
      args.head_limit < 1 ||
      args.head_limit > maxHeadLimit)
  ) {
    return {
      ok: false,
      error: "Glob.head_limit must be an integer between 1 and 500.",
    };
  }

  if (
    args.offset !== undefined &&
    (typeof args.offset !== "number" ||
      !Number.isSafeInteger(args.offset) ||
      args.offset < 0)
  ) {
    return { ok: false, error: "Glob.offset must be a non-negative safe integer." };
  }

  return {
    ok: true,
    value: {
      pattern: args.pattern,
      path: args.path,
      head_limit: args.head_limit ?? defaultHeadLimit,
      offset: args.offset ?? 0,
    },
  };
}

function hasParentDirectorySegment(pattern: string): boolean {
  return pattern.split(/[\\/]+/).some((segment) => segment === "..");
}

async function ensureDirectory(
  directoryPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const info = await stat(directoryPath);
    return info.isDirectory()
      ? { ok: true }
      : { ok: false, error: "Glob.path is not a directory." };
  } catch {
    return { ok: false, error: "Glob.path does not exist." };
  }
}

async function toDisplayMatches(input: {
  workspaceRoot: string;
  matches: Path[];
  signal: AbortSignal;
}): Promise<string[]> {
  const normalized: string[] = [];
  for (const match of input.matches) {
    throwIfTurnCancelled(input.signal);
    if (!(await isRegularFileMatch(match))) continue;
    const absolutePath = resolveWorkspacePath(input.workspaceRoot, match.fullpath());
    normalized.push(toDisplayPath(input.workspaceRoot, absolutePath));
  }
  throwIfTurnCancelled(input.signal);

  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

async function isRegularFileMatch(match: Path): Promise<boolean> {
  if (!match.isSymbolicLink()) return match.isFile();

  try {
    // Resolve only the type; keep the link's path in the returned matches.
    return (await stat(match.fullpath())).isFile();
  } catch (error) {
    if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
