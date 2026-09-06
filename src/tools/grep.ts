import path from "node:path";
import { stat } from "node:fs/promises";
import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import { isWorkspaceLocalCwd, type CwdState } from "./cwd-state";
import { resolveWorkspacePath, toDisplayPath } from "./path-safety";
import { ripGrep } from "./ripgrep";
import { parseGrepOutput } from "./grep-output";
import { applyContentHeadLimit, applyHeadLimit } from "./grep-pagination";
import { formatGrepPath } from "./grep-path";
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

const defaultExcludedDirectories = [
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  ".jj",
  ".sl",
  "node_modules",
  ".tinker",
];

export function createGrepToolExecutor(options: GrepToolOptions): ToolExecutor {
  return defineToolExecutor("grep", {
    definition: {
      name: "Grep",
      description:
        "Search file contents with ripgrep. Directory searches include hidden files, respect ignore rules (including .gitignore and .ignore), and exclude .git, .svn, .hg, .bzr, .jj, .sl, node_modules, and .tinker by default. Directory traversal does not follow symlinks; binary detection can stop searching a file. No matches means no matches within the effective search scope. Results use a consistent file-path order. Pagination is not a snapshot: file changes between calls may cause skipped or repeated results. Quoted paths use JSON escaping; pass the decoded path to file tools.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pattern: {
            type: "string",
            minLength: 1,
            description:
              "The regular expression pattern to search for in file contents.",
          },
          path: {
            type: "string",
            description:
              "Optional workspace-relative or absolute file or directory to search in. Defaults to the current workspace-local cwd. For directories, ripgrep runs in that directory with . as its search path; explicitly selecting an excluded directory allows searching inside it. Files are passed as absolute paths: explicit files bypass ignore/glob/type filtering, and explicit symlink files are followed. Explicit binary files may yield matches but are not guaranteed to be searched completely, and reported line numbers may be inaccurate.",
          },
          glob: {
            type: "string",
            description:
              "Passed unchanged to ripgrep's --glob option after default exclusions. A glob that matches files inside an excluded directory does not necessarily allow traversal into that directory: **/node_modules/** can return no matches because node_modules itself is still excluded. To search an excluded directory, set path to that directory (for example, node_modules/pkg), then use glob to filter files within it. Broad globs such as **/* can also match excluded directory entries and allow traversal. Does not enable symlink traversal or disable binary detection.",
          },
          output_mode: {
            type: "string",
            enum: ["content", "files_with_matches", "count", "count-matches"],
            description:
              'Defaults to "files_with_matches" (matching file paths). "content" returns matching lines. Lines longer than 500 Unicode code points are excerpted: match windows include up to 100 code points on each side, with at most 500 source code points retained per line; later matches or long matches may be omitted. Long context lines retain their first 500 code points. Omission markers report skipped code points; use Read for full lines. "count" returns matching lines per file, counting a line once even with multiple matches; cannot be combined with multiline=true. "count-matches" returns non-overlapping matches per file, including multiple matches on one line. Count summaries cover only the displayed files when paginated.',
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
            description: "Passed unchanged to ripgrep's --type option.",
          },
          head_limit: {
            type: "integer",
            minimum: 0,
            description:
              "Limit selected results. In content mode, counts matching lines (one per line even with multiple matches), or complete ripgrep match events with multiline=true. Each selected result includes its requested context when the search completes; context does not consume the limit. Nearby matches shown within that context are not consumed or expanded and may reappear on later pages. Overlapping context is deduplicated within a page. Other modes count file entries. Defaults to 250. Pass 0 for unlimited.",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description:
              "Skip N results in the same units as head_limit, excluding context. Defaults to 0. To continue, pass nextOffset with the same search parameters. Pages may repeat context lines.",
          },
          multiline: {
            type: "boolean",
            description:
              'Enable multiline mode where dot matches newlines. Defaults to false. For counting, use output_mode="count-matches"; "count" rejects multiline=true.',
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

      const searchCwd = pathCheck.isDirectory ? absoluteSearchPath : undefined;
      const rgArgs = buildRipgrepArgs(
        input,
        mode,
        pathCheck.isDirectory ? "." : absoluteSearchPath,
      );
      const rg = await ripGrep(rgArgs, {
        signal: context.signal,
        ...options.ripgrep,
        cwd: searchCwd,
      });

      if (!rg.ok) {
        return grepFailure({
          pattern: input.pattern,
          searchPath,
          absoluteSearchPath,
          mode,
          truncated: rg.truncated ? true : undefined,
          error: omitUnsupportedRegexHint(rg.error ?? "ripgrep failed."),
        });
      }

      const base = {
        ok: true as const,
        pattern: input.pattern,
        searchPath,
        absoluteSearchPath,
        mode,
      };
      const partialWarning = rg.truncated ? rg.error : undefined;

      let records;
      try {
        records = parseGrepOutput(
          rg.stdout,
          mode,
          options.workspaceRoot,
          rg.truncated,
          searchCwd,
        );
      } catch (error) {
        return grepFailure({
          pattern: input.pattern,
          searchPath,
          absoluteSearchPath,
          mode,
          error: `Invalid ripgrep output: ${errorMessage(error)}`,
        });
      }
      if (rg.truncated && records.length === 0) {
        return grepFailure({
          pattern: input.pattern,
          searchPath,
          absoluteSearchPath,
          mode,
          truncated: true,
          error:
            partialWarning ??
            "Incomplete ripgrep output contained no complete records.",
        });
      }

      const requestedContext = resolveGrepContext(input);
      const page =
        mode === "content"
          ? applyContentHeadLimit(
              records,
              input.head_limit,
              input.offset ?? 0,
              requestedContext,
            )
          : applyHeadLimit(records, input.head_limit, input.offset ?? 0);
      const filenames = [...new Set(page.items.map((record) => record.filePath))];
      const pagination = {
        totalResults: page.totalResults,
        returnedResults: page.returnedResults,
        paginationUnit:
          mode === "content"
            ? input.multiline === true
              ? ("match_events" as const)
              : ("matching_lines" as const)
            : ("files" as const),
        hasMore: page.hasMore,
        nextOffset: page.nextOffset,
        appliedLimit: page.appliedLimit,
        appliedOffset: appliedOffset(input.offset),
        searchIncomplete: rg.truncated,
        contextMayBeIncomplete:
          mode === "content" &&
          rg.truncated &&
          (requestedContext.before > 0 || requestedContext.after > 0),
        truncated: rg.truncated || page.appliedLimit !== undefined || undefined,
        error: partialWarning,
      };
      if (mode === "files_with_matches") {
        return { ...base, ...pagination, filenames, numFiles: filenames.length };
      }
      if (mode === "count" || mode === "count-matches") {
        const counts = page.items.flatMap((record) =>
          record.kind === "count"
            ? [{ filePath: record.filePath, count: record.count }]
            : [],
        );
        return {
          ...base,
          ...pagination,
          filenames,
          numFiles: filenames.length,
          counts,
          content: counts
            .map((entry) => `${formatGrepPath(entry.filePath)}:${entry.count}`)
            .join("\n"),
          numMatches: counts.reduce((sum, entry) => sum + entry.count, 0),
        };
      }
      const contentLines = page.items.flatMap((record) => {
        if (record.kind !== "match" && record.kind !== "context") return [];
        const separator = record.kind === "match" ? ":" : "-";
        return record.lines.map((text, index) => {
          const position =
            input.lineNumbers === false
              ? ""
              : `${record.lineNumber + index}${separator}`;
          return `${formatGrepPath(record.filePath)}${separator}${position}${text}`;
        });
      });
      return {
        ...base,
        ...pagination,
        filenames,
        numFiles: filenames.length,
        content: contentLines.join("\n"),
        numLines: contentLines.length,
      };
    },
  });
}

