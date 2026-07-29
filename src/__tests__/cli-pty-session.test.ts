import { expect, test } from "bun:test";
import clipboard from "clipboardy";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ptyCopyMarkdownResponse } from "../model/fake-model-client";
import {
  currentSessionId,
  promptHistoryEntries,
  quitTui,
  sessionSummary,
  storedSessions,
  submitPrompt,
  waitForInitialFrame,
  withSessionDatabase,
} from "./helpers/pty-product-test-support";
import {
  createPtyTuiFixture,
  type PtyTuiHarness,
  withPtyTui,
} from "./helpers/pty-tui-harness";

test(
  "PTY-104: clears into a new session and resumes the complete old session",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-clear", rows: 60, columns: 140 },
      async (harness) => {
        await waitForInitialFrame(harness);
        const sourceId = currentSessionId(harness.screenText());
        await submitPrompt(harness, "PTY_CLEAR_SEED");
        await harness.waitForScreen("PTY_CLEAR_SEED_DONE");

        await submitPrompt(harness, "/clear");
        await harness.waitForScreen("Previous session remains available via /resume.");
        const freshScreen = harness.screenText();
        const freshId = currentSessionId(freshScreen);
        expect(freshId).not.toBe(sourceId);
        expect(freshScreen).toContain("idle");
        expect(freshScreen).not.toContain("PTY_CLEAR_SEED");

        await submitPrompt(harness, `/resume ${sourceId}`);
        await harness.waitForScreen(`Resumed session ${sourceId}.`, {
          timeoutMs: 10_000,
        });
        expect(harness.screenText()).toContain("PTY_CLEAR_SEED_DONE");
        await submitPrompt(harness, "PTY_CLEAR_CONTINUE");
        await harness.waitForScreen("PTY_CLEAR_CONTINUED");

        await quitTui(harness);
        expect(await sessionSummary(harness.workspaceRoot, sourceId)).toMatchObject({
          sessionId: sourceId,
          turnCount: 2,
        });
        expect(await sessionSummary(harness.workspaceRoot, freshId)).toMatchObject({
          sessionId: freshId,
          turnCount: 0,
        });
        withSessionDatabase(
          harness.workspaceRoot,
          { sessionId: sourceId },
          (database) => {
            expect(
              database
                .query(
                  "SELECT content FROM messages WHERE role = 'user' ORDER BY ordinal",
                )
                .all(),
            ).toEqual([
              { content: "PTY_CLEAR_SEED" },
              { content: "PTY_CLEAR_CONTINUE" },
            ]);
          },
        );
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-113: resumes long static history at the visible viewport tail",
  async () => {
    const fixture = await createPtyTuiFixture({
      workspaceFiles: longResumeWorkspaceFiles(),
    });
    let first: PtyTuiHarness | undefined;
    let second: PtyTuiHarness | undefined;
    try {
      first = await fixture.start({
        fakeModel: "pty-resume-layout",
        rows: 48,
        columns: 162,
      });
      await waitForInitialFrame(first);
      const sourceId = currentSessionId(first.screenText());
      let activeSessionId = sourceId;
      for (let turn = 1; turn <= 3; turn += 1) {
        await submitPrompt(first, `PTY_RESUME_LAYOUT_${turn}`);
        await first.waitForScreen(`PTY_RESUME_LAYOUT_${turn}_FINAL_08`);
      }
      for (let index = 1; index <= 15; index += 1) {
        await submitPrompt(first, "/clear");
        await first.waitForScreen(
          (screen) => {
            const visibleSessionId = screen.match(/\bsession=([0-9a-f-]{36})\b/u)?.[1];
            return (
              screen.includes("Started new session") &&
              visibleSessionId !== undefined &&
              visibleSessionId !== activeSessionId
            );
          },
          { message: `fresh picker-padding session ${index}` },
        );
        activeSessionId = currentSessionId(first.screenText());
        const prompt = `PTY_RESUME_LAYOUT_PAD_${index}`;
        await submitPrompt(first, prompt);
        await first.waitForScreen(`${prompt}_DONE`);
      }
      await quitTui(first);
      await first.dispose();

      second = await fixture.start({
        fakeModel: "pty-resume-layout",
        rows: 48,
        columns: 162,
      });
      await waitForInitialFrame(second);
      await submitPrompt(second, "/resume");
      await second.waitForScreen("Showing 1–14 / 16");
      for (let index = 0; index < 15; index += 1) {
        await second.press("down");
      }
      await second.waitForScreen("PTY_RESUME_LAYOUT_1", {
        message: "the long source session selected in the picker",
      });
      await second.press("enter");
      await second.waitForScreen(`Resumed session ${sourceId}.`, {
        timeoutMs: 10_000,
      });
      await second.waitForScreen("mcp fixture connected -> 1 tool");
      await second.waitForScreen("PTY_RESUME_LAYOUT_3_FINAL_08", {
        timeoutMs: 1_000,
        message: "the resumed history tail in the current viewport",
      });
      expect(second.screenText().split("\n")).toHaveLength(47);
      await quitTui(second);
    } finally {
      await second?.dispose();
      await first?.dispose();
      await fixture.dispose();
    }
  },
  { timeout: 30_000 },
);

test(
  "PTY-114: restores the long-history viewport after closing transient surfaces",
  async () => {
    const fixture = await createPtyTuiFixture({
      workspaceFiles: transientSurfaceWorkspaceFiles(),
    });
    let harness: PtyTuiHarness | undefined;
    try {
      harness = await fixture.start({
        fakeModel: "pty-resume-layout",
        rows: 24,
        columns: 100,
        environment: { TINKER_MODELS: "models.json" },
      });
      const activeHarness = harness;
      await waitForInitialFrame(harness);
      let activeSessionId = currentSessionId(harness.screenText());
      for (let index = 1; index <= 7; index += 1) {
        const prompt = `PTY_RESUME_LAYOUT_PAD_${index}`;
        await submitPrompt(harness, prompt);
        await harness.waitForScreen(`${prompt}_DONE`);
        await submitPrompt(harness, "/clear");
        await harness.waitForScreen(
          (screen) => {
            const visibleSessionId = screen.match(/\bsession=([0-9a-f-]{36})\b/u)?.[1];
            return (
              screen.includes("Started new session") &&
              visibleSessionId !== undefined &&
              visibleSessionId !== activeSessionId
            );
          },
          { message: `fresh transient-surface session ${index}` },
        );
        activeSessionId = currentSessionId(harness.screenText());
      }

      await submitPrompt(harness, "PTY_RESUME_LAYOUT_1");
      await harness.waitForPromptReady(10_000);
      const tailSentinel = "PTY_RESUME_LAYOUT_1_FINAL_31";
      expect(harness.screenText()).toContain(tailSentinel);

      const observations: Array<{
        clearCount: number;
        surface: string;
        tailVisible: boolean;
        visibleRows: number;
      }> = [];
      const observeRestoredViewport = (surface: string, transcriptMark: number) => {
        const screen = activeHarness.screenText();
        observations.push({
          clearCount:
            activeHarness.transcriptSince(transcriptMark).split("\u001b[3J").length - 1,
          surface,
          tailVisible: screen.includes(tailSentinel),
          visibleRows: screen.split("\n").length,
        });
      };

      await submitPrompt(harness, "/view long-view.txt");
      await harness.waitForScreen("1–20 / 80");
      const viewCloseMark = harness.markTranscript();
      await harness.press("escape");
      await harness.waitForPromptReady();
      observeRestoredViewport("view", viewCloseMark);

      await submitPrompt(harness, "/memory");
      await harness.waitForScreen("No stored memories.");
      const memoryCloseMark = harness.markTranscript();
      await harness.press("escape");
      await harness.waitForPromptReady();
      observeRestoredViewport("memory", memoryCloseMark);

      await submitPrompt(harness, "/resume");
      await harness.waitForScreen("Showing 1–6 / 8");
      const resumeCloseMark = harness.markTranscript();
      await harness.press("escape");
      await harness.waitForPromptReady();
      observeRestoredViewport("resume", resumeCloseMark);

      await harness.resize(48, 100);
      await harness.waitForPromptReady();
      await submitPrompt(harness, "/status");
      await harness.waitForScreen("Measurement");
      const statusCloseMark = harness.markTranscript();
      await submitPrompt(harness, "/skills");
      await harness.waitForScreen("no skills available");
      observeRestoredViewport("status", statusCloseMark);

      const skillsCloseMark = harness.markTranscript();
      await submitPrompt(harness, "/mcp");
      await harness.waitForScreen("no MCP servers configured");
      observeRestoredViewport("skills", skillsCloseMark);

      const mcpCloseMark = harness.markTranscript();
      await submitPrompt(harness, "/not-a-command");
      await harness.waitForScreen("Unknown command: /not-a-command");
      observeRestoredViewport("mcp", mcpCloseMark);
      await harness.press("ctrl_u");

      expect(observations.slice(0, 3)).toEqual([
        { clearCount: 1, surface: "view", tailVisible: true, visibleRows: 23 },
        { clearCount: 1, surface: "memory", tailVisible: true, visibleRows: 23 },
        { clearCount: 1, surface: "resume", tailVisible: true, visibleRows: 23 },
      ]);
      for (const observation of observations.slice(3)) {
        expect(observation.clearCount).toBe(1);
        expect(observation.tailVisible).toBe(true);
        expect(observation.visibleRows).toBeGreaterThanOrEqual(44);
      }
      await quitTui(harness);
    } finally {
      await harness?.dispose();
      await fixture.dispose();
    }
  },
  { timeout: 30_000 },
);

test(
  "PTY-105: forks shared tool history into two independent branches",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-fork", rows: 70, columns: 140 },
      async (harness) => {
        await waitForInitialFrame(harness);
        const sourceId = currentSessionId(harness.screenText());
        await submitPrompt(harness, "PTY_FORK_SEED");
        await harness.waitForScreen("PTY_FORK_SEED_DONE");

        await submitPrompt(harness, "/fork");
        await harness.waitForScreen("Cloned current session as", {
          timeoutMs: 10_000,
        });
        const cloneId = currentSessionId(harness.screenText());
        expect(cloneId).not.toBe(sourceId);
        expect(harness.screenText()).toContain("Write pty-fork-shared.txt");

        await submitPrompt(harness, "CLONE_ONLY");
        await harness.waitForScreen("PTY_CLONE_ONLY_DONE");

        await submitPrompt(harness, `/resume ${sourceId}`);
        await harness.waitForScreen(`Resumed session ${sourceId}.`, {
          timeoutMs: 10_000,
        });
        expect(harness.screenText()).not.toContain("CLONE_ONLY");
        await submitPrompt(harness, "SOURCE_ONLY");
        await harness.waitForScreen("PTY_SOURCE_ONLY_DONE");

        await submitPrompt(harness, `/resume ${cloneId}`);
        await harness.waitForScreen(`Resumed session ${cloneId}.`, {
          timeoutMs: 10_000,
        });
        const cloneScreen = harness.screenText();
        expect(cloneScreen).toContain("CLONE_ONLY");
        expect(cloneScreen).not.toContain("SOURCE_ONLY");

        await quitTui(harness);
        expect(
          await readFile(
            path.join(harness.workspaceRoot, "pty-fork-shared.txt"),
            "utf8",
          ),
        ).toBe("PTY_FORK_SHARED_HISTORY\n");
        assertForkBranch(harness.workspaceRoot, sourceId, "SOURCE_ONLY");
        assertForkBranch(harness.workspaceRoot, cloneId, "CLONE_ONLY");
      },
    );
  },
  { timeout: 40_000 },
);

