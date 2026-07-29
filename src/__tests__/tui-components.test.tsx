import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Header } from "../tui/components/header";
import { BashResultView } from "../tui/components/bash-result-view";
import { BackgroundTasks } from "../tui/components/background-tasks";
import { DiffView } from "../tui/components/diff-view";
import { Timeline } from "../tui/components/timeline";
import { Footer } from "../tui/components/footer";
import { App } from "../tui/app";
import { PromptInput } from "../tui/components/prompt-input";
import { McpPanel } from "../tui/components/mcp-panel";
import { PromptHistory } from "../tui/prompt-history";
import { TuiProjectionStore } from "../tui/tui-projection-store";
import type { SlashCommand } from "../tui/slash-commands";
import type { ProjectSlashCommand } from "../tui/project-slash-commands";
import type { SessionId } from "../ids/runtime-id";
import { runtimeIdFactory } from "../ids/runtime-id";
import type { ContextUsageSnapshot } from "../agent/context-meter";
import {
  ContextManagerError,
  type ContextCompactionResult,
  type ContextRetirementResult,
} from "../context/context-manager";
import type { RunAgentResult } from "../agent/types";
import type {
  TuiSessionBinding,
  TuiSessionController,
} from "../tui/tui-session-controller";
import type { SessionSummary } from "../session/session-catalog";
import type { ModelProfile, ModelProfiles } from "../cli/model-profiles";
import { parseModelProfiles } from "../cli/model-profiles";
import { ContextBudgetExceededError } from "../model/model-request-preflight";
import type { ViewFile } from "../tui/view-file";
import type { McpInventorySnapshot } from "../mcp/mcp-manager";
import {
  createTestRuntime,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
} from "./test-runtime";

const testRuntime = createTestRuntime();

function completedResult() {
  return {
    status: "completed" as const,
    finalText: "",
    lastIteration: testRuntime.iteration,
  };
}

function promptProjection(text: string) {
  return { version: 1 as const, text, images: [], omittedImageCount: 0 };
}

function createProjectionStore(): TuiProjectionStore {
  return new TuiProjectionStore({
    sessionId: "session-1",
    modelName: "model",
    workspaceRoot: "/tmp/tinker",
  });
}

function createSessionController(
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

async function submitInput(stdin: { write: (data: string) => void }, value: string) {
  stdin.write(value);
  await Bun.sleep(15);
  stdin.write("\r");
}

async function writeInputUntilFrame(
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

async function waitForFrame(
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

function withStdoutColumns<T>(columns: number, run: () => T): T {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: columns,
  });

  try {
    return run();
  } finally {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(process.stdout, "columns");
    } else {
      Object.defineProperty(process.stdout, "columns", originalDescriptor);
    }
  }
}

