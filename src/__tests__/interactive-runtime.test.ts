import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildInteractiveRuntimeInput,
  createInteractiveRuntimeSession,
} from "../cli/interactive-runtime";
import type { RunnerConfig } from "../cli/config";
import { DEFAULT_PUBLIC_TOOLING_CONFIG } from "../cli/public-config-contract";
import { createUuidV7 } from "../ids/uuid-v7";
import { parseSessionId } from "../ids/runtime-id";
import { createHostedRuntimeFactory } from "../cli/serve-runtime";
import type { ManagedSessionRecord } from "../remote/service-store";
import type { AgentEvent } from "../events/types";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";
import { TEST_CONTEXT_BUDGET, TEST_CONTEXT_PROFILE } from "./test-runtime";

const homeRoot = isolateTinkerHome();

describe("interactive runtime composition", () => {
  test("hosted entry resolves workspace config and reopens the same database", async () => {
    const workspaceRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "tinker-hosted-compose-")),
    );
    const record: ManagedSessionRecord = {
      id: createUuidV7(),
      workspaceId: "workspace",
      workspacePath: workspaceRoot,
      title: "Composition test",
      modelName: "",
      owner: "service",
      status: "accepted",
      updatedAt: new Date().toISOString(),
      initialized: false,
    };
    const factory = createHostedRuntimeFactory(
      [{ id: "workspace", name: "Workspace", path: workspaceRoot }],
      {
        TINKER_MODEL: "test-model",
        TINKER_API_KEY: "test-key",
        TINKER_BASE_URL: "https://example.test/v1",
        TINKER_CONTEXT_WINDOW_TOKENS: "262144",
        TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: "65536",
        TINKER_TEST_FAKE_MODEL: "pty-echo-history",
      },
      homeRoot(),
    );
    const sink = {
      append: async () => {},
      updateAssistantTextDelta: () => {},
    };
    let opened;
    try {
      opened = await factory({ record, sink });
      expect(opened.modelName).toBe("test-model");
      const databasePath = opened.databasePath;
      for (const prompt of ["PTY_FIRST", "PTY_SECOND"]) {
        if (prompt === "PTY_SECOND") {
          await opened.runtime.dispose({ type: "session_switch" });
          opened = await factory({
            record: { ...record, initialized: true },
            sink,
          });
          expect(opened.runtime.resumed).toBe(true);
          expect(opened.databasePath).toBe(databasePath);
        }
        expect(
          (
            await opened.runtime.executeTurn({
              userMessage: { role: "user", content: prompt },
              signal: new AbortController().signal,
            })
          ).status,
        ).toBe("completed");
      }
    } finally {
      await opened?.runtime.dispose({ type: "tui_exit" });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test.each([
    "local-tui",
    "service",
  ] as const)("%s preserves capabilities and resumes canonical history with fresh instructions", async (owner) => {
    const workspaceRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "tinker-compose-")),
    );
    const sessionId = parseSessionId(createUuidV7());
    const config: RunnerConfig = {
      workspaceRoot,
      sessionId,
      api: "chat-completions",
      apiKey: "test-key",
      apiBase: "https://example.test/v1",
      modelName: "test-model",
      maxIterations: 8,
      includeReasoningContent: false,
      stream: true,
      contextProfile: TEST_CONTEXT_PROFILE,
      contextBudget: TEST_CONTEXT_BUDGET,
      inputModalities: ["text"],
      toolResultModalities: ["text"],
      bashGuardMode: "guard",
      bashGuardSource: "environment",
      reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "low" },
    };
    const events: AgentEvent[] = [];
    const sink = {
      append: async (event: AgentEvent) => {
        events.push(event);
      },
      updateAssistantTextDelta: () => {},
    };
    const common = {
      config,
      workspaceRoot,
      homeRoot: homeRoot(),
      toolingConfig: DEFAULT_PUBLIC_TOOLING_CONFIG,
      env: { TINKER_TEST_FAKE_MODEL: "pty-echo-history" },
      sink,
      owner,
    };
    let runtime;
    try {
      await writeFile(path.join(workspaceRoot, "AGENTS.md"), "COMPOSITION_FIRST");
      const input = await buildInteractiveRuntimeInput({
        ...common,
        selection: { mode: "new", sessionId },
      });
      expect(input.systemPrompt).toContain("COMPOSITION_FIRST");
      expect(input.enableTurnUndo).toBe(owner === "local-tui");
      expect(input.enableProviderRetryPrompt).toBe(owner === "local-tui");
      expect(input.enableAskUser).toBe(true);
      expect(input.bashGuard).toEqual({
        mode: "guard",
        source: "environment",
        surface: "tui",
      });
      expect(input.presentationSinks).toEqual([sink]);
      expect(input.assistantTextDeltaSink).toBe(sink);
      expect(input.homeRoot).toBe(homeRoot());

      runtime = await createInteractiveRuntimeSession({
        ...common,
        selection: { mode: "new", sessionId },
      });
      expect(runtime.resumed).toBe(false);
      runtime.setReasoningEffort("high");
      expect(runtime.reasoningEffort()?.effort).toBe("high");
      expect(
        (
          await runtime.executeTurn({
            userMessage: { role: "user", content: "PTY_FIRST" },
            signal: new AbortController().signal,
          })
        ).status,
      ).toBe("completed");
      expect(events.length).toBeGreaterThan(0);
      await runtime.dispose({ type: "session_switch" });
      runtime = undefined;

      await writeFile(path.join(workspaceRoot, "AGENTS.md"), "COMPOSITION_SECOND");
      const resumedInput = await buildInteractiveRuntimeInput({
        ...common,
        selection: { mode: "resume", sessionId },
      });
      expect(resumedInput.systemPrompt).toContain("COMPOSITION_SECOND");
      expect(resumedInput.systemPrompt).not.toContain("COMPOSITION_FIRST");
      runtime = await createInteractiveRuntimeSession({
        ...common,
        selection: { mode: "resume", sessionId },
      });
      expect(runtime.resumed).toBe(true);
      expect(runtime.reasoningEffort()?.effort).toBe("low");
      // The fake model rejects PTY_SECOND unless the first turn was recovered.
      expect(
        (
          await runtime.executeTurn({
            userMessage: { role: "user", content: "PTY_SECOND" },
            signal: new AbortController().signal,
          })
        ).status,
      ).toBe("completed");
    } finally {
      await runtime?.dispose({ type: "tui_exit" });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
