import type { ContextUsageSnapshot } from "../../agent/context-meter";
import type { RunAgentResult } from "../../agent/types";
import {
  type ContextCompactionResult,
  type ContextRetirementResult,
} from "../../context/context-manager";
import type { SessionId } from "../../ids/runtime-id";
import type { McpInventorySnapshot } from "../../mcp/mcp-manager";
import { TuiProjectionStore } from "../../tui/tui-projection-store";
import type {
  TuiSessionBinding,
  TuiSessionController,
} from "../../tui/tui-session-controller";
import { createTestRuntime, TEST_CONTEXT_BUDGET } from "../test-runtime";

export const testRuntime = createTestRuntime();

export const testBashGuard = Object.freeze({
  mode: "guard" as const,
  source: "default" as const,
});

export const testAskUser = Object.freeze({});

export function completedResult() {
  return {
    status: "completed" as const,
    finalText: "",
    lastIteration: testRuntime.iteration,
  };
}

export function createProjectionStore(): TuiProjectionStore {
  return new TuiProjectionStore({
    sessionId: "session-1",
    modelName: "model",
    workspaceRoot: "/tmp/tinker",
  });
}

export function createSessionController(
  projectionStore: TuiProjectionStore,
  run: (prompt: string, signal: AbortSignal) => Promise<RunAgentResult>,
  compact: () => Promise<ContextCompactionResult> = async () => {
    throw new Error("not used");
  },
  retire: () => Promise<ContextRetirementResult> = async () => {
    throw new Error("not used");
  },
  mcp: McpInventorySnapshot = { servers: [] },
): TuiSessionController {
  const binding: TuiSessionBinding = {
    sessionId: "session-1" as SessionId,
    modelName: "model",
    workspaceRoot: "/tmp/tinker",
    projectionStore,
    skills: () => ({ skills: [], shadowedNames: [] }),
    mcp: () => mcp,
    bashGuard: () => testBashGuard,
    subscribeBashGuard: () => () => undefined,
    setYoloMode: () => undefined,
    resolveBashConfirmation: async () => undefined,
    askUser: () => testAskUser,
    subscribeAskUser: () => () => undefined,
    resolveAskUser: async () => undefined,
    admitTurn: async (userMessage, signal) => ({
      turnId: testRuntime.turn.turnId,
      userMessage,
      completion: run(userMessage.content, signal),
    }),
    executeTurn: (userMessage, signal) => run(userMessage.content, signal),
  };
  return {
    getBinding: () => binding,
    subscribe: () => () => undefined,
    listSessions: async () => [],
    compact,
    retire,
    undo: async () => ({ status: "nothing" }),
    fork: async () => {
      throw new Error("not used");
    },
    clear: async () => {
      throw new Error("not used");
    },
    resume: async () => {
      throw new Error("not used");
    },
    delete: async () => {
      throw new Error("not used");
    },
    switchModel: async () => {
      throw new Error("not used");
    },
  };
}

export async function submitInput(
  stdin: { write: (data: string) => void },
  value: string,
) {
  stdin.write(value);
  await Bun.sleep(15);
  stdin.write("\r");
}

export async function writeInputUntilFrame(
  stdin: { write: (data: string) => void },
  input: string,
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate(lastFrame() ?? "")) {
      return;
    }

    // A rendered overlay can precede its useInput subscription on a loaded runner.
    // Retry the input instead of depending on one event that may arrive too early.
    stdin.write(input);
    await Bun.sleep(25);
  }

  throw new Error(`Timed out waiting for ${description}. Last frame:\n${lastFrame()}`);
}

export async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate(lastFrame() ?? "")) {
      return;
    }
    await Bun.sleep(25);
  }

  throw new Error(`Timed out waiting for ${description}. Last frame:\n${lastFrame()}`);
}

export function contextSnapshot(
  overrides: Partial<ContextUsageSnapshot> = {},
): ContextUsageSnapshot {
  return {
    usedInputTokens: 10_000,
    source: "estimated_full",
    pressure: "normal",
    inputBudgetTokens: TEST_CONTEXT_BUDGET.inputBudgetTokens,
    triggerTokens: TEST_CONTEXT_BUDGET.triggerTokens,
    triggerRatio: TEST_CONTEXT_BUDGET.triggerRatio,
    requestMaxOutputTokens: TEST_CONTEXT_BUDGET.requestMaxOutputTokens,
    correctionFactor: 1.25,
    calibrationSampleCount: 0,
    prefixHash: "a".repeat(64),
    requestConfigHash: "b".repeat(64),
    toolSchemaHash: "c".repeat(64),
    ...overrides,
  };
}
