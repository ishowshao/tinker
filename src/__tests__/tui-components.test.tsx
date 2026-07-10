import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Header } from "../tui/components/header";
import { BashResultView } from "../tui/components/bash-result-view";
import { DiffView } from "../tui/components/diff-view";
import { Timeline } from "../tui/components/timeline";
import { Footer } from "../tui/components/footer";
import { App } from "../tui/app";
import { PromptInput } from "../tui/components/prompt-input";
import { TuiEventStream } from "../events/tui-event-stream";
import type { SlashCommand } from "../tui/slash-commands";

describe("tui components", () => {
  test("renders header metadata", () => {
    const { lastFrame, cleanup } = render(
      <Header
        modelName="deepseek-v4-flash"
        workspaceRoot="/tmp/tinker"
        runId="run-1"
      />,
    );

    expect(lastFrame()).toContain("deepseek-v4-flash");
    expect(lastFrame()).toContain("tinker");
    expect(lastFrame()).toContain("run-1");
    cleanup();
  });

  test("renders timeline tool status", () => {
    const { lastFrame, cleanup } = render(
      <Timeline
        events={[
          { type: "model.step.started", step: 1 },
          {
            type: "tool.started",
            step: 1,
            call: {
              id: "call_1",
              name: "Read",
              args: { file_path: "README.md" },
            },
          },
          {
            type: "tool.finished",
            step: 1,
            call: {
              id: "call_1",
              name: "Read",
              args: { file_path: "README.md" },
            },
            ok: true,
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
    const { lastFrame, cleanup } = render(<Footer status="done" />);

    expect(lastFrame()).toContain("done");
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

  test("submits /quit to the app quit handler", async () => {
    let quitCount = 0;
    let runCount = 0;
    const { stdin, cleanup } = render(
      <App
        modelName="model"
        workspaceRoot="/tmp/tinker"
        runId="run-1"
        eventStream={new TuiEventStream()}
        run={async () => {
          runCount += 1;
          return { ok: true, finalText: "", messages: [] };
        }}
        onQuit={() => {
          quitCount += 1;
        }}
      />,
    );

    stdin.write("/quit\n");
    await Bun.sleep(25);

    expect(quitCount).toBe(1);
    expect(runCount).toBe(0);
    cleanup();
  });

  test("intercepts unknown slash commands instead of running them", async () => {
    let runCount = 0;
    const { stdin, lastFrame, cleanup } = render(
      <App
        modelName="model"
        workspaceRoot="/tmp/tinker"
        runId="run-1"
        eventStream={new TuiEventStream()}
        run={async () => {
          runCount += 1;
          return { ok: true, finalText: "", messages: [] };
        }}
        onQuit={() => undefined}
      />,
    );

    stdin.write("/nope\n");
    await Bun.sleep(25);

    expect(runCount).toBe(0);
    expect(lastFrame()).toContain("Unknown command: /nope");
    cleanup();
  });
});

describe("prompt input slash commands", () => {
  const commands: readonly SlashCommand[] = [
    { name: "quit", description: "Exit the TUI" },
    { name: "quiet", description: "Toggle quiet mode" },
  ];

  test("shows suggestions while typing a slash command", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput commands={commands} onSubmit={() => undefined} />,
    );

    stdin.write("/qui");
    await Bun.sleep(25);

    expect(lastFrame()).toContain("❯ /quit");
    expect(lastFrame()).toContain("Exit the TUI");
    expect(lastFrame()).toContain("/quiet");
    cleanup();
  });

  test("completes the selected command with tab", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput commands={commands} onSubmit={(value) => submitted.push(value)} />,
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
      <PromptInput commands={commands} onSubmit={(value) => submitted.push(value)} />,
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
      <PromptInput commands={commands} onSubmit={(value) => submitted.push(value)} />,
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
      <PromptInput commands={commands} onSubmit={(value) => submitted.push(value)} />,
    );

    stdin.write("/q");
    await Bun.sleep(25);
    stdin.write("");
    await Bun.sleep(25);

    expect(lastFrame()).not.toContain("Exit the TUI");

    stdin.write("\r");
    await Bun.sleep(25);

    expect(submitted).toEqual(["/q"]);
    cleanup();
  });

  test("reopens suggestions after escape when input changes", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput commands={commands} onSubmit={() => undefined} />,
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
