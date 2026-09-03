import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { ToolCall } from "../agent/types";
import type { SessionId, TurnId } from "../ids/runtime-id";
import type {
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import type { CompletedTurnSnapshot } from "../session/session-store";
import { ObservationBuilder } from "../observation/observation-builder";
import {
  buildExtractionEvidenceText,
  containsSensitiveMemory,
  fuseMemoryRecall,
  MemoryCoordinator,
} from "../memory/memory-coordinator";
import type { MemoryFtsMatch, MemorySearchMatch } from "../memory/contracts";
import type { MemoryEmbeddingClient } from "../memory/embedding-client";
import { MemoryStore, resolveMemoryPaths } from "../memory/memory-store";
import {
  TEST_CONTEXT_BUDGET,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

const EMBEDDING = Object.freeze({
  name: "coordinator-test-space",
  kind: "openai-compatible" as const,
  model: "coordinator-embedding",
  apiBase: "https://embedding.example.test/v1",
  apiKey: "embedding-key",
  dimensions: 3,
});

class QueueExtractionModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];

  constructor(private readonly outputs: string[]) {
    super();
  }

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    this.inputs.push(testModelRequestInput(prepared));
    const output = this.outputs.shift();
    if (output === undefined) {
      throw new Error("No extraction response is queued.");
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: output,
    });
  }
}

class RecordingEmbeddingClient implements MemoryEmbeddingClient {
  readonly calls: string[][] = [];

  constructor(
    private readonly vectorFor: (input: string) => readonly number[] = () => [1, 0, 0],
  ) {}

  async embed(
    inputs: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    signal.throwIfAborted();
    this.calls.push([...inputs]);
    return Object.freeze(
      inputs.map((input) => Object.freeze([...this.vectorFor(input)])),
    );
  }
}

class SelectiveFailureEmbeddingClient extends RecordingEmbeddingClient {
  async embed(
    inputs: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    if (inputs.length === 1 && inputs[0] === "provider failure") {
      this.calls.push([...inputs]);
      throw new Error("embedding endpoint unavailable");
    }
    return super.embed(inputs, signal);
  }
}

class AbortableEmbeddingClient implements MemoryEmbeddingClient {
  readonly started: Promise<void>;
  readonly calls: string[][] = [];
  private markStarted!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  async embed(
    inputs: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    this.calls.push([...inputs]);
    this.markStarted();
    return new Promise((_resolve, reject) => {
      const abort = () => {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Memory embedding test request was aborted."),
        );
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

class GatedExtractionModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];
  readonly firstStarted: Promise<void>;
  private markFirstStarted!: () => void;
  private releaseFirst!: () => void;
  private readonly firstGate: Promise<void>;

  constructor() {
    super();
    this.firstStarted = new Promise((resolve) => {
      this.markFirstStarted = resolve;
    });
    this.firstGate = new Promise((resolve) => {
      this.releaseFirst = resolve;
    });
  }

  release(): void {
    this.releaseFirst();
  }

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push(input);
    if (this.inputs.length === 1) {
      this.markFirstStarted();
      await this.firstGate;
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: JSON.stringify({
        text: `memory from extraction ${this.inputs.length}`,
        summary: "",
      }),
    });
  }
}

