import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import type { ToolCall } from "../agent/types";
import type { TurnId } from "../ids/runtime-id";
import {
  buildExtractionEvidenceText,
  containsSensitiveMemory,
  MemoryCoordinator,
} from "../memory/memory-coordinator";
import { MemoryStore } from "../memory/memory-store";
import type {
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { ObservationBuilder } from "../observation/observation-builder";
import {
  completedHookInput,
  completedSnapshot,
  createFixture,
  EMBEDDING,
  QueueExtractionModel,
  readDiagnostics,
  readOptionalFile,
  RecordingEmbeddingClient,
  waitForLogKind,
  waitForLogLines,
} from "./helpers/memory-coordinator-support";
import {
  TEST_CONTEXT_BUDGET,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

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

describe("MemoryCoordinator extraction and queue", () => {
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
});
