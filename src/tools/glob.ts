import path from "node:path";
import { stat } from "node:fs/promises";
import { glob } from "glob";
import { resolveWorkspacePath, toWorkspaceRelativePath } from "./path-safety";
import type { GlobRawResult, ToolExecutor } from "./types";

type GlobArgs = {
  pattern: string;
  path?: string;
};

export type GlobToolOptions = {
  workspaceRoot: string;
};

const ignoredDirectories = ["node_modules", ".git"];

export function createGlobToolExecutor(options: GlobToolOptions): ToolExecutor {
  return {
    definition: {
      name: "Glob",
      description:
        "Find files in the local workspace by glob pattern. node_modules and .git are ignored.",
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
              "Optional workspace-relative search directory. Defaults to the workspace root.",
          },
        },
        required: ["pattern"],
      },
    },
    async execute(args): Promise<GlobRawResult> {
      const parsed = parseGlobArgs(args);

      if (!parsed.ok) {
        return {
          ok: false,
          pattern: "",
          searchPath: ".",
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

      const searchPath = toWorkspaceRelativePath(
        options.workspaceRoot,
        absoluteSearchPath,
      );

      const directoryCheck = await ensureDirectory(absoluteSearchPath);
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
          ignore: ["**/node_modules/**", "**/.git/**"],
        });
        const workspaceMatches = toWorkspaceMatches({
          workspaceRoot: options.workspaceRoot,
          absoluteSearchPath,
          matches,
        });

        return {
          ok: true,
          pattern: input.pattern,
          searchPath,
          absoluteSearchPath,
          matches: workspaceMatches,
          matchCount: workspaceMatches.length,
          ignored: ignoredDirectories,
        };
      } catch (error) {
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
  };
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

  return {
    ok: true,
    value: {
      pattern: args.pattern,
      path: args.path,
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

function toWorkspaceMatches(input: {
  workspaceRoot: string;
  absoluteSearchPath: string;
  matches: string[];
}): string[] {
  const normalized = input.matches.map((match) => {
    const absolutePath = resolveWorkspacePath(
      input.workspaceRoot,
      path.resolve(input.absoluteSearchPath, match),
    );
    return toWorkspaceRelativePath(input.workspaceRoot, absolutePath);
  });

  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
