import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  MemoryCoordinator,
} from "../memory/memory-coordinator";
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
        memories: [`memory from extraction ${this.inputs.length}`],
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
  test("keeps full text evidence and filters only MemorySearch observations", () => {
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

describe("MemoryCoordinator", () => {
  test("extracts, batches embeddings, persists, searches, and writes content-free diagnostics", async () => {
    const fixture = await createFixture();
    const model = new QueueExtractionModel([
      JSON.stringify({
        memories: [
          "Tinker source changes require bun run check.",
          "The user prefers strict fail-fast configuration.",
        ],
      }),
    ]);
    const embeddings = new RecordingEmbeddingClient((input) =>
      input.includes("fail-fast") ? [0, 1, 0] : [1, 0, 0],
    );
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
        "Tinker source changes require bun run check.",
        "The user prefers strict fail-fast configuration.",
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
      expect(raw.matches).toHaveLength(2);
      const observation = new ObservationBuilder().build({
        call: {} as ToolCall,
        raw,
      }).displayText;
      expect(observation).toContain("derived memories");
      expect(observation).toContain("may be stale or wrong");
      expect(observation).toContain(fixture.workspaceRoot);

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

      await waitForLogLines(fixture.paths.log, 3);
      const diagnosticText = await readFile(fixture.paths.log, "utf8");
      expect(diagnosticText).not.toContain("What checks does Tinker require?");
      expect(diagnosticText).not.toContain(
        "Tinker source changes require bun run check.",
      );
      const diagnostics = diagnosticText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(diagnostics.map((entry) => entry.kind)).toEqual([
        "extraction",
        "search",
        "search",
      ]);
      expect(diagnostics[0]).toMatchObject({
        outcome: "ok",
        returned: 2,
        written: 2,
        rejected: { duplicate: 0, secret: 0, invalid: 0, embedding: 0 },
      });
      expect(diagnostics[1]).toMatchObject({
        outcome: "ok",
        returned: 2,
      });
      expect(diagnostics[2]).toMatchObject({
        outcome: "failed",
        reason: "memory_search_args_invalid",
      });
      const extractedText = await readFile(fixture.paths.extractedLog, "utf8");
      expect(extractedText).toContain(
        `[2026-07-25T10:00:00.000Z] workspace=${JSON.stringify(fixture.workspaceRoot)} turn=coordinator-turn-1 written=2`,
      );
      expect(extractedText).toContain('"Tinker source changes require bun run check."');
      expect(extractedText).toContain(
        '"The user prefers strict fail-fast configuration."',
      );
      expect(extractedText.match(/^- /gm)).toHaveLength(2);
      expect((await stat(fixture.paths.extractedLog)).mode & 0o777).toBe(0o600);

      coordinator.dispose();
      const reopened = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      expect(reopened.count()).toBe(2);
      reopened.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects secrets before embedding and skips the request when none remain", async () => {
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
              memories: ["The deployment password=supersecretvalue"],
            }),
          ]),
        createEmbeddingClient: () => embeddings,
      });
      coordinator.enqueue({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
        turnId: "secret-turn" as TurnId,
        snapshot: completedSnapshot("secret evidence"),
      });
      const [diagnostic] = await waitForLogKind(fixture.paths.log, "extraction");
      expect(embeddings.calls).toHaveLength(0);
      expect(diagnostic).toMatchObject({
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

  test("logs only newly inserted memories when later extraction is a duplicate", async () => {
    const fixture = await createFixture();
    const memory = "Tinker uses bun run check as its source-change gate.";
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () =>
          new QueueExtractionModel([
            JSON.stringify({ memories: [memory] }),
            JSON.stringify({ memories: [memory] }),
          ]),
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

  test("does not partially write when one vector in a batch is invalid", async () => {
    const fixture = await createFixture();
    const embeddings = new RecordingEmbeddingClient((input) =>
      input === "second candidate" ? [1, 0] : [1, 0, 0],
    );
    try {
      const coordinator = await MemoryCoordinator.create({
        paths: fixture.paths,
        embedding: EMBEDDING,
        extractionContextBudget: TEST_CONTEXT_BUDGET,
        createExtractionClient: () =>
          new QueueExtractionModel([
            JSON.stringify({
              memories: ["first candidate", "second candidate"],
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
        rejected: { embedding: 2 },
      });
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

  test("keeps one active and replaces the single pending task with the latest", async () => {
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

      await waitForLogLines(fixture.paths.log, 2);
      expect(model.inputs).toHaveLength(2);
      expect(model.inputs[0]?.messages[1]?.content).toContain("first");
      expect(model.inputs[1]?.messages[1]?.content).toContain("third");
      expect(model.inputs[1]?.messages[1]?.content).not.toContain("second");
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
