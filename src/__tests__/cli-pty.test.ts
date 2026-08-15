import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionCatalog, type SessionSummary } from "../session/session-catalog";
import { sessionDatabasePath } from "../session/session-store";
import { runtimeIdFactory } from "../ids/runtime-id";
import { MemoryStore, resolveMemoryPaths } from "../memory/memory-store";
import { normalizeEmbedding } from "../memory/vector";
import {
  createPtyTuiFixture,
  type PtyTuiHarness,
  withPtyTui,
} from "./helpers/pty-tui-harness";

test(
  "PTY-001: exits the complete TUI process after idle /quit",
  async () => {
    await withPtyTui({ fakeModel: "pty-quit" }, async (harness) => {
      await harness.waitForScreen("Tinker", {
        timeoutMs: 10_000,
        message: "initial Tinker frame",
      });

      const beforeInput = harness.markTranscript();
      await harness.type("/quit");
      await harness.waitForTranscript("/quit", {
        since: beforeInput,
        timeoutMs: 2_000,
        message: "new /quit input frame",
      });
      await harness.waitForScreen("Exit the TUI", {
        timeoutMs: 2_000,
        message: "/quit command suggestion",
      });
      expect(harness.transcriptSince(beforeInput)).toContain("/quit");

      await harness.press("enter");
      const exit = await harness.waitForExit(2_000);
      if (exit === undefined) {
        throw new Error(
          harness.diagnosticText("Tinker and PTY wrapper exit within 2000ms"),
        );
      }
      expect(exit).toEqual({ code: 0, signal: null });
      expect(harness.wrapperExit()).toEqual({ code: 0, signal: null });
    });
  },
  { timeout: 20_000 },
);

test(
  "PTY-002: completes two conversational turns with shared history",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-echo-history", rows: 70, columns: 140 },
      async (harness) => {
        await waitForInitialFrame(harness);

        await submitPrompt(harness, "PTY_FIRST");
        await harness.waitForScreen("PTY_TURN_ONE_DONE");

        await submitPrompt(harness, "PTY_SECOND");
        await harness.waitForScreen("PTY_TURN_TWO_DONE");
        const conversation = harness.screenText();
        expect(conversation).toContain("PTY_FIRST");
        expect(conversation).toContain("PTY_TURN_ONE_DONE");
        expect(conversation).toContain("PTY_SECOND");
        expect(conversation).toContain("PTY_TURN_TWO_DONE");

        await submitPrompt(harness, "/status");
        await harness.waitForScreen("Measurement");
        expect(harness.screenText()).toContain("Session");
        expect(harness.screenText()).toContain("Context");

        await quitTui(harness);
        const session = await onlyStoredSession(harness.workspaceRoot);
        expect(session.turnCount).toBe(2);
        withSessionDatabase(harness.workspaceRoot, session, (database) => {
          expect(
            database
              .query("SELECT turn_number, status FROM turns ORDER BY turn_number")
              .all(),
          ).toEqual([
            { turn_number: 1, status: "completed" },
            { turn_number: 2, status: "completed" },
          ]);
          expect(
            database
              .query(
                "SELECT role, content FROM messages WHERE role IN ('user', 'assistant') ORDER BY ordinal",
              )
              .all(),
          ).toEqual([
            { role: "user", content: "PTY_FIRST" },
            { role: "assistant", content: "PTY_TURN_ONE_DONE" },
            { role: "user", content: "PTY_SECOND" },
            { role: "assistant", content: "PTY_TURN_TWO_DONE" },
          ]);
        });
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-010: live updates do not clear or replay long static history",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-static-history", rows: 24, columns: 120 },
      async (harness) => {
        await waitForInitialFrame(harness);
        for (let turn = 1; turn <= 4; turn += 1) {
          await submitPrompt(harness, `PTY_STATIC_HISTORY_${turn}`);
          await harness.waitForScreen(`PTY_STATIC_HISTORY_${turn}_DONE`);
        }

        await submitPrompt(harness, "PTY_STATIC_LIVE");
        await harness.waitForScreen("Running");
        const liveMark = harness.markTranscript();
        await harness.waitForTranscript("Exercise static history live tail", {
          since: liveMark,
          message: "the live Bash row after static history settled",
        });
        await harness.waitForTranscript("PTY_STATIC_LIVE_DONE", {
          since: liveMark,
          message: "the final live-tail response",
        });

        const liveWrites = harness.transcriptSince(liveMark);
        expect(liveWrites).toContain("PTY_STATIC_LIVE_LINE_20");
        expect(liveWrites).not.toContain("\u001b[3J");
        expect(liveWrites).not.toContain("PTY_STATIC_HISTORY_EARLY_SENTINEL");
        await quitTui(harness);
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-012: clears the queued notice when an active-turn follow-up is applied",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-steering-notice", rows: 40, columns: 120 },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_STEERING_START");
        await harness.waitForScreen("Send a follow-up for the active turn…", {
          message: "active-turn follow-up input",
        });
        await harness.type("PTY_STEERING_FOLLOWUP");
        await harness.waitForScreen("PTY_STEERING_FOLLOWUP");
        await harness.press("enter");
        const queuedNotice = "Follow-up queued for the active turn (1 pending).";
        await harness.waitForScreen(queuedNotice);
        await harness.waitForScreen(
          (screen) =>
            screen.includes("follow-up") &&
            screen.includes("PTY_STEERING_FOLLOWUP") &&
            !screen.includes(queuedNotice),
          {
            timeoutMs: 5_000,
            message: "applied follow-up without stale queued notice",
          },
        );
        await harness.waitForScreen("PTY_STEERING_FINAL", { timeoutMs: 5_000 });
        await quitTui(harness);
      },
    );
  },
  { timeout: 20_000 },
);

