import path from "node:path";
import { stat } from "node:fs/promises";
import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import { isWorkspaceLocalCwd, type CwdState } from "./cwd-state";
import { resolveWorkspacePath, toDisplayPath } from "./path-safety";
import { ripGrep } from "./ripgrep";
import { defineToolExecutor } from "./types";
import type {
  GrepOutputMode,
  GrepRawResult,
  ToolExecutionContext,
  ToolExecutor,
} from "./types";

type GrepArgs = {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: GrepOutputMode;
  before?: number;
  after?: number;
  contextAlias?: number;
  context?: number;
  lineNumbers?: boolean;
  caseInsensitive?: boolean;
  type?: string;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
};

export type GrepToolOptions = {
  workspaceRoot: string;
  cwdState: CwdState;
  ripgrep?: {
    command?: string;
    timeoutMs?: number;
    maxBufferBytes?: number;
  };
};

const ignoredDirectories = [
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  ".jj",
  ".sl",
  "node_modules",
  ".tinker",
];

const defaultHeadLimit = 250;

export function createGrepToolExecutor(options: GrepToolOptions): ToolExecutor {
  return defineToolExecutor("grep", {
    definition: {
      name: "Grep",
      description: "Search file contents with ripgrep.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pattern: {
            type: "string",
            description:
              "The regular expression pattern to search for in file contents.",
          },
          path: {
            type: "string",
            description:
              "Optional workspace-relative or absolute file or directory to search in. Defaults to the current workspace-local cwd.",
          },
          glob: {
            type: "string",
            description: 'Glob pattern to filter files, such as "*.js" or "**/*.tsx".',
          },
          output_mode: {
            type: "string",
            enum: ["content", "files_with_matches", "count"],
            description: 'Output mode. Defaults to "files_with_matches".',
          },
          "-B": {
            type: "integer",
            minimum: 0,
            description:
              'Number of lines to show before each match. Only applies to output_mode="content".',
          },
          "-A": {
            type: "integer",
            minimum: 0,
            description:
              'Number of lines to show after each match. Only applies to output_mode="content".',
          },
          "-C": {
            type: "integer",
            minimum: 0,
            description: "Alias for context.",
          },
          context: {
            type: "integer",
            minimum: 0,
            description:
              'Number of lines to show before and after each match. Only applies to output_mode="content".',
          },
          "-n": {
            type: "boolean",
            description: "Show line numbers in content output. Defaults to true.",
          },
          "-i": {
            type: "boolean",
            description: "Case insensitive search.",
          },
          type: {
            type: "string",
            description: "File type to search, such as js, ts, py, rust, go, or java.",
          },
          head_limit: {
            type: "integer",
            minimum: 0,
            description:
              "Limit output to first N lines or entries. Defaults to 250. Pass 0 for unlimited.",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description:
              "Skip first N lines or entries before applying head_limit. Defaults to 0.",
          },
          multiline: {
            type: "boolean",
            description:
              "Enable multiline mode where dot matches newlines. Defaults to false.",
          },
        },
        required: ["pattern"],
      },
    },
    async execute(args, _call, context: ToolExecutionContext): Promise<GrepRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseGrepArgs(args);

      if (!parsed.ok) {
        return grepFailure({
          pattern: parsed.pattern ?? "",
          searchPath: ".",
          mode: parsed.mode ?? "files_with_matches",
          error: parsed.error,
        });
      }

      const input = parsed.value;
      const mode = input.output_mode ?? "files_with_matches";

      let absoluteSearchPath: string;
      try {
        absoluteSearchPath = resolveSearchPath(options, input.path);
      } catch (error) {
        return grepFailure({
          pattern: input.pattern,
          searchPath: input.path ?? ".",
          mode,
          error: errorMessage(error),
        });
      }

      const searchPath = toDisplayPath(options.workspaceRoot, absoluteSearchPath);

      const pathCheck = await ensureFileOrDirectory(absoluteSearchPath);
      throwIfTurnCancelled(context.signal);
      if (!pathCheck.ok) {
        return grepFailure({
          pattern: input.pattern,
          searchPath,
          absoluteSearchPath,
          mode,
          error: pathCheck.error,
        });
      }

      const rgArgs = buildRipgrepArgs(input, mode, absoluteSearchPath);
      const rg = await ripGrep(rgArgs, {
        signal: context.signal,
        ...options.ripgrep,
      });

      if (!rg.ok) {
        return grepFailure({
          pattern: input.pattern,
          searchPath,
          absoluteSearchPath,
          mode,
          truncated: rg.truncated ? true : undefined,
          error: rg.error ?? "ripgrep failed.",
        });
      }

      const base = {
        ok: true as const,
        pattern: input.pattern,
        searchPath,
        absoluteSearchPath,
        mode,
        ignored: ignoredDirectories,
      };
      const partialWarning = rg.truncated ? rg.error : undefined;

      if (mode === "files_with_matches") {
        const sorted = await sortFilesForOutput([...new Set(rg.lines)]);
        const page = applyHeadLimit(sorted, input.head_limit, input.offset ?? 0);
        const filenames = page.items.map((file) =>
          toDisplayPath(options.workspaceRoot, file),
        );

        return {
          ...base,
          filenames,
          numFiles: filenames.length,
          appliedLimit: page.appliedLimit,
          appliedOffset: appliedOffset(input.offset),
          truncated: rg.truncated || page.appliedLimit !== undefined || undefined,
          error: partialWarning,
        };
      }

      if (mode === "count") {
        const sorted = [...rg.lines].sort((left, right) => left.localeCompare(right));
        const page = applyHeadLimit(sorted, input.head_limit, input.offset ?? 0);
        const entries = page.items.map((line) =>
          parseCountLine(line, options.workspaceRoot),
        );
        const filenames = entries.map((entry) => entry.filePath);

        return {
          ...base,
          filenames,
          numFiles: filenames.length,
          content: entries
            .map((entry) => `${entry.filePath}:${entry.count}`)
            .join("\n"),
          numMatches: entries.reduce((total, entry) => total + entry.count, 0),
          appliedLimit: page.appliedLimit,
          appliedOffset: appliedOffset(input.offset),
          truncated: rg.truncated || page.appliedLimit !== undefined || undefined,
          error: partialWarning,
        };
      }

      const page = applyHeadLimit(rg.lines, input.head_limit, input.offset ?? 0);
      const contentLines = page.items.map((line) =>
        relativizeContentLine(line, options.workspaceRoot),
      );
      const filenames = extractContentFilenames(contentLines);

      return {
        ...base,
        filenames,
        numFiles: filenames.length,
        content: contentLines.join("\n"),
        numLines: contentLines.length,
        appliedLimit: page.appliedLimit,
        appliedOffset: appliedOffset(input.offset),
        truncated: rg.truncated || page.appliedLimit !== undefined || undefined,
        error: partialWarning,
      };
    },
  });
}

