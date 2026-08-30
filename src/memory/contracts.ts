import type { SessionId, TurnId } from "../ids/runtime-id";

export const MEMORY_SEARCH_TOOL_NAME = "MemorySearch" as const;
export const MEMORY_GET_TOOL_NAME = "MemoryGet" as const;
export const MEMORY_SCHEMA_VERSION = 2 as const;
export const MAX_MEMORY_TEXT_BYTES = 512;
export const MAX_MEMORY_SUMMARY_BYTES = 4_096;
export const MAX_SEARCH_RESULT_SUMMARY_BYTES = 1_536;
export const MAX_MEMORY_QUERY_BYTES = 1_024;
export const MAX_MEMORY_ID_BYTES = 64;
export const MEMORY_SEARCH_LIMIT = 5;
export const MEMORY_RECALL_CANDIDATE_LIMIT = 20;
export const MAX_MEMORY_KEYWORDS = 8;
export const MAX_MEMORY_KEYWORD_BYTES = 128;
export const MEMORY_RRF_K = 60;
export const MEMORY_EXTRACTION_QUEUE_CAPACITY = 64;
export const MEMORY_SEARCH_DIAGNOSTIC_VECTOR_SCORES_LIMIT = 10;

export type MemoryEmbeddingKind = "openai-compatible";

export type MemoryEmbeddingConfig = {
  readonly name: string;
  readonly kind: MemoryEmbeddingKind;
  readonly model: string;
  readonly apiBase: string;
  readonly apiKey: string;
  readonly dimensions: number;
};

export type MemoryEmbeddingIdentity = Pick<
  MemoryEmbeddingConfig,
  "name" | "kind" | "model" | "dimensions"
>;

export type MemoryPaths = {
  readonly directory: string;
  readonly database: string;
  readonly log: string;
  readonly extractedLog: string;
};

export type MemoryWriteCandidate = {
  readonly text: string;
  readonly summary: string;
  readonly embedding: Float32Array;
};

export type MemoryWriteBatch = {
  readonly workspaceRoot: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly candidates: readonly MemoryWriteCandidate[];
};

export type MemoryWriteResult = {
  readonly written: number;
  readonly duplicate: number;
  readonly inserted: readonly MemoryInsertedRecord[];
};

export type MemoryInsertedRecord = {
  readonly memoryId: string;
  readonly text: string;
  readonly createdAt: string;
};

export type MemorySearchMatch = {
  readonly memoryId: string;
  readonly text: string;
  readonly summary: string;
  readonly score: number;
  readonly sourceWorkspace: string;
  readonly sourceSessionId: string;
  readonly createdAt: string;
};

export type MemoryRecallPath = "vector" | "fts";

export type MemoryFtsMatch = {
  readonly memoryId: string;
  readonly text: string;
  readonly summary: string;
  readonly bm25: number;
  readonly sourceWorkspace: string;
  readonly sourceSessionId: string;
  readonly createdAt: string;
};

export type MemoryHybridMatch = {
  readonly memoryId: string;
  readonly text: string;
  readonly summary: string;
  readonly score: number;
  readonly via: readonly MemoryRecallPath[];
  readonly sourceWorkspace: string;
  readonly sourceSessionId: string;
  readonly createdAt: string;
};

export type MemoryRecallDegraded = "vector" | "fts";

export type StoredMemorySummary = {
  readonly memoryId: string;
  readonly text: string;
  readonly summary: string;
  readonly sourceWorkspace: string;
  readonly sourceSessionId: string;
  readonly createdAt: string;
};

export type StoredMemoryRecord = StoredMemorySummary & {
  readonly sourceTurnId: string;
};

export type MemoryExtractionRejectedCounts = {
  readonly duplicate: number;
  readonly secret: number;
  readonly invalid: number;
  readonly embedding: number;
};

export type MemoryExtractionDiagnostic = {
  readonly at: string;
  readonly kind: "extraction";
  readonly outcome: "ok" | "failed" | "skipped";
  readonly reason: string | null;
  readonly workspace: string;
  readonly turnId: string;
  readonly inputTokens: number;
  readonly returned: number;
  readonly written: number;
  readonly rejected: MemoryExtractionRejectedCounts;
  readonly ms: number;
  /**
   * Bounded single-line error detail (message plus cause chain) recorded for
   * failed and skipped outcomes so provider/parse failures are diagnosable
   * from the log alone. Absent on success.
   */
  readonly detail?: string;
};

export type MemorySearchDiagnostic = {
  readonly at: string;
  readonly kind: "search";
  readonly outcome: "ok" | "failed" | "skipped";
  readonly reason: string | null;
  readonly workspace: string;
  readonly sessionId: string;
  readonly queryBytes: number;
  readonly keywordCount: number;
  readonly returned: number;
  readonly vectorReturned: number;
  readonly ftsReturned: number;
  readonly degraded: MemoryRecallDegraded | null;
  readonly scores: readonly number[];
  readonly vectorScores: readonly number[];
  readonly ms: number;
};

export type MemoryInitDiagnostic = {
  readonly at: string;
  readonly kind: "init";
  readonly outcome: "failed";
  readonly reason: string;
};

export type MemoryGetDiagnostic = {
  readonly at: string;
  readonly kind: "get";
  readonly outcome: "ok" | "failed";
  readonly reason: string | null;
  readonly workspace: string;
  readonly sessionId: string;
  readonly found: boolean;
  readonly ms: number;
};

export type MemoryDiagnostic =
  | MemoryExtractionDiagnostic
  | MemorySearchDiagnostic
  | MemoryGetDiagnostic
  | MemoryInitDiagnostic;

export class MemoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MemoryError";
  }
}

export function memoryErrorCode(error: unknown, fallback: string): string {
  return error instanceof MemoryError ? error.code : fallback;
}

export function boundedMemoryError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const singleLine = raw.replaceAll(/\s+/g, " ").trim() || "unknown memory error";
  return truncateUtf8(singleLine, 400);
}

export function boundedMemoryErrorDetail(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current !== undefined && current !== null;
    depth += 1
  ) {
    const raw =
      current instanceof Error
        ? current.message
        : typeof current === "string" ||
            typeof current === "number" ||
            typeof current === "boolean"
          ? String(current)
          : "unknown non-error cause";
    const singleLine = raw.replaceAll(/\s+/g, " ").trim();
    if (singleLine !== "" && !parts.includes(singleLine)) {
      parts.push(singleLine);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return truncateUtf8(parts.join(" | ") || "unknown memory error", 400);
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(`${value.slice(0, end)}…`, "utf8") > maxBytes) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
}
