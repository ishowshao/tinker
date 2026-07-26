import path from "node:path";
import type {
  CompletedTurnHook,
  CompletedTurnHookFailure,
  CompletedTurnHookInput,
} from "../agent/runtime-session";
import type { SessionId } from "../ids/runtime-id";
import type { ModelContextBudget } from "../model/model-context-profile";
import type { ModelClient } from "../model/model-client";
import type { CompletedTurnSnapshot } from "../session/session-store";
import type { MemorySearchRawResult, ToolExecutor } from "../tools/types";
import {
  boundedMemoryError,
  memoryErrorCode,
  MEMORY_SEARCH_TOOL_NAME,
  MemoryError,
  type MemoryEmbeddingConfig,
  type MemoryExtractionDiagnostic,
  type MemoryExtractionRejectedCounts,
  type MemoryPaths,
  type MemorySearchDiagnostic,
} from "./contracts";
import {
  OpenAICompatibleEmbeddingClient,
  type MemoryEmbeddingClient,
} from "./embedding-client";
import {
  MemoryExtractionOutputError,
  MemoryExtractionRequestError,
  MemoryExtractionSkippedError,
  MemoryExtractor,
  type MemoryExtractionResult,
} from "./memory-extractor";
import { MemoryLog } from "./memory-log";
import { createMemorySearchToolExecutor } from "./memory-search-tool";
import { MemoryStore, resolveMemoryPaths } from "./memory-store";
import { normalizeEmbedding } from "./vector";

type MemoryWorkerTask = {
  readonly workspaceRoot: string;
  readonly sessionId: SessionId;
  readonly turnId: CompletedTurnHookInput["turnId"];
  readonly extractionEvidenceText: string;
};

type ActiveMemoryTask = {
  readonly task: MemoryWorkerTask;
  readonly controller: AbortController;
  completion?: Promise<void>;
};

export type CreateMemoryCoordinatorInput = {
  readonly paths?: MemoryPaths;
  readonly embedding: MemoryEmbeddingConfig;
  readonly extractionContextBudget: ModelContextBudget;
  readonly createExtractionClient: () => ModelClient;
  readonly createEmbeddingClient?: () => MemoryEmbeddingClient;
  readonly clock?: () => string;
};

export class MemoryCoordinator implements CompletedTurnHook {
  private accepting = true;
  private active?: ActiveMemoryTask;
  private pending?: MemoryWorkerTask;

  private constructor(
    private readonly store: MemoryStore,
    private readonly extractor: MemoryExtractor,
    private readonly embeddingClient: MemoryEmbeddingClient,
    private readonly log: MemoryLog,
    private readonly embeddingDimensions: number,
    private readonly clock: () => string,
  ) {}

  static async create(input: CreateMemoryCoordinatorInput): Promise<MemoryCoordinator> {
    const paths = input.paths ?? resolveMemoryPaths();
    const log = new MemoryLog(paths.log);
    const store = await MemoryStore.open({
      paths,
      embedding: input.embedding,
      clock: input.clock,
    });
    try {
      const extractionClient = input.createExtractionClient();
      const embeddingClient =
        input.createEmbeddingClient?.() ??
        new OpenAICompatibleEmbeddingClient(input.embedding);
      return new MemoryCoordinator(
        store,
        new MemoryExtractor(extractionClient, input.extractionContextBudget),
        embeddingClient,
        log,
        input.embedding.dimensions,
        input.clock ?? (() => new Date().toISOString()),
      );
    } catch (error) {
      store.close();
      throw error;
    }
  }

  enqueue(input: CompletedTurnHookInput): void {
    if (!this.accepting) {
      throw new MemoryError(
        "completed_turn_enqueue_failed",
        "Memory coordinator is shutting down.",
      );
    }
    const extractionEvidenceText = buildExtractionEvidenceText(
      input.workspaceRoot,
      input.snapshot,
    );
    const task = Object.freeze({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      turnId: input.turnId,
      extractionEvidenceText,
    });
    if (this.active === undefined) {
      this.start(task);
      return;
    }
    this.pending = task;
  }

  recordFailure(input: CompletedTurnHookFailure): void {
    void this.log.append(
      extractionDiagnostic({
        clock: this.clock,
        outcome: "failed",
        reason: input.reason,
        workspace: input.workspaceRoot,
        turnId: input.turnId,
        ms: 0,
      }),
    );
  }

  createSearchToolExecutor(input: {
    readonly workspaceRoot: string;
    readonly sessionId: SessionId;
  }): ToolExecutor {
    return createMemorySearchToolExecutor({
      search: (query, signal) => this.search(query, signal, input),
      recordInvalidCall: (queryBytes) => this.recordInvalidSearch(queryBytes, input),
    });
  }

  dispose(): void {
    if (!this.accepting) {
      return;
    }
    this.accepting = false;
    this.pending = undefined;
    this.active?.controller.abort(
      new MemoryError(
        "memory_coordinator_disposed",
        "Memory coordinator is shutting down.",
      ),
    );
    this.store.close();
  }