test(
  "PTY-106: switches model profiles only on empty sessions and preserves each session",
  async () => {
    await withPtyTui(
      {
        fakeModel: "pty-model-switch",
        rows: 60,
        columns: 140,
        environment: { TINKER_MODELS: "models.json" },
        workspaceFiles: { "models.json": modelProfilesJson() },
      },
      async (harness) => {
        await waitForInitialFrame(harness);
        expect(harness.screenText()).toContain("model=alpha-model");
        const initialAlphaId = currentSessionId(harness.screenText());

        await submitPrompt(harness, "/model");
        await harness.waitForScreen(
          "Switching creates a new session; the current session is preserved.",
        );
        expect(harness.screenText()).toContain("alpha (current)");
        await harness.press("down");
        await harness.waitForScreen("❯ beta");
        await harness.press("enter");
        await harness.waitForScreen('Switched to model profile "beta" (beta-model).', {
          timeoutMs: 10_000,
        });
        const betaId = currentSessionId(harness.screenText());
        expect(betaId).not.toBe(initialAlphaId);
        expect(harness.screenText()).toContain("model=beta-model");
        expect(await defaultProfile(harness.workspaceRoot)).toBe("beta");

        await submitPrompt(harness, "/model alpha");
        await harness.waitForScreen(
          'Switched to model profile "alpha" (alpha-model).',
          { timeoutMs: 10_000 },
        );
        const activeAlphaId = currentSessionId(harness.screenText());
        expect(activeAlphaId).not.toBe(betaId);
        expect(await defaultProfile(harness.workspaceRoot)).toBe("alpha");

        await submitPrompt(harness, "PTY_MODEL_ALPHA_TURN");
        await harness.waitForScreen("PTY_MODEL_ALPHA_DONE");
        await submitPrompt(harness, "/model beta");
        await harness.waitForScreen(
          "Cannot switch models after the session has turns or while running.",
        );
        expect(currentSessionId(harness.screenText())).toBe(activeAlphaId);
        expect(harness.screenText()).toContain("model=alpha-model");
        await harness.press("ctrl_u");

        await submitPrompt(harness, `/resume ${betaId}`);
        await harness.waitForScreen(`Resumed session ${betaId}.`, {
          timeoutMs: 10_000,
        });
        expect(currentSessionId(harness.screenText())).toBe(betaId);
        expect(harness.screenText()).toContain("model=beta-model");
        expect(harness.screenText()).toContain("idle");

        await quitTui(harness);
        const sessions = await storedSessions(harness.workspaceRoot);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.sessionId).toBe(activeAlphaId);
        expect(
          await sessionSummary(harness.workspaceRoot, initialAlphaId),
        ).toMatchObject({
          turnCount: 0,
          modelName: "alpha-model",
          profileName: "alpha",
        });
        expect(await sessionSummary(harness.workspaceRoot, betaId)).toMatchObject({
          turnCount: 0,
          modelName: "beta-model",
          profileName: "beta",
        });
        expect(
          await sessionSummary(harness.workspaceRoot, activeAlphaId),
        ).toMatchObject({
          turnCount: 1,
          modelName: "alpha-model",
          profileName: "alpha",
        });
      },
    );
  },
  { timeout: 40_000 },
);