test(
  "PTY-011: prints sealed assistant sections before request settlement without duplicates",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-incremental-output", rows: 40, columns: 120 },
      async (harness) => {
        await waitForInitialFrame(harness);
        const mark = harness.markTranscript();
        await submitPrompt(harness, "PTY_INCREMENTAL_OUTPUT");

        await harness.waitForTranscript("PTY_INCREMENTAL_EARLY_SENTINEL", {
          since: mark,
          timeoutMs: 2_000,
          message: "the first sealed assistant section before request settlement",
        });
        expect(harness.transcriptSince(mark)).not.toContain(
          "PTY_INCREMENTAL_FINAL_SENTINEL",
        );
        await harness.waitForScreen("Running", {
          timeoutMs: 1_000,
          message: "the running status while incremental output remains unsettled",
        });

        await harness.waitForTranscript("PTY_INCREMENTAL_FINAL_SENTINEL", {
          since: mark,
          timeoutMs: 3_000,
          message: "the final assistant section after request settlement",
        });
        await harness.waitForPromptReady();
        const writes = harness.transcriptSince(mark);
        expect(occurrences(writes, "PTY_INCREMENTAL_EARLY_SENTINEL")).toBe(1);
        expect(occurrences(writes, "PTY_INCREMENTAL_SECOND_BODY")).toBe(1);
        expect(occurrences(writes, "PTY_INCREMENTAL_FINAL_SENTINEL")).toBe(1);
        expect(writes).not.toContain("\u001b[3J");

        await quitTui(harness);
        const session = await onlyStoredSession(harness.workspaceRoot);
        withSessionDatabase(harness.workspaceRoot, session, (database) => {
          expect(
            database
              .query(
                "SELECT content FROM messages WHERE role = 'assistant' ORDER BY ordinal",
              )
              .all(),
          ).toEqual([
            {
              content: [
                "## PTY incremental first",
                "PTY_INCREMENTAL_EARLY_SENTINEL",
                "",
                "## PTY incremental second",
                "PTY_INCREMENTAL_SECOND_BODY",
                "",
                "## PTY incremental final",
                "PTY_INCREMENTAL_FINAL_SENTINEL",
              ].join("\n"),
            },
          ]);
        });
        const events = await readFile(
          path.join(
            harness.workspaceRoot,
            ".tinker",
            "sessions",
            session.sessionId,
            "events.jsonl",
          ),
          "utf8",
        );
        expect(events).not.toContain('"type":"assistant.delta"');
      },
    );
  },
  { timeout: 20_000 },
);