export function buildRipgrepArgs(
  input: GrepArgs,
  mode: GrepOutputMode,
  searchPathArgument: string,
): string[] {
  // Sorting in rg fixes cross-file order before any pagination, including partial output.
  const args = ["--no-config", "--hidden", "--sort", "path", "--color", "never"];

  for (const directory of defaultExcludedDirectories) {
    args.push("--glob", `!${directory}`);
  }

  if (mode === "files_with_matches") {
    args.push("-l", "--null");
  } else if (mode === "count" || mode === "count-matches") {
    args.push(mode === "count" ? "-c" : "--count-matches", "--with-filename", "--null");
  } else {
    args.push("--json");

    const context = resolveGrepContext(input);
    args.push("-B", String(context.before), "-A", String(context.after));
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

  args.push("-e", input.pattern, searchPathArgument);
  return args;
}

function resolveGrepContext(input: GrepArgs) {
  const both = input.context ?? input.contextAlias;
  return {
    before: input.before ?? both ?? 0,
    after: input.after ?? both ?? 0,
  };
}

function omitUnsupportedRegexHint(error: string): string {
  // Grep does not expose rg's PCRE2 flag; preserve the diagnostic itself.
  return error.replace(
    /\n+Consider enabling PCRE2 with the --pcre2 flag, which can handle backreferences\s+and look-around\.\s*$/,
    "",
  );
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
    args.output_mode !== "count" &&
    args.output_mode !== "count-matches"
  ) {
    return {
      ok: false,
      pattern,
      error:
        'Grep.output_mode must be one of "content", "files_with_matches", "count", or "count-matches".',
    };
  }

  const mode = args.output_mode;

  if (mode === "count" && args.multiline === true) {
    return {
      ok: false,
      pattern,
      mode,
      error:
        'Grep output_mode="count" counts matching lines and cannot be combined with multiline=true. Use output_mode="count-matches" to count multiline matches.',
    };
  }

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
): Promise<{ ok: true; isDirectory: boolean } | { ok: false; error: string }> {
  try {
    const info = await stat(targetPath);
    return info.isFile() || info.isDirectory()
      ? { ok: true, isDirectory: info.isDirectory() }
      : { ok: false, error: "Grep.path must be a file or directory." };
  } catch {
    return { ok: false, error: "Grep.path does not exist." };
  }
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