function contextSnapshot(
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

describe("tui components", () => {
  test("renders header metadata", () => {
    const { lastFrame, cleanup } = render(
      <Header
        modelName="deepseek-v4-flash"
        workspaceRoot="/tmp/tinker"
        sessionId={"session-1" as SessionId}
      />,
    );

    expect(lastFrame()).toContain("deepseek-v4-flash");
    expect(lastFrame()).toContain("tinker");
    expect(lastFrame()).toContain("session-1");
    cleanup();
  });

  test("renders timeline tool status", () => {
    const { lastFrame, cleanup } = render(
      <Timeline
        items={[
          {
            id: "tool-read",
            text: "Read README.md",
            status: "ok",
          },
        ]}
      />,
    );

    expect(lastFrame()).toContain("Read");
    expect(lastFrame()).toContain("README.md");
    expect(lastFrame()).toContain("✔");
    cleanup();
  });

  test("renders footer status", () => {
    const { lastFrame, cleanup } = render(
      <Footer status="done" workedForMs={207_000} />,
    );

    expect(lastFrame()).toContain("✔ Worked for 3m 27s");
    expect(lastFrame()).not.toContain("done");
    cleanup();
  });

  test("renders an animated spinner for the running footer status", async () => {
    const running = render(<Footer status="running" />);
    const firstFrame = running.lastFrame();

    expect(firstFrame).toContain("Running");
    await Bun.sleep(120);
    expect(running.lastFrame()).not.toBe(firstFrame);
    running.cleanup();
  });

  test("renders the running footer status without a ticking elapsed counter", () => {
    const running = render(<Footer status="running" />);
    expect(running.lastFrame()).toContain("Running");
    expect(running.lastFrame()).not.toMatch(/Running \d/);
    running.cleanup();
  });

  test("renders context usage in the prompt input status bar", () => {
    const normal = render(
      <PromptInput
        modelName="deepseek-v4-flash"
        workspaceRoot="/tmp/tinker"
        gitBranch="main"
        contextUsage={contextSnapshot({
          usedInputTokens: 700 * 1_024,
          inputBudgetTokens: 896 * 1_024,
        })}
        onSubmit={() => true}
      />,
    );
    expect(normal.lastFrame()).toContain(
      "deepseek-v4-flash · /tmp/tinker · main · context 700K / 896K (78% used)",
    );
    normal.cleanup();

    const blocked = render(
      <PromptInput
        modelName="deepseek-v4-flash"
        workspaceRoot="/tmp/tinker"
        gitBranch="main"
        contextUsage={contextSnapshot({
          usedInputTokens: 930 * 1_024,
          inputBudgetTokens: 896 * 1_024,
          pressure: "blocked",
        })}
        onSubmit={() => true}
      />,
    );
    expect(blocked.lastFrame()).toContain("context 930K / 896K (104% used, blocked)");
    blocked.cleanup();
  });

  test("shows /status locally without running the agent", async () => {
    const projectionStore = createProjectionStore();
    await projectionStore.append({
      type: "session.started",
      sessionId: testRuntime.runtimeSession.sessionId,
      eventSequence: 1,
      timestamp: "2026-07-11T00:00:00.000Z",
      data: {
        workspaceRoot: "/tmp/tinker",
        model: "model",
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
    let runCalls = 0;
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(projectionStore, async () => {
          runCalls += 1;
          return completedResult();
        })}
      />,
    );

    await submitInput(stdin, "/status");
    await Bun.sleep(25);
    expect(lastFrame()).toContain("model window: 256K");
    expect(lastFrame()).toContain("request max output: 64K");
    expect(lastFrame()).toContain("Estimator");
    expect(runCalls).toBe(0);

    await submitInput(stdin, "/nope");
    await Bun.sleep(25);
    expect(lastFrame()).not.toContain("Estimator");
    cleanup();
  });

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

  test("shows an initial memory failure notice without creating a turn", () => {
    const projectionStore = createProjectionStore();
    const history = new PromptHistory();
    let runCalls = 0;
    const { lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(projectionStore, async () => {
          runCalls += 1;
          return completedResult();
        })}
        history={history}
        initialNotice="memory disabled: global memory store is unavailable"
      />,
    );

    expect(lastFrame()).toContain(
      "memory disabled: global memory store is unavailable",
    );
    expect(runCalls).toBe(0);
    expect(history.entries).toEqual([]);
    expect(projectionStore.getSnapshot().recentTurns).toEqual([]);
    cleanup();
  });

  test("opens /memory locally from one fixed snapshot and restores prompt input", async () => {
    let runCalls = 0;
    let listCalls = 0;
    const history = new PromptHistory();
    const { stdin, lastFrame, frames, cleanup } = render(
      <App
        sessionController={createSessionController(
          createProjectionStore(),
          async () => {
            runCalls += 1;
            return completedResult();
          },
        )}
        history={history}
        listStoredMemories={() => {
          listCalls += 1;
          return [
            {
              memoryId: "memory-1",
              text: "Tinker changes require bun run check.",
              sourceWorkspace: "/tmp/tinker",
              createdAt: "2026-07-26T06:32:00.000Z",
            },
          ];
        }}
      />,
    );

    await submitInput(stdin, "/memory");
    await waitForFrame(
      lastFrame,
      (frame) => frame.includes("Global memory"),
      "the memory browser to open",
    );
    expect(lastFrame()).toContain("Tinker changes require bun run check.");
    expect(lastFrame()).not.toContain('Enter a coding request, or "/" for commands');
    expect(listCalls).toBe(1);
    expect(runCalls).toBe(0);
    expect(history.entries).toEqual([]);

    await Bun.sleep(25);
    expect(listCalls).toBe(1);
    const closeFrameMark = frames.length;
    await writeInputUntilFrame(
      stdin,
      "\u001b",
      lastFrame,
      (frame) => !frame.includes("Global memory"),
      "the memory browser to close",
    );
    expect(lastFrame()).toContain('Enter a coding request, or "/" for commands');
    expect(
      frames.slice(closeFrameMark).filter((frame) => frame.includes("\u001b[3J")),
    ).toHaveLength(1);

    await submitInput(stdin, "normal prompt");
    await Bun.sleep(25);
    expect(runCalls).toBe(1);
    cleanup();
  });

  test("reports unavailable memory locally without leaving a half-open panel", async () => {
    const unconfigured = render(
      <App
        sessionController={createSessionController(createProjectionStore(), async () =>
          completedResult(),
        )}
      />,
    );
    await submitInput(unconfigured.stdin, "/memory");
    await Bun.sleep(25);
    expect(unconfigured.lastFrame()).toContain("memory disabled: not configured");
    expect(unconfigured.lastFrame()).not.toContain("Global memory");
    unconfigured.cleanup();

    const initializationFailed = render(
      <App
        sessionController={createSessionController(createProjectionStore(), async () =>
          completedResult(),
        )}
        memoryDisabledNotice="memory disabled: incompatible database"
      />,
    );
    await submitInput(initializationFailed.stdin, "/memory");
    await Bun.sleep(25);
    expect(initializationFailed.lastFrame()).toContain(
      "memory disabled: incompatible database",
    );
    expect(initializationFailed.lastFrame()).not.toContain("Global memory");
    initializationFailed.cleanup();

    const readFailed = render(
      <App
        sessionController={createSessionController(createProjectionStore(), async () =>
          completedResult(),
        )}
        listStoredMemories={() => {
          throw new Error("database\nread failed");
        }}
      />,
    );
    await submitInput(readFailed.stdin, "/memory");
    await Bun.sleep(25);
    expect(readFailed.lastFrame()).toContain(
      "memory unavailable: database read failed",
    );
    expect(readFailed.lastFrame()).not.toContain("Global memory");
    readFailed.cleanup();
  });

  test("shows current runtime MCP tools locally without running the agent", async () => {
    let runCalls = 0;
    const snapshot: McpInventorySnapshot = {
      servers: [
        {
          name: "playwright",
          tools: ["browser_click", "browser_navigate"],
        },
      ],
    };
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(
          createProjectionStore(),
          async () => {
            runCalls += 1;
            return completedResult();
          },
          undefined,
          undefined,
          snapshot,
        )}
      />,
    );

    await submitInput(stdin, "/mcp");
    await Bun.sleep(25);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("MCP Tools");
    expect(frame).toContain("playwright (connected, 2 tools)");
    expect(frame).toContain("browser_click, browser_navigate");
    expect(runCalls).toBe(0);

    await submitInput(stdin, "/mcp verbose");
    await Bun.sleep(25);
    expect(lastFrame()).not.toContain("browser_click");
    expect(lastFrame()).toContain("Usage: /mcp");
    expect(runCalls).toBe(0);
    cleanup();
  });

  test("renders an empty MCP runtime inventory", () => {
    const { lastFrame, cleanup } = render(<McpPanel snapshot={{ servers: [] }} />);

    expect(lastFrame()).toContain("MCP Tools");
    expect(lastFrame()).toContain("no MCP servers configured");
    cleanup();
  });

  test("copies the canonical last response as exact Markdown without running the agent", async () => {
    const markdown = "# Result\n\n```ts\nconst copied = true;\n```\n\n";
    const reads: Array<{ workspaceRoot: string; sessionId: SessionId }> = [];
    const copied: string[] = [];
    const history = new PromptHistory();
    let runCalls = 0;
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(
          createProjectionStore(),
          async () => {
            runCalls += 1;
            return completedResult();
          },
        )}
        history={history}
        readLastResponse={async (workspaceRoot, sessionId) => {
          reads.push({ workspaceRoot, sessionId });
          return markdown;
        }}
        writeClipboard={async (text) => {
          copied.push(text);
        }}
      />,
    );

    await submitInput(stdin, "/copy");
    await Bun.sleep(25);

    expect(reads).toEqual([
      { workspaceRoot: "/tmp/tinker", sessionId: "session-1" as SessionId },
    ]);
    expect(copied).toEqual([markdown]);
    expect(runCalls).toBe(0);
    expect(history.entries).toEqual([]);
    expect(lastFrame()).toContain("Copied last response as Markdown.");
    cleanup();
  });

  test("reports when /copy has no assistant response", async () => {
    let clipboardCalls = 0;
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(createProjectionStore(), async () =>
          completedResult(),
        )}
        readLastResponse={async () => undefined}
        writeClipboard={async () => {
          clipboardCalls += 1;
        }}
      />,
    );

    await submitInput(stdin, "/copy");
    await Bun.sleep(25);

    expect(clipboardCalls).toBe(0);
    expect(lastFrame()).toContain("No assistant response is available to copy.");
    cleanup();
  });

  test("reports clipboard failures from /copy", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(createProjectionStore(), async () =>
          completedResult(),
        )}
        readLastResponse={async () => "answer"}
        writeClipboard={async () => {
          throw new Error("clipboard unavailable");
        }}
      />,
    );

    await submitInput(stdin, "/copy");
    await Bun.sleep(25);

    expect(lastFrame()).toContain("Copy failed: clipboard unavailable");
    cleanup();
  });

  test("shows /skills from the current runtime snapshot without running the agent", async () => {
    const projectionStore = createProjectionStore();
    let runCalls = 0;
    const baseController = createSessionController(projectionStore, async () => {
      runCalls += 1;
      return completedResult();
    });
    const baseBinding = baseController.getBinding();
    const skillsBinding = {
      ...baseBinding,
      skills: () => ({
        skills: [
          {
            name: "code-review",
            description: "Review changes for correctness and regressions.",
            scope: "project" as const,
            active: true,
          },
          {
            name: "pdf-processing",
            description: "Read and create PDF artifacts.",
            scope: "user" as const,
            active: false,
          },
        ],
        shadowedNames: ["code-review"],
      }),
    };
    const sessionController: TuiSessionController = {
      ...baseController,
      getBinding: () => skillsBinding,
    };
    const { stdin, lastFrame, cleanup } = render(
      <App sessionController={sessionController} />,
    );

    await submitInput(stdin, "/skills");
    await Bun.sleep(25);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Agent Skills");
    expect(frame).toContain("code-review (project, active)");
    expect(frame).toContain("Review changes for correctness and regressions.");
    expect(frame).toContain("pdf-processing (user)");
    expect(frame).toContain("Shadowed user skills");
    expect(runCalls).toBe(0);
    cleanup();
  });

  test("runs /compact outside the agent turn and renders a bounded result", async () => {
    let runCalls = 0;
    let compactCalls = 0;
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(
          createProjectionStore(),
          async () => {
            runCalls += 1;
            return completedResult();
          },
          async () => {
            compactCalls += 1;
            return {
              status: "compacted",
              outcome: "target_reached",
              previousRevisionId: runtimeIdFactory.createContextRevisionId(),
              revisionId: runtimeIdFactory.createContextRevisionId(),
              previousRevisionNumber: 1,
              revisionNumber: 2,
              addedOverrideCount: 3,
              activeOverrideCount: 3,
              originalObservationBytes: 42_762,
              projectedObservationBytes: 1_665,
              rawTokensBefore: 43_964,
              rawTokensAfter: 31_577,
              guardedTokensBefore: 48_361,
              guardedTokensAfter: 34_735,
              targetTokens: 39_321,
              planHash: "a".repeat(64),
              planningDurationMs: 1.1,
              validationDurationMs: 1.2,
              transactionDurationMs: 1.3,
              activationDurationMs: 0.6,
              durationMs: 4.2,
            };
          },
        )}
      />,
    );

    await submitInput(stdin, "/compact");
    await Bun.sleep(30);
    expect(lastFrame()).toContain("Context compacted: revision 1 -> 2");
    expect(lastFrame()).toContain("48,361 -> 34,735 estimated tokens");
    expect(lastFrame()).toContain("(-28.2%)");
    expect(compactCalls).toBe(1);
    expect(runCalls).toBe(0);
    cleanup();
  });

  test("bounds /compact failures without rendering the underlying error body", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(
          createProjectionStore(),
          async () => completedResult(),
          async () => {
            throw new ContextManagerError(
              "validate",
              "prospective_prepare_failed",
              false,
              false,
              "secret path /tmp/private and ctx://message/private",
            );
          },
        )}
      />,
    );

    await submitInput(stdin, "/compact");
    await Bun.sleep(30);
    expect(lastFrame()).toContain(
      "Context compaction failed at validate (prospective_prepare_failed).",
    );
    expect(lastFrame()).not.toContain("/tmp/private");
    expect(lastFrame()).not.toContain("ctx://message/private");
    cleanup();
  });

  test("runs /compact retire explicitly and reports Recall availability", async () => {
    let runCalls = 0;
    let retireCalls = 0;
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(
          createProjectionStore(),
          async () => {
            runCalls += 1;
            return completedResult();
          },
          undefined,
          async () => {
            retireCalls += 1;
            return {
              status: "retired",
              outcome: "target_reached",
              previousRevisionId: runtimeIdFactory.createContextRevisionId(),
              revisionId: runtimeIdFactory.createContextRevisionId(),
              previousRevisionNumber: 2,
              revisionNumber: 3,
              previousKeepFromOrdinal: 1,
              keepFromOrdinal: 42,
              retiredTurnCount: 17,
              retiredFrameCount: 40,
              retiredMessageCount: 41,
              activeOverrideCount: 2,
              rawTokensBefore: 78_248,
              rawTokensAfter: 37_473,
              guardedTokensBefore: 86_073,
              guardedTokensAfter: 41_220,
              targetTokens: 50_000,
              planHash: "b".repeat(64),
              planningDurationMs: 1.1,
              validationDurationMs: 1.2,
              transactionDurationMs: 1.3,
              activationDurationMs: 0.7,
              durationMs: 4.3,
            };
          },
        )}
      />,
    );

    await submitInput(stdin, "/compact retire");
    await Bun.sleep(30);
    expect(lastFrame()).toContain("Context prefix retired: revision 2 -> 3");
    expect(lastFrame()).toContain("17 turns removed from the active request");
    expect(lastFrame()).toContain("86,073 -> 41,220");
    expect(lastFrame()).toContain("estimated tokens (-52.1%)");
    expect(lastFrame()).toContain("available through Recall");
    expect(retireCalls).toBe(1);
    expect(runCalls).toBe(0);
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

  test("renders background task identity, status, and exit result", () => {
    const { lastFrame, cleanup } = render(
      <BackgroundTasks
        tasks={[
          {
            taskId: "task-019f",
            origin: testRuntime.toolCall({
              providerToolCallId: "background-origin",
              name: "Bash",
              args: {},
            }),
            command: "bun run dev",
            description: "Start development server",
            status: "completed",
            startedAt: "2026-07-10T10:00:00.000Z",
            endedAt: "2026-07-10T10:01:00.000Z",
            backgroundedAt: "2026-07-10T10:00:00.010Z",
            backgroundReason: "requested",
            outputFilePath: "/tmp/task.log",
            outputBytes: 20,
            outputLines: 2,
            cwd: "/tmp/workspace",
            exitCode: 0,
          },
        ]}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Background tasks");
    expect(frame).toContain("✔ completed Start development server exit=0");
    expect(frame).toContain(
      "id=task-019f · started=2026-07-10T10:00:00.000Z · ended=2026-07-10T10:01:00.000Z",
    );
    cleanup();
  });

  test("shows only five background tasks and summarizes the remainder", () => {
    const tasks = Array.from({ length: 7 }, (_, index) => ({
      taskId: `task-${index + 1}`,
      origin: testRuntime.toolCall({
        providerToolCallId: `background-${index + 1}`,
        name: "Bash",
        args: {},
      }),
      command: `task ${index + 1}`,
      description: `Task ${index + 1}`,
      status: "running" as const,
      startedAt: `2026-07-10T10:00:0${index}.000Z`,
      backgroundedAt: `2026-07-10T10:00:0${index}.010Z`,
      backgroundReason: "requested" as const,
      outputFilePath: `/tmp/task-${index + 1}.log`,
      outputBytes: 0,
      outputLines: 0,
      cwd: "/tmp/workspace",
    }));
    const { lastFrame, cleanup } = render(<BackgroundTasks tasks={tasks} />);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Task 1");
    expect(frame).toContain("Task 5");
    expect(frame).not.toContain("Task 6");
    expect(frame).not.toContain("Task 7");
    expect(frame).toContain("+2 more");
    cleanup();
  });

  test("renders final output without ok status prefix", () => {
    const { lastFrame, cleanup } = render(
      <Timeline
        items={[
          {
            id: "final-1",
            label: "assistant",
            text: "Completed the change.",
            status: "text",
          },
        ]}
      />,
    );

    expect(lastFrame()).toContain("- assistant");
    expect(lastFrame()).toContain("Completed the change.");
    expect(lastFrame()).not.toContain("final:");
    expect(lastFrame()).not.toContain("ok Completed");
    cleanup();
  });

  test("renders assistant markdown output", () => {
    const { lastFrame, cleanup } = render(
      <Timeline
        items={[
          {
            id: "assistant-1",
            label: "assistant",
            text: "**Done**\n\n- one\n- two",
            status: "text",
          },
        ]}
      />,
    );

    expect(lastFrame()).toContain("- assistant");
    expect(lastFrame()).toContain("Done");
    expect(lastFrame()).toContain("one");
    expect(lastFrame()).toContain("two");
    expect(lastFrame()).not.toContain("**Done**");
    cleanup();
  });

  test("hard-wraps long markdown table cells without breaking borders", () => {
    withStdoutColumns(80, () => {
      const { lastFrame, cleanup } = render(
        <Timeline
          items={[
            {
              id: "assistant-table-1",
              label: "assistant",
              text: [
                "| 文件 | 变更类型 | 具体改动 | 目的 |",
                "| --- | --- | --- | --- |",
                "| src/tui/components/assistant-markdown.tsx | 新增常量 | tableOptions = { tableTruncate: false } | 明确禁止表格单元格内容截断 |",
              ].join("\n"),
              status: "text",
            },
          ]}
        />,
      );

      const frame = lastFrame() ?? "";
      const lines = frame.split("\n");
      const tableLines = lines.filter((line) => /^[┌├└│]/.test(line));
      const bodyLines = tableLines.filter((line) => line.startsWith("│")).slice(1);
      const cellText = (column: number) =>
        bodyLines.map((line) => line.split("│")[column]?.trim() ?? "").join("");

      expect(cellText(1)).toBe("src/tui/components/assistant-markdown.tsx");
      expect(cellText(4)).toBe("明确禁止表格单元格内容截断");
      expect(frame).not.toContain("…");
      expect(new Set(tableLines.map((line) => Bun.stringWidth(line))).size).toBe(1);
      cleanup();
    });
  });

  test("separates markdown table body rows without splitting wrapped rows", () => {
    withStdoutColumns(80, () => {
      const { lastFrame, cleanup } = render(
        <Timeline
          items={[
            {
              id: "assistant-table-rows-1",
              label: "assistant",
              text: [
                "| Name | Value |",
                "| --- | --- |",
                "| first | src/tui/components/assistant-markdown.tsx |",
                "| second | complete |",
              ].join("\n"),
              status: "text",
            },
          ]}
        />,
      );

      const frame = lastFrame() ?? "";
      const tableLines = frame.split("\n").filter((line) => /^[┌├└│]/.test(line));
      const separators = tableLines.filter((line) => line.startsWith("├"));
      const bodyLines = tableLines.filter((line) => line.startsWith("│")).slice(1);

      expect(separators).toHaveLength(2);
      expect(bodyLines.length).toBeGreaterThan(2);
      expect(frame).toContain("first");
      expect(frame).toContain("second");
      cleanup();
    });
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

  test("intercepts unknown slash commands instead of running them", async () => {
    let runCount = 0;
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(
          createProjectionStore(),
          async () => {
            runCount += 1;
            return completedResult();
          },
        )}
        onQuit={() => undefined}
      />,
    );

    await submitInput(stdin, "/nope");
    await Bun.sleep(25);

    expect(runCount).toBe(0);
    expect(lastFrame()).toContain("Unknown command: /nope");
    cleanup();
  });

  test("expands a project slash command as an ordinary prompt", async () => {
    const prompts: string[] = [];
    const history = new PromptHistory();
    const projectSlashCommands: readonly ProjectSlashCommand[] = [
      {
        name: "literal-slash-prompt",
        description: "Submit a prompt beginning with a slash",
        prompt: "/this is ordinary prompt text",
      },
    ];
    const { stdin, cleanup } = render(
      <App
        sessionController={createSessionController(
          createProjectionStore(),
          async (prompt) => {
            prompts.push(prompt);
            return completedResult();
          },
        )}
        history={history}
        projectSlashCommands={projectSlashCommands}
      />,
    );

    await submitInput(stdin, "/literal-slash-prompt");
    await Bun.sleep(25);

    expect(prompts).toEqual(["/this is ordinary prompt text"]);
    expect(history.entries).toEqual(["/this is ordinary prompt text"]);
    cleanup();
  });

  test("rejects project command arguments without running the agent", async () => {
    let runCount = 0;
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(
          createProjectionStore(),
          async () => {
            runCount += 1;
            return completedResult();
          },
        )}
        projectSlashCommands={[
          {
            name: "review-changes",
            description: "Review changes",
            prompt: "Review the workspace changes.",
          },
        ]}
      />,
    );

    await submitInput(stdin, "/review-changes now");
    await Bun.sleep(25);

    expect(runCount).toBe(0);
    expect(lastFrame()).toContain("Usage: /review-changes");
    cleanup();
  });

  test("lists project commands after built-in slash commands", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={createSessionController(createProjectionStore(), async () =>
          completedResult(),
        )}
        projectSlashCommands={[
          {
            name: "review-changes",
            description: "Review changes",
            prompt: "Review the workspace changes.",
          },
        ]}
      />,
    );

    stdin.write("/");
    await Bun.sleep(25);
    const frame = lastFrame() ?? "";

    expect(frame).toContain("/quit");
    expect(frame).toContain("/review-changes");
    expect(frame.indexOf("/quit")).toBeLessThan(frame.indexOf("/review-changes"));
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
      (frame) => frame.includes("↑/↓ or j/k to move · Enter to resume"),
      "the resume picker to open",
    );
    expect(lastFrame()).toContain("Resume session");
    expect(lastFrame()).toContain(
      "↑/↓ or j/k to move · Enter to resume · Esc to cancel",
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
      (frame) => frame.includes("↑/↓ or j/k to move · Enter to resume"),
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
});