test(
  "PTY-108: copies canonical Markdown before and after session resume",
  async () => {
    const fixture = await createPtyTuiFixture();
    const clipboardFile = path.join(fixture.workspaceRoot, "clipboard.md");
    const environment = { TINKER_TEST_CLIPBOARD_FILE: clipboardFile };
    let first: PtyTuiHarness | undefined;
    let second: PtyTuiHarness | undefined;
    try {
      first = await fixture.start({
        fakeModel: "pty-copy",
        rows: 80,
        columns: 140,
        environment,
      });
      await waitForInitialFrame(first);
      await submitPrompt(first, "PTY_COPY_MARKDOWN");
      await first.waitForScreen("PTY_COPY_END");
      await submitPrompt(first, "/copy");
      await first.waitForScreen("Copied last response as Markdown.");
      expect(await readFile(clipboardFile, "utf8")).toBe(ptyCopyMarkdownResponse());
      expect((await stat(clipboardFile)).mode & 0o777).toBe(0o600);
      await quitTui(first);
      await first.dispose();

      const session = (await storedSessions(fixture.workspaceRoot)).find(
        (candidate) => candidate.turnCount === 1,
      );
      if (session === undefined) {
        throw new Error("Expected the copied PTY session.");
      }

      second = await fixture.start({
        fakeModel: "pty-copy",
        rows: 80,
        columns: 140,
        environment,
      });
      await waitForInitialFrame(second);
      await submitPrompt(second, `/resume ${session.sessionId}`);
      await second.waitForScreen(`Resumed session ${session.sessionId}.`, {
        timeoutMs: 10_000,
      });
      expect(second.screenText()).toContain("PTY_COPY_CODE");
      expect(second.screenText()).toContain("PTY_COPY_END");
      await submitPrompt(second, "/copy");
      await second.waitForScreen("Copied last response as Markdown.");
      expect(await readFile(clipboardFile, "utf8")).toBe(ptyCopyMarkdownResponse());
      await quitTui(second);

      withSessionDatabase(fixture.workspaceRoot, session, (database) => {
        expect(
          database
            .query(
              "SELECT content FROM messages WHERE role = 'assistant' ORDER BY ordinal",
            )
            .get(),
        ).toEqual({ content: ptyCopyMarkdownResponse() });
      });
      expect(await promptHistoryEntries(fixture.workspaceRoot)).toEqual([
        "PTY_COPY_MARKDOWN",
      ]);
    } finally {
      await second?.dispose();
      await first?.dispose();
      await fixture.dispose();
    }
  },
  { timeout: 40_000 },
);

