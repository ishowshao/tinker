import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ToolCall } from "../agent/types";
import type { MemoryEmbeddingClient } from "../memory/embedding-client";
import { MemoryCoordinator } from "../memory/memory-coordinator";
import { ObservationBuilder } from "../observation/observation-builder";
import {
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

describe("MemoryCoordinator mutations", () => {
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