describe("prompt input slash commands", () => {
  const modelName = "model";
  const workspaceRoot = "/tmp/tinker";
  const commands: readonly SlashCommand[] = [
    { name: "quit", description: "Exit the TUI" },
    { name: "quiet", description: "Toggle quiet mode" },
  ];

  test("shows suggestions while typing a slash command", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        onSubmit={() => true}
      />,
    );

    stdin.write("/qui");
    await Bun.sleep(25);

    expect(lastFrame()).toContain("❯ /quit");
    expect(lastFrame()).toContain("Exit the TUI");
    expect(lastFrame()).toContain("/quiet");
    expect(lastFrame()).not.toContain(modelName);
    cleanup();
  });

  test("completes the selected command with tab", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        onSubmit={(value) => {
          submitted.push(value.userMessage.content);
          return true;
        }}
      />,
    );

    stdin.write("/q");
    await Bun.sleep(25);
    stdin.write("\t");
    await Bun.sleep(25);

    expect(lastFrame()).toContain("/quit");
    expect(lastFrame()).not.toContain("Exit the TUI");

    stdin.write("\r");
    await Bun.sleep(25);

    expect(submitted).toEqual(["/quit"]);
    cleanup();
  });

  test("accepts the selected suggestion on enter", async () => {
    const submitted: string[] = [];
    const { stdin, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        onSubmit={(value) => {
          submitted.push(value.userMessage.content);
          return true;
        }}
      />,
    );

    stdin.write("/q");
    await Bun.sleep(25);
    stdin.write("\r");
    await Bun.sleep(25);

    expect(submitted).toEqual(["/quit"]);
    cleanup();
  });

  test("navigates suggestions with arrow keys", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        onSubmit={(value) => {
          submitted.push(value.userMessage.content);
          return true;
        }}
      />,
    );

    stdin.write("/q");
    await Bun.sleep(25);
    stdin.write("[B");
    await Bun.sleep(25);

    expect(lastFrame()).toContain("❯ /quiet");

    stdin.write("\r");
    await Bun.sleep(25);

    expect(submitted).toEqual(["/quiet"]);
    cleanup();
  });

  test("dismisses suggestions with escape and submits raw input", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        onSubmit={(value) => {
          submitted.push(value.userMessage.content);
          return true;
        }}
      />,
    );

    stdin.write("/q");
    await Bun.sleep(25);
    stdin.write("");
    await Bun.sleep(25);

    expect(lastFrame()).not.toContain("Exit the TUI");
    expect(lastFrame()).toContain(modelName);

    stdin.write("\r");
    await Bun.sleep(25);

    expect(submitted).toEqual(["/q"]);
    cleanup();
  });

  test("reopens suggestions after escape when input changes", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        onSubmit={() => true}
      />,
    );

    stdin.write("/q");
    await Bun.sleep(25);
    stdin.write("");
    await Bun.sleep(25);
    stdin.write("u");
    await Bun.sleep(25);

    expect(lastFrame()).toContain("❯ /quit");
    cleanup();
  });

  test("keeps history navigation when no suggestions are shown", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        history={{ entries: ["fix the bug"] }}
        onSubmit={() => true}
      />,
    );

    stdin.write("[A");
    await Bun.sleep(25);

    expect(lastFrame()).toContain("fix the bug");
    cleanup();
  });
});

