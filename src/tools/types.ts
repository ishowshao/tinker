import type { ToolCall } from "../agent/types";
import type { ShellTaskSnapshot, ShellTaskStatus } from "./bash-task";

export type JsonSchema = Record<string, unknown>;

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export type ReadFileRawResult = {
  ok: boolean;
  filePath: string;
  absolutePath?: string;
  content?: string;
  sizeBytes?: number;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  sha256?: string;
  truncated?: boolean;
  displayedBytes?: number;
  error?: string;
};

export type WriteFileRawResult = {
  ok: boolean;
  filePath: string;
  absolutePath?: string;
  bytesWritten?: number;
  oldSha256?: string | null;
  newSha256?: string;
  created?: boolean;
  patch?: DiffHunk[];
  patchTruncated?: boolean;
  requiredReadBeforeWrite?: boolean;
  currentSha256?: string;
  lastReadSha256?: string;
  error?: string;
};

export type EditFileRawResult = {
  ok: boolean;
  filePath: string;
  absolutePath?: string;
  bytesWritten?: number;
  oldSha256?: string | null;
  newSha256?: string;
  replacementCount?: number;
  replaceAll?: boolean;
  created?: boolean;
  patch?: DiffHunk[];
  patchTruncated?: boolean;
  requiredReadBeforeEdit?: boolean;
  currentMtimeMs?: number;
  lastReadMtimeMs?: number;
  error?: string;
};

export type GlobRawResult = {
  ok: boolean;
  pattern: string;
  searchPath: string;
  absoluteSearchPath?: string;
  matches?: string[];
  matchCount?: number;
  ignored?: string[];
  error?: string;
};

export type GrepOutputMode = "content" | "files_with_matches" | "count";

export type GrepRawResult = {
  ok: boolean;
  pattern: string;
  searchPath: string;
  absoluteSearchPath?: string;
  mode: GrepOutputMode;
  filenames: string[];
  numFiles: number;
  content?: string;
  numLines?: number;
  numMatches?: number;
  appliedLimit?: number;
  appliedOffset?: number;
  ignored?: string[];
  truncated?: boolean;
  error?: string;
};

export type BashRawResult = {
  ok: boolean;
  command: string;
  taskId: string;
  runId: string;
  status: "completed" | "failed" | "running" | "killed";
  exitCode?: number;
  signal?: string;
  cwd: string;
  outputFilePath: string;
  outputBytes: number;
  outputLines: number;
  preview: string;
  truncated: boolean;
  omittedLines?: number;
  timedOut?: boolean;
  timeoutMs?: number;
  backgrounded?: boolean;
  backgroundedDueToTimeout?: boolean;
  returnCodeInterpretation?: string;
  error?: string;
};

export type TaskListRawResult = {
  ok: boolean;
  runningCount: number;
  tasks: ShellTaskSnapshot[];
  error?: string;
};

export type TaskOutputRawResult = {
  ok: boolean;
  taskId: string;
  task?: ShellTaskSnapshot;
  status?: ShellTaskStatus;
  command?: string;
  outputBytes?: number;
  outputLines?: number;
  preview?: string;
  truncated?: boolean;
  omittedLines?: number;
  outputFilePath?: string;
  error?: string;
};

export type TaskStopRawResult = {
  ok: boolean;
  taskId: string;
  task?: ShellTaskSnapshot;
  status?: ShellTaskStatus;
  requestedSignal?: "SIGTERM";
  escalated?: boolean;
  error?: string;
};

export type WebSearchResultItem = {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  highlights?: string[];
};

export type WebSearchRawResult = {
  ok: boolean;
  query: string;
  searchType?: string;
  requestId?: string;
  results?: WebSearchResultItem[];
  resultCount?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  costDollars?: number;
  durationMs?: number;
  error?: string;
};

export type WebFetchRawResult = {
  ok: boolean;
  url: string;
  route?: "local" | "exa" | "local-browser";
  finalUrl?: string;
  redirectUrl?: string;
  title?: string;
  publishedDate?: string;
  refined?: boolean;
  content?: string;
  highlights?: string[];
  source?: "cached" | "crawled";
  cacheHit?: boolean;
  errorTag?: string;
  httpStatusCode?: number;
  costDollars?: number;
  durationMs?: number;
  error?: string;
};

export type GenericToolRawResult = {
  ok: false;
  toolName: string;
  error: string;
};

export type McpToolRawResult = {
  ok: boolean;
  toolName: string;
  serverName: string;
  serverToolName: string;
  isError?: boolean;
  text?: string;
  truncated?: boolean;
  contentBlockCount?: number;
  error?: string;
};

export type ToolRawResult =
  | ReadFileRawResult
  | WriteFileRawResult
  | EditFileRawResult
  | GlobRawResult
  | GrepRawResult
  | BashRawResult
  | TaskListRawResult
  | TaskOutputRawResult
  | TaskStopRawResult
  | WebSearchRawResult
  | WebFetchRawResult
  | McpToolRawResult
  | GenericToolRawResult;

export type ToolExecutor = {
  definition: ToolDefinition;
  execute(args: unknown, call: ToolCall): Promise<ToolRawResult>;
};

export type FileSnapshot = {
  sha256: string;
  mtimeMs: number;
  fullFile: boolean;
  source: "read" | "write" | "edit";
};

export type ReadSnapshotStore = Map<string, FileSnapshot>;