test(
  "PTY-003: cancels a blocked turn with Esc and completes the next turn",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-cancel-then-echo", rows: 70, columns: 140 },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_CANCEL_BLOCK");
        await harness.waitForScreen("Running", {
          message: "blocked turn running state",
        });
        await harness.waitForScreen("model iteration 1", {
          message: "blocked model request in flight",
        });

        await harness.press("escape");
        await harness.waitForScreen(
          (screen) => screen.includes("cancelling") || screen.includes("-> cancelled"),
          { message: "immediate feedback after Esc" },
        );
        await harness.waitForScreen(
          (screen) =>
            screen.includes("⊘ model iteration 1 -> cancelled") &&
            !screen.includes("cancelling") &&
            !screen.includes("Running"),
          { message: "settled cancelled screen" },
        );
        await harness.waitForPromptReady();

        await submitPrompt(harness, "PTY_AFTER_CANCEL");
        await harness.waitForScreen("PTY_AFTER_CANCEL_DONE");
        expect(harness.screenText()).toContain("PTY_CANCEL_BLOCK");
        expect(harness.screenText()).toContain("PTY_AFTER_CANCEL");

        await quitTui(harness);
        const session = await onlyStoredSession(harness.workspaceRoot);
        withSessionDatabase(harness.workspaceRoot, session, (database) => {
          expect(
            database
              .query("SELECT turn_number, status FROM turns ORDER BY turn_number")
              .all(),
          ).toEqual([
            { turn_number: 1, status: "cancelled" },
            { turn_number: 2, status: "completed" },
          ]);
          expect(
            database
              .query(
                "SELECT COUNT(*) AS count FROM protocol_frames WHERE state = 'open'",
              )
              .get(),
          ).toEqual({ count: 0 });
        });
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-004: executes Write, Edit, and Bash with durable workspace results",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-tool-chain", rows: 80, columns: 140 },
      async (harness) => {
        await waitForInitialFrame(harness);
        const toolMark = harness.markTranscript();
        await submitPrompt(harness, "PTY_TOOL_CHAIN_START");
        await harness.waitForTranscript("Write pty-tool-chain.txt", {
          since: toolMark,
        });
        await harness.waitForTranscript("Edit pty-tool-chain.txt", {
          since: toolMark,
        });
        await harness.waitForTranscript("Verify edited PTY fixture", {
          since: toolMark,
        });
        await harness.waitForScreen("PTY_TOOL_CHAIN_DONE");

        const screen = harness.screenText();
        expect(screen).toContain("Write pty-tool-chain.txt");
        expect(screen).toContain("Edit pty-tool-chain.txt");
        expect(screen).toContain("Bash Verify edited PTY fixture");
        expect(screen).toContain("PTY_BASH_OK:beta");
        expect(
          await readFile(
            path.join(harness.workspaceRoot, "pty-tool-chain.txt"),
            "utf8",
          ),
        ).toBe("beta\n");

        await submitPrompt(harness, "PTY_TOOL_CHAIN_VERIFY");
        await harness.waitForScreen("PTY_TOOL_CHAIN_VERIFIED");

        await quitTui(harness);
        const session = await onlyStoredSession(harness.workspaceRoot);
        expect(session.turnCount).toBe(2);
        withSessionDatabase(harness.workspaceRoot, session, (database) => {
          expect(
            database
              .query(
                `SELECT messages.name
                 FROM tool_results
                 JOIN messages ON messages.message_id = tool_results.tool_message_id
                 ORDER BY messages.ordinal`,
              )
              .all(),
          ).toEqual([{ name: "Write" }, { name: "Edit" }, { name: "Bash" }]);
          expect(
            database
              .query(
                `SELECT json_extract(tool_results.raw_json, '$.ok') AS ok,
                        json_extract(tool_results.raw_json, '$.exitCode') AS exit_code
                 FROM tool_results
                 JOIN messages ON messages.message_id = tool_results.tool_message_id
                 WHERE messages.name = 'Bash'`,
              )
              .get(),
          ).toEqual({ ok: 1, exit_code: 0 });
        });
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-116: undoes one multi-file mutation turn without rewriting history",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-turn-undo", rows: 80, columns: 140 },
      async (harness) => {
        await waitForInitialFrame(harness);
        const modifiedPath = path.join(harness.workspaceRoot, "pty-undo-modified.txt");
        const createdPath = path.join(
          harness.workspaceRoot,
          "pty-undo-created",
          "nested.txt",
        );
        const deletedPath = path.join(harness.workspaceRoot, "pty-undo-deleted.bin");
        const deletedBytes = Buffer.from([0xff, 0x00, 0x80, 0x61]);
        await writeFile(modifiedPath, "before undo turn\n");
        await writeFile(deletedPath, deletedBytes);

        await submitPrompt(harness, "PTY_UNDO_MUTATE");
        await harness.waitForScreen("PTY_UNDO_MUTATIONS_DONE");
        expect(await readFile(modifiedPath, "utf8")).toBe("after undo turn\n");
        expect(await readFile(createdPath, "utf8")).toBe("created by undo turn\n");
        expect(readFile(deletedPath)).rejects.toMatchObject({ code: "ENOENT" });

        await submitPrompt(harness, "/undo");
        await harness.waitForScreen(
          "Restored workspace to before turn 1: 2 files restored, 1 file deleted.",
        );
        expect(await readFile(modifiedPath, "utf8")).toBe("before undo turn\n");
        expect(await readFile(deletedPath)).toEqual(deletedBytes);
        expect(readFile(createdPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await stat(path.dirname(createdPath))).isDirectory()).toBe(true);

        await submitPrompt(harness, "/undo");
        await harness.waitForScreen("Nothing to undo in this active session.");
        await quitTui(harness);

        const session = await onlyStoredSession(harness.workspaceRoot);
        expect(session.turnCount).toBe(1);
        withSessionDatabase(harness.workspaceRoot, session, (database) => {
          expect(
            database
              .query("SELECT turn_number, status FROM turns ORDER BY turn_number")
              .all(),
          ).toEqual([{ turn_number: 1, status: "completed" }]);
          expect(
            database
              .query(
                `SELECT messages.name
                 FROM tool_results
                 JOIN messages ON messages.message_id = tool_results.tool_message_id
                 ORDER BY messages.ordinal`,
              )
              .all(),
          ).toEqual([
            { name: "Read" },
            { name: "Write" },
            { name: "Write" },
            { name: "Delete" },
          ]);
        });
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-005: inspects and stops a real background task",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-background-task", rows: 90, columns: 140 },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_BACKGROUND_STOP");
        await harness.waitForScreen("PTY_BACKGROUND_STOPPED", {
          timeoutMs: 10_000,
        });

        const pid = await readBackgroundPid(harness.workspaceRoot);
        await waitForProcessExit(pid);
        await harness.waitForScreen("Background tasks · 0 running / 1 total", {
          timeoutMs: 2_000,
          message: "the background task panel to observe the stopped process",
        });
        const screen = harness.screenText();
        expect(screen).toContain("TaskOutput");
        expect(screen).toContain("TaskStop");
        expect(screen).toContain("Background tasks · 0 running / 1 total");
        expect(screen).toContain("killed");

        await quitTui(harness);
        const session = await onlyStoredSession(harness.workspaceRoot);
        withSessionDatabase(harness.workspaceRoot, session, (database) => {
          const names = database
            .query(
              `SELECT messages.name
               FROM tool_results
               JOIN messages ON messages.message_id = tool_results.tool_message_id
               ORDER BY messages.ordinal`,
            )
            .all() as Array<{ name: string }>;
          expect(names[0]?.name).toBe("Bash");
          expect(names).toContainEqual({ name: "TaskOutput" });
          expect(names.at(-1)?.name).toBe("TaskStop");
          expect(
            database
              .query(
                `SELECT json_extract(tool_results.raw_json, '$.status') AS status
                 FROM tool_results
                 JOIN messages ON messages.message_id = tool_results.tool_message_id
                 WHERE messages.name = 'TaskStop'`,
              )
              .get(),
          ).toEqual({ status: "killed" });
        });
        expect(await readOnlyBackgroundLog(harness.workspaceRoot)).toContain(
          "PTY_BACKGROUND_READY",
        );
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-005: stops a still-running background task during /quit cleanup",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-background-task", rows: 70, columns: 140 },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_BACKGROUND_QUIT");
        await harness.waitForScreen("PTY_BACKGROUND_RUNNING");

        const pid = await readBackgroundPid(harness.workspaceRoot);
        expect(isProcessAlive(pid)).toBe(true);
        await quitTui(harness);
        await waitForProcessExit(pid);
        expect(await readOnlyBackgroundLog(harness.workspaceRoot)).toContain(
          "PTY_BACKGROUND_READY",
        );

        const session = await onlyStoredSession(harness.workspaceRoot);
        expect(session.turnCount).toBe(1);
        withSessionDatabase(harness.workspaceRoot, session, (database) => {
          expect(
            database.query("SELECT status FROM turns WHERE turn_number = 1").get(),
          ).toEqual({ status: "completed" });
          expect(
            database
              .query(
                `SELECT json_extract(tool_results.raw_json, '$.status') AS status
                 FROM tool_results
                 JOIN messages ON messages.message_id = tool_results.tool_message_id
                 WHERE messages.name = 'Bash'`,
              )
              .get(),
          ).toEqual({ status: "running" });
        });
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-117: drives an interactive child terminal and preserves canonical tool order",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-interactive-terminal", rows: 90, columns: 140 },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_INTERACTIVE_TERMINAL");
        await harness.waitForScreen("PTY_INTERACTIVE_DONE", { timeoutMs: 10_000 });

        const screen = harness.screenText();
        expect(screen).toContain("Bash");
        expect(screen).toContain("TaskOutput");
        expect(screen).toContain("TaskInput");
        expect(screen).toContain("42");
        expect(screen).not.toContain("\x1b");

        await submitPrompt(harness, "PTY_INTERACTIVE_FOLLOWUP");
        await harness.waitForScreen("PTY_INTERACTIVE_FOLLOWUP_DONE");
        await quitTui(harness);

        const session = await onlyStoredSession(harness.workspaceRoot);
        expect(session.turnCount).toBe(2);
        withSessionDatabase(harness.workspaceRoot, session, (database) => {
          const names = database
            .query(
              `SELECT messages.name
               FROM tool_results
               JOIN messages ON messages.message_id = tool_results.tool_message_id
               ORDER BY messages.ordinal`,
            )
            .all() as Array<{ name: string }>;
          expect(names[0]?.name).toBe("Bash");
          expect(names).toContainEqual({ name: "TaskOutput" });
          expect(names.filter((entry) => entry.name === "TaskInput")).toHaveLength(2);

          const inputs = database
            .query(
              `SELECT json_extract(tool_results.raw_json, '$.kind') AS kind,
                      json_extract(tool_results.raw_json, '$.status') AS status,
                      json_extract(tool_results.raw_json, '$.screen') AS screen
               FROM tool_results
               JOIN messages ON messages.message_id = tool_results.tool_message_id
               WHERE messages.name = 'TaskInput'
               ORDER BY messages.ordinal`,
            )
            .all() as Array<{ kind: string; status: string; screen: string }>;
          expect(inputs.map((entry) => entry.kind)).toEqual([
            "task_input",
            "task_input",
          ]);
          expect(inputs[0]?.screen).toContain("42");
          expect(inputs.at(-1)?.status).toBe("completed");
          expect(inputs.every((entry) => !entry.screen.includes("\x1b"))).toBe(true);
        });
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-118: cleans up a still-running child terminal during /quit",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-interactive-terminal", rows: 80, columns: 140 },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_INTERACTIVE_QUIT");
        await harness.waitForScreen("PTY_INTERACTIVE_RUNNING", {
          timeoutMs: 10_000,
        });

        const log = await readOnlyBackgroundLog(harness.workspaceRoot);
        const pidMatch = log.match(/PTY_INTERACTIVE_PID=(\d+)/);
        expect(pidMatch).not.toBeNull();
        const pid = Number(pidMatch?.[1]);
        expect(Number.isSafeInteger(pid)).toBe(true);
        expect(isProcessAlive(pid)).toBe(true);

        await quitTui(harness);
        await waitForProcessExit(pid);

        const session = await onlyStoredSession(harness.workspaceRoot);
        withSessionDatabase(harness.workspaceRoot, session, (database) => {
          expect(
            database
              .query(
                `SELECT json_extract(tool_results.raw_json, '$.status') AS status
                 FROM tool_results
                 JOIN messages ON messages.message_id = tool_results.tool_message_id
                 WHERE messages.name = 'TaskInput'
                 ORDER BY messages.ordinal DESC LIMIT 1`,
              )
              .get(),
          ).toEqual({ status: "running" });
        });
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-006: resumes a completed tool session through the keyboard picker",
  async () => {
    const fixture = await createPtyTuiFixture();
    let first: PtyTuiHarness | undefined;
    let second: PtyTuiHarness | undefined;
    try {
      first = await fixture.start({
        fakeModel: "pty-resume",
        rows: 80,
        columns: 140,
      });
      await waitForInitialFrame(first);
      await submitPrompt(first, "PTY_RESUME_SEED");
      await first.waitForScreen("PTY_RESUME_SEED_DONE");
      await quitTui(first);
      await first.dispose();

      const seedSession = await onlyStoredSession(fixture.workspaceRoot);
      expect(seedSession.status).toBe("resumable");
      expect(
        await readFile(path.join(fixture.workspaceRoot, "pty-resume.txt"), "utf8"),
      ).toBe("PTY_RESUME_SIDE_EFFECT\n");

      second = await fixture.start({
        fakeModel: "pty-resume",
        rows: 80,
        columns: 140,
      });
      await waitForInitialFrame(second);
      await submitPrompt(second, "/resume");
      await second.waitForScreen("PTY_RESUME_SEED");
      expect(second.screenText()).toContain("resumable");
      expect(second.screenText()).toContain("1 turn");
      await second.press("enter");
      await second.waitForScreen(`Resumed session ${seedSession.sessionId}.`, {
        timeoutMs: 10_000,
      });

      const resumed = second.screenText();
      expect(resumed).toContain(seedSession.sessionId);
      expect(resumed).toContain("PTY_RESUME_SEED");
      expect(resumed).toContain("Write pty-resume.txt");
      expect(resumed).toContain("PTY_RESUME_SEED_DONE");

      await submitPrompt(second, "PTY_RESUME_CONTINUE");
      await second.waitForScreen("PTY_RESUME_CONTINUED");
      await quitTui(second);

      const sessions = await new SessionCatalog({
        workspaceRoot: fixture.workspaceRoot,
      }).list();
      const nonEmptySessions = sessions.filter((session) => session.turnCount > 0);
      expect(nonEmptySessions).toHaveLength(1);
      expect(nonEmptySessions[0]).toMatchObject({
        sessionId: seedSession.sessionId,
        turnCount: 2,
        status: "resumable",
      });
      withSessionDatabase(fixture.workspaceRoot, seedSession, (database) => {
        expect(
          database
            .query("SELECT content FROM messages WHERE role = 'user' ORDER BY ordinal")
            .all(),
        ).toEqual([{ content: "PTY_RESUME_SEED" }, { content: "PTY_RESUME_CONTINUE" }]);
      });
    } finally {
      await second?.dispose();
      await first?.dispose();
      await fixture.dispose();
    }
  },
  { timeout: 40_000 },
);