class AbortableExtractionModel extends TestModelClient {
  readonly started: Promise<void>;
  readonly aborted: Promise<void>;
  requests = 0;
  private markStarted!: () => void;
  private markAborted!: () => void;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
    this.aborted = new Promise((resolve) => {
      this.markAborted = resolve;
    });
  }

  async request(
    _prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requests += 1;
    this.markStarted();
    return new Promise((_resolve, reject) => {
      const abort = () => {
        this.markAborted();
        reject(
          options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("Memory extraction test request was aborted."),
        );
      };
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

describe("completed-turn memory projection", () => {
  test("keeps full text evidence and filters all memory tool observations", () => {
    const evidence = buildExtractionEvidenceText(
      "/workspace/a",
      completedSnapshot("user text [Image #1]"),
    );
    const parsed = JSON.parse(evidence) as {
      workspaceRoot: string;
      messages: Array<{ role: string; name?: string; content?: string }>;
    };

    expect(parsed.workspaceRoot).toBe("/workspace/a");
    expect(parsed.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(parsed.messages.some((message) => message.name === "MemorySearch")).toBe(
      false,
    );
    expect(parsed.messages.some((message) => message.name === "MemoryGet")).toBe(false);
    expect(parsed.messages.some((message) => message.name === "MemoryCreate")).toBe(
      false,
    );
    expect(parsed.messages.some((message) => message.name === "MemoryUpdate")).toBe(
      false,
    );
    expect(parsed.messages.some((message) => message.name === "MemoryDelete")).toBe(
      false,
    );
    expect(evidence).not.toContain("old derived memory");
    expect(parsed.messages.find((message) => message.name === "Read")?.content).toBe(
      "Read succeeded with verified output.",
    );
    expect(evidence).toContain("[Image #1]");
    expect(evidence).toContain("assistant reasoning");
  });

  test("detects common credential and private-key forms without redaction", () => {
    expect(containsSensitiveMemory("api_key=abcdefghijklmnop")).toBe(true);
    expect(containsSensitiveMemory("Authorization: Bearer abcdefghijklmnop")).toBe(
      true,
    );
    expect(
      containsSensitiveMemory(
        "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
      ),
    ).toBe(true);
    expect(
      containsSensitiveMemory(
        "The Tinker project requires bun run check before completion.",
      ),
    ).toBe(false);
  });
});

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

describe("MemoryCoordinator", () => {
  test("extracts one historical record, embeds its text, persists, searches, and writes content-free diagnostics", async () => {
    const fixture = await createFixture();
    const model = new QueueExtractionModel([
      JSON.stringify({
        text: "Tinker quality gate: source changes require bun run check.",
        summary:
          "User stated that Tinker source changes require bun run check before completion.",
      }),
    ]);
    const embeddings = new RecordingEmbeddingClient();
    let extractionClientCreations = 0;
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => {
          extractionClientCreations += 1;
          return model;
        },
        createEmbeddingClient: () => embeddings,
        clock: () => "2026-07-25T10:00:00.000Z",
      });
      coordinator.enqueue({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
        turnId: "coordinator-turn-1" as TurnId,
        snapshot: completedSnapshot("remember the Tinker constraints"),
      });
      await waitForLogKind(fixture.paths.log, "extraction");

      expect(extractionClientCreations).toBe(1);
      expect(embeddings.calls[0]).toEqual([
        "Tinker quality gate: source changes require bun run check.",
      ]);
      expect(model.inputs[0]?.messages[1]?.content).not.toContain("old derived memory");
      expect(model.inputs[0]?.messages[1]?.content).toContain(
        "Read succeeded with verified output.",
      );

      const executor = coordinator.createSearchToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });
      const raw = await executor.execute(
        { query: "What checks does Tinker require?" },
        {} as ToolCall,
        { signal: new AbortController().signal },
      );
      expect(raw).toMatchObject({
        kind: "memory_search",
        ok: true,
      });
      if (raw.kind !== "memory_search" || !raw.ok) {
        throw new Error("Expected successful MemorySearch.");
      }
      expect(raw.matches).toHaveLength(1);
      expect(raw.matches[0]).toMatchObject({
        text: "Tinker quality gate: source changes require bun run check.",
        summary:
          "User stated that Tinker source changes require bun run check before completion.",
        sourceSessionId: fixture.sessionId,
      });
      const observation = new ObservationBuilder().build({
        call: {} as ToolCall,
        raw,
      }).displayText;
      expect(observation).toContain("derived historical memory records");
      expect(observation).toContain("may be stale or wrong");
      expect(observation).toContain(fixture.workspaceRoot);
      expect(observation).toContain(`session=${fixture.sessionId}`);
      expect(observation).toContain(`memory=${raw.matches[0]?.memoryId}`);
      expect(observation).toContain(
        "User stated that Tinker source changes require bun run check before completion.",
      );
      expect(observation).toContain("MemoryGet");
      expect(observation).toContain("RecallSearch");

      const invalid = await executor.execute(
        { query: "valid", limit: 10 },
        {} as ToolCall,
        { signal: new AbortController().signal },
      );
      expect(invalid).toMatchObject({
        kind: "memory_search",
        ok: false,
      });
      expect(embeddings.calls).toHaveLength(2);

      const getExecutor = coordinator.createGetToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });
      const memoryId = raw.matches[0]?.memoryId;
      if (memoryId === undefined) {
        throw new Error("Expected MemorySearch to expose a memoryId.");
      }
      const got = await getExecutor.execute({ id: memoryId }, {} as ToolCall, {
        signal: new AbortController().signal,
      });
      expect(got).toMatchObject({ kind: "memory_get", ok: true });
      if (got.kind !== "memory_get" || !got.ok || got.memory === null) {
        throw new Error("Expected successful MemoryGet.");
      }
      expect(got.memory).toMatchObject({
        memoryId,
        text: "Tinker quality gate: source changes require bun run check.",
        summary:
          "User stated that Tinker source changes require bun run check before completion.",
        sourceWorkspace: fixture.workspaceRoot,
        sourceSessionId: fixture.sessionId,
        sourceTurnId: "coordinator-turn-1",
      });
      const getObservation = new ObservationBuilder().build({
        call: {} as ToolCall,
        raw: got,
      }).displayText;
      expect(getObservation).toContain("derived historical memory record");
      expect(getObservation).toContain("may be stale or wrong");
      expect(getObservation).toContain(`memory=${memoryId}`);
      expect(getObservation).toContain("turn=coordinator-turn-1");
      expect(getObservation).toContain(
        "summary: User stated that Tinker source changes require bun run check before completion.",
      );
      expect(getObservation).toContain("RecallSearch");

      const missing = await getExecutor.execute(
        { id: "01a00000-0000-7000-8000-000000000000" },
        {} as ToolCall,
        { signal: new AbortController().signal },
      );
      expect(missing).toMatchObject({ kind: "memory_get", ok: true, memory: null });
      const missingObservation = new ObservationBuilder().build({
        call: {} as ToolCall,
        raw: missing,
      }).displayText;
      expect(missingObservation).toBe("MemoryGet found no stored memory with that id.");

      const invalidGet = await getExecutor.execute(
        { id: memoryId, extra: true },
        {} as ToolCall,
        { signal: new AbortController().signal },
      );
      expect(invalidGet).toMatchObject({ kind: "memory_get", ok: false });

      await waitForLogLines(fixture.paths.log, 6);
      const diagnosticText = await readFile(fixture.paths.log, "utf8");
      expect(diagnosticText).not.toContain("What checks does Tinker require?");
      expect(diagnosticText).not.toContain("Tinker quality gate");
      expect(diagnosticText).not.toContain("User stated that Tinker");
      expect(diagnosticText).not.toContain(memoryId);
      const diagnostics = diagnosticText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(diagnostics.map((entry) => entry.kind)).toEqual([
        "extraction",
        "search",
        "search",
        "get",
        "get",
        "get",
      ]);
      expect(diagnostics[0]).toMatchObject({
        outcome: "ok",
        returned: 1,
        written: 1,
        rejected: { duplicate: 0, secret: 0, invalid: 0, embedding: 0 },
      });
      expect(diagnostics[1]).toMatchObject({
        outcome: "ok",
        returned: 1,
      });
      expect(diagnostics[2]).toMatchObject({
        outcome: "failed",
        reason: "memory_search_args_invalid",
      });
      expect(diagnostics[3]).toMatchObject({ outcome: "ok", found: true });
      expect(diagnostics[4]).toMatchObject({ outcome: "ok", found: false });
      expect(diagnostics[5]).toMatchObject({
        outcome: "failed",
        reason: "memory_get_args_invalid",
      });
      const extractedText = await readFile(fixture.paths.extractedLog, "utf8");
      expect(extractedText).toContain(
        `[2026-07-25T10:00:00.000Z] workspace=${JSON.stringify(fixture.workspaceRoot)} turn=coordinator-turn-1 written=1`,
      );
      expect(extractedText).toContain(
        '"Tinker quality gate: source changes require bun run check."',
      );
      expect(extractedText.match(/^- /gm)).toHaveLength(1);
      expect((await stat(fixture.paths.extractedLog)).mode & 0o777).toBe(0o600);

      coordinator.dispose();
      const reopened = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      expect(reopened.count()).toBe(1);
      reopened.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects records whose text or summary carries a secret before embedding", async () => {
    const fixture = await createFixture();
    const embeddings = new RecordingEmbeddingClient();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () =>
          new QueueExtractionModel([
            JSON.stringify({
              text: "The deployment password=supersecretvalue",
              summary: "Harmless summary.",
            }),
            JSON.stringify({
              text: "Deployment turn record.",
              summary: "The deployment used api_key=supersecretvalue during setup.",
            }),
          ]),
        createEmbeddingClient: () => embeddings,
      });
      coordinator.enqueue({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
        turnId: "secret-text-turn" as TurnId,
        snapshot: completedSnapshot("secret evidence in text"),
      });
      await waitForLogLines(fixture.paths.log, 1);
      coordinator.enqueue({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
        turnId: "secret-summary-turn" as TurnId,
        snapshot: completedSnapshot("secret evidence in summary"),
      });
      const diagnostics = await waitForLogLines(fixture.paths.log, 2);
      expect(embeddings.calls).toHaveLength(0);
      expect(diagnostics[0]).toMatchObject({
        outcome: "ok",
        returned: 1,
        written: 0,
        rejected: { secret: 1 },
      });
      expect(diagnostics[1]).toMatchObject({
        outcome: "ok",
        returned: 1,
        written: 0,
        rejected: { secret: 1 },
      });
      expect(await readOptionalFile(fixture.paths.extractedLog)).toBe("");
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("logs a skipped turn as returned 0 without embedding or writing", async () => {
    const fixture = await createFixture();
    const embeddings = new RecordingEmbeddingClient();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () =>
          new QueueExtractionModel([JSON.stringify({ text: "", summary: "" })]),
        createEmbeddingClient: () => embeddings,
      });
      coordinator.enqueue({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
        turnId: "skipped-turn" as TurnId,
        snapshot: completedSnapshot("just a greeting"),
      });
      const [diagnostic] = await waitForLogKind(fixture.paths.log, "extraction");
      expect(embeddings.calls).toHaveLength(0);
      expect(diagnostic).toMatchObject({
        outcome: "ok",
        returned: 0,
        written: 0,
        rejected: { duplicate: 0, secret: 0, invalid: 0, embedding: 0 },
      });
      expect(await readOptionalFile(fixture.paths.extractedLog)).toBe("");
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("logs only newly inserted memories when later extraction is a duplicate", async () => {
    const fixture = await createFixture();
    const memory = {
      text: "Tinker uses bun run check as its source-change gate.",
      summary: "Recorded from a turn about the Tinker quality gate.",
    };
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () =>
          new QueueExtractionModel([JSON.stringify(memory), JSON.stringify(memory)]),
        createEmbeddingClient: () => new RecordingEmbeddingClient(),
        clock: () => "2026-07-25T10:00:00.000Z",
      });

      coordinator.enqueue(completedHookInput(fixture, "first evidence", "first-turn"));
      await waitForLogLines(fixture.paths.log, 1);
      coordinator.enqueue(
        completedHookInput(fixture, "duplicate evidence", "duplicate-turn"),
      );
      const diagnostics = await waitForLogLines(fixture.paths.log, 2);

      expect(diagnostics[1]).toMatchObject({
        outcome: "ok",
        returned: 1,
        written: 0,
        rejected: { duplicate: 1 },
      });
      const extractedText = await readFile(fixture.paths.extractedLog, "utf8");
      expect(extractedText).toContain("turn=first-turn written=1");
      expect(extractedText).not.toContain("duplicate-turn");
      expect(extractedText.match(/^- /gm)).toHaveLength(1);
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("logs oversized extraction preflight as skipped without dispatch or embedding", async () => {
    const fixture = await createFixture();
    const model = new QueueExtractionModel([]);
    const embeddings = new RecordingEmbeddingClient();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: {
          ...TEST_CONTEXT_BUDGET,
          inputBudgetTokens: 1,
        },
        createExtractionClient: () => model,
        createEmbeddingClient: () => embeddings,
      });
      coordinator.enqueue({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
        turnId: "oversized-turn" as TurnId,
        snapshot: completedSnapshot("oversized extraction evidence"),
      });
      const [diagnostic] = await waitForLogKind(fixture.paths.log, "extraction");

      expect(model.inputs).toHaveLength(0);
      expect(embeddings.calls).toHaveLength(0);
      expect(diagnostic).toMatchObject({
        outcome: "skipped",
        reason: "extraction_input_too_large",
        written: 0,
      });
      expect(diagnostic?.inputTokens).toBeGreaterThan(1);
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

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

  test("fails the extraction when the embedding vector is invalid", async () => {
    const fixture = await createFixture();
    const embeddings = new RecordingEmbeddingClient(() => [1, 0]);
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () =>
          new QueueExtractionModel([
            JSON.stringify({
              text: "Tinker vector record.",
              summary: "A summary that will never be stored.",
            }),
          ]),
        createEmbeddingClient: () => embeddings,
      });
      coordinator.enqueue({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
        turnId: "invalid-vector-turn" as TurnId,
        snapshot: completedSnapshot("vector evidence"),
      });
      const [diagnostic] = await waitForLogKind(fixture.paths.log, "extraction");
      expect(embeddings.calls).toHaveLength(1);
      expect(diagnostic).toMatchObject({
        outcome: "failed",
        written: 0,
        rejected: { embedding: 1 },
      });
      expect(typeof diagnostic.detail).toBe("string");
      coordinator.dispose();

      const reopened = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      expect(reopened.count()).toBe(0);
      reopened.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("records bounded error detail for extraction failures", async () => {
    const fixture = await createFixture();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => new QueueExtractionModel(["not json at all"]),
        createEmbeddingClient: () => new RecordingEmbeddingClient(),
      });
      coordinator.enqueue({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
        turnId: "invalid-output-turn" as TurnId,
        snapshot: completedSnapshot("bad output evidence"),
      });
      const [invalidDiagnostic] = await waitForLogKind(fixture.paths.log, "extraction");
      expect(invalidDiagnostic).toMatchObject({
        outcome: "failed",
        reason: "extraction_output_invalid",
      });
      expect(invalidDiagnostic.detail).toEqual(expect.any(String));
      expect(invalidDiagnostic.detail as string).toContain("not valid JSON");
      expect(invalidDiagnostic.detail as string).toContain("not json at all");

      // The queue is now empty, so the next request throws inside the model.
      coordinator.enqueue({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
        turnId: "model-failure-turn" as TurnId,
        snapshot: completedSnapshot("model failure evidence"),
      });
      const diagnostics = await waitForLogLines(fixture.paths.log, 2);
      expect(diagnostics[1]).toMatchObject({
        outcome: "failed",
        reason: "extraction_model_failed",
      });
      expect(diagnostics[1]?.detail as string).toContain(
        "No extraction response is queued.",
      );
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("keeps one active task and drains queued tasks in FIFO order", async () => {
    const fixture = await createFixture();
    const model = new GatedExtractionModel();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => model,
        createEmbeddingClient: () => new RecordingEmbeddingClient(),
      });
      coordinator.enqueue(completedHookInput(fixture, "first", "turn-first"));
      await model.firstStarted;
      coordinator.enqueue(completedHookInput(fixture, "second", "turn-second"));
      coordinator.enqueue(completedHookInput(fixture, "third", "turn-third"));
      model.release();

      await waitForLogLines(fixture.paths.log, 3);
      expect(model.inputs).toHaveLength(3);
      expect(model.inputs[0]?.messages[1]?.content).toContain("first");
      expect(model.inputs[1]?.messages[1]?.content).toContain("second");
      expect(model.inputs[2]?.messages[1]?.content).toContain("third");
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("bounds the pending queue and drops the oldest queued tasks", async () => {
    const fixture = await createFixture();
    const model = new GatedExtractionModel();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => model,
        createEmbeddingClient: () => new RecordingEmbeddingClient(),
      });
      coordinator.enqueue(completedHookInput(fixture, "marker-001", "turn-001"));
      await model.firstStarted;
      for (let index = 2; index <= 67; index += 1) {
        const marker = `marker-${String(index).padStart(3, "0")}`;
        coordinator.enqueue(completedHookInput(fixture, marker, `turn-${marker}`));
      }
      model.release();

      await waitForLogLines(fixture.paths.log, 65);
      const contents = model.inputs.map((input) => {
        const content: unknown = input.messages[1]?.content;
        return typeof content === "string" ? content : "";
      });
      expect(contents).toHaveLength(65);
      expect(contents[0]).toContain("marker-001");
      expect(contents.some((content) => content.includes("marker-002"))).toBe(false);
      expect(contents.some((content) => content.includes("marker-003"))).toBe(false);
      expect(contents[1]).toContain("marker-004");
      expect(contents[64]).toContain("marker-067");
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("cancels active work and drops pending work without draining on dispose", async () => {
    const fixture = await createFixture();
    const model = new AbortableExtractionModel();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => model,
        createEmbeddingClient: () => new RecordingEmbeddingClient(),
      });
      coordinator.enqueue(completedHookInput(fixture, "active", "turn-active"));
      await model.started;
      coordinator.enqueue(completedHookInput(fixture, "pending", "turn-pending"));
      coordinator.dispose();
      await model.aborted;
      await waitForLogKind(fixture.paths.log, "extraction");

      expect(model.requests).toBe(1);
      const diagnostics = await readDiagnostics(fixture.paths.log);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        outcome: "skipped",
        reason: "extraction_cancelled",
      });
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

  test("creates, updates, deletes, and immediately recalls model-authored memories", async () => {
    const fixture = await createFixture();
    const embeddings = new RecordingEmbeddingClient((input) =>
      input.includes("replacement") ? [0, 1, 0] : [1, 0, 0],
    );
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => new QueueExtractionModel([]),
        createEmbeddingClient: () => embeddings,
        clock: () => "2026-09-03T10:00:00.000Z",
      });
      const source = {
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      };
      const create = coordinator.createCreateToolExecutor(source);
      const update = coordinator.createUpdateToolExecutor(source);
      const remove = coordinator.createDeleteToolExecutor(source);
      const search = coordinator.createSearchToolExecutor(source);
      const get = coordinator.createGetToolExecutor(source);
      const signal = new AbortController().signal;

      const createCall = memoryToolCall(
        "MemoryCreate",
        { text: "  model authored anchor  ", summary: "  original detail marker  " },
        1,
      );
      const created = await create.execute(createCall.args, createCall, { signal });
      expect(created).toMatchObject({
        kind: "memory_create",
        ok: true,
        status: "created",
        createdAt: "2026-09-03T10:00:00.000Z",
      });
      if (created.kind !== "memory_create" || !created.ok) {
        throw new Error("Expected MemoryCreate success.");
      }
      const firstId = created.memoryId;
      expect(
        new ObservationBuilder().build({ call: createCall, raw: created }).displayText,
      ).toBe(
        `MemoryCreate created memory=${firstId} created_at=2026-09-03T10:00:00.000Z.\ntext: model authored anchor`,
      );
      const recalled = await search.execute(
        { query: "model authored", keywords: ["original detail"] },
        memoryToolCall("MemorySearch", {}, 2),
        { signal },
      );
      expect(recalled).toMatchObject({
        kind: "memory_search",
        ok: true,
        matches: [{ memoryId: firstId, text: "model authored anchor" }],
      });
      const fetched = await get.execute(
        { id: firstId },
        memoryToolCall("MemoryGet", {}, 3),
        { signal },
      );
      expect(fetched).toMatchObject({
        kind: "memory_get",
        ok: true,
        memory: {
          memoryId: firstId,
          summary: "original detail marker",
          sourceWorkspace: fixture.workspaceRoot,
          sourceSessionId: fixture.sessionId,
          sourceTurnId: "memory-mutation-turn-1",
        },
      });

      const duplicateCall = memoryToolCall(
        "MemoryCreate",
        { text: "model authored anchor", summary: "ignored duplicate summary" },
        4,
      );
      const duplicate = await create.execute(duplicateCall.args, duplicateCall, {
        signal,
      });
      expect(duplicate).toEqual({
        kind: "memory_create",
        ok: true,
        status: "already_exists",
        memoryId: firstId,
        createdAt: "2026-09-03T10:00:00.000Z",
      });
      expect(coordinator.listStoredMemories()).toHaveLength(1);

      const callsBeforeSummaryUpdate = embeddings.calls.length;
      const summaryUpdateCall = memoryToolCall(
        "MemoryUpdate",
        {
          id: firstId,
          text: "model authored anchor",
          summary: "updated detail marker",
        },
        5,
      );
      const summaryUpdated = await update.execute(
        summaryUpdateCall.args,
        summaryUpdateCall,
        { signal },
      );
      expect(summaryUpdated).toEqual({
        kind: "memory_update",
        ok: true,
        status: "updated",
        memoryId: firstId,
      });
      expect(embeddings.calls).toHaveLength(callsBeforeSummaryUpdate);
      expect(
        new ObservationBuilder().build({
          call: summaryUpdateCall,
          raw: summaryUpdated,
        }).displayText,
      ).toBe(`MemoryUpdate updated memory=${firstId}.\ntext: model authored anchor`);
      const oldSummary = await search.execute(
        { keywords: ["original detail"] },
        memoryToolCall("MemorySearch", {}, 6),
        { signal },
      );
      expect(oldSummary).toMatchObject({
        kind: "memory_search",
        ok: true,
        matches: [],
      });
      const newSummary = await search.execute(
        { keywords: ["updated detail"] },
        memoryToolCall("MemorySearch", {}, 7),
        { signal },
      );
      expect(newSummary).toMatchObject({
        kind: "memory_search",
        ok: true,
        matches: [{ memoryId: firstId }],
      });

      const textUpdateCall = memoryToolCall(
        "MemoryUpdate",
        {
          id: firstId,
          text: "replacement searchable anchor",
          summary: "replacement summary",
        },
        8,
      );
      const textUpdated = await update.execute(textUpdateCall.args, textUpdateCall, {
        signal,
      });
      expect(textUpdated).toMatchObject({
        kind: "memory_update",
        ok: true,
        memoryId: firstId,
      });
      expect(embeddings.calls.at(-1)).toEqual(["replacement searchable anchor"]);
      const oldText = await search.execute(
        { keywords: ["model authored"] },
        memoryToolCall("MemorySearch", {}, 9),
        { signal },
      );
      expect(oldText).toMatchObject({
        kind: "memory_search",
        ok: true,
        matches: [],
      });
      const newText = await search.execute(
        { query: "replacement searchable", keywords: ["replacement searchable"] },
        memoryToolCall("MemorySearch", {}, 10),
        { signal },
      );
      expect(newText).toMatchObject({
        kind: "memory_search",
        ok: true,
        matches: [{ memoryId: firstId }],
      });

      const secondCall = memoryToolCall(
        "MemoryCreate",
        { text: "second collision anchor", summary: "second summary" },
        11,
      );
      const second = await create.execute(secondCall.args, secondCall, { signal });
      if (second.kind !== "memory_create" || !second.ok) {
        throw new Error("Expected second MemoryCreate success.");
      }
      const collisionCall = memoryToolCall(
        "MemoryUpdate",
        {
          id: firstId,
          text: "second collision anchor",
          summary: "must not replace",
        },
        12,
      );
      const collision = await update.execute(collisionCall.args, collisionCall, {
        signal,
      });
      expect(collision).toEqual({
        kind: "memory_update",
        ok: false,
        code: "memory_duplicate",
        conflictMemoryId: second.memoryId,
        error: `Another global memory already has the replacement text (memoryId ${second.memoryId}).`,
      });
      expect(
        new ObservationBuilder().build({ call: collisionCall, raw: collision })
          .displayText,
      ).toContain(`code=memory_duplicate conflict_memory=${second.memoryId}`);

      const missingId = "00000000-0000-7000-8000-00000000000f";
      const missingUpdateCall = memoryToolCall(
        "MemoryUpdate",
        { id: missingId, text: "missing record", summary: "" },
        13,
      );
      const missingUpdate = await update.execute(
        missingUpdateCall.args,
        missingUpdateCall,
        { signal },
      );
      expect(missingUpdate).toMatchObject({
        kind: "memory_update",
        ok: false,
        code: "memory_not_found",
      });

      const deleteCall = memoryToolCall("MemoryDelete", { id: firstId }, 14);
      const deleted = await remove.execute(deleteCall.args, deleteCall, { signal });
      expect(deleted).toEqual({
        kind: "memory_delete",
        ok: true,
        status: "deleted",
        memoryId: firstId,
      });
      expect(
        new ObservationBuilder().build({ call: deleteCall, raw: deleted }).displayText,
      ).toBe(`MemoryDelete deleted memory=${firstId}.`);
      const deletedGet = await get.execute(
        { id: firstId },
        memoryToolCall("MemoryGet", {}, 15),
        { signal },
      );
      expect(deletedGet).toMatchObject({
        kind: "memory_get",
        ok: true,
        memory: null,
      });
      const missingDelete = await remove.execute(
        { id: firstId },
        memoryToolCall("MemoryDelete", { id: firstId }, 16),
        { signal },
      );
      expect(missingDelete).toMatchObject({
        kind: "memory_delete",
        ok: false,
        code: "memory_not_found",
      });
      const recreatedCall = memoryToolCall(
        "MemoryCreate",
        { text: "replacement searchable anchor", summary: "recreated" },
        17,
      );
      const recreated = await create.execute(recreatedCall.args, recreatedCall, {
        signal,
      });
      expect(recreated).toMatchObject({
        kind: "memory_create",
        ok: true,
        status: "created",
      });
      if (recreated.kind !== "memory_create" || !recreated.ok) {
        throw new Error("Expected recreated MemoryCreate success.");
      }
      expect(recreated.memoryId).not.toBe(firstId);

      await waitForLogKind(fixture.paths.log, "delete");
      const diagnosticText = await readFile(fixture.paths.log, "utf8");
      expect(diagnosticText).not.toContain("model authored anchor");
      expect(diagnosticText).not.toContain("replacement summary");
      const mutations = (await readDiagnostics(fixture.paths.log)).filter((entry) =>
        ["create", "update", "delete"].includes(String(entry.kind)),
      );
      expect(mutations[0]).toMatchObject({
        kind: "create",
        outcome: "ok",
        workspace: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
        turnId: "memory-mutation-turn-1",
        toolCallId: "memory-mutation-tool-1",
        memoryId: firstId,
      });
      expect(mutations.some((entry) => entry.reason === "memory_duplicate")).toBe(true);
      expect(mutations.some((entry) => entry.reason === "memory_not_found")).toBe(true);
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects invalid, sensitive, and unembeddable mutation inputs without writing", async () => {
    const fixture = await createFixture();
    const embeddings = new SelectiveFailureEmbeddingClient();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => new QueueExtractionModel([]),
        createEmbeddingClient: () => embeddings,
      });
      const source = {
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      };
      const create = coordinator.createCreateToolExecutor(source);
      const update = coordinator.createUpdateToolExecutor(source);
      const remove = coordinator.createDeleteToolExecutor(source);
      const signal = new AbortController().signal;

      const invalidCreateCall = memoryToolCall(
        "MemoryCreate",
        { text: "valid", extra: true },
        1,
      );
      expect(
        await create.execute(invalidCreateCall.args, invalidCreateCall, { signal }),
      ).toMatchObject({ kind: "memory_create", ok: false });
      const invalidUpdateCall = memoryToolCall(
        "MemoryUpdate",
        { id: "memory-id", text: "valid" },
        2,
      );
      expect(
        await update.execute(invalidUpdateCall.args, invalidUpdateCall, { signal }),
      ).toMatchObject({ kind: "memory_update", ok: false });
      const invalidDeleteCall = memoryToolCall(
        "MemoryDelete",
        { id: "memory-id", extra: true },
        3,
      );
      expect(
        await remove.execute(invalidDeleteCall.args, invalidDeleteCall, { signal }),
      ).toMatchObject({ kind: "memory_delete", ok: false });

      const sensitiveCall = memoryToolCall(
        "MemoryCreate",
        { text: "sensitive candidate", summary: "api_key=abcdefghijklmnop" },
        4,
      );
      const sensitive = await create.execute(sensitiveCall.args, sensitiveCall, {
        signal,
      });
      expect(sensitive).toEqual({
        kind: "memory_create",
        ok: false,
        error: "MemoryCreate rejected content that may contain sensitive information.",
      });
      const embeddingCall = memoryToolCall(
        "MemoryCreate",
        { text: "provider failure", summary: "must not persist" },
        5,
      );
      const embeddingFailure = await create.execute(embeddingCall.args, embeddingCall, {
        signal,
      });
      expect(embeddingFailure).toEqual({
        kind: "memory_create",
        ok: false,
        error: "MemoryCreate could not generate a memory embedding.",
      });
      expect(coordinator.listStoredMemories()).toEqual([]);

      const diagnostics = await waitForLogLines(fixture.paths.log, 5);
      expect(diagnostics.map((entry) => entry.reason)).toEqual([
        "memory_create_args_invalid",
        "memory_update_args_invalid",
        "memory_delete_args_invalid",
        "memory_sensitive_rejected",
        "memory_embedding_failed",
      ]);
      const diagnosticText = await readFile(fixture.paths.log, "utf8");
      expect(diagnosticText).not.toContain("abcdefghijklmnop");
      expect(diagnosticText).not.toContain("provider failure");
      expect(embeddings.calls).toEqual([["provider failure"]]);
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("returns transaction failures as tool errors and remains usable", async () => {
    const fixture = await createFixture();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => new QueueExtractionModel([]),
        createEmbeddingClient: () => new RecordingEmbeddingClient(),
      });
      const create = coordinator.createCreateToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });
      const update = coordinator.createUpdateToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });
      const remove = coordinator.createDeleteToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });
      const database = new Database(fixture.paths.database);
      database.exec(
        "CREATE TRIGGER reject_model_memory AFTER INSERT ON memories BEGIN SELECT RAISE(ABORT, 'injected mutation failure'); END",
      );
      const failedCall = memoryToolCall(
        "MemoryCreate",
        { text: "failed transaction", summary: "" },
        1,
      );
      const failed = await create.execute(failedCall.args, failedCall, {
        signal: new AbortController().signal,
      });
      expect(failed).toMatchObject({ kind: "memory_create", ok: false });
      expect(coordinator.listStoredMemories()).toEqual([]);

      database.exec("DROP TRIGGER reject_model_memory");
      database.close();
      const recoveredCall = memoryToolCall(
        "MemoryCreate",
        { text: "successful retry", summary: "" },
        2,
      );
      const recovered = await create.execute(recoveredCall.args, recoveredCall, {
        signal: new AbortController().signal,
      });
      expect(recovered).toMatchObject({
        kind: "memory_create",
        ok: true,
        status: "created",
      });
      if (recovered.kind !== "memory_create" || !recovered.ok) {
        throw new Error("Expected MemoryCreate recovery.");
      }

      const updateDatabase = new Database(fixture.paths.database);
      updateDatabase.exec(
        "CREATE TRIGGER reject_model_memory_update AFTER UPDATE ON memories BEGIN SELECT RAISE(ABORT, 'injected update failure'); END",
      );
      const updateCall = memoryToolCall(
        "MemoryUpdate",
        {
          id: recovered.memoryId,
          text: "failed replacement",
          summary: "failed replacement summary",
        },
        3,
      );
      expect(
        await update.execute(updateCall.args, updateCall, {
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ kind: "memory_update", ok: false });
      updateDatabase.exec("DROP TRIGGER reject_model_memory_update");
      updateDatabase.exec(
        "CREATE TRIGGER reject_model_memory_delete AFTER DELETE ON memories BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END",
      );
      const deleteCall = memoryToolCall("MemoryDelete", { id: recovered.memoryId }, 4);
      expect(
        await remove.execute(deleteCall.args, deleteCall, {
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ kind: "memory_delete", ok: false });
      updateDatabase.close();
      expect(coordinator.listStoredMemories()).toEqual([
        expect.objectContaining({
          memoryId: recovered.memoryId,
          text: "successful retry",
        }),
      ]);

      const diagnostics = await waitForLogLines(fixture.paths.log, 4);
      expect(diagnostics[0]).toMatchObject({
        kind: "create",
        outcome: "failed",
        reason: "memory_write_failed",
      });
      expect(diagnostics[1]).toMatchObject({ kind: "create", outcome: "ok" });
      expect(diagnostics[2]).toMatchObject({
        kind: "update",
        outcome: "failed",
        reason: "memory_write_failed",
      });
      expect(diagnostics[3]).toMatchObject({
        kind: "delete",
        outcome: "failed",
        reason: "memory_write_failed",
      });
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  test("cancels mutation embedding before commit and records a skipped diagnostic", async () => {
    const fixture = await createFixture();
    const embeddings = new AbortableEmbeddingClient();
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () => new QueueExtractionModel([]),
        createEmbeddingClient: () => embeddings,
      });
      const create = coordinator.createCreateToolExecutor({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
      });
      const controller = new AbortController();
      const call = memoryToolCall(
        "MemoryCreate",
        { text: "cancelled mutation", summary: "" },
        1,
      );
      const completion = create.execute(call.args, call, {
        signal: controller.signal,
      });
      await embeddings.started;
      controller.abort(new Error("cancel mutation"));
      expect(completion).rejects.toThrow("cancel mutation");
      const diagnostics = await waitForLogLines(fixture.paths.log, 1);
      expect(diagnostics[0]).toMatchObject({
        kind: "create",
        outcome: "skipped",
        reason: "memory_create_cancelled",
        memoryId: null,
      });
      expect(coordinator.listStoredMemories()).toEqual([]);
      coordinator.dispose();
    } finally {
      await fixture.cleanup();
    }
  });
});