if (process.platform === "darwin" && process.env.TINKER_TEST_LIVE_CLIPBOARD === "1") {
  test(
    "PTY-108: copies canonical Markdown through the live macOS system clipboard",
    async () => {
      const previousClipboard = await clipboard.read();
      try {
        await withPtyTui(
          { fakeModel: "pty-copy", rows: 80, columns: 140 },
          async (harness) => {
            await waitForInitialFrame(harness);
            await submitPrompt(harness, "PTY_COPY_MARKDOWN");
            await harness.waitForScreen("PTY_COPY_END");
            await submitPrompt(harness, "/copy");
            await harness.waitForScreen("Copied last response as Markdown.");
            expect(await clipboard.read()).toBe(ptyCopyMarkdownResponse());
            await quitTui(harness);
          },
        );
      } finally {
        await clipboard.write(previousClipboard);
      }
    },
    { timeout: 30_000 },
  );
}

function assertForkBranch(
  workspaceRoot: string,
  sessionId: ReturnType<typeof currentSessionId>,
  branchPrompt: "SOURCE_ONLY" | "CLONE_ONLY",
): void {
  withSessionDatabase(workspaceRoot, { sessionId }, (database) => {
    const prompts = database
      .query("SELECT content FROM messages WHERE role = 'user' ORDER BY ordinal")
      .all();
    expect(prompts).toEqual([{ content: "PTY_FORK_SEED" }, { content: branchPrompt }]);
    expect(
      database
        .query(
          `SELECT COUNT(*) AS count
           FROM tool_results
           JOIN messages ON messages.message_id = tool_results.tool_message_id
           WHERE messages.name = 'Write'`,
        )
        .get(),
    ).toEqual({ count: 1 });
  });
}