test(
  "PTY-007: resumes an interrupted session without replaying its completed tool",
  async () => {
    const fixture = await createPtyTuiFixture();
    let first: PtyTuiHarness | undefined;
    let second: PtyTuiHarness | undefined;
    try {
      first = await fixture.start({
        fakeModel: "pty-interrupted-tool",
        rows: 80,
        columns: 140,
      });
      await waitForInitialFrame(first);
      const interruptedMark = first.markTranscript();
      await submitPrompt(first, "PTY_INTERRUPT_START");
      await first.waitForTranscript("Write pty-interrupted.txt", {
        since: interruptedMark,
      });
      await first.waitForTranscript("model iteration 2", {
        since: interruptedMark,
        message: "blocked post-tool model request",
      });
      expect(
        await readFile(path.join(fixture.workspaceRoot, "pty-interrupted.txt"), "utf8"),
      ).toBe("PTY_INTERRUPT_SIDE_EFFECT\n");

      await first.signalTui("SIGKILL");
      expect(await first.waitForExit(2_000)).toEqual({
        code: null,
        signal: "SIGKILL",
      });
      await first.dispose();

      const interrupted = await onlyStoredSession(fixture.workspaceRoot);
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.turnCount).toBe(1);

      second = await fixture.start({
        fakeModel: "pty-interrupted-tool",
        rows: 80,
        columns: 140,
      });
      await waitForInitialFrame(second);
      await submitPrompt(second, "/resume");
      await second.waitForScreen("interrupted · completes record; no tool retry");
      await second.press("enter");
      await second.waitForScreen(`Resumed session ${interrupted.sessionId}.`, {
        timeoutMs: 10_000,
      });
      const recoveredScreen = second.screenText();
      expect(recoveredScreen).toContain("Write pty-interrupted.txt");
      expect(recoveredScreen).toContain("model iteration 2 -> interrupted");

      await submitPrompt(second, "PTY_INTERRUPT_RECOVER");
      await second.waitForScreen("PTY_INTERRUPT_RECOVERED");
      await quitTui(second);

      expect(
        await readFile(path.join(fixture.workspaceRoot, "pty-interrupted.txt"), "utf8"),
      ).toBe("PTY_INTERRUPT_SIDE_EFFECT\n");
      withSessionDatabase(fixture.workspaceRoot, interrupted, (database) => {
        expect(
          database
            .query("SELECT turn_number, status FROM turns ORDER BY turn_number")
            .all(),
        ).toEqual([
          { turn_number: 1, status: "interrupted" },
          { turn_number: 2, status: "completed" },
        ]);
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
        expect(
          database
            .query("SELECT COUNT(*) AS count FROM protocol_frames WHERE state = 'open'")
            .get(),
        ).toEqual({ count: 0 });
      });
    } finally {
      await second?.dispose();
      await first?.dispose();
      await fixture.dispose();
    }
  },
  { timeout: 40_000 },
);

