import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { RunAgentResult } from "../agent/types";
import type { ModelProfile, ModelProfiles } from "../cli/model-profiles";
import { parseModelProfiles } from "../cli/model-profiles";
import type { SessionId } from "../ids/runtime-id";
import { runtimeIdFactory } from "../ids/runtime-id";
import { ContextBudgetExceededError } from "../model/model-request-preflight";
import { RuntimeReasoningEffort } from "../model/reasoning-effort";
import type { SessionSummary } from "../session/session-catalog";
import { App } from "../tui/app";
import { TuiProjectionStore } from "../tui/tui-projection-store";
import type { TuiSessionController } from "../tui/tui-session-controller";
import type { ViewFile } from "../tui/view-file";
import {
  completedResult,
  contextSnapshot,
  createProjectionStore,
  createSessionController,
  submitInput,
  testRuntime,
  waitForFrame,
  writeInputUntilFrame,
} from "./helpers/tui-components-support";
import { TEST_CONTEXT_BUDGET, TEST_CONTEXT_PROFILE } from "./test-runtime";

function promptProjection(text: string) {
  return { version: 1 as const, text, images: [], omittedImageCount: 0 };
}

const TEST_PROFILES_JSON = JSON.stringify({
  default: "deepseek",
  profiles: {
    deepseek: {
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com/v1",
      apiKey: "sk-deepseek",
      contextWindowTokens: 256 * 1024,
      maxSupportedOutputTokens: 64 * 1024,
      reasoning: {
        supportedEfforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
    },
    gpt4o: {
      model: "gpt-4o",
      apiBase: "https://api.openai.com/v1",
      apiKey: "sk-openai",
      contextWindowTokens: 256 * 1024,
      maxSupportedOutputTokens: 64 * 1024,
    },
  },
});

const TEST_PROFILES: ModelProfiles = parseModelProfiles(
  TEST_PROFILES_JSON,
  "/test/models.json",
);

function createSessionControllerWithProfiles(
  projectionStore: TuiProjectionStore,
  run: (prompt: string, signal: AbortSignal) => Promise<RunAgentResult>,
  switchModel: (profile: ModelProfile) => Promise<void>,
): TuiSessionController {
  const base = createSessionController(projectionStore, run);
  const baseBinding = base.getBinding();
  const reasoningConfig = TEST_PROFILES.profiles.get("deepseek")?.reasoning;
  if (reasoningConfig === undefined) {
    throw new Error("Expected reasoning config for the deepseek test profile.");
  }
  const reasoningEffort = new RuntimeReasoningEffort(reasoningConfig);
  const profileBinding = {
    ...baseBinding,
    profileName: "deepseek",
    reasoningEffort: () => reasoningEffort.snapshot(),
    setReasoningEffort: (effort: string) => reasoningEffort.set(effort),
    resetReasoningEffort: () => reasoningEffort.reset(),
  };
  return {
    ...base,
    switchModel,
    getBinding: () => profileBinding,
  };
}

describe("TUI session interactions", () => {
  test("shows a running spinner during the turn and the worked duration when it finishes", async () => {
    const projectionStore = createProjectionStore();
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    await projectionStore.append({
      ...testRuntime.turn,
      type: "turn.started",
      eventSequence: 1,
      timestamp: startedAt,
      data: { userPrompt: promptProjection("counting prompt") },
    });
    const { lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(projectionStore, async () =>
          completedResult(),
        )}
      />,
    );

    await waitForFrame(
      lastFrame,
      (frame) => frame.includes("Running"),
      "the running footer",
    );
    expect(lastFrame()).not.toMatch(/Running \d/);

    await projectionStore.append({
      ...testRuntime.turn,
      type: "turn.finished",
      eventSequence: 2,
      timestamp: new Date(Date.parse(startedAt) + 9_000).toISOString(),
      data: {
        status: "completed",
        finalText: "done",
        lastIteration: testRuntime.iteration,
        messageCount: 2,
      },
    });
    await waitForFrame(
      lastFrame,
      (frame) => frame.includes("Worked for 9s"),
      "the finished footer",
    );
    expect(lastFrame()).not.toContain("Running");
    cleanup();
  });

  test("shows an admission budget error thrown before a run promise exists", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(createProjectionStore(), () => {
          throw new ContextBudgetExceededError({
            projectedInputTokens: 220_000,
            source: "estimated_full",
            contextWindowTokens: TEST_CONTEXT_BUDGET.contextWindowTokens,
            inputBudgetTokens: TEST_CONTEXT_BUDGET.inputBudgetTokens,
            requestMaxOutputTokens: TEST_CONTEXT_BUDGET.requestMaxOutputTokens,
            triggerTokens: TEST_CONTEXT_BUDGET.triggerTokens,
          });
        })}
      />,
    );

    await submitInput(stdin, "oversized prompt");
    await Bun.sleep(25);
    expect(lastFrame()).toContain("Model request blocked before provider call");
    expect(lastFrame()).toContain("input budget 192K");
    cleanup();
  });

  test("refreshes the Git branch after each completed turn", async () => {
    const branches = ["main", "feature/refreshed-branch"];
    let branchReads = 0;
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(createProjectionStore(), async () =>
          completedResult(),
        )}
        readGitBranch={async () => branches[branchReads++]}
      />,
    );

    await Bun.sleep(25);
    expect(lastFrame()).toContain("model · /tmp/tinker · main");

    await submitInput(stdin, "refresh branch");
    await Bun.sleep(50);

    expect(branchReads).toBe(2);
    expect(lastFrame()).toContain("model · /tmp/tinker · feature/refreshed-branch");
    cleanup();
  });

  test("uses local cancelling feedback until turn.cancelled arrives", async () => {
    const projectionStore = createProjectionStore();
    let abortCount = 0;
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(
          projectionStore,
          async (prompt, signal) => {
            await projectionStore.append({
              type: "turn.started",
              ...testRuntime.turn,
              eventSequence: 1,
              timestamp: "2026-07-10T00:00:00.000Z",
              data: { userPrompt: promptProjection(prompt) },
            });
            await projectionStore.append({
              type: "model.request.started",
              ...testRuntime.iteration,
              eventSequence: 2,
              timestamp: "2026-07-10T00:00:00.100Z",
              data: { attemptNumber: 1, maxAttempts: 2 },
            });

            return await new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  abortCount += 1;
                  setTimeout(() => {
                    void projectionStore
                      .append({
                        type: "turn.cancelled",
                        ...testRuntime.iteration,
                        eventSequence: 3,
                        timestamp: "2026-07-10T00:00:01.000Z",
                        data: {
                          cancellation: {
                            source: "user",
                            phase: "model_request",
                            iterationId: testRuntime.iteration.iterationId,
                            iterationNumber: 1,
                          },
                        },
                      })
                      .then(() =>
                        resolve({
                          status: "cancelled" as const,
                          cancellation: {
                            source: "user" as const,
                            phase: "model_request" as const,
                            iterationId: testRuntime.iteration.iterationId,
                            iterationNumber: 1,
                          },
                          lastIteration: testRuntime.iteration,
                        }),
                      );
                  }, 250);
                },
                { once: true },
              );
            });
          },
        )}
      />,
    );

    await submitInput(stdin, "wait");
    await writeInputUntilFrame(
      stdin,
      "\u001b",
      lastFrame,
      (frame) => frame.includes("cancelling"),
      "local cancellation feedback",
    );
    expect(abortCount).toBe(1);

    await waitForFrame(
      lastFrame,
      (frame) =>
        frame.includes("cancelled") && !frame.includes("Cancelling current turn..."),
      "the cancelled turn event",
    );
    expect(lastFrame()).not.toContain("Cancelling current turn...");

    await Bun.sleep(100);
    await submitInput(stdin, "/nope");
    await waitForFrame(
      lastFrame,
      (frame) => frame.includes("Unknown command: /nope"),
      "the next prompt to be handled",
    );
    cleanup();
  });

  test("submits /quit to the app quit handler and exits the Ink app", async () => {
    let quitCount = 0;
    let runCount = 0;
    const { stdin, cleanup } = render(
      <App
        sessionController={createSessionController(
          createProjectionStore(),
          async () => {
            runCount += 1;
            return completedResult();
          },
        )}
        onQuit={() => {
          quitCount += 1;
        }}
      />,
    );

    await submitInput(stdin, "/quit");
    await Bun.sleep(25);
    await submitInput(stdin, "should not run");
    await Bun.sleep(25);

    expect(quitCount).toBe(1);
    expect(runCount).toBe(0);
    cleanup();
  });

  test("starts a new empty session with /clear without running the agent", async () => {
    const currentStore = createProjectionStore();
    await currentStore.append({
      type: "turn.started",
      ...testRuntime.turn,
      eventSequence: 1,
      timestamp: "2026-07-19T00:00:00.000Z",
      data: { userPrompt: promptProjection("old session prompt") },
    });
    await currentStore.append({
      type: "turn.finished",
      ...testRuntime.turn,
      eventSequence: 2,
      timestamp: "2026-07-19T00:00:01.000Z",
      data: {
        status: "completed",
        finalText: "old session answer",
        lastIteration: testRuntime.iteration,
        messageCount: 2,
      },
    });

    const newSessionId = runtimeIdFactory.createSessionId();
    const freshStore = new TuiProjectionStore({
      sessionId: newSessionId,
      modelName: "model",
      workspaceRoot: "/tmp/tinker",
    });
    let runCount = 0;
    let clearCount = 0;
    const listeners = new Set<() => void>();
    const baseController = createSessionController(currentStore, async () => {
      runCount += 1;
      return completedResult();
    });
    const currentBinding = baseController.getBinding();
    const freshBinding = {
      ...currentBinding,
      sessionId: newSessionId,
      projectionStore: freshStore,
    };
    let activeBinding = currentBinding;
    const controller: TuiSessionController = {
      ...baseController,
      getBinding: () => activeBinding,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      clear: async () => {
        clearCount += 1;
        activeBinding = freshBinding;
        for (const listener of listeners) {
          listener();
        }
      },
    };
    const { stdin, lastFrame, cleanup } = render(
      <App sessionController={controller} />,
    );

    expect(lastFrame()).toContain("old session prompt");
    await submitInput(stdin, "/clear");
    await Bun.sleep(25);

    const frame = lastFrame() ?? "";
    const normalizedFrame = frame.replace(/\s+/g, " ");
    expect(clearCount).toBe(1);
    expect(runCount).toBe(0);
    expect(frame).toContain(newSessionId);
    expect(frame).toContain("Started new session");
    expect(normalizedFrame).toContain(
      "Previous session remains available via /resume.",
    );
    expect(frame).not.toContain("old session prompt");
    expect(frame).not.toContain("old session answer");
    cleanup();
  });

  test("clones the current session with /fork without running the agent", async () => {
    const projectionStore = createProjectionStore();
    const targetSessionId = runtimeIdFactory.createSessionId();
    let runCount = 0;
    let forkCount = 0;
    const baseController = createSessionController(projectionStore, async () => {
      runCount += 1;
      return completedResult();
    });
    let activeBinding = baseController.getBinding();
    const listeners = new Set<() => void>();
    const controller: TuiSessionController = {
      ...baseController,
      getBinding: () => activeBinding,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      fork: async () => {
        forkCount += 1;
        activeBinding = { ...activeBinding, sessionId: targetSessionId };
        for (const listener of listeners) {
          listener();
        }
        return targetSessionId;
      },
    };
    const { stdin, lastFrame, cleanup } = render(
      <App sessionController={controller} />,
    );

    await submitInput(stdin, "/fork");
    await Bun.sleep(25);

    const frame = lastFrame() ?? "";
    expect(forkCount).toBe(1);
    expect(runCount).toBe(0);
    expect(frame).toContain(targetSessionId);
    expect(frame).toContain("Cloned current session as");
    expect(frame.replace(/\s+/g, " ")).toContain(
      "Previous session remains available via /resume.",
    );
    cleanup();
  });

  test("opens /view outside the agent turn and restores the TUI with Escape", async () => {
    let runCount = 0;
    const reads: Array<{ workspaceRoot: string; filePath: string }> = [];
    const viewedFile: ViewFile = {
      absolutePath: "/tmp/tinker/docs/design notes.ts",
      displayPath: "docs/design notes.ts",
      lines: ["export const viewed = true;"],
      sizeBytes: 27,
    };
    const { stdin, lastFrame, frames, cleanup } = render(
      <App
        sessionController={createSessionController(
          createProjectionStore(),
          async () => {
            runCount += 1;
            return completedResult();
          },
        )}
        readViewFile={async (workspaceRoot, filePath) => {
          reads.push({ workspaceRoot, filePath });
          if (filePath === "missing.ts") {
            throw new Error("File does not exist: /tmp/tinker/missing.ts");
          }
          return viewedFile;
        }}
      />,
    );

    await submitInput(stdin, "/view docs/design notes.ts");
    await Bun.sleep(25);

    expect(reads).toEqual([
      { workspaceRoot: "/tmp/tinker", filePath: "docs/design notes.ts" },
    ]);
    expect(lastFrame()).toContain("View: docs/design notes.ts");
    expect(lastFrame()).toContain("export const viewed = true;");
    expect(lastFrame()).not.toContain('Enter a coding request, or "/" for commands');
    expect(runCount).toBe(0);

    const closeFrameMark = frames.length;
    await writeInputUntilFrame(
      stdin,
      "\u001b",
      lastFrame,
      (frame) => !frame.includes("View: docs/design notes.ts"),
      "the file viewer to close",
    );
    expect(lastFrame()).not.toContain("View: docs/design notes.ts");
    expect(lastFrame()).toContain("model · /tmp/tinker");
    expect(
      frames.slice(closeFrameMark).filter((frame) => frame.includes("\u001b[3J")),
    ).toHaveLength(1);

    const failureFrameMark = frames.length;
    await submitInput(stdin, "/view missing.ts");
    await Bun.sleep(25);
    expect(lastFrame()).toContain(
      "View failed: File does not exist: /tmp/tinker/missing.ts",
    );
    expect(
      frames.slice(failureFrameMark).filter((frame) => frame.includes("\u001b[3J")),
    ).toHaveLength(1);
    expect(runCount).toBe(0);
    cleanup();
  });

  test("opens /resume as a picker and preserves full-ID direct resume", async () => {
    const projectionStore = createProjectionStore();
    const targetId = "019f53d7-0000-7000-8000-000000000001" as SessionId;
    const directTargetId = "019f53d8-0000-7000-8000-000000000002" as SessionId;
    const sessions: readonly SessionSummary[] = [
      {
        sessionId: "session-1" as SessionId,
        modelName: "model",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T01:00:00.000Z",
        turnCount: 1,
        firstUserPromptPreview: "current prompt",
        status: "current",
        databaseBytes: 1_024,
      },
      {
        sessionId: targetId,
        modelName: "deepseek-v4-flash",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T01:00:00.000Z",
        turnCount: 3,
        firstUserPromptPreview: "帮我提交推送",
        status: "resumable",
        databaseBytes: 2_048,
      },
    ];
    const resumed: SessionId[] = [];
    const baseController = createSessionController(projectionStore, async () =>
      completedResult(),
    );
    const controller: TuiSessionController = {
      ...baseController,
      listSessions: async () => sessions,
      resume: async (sessionId) => {
        resumed.push(sessionId);
      },
    };
    const { stdin, lastFrame, cleanup } = render(
      <App sessionController={controller} />,
    );

    await Bun.sleep(100);
    await submitInput(stdin, "/resume");
    await waitForFrame(
      lastFrame,
      (frame) => frame.includes("· / to search · Enter to resume"),
      "the resume picker to open",
    );
    expect(lastFrame()).toContain("Resume session");
    expect(lastFrame()).toContain(
      "↑/↓ or j/k to move · / to search · Enter to resume · Esc to cancel",
    );
    expect(lastFrame()).toContain("帮我提交推送");

    await writeInputUntilFrame(
      stdin,
      "\u001b",
      lastFrame,
      (frame) => !frame.includes("Resume session"),
      "the resume picker to close",
    );
    expect(lastFrame()).not.toContain("Resume session");
    expect(resumed).toEqual([]);

    await Bun.sleep(100);
    await submitInput(stdin, "/resume");
    await waitForFrame(
      lastFrame,
      (frame) => frame.includes("· / to search · Enter to resume"),
      "the resume picker to reopen",
    );
    await writeInputUntilFrame(
      stdin,
      "\r",
      lastFrame,
      (frame) => frame.includes(`Resumed session ${targetId}.`),
      "the selected session to resume",
    );
    expect(resumed).toEqual([targetId]);
    expect(lastFrame()).toContain(`Resumed session ${targetId}.`);

    await Bun.sleep(100);
    await submitInput(stdin, `/resume ${directTargetId}`);
    await waitForFrame(
      lastFrame,
      (frame) => frame.includes(`Resumed session ${directTargetId}.`),
      "the direct session to resume",
    );
    expect(resumed).toEqual([targetId, directTargetId]);
    cleanup();
  });

  test("searches stored sessions beyond the default 20 and resumes a match", async () => {
    const projectionStore = createProjectionStore();
    const targetId = "019f53e0-0000-7000-8000-000000000024" as SessionId;
    const sessions: readonly SessionSummary[] = Array.from(
      { length: 25 },
      (_, index) => ({
        sessionId:
          index === 24
            ? targetId
            : (`019f53e0-0000-7000-8000-0000000000${String(index).padStart(2, "0")}` as SessionId),
        modelName: "deepseek-v4-flash",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: new Date(
          Date.parse("2026-07-12T01:00:00.000Z") - index * 60_000,
        ).toISOString(),
        turnCount: 2,
        firstUserPromptPreview:
          index === 24 ? "wav repair notes" : `default prompt ${index}`,
        status: "resumable" as const,
        databaseBytes: 2_048,
      }),
    );
    const resumed: SessionId[] = [];
    const baseController = createSessionController(projectionStore, async () =>
      completedResult(),
    );
    const controller: TuiSessionController = {
      ...baseController,
      listSessions: async () => sessions,
      resume: async (sessionId) => {
        resumed.push(sessionId);
      },
    };
    const { stdin, lastFrame, cleanup } = render(
      <App sessionController={controller} />,
    );

    await Bun.sleep(100);
    await submitInput(stdin, "/resume");
    await waitForFrame(
      lastFrame,
      (frame) => frame.includes("· 25 sessions total"),
      "the resume picker to open with the full candidate count",
    );
    expect(lastFrame()).toContain("/ 20 recent · 25 sessions total");
    expect(lastFrame()).not.toContain("wav repair notes");

    await writeInputUntilFrame(
      stdin,
      "/",
      lastFrame,
      (frame) => frame.includes("Search:"),
      "the search editor to open",
    );
    await writeInputUntilFrame(
      stdin,
      "wav repair",
      lastFrame,
      (frame) => frame.includes("wav repair notes"),
      "the older session to match the query",
    );
    expect(lastFrame()).toContain("1 match");
    expect(lastFrame()).not.toContain("default prompt 0");

    await writeInputUntilFrame(
      stdin,
      "\r",
      lastFrame,
      (frame) => frame.includes(`Resumed session ${targetId}.`),
      "the searched session to resume",
    );
    expect(resumed).toEqual([targetId]);
    cleanup();
  });
});

