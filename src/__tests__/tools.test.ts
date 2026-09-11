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

  test("registers text memory tools without configuration", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-memory-tool-"));
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      homeRoot: workspace,
    });
    try {
      expect(
        tooling.registry
          .definitions()
          .map((tool) => tool.name)
          .filter((name) => name.startsWith("Memory")),
      ).toEqual(["MemorySearch", "MemoryCreate"]);
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });
});