  private start(task: MemoryWorkerTask): void {
    const active: ActiveMemoryTask = {
      task,
      controller: new AbortController(),
    };
    this.active = active;
    active.completion = Promise.resolve()
      .then(() => this.processTask(task, active.controller.signal))
      .catch(() => undefined)
      .finally(() => {
        if (this.active !== active) {
          return;
        }
        this.active = undefined;
        const next = this.accepting ? this.pending : undefined;
        this.pending = undefined;
        if (next !== undefined) {
          this.start(next);
        }
      });
  }

  private async processTask(
    task: MemoryWorkerTask,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = performance.now();
    let inputTokens = 0;
    let returned = 0;
    let rejected = emptyRejectedCounts();

    let extraction: MemoryExtractionResult;
    try {
      extraction = await this.extractor.extract(task.extractionEvidenceText, signal);
      inputTokens = extraction.inputTokens;
      returned = extraction.memories.length;
    } catch (error) {
      if (error instanceof MemoryExtractionSkippedError) {
        inputTokens = error.inputTokens;
        await this.log.append(
          extractionDiagnostic({
            clock: this.clock,
            outcome: "skipped",
            reason: error.code,
            workspace: task.workspaceRoot,
            turnId: task.turnId,
            inputTokens,
            ms: elapsedMs(startedAt),
          }),
        );
        return;
      }
      if (error instanceof MemoryExtractionOutputError) {
        inputTokens = error.inputTokens;
        returned = error.returned;
        rejected = Object.freeze({ ...rejected, invalid: Math.max(1, returned) });
      } else if (error instanceof MemoryExtractionRequestError) {
        inputTokens = error.inputTokens;
      }
      await this.log.append(
        extractionDiagnostic({
          clock: this.clock,
          outcome: signal.aborted ? "skipped" : "failed",
          reason: signal.aborted
            ? "extraction_cancelled"
            : memoryErrorCode(error, "extraction_model_failed"),
          workspace: task.workspaceRoot,
          turnId: task.turnId,
          inputTokens,
          returned,
          rejected,
          ms: elapsedMs(startedAt),
        }),
      );
      return;
    }

    const safeMemories = extraction.memories.filter((text) => {
      if (!containsSensitiveMemory(text)) {
        return true;
      }
      rejected = Object.freeze({
        ...rejected,
        secret: rejected.secret + 1,
      });
      return false;
    });
    if (safeMemories.length === 0) {
      await this.log.append(
        extractionDiagnostic({
          clock: this.clock,
          outcome: "ok",
          reason: null,
          workspace: task.workspaceRoot,
          turnId: task.turnId,
          inputTokens,
          returned,
          rejected,
          ms: elapsedMs(startedAt),
        }),
      );
      return;
    }

    let embeddings: readonly Float32Array[];
    try {
      const rawEmbeddings = await this.embeddingClient.embed(safeMemories, signal);
      if (rawEmbeddings.length !== safeMemories.length) {
        throw new MemoryError(
          "memory_embedding_response_invalid",
          "Embedding response count does not match the memory candidate count.",
        );
      }
      embeddings = Object.freeze(
        rawEmbeddings.map((vector) =>
          normalizeEmbedding(vector, this.embeddingDimensions),
        ),
      );
    } catch (error) {
      rejected = Object.freeze({
        ...rejected,
        embedding: safeMemories.length,
      });
      await this.log.append(
        extractionDiagnostic({
          clock: this.clock,
          outcome: signal.aborted ? "skipped" : "failed",
          reason: signal.aborted
            ? "extraction_cancelled"
            : memoryErrorCode(error, "memory_embedding_failed"),
          workspace: task.workspaceRoot,
          turnId: task.turnId,
          inputTokens,
          returned,
          rejected,
          ms: elapsedMs(startedAt),
        }),
      );
      return;
    }

    try {
      const result = this.store.insertBatch({
        workspaceRoot: task.workspaceRoot,
        sessionId: task.sessionId,
        turnId: task.turnId,
        candidates: safeMemories.map((text, index) => ({
          text,
          embedding: embeddings[index],
        })),
      });
      rejected = Object.freeze({
        ...rejected,
        duplicate: result.duplicate,
      });
      await this.log.append(
        extractionDiagnostic({
          clock: this.clock,
          outcome: "ok",
          reason: null,
          workspace: task.workspaceRoot,
          turnId: task.turnId,
          inputTokens,
          returned,
          written: result.written,
          rejected,
          ms: elapsedMs(startedAt),
        }),
      );
    } catch (error) {
      await this.log.append(
        extractionDiagnostic({
          clock: this.clock,
          outcome: signal.aborted ? "skipped" : "failed",
          reason: signal.aborted
            ? "extraction_cancelled"
            : memoryErrorCode(error, "memory_write_failed"),
          workspace: task.workspaceRoot,
          turnId: task.turnId,
          inputTokens,
          returned,
          rejected,
          ms: elapsedMs(startedAt),
        }),
      );
    }
  }

