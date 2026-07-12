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
import { TuiProjectionStore } from "../tui/tui-projection-store";
import type { SlashCommand } from "../tui/slash-commands";
import type { SessionId } from "../ids/runtime-id";
import type { ContextUsageSnapshot } from "../agent/context-meter";
import type { RunAgentResult } from "../agent/types";
import type { TuiSessionController } from "../tui/tui-session-controller";
import type { SessionSummary } from "../session/session-catalog";
import { ContextBudgetExceededError } from "../model/model-request-preflight";
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
): TuiSessionController {
  const binding = {
    sessionId: "session-1" as SessionId,
    modelName: "model",
    workspaceRoot: "/tmp/tinker",
    projectionStore,
    executeTurn: run,
  };
  return {
    getBinding: () => binding,
    subscribe: () => () => undefined,
    listSessions: async () => [],
    resume: async () => {
      throw new Error("not used");
    },
    delete: async () => {
      throw new Error("not used");
    },
  };
}

async function submitInput(stdin: { write: (data: string) => void }, value: string) {
  stdin.write(value);
  await Bun.sleep(15);
  stdin.write("\r");
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
        onSubmit={() => undefined}
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
        onSubmit={() => undefined}
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
              data: { userPrompt: prompt },
            });
            await projectionStore.append({
              type: "model.request.started",
              ...testRuntime.iteration,
              eventSequence: 2,
              timestamp: "2026-07-10T00:00:00.100Z",
              data: {},
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
                  }, 40);
                },
                { once: true },
              );
            });
          },
        )}
      />,
    );

    await submitInput(stdin, "wait");
    await Bun.sleep(20);
    stdin.write("\u001b");
    await Bun.sleep(25);
    stdin.write("\u001b");
    await Bun.sleep(25);

    expect(lastFrame()).toContain("cancelling");
    expect(abortCount).toBe(1);

    await Bun.sleep(60);
    expect(lastFrame()).toContain("cancelled");
    expect(lastFrame()).not.toContain("Cancelling current turn...");

    await submitInput(stdin, "/nope");
    await Bun.sleep(25);
    expect(lastFrame()).toContain("Unknown command: /nope");
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

    await submitInput(stdin, "/resume");
    await Bun.sleep(25);
    expect(lastFrame()).toContain("Resume session");
    expect(lastFrame()).toContain(
      "↑/↓ or j/k to move · Enter to resume · Esc to cancel",
    );
    expect(lastFrame()).toContain("帮我提交推送");

    stdin.write("\u001b");
    await Bun.sleep(25);
    expect(lastFrame()).not.toContain("Resume session");
    expect(resumed).toEqual([]);

    await submitInput(stdin, "/resume");
    await Bun.sleep(25);
    stdin.write("\r");
    await Bun.sleep(25);
    expect(resumed).toEqual([targetId]);
    expect(lastFrame()).toContain(`Resumed session ${targetId}.`);

    await submitInput(stdin, `/resume ${directTargetId}`);
    await Bun.sleep(25);
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
        onSubmit={() => undefined}
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
        onSubmit={(value) => submitted.push(value)}
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

    expect(submitted).toEqual(["/quit "]);
    cleanup();
  });

  test("accepts the selected suggestion on enter", async () => {
    const submitted: string[] = [];
    const { stdin, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        onSubmit={(value) => submitted.push(value)}
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
        onSubmit={(value) => submitted.push(value)}
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
        onSubmit={(value) => submitted.push(value)}
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
        onSubmit={() => undefined}
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
        onSubmit={() => undefined}
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
