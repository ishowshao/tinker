import type { ToolCall } from "../agent/types";
import type { ImageAssetRef } from "../image/image-types";
import type { SessionId } from "../ids/runtime-id";
import type {
  RecallGetPage,
  RecallSearchFilters,
  RecallSearchPage,
} from "../session/session-history-reader";
import type { ShellTaskSnapshot, ShellTaskStatus } from "./bash-task";
import type { SkillScope } from "../skills/skill-loader";

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
  contentBytes?: number;
  sizeBytes?: number;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  sha256?: string;
  error?: string;
};

export type ViewImageRawResult = {
  ok: boolean;
  filePath: string;
  originalName?: string;
  asset?: ImageAssetRef;
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
  lastObservedSha256?: string;
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
  currentSha256?: string;
  lastObservedSha256?: string;
  error?: string;
};

export type DeleteFileRawResult = {
  ok: boolean;
  filePath: string;
  absolutePath?: string;
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
  sessionId: SessionId;
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
  tty: boolean;
  screenRows?: number;
  screenColumns?: number;
  screen?: string;
  error?: string;
};

export type TaskListRawResult = {
  ok: boolean;
  runningCount: number;
  tasks: ShellTaskSnapshot[];
  error?: string;
};

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export type PlanStep = {
  step: string;
  status: PlanStepStatus;
};

export type UpdatePlanRawResult =
  | {
      ok: true;
      explanation?: string;
      plan: PlanStep[];
    }
  | {
      ok: false;
      error: string;
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
  screenRows?: number;
  screenColumns?: number;
  screen?: string;
  error?: string;
};

export type TaskInputRawResult =
  | {
      ok: true;
      taskId: string;
      task: ShellTaskSnapshot;
      status: ShellTaskStatus;
      writtenBytes: number;
      waitedMs: number;
      screenRows: number;
      screenColumns: number;
      screen: string;
      outputBytes: number;
      outputLines: number;
      outputFilePath: string;
    }
  | {
      ok: false;
      taskId: string;
      task?: ShellTaskSnapshot;
      status?: ShellTaskStatus;
      writtenBytes?: number;
      error: string;
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

export type RecallToolErrorCode =
  | "RECALL_ARGS_INVALID"
  | "RECALL_SOURCE_INVALID"
  | "RECALL_SOURCE_NOT_FOUND"
  | "RECALL_PAGE_INVALID"
  | "RECALL_SNAPSHOT_INVALID";

export type RecallSearchRawResult =
  | {
      ok: true;
      mode: "search";
      historical: true;
      query: string;
      filters: RecallSearchFilters;
      page: RecallSearchPage;
    }
  | {
      ok: false;
      mode: "search";
      errorCode: RecallToolErrorCode;
      error: string;
    };

export type RecallGetRawResult =
  | {
      ok: true;
      mode: "get";
      historical: true;
      page: RecallGetPage;
    }
  | {
      ok: false;
      mode: "get";
      errorCode: RecallToolErrorCode;
      error: string;
    };

export type RecallRawResult = RecallSearchRawResult | RecallGetRawResult;

export type MemorySearchRawResult =
  | {
      ok: true;
      matches: readonly {
        text: string;
        score: number;
        sourceWorkspace: string;
        createdAt: string;
      }[];
    }
  | {
      ok: false;
      error: string;
    };

export type SkillRawResult =
  | {
      ok: true;
      status: "loaded";
      name: string;
      scope: SkillScope;
      directory: string;
      skillFilePath: string;
      content: string;
      byteLength: number;
      sha256: string;
      resources: readonly string[];
      resourcesTruncated: boolean;
    }
  | {
      ok: true;
      status: "already_loaded";
      name: string;
      scope: SkillScope;
      lifecycle: "pending" | "dispatched";
      sha256: string;
    }
  | {
      ok: true;
      status: "already_active";
      name: string;
      scope: SkillScope;
      sha256: string;
    }
  | {
      ok: false;
      status: "failed";
      name: string;
      errorCode: string;
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

export type ToolRawResultByKind = {
  read: ReadFileRawResult;
  view_image: ViewImageRawResult;
  write: WriteFileRawResult;
  edit: EditFileRawResult;
  delete: DeleteFileRawResult;
  glob: GlobRawResult;
  grep: GrepRawResult;
  bash: BashRawResult;
  update_plan: UpdatePlanRawResult;
  task_list: TaskListRawResult;
  task_output: TaskOutputRawResult;
  task_input: TaskInputRawResult;
  task_stop: TaskStopRawResult;
  web_search: WebSearchRawResult;
  web_fetch: WebFetchRawResult;
  recall: RecallRawResult;
  memory_search: MemorySearchRawResult;
  skill: SkillRawResult;
  mcp: McpToolRawResult;
  generic: GenericToolRawResult;
};

export type ToolRawResultKind = keyof ToolRawResultByKind;

export type ToolRawResult = {
  [TKind in ToolRawResultKind]: ToolRawResultByKind[TKind] & { kind: TKind };
}[ToolRawResultKind];

export type ToolExecutor = {
  definition: ToolDefinition;
  execute(
    args: unknown,
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolRawResult>;
};

type UntaggedToolExecutor<TKind extends ToolRawResultKind> = {
  definition: ToolDefinition;
  execute(
    args: unknown,
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolRawResultByKind[TKind]>;
};

export function defineToolExecutor<TKind extends ToolRawResultKind>(
  kind: TKind,
  executor: UntaggedToolExecutor<TKind>,
): ToolExecutor {
  return {
    definition: executor.definition,
    async execute(args, call, context) {
      const raw = await executor.execute(args, call, context);
      return { ...raw, kind } as ToolRawResult;
    },
  };
}

export type ToolExecutionContext = {
  signal: AbortSignal;
  confirmBashCommand?: (request: {
    command: string;
    reason: string;
  }) => Promise<"allow" | "deny">;
  bashGuardSurface?: "tui" | "one-shot";
};

export class ToolExecutionFatalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolExecutionFatalError";
  }
}

export type FileSnapshot = {
  sha256: string;
  mtimeMs: number;
  source: "read" | "write" | "edit";
};

export type FileSnapshotStore = Map<string, FileSnapshot>;
