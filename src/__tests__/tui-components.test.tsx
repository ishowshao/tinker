import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { loadPackageMetadata } from "../cli/package-metadata";
import type { SessionId } from "../ids/runtime-id";
import type { ModelUsage } from "../model/model-client";
import { AskUser } from "../tui/components/ask-user";
import { BackgroundTasks } from "../tui/components/background-tasks";
import { BashConfirmation } from "../tui/components/bash-confirmation";
import { BashResultView } from "../tui/components/bash-result-view";
import { ContextStatus } from "../tui/components/context-status";
import { DiffView } from "../tui/components/diff-view";
import { Footer } from "../tui/components/footer";
import { Header } from "../tui/components/header";
import { McpPanel } from "../tui/components/mcp-panel";
import { PromptInput } from "../tui/components/prompt-input";
import { Timeline } from "../tui/components/timeline";
import { createInitialTuiState } from "../tui/event-store";
import { contextSnapshot, testRuntime } from "./helpers/tui-components-support";
import { TEST_CONTEXT_BUDGET, TEST_CONTEXT_PROFILE } from "./test-runtime";

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

function providerUsage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    promptTokens: 10_000,
    completionTokens: 500,
    totalTokens: 10_500,
    ...overrides,
  };
}

function renderPromptWithUsage(usage: ModelUsage | undefined) {
  return render(
    <PromptInput
      modelName="deepseek-v4-flash"
      workspaceRoot="/tmp/tinker"
      gitBranch="main"
      contextUsage={contextSnapshot(
        usage === undefined ? {} : { lastProviderUsage: usage },
      )}
      onSubmit={() => true}
    />,
  );
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

  test("renders plan progress with explanation and step states", () => {
    const { lastFrame, cleanup } = render(
      <Timeline
        items={[
          {
            id: "tool-plan",
            text: "UpdatePlan -> 1/3 completed",
            status: "ok",
            plan: {
              explanation: "Adjusted after inspection.",
              steps: [
                { step: "Inspect implementation", status: "completed" },
                { step: "Add coverage", status: "in_progress" },
                { step: "Run checks", status: "pending" },
              ],
            },
          },
        ]}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("UpdatePlan -> 1/3 completed");
    expect(frame).toContain("Adjusted after inspection.");
    expect(frame).toContain("✓ Inspect implementation");
    expect(frame).toContain("→ Add coverage");
    expect(frame).toContain("• Run checks");
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

  test("renders and resolves the dangerous Bash confirmation panel", async () => {
    const decisions: string[] = [];
    const panel = render(
      <BashConfirmation
        command="rm -rf /"
        reason="recursive forced removal targets a protected root"
        onDecision={(decision) => decisions.push(decision)}
      />,
    );

    expect(panel.lastFrame()).toContain("Dangerous Bash command");
    expect(panel.lastFrame()).toContain("rm -rf /");
    expect(panel.lastFrame()).toContain("y allow / n deny / Esc cancel turn");
    panel.stdin.write("n");
    await Bun.sleep(10);
    expect(decisions).toEqual(["deny"]);
    panel.cleanup();
  });

  test("uses the latest selection for rapid arrow/Enter input", async () => {
    const selections: number[] = [];
    const panel = render(
      <AskUser
        title="Provider request failed"
        question="Automatic retries exhausted"
        dismissLabel="end this turn"
        options={[{ description: "Retry again" }, { description: "End this turn" }]}
        onSelect={(index) => selections.push(index)}
        onDismiss={() => undefined}
      />,
    );
    panel.stdin.write("\u001b[B");
    panel.stdin.write("\r");
    await Bun.sleep(10);
    expect(selections).toEqual([1]);
    expect(panel.lastFrame()).toContain("Provider request failed");
    expect(panel.lastFrame()).toContain("Esc end this turn");
    panel.cleanup();
  });

  test("supports keyboard selection and dismissal for AskUser", async () => {
    const selections: number[] = [];
    let dismissed = 0;
    const panel = render(
      <AskUser
        question="Which scope?"
        options={[{ description: "Project" }, { description: "Global" }]}
        onSelect={(index) => selections.push(index)}
        onDismiss={() => {
          dismissed += 1;
        }}
      />,
    );
    expect(panel.lastFrame()).toContain("Tinker asks");
    expect(panel.lastFrame()).toContain("❯ 1. Project");
    panel.stdin.write("\u001b[B");
    await Bun.sleep(10);
    expect(panel.lastFrame()).toContain("❯ 2. Global");
    panel.stdin.write("\r");
    await Bun.sleep(10);
    expect(selections).toEqual([1]);
    panel.cleanup();

    const dismissPanel = render(
      <AskUser
        question="Dismiss?"
        options={[{ description: "One" }, { description: "Two" }]}
        onSelect={() => undefined}
        onDismiss={() => {
          dismissed += 1;
        }}
      />,
    );
    dismissPanel.stdin.write("\u001b");
    await Bun.sleep(30);
    expect(dismissed).toBe(1);
    dismissPanel.cleanup();
  });

  test("marks the footer while yolo mode is enabled", () => {
    const footer = render(<Footer status="idle" yolo />);
    expect(footer.lastFrame()).toContain("idle · yolo");
    footer.cleanup();
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

  test("renders context usage in the prompt input status bar", async () => {
    const { version } = await loadPackageMetadata();
    const normal = render(
      <PromptInput
        modelName="deepseek-v4-flash"
        version={version}
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
    expect(normal.lastFrame()).toEndWith(`· tinker ${version}`);
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

  test("hides the cache segment without provider usage", () => {
    const noContextUsage = render(
      <PromptInput
        modelName="deepseek-v4-flash"
        workspaceRoot="/tmp/tinker"
        gitBranch="main"
        onSubmit={() => true}
      />,
    );
    expect(noContextUsage.lastFrame()).not.toContain("cache");
    noContextUsage.cleanup();

    const noLastUsage = renderPromptWithUsage(undefined);
    expect(noLastUsage.lastFrame()).not.toContain("cache");
    noLastUsage.cleanup();

    const noCacheFields = renderPromptWithUsage(providerUsage());
    expect(noCacheFields.lastFrame()).not.toContain("cache");
    noCacheFields.cleanup();

    const zeroTotal = renderPromptWithUsage(
      providerUsage({ promptCacheHitTokens: 0, promptCacheMissTokens: 0 }),
    );
    expect(zeroTotal.lastFrame()).not.toContain("cache");
    zeroTotal.cleanup();
  });

  test("renders the latest provider cache hit rate", () => {
    const missOnly = renderPromptWithUsage(
      providerUsage({ promptCacheHitTokens: 0, promptCacheMissTokens: 10_000 }),
    );
    expect(missOnly.lastFrame()).toContain("cache 0%");
    missOnly.cleanup();

    const partial = renderPromptWithUsage(
      providerUsage({ promptCacheHitTokens: 7_200, promptCacheMissTokens: 2_800 }),
    );
    expect(partial.lastFrame()).toContain("cache 72%");
    partial.cleanup();

    const hitOnly = renderPromptWithUsage(
      providerUsage({ promptCacheHitTokens: 10_000, promptCacheMissTokens: 0 }),
    );
    expect(hitOnly.lastFrame()).toContain("cache 100%");
    hitOnly.cleanup();

    const rounded = renderPromptWithUsage(
      providerUsage({ promptCacheHitTokens: 2, promptCacheMissTokens: 3 }),
    );
    expect(rounded.lastFrame()).toContain("cache 40%");
    rounded.cleanup();
  });

  test("floors near-total cache hit rates to 99% instead of rounding to 100%", () => {
    // 99.95% hit rate: an append turn into a large cached prompt must not
    // display as a misleading 100%.
    const nearFull = renderPromptWithUsage(
      providerUsage({ promptCacheHitTokens: 19_990, promptCacheMissTokens: 10 }),
    );
    expect(nearFull.lastFrame()).toContain("cache 99%");
    expect(nearFull.lastFrame()).not.toContain("cache 100%");
    nearFull.cleanup();

    // Exactly at the old Math.round boundary (99.5%) still floors to 99%.
    const boundary = renderPromptWithUsage(
      providerUsage({ promptCacheHitTokens: 199, promptCacheMissTokens: 1 }),
    );
    expect(boundary.lastFrame()).toContain("cache 99%");
    boundary.cleanup();
  });

  test("replaces and clears the cache segment on rerender", () => {
    const view = renderPromptWithUsage(
      providerUsage({ promptCacheHitTokens: 9_400, promptCacheMissTokens: 600 }),
    );
    expect(view.lastFrame()).toContain("cache 94%");

    view.rerender(
      <PromptInput
        modelName="deepseek-v4-flash"
        workspaceRoot="/tmp/tinker"
        gitBranch="main"
        contextUsage={contextSnapshot({
          lastProviderUsage: providerUsage({
            promptCacheHitTokens: 1_000,
            promptCacheMissTokens: 1_000,
          }),
        })}
        onSubmit={() => true}
      />,
    );
    expect(view.lastFrame()).toContain("cache 50%");
    expect(view.lastFrame()).not.toContain("cache 94%");

    view.rerender(
      <PromptInput
        modelName="deepseek-v4-flash"
        workspaceRoot="/tmp/tinker"
        gitBranch="main"
        contextUsage={contextSnapshot({
          lastProviderUsage: providerUsage(),
        })}
        onSubmit={() => true}
      />,
    );
    expect(view.lastFrame()).not.toContain("cache");
    view.cleanup();
  });

  test("keeps the cache segment across context pressure states", () => {
    for (const pressure of ["normal", "triggered", "blocked"] as const) {
      const view = render(
        <PromptInput
          modelName="deepseek-v4-flash"
          workspaceRoot="/tmp/tinker"
          gitBranch="main"
          contextUsage={contextSnapshot({
            pressure,
            lastProviderUsage: providerUsage({
              promptCacheHitTokens: 500,
              promptCacheMissTokens: 500,
            }),
          })}
          onSubmit={() => true}
        />,
      );
      expect(view.lastFrame()).toContain("cache 50%");
      view.cleanup();
    }
  });

  test("renders the full ContextStatus panel sections without viewport clipping", () => {
    const view = render(
      <ContextStatus
        state={{
          ...createInitialTuiState({
            sessionId: "session-1",
            modelName: "model",
            workspaceRoot: "/tmp/tinker",
          }),
          contextUsage: contextSnapshot(),
          contextProfile: TEST_CONTEXT_PROFILE,
          contextBudget: TEST_CONTEXT_BUDGET,
        }}
        bashGuard={{ mode: "guard", source: "default" }}
      />,
    );
    const frame = view.lastFrame();
    expect(frame).toContain("Session");
    expect(frame).toContain("Bash guard");
    expect(frame).toContain("mode: guard (source: default)");
    expect(frame).toContain("Context");
    expect(frame).toContain("Measurement");
    expect(frame).toContain("Estimator");
    view.cleanup();
  });

  test("renders an empty MCP runtime inventory", () => {
    const { lastFrame, cleanup } = render(<McpPanel snapshot={{ servers: [] }} />);

    expect(lastFrame()).toContain("MCP Tools");
    expect(lastFrame()).toContain("no MCP servers configured");
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
            tty: true,
          },
        ]}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Background tasks");
    expect(frame).toContain("✔ completed tty Start development server exit=0");
    expect(frame).toContain(
      "id=task-019f · started=2026-07-10T10:00:00.000Z · ended=2026-07-10T10:01:00.000Z",
    );
    cleanup();
  });

  test("shows only two background tasks and summarizes the remainder", () => {
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
      tty: false,
    }));
    const { lastFrame, cleanup } = render(<BackgroundTasks tasks={tasks} />);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Task 1");
    expect(frame).toContain("Task 2");
    expect(frame).not.toContain("Task 3");
    expect(frame).not.toContain("Task 7");
    expect(frame).toContain("+5 more");
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
