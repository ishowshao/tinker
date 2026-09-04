import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../tools/registry";
import { defineToolExecutor } from "../tools/types";
import { createDefaultTooling } from "./helpers/tools-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

describe("ToolRegistry", () => {
  test("rejects duplicate names with both registration sources", () => {
    const registry = new ToolRegistry();
    const executor = defineToolExecutor("generic", {
      definition: {
        name: "Duplicate",
        description: "duplicate test tool",
        parameters: { type: "object", properties: {} },
      },
      async execute() {
        return { ok: false, toolName: "Duplicate", error: "not executed" };
      },
    });

    registry.register(executor, "test-source-a");
    expect(() => registry.register(executor, "test-source-b")).toThrow(
      "Tool Duplicate from test-source-b conflicts with an existing registration from test-source-a",
    );
  });

  test("registers MemorySearch only when composition supplies its executor", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-memory-tool-"));
    const memorySearch = defineToolExecutor("memory_search", {
      definition: {
        name: "MemorySearch",
        description: "test memory search",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      async execute() {
        return { ok: true, degraded: null, matches: [] };
      },
    });
    try {
      const withoutMemory = createDefaultTooling({ workspaceRoot: workspace });
      expect(
        withoutMemory.registry
          .definitions()
          .some((definition) => definition.name === "MemorySearch"),
      ).toBe(false);
      await withoutMemory.dispose();

      const withMemory = createDefaultTooling({
        workspaceRoot: workspace,
        memorySearch,
      });
      expect(
        withMemory.registry
          .definitions()
          .some((definition) => definition.name === "MemorySearch"),
      ).toBe(true);
      await withMemory.dispose();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("registers MemoryGet only when composition supplies its executor", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-memory-tool-"));
    const memoryGet = defineToolExecutor("memory_get", {
      definition: {
        name: "MemoryGet",
        description: "test memory get",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      async execute() {
        return { ok: true, memory: null };
      },
    });
    try {
      const withoutMemory = createDefaultTooling({ workspaceRoot: workspace });
      expect(
        withoutMemory.registry
          .definitions()
          .some((definition) => definition.name === "MemoryGet"),
      ).toBe(false);
      await withoutMemory.dispose();

      const withMemory = createDefaultTooling({
        workspaceRoot: workspace,
        memoryGet,
      });
      expect(
        withMemory.registry
          .definitions()
          .some((definition) => definition.name === "MemoryGet"),
      ).toBe(true);
      await withMemory.dispose();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("registers memory mutation tools only when the TUI composition supplies them", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-memory-tool-"));
    const memoryCreate = defineToolExecutor("memory_create", {
      definition: {
        name: "MemoryCreate",
        description: "test memory create",
        parameters: { type: "object", properties: {} },
      },
      async execute() {
        return {
          ok: true,
          status: "created" as const,
          memoryId: "memory-1",
          createdAt: "2026-09-03T10:00:00.000Z",
        };
      },
    });
    const memoryUpdate = defineToolExecutor("memory_update", {
      definition: {
        name: "MemoryUpdate",
        description: "test memory update",
        parameters: { type: "object", properties: {} },
      },
      async execute() {
        return {
          ok: true,
          status: "updated" as const,
          memoryId: "memory-1",
        };
      },
    });
    const memoryDelete = defineToolExecutor("memory_delete", {
      definition: {
        name: "MemoryDelete",
        description: "test memory delete",
        parameters: { type: "object", properties: {} },
      },
      async execute() {
        return {
          ok: true,
          status: "deleted" as const,
          memoryId: "memory-1",
        };
      },
    });
    try {
      const withoutMemory = createDefaultTooling({ workspaceRoot: workspace });
      expect(
        withoutMemory.registry
          .definitions()
          .filter((definition) =>
            ["MemoryCreate", "MemoryUpdate", "MemoryDelete"].includes(definition.name),
          ),
      ).toEqual([]);
      await withoutMemory.dispose();

      const withMemory = createDefaultTooling({
        workspaceRoot: workspace,
        memoryCreate,
        memoryUpdate,
        memoryDelete,
      });
      expect(
        withMemory.registry
          .definitions()
          .map((definition) => definition.name)
          .filter((name) => name.startsWith("Memory")),
      ).toEqual(["MemoryCreate", "MemoryUpdate", "MemoryDelete"]);
      await withMemory.dispose();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});
