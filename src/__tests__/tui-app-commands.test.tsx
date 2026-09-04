import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ContextManagerError } from "../context/context-manager";
import type { SessionId } from "../ids/runtime-id";
import { runtimeIdFactory } from "../ids/runtime-id";
import type { McpInventorySnapshot } from "../mcp/mcp-manager";
import { App } from "../tui/app";
import type { ProjectSlashCommand } from "../tui/project-slash-commands";
import { PromptHistory } from "../tui/prompt-history";
import type { TuiSessionController } from "../tui/tui-session-controller";
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

describe("TUI local commands", () => {
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
    expect(lastFrame()).toContain("Bash guard");
    expect(lastFrame()).toContain("model window: 256K");
    expect(lastFrame()).toContain("request max output: 64K");
    expect(runCalls).toBe(0);

    await submitInput(stdin, "/nope");
    await Bun.sleep(25);
    expect(lastFrame()).not.toContain("Bash guard");
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
              summary: "Recorded the Tinker quality gate rule.",
              sourceWorkspace: "/tmp/tinker",
              sourceSessionId: "source-session",
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

  test("runs /undo locally and renders the restore result", async () => {
    let runCalls = 0;
    let undoCalls = 0;
    const controller = createSessionController(createProjectionStore(), async () => {
      runCalls += 1;
      return completedResult();
    });
    controller.undo = async () => {
      undoCalls += 1;
      return {
        status: "restored",
        turnNumber: 7,
        restoredFileCount: 2,
        deletedFileCount: 1,
      };
    };
    const { stdin, lastFrame, cleanup } = render(
      <App sessionController={controller} />,
    );

    await submitInput(stdin, "/undo");
    await Bun.sleep(30);
    expect(lastFrame()).toContain(
      "Restored workspace to before turn 7: 2 files restored, 1 file deleted.",
    );
    expect(undoCalls).toBe(1);
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
    expect(lastFrame()).toContain("available through RecallSearch and RecallGet");
    expect(retireCalls).toBe(1);
    expect(runCalls).toBe(0);
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
});