  private async search(
    query: string,
    signal: AbortSignal,
    source: { readonly workspaceRoot: string; readonly sessionId: SessionId },
  ): Promise<MemorySearchRawResult> {
    const startedAt = performance.now();
    const queryBytes = Buffer.byteLength(query, "utf8");
    try {
      const raw = await this.embeddingClient.embed([query], signal);
      if (raw.length !== 1 || raw[0] === undefined) {
        throw new MemoryError(
          "memory_embedding_response_invalid",
          "Embedding response did not contain the query vector.",
        );
      }
      const queryEmbedding = normalizeEmbedding(raw[0], this.embeddingDimensions);
      const matches = this.store.search(queryEmbedding);
      await this.log.append(
        searchDiagnostic({
          clock: this.clock,
          outcome: "ok",
          reason: null,
          workspace: source.workspaceRoot,
          sessionId: source.sessionId,
          queryBytes,
          returned: matches.length,
          scores: matches.map((match) => roundScore(match.score)),
          ms: elapsedMs(startedAt),
        }),
      );
      return {
        ok: true,
        matches: Object.freeze(
          matches.map((match) =>
            Object.freeze({
              text: match.text,
              score: match.score,
              sourceWorkspace: match.sourceWorkspace,
              createdAt: match.createdAt,
            }),
          ),
        ),
      };
    } catch (error) {
      const reason = signal.aborted
        ? "memory_search_cancelled"
        : memoryErrorCode(error, "memory_search_failed");
      await this.log.append(
        searchDiagnostic({
          clock: this.clock,
          outcome: signal.aborted ? "skipped" : "failed",
          reason,
          workspace: source.workspaceRoot,
          sessionId: source.sessionId,
          queryBytes,
          ms: elapsedMs(startedAt),
        }),
      );
      if (signal.aborted) {
        throw error;
      }
      return {
        ok: false,
        error: boundedMemoryError(error),
      };
    }
  }

  private recordInvalidSearch(
    queryBytes: number,
    source: { readonly workspaceRoot: string; readonly sessionId: SessionId },
  ): Promise<void> {
    return this.log.append(
      searchDiagnostic({
        clock: this.clock,
        outcome: "failed",
        reason: "memory_search_args_invalid",
        workspace: source.workspaceRoot,
        sessionId: source.sessionId,
        queryBytes,
        ms: 0,
      }),
    );
  }
}

export function buildExtractionEvidenceText(
  workspaceRoot: string,
  snapshot: CompletedTurnSnapshot,
): string {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new MemoryError(
      "completed_turn_enqueue_failed",
      "Completed turn workspace must be absolute.",
    );
  }
  const messages = snapshot.messages
    .filter(
      (message) => message.role !== "tool" || message.name !== MEMORY_SEARCH_TOOL_NAME,
    )
    .map((message) => ({ ...message }));
  return JSON.stringify(
    {
      workspaceRoot,
      messages,
    },
    null,
    2,
  );
}

export function containsSensitiveMemory(text: string): boolean {
  return [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
    /\b(?:authorization\s*:\s*)?bearer\s+[a-z0-9._~+/=-]{12,}\b/i,
    /\b(?:sk-[a-z0-9_-]{12,}|gh[opusr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/,
    /\b(?:cookie|session(?:_?token|id)?)\s*[:=]\s*["']?[^\s"',;]{8,}/i,
    /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?[^\s"',;]{6,}/i,
  ].some((pattern) => pattern.test(text));
}

function extractionDiagnostic(input: {
  readonly clock: () => string;
  readonly outcome: MemoryExtractionDiagnostic["outcome"];
  readonly reason: string | null;
  readonly workspace: string;
  readonly turnId: string;
  readonly ms: number;
  readonly inputTokens?: number;
  readonly returned?: number;
  readonly written?: number;
  readonly rejected?: MemoryExtractionRejectedCounts;
}): MemoryExtractionDiagnostic {
  return Object.freeze({
    at: input.clock(),
    kind: "extraction",
    outcome: input.outcome,
    reason: input.reason,
    workspace: input.workspace,
    turnId: input.turnId,
    inputTokens: input.inputTokens ?? 0,
    returned: input.returned ?? 0,
    written: input.written ?? 0,
    rejected: input.rejected ?? emptyRejectedCounts(),
    ms: input.ms,
  });
}

function searchDiagnostic(input: {
  readonly clock: () => string;
  readonly outcome: MemorySearchDiagnostic["outcome"];
  readonly reason: string | null;
  readonly workspace: string;
  readonly sessionId: string;
  readonly queryBytes: number;
  readonly returned?: number;
  readonly scores?: readonly number[];
  readonly ms: number;
}): MemorySearchDiagnostic {
  return Object.freeze({
    at: input.clock(),
    kind: "search",
    outcome: input.outcome,
    reason: input.reason,
    workspace: input.workspace,
    sessionId: input.sessionId,
    queryBytes: input.queryBytes,
    returned: input.returned ?? 0,
    scores: Object.freeze([...(input.scores ?? [])]),
    ms: input.ms,
  });
}

function emptyRejectedCounts(): MemoryExtractionRejectedCounts {
  return Object.freeze({
    duplicate: 0,
    secret: 0,
    invalid: 0,
    embedding: 0,
  });
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function roundScore(score: number): number {
  return Math.round(score * 1_000) / 1_000;
}