describe("model switching", () => {
  test("/reasoning changes only the active session runtime effort", async () => {
    const projectionStore = createProjectionStore();
    let runCalls = 0;
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionControllerWithProfiles(
          projectionStore,
          async () => {
            runCalls += 1;
            return completedResult();
          },
          async () => undefined,
        )}
        profiles={TEST_PROFILES}
      />,
    );

    expect(lastFrame()).toContain("model medium ·");

    await submitInput(stdin, "/reasoning");
    await Bun.sleep(25);
    expect(lastFrame()).toContain(
      "Reasoning effort: medium (profile default). Available: low, medium, high.",
    );

    await submitInput(stdin, "/reasoning high");
    await Bun.sleep(25);
    expect(lastFrame()).toContain(
      'Reasoning effort set to "high" for this session runtime',
    );
    expect(lastFrame()).toContain("model high ·");

    await submitInput(stdin, "/reasoning");
    await Bun.sleep(25);
    expect(lastFrame()).toContain(
      "Reasoning effort: high (session override; profile default: medium).",
    );

    await submitInput(stdin, "/reasoning reset");
    await Bun.sleep(25);
    expect(lastFrame()).toContain(
      'Reasoning effort reset to profile default "medium".',
    );
    expect(lastFrame()).toContain("model medium ·");
    expect(runCalls).toBe(0);
    cleanup();
  });

  test("/reasoning rejects values outside the active profile enumeration", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionControllerWithProfiles(
          createProjectionStore(),
          async () => completedResult(),
          async () => undefined,
        )}
        profiles={TEST_PROFILES}
      />,
    );

    await submitInput(stdin, "/reasoning deep");
    await Bun.sleep(25);
    expect(lastFrame()).toContain(
      'Unsupported reasoning effort "deep". Available efforts: low, medium, high.',
    );
    cleanup();
  });

  test("/model shows the picker on an empty session", async () => {
    const projectionStore = createProjectionStore();
    await projectionStore.append({
      type: "session.started",
      sessionId: testRuntime.runtimeSession.sessionId,
      eventSequence: 1,
      timestamp: "2026-07-11T00:00:00.000Z",
      data: {
        workspaceRoot: "/tmp/tinker",
        model: "deepseek-chat",
        maxIterations: 100,
        includeReasoningContent: false,
        contextProfile: TEST_CONTEXT_PROFILE,
        contextBudget: TEST_CONTEXT_BUDGET,
        projectInstructions: {},
      },
    });
    await projectionStore.append({
      type: "context.usage.updated",
      sessionId: testRuntime.runtimeSession.sessionId,
      eventSequence: 2,
      timestamp: "2026-07-11T00:00:00.001Z",
      data: { phase: "initial", snapshot: contextSnapshot() },
    });
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionControllerWithProfiles(
          projectionStore,
          async () => completedResult(),
          async () => undefined,
        )}
        profiles={TEST_PROFILES}
      />,
    );

    await submitInput(stdin, "/model");
    await Bun.sleep(25);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Switch model profile");
    expect(frame).toContain("deepseek");
    expect(frame).toContain("gpt4o");
    cleanup();
  });

  test("/model is hidden after a turn exists", async () => {
    const projectionStore = createProjectionStore();
    await projectionStore.append({
      type: "session.started",
      sessionId: testRuntime.runtimeSession.sessionId,
      eventSequence: 1,
      timestamp: "2026-07-11T00:00:00.000Z",
      data: {
        workspaceRoot: "/tmp/tinker",
        model: "deepseek-chat",
        maxIterations: 100,
        includeReasoningContent: false,
        contextProfile: TEST_CONTEXT_PROFILE,
        contextBudget: TEST_CONTEXT_BUDGET,
        projectInstructions: {},
      },
    });
    await projectionStore.append({
      type: "turn.started",
      ...testRuntime.turn,
      eventSequence: 2,
      timestamp: "2026-07-11T00:00:00.002Z",
      data: { userPrompt: promptProjection("hello") },
    });
    await projectionStore.append({
      type: "turn.finished",
      ...testRuntime.turn,
      eventSequence: 3,
      timestamp: "2026-07-11T00:00:00.003Z",
      data: {
        status: "completed",
        finalText: "hi",
        lastIteration: testRuntime.iteration,
        messageCount: 2,
      },
    });
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionControllerWithProfiles(
          projectionStore,
          async () => completedResult(),
          async () => undefined,
        )}
        profiles={TEST_PROFILES}
      />,
    );

    stdin.write("/");
    await Bun.sleep(25);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("/model");
    expect(frame).toContain("/status");
    expect(frame).toContain("/resume");
    cleanup();
  });

  test("/model gpt4o calls switchModel with the named profile", async () => {
    const projectionStore = createProjectionStore();
    await projectionStore.append({
      type: "session.started",
      sessionId: testRuntime.runtimeSession.sessionId,
      eventSequence: 1,
      timestamp: "2026-07-11T00:00:00.000Z",
      data: {
        workspaceRoot: "/tmp/tinker",
        model: "deepseek-chat",
        maxIterations: 100,
        includeReasoningContent: false,
        contextProfile: TEST_CONTEXT_PROFILE,
        contextBudget: TEST_CONTEXT_BUDGET,
        projectInstructions: {},
      },
    });
    await projectionStore.append({
      type: "context.usage.updated",
      sessionId: testRuntime.runtimeSession.sessionId,
      eventSequence: 2,
      timestamp: "2026-07-11T00:00:00.001Z",
      data: { phase: "initial", snapshot: contextSnapshot() },
    });
    const switched: ModelProfile[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionControllerWithProfiles(
          projectionStore,
          async () => completedResult(),
          async (profile) => {
            switched.push(profile);
          },
        )}
        profiles={TEST_PROFILES}
        persistDefaultProfile={async () => {
          throw new Error("read-only config");
        }}
      />,
    );

    await submitInput(stdin, "/model gpt4o");
    await Bun.sleep(25);
    expect(switched).toHaveLength(1);
    expect(switched[0]?.name).toBe("gpt4o");
    expect(lastFrame()).toContain("Switched to model profile");
    expect(lastFrame()).toContain("failed to save it as the default: read-only config");
    cleanup();
  });
});