export function buildRipgrepArgs(
  input: GrepArgs,
  mode: GrepOutputMode,
  absoluteSearchPath: string,
): string[] {
  const args = ["--hidden", "--max-columns", "500"];

  for (const directory of ignoredDirectories) {
    args.push("--glob", `!${directory}`);
  }

  if (mode === "files_with_matches") {
    args.push("-l");
  } else if (mode === "count") {
    args.push("-c", "--with-filename");
  } else {
    args.push("--with-filename");
    if (input.lineNumbers !== false) {
      args.push("-n");
    }

    if (input.context !== undefined) {
      args.push("-C", String(input.context));
    } else if (input.contextAlias !== undefined) {
      args.push("-C", String(input.contextAlias));
    } else {
      if (input.before !== undefined) {
        args.push("-B", String(input.before));
      }
      if (input.after !== undefined) {
        args.push("-A", String(input.after));
      }
    }
  }

  if (input.multiline === true) {
    args.push("-U", "--multiline-dotall");
  }

  if (input.caseInsensitive === true) {
    args.push("-i");
  }

  if (input.type !== undefined) {
    args.push("--type", input.type);
  }

  if (input.glob !== undefined) {
    args.push("--glob", input.glob);
  }

  args.push("-e", input.pattern, absoluteSearchPath);
  return args;
}

export function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset = 0,
): { items: T[]; appliedLimit?: number } {
  if (limit === 0) {
    return { items: items.slice(offset) };
  }

  const effectiveLimit = limit ?? defaultHeadLimit;
  const itemsPage = items.slice(offset, offset + effectiveLimit);
  const wasTruncated = items.length - offset > effectiveLimit;

  return {
    items: itemsPage,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  };
}

type ParsedGrepArgs =
  | { ok: true; value: GrepArgs }
  | { ok: false; error: string; pattern?: string; mode?: GrepOutputMode };

