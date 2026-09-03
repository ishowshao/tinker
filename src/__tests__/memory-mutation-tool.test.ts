import { describe, expect, test } from "bun:test";
import type { ToolCall } from "../agent/types";
import {
  MEMORY_CREATE_TOOL_DEFINITION,
  createMemoryCreateToolExecutor,
} from "../memory/memory-create-tool";
import {
  MEMORY_DELETE_TOOL_DEFINITION,
  createMemoryDeleteToolExecutor,
} from "../memory/memory-delete-tool";
import {
  MEMORY_UPDATE_TOOL_DEFINITION,
  createMemoryUpdateToolExecutor,
} from "../memory/memory-update-tool";
import { decodeStoredToolRawResult } from "../session/session-store";
import type { ToolRawResult } from "../tools/types";

describe("memory mutation tool contracts", () => {
  test("publishes the bounded create, update, and delete schemas", () => {
    expect(MEMORY_CREATE_TOOL_DEFINITION).toMatchObject({
      name: "MemoryCreate",
      parameters: {
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 512 },
          summary: { type: "string", maxLength: 4096 },
        },
      },
    });
    expect(MEMORY_UPDATE_TOOL_DEFINITION).toMatchObject({
      name: "MemoryUpdate",
      parameters: {
        additionalProperties: false,
        required: ["id", "text", "summary"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
          text: { type: "string", minLength: 1, maxLength: 512 },
          summary: { type: "string", maxLength: 4096 },
        },
      },
    });
    expect(MEMORY_DELETE_TOOL_DEFINITION).toMatchObject({
      name: "MemoryDelete",
      parameters: {
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
      },
    });
  });

  test("trims valid create arguments, defaults summary, and rejects invalid bytes", async () => {
    const accepted: Array<{ text: string; summary: string }> = [];
    let invalidCalls = 0;
    const executor = createMemoryCreateToolExecutor({
      async create(text, summary) {
        accepted.push({ text, summary });
        return {
          ok: true,
          status: "created",
          memoryId: "memory-1",
          createdAt: "2026-09-03T10:00:00.000Z",
        };
      },
      async recordInvalidCall() {
        invalidCalls += 1;
      },
    });
    const signal = new AbortController().signal;

    expect(
      await executor.execute(
        { text: "  searchable index  " },
        toolCall("MemoryCreate", 1),
        { signal },
      ),
    ).toMatchObject({ kind: "memory_create", ok: true });
    expect(accepted).toEqual([{ text: "searchable index", summary: "" }]);

    for (const [index, args] of [
      { text: "" },
      { text: "记".repeat(171) },
      { text: "valid", summary: "记".repeat(1_366) },
      { text: "valid", unexpected: true },
    ].entries()) {
      expect(
        await executor.execute(args, toolCall("MemoryCreate", index + 2), {
          signal,
        }),
      ).toMatchObject({ kind: "memory_create", ok: false });
    }
    expect(accepted).toHaveLength(1);
    expect(invalidCalls).toBe(4);
  });

  test("requires complete replacement update arguments and a bounded delete id", async () => {
    const updates: Array<{ id: string; text: string; summary: string }> = [];
    const deletes: string[] = [];
    let invalidUpdates = 0;
    let invalidDeletes = 0;
    const update = createMemoryUpdateToolExecutor({
      async update(id, text, summary) {
        updates.push({ id, text, summary });
        return { ok: true, status: "updated", memoryId: id };
      },
      async recordInvalidCall() {
        invalidUpdates += 1;
      },
    });
    const remove = createMemoryDeleteToolExecutor({
      async delete(id) {
        deletes.push(id);
        return { ok: true, status: "deleted", memoryId: id };
      },
      async recordInvalidCall() {
        invalidDeletes += 1;
      },
    });
    const signal = new AbortController().signal;

    await update.execute(
      { id: " memory-1 ", text: " replacement ", summary: " details " },
      toolCall("MemoryUpdate", 1),
      { signal },
    );
    expect(updates).toEqual([
      { id: "memory-1", text: "replacement", summary: "details" },
    ]);
    for (const [index, args] of [
      { id: "memory-1", text: "replacement" },
      { id: "x".repeat(65), text: "replacement", summary: "" },
      { id: "memory-1", text: "", summary: "" },
      { id: "memory-1", text: "replacement", summary: 1 },
    ].entries()) {
      expect(
        await update.execute(args, toolCall("MemoryUpdate", index + 2), {
          signal,
        }),
      ).toMatchObject({ kind: "memory_update", ok: false });
    }

    await remove.execute({ id: " memory-1 " }, toolCall("MemoryDelete", 6), { signal });
    expect(deletes).toEqual(["memory-1"]);
    for (const [index, args] of [
      { id: "" },
      { id: "x".repeat(65) },
      { id: "memory-1", unexpected: true },
    ].entries()) {
      expect(
        await remove.execute(args, toolCall("MemoryDelete", index + 7), {
          signal,
        }),
      ).toMatchObject({ kind: "memory_delete", ok: false });
    }
    expect(invalidUpdates).toBe(4);
    expect(invalidDeletes).toBe(3);
  });

  test("round-trips every mutation result kind through session persistence", () => {
    const values: ToolRawResult[] = [
      {
        kind: "memory_create",
        ok: true,
        status: "already_exists",
        memoryId: "memory-1",
        createdAt: "2026-09-03T10:00:00.000Z",
      },
      {
        kind: "memory_update",
        ok: false,
        code: "memory_duplicate",
        conflictMemoryId: "memory-2",
        error: "duplicate",
      },
      {
        kind: "memory_delete",
        ok: false,
        code: "memory_not_found",
        error: "not found",
      },
    ];
    for (const value of values) {
      expect(decodeStoredToolRawResult(JSON.parse(JSON.stringify(value)))).toEqual(
        value,
      );
    }
  });
});

function toolCall(name: string, toolCallNumber: number): ToolCall {
  return {
    sessionId: "session",
    turnId: "turn",
    turnNumber: 1,
    iterationId: "iteration",
    iterationNumber: 1,
    toolCallId: `tool-${toolCallNumber}`,
    toolCallNumber,
    providerToolCallId: `provider-${toolCallNumber}`,
    name,
    args: {},
  } as ToolCall;
}
