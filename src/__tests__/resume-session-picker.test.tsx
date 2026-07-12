import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { SessionId } from "../ids/runtime-id";
import type { SessionSummary } from "../session/session-catalog";
import {
  formatRelativeTime,
  ResumeSessionPicker,
} from "../tui/components/resume-session-picker";

const ARROW_UP = "\u001b[A";
const ARROW_DOWN = "\u001b[B";
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

function stripAnsi(value: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (value ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}
