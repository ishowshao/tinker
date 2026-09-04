import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ObservationBuilder } from "../observation/observation-builder";
import { decodeStoredToolRawResult } from "../session/session-store";
import { createDefaultTooling } from "./helpers/tools-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

describe("UpdatePlan tool", () => {
  test("registers a bounded complete-snapshot schema", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-plan-tool-"));
    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const definition = tooling.registry
        .definitions()
        .find((candidate) => candidate.name === "UpdatePlan");
      expect(definition).toBeDefined();
      expect(definition?.parameters).toMatchObject({
        additionalProperties: false,
        required: ["plan"],
        properties: {
          explanation: { type: "string", maxLength: 500 },
          plan: { type: "array", maxItems: 12 },
        },
      });
      await tooling.dispose();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("normalizes and returns a plan snapshot for persistence and presentation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-plan-tool-"));
    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "provider-plan-1",
        name: "UpdatePlan",
        args: {
          explanation: "  Refined after inspection.  ",
          plan: [
            { step: "  Inspect implementation  ", status: "completed" },
            { step: "Add coverage", status: "in_progress" },
            { step: "Run checks", status: "pending" },
          ],
        },
      });

      expect(raw).toEqual({
        kind: "update_plan",
        ok: true,
        explanation: "Refined after inspection.",
        plan: [
          { step: "Inspect implementation", status: "completed" },
          { step: "Add coverage", status: "in_progress" },
          { step: "Run checks", status: "pending" },
        ],
      });
      expect(
        new ObservationBuilder().build({
          call: tooling.testRuntime.toolCall({
            providerToolCallId: "provider-plan-observation",
            name: "UpdatePlan",
            args: {},
          }),
          raw,
        }),
      ).toMatchObject({
        content: [{ type: "text", text: "Plan updated." }],
        displayText: "Plan updated.",
      });
      expect(decodeStoredToolRawResult(JSON.parse(JSON.stringify(raw)))).toEqual(raw);
      await tooling.dispose();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects multiple in-progress steps", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-plan-tool-"));
    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "provider-plan-invalid",
        name: "UpdatePlan",
        args: {
          plan: [
            { step: "First", status: "in_progress" },
            { step: "Second", status: "in_progress" },
          ],
        },
      });

      expect(raw).toEqual({
        kind: "update_plan",
        ok: false,
        error: "UpdatePlan allows at most one in_progress step.",
      });
      expect(
        new ObservationBuilder().build({
          call: tooling.testRuntime.toolCall({
            providerToolCallId: "provider-plan-failure-observation",
            name: "UpdatePlan",
            args: {},
          }),
          raw,
        }).displayText,
      ).toContain("UpdatePlan failed");
      await tooling.dispose();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});