function memoryToolCall(name: string, args: unknown, toolCallNumber: number): ToolCall {
  return {
    sessionId: "coordinator-session",
    turnId: "memory-mutation-turn-1",
    turnNumber: 1,
    iterationId: "memory-mutation-iteration-1",
    iterationNumber: 1,
    toolCallId: `memory-mutation-tool-${toolCallNumber}`,
    toolCallNumber,
    providerToolCallId: `provider-memory-mutation-${toolCallNumber}`,
    name,
    args,
  } as ToolCall;
}

function completedSnapshot(userContent: string): CompletedTurnSnapshot {
  return Object.freeze({
    messages: Object.freeze([
      Object.freeze({
        ordinal: 2,
        role: "user" as const,
        content: userContent,
      }),
      Object.freeze({
        ordinal: 3,
        role: "assistant" as const,
        content: "assistant content",
        reasoningContent: "assistant reasoning",
      }),
      Object.freeze({
        ordinal: 4,
        role: "tool" as const,
        name: "MemorySearch",
        content: "old derived memory",
      }),
      Object.freeze({
        ordinal: 5,
        role: "tool" as const,
        name: "MemoryGet",
        content: "old derived memory full record",
      }),
      Object.freeze({
        ordinal: 6,
        role: "tool" as const,
        name: "MemoryCreate",
        content: "new derived memory",
      }),
      Object.freeze({
        ordinal: 7,
        role: "tool" as const,
        name: "MemoryUpdate",
        content: "updated derived memory",
      }),
      Object.freeze({
        ordinal: 8,
        role: "tool" as const,
        name: "MemoryDelete",
        content: "deleted derived memory",
      }),
      Object.freeze({
        ordinal: 9,
        role: "tool" as const,
        name: "Read",
        content: "Read succeeded with verified output.",
      }),
    ]),
  });
}