function parseGrepArgs(args: unknown): ParsedGrepArgs {
  if (!isRecord(args)) {
    return { ok: false, error: "Grep arguments must be an object." };
  }

  const pattern = typeof args.pattern === "string" ? args.pattern : undefined;

  if (pattern === undefined || pattern === "") {
    return { ok: false, error: "Grep.pattern must be a non-empty string." };
  }

  if (args.path !== undefined && typeof args.path !== "string") {
    return { ok: false, pattern, error: "Grep.path must be a string." };
  }

  if (args.glob !== undefined && typeof args.glob !== "string") {
    return { ok: false, pattern, error: "Grep.glob must be a string." };
  }

  if (
    args.output_mode !== undefined &&
    args.output_mode !== "content" &&
    args.output_mode !== "files_with_matches" &&
    args.output_mode !== "count"
  ) {
    return {
      ok: false,
      pattern,
      error:
        'Grep.output_mode must be one of "content", "files_with_matches", or "count".',
    };
  }

  const mode = args.output_mode;

  for (const name of ["-B", "-A", "-C", "context", "head_limit", "offset"]) {
    const value = args[name];
    if (value !== undefined && !isNonNegativeInteger(value)) {
      return {
        ok: false,
        pattern,
        mode,
        error: `Grep.${name} must be a non-negative integer.`,
      };
    }
  }

  for (const name of ["-n", "-i", "multiline"]) {
    const value = args[name];
    if (value !== undefined && typeof value !== "boolean") {
      return {
        ok: false,
        pattern,
        mode,
        error: `Grep.${name} must be a boolean.`,
      };
    }
  }

  if (args.type !== undefined && (typeof args.type !== "string" || args.type === "")) {
    return {
      ok: false,
      pattern,
      mode,
      error: "Grep.type must be a non-empty string.",
    };
  }

  return {
    ok: true,
    value: {
      pattern,
      path: args.path,
      glob: args.glob,
      output_mode: mode,
      before: args["-B"] as number | undefined,
      after: args["-A"] as number | undefined,
      contextAlias: args["-C"] as number | undefined,
      context: args.context as number | undefined,
      lineNumbers: args["-n"] as boolean | undefined,
      caseInsensitive: args["-i"] as boolean | undefined,
      type: args.type,
      head_limit: args.head_limit as number | undefined,
      offset: args.offset as number | undefined,
      multiline: args.multiline as boolean | undefined,
    },
  };
}

function resolveSearchPath(options: GrepToolOptions, inputPath?: string): string {
  if (inputPath !== undefined) {
    return resolveWorkspacePath(options.workspaceRoot, inputPath);
  }

  const cwd = options.cwdState.cwd;
  if (!isWorkspaceLocalCwd(options.workspaceRoot, cwd)) {
    throw new Error("Current cwd is outside the workspace. Pass an explicit path.");
  }

  return path.resolve(cwd);
}

async function ensureFileOrDirectory(
  targetPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const info = await stat(targetPath);
    return info.isFile() || info.isDirectory()
      ? { ok: true }
      : { ok: false, error: "Grep.path must be a file or directory." };
  } catch {
    return { ok: false, error: "Grep.path does not exist." };
  }
}

async function sortFilesForOutput(files: string[]): Promise<string[]> {
  if (process.env.NODE_ENV === "test") {
    return [...files].sort((left, right) => left.localeCompare(right));
  }

  const withMtime = await Promise.all(
    files.map(async (file) => {
      try {
        const info = await stat(file);
        return { file, mtimeMs: info.mtimeMs };
      } catch {
        return { file, mtimeMs: 0 };
      }
    }),
  );

  return withMtime
    .sort((left, right) =>
      right.mtimeMs !== left.mtimeMs
        ? right.mtimeMs - left.mtimeMs
        : left.file.localeCompare(right.file),
    )
    .map((entry) => entry.file);
}

function parseCountLine(
  line: string,
  workspaceRoot: string,
): { filePath: string; count: number } {
  const separator = line.lastIndexOf(":");
  const absolutePath = separator === -1 ? line : line.slice(0, separator);
  const count = separator === -1 ? 0 : Number(line.slice(separator + 1));

  return {
    filePath: toDisplayPath(workspaceRoot, absolutePath),
    count: Number.isFinite(count) ? count : 0,
  };
}

function relativizeContentLine(line: string, workspaceRoot: string): string {
  const prefix = path.resolve(workspaceRoot) + path.sep;
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

function extractContentFilenames(lines: string[]): string[] {
  const filenames = new Set<string>();

  for (const line of lines) {
    const match = /^(.+?):\d+[:-]/.exec(line);
    if (match?.[1] !== undefined) {
      filenames.add(match[1]);
    }
  }

  return [...filenames];
}

function appliedOffset(offset: number | undefined): number | undefined {
  return offset !== undefined && offset > 0 ? offset : undefined;
}

function grepFailure(input: {
  pattern: string;
  searchPath: string;
  absoluteSearchPath?: string;
  mode: GrepOutputMode;
  truncated?: boolean;
  error: string;
}): GrepRawResult {
  return {
    ok: false,
    pattern: input.pattern,
    searchPath: input.searchPath,
    absoluteSearchPath: input.absoluteSearchPath,
    mode: input.mode,
    filenames: [],
    numFiles: 0,
    ignored: ignoredDirectories,
    truncated: input.truncated,
    error: input.error,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
