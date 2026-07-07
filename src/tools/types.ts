import type { ToolCall } from "../agent/types";

export type JsonSchema = Record<string, unknown>;

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
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

export type GenericToolRawResult = {
  ok: false;
  toolName: string;
  error: string;
};

export type ToolRawResult =
  | ReadFileRawResult
  | WriteFileRawResult
  | EditFileRawResult
  | GlobRawResult
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