describe("bash result view", () => {
  test("renders the command and the output preview", () => {
    const { lastFrame, cleanup } = render(
      <BashResultView
        detail={{
          command: "git status",
          outputPreview: ["On branch main", "nothing to commit"],
          omittedOutputLines: 0,
        }}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("$ git status");
    expect(frame).toContain("On branch main");
    expect(frame).toContain("nothing to commit");
    cleanup();
  });

  test("truncates multi-line commands and reports omitted output", () => {
    const { lastFrame, cleanup } = render(
      <BashResultView
        detail={{
          command: "line one\nline two\nline three\nline four",
          outputPreview: ["tail line"],
          omittedOutputLines: 12,
          outputFilePath: "/tmp/task-1.log",
        }}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("$ line one");
    expect(frame).toContain("line two");
    expect(frame).not.toContain("line three");
    expect(frame).toContain("… +2 more lines");
    expect(frame).toContain("tail line");
    expect(frame).toContain("… +12 lines (full output: /tmp/task-1.log)");
    cleanup();
  });

  test("renders the bash detail attached to a timeline item", () => {
    const { lastFrame, cleanup } = render(
      <Timeline
        items={[
          {
            id: "1",
            text: "Bash Stage all changes -> exit 0",
            status: "ok",
            bash: {
              command: "git add -A",
              outputPreview: ["2 files changed"],
              omittedOutputLines: 0,
            },
          },
        ]}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Bash Stage all changes -> exit 0");
    expect(frame).toContain("$ git add -A");
    expect(frame).toContain("2 files changed");
    cleanup();
  });
});

describe("diff view", () => {
  test("renders added, removed and context lines with line numbers", () => {
    const { lastFrame, cleanup } = render(
      <DiffView
        hunks={[
          {
            oldStart: 10,
            oldLines: 3,
            newStart: 10,
            newLines: 3,
            lines: [" alpha", "-beta", "+delta", " gamma"],
          },
        ]}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("10   alpha");
    expect(frame).toContain("11 - beta");
    expect(frame).toContain("11 + delta");
    expect(frame).toContain("12   gamma");
    cleanup();
  });

  test("caps displayed lines and reports the hidden count", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `+line ${index}`);
    const { lastFrame, cleanup } = render(
      <DiffView
        hunks={[{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 30, lines }]}
        maxLines={5}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("line 4");
    expect(frame).not.toContain("line 5");
    expect(frame).toContain("+25 more lines");
    cleanup();
  });

  test("renders the diff attached to a timeline item", () => {
    const { lastFrame, cleanup } = render(
      <Timeline
        items={[
          {
            id: "1",
            text: "Edit notes.txt -> +1 -1",
            status: "ok",
            diff: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-beta", "+delta"],
              },
            ],
          },
        ]}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Edit notes.txt -> +1 -1");
    expect(frame).toContain("- beta");
    expect(frame).toContain("+ delta");
    cleanup();
  });
});

const TEST_PROFILES_JSON = JSON.stringify({
  default: "deepseek",
  profiles: {
    deepseek: {
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com/v1",
      apiKey: "sk-deepseek",
      contextWindowTokens: 256 * 1024,
      maxSupportedOutputTokens: 64 * 1024,
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
  const profileBinding = { ...baseBinding, profileName: "deepseek" };
  return {
    ...base,
    switchModel,
    getBinding: () => profileBinding,
  };
}

describe("model switching", () => {
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