function modelProfilesJson(): string {
  const profile = (model: string) => ({
    model,
    apiBase: "https://api.example.test/v1",
    apiKey: "profile-placeholder",
    contextWindowTokens: 128 * 1_024,
    maxSupportedOutputTokens: 16 * 1_024,
    includeReasoningContent: false,
    stream: false,
    inputModalities: ["text"],
  });
  return `${JSON.stringify({
    default: "alpha",
    profiles: {
      alpha: profile("alpha-model"),
      beta: profile("beta-model"),
    },
  })}\n`;
}

function longResumeWorkspaceFiles(): Readonly<Record<string, string>> {
  return {
    "resume-layout.txt": "fixture\n",
    ".mcp.json": JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [path.join(import.meta.dir, "fixtures/fake-mcp-server.ts")],
        },
      },
    }),
  };
}

function transientSurfaceWorkspaceFiles(): Readonly<Record<string, string>> {
  const lines = Array.from(
    { length: 80 },
    (_, index) => `VIEW_LINE_${String(index + 1).padStart(3, "0")}`,
  );
  return {
    "resume-layout.txt": "fixture\n",
    "long-view.txt": `${lines.join("\n")}\n`,
    "models.json": `${JSON.stringify({
      default: "work",
      profiles: {
        work: {
          model: "pty-test-model",
          apiBase: "https://api.example.test/v1",
          apiKey: "pty-placeholder-key",
          contextWindowTokens: 128 * 1_024,
          maxSupportedOutputTokens: 16 * 1_024,
        },
      },
      memory: {
        profile: "work",
        embedding: {
          name: "pty-memory-space",
          kind: "openai-compatible",
          model: "pty-embedding",
          apiBase: "https://embedding.example.test/v1",
          apiKey: "pty-embedding-key",
          dimensions: 3,
        },
      },
    })}\n`,
  };
}

async function defaultProfile(workspaceRoot: string): Promise<string> {
  const parsed = JSON.parse(
    await readFile(path.join(workspaceRoot, "models.json"), "utf8"),
  ) as { default: string };
  return parsed.default;
}