test(
  "PTY-008: remains usable after a provider failure",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-fail-once", rows: 70, columns: 140 },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_FAIL_FIRST");
        await harness.waitForScreen("PTY_FAKE_PROVIDER_FAILURE");
        await harness.waitForPromptReady();
        expect(harness.screenText()).toContain("failed");

        await submitPrompt(harness, "PTY_FAIL_RECOVER");
        await harness.waitForScreen("PTY_FAIL_RECOVERED");
        expect(harness.screenText()).toContain("PTY_FAIL_FIRST");
        expect(harness.screenText()).toContain("PTY_FAIL_RECOVER");

        await quitTui(harness);
        const session = await onlyStoredSession(harness.workspaceRoot);
        withSessionDatabase(harness.workspaceRoot, session, (database) => {
          expect(
            database
              .query("SELECT turn_number, status FROM turns ORDER BY turn_number")
              .all(),
          ).toEqual([
            { turn_number: 1, status: "failed" },
            { turn_number: 2, status: "completed" },
          ]);
          expect(
            database
              .query("SELECT terminal_detail_json FROM turns WHERE turn_number = 1")
              .get(),
          ).toEqual({
            terminal_detail_json: '{"error":"PTY_FAKE_PROVIDER_FAILURE","version":1}',
          });
        });
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-008: remains usable after a real tool failure",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-tool-chain", rows: 70, columns: 140 },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_TOOL_FAILURE");
        await harness.waitForScreen("PTY_TOOL_FAILURE_HANDLED");
        const failureScreen = harness.screenText();
        expect(failureScreen).toContain("Bash Produce expected PTY failure");
        expect(failureScreen).toContain("exit 7");
        expect(failureScreen).toContain("PTY_TOOL_FAILURE_OUTPUT");

        await submitPrompt(harness, "PTY_AFTER_TOOL_FAILURE");
        await harness.waitForScreen("PTY_AFTER_TOOL_FAILURE_DONE");
        await quitTui(harness);

        const session = await onlyStoredSession(harness.workspaceRoot);
        withSessionDatabase(harness.workspaceRoot, session, (database) => {
          expect(
            database
              .query("SELECT turn_number, status FROM turns ORDER BY turn_number")
              .all(),
          ).toEqual([
            { turn_number: 1, status: "completed" },
            { turn_number: 2, status: "completed" },
          ]);
          expect(
            database
              .query(
                `SELECT json_extract(tool_results.raw_json, '$.ok') AS ok,
                        json_extract(tool_results.raw_json, '$.status') AS status,
                        json_extract(tool_results.raw_json, '$.exitCode') AS exit_code
                 FROM tool_results
                 JOIN messages ON messages.message_id = tool_results.tool_message_id
                 WHERE messages.name = 'Bash'`,
              )
              .get(),
          ).toEqual({ ok: 0, status: "failed", exit_code: 7 });
        });
      },
    );
  },
  { timeout: 30_000 },
);