async function createFixture() {
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "tinker-memory-coordinator-"));
  return {
    homeRoot,
    paths: resolveMemoryPaths(homeRoot),
    workspaceRoot: path.join(homeRoot, "workspace"),
    sessionId: "coordinator-session" as SessionId,
    cleanup: () => rm(homeRoot, { recursive: true }),
  };
}

function completedHookInput(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  content: string,
  turnId: string,
) {
  return {
    workspaceRoot: fixture.workspaceRoot,
    sessionId: fixture.sessionId,
    turnId: turnId as TurnId,
    snapshot: completedSnapshot(content),
  };
}

async function waitForLogKind(
  filePath: string,
  kind: string,
): Promise<Record<string, unknown>[]> {
  return waitFor(async () => {
    const diagnostics = await readDiagnostics(filePath);
    return diagnostics.some((entry) => entry.kind === kind) ? diagnostics : undefined;
  });
}

async function waitForLogLines(
  filePath: string,
  count: number,
): Promise<Record<string, unknown>[]> {
  return waitFor(async () => {
    const diagnostics = await readDiagnostics(filePath);
    return diagnostics.length >= count ? diagnostics : undefined;
  });
}

async function readDiagnostics(filePath: string): Promise<Record<string, unknown>[]> {
  const content = await readOptionalFile(filePath);
  return content.trim() === ""
    ? []
    : content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readOptionalFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for memory test state.");
}
