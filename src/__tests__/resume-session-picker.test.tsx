import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { SessionId } from "../ids/runtime-id";
import type { SessionSummary } from "../session/session-catalog";
import {
  formatRelativeTime,
  matchesSessionPreview,
  normalizeSearchText,
  ResumeSessionPicker,
} from "../tui/components/resume-session-picker";

const ARROW_UP = "\u001b[A";
const ARROW_DOWN = "\u001b[B";
const ARROW_LEFT = "\u001b[D";
const BACKSPACE = "\u007f";
const DELETE = "\u001b[3~";
const CTRL_A = "\u0001";
const CTRL_E = "\u0005";
const CTRL_U = "\u0015";
const ESCAPE = "\u001b";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const NOW = new Date("2026-07-12T12:00:00.000Z");

describe("resume session picker", () => {
  test("renders session metadata, availability reasons, and interrupted recovery guidance", () => {
    const sessions = [
      summary(0, "current", { minutesAgo: 1, prompt: "current prompt" }),
      summary(1, "resumable", {
        minutesAgo: 12,
        turns: 3,
        prompt: "帮我提交推送",
      }),
      summary(2, "interrupted", { minutesAgo: 30 }),
      summary(3, "active", { minutesAgo: 40 }),
      summary(4, "incomplete", { minutesAgo: 50 }),
      summary(5, "unavailable", {
        minutesAgo: 60,
        statusDetail: "lock is corrupt",
      }),
    ];
    const { lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={6}
        onCancel={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const frame = stripAnsi(lastFrame());
    expect(frame).toContain("❯ 12 minutes ago · 3 turns · resumable");
    expect(frame).toContain("帮我提交推送");
    expect(frame).toContain("deepseek-v4-flash");
    expect(frame).toContain("019f0001…");
    expect(frame).toContain("current session · not selectable");
    expect(frame).toContain("interrupted · completes record; no tool retry");
    expect(frame).toContain("in use by another Tinker process");
    expect(frame).toContain("initialization incomplete · cannot resume");
    expect(frame).toContain("unavailable: lock is corrupt");
    cleanup();
  });

  test("moves with arrows and j/k, blocks disabled entries, and cancels with Escape", async () => {
    const sessions = [
      summary(0, "active"),
      summary(1, "resumable"),
      summary(2, "interrupted"),
    ];
    const selected: SessionId[] = [];
    let cancelCount = 0;
    const { stdin, lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={3}
        onCancel={() => {
          cancelCount += 1;
        }}
        onSelect={(session) => selected.push(session.sessionId)}
      />,
    );

    await press(stdin, ARROW_UP, "\r");
    expect(selected).toEqual([]);
    expect(stripAnsi(lastFrame())).toContain(
      "❯ 5 minutes ago · 1 turn · in use by another Tinker process",
    );

    await press(stdin, "j", "\r");
    expect(selected).toEqual([sessions[1]?.sessionId]);

    await press(stdin, ARROW_DOWN, "\r");
    expect(selected).toEqual([sessions[1]?.sessionId, sessions[2]?.sessionId]);

    await press(stdin, "k");
    stdin.write("\u001b");
    await Bun.sleep(25);
    expect(cancelCount).toBe(1);
    cleanup();
  });

  test("scrolls the window so every newly selected session remains visible", async () => {
    const sessions = Array.from({ length: 6 }, (_, index) =>
      summary(index, "resumable", {
        minutesAgo: index + 1,
        prompt: `prompt-${index}`,
      }),
    );
    const { stdin, lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={2}
        onCancel={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(stripAnsi(lastFrame())).toContain("prompt-0");
    expect(stripAnsi(lastFrame())).toContain("prompt-1");
    expect(stripAnsi(lastFrame())).not.toContain("prompt-2");
    expect(stripAnsi(lastFrame()).split("\n")).toHaveLength(9);

    for (let selectedIndex = 1; selectedIndex < sessions.length; selectedIndex += 1) {
      await press(stdin, selectedIndex % 2 === 0 ? "j" : ARROW_DOWN);
      const frame = stripAnsi(lastFrame());
      expect(frame).toContain(`prompt-${selectedIndex}`);
      if (selectedIndex >= 2) {
        expect(frame).not.toContain(`prompt-${selectedIndex - 2}`);
      }
    }

    const finalFrame = stripAnsi(lastFrame());
    expect(finalFrame).toContain("Showing 5–6 / 6");
    expect(finalFrame).toContain("↑ more above");
    cleanup();
  });

  test("matches previews with normalization, case folding, and AND terms", () => {
    const chinese = summary(0, "resumable", { prompt: "帮我修复 WAV 文件" });
    expect(matchesSessionPreview(chinese, "修复")).toBe(true);
    expect(matchesSessionPreview(chinese, "wav 文件")).toBe(true);
    expect(matchesSessionPreview(chinese, "ＷＡＶ")).toBe(true);
    expect(matchesSessionPreview(chinese, "修复  文件")).toBe(true);
    expect(matchesSessionPreview(chinese, "wav repair")).toBe(false);

    const english = summary(1, "resumable", { prompt: "Fix the WAV repair tool" });
    expect(matchesSessionPreview(english, "wav repair")).toBe(true);
    expect(matchesSessionPreview(english, "REPAIR wav")).toBe(true);
    expect(matchesSessionPreview(english, "repair missing")).toBe(false);

    const spaced = summary(2, "resumable", {
      prompt: "line one\nline   two\tend",
    });
    expect(matchesSessionPreview(spaced, "one line two")).toBe(true);
    expect(matchesSessionPreview(spaced, "\n\t ")).toBe(true);

    const noPreview = summary(3, "resumable", { prompt: "" });
    expect(matchesSessionPreview(noPreview, "anything")).toBe(false);
    expect(matchesSessionPreview(noPreview, "")).toBe(true);

    const secondTurnOnly = summary(4, "resumable", {
      prompt: "first prompt only",
    });
    expect(matchesSessionPreview(secondTurnOnly, "second turn words")).toBe(false);

    const hiddenFields = summary(5, "unavailable", {
      prompt: "visible preview",
      statusDetail: "lock is corrupt",
    });
    expect(matchesSessionPreview(hiddenFields, "corrupt")).toBe(false);
    expect(matchesSessionPreview(hiddenFields, "deepseek")).toBe(false);
    expect(matchesSessionPreview(hiddenFields, "019f0005")).toBe(false);
  });

  test("normalizes search text with NFKC, whitespace folding, and lowercasing", () => {
    expect(normalizeSearchText("  WAV\u3000Repair\nTool  ")).toBe("wav repair tool");
    expect(normalizeSearchText("ＦＵＬＬＷＩＤＴＨ")).toBe("fullwidth");
    expect(normalizeSearchText(" \t\n ")).toBe("");
  });

  test("caps the default list at the 20 most recent sessions", async () => {
    const sessions = Array.from({ length: 25 }, (_, index) =>
      summary(index, "resumable", {
        minutesAgo: index + 1,
        prompt: `default-prompt-${index}`,
      }),
    );
    const { stdin, lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={25}
        onCancel={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const frame = stripAnsi(lastFrame());
    expect(frame).toContain("default-prompt-0");
    expect(frame).toContain("default-prompt-19");
    expect(frame).not.toContain("default-prompt-20");
    expect(frame).toContain("Showing 1–20 / 20 recent · 25 sessions total");

    for (let index = 0; index < 24; index += 1) {
      await press(stdin, "j");
    }
    expect(stripAnsi(lastFrame())).toContain("❯ 20 minutes ago");
    expect(stripAnsi(lastFrame())).not.toContain("default-prompt-20");
    cleanup();
  });

  test("searches every session and resumes a match outside the default 20", async () => {
    const sessions = Array.from({ length: 25 }, (_, index) =>
      summary(index, "resumable", {
        minutesAgo: index + 1,
        prompt: index === 24 ? "wav repair notes" : `default-prompt-${index}`,
      }),
    );
    const selected: SessionId[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={20}
        onCancel={() => undefined}
        onSelect={(session) => selected.push(session.sessionId)}
      />,
    );

    expect(stripAnsi(lastFrame())).not.toContain("wav repair notes");

    await press(stdin, "/", "wav repair");
    const frame = stripAnsi(lastFrame());
    expect(frame).toContain("Search: wav repair");
    expect(frame).toContain("wav repair notes");
    expect(frame).not.toContain("default-prompt-0");
    expect(frame).toContain("↑/↓ to move · Enter to resume · Esc to clear search");
    expect(frame).toContain("1 match");

    await press(stdin, "\r");
    expect(selected).toEqual([sessions[24]?.sessionId]);
    cleanup();
  });

  test("caps search results at 20 and reports the full match count", async () => {
    const sessions = Array.from({ length: 25 }, (_, index) =>
      summary(index, "resumable", {
        minutesAgo: index + 1,
        prompt: `shared needle ${index}`,
      }),
    );
    const { stdin, lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={6}
        onCancel={() => undefined}
        onSelect={() => undefined}
      />,
    );

    await press(stdin, "/", "needle");
    const frame = stripAnsi(lastFrame());
    expect(frame).toContain("shared needle 0");
    expect(frame).toContain("shared needle 5");
    expect(frame).not.toContain("shared needle 20");
    expect(frame).toContain("Showing 1–6 / 20 results · 25 matches total");
    cleanup();
  });

  test("shows an empty result without a hidden selection and clears with Escape", async () => {
    const sessions = [
      summary(0, "resumable", { prompt: "alpha" }),
      summary(1, "resumable", { prompt: "beta" }),
    ];
    const selected: SessionId[] = [];
    let cancelCount = 0;
    const { stdin, lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={3}
        onCancel={() => {
          cancelCount += 1;
        }}
        onSelect={(session) => selected.push(session.sessionId)}
      />,
    );

    await press(stdin, "/", "zzz");
    const emptyFrame = stripAnsi(lastFrame());
    expect(emptyFrame).toContain('No sessions match "zzz" · Esc to clear search');
    expect(emptyFrame).not.toContain("alpha");
    expect(emptyFrame).not.toContain("beta");

    await press(stdin, "\r");
    expect(selected).toEqual([]);

    await pressEscape(stdin);
    const browseFrame = stripAnsi(lastFrame());
    expect(browseFrame).toContain("alpha");
    expect(browseFrame).toContain(
      "↑/↓ or j/k to move · / to search · Enter to resume · Esc to cancel",
    );
    expect(cancelCount).toBe(0);

    await pressEscape(stdin);
    expect(cancelCount).toBe(1);
    cleanup();
  });

  test("treats j, k, and / as query characters while searching", async () => {
    const sessions = [
      summary(0, "resumable", { prompt: "j/k shortcuts" }),
      summary(1, "resumable", { prompt: "plain text" }),
    ];
    const { stdin, lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={3}
        onCancel={() => undefined}
        onSelect={() => undefined}
      />,
    );

    await press(stdin, "/", "j/k");
    const frame = stripAnsi(lastFrame());
    expect(frame).toContain("Search: j/k");
    expect(frame).toContain("j/k shortcuts");
    expect(frame).not.toContain("plain text");
    expect(frame).toContain("1 match");
    cleanup();
  });

  test("keeps every character from rapid consecutive input events", async () => {
    const sessions = [
      summary(0, "resumable", { prompt: "alphabet" }),
      summary(1, "resumable", { prompt: "other" }),
    ];
    const { stdin, lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={3}
        onCancel={() => undefined}
        onSelect={() => undefined}
      />,
    );

    // No waiting between writes: every event must apply to the latest state.
    stdin.write("/");
    stdin.write("a");
    stdin.write("b");
    await Bun.sleep(60);
    expect(stripAnsi(lastFrame())).toContain("Search: ab");

    stdin.write("c");
    stdin.write("d");
    await Bun.sleep(60);
    expect(stripAnsi(lastFrame())).toContain("Search: abcd");

    stdin.write(BACKSPACE);
    stdin.write(BACKSPACE);
    await Bun.sleep(60);
    expect(stripAnsi(lastFrame())).toContain("Search: ab");

    stdin.write(`${PASTE_START} xy z${PASTE_END}`);
    await Bun.sleep(60);
    expect(stripAnsi(lastFrame())).toContain("Search: ab xy z");
    cleanup();
  });

  test("clears the query when Escape arrives without an intervening render", async () => {
    const sessions = [summary(0, "resumable", { prompt: "alpha" })];
    let cancelCount = 0;
    const { stdin, lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={2}
        onCancel={() => {
          cancelCount += 1;
        }}
        onSelect={() => undefined}
      />,
    );

    // No waiting between writes: the Escape must clear the query rather than
    // cancel the picker, even if no render happened since the typed input.
    stdin.write("/");
    stdin.write("alpha");
    stdin.write(ESCAPE);
    await Bun.sleep(100);
    expect(cancelCount).toBe(0);
    expect(stripAnsi(lastFrame())).toContain(
      "↑/↓ or j/k to move · / to search · Enter to resume · Esc to cancel",
    );

    await pressEscape(stdin);
    expect(cancelCount).toBe(1);
    cleanup();
  });

  test("edits the query with arrows, backspace, delete, and ctrl chords", async () => {
    const sessions = [
      summary(0, "resumable", { prompt: "wav repair" }),
      summary(1, "resumable", { prompt: "other" }),
    ];
    const { stdin, lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={3}
        onCancel={() => undefined}
        onSelect={() => undefined}
      />,
    );

    await press(stdin, "/", "wx");
    expect(stripAnsi(lastFrame())).toContain("Search: wx");

    await press(stdin, ARROW_LEFT, "av");
    expect(stripAnsi(lastFrame())).toContain("Search: wavx");

    await press(stdin, DELETE, BACKSPACE);
    expect(stripAnsi(lastFrame())).toContain("Search: wa");

    await press(stdin, "v repair");
    const frame = stripAnsi(lastFrame());
    expect(frame).toContain("Search: wav repair");
    expect(frame).toContain("1 match");

    await press(stdin, CTRL_A, "bad ");
    expect(stripAnsi(lastFrame())).toContain("Search: bad wav repair");

    await press(stdin, CTRL_U, CTRL_E);
    const finalFrame = stripAnsi(lastFrame());
    expect(finalFrame).toContain("Search: wav repair");
    expect(finalFrame).toContain("1 match");
    cleanup();
  });

  test("resets selection to the first selectable result when the query changes", async () => {
    const sessions = [
      summary(0, "active", { prompt: "alpha first" }),
      summary(1, "resumable", { prompt: "alpha second" }),
      summary(2, "resumable", { prompt: "beta third" }),
    ];
    const selected: SessionId[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={4}
        onCancel={() => undefined}
        onSelect={(session) => selected.push(session.sessionId)}
      />,
    );

    await press(stdin, ARROW_DOWN);
    expect(stripAnsi(lastFrame())).toContain("❯ 5 minutes ago · 1 turn · resumable");

    await press(stdin, "/", "alpha");
    const frame = stripAnsi(lastFrame());
    expect(frame).toContain("2 matches");
    expect(frame).toContain("❯ 5 minutes ago · 1 turn · resumable");
    expect(frame).not.toContain("beta third");

    await press(stdin, "\r");
    expect(selected).toEqual([sessions[1]?.sessionId]);
    cleanup();
  });

  test("focuses a disabled-only result row without resuming it", async () => {
    const sessions = [
      summary(0, "resumable", { prompt: "alpha" }),
      summary(1, "active", { prompt: "beta blocked" }),
    ];
    const selected: SessionId[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={3}
        onCancel={() => undefined}
        onSelect={(session) => selected.push(session.sessionId)}
      />,
    );

    await press(stdin, "/", "beta");
    const frame = stripAnsi(lastFrame());
    expect(frame).toContain(
      "❯ 5 minutes ago · 1 turn · in use by another Tinker process",
    );
    expect(frame).toContain("1 match");

    await press(stdin, "\r");
    expect(selected).toEqual([]);
    cleanup();
  });

  test("keeps the selection visible when search chrome shrinks the window", async () => {
    const sessions = Array.from({ length: 5 }, (_, index) =>
      summary(index, "resumable", {
        minutesAgo: index + 1,
        prompt: `chrome-prompt-${index}`,
      }),
    );
    const { stdin, lastFrame, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        viewportRows={12}
        onCancel={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(stripAnsi(lastFrame())).toContain("chrome-prompt-2");

    await press(stdin, ARROW_DOWN, ARROW_DOWN);
    expect(stripAnsi(lastFrame())).toContain("❯ 3 minutes ago");

    await press(stdin, "/");
    const frame = stripAnsi(lastFrame());
    expect(frame).toContain("Search:");
    expect(frame).toContain("❯ 3 minutes ago");
    expect(frame).toContain("chrome-prompt-2");
    expect(frame).toContain("chrome-prompt-1");
    expect(frame).not.toContain("chrome-prompt-0");
    cleanup();
  });

  test("preserves the query and results after a failed resume", async () => {
    const sessions = [
      summary(0, "resumable", { prompt: "wav repair" }),
      summary(1, "resumable", { prompt: "other" }),
    ];
    const { stdin, lastFrame, rerender, cleanup } = render(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={3}
        onCancel={() => undefined}
        onSelect={() => undefined}
      />,
    );

    await press(stdin, "/", "wav");
    expect(stripAnsi(lastFrame())).toContain("1 match");

    rerender(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={3}
        isResuming={true}
        onCancel={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(stripAnsi(lastFrame())).toContain("Resuming 019f0000…");

    rerender(
      <ResumeSessionPicker
        sessions={sessions}
        now={NOW}
        visibleItemCount={3}
        error="session lock is stale"
        onCancel={() => undefined}
        onSelect={() => undefined}
      />,
    );
    const frame = stripAnsi(lastFrame());
    expect(frame).toContain("Search: wav");
    expect(frame).toContain("wav repair");
    expect(frame).toContain("Resume failed: session lock is stale");
    expect(frame).not.toContain("other");
    cleanup();
  });

  test("formats relative timestamps at stable unit boundaries", () => {
    expect(formatRelativeTime("2026-07-12T11:59:30.000Z", NOW)).toBe("just now");
    expect(formatRelativeTime("2026-07-12T11:59:00.000Z", NOW)).toBe("1 minute ago");
    expect(formatRelativeTime("2026-07-12T11:48:00.000Z", NOW)).toBe("12 minutes ago");
    expect(formatRelativeTime("2026-07-12T11:00:00.000Z", NOW)).toBe("1 hour ago");
    expect(formatRelativeTime("2026-07-12T09:00:00.000Z", NOW)).toBe("3 hours ago");
    expect(formatRelativeTime("2026-07-11T12:00:00.000Z", NOW)).toBe("1 day ago");
    expect(formatRelativeTime("2026-07-10T12:00:00.000Z", NOW)).toBe("2 days ago");
  });
});

function summary(
  index: number,
  status: SessionSummary["status"],
  overrides: {
    minutesAgo?: number;
    turns?: number;
    prompt?: string;
    statusDetail?: string;
  } = {},
): SessionSummary {
  return {
    sessionId: `019f000${index}-0000-7000-8000-00000000000${index}` as SessionId,
    modelName: "deepseek-v4-flash",
    createdAt: "2026-07-12T10:00:00.000Z",
    updatedAt: new Date(
      NOW.getTime() - (overrides.minutesAgo ?? 5) * 60_000,
    ).toISOString(),
    turnCount: overrides.turns ?? 1,
    firstUserPromptPreview: overrides.prompt ?? `prompt-${index}`,
    status,
    databaseBytes: 1_024,
    ...(overrides.statusDetail === undefined
      ? {}
      : { statusDetail: overrides.statusDetail }),
  };
}

async function press(stdin: { write: (data: string) => void }, ...keys: string[]) {
  for (const key of keys) {
    stdin.write(key);
    await Bun.sleep(15);
  }
}

async function pressEscape(stdin: { write: (data: string) => void }) {
  stdin.write(ESCAPE);
  await Bun.sleep(60);
}

function stripAnsi(value: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (value ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}
