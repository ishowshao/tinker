import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ToolCall } from "../agent/types";
import type { TurnId } from "../ids/runtime-id";
import type { MemoryFtsMatch, MemorySearchMatch } from "../memory/contracts";
import { fuseMemoryRecall, MemoryCoordinator } from "../memory/memory-coordinator";
import { ObservationBuilder } from "../observation/observation-builder";
import {
  completedHookInput,
  completedSnapshot,
  createFixture,
  EMBEDDING,
  QueueExtractionModel,
  readDiagnostics,
  RecordingEmbeddingClient,
  SelectiveFailureEmbeddingClient,
  waitForLogKind,
  waitForLogLines,
} from "./helpers/memory-coordinator-support";
import { TEST_CONTEXT_BUDGET } from "./test-runtime";

describe("fuseMemoryRecall", () => {
  function vectorMatch(memoryId: string, createdAt: string): MemorySearchMatch {
    return Object.freeze({
      memoryId,
      text: `text-${memoryId}`,
      summary: `summary-${memoryId}`,
      score: 0.5,
      sourceWorkspace: "/w",
      sourceSessionId: "s",
      createdAt,
    });
  }

  function ftsMatch(memoryId: string, createdAt: string): MemoryFtsMatch {
    return Object.freeze({
      memoryId,
      text: `text-${memoryId}`,
      summary: `summary-${memoryId}`,
      bm25: -1,
      sourceWorkspace: "/w",
      sourceSessionId: "s",
      createdAt,
    });
  }

  test("ranks dual-path hits above single-path hits and marks via", () => {
    const fused = fuseMemoryRecall({
      vector: [
        vectorMatch("b", "2026-07-25T10:00:01.000Z"),
        vectorMatch("a", "2026-07-25T10:00:00.000Z"),
      ],
      fts: [ftsMatch("a", "2026-07-25T10:00:00.000Z")],
    });
    expect(fused.map((match) => match.memoryId)).toEqual(["a", "b"]);
    expect(fused[0]?.via).toEqual(["vector", "fts"]);
    expect(fused[1]?.via).toEqual(["vector"]);
    expect(fused[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(fused[1]?.score).toBeCloseTo(1 / 61, 10);
  });

  test("breaks RRF ties by recency then memory id and supports single-path input", () => {
    const fused = fuseMemoryRecall({
      vector: [],
      fts: [
        ftsMatch("b", "2026-07-25T10:00:00.000Z"),
        ftsMatch("a", "2026-07-25T10:00:01.000Z"),
      ],
    });
    expect(fused.map((match) => match.memoryId)).toEqual(["b", "a"]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 10);
    expect(fused[1]?.score).toBeCloseTo(1 / 62, 10);
    expect(fused[0]?.via).toEqual(["fts"]);

    const tiedByRecency = fuseMemoryRecall({
      vector: [vectorMatch("a", "2026-07-25T10:00:00.000Z")],
      fts: [ftsMatch("b", "2026-07-25T10:00:01.000Z")],
    });
    expect(tiedByRecency.map((match) => match.memoryId)).toEqual(["b", "a"]);

    const tiedById = fuseMemoryRecall({
      vector: [vectorMatch("b", "2026-07-25T10:00:00.000Z")],
      fts: [ftsMatch("a", "2026-07-25T10:00:00.000Z")],
    });
    expect(tiedById.map((match) => match.memoryId)).toEqual(["a", "b"]);
  });

  test("returns an empty result for empty recall", () => {
    expect(fuseMemoryRecall({ vector: [], fts: [] })).toEqual([]);
  });
});

describe("MemoryCoordinator recall", () => {
  test("truncates surfaced summaries to the search-result budget with a visible marker", async () => {
    const fixture = await createFixture();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () =>
          new QueueExtractionModel([
            JSON.stringify({
              text: "Tinker truncation record.",
              summary: " evidence line".repeat(200),
            }),
          ]),
        createEmbeddingClient: () => new RecordingEmbeddingClient(),
      });
      coordinator.enqueue({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
        turnId: "truncation-turn" as TurnId,
        snapshot: completedSnapshot("long summary evidence"),
      });
      await waitForLogKind(fixture.paths.log, "extraction");
      const executor = coordinator.createSearchToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });

      const raw = await executor.execute({ query: "truncation" }, {} as ToolCall, {
        signal: new AbortController().signal,
      });
      if (raw.kind !== "memory_search" || !raw.ok) {
        throw new Error("Expected successful MemorySearch.");
      }
      expect(raw.matches).toHaveLength(1);
      const summary = raw.matches[0]?.summary ?? "";
      expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(1_536);
      expect(summary.endsWith("…")).toBe(true);
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("returns an ordinary unavailable observation for search failures and remains usable", async () => {
    const fixture = await createFixture();
    const embeddings = new SelectiveFailureEmbeddingClient();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () =>
          new QueueExtractionModel([
            JSON.stringify({ memories: ["A durable test memory."] }),
          ]),
        createEmbeddingClient: () => embeddings,
      });
      coordinator.enqueue({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
        turnId: "search-failure-turn" as TurnId,
        snapshot: completedSnapshot("seed memory"),
      });
      await waitForLogKind(fixture.paths.log, "extraction");
      const executor = coordinator.createSearchToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });

      const failed = await executor.execute(
        { query: "provider failure" },
        {} as ToolCall,
        { signal: new AbortController().signal },
      );
      expect(failed).toMatchObject({ kind: "memory_search", ok: false });
      expect(
        new ObservationBuilder().build({
          call: {} as ToolCall,
          raw: failed,
        }).displayText,
      ).toBe("MemorySearch unavailable: embedding endpoint unavailable");

      const recovered = await executor.execute(
        { query: "working query" },
        {} as ToolCall,
        { signal: new AbortController().signal },
      );
      expect(recovered).toMatchObject({ kind: "memory_search", ok: true });
      await waitForLogLines(fixture.paths.log, 3);
      const diagnostics = await readDiagnostics(fixture.paths.log);
      expect(diagnostics[1]).toMatchObject({
        kind: "search",
        outcome: "failed",
        reason: "memory_search_failed",
      });
      expect(diagnostics[2]).toMatchObject({
        kind: "search",
        outcome: "ok",
      });
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("enforces trimmed query UTF-8 byte limits before embedding", async () => {
    const fixture = await createFixture();
    const embeddings = new RecordingEmbeddingClient();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => new QueueExtractionModel([]),
        createEmbeddingClient: () => embeddings,
      });
      const executor = coordinator.createSearchToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });

      for (const query of ["   ", "记".repeat(342)]) {
        const result = await executor.execute({ query }, {} as ToolCall, {
          signal: new AbortController().signal,
        });
        expect(result).toMatchObject({ kind: "memory_search", ok: false });
      }
      expect(embeddings.calls).toHaveLength(0);

      const valid = await executor.execute(
        { query: `  ${"记".repeat(341)}  ` },
        {} as ToolCall,
        { signal: new AbortController().signal },
      );
      expect(valid).toMatchObject({
        kind: "memory_search",
        ok: true,
        matches: [],
      });
      expect(embeddings.calls).toEqual([["记".repeat(341)]]);
      expect(
        new ObservationBuilder().build({
          call: {} as ToolCall,
          raw: valid,
        }).displayText,
      ).toBe("MemorySearch found no stored memories.");

      await waitForLogLines(fixture.paths.log, 3);
      const diagnostics = await readDiagnostics(fixture.paths.log);
      expect(diagnostics.map((entry) => entry.queryBytes)).toEqual([0, 1_026, 1_023]);
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("fuses vector and keyword recall with RRF and exposes via markers", async () => {
    const fixture = await createFixture();
    const model = new QueueExtractionModel([
      JSON.stringify({
        text: "Tinker 质量门: bun run check 必须通过",
        summary: "质量门摘要。",
      }),
      JSON.stringify({
        text: "FTS5 trigram 分词器支持中文",
        summary: "这条摘要提到 bun run check。",
      }),
      JSON.stringify({
        text: "完全无关的记忆",
        summary: "无关摘要。",
      }),
    ]);
    let tick = 0;
    const clock = () => `2026-07-25T10:00:${String(tick++ % 60).padStart(2, "0")}.000Z`;
    const embeddings = new RecordingEmbeddingClient((input) => {
      if (input.includes("质量门")) {
        return [1, 0, 0];
      }
      if (input.includes("trigram")) {
        return [0, 1, 0];
      }
      return [0, 0, 1];
    });
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => model,
        createEmbeddingClient: () => embeddings,
        clock,
      });
      coordinator.enqueue(completedHookInput(fixture, "turn a", "turn-a"));
      coordinator.enqueue(completedHookInput(fixture, "turn b", "turn-b"));
      coordinator.enqueue(completedHookInput(fixture, "turn c", "turn-c"));
      await waitForLogLines(fixture.paths.log, 3);

      const executor = coordinator.createSearchToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });
      const raw = await executor.execute(
        { query: "质量门是什么", keywords: ["bun run check"] },
        {} as ToolCall,
        { signal: new AbortController().signal },
      );
      if (raw.kind !== "memory_search" || !raw.ok) {
        throw new Error("Expected successful hybrid MemorySearch.");
      }
      expect(raw.degraded).toBeNull();
      expect(raw.matches).toHaveLength(3);
      expect(raw.matches.map((match) => match.text)).toEqual([
        "Tinker 质量门: bun run check 必须通过",
        "FTS5 trigram 分词器支持中文",
        "完全无关的记忆",
      ]);
      expect(raw.matches[0]?.via).toEqual(["vector", "fts"]);
      expect(raw.matches[1]?.via).toEqual(["vector", "fts"]);
      expect(raw.matches[2]?.via).toEqual(["vector"]);
      expect(raw.matches[0]?.score ?? 0).toBeGreaterThan(raw.matches[1]?.score ?? 0);

      const observation = new ObservationBuilder().build({
        call: {} as ToolCall,
        raw,
      }).displayText;
      expect(observation).toContain("via=vector,fts");
      expect(observation).not.toContain("unavailable");

      const diagnostics = await waitForLogLines(fixture.paths.log, 4);
      expect(diagnostics[3]).toMatchObject({
        kind: "search",
        outcome: "ok",
        keywordCount: 1,
        vectorReturned: 3,
        ftsReturned: 2,
        returned: 3,
        degraded: null,
      });
      const vectorScores =
        (diagnostics[3] as { vectorScores?: number[] }).vectorScores ?? [];
      expect(vectorScores).toHaveLength(3);
      for (const score of vectorScores) {
        expect(score).toBeGreaterThanOrEqual(-1);
        expect(score).toBeLessThanOrEqual(1);
      }
      expect([...vectorScores].sort((a, b) => b - a)).toEqual(vectorScores);
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("recalls with keywords only without calling the embedding provider", async () => {
    const fixture = await createFixture();
    const model = new QueueExtractionModel([
      JSON.stringify({ text: "关键词唯一召回目标", summary: "摘要。" }),
    ]);
    const embeddings = new RecordingEmbeddingClient();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => model,
        createEmbeddingClient: () => embeddings,
      });
      coordinator.enqueue(completedHookInput(fixture, "turn a", "turn-a"));
      await waitForLogLines(fixture.paths.log, 1);
      const embeddingCalls = embeddings.calls.length;

      const executor = coordinator.createSearchToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });
      const raw = await executor.execute({ keywords: ["召回目标"] }, {} as ToolCall, {
        signal: new AbortController().signal,
      });
      if (raw.kind !== "memory_search" || !raw.ok) {
        throw new Error("Expected successful keyword-only MemorySearch.");
      }
      expect(embeddings.calls).toHaveLength(embeddingCalls);
      expect(raw.degraded).toBeNull();
      expect(raw.matches).toHaveLength(1);
      expect(raw.matches[0]?.via).toEqual(["fts"]);

      const diagnostics = await waitForLogLines(fixture.paths.log, 2);
      expect(diagnostics[1]).toMatchObject({
        kind: "search",
        outcome: "ok",
        queryBytes: 0,
        keywordCount: 1,
        vectorReturned: 0,
        ftsReturned: 1,
        vectorScores: [],
      });
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("degrades to keyword recall when the embedding provider fails", async () => {
    const fixture = await createFixture();
    const model = new QueueExtractionModel([
      JSON.stringify({ text: "embedding 故障时的降级目标", summary: "摘要。" }),
    ]);
    const embeddings = new SelectiveFailureEmbeddingClient();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => model,
        createEmbeddingClient: () => embeddings,
      });
      coordinator.enqueue(completedHookInput(fixture, "turn a", "turn-a"));
      await waitForLogLines(fixture.paths.log, 1);

      const executor = coordinator.createSearchToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });
      const raw = await executor.execute(
        { query: "provider failure", keywords: ["降级目标"] },
        {} as ToolCall,
        { signal: new AbortController().signal },
      );
      if (raw.kind !== "memory_search" || !raw.ok) {
        throw new Error("Expected degraded keyword-only MemorySearch.");
      }
      expect(raw.degraded).toBe("vector");
      expect(raw.matches).toHaveLength(1);
      expect(raw.matches[0]?.via).toEqual(["fts"]);
      const observation = new ObservationBuilder().build({
        call: {} as ToolCall,
        raw,
      }).displayText;
      expect(observation).toContain("vector search unavailable; keyword results only.");

      const diagnostics = await waitForLogLines(fixture.paths.log, 2);
      expect(diagnostics[1]).toMatchObject({
        kind: "search",
        outcome: "ok",
        vectorReturned: 0,
        ftsReturned: 1,
        degraded: "vector",
      });
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("degrades to vector recall when the keyword index fails at runtime", async () => {
    const fixture = await createFixture();
    const model = new QueueExtractionModel([
      JSON.stringify({ text: "关键词索引损坏时的降级目标", summary: "摘要。" }),
    ]);
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => model,
        createEmbeddingClient: () => new RecordingEmbeddingClient(),
      });
      coordinator.enqueue(completedHookInput(fixture, "turn a", "turn-a"));
      await waitForLogLines(fixture.paths.log, 1);

      const external = new Database(fixture.paths.database, { strict: true });
      external.exec("DROP TABLE memories_fts");
      external.close();

      const executor = coordinator.createSearchToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });
      const raw = await executor.execute(
        { query: "降级目标", keywords: ["降级目标"] },
        {} as ToolCall,
        { signal: new AbortController().signal },
      );
      if (raw.kind !== "memory_search" || !raw.ok) {
        throw new Error("Expected degraded vector-only MemorySearch.");
      }
      expect(raw.degraded).toBe("fts");
      expect(raw.matches).toHaveLength(1);
      expect(raw.matches[0]?.via).toEqual(["vector"]);
      const observation = new ObservationBuilder().build({
        call: {} as ToolCall,
        raw,
      }).displayText;
      expect(observation).toContain("keyword search unavailable; vector results only.");

      const diagnostics = await waitForLogLines(fixture.paths.log, 2);
      expect(diagnostics[1]).toMatchObject({
        kind: "search",
        outcome: "ok",
        vectorReturned: 1,
        ftsReturned: 0,
        degraded: "fts",
      });
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("fails when both recall paths are unavailable", async () => {
    const fixture = await createFixture();
    const model = new QueueExtractionModel([
      JSON.stringify({ text: "双路故障目标", summary: "摘要。" }),
    ]);
    const embeddings = new SelectiveFailureEmbeddingClient();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => model,
        createEmbeddingClient: () => embeddings,
      });
      coordinator.enqueue(completedHookInput(fixture, "turn a", "turn-a"));
      await waitForLogLines(fixture.paths.log, 1);

      const external = new Database(fixture.paths.database, { strict: true });
      external.exec("DROP TABLE memories_fts");
      external.close();

      const executor = coordinator.createSearchToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });
      const raw = await executor.execute(
        { query: "provider failure", keywords: ["双路故障"] },
        {} as ToolCall,
        { signal: new AbortController().signal },
      );
      expect(raw).toMatchObject({ kind: "memory_search", ok: false });

      const diagnostics = await waitForLogLines(fixture.paths.log, 2);
      expect(diagnostics[1]).toMatchObject({
        kind: "search",
        outcome: "failed",
      });
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects invalid keyword arguments before touching recall paths", async () => {
    const fixture = await createFixture();
    const embeddings = new RecordingEmbeddingClient();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => new QueueExtractionModel([]),
        createEmbeddingClient: () => embeddings,
      });
      const executor = coordinator.createSearchToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });

      const invalidInputs: readonly unknown[] = [
        {},
        { keywords: [] },
        { keywords: Array.from({ length: 9 }, () => "abc") },
        { keywords: ["x".repeat(129)] },
        { keywords: "nope" },
        { query: 42 },
        { query: "ok", unexpected: true },
      ];
      for (const input of invalidInputs) {
        const result = await executor.execute(input, {} as ToolCall, {
          signal: new AbortController().signal,
        });
        expect(result).toMatchObject({ kind: "memory_search", ok: false });
      }
      expect(embeddings.calls).toHaveLength(0);

      const diagnostics = await waitForLogLines(
        fixture.paths.log,
        invalidInputs.length,
      );
      expect(
        diagnostics.every((entry) => entry.reason === "memory_search_args_invalid"),
      ).toBe(true);
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });
});