test(
  "PTY-009: browses a stored global-memory snapshot and restores the prompt",
  async () => {
    const fixture = await createPtyTuiFixture({
      workspaceFiles: { "models.json": memoryBrowserModelProfilesJson() },
    });
    const timestamps = [
      "2026-07-24T08:00:00.000Z",
      "2026-07-25T09:00:00.000Z",
      "2026-07-26T10:00:00.000Z",
    ];
    let harness: PtyTuiHarness | undefined;
    try {
      const store = await MemoryStore.open({
        paths: resolveMemoryPaths(fixture.homeRoot),
        embedding: {
          name: "pty-memory-space",
          kind: "openai-compatible",
          model: "pty-embedding",
          dimensions: 3,
        },
        clock: () => timestamps.shift()!,
      });
      const source = {
        sessionId: runtimeIdFactory.createSessionId(),
        turnId: runtimeIdFactory.createTurnId(),
      };
      store.insertBatch({
        ...source,
        workspaceRoot: "/workspace/oldest",
        candidates: [
          {
            text: [
              "OLDEST_LINE_1",
              "OLDEST_LINE_2",
              "OLDEST_LINE_3",
              "OLDEST_FINAL_MEMORY",
            ].join("\n"),
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });
      store.insertBatch({
        ...source,
        workspaceRoot: "/workspace/middle",
        candidates: [
          {
            text: "MIDDLE_MEMORY",
            embedding: normalizeEmbedding([0, 1, 0], 3),
          },
        ],
      });
      store.insertBatch({
        ...source,
        workspaceRoot: "/workspace/newest",
        candidates: [
          {
            text: "NEWEST_MEMORY",
            embedding: normalizeEmbedding([0, 0, 1], 3),
          },
        ],
      });
      store.close();

      harness = await fixture.start({
        fakeModel: "pty-memory-browser",
        rows: 9,
        columns: 100,
        environment: { TINKER_MODELS: "models.json" },
      });
      await submitPrompt(harness, "/memory");
      await harness.waitForScreen("NEWEST_MEMORY");
      const initial = harness.screenText();
      expect(initial).toContain("/workspace/newest");
      expect(initial).toContain("MIDDLE_MEMORY");
      expect(initial.indexOf("NEWEST_MEMORY")).toBeLessThan(
        initial.indexOf("MIDDLE_MEMORY"),
      );
      expect(initial).not.toContain("OLDEST_FINAL_MEMORY");

      await harness.press("end");
      await harness.waitForScreen("OLDEST_FINAL_MEMORY");
      await harness.press("escape");
      await harness.waitForPromptReady();

      const restoredTurn = harness.markTranscript();
      await submitPrompt(harness, "PTY_MEMORY_AFTER");
      await harness.waitForTranscript("Fake model received: PTY_MEMORY_AFTER", {
        since: restoredTurn,
      });
      await harness.waitForPromptReady();
      await quitTui(harness);
    } finally {
      await harness?.dispose();
      await fixture.dispose();
    }
  },
  { timeout: 30_000 },
);

async function waitForInitialFrame(harness: PtyTuiHarness): Promise<void> {
  await harness.waitForScreen("Tinker", {
    timeoutMs: 10_000,
    message: "initial Tinker frame",
  });
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function memoryBrowserModelProfilesJson(): string {
  return JSON.stringify({
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
  });
}

async function submitPrompt(harness: PtyTuiHarness, prompt: string): Promise<void> {
  await waitForPromptReady(harness);
  await harness.type(prompt);
  await harness.waitForScreen(prompt, {
    timeoutMs: 2_000,
    message: `typed ${prompt}`,
  });
  await harness.press("enter");
}

async function waitForPromptReady(harness: PtyTuiHarness): Promise<void> {
  await harness.waitForPromptReady();
}

async function quitTui(harness: PtyTuiHarness): Promise<void> {
  await submitPrompt(harness, "/quit");
  const exit = await harness.waitForExit(2_000);
  if (exit === undefined) {
    throw new Error(
      harness.diagnosticText("Tinker and PTY wrapper exit within 2000ms"),
    );
  }
  expect(exit).toEqual({ code: 0, signal: null });
  expect(harness.wrapperExit()).toEqual({ code: 0, signal: null });
}

async function onlyStoredSession(workspaceRoot: string): Promise<SessionSummary> {
  const sessions = await new SessionCatalog({ workspaceRoot }).list();
  const stored = sessions.filter((session) => session.turnCount > 0);
  expect(stored).toHaveLength(1);
  const session = stored[0];
  if (session === undefined) {
    throw new Error("Expected one stored PTY session.");
  }
  return session;
}

function withSessionDatabase<T>(
  workspaceRoot: string,
  session: Pick<SessionSummary, "sessionId">,
  inspect: (database: Database) => T,
): T {
  const database = new Database(sessionDatabasePath(workspaceRoot, session.sessionId), {
    readonly: true,
    strict: true,
  });
  try {
    return inspect(database);
  } finally {
    database.close();
  }
}

async function readBackgroundPid(workspaceRoot: string): Promise<number> {
  const value = await waitForFileContent(
    path.join(workspaceRoot, "pty-background.pid"),
    "background PID file",
  );
  const pid = Number(value.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid background PID: ${JSON.stringify(value)}.`);
  }
  return pid;
}

async function waitForFileContent(
  filePath: string,
  description: string,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const content = await readFile(filePath, "utf8");
      if (content !== "") {
        return content;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`${description} was not ready within ${timeoutMs}ms.`);
    }
    await Bun.sleep(25);
  }
}

async function readOnlyBackgroundLog(workspaceRoot: string): Promise<string> {
  const directory = path.join(workspaceRoot, ".tinker", "bash");
  const logs = (await readdir(directory))
    .filter((entry) => entry.endsWith(".log"))
    .sort();
  expect(logs).toHaveLength(1);
  const log = logs[0];
  if (log === undefined) {
    throw new Error("Expected one PTY background task log.");
  }
  return readFile(path.join(directory, log), "utf8");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Process ${pid} remained alive after ${timeoutMs}ms.`);
    }
    await Bun.sleep(25);
  }
}
