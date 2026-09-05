import { describe, expect, test } from "bun:test";
import { assertContextMaintenanceCapabilities } from "../agent/runtime-context-capabilities";
import { assertPreparedMatchesSurface } from "../agent/runtime-context-events";
import { DEFAULT_CONTEXT_AUTOMATION_POLICY } from "../context/context-automation-policy";
import { createContextSurface } from "../context/context-surface";
import { CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION } from "../context/recall-retirement-contract";
import { runtimeIdFactory } from "../ids/runtime-id";
import { RECALL_TOOL_DEFINITIONS } from "../tools/recall";
import { ToolRegistry } from "../tools/registry";
import { prepareTestModelRequest } from "./test-runtime";

function registryWithout(missing?: string) {
  const registry = new ToolRegistry();
  for (const definition of RECALL_TOOL_DEFINITIONS) {
    if (definition.name !== missing)
      registry.register({
        definition,
        execute: async () => {
          throw new Error("Capability test must not execute tools.");
        },
      });
  }
  return registry;
}

describe("context automation product policy", () => {
  test("has frozen defaults without model, evaluation, report or surface inputs", () => {
    expect(DEFAULT_CONTEXT_AUTOMATION_POLICY).toEqual({
      policyId: "context-automation-v1",
      automaticSwap: true,
      automaticPrefixRetirement: true,
    });
    expect(Object.isFrozen(DEFAULT_CONTEXT_AUTOMATION_POLICY)).toBe(true);
  });

  test.each([
    "RecallSearch",
    "RecallGet",
  ])("rejects missing executable %s independently of product defaults", (name) => {
    expect(() =>
      assertContextMaintenanceCapabilities(
        registryWithout(name),
        CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
      ),
    ).toThrow(`requires an executable ${name}`);
    expect(DEFAULT_CONTEXT_AUTOMATION_POLICY.automaticSwap).toBe(true);
  });

  test("rejects incompatible contracts without consulting evaluation evidence", () => {
    expect(() =>
      assertContextMaintenanceCapabilities(registryWithout(), "recall-retirement-v1"),
    ).toThrow("requires the current Recall retirement contract");
    expect(() =>
      assertContextMaintenanceCapabilities(
        registryWithout(),
        CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
      ),
    ).not.toThrow();
  });

  test("allows updated descriptions with a refreshed surface but still rejects request drift", () => {
    const tools = RECALL_TOOL_DEFINITIONS.map((tool) => ({
      ...tool,
      description: "Updated description.",
    }));
    const prepared = prepareTestModelRequest({
      messages: [{ role: "system", content: "system" }],
      tools,
    });
    const surface = createContextSurface({
      surfaceId: runtimeIdFactory.createContextSurfaceId(),
      sessionId: runtimeIdFactory.createSessionId(),
      systemPrompt: "system",
      recallContractVersion: CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
      toolDefinitions: tools,
      prepared,
      createdAt: "2026-09-05T00:00:00.000Z",
    });
    expect(() => assertPreparedMatchesSurface(prepared, surface)).not.toThrow();
    const stale = prepareTestModelRequest({
      messages: [{ role: "system", content: "system" }],
      tools: [...RECALL_TOOL_DEFINITIONS],
    });
    expect(() => assertPreparedMatchesSurface(stale, surface)).toThrow(
      "does not match its context surface",
    );
  });
});
