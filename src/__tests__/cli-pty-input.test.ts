import { expect, test } from "bun:test";
import {
  onlyNonEmptySession,
  promptHistoryEntries,
  quitTui,
  storedSessions,
  submitPrompt,
  waitForInitialFrame,
  waitForPromptReady,
  withSessionDatabase,
} from "./helpers/pty-product-test-support";
import { type PtyKey, type PtyTuiHarness, withPtyTui } from "./helpers/pty-tui-harness";

test(
  "PTY-101: preserves multiline Unicode editing and Prompt history",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-prompt-input", rows: 70, columns: 140 },
      async (harness) => {
        await waitForInitialFrame(harness);
        await waitForPromptReady(harness);

        await harness.paste("first\nsecond\nthird");
        await harness.waitForScreen("first\nsecond\nthird");
        await pressAndWaitForRedraw(harness, "ctrl_a");
        await pressAndWaitForRedraw(harness, "ctrl_a");
        await harness.type(">");
        await harness.waitForScreen("first\n>second\nthird");
        await pressAndWaitForRedraw(harness, "ctrl_e");
        await pressAndWaitForRedraw(harness, "ctrl_e");
        await harness.type("<");
        await harness.waitForScreen("first\n>second\nthird<");
        await pressAndWaitForRedraw(harness, "left");
        await harness.press("ctrl_u");
        await harness.waitForScreen("first\n>second\n<");
        await harness.type("中文");
        await harness.waitForScreen("first\n>second\n中文<");
        await harness.press("enter");
        await harness.waitForScreen("PTY_PROMPT_FIRST_DONE");

        await waitForPromptReady(harness);
        await harness.type("草稿");
        await harness.waitForScreen("草稿");
        await pressAndWaitForRedraw(harness, "up");
        await harness.press("up");
        await harness.waitForScreen(
          (screen) => occurrences(screen, "first\n>second\n中文<") >= 2,
        );
        await harness.press("down");
        await harness.waitForScreen("草稿");
        await pressAndWaitForRedraw(harness, "ctrl_e");
        await harness.type("-恢复");
        await harness.waitForScreen("草稿-恢复");
        await harness.press("enter");
        await harness.waitForScreen("PTY_PROMPT_DRAFT_DONE");

        await waitForPromptReady(harness);
        await harness.press("up");
        await harness.waitForScreen((screen) => occurrences(screen, "草稿-恢复") >= 2);
        await harness.type("-重提");
        await harness.waitForScreen("草稿-恢复-重提");
        await harness.press("enter");
        await harness.waitForScreen("PTY_PROMPT_HISTORY_DONE");

        await quitTui(harness);
        const session = await onlyNonEmptySession(harness.workspaceRoot);
        withSessionDatabase(harness.workspaceRoot, session, (database) => {
          expect(
            database
              .query(
                "SELECT content FROM messages WHERE role = 'user' ORDER BY ordinal",
              )
              .all(),
          ).toEqual([
            { content: "first\n>second\n中文<" },
            { content: "草稿-恢复" },
            { content: "草稿-恢复-重提" },
          ]);
        });
        expect(await promptHistoryEntries(harness.workspaceRoot)).toEqual([
          "first\n>second\n中文<",
          "草稿-恢复",
          "草稿-恢复-重提",
        ]);
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-102: discovers and executes slash commands entirely from the keyboard",
  async () => {
    await withPtyTui(
      {
        fakeModel: "pty-local-panels",
        rows: 50,
        columns: 120,
        environment: {
          TINKER_TEST_FAKE_MODEL_REQUEST_LOG: "model-requests.jsonl",
        },
      },
      async (harness) => {
        await waitForInitialFrame(harness);
        await waitForPromptReady(harness);

        await harness.type("/st");
        await harness.waitForScreen("❯ /status");
        await harness.press("tab");
        await harness.waitForScreen(
          (screen) =>
            screen.includes("/status") &&
            !screen.includes("Show session and context details"),
          { message: "Tab-completed /status input" },
        );
        await harness.press("enter");
        await harness.waitForScreen("Measurement");

        await waitForPromptReady(harness);
        await harness.type("/");
        await harness.waitForScreen("❯ /status");
        await harness.press("down");
        await harness.waitForScreen("❯ /skills");
        await harness.press("up");
        await harness.waitForScreen("❯ /status");
        await harness.press("down");
        await harness.waitForScreen("❯ /skills");
        await harness.press("enter");
        await harness.waitForScreen("Agent Skills");

        await waitForPromptReady(harness);
        await harness.type("/m");
        await harness.waitForScreen("❯ /mcp");
        await harness.press("escape");
        await harness.waitForScreen(
          (screen) => !screen.includes("❯ /mcp") && screen.includes("pty-test-model"),
          { message: "slash suggestions dismissed without closing the TUI" },
        );
        await harness.press("ctrl_u");
        await waitForPromptReady(harness);

        expect(
          await Bun.file(`${harness.workspaceRoot}/model-requests.jsonl`).exists(),
        ).toBe(false);
        expect(await promptHistoryEntries(harness.workspaceRoot)).toEqual([]);
        await quitTui(harness);

        const sessions = await storedSessions(harness.workspaceRoot);
        expect(sessions).toHaveLength(0);
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-103: inserts a ranked workspace path and expands a project command",
  async () => {
    await withPtyTui(
      {
        fakeModel: "pty-file-command",
        rows: 70,
        columns: 140,
        workspaceFiles: {
          ".tinker.json": JSON.stringify({
            version: 1,
            slashCommands: [
              {
                name: "review-changes",
                description: "Review fixture files",
                prompt: "Review shallow and deep files.\nReturn exact marker.",
              },
            ],
          }),
          "README.md": "root\n",
          "src/index.ts": "export const index = true;\n",
          "src/deep/file.ts": "export const deep = true;\n",
        },
      },
      async (harness) => {
        await waitForInitialFrame(harness);
        await waitForPromptReady(harness);

        await harness.type("open @");
        await harness.waitForScreen("src/deep/file.ts");
        const suggestions = harness.screenText();
        expect(suggestions.indexOf("README.md")).toBeLessThan(
          suggestions.indexOf("src/index.ts"),
        );
        expect(suggestions.indexOf("src/index.ts")).toBeLessThan(
          suggestions.indexOf("src/deep/file.ts"),
        );
        await harness.press("down");
        await harness.waitForScreen("❯ README.md");
        await harness.press("down");
        await harness.waitForScreen("❯ src/index.ts");
        await harness.press("enter");
        await harness.waitForScreen(
          (screen) =>
            screen.includes("open src/index.ts") &&
            !screen.includes("❯ src/index.ts") &&
            !screen.includes("src/deep/file.ts"),
          { message: "selected file inserted and popup closed" },
        );
        await harness.type("now");
        await harness.waitForScreen("open src/index.ts now");
        await harness.press("enter");
        await harness.waitForScreen("PTY_FILE_SELECTION_DONE");

        await submitPrompt(harness, "/review-changes");
        await harness.waitForScreen("PTY_PROJECT_COMMAND_DONE");
        expect(harness.screenText()).toContain(
          "Review shallow and deep files.\nReturn exact marker.",
        );

        await quitTui(harness);
        const session = await onlyNonEmptySession(harness.workspaceRoot);
        withSessionDatabase(harness.workspaceRoot, session, (database) => {
          expect(
            database
              .query(
                "SELECT content FROM messages WHERE role = 'user' ORDER BY ordinal",
              )
              .all(),
          ).toEqual([
            { content: "open src/index.ts now" },
            {
              content: "Review shallow and deep files.\nReturn exact marker.",
            },
          ]);
        });
        expect(await promptHistoryEntries(harness.workspaceRoot)).toEqual([
          "open src/index.ts now",
          "Review shallow and deep files.\nReturn exact marker.",
        ]);
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-107: navigates a full-screen UTF-8 file viewer and restores the TUI",
  async () => {
    const viewedFile = Array.from({ length: 80 }, (_, index) => {
      const line = index + 1;
      return line === 1
        ? `LINE_001:${"ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(8)}`
        : `LINE_${String(line).padStart(3, "0")}: 中文 viewer row ${line}`;
    }).join("\n");

    await withPtyTui(
      {
        fakeModel: "pty-viewer",
        rows: 30,
        columns: 60,
        workspaceFiles: { "long-view.txt": viewedFile },
      },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_VIEW_SEED");
        await harness.waitForScreen("PTY_VIEW_SEED_DONE");

        await submitPrompt(harness, "/view long-view.txt");
        await harness.waitForScreen("1–27 / 80");
        let screen = harness.screenText();
        expect(screen).toContain("View: long-view.txt");
        expect(screen).not.toContain("Tinker");
        expect(screen).not.toContain('Enter a coding request, or "/" for commands');

        await harness.press("right");
        await harness.waitForScreen("column 9");
        expect(harness.screenText()).not.toContain("LINE_001:");
        await harness.press("left");
        await harness.waitForScreen(
          (current) => current.includes("1–27 / 80") && !current.includes("column"),
        );
        await harness.press("down");
        await harness.waitForScreen("2–28 / 80");
        await harness.press("up");
        await harness.waitForScreen("1–27 / 80");
        await harness.press("page_down");
        await harness.waitForScreen("28–54 / 80");
        await harness.press("end");
        await harness.waitForScreen("54–80 / 80");
        await harness.press("home");
        await harness.waitForScreen("1–27 / 80");

        await harness.press("escape");
        await harness.waitForScreen("PTY_VIEW_SEED_DONE");
        screen = harness.screenText();
        expect(screen).toContain("Tinker");
        expect(screen).toContain("PTY_VIEW_SEED");
        await submitPrompt(harness, "PTY_VIEW_CONTINUE");
        await harness.waitForScreen("PTY_VIEW_CONTINUED");

        await quitTui(harness);
        const session = await onlyNonEmptySession(harness.workspaceRoot);
        expect(session.turnCount).toBe(2);
        expect(await promptHistoryEntries(harness.workspaceRoot)).toEqual([
          "PTY_VIEW_SEED",
          "PTY_VIEW_CONTINUE",
        ]);
      },
    );
  },
  { timeout: 30_000 },
);

async function pressAndWaitForRedraw(
  harness: PtyTuiHarness,
  key: PtyKey,
): Promise<void> {
  const mark = harness.markTranscript();
  await harness.press(key);
  await harness.waitForTranscript((output) => output.length > 0, {
    since: mark,
    message: `${key} redraw`,
  });
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
