import { Box, Text, useInput, useWindowSize } from "ink";
import { useState } from "react";
import type { SessionSummary } from "../../session/session-catalog";

const SESSION_ROWS = 3;
const PICKER_CHROME_ROWS = 3;

export type ResumeSessionPickerProps = {
  sessions: readonly SessionSummary[];
  isResuming?: boolean;
  error?: string;
  now?: Date;
  visibleItemCount?: number;
  onCancel: () => void;
  onSelect: (session: SessionSummary) => void;
};

type PickerPosition = {
  selectedIndex: number;
  windowStart: number;
};

export function ResumeSessionPicker(props: ResumeSessionPickerProps) {
  if (props.sessions.length === 0) {
    throw new Error("ResumeSessionPicker requires at least one session.");
  }

  return <ResumeSessionPickerContent {...props} />;
}

function ResumeSessionPickerContent(props: ResumeSessionPickerProps) {
  const { rows } = useWindowSize();
  const visibleItemCount = Math.min(
    props.sessions.length,
    Math.max(
      1,
      Math.floor(props.visibleItemCount ?? (rows - PICKER_CHROME_ROWS) / SESSION_ROWS),
    ),
  );
  const [position, setPosition] = useState<PickerPosition>(() => ({
    selectedIndex: initialSelectedIndex(props.sessions),
    windowStart: 0,
  }));
  const windowStart = keepSelectionVisible(
    position.windowStart,
    position.selectedIndex,
    visibleItemCount,
    props.sessions.length,
  );
  const windowEnd = Math.min(props.sessions.length, windowStart + visibleItemCount);
  const selectedSession = props.sessions[position.selectedIndex];

  useInput(
    (input, key) => {
      if (key.escape) {
        props.onCancel();
        return;
      }

      if (key.return) {
        if (selectedSession !== undefined && isSessionSelectable(selectedSession)) {
          props.onSelect(selectedSession);
        }
        return;
      }

      const direction =
        key.upArrow || (input === "k" && !key.ctrl && !key.meta)
          ? -1
          : key.downArrow || (input === "j" && !key.ctrl && !key.meta)
            ? 1
            : 0;
      if (direction === 0) {
        return;
      }

      setPosition((current) => {
        const selectedIndex = clamp(
          current.selectedIndex + direction,
          0,
          props.sessions.length - 1,
        );
        const nextWindowStart = keepSelectionVisible(
          current.windowStart,
          selectedIndex,
          visibleItemCount,
          props.sessions.length,
        );
        if (
          selectedIndex === current.selectedIndex &&
          nextWindowStart === current.windowStart
        ) {
          return current;
        }
        return { selectedIndex, windowStart: nextWindowStart };
      });
    },
    { isActive: props.isResuming !== true },
  );

  const now = props.now ?? new Date();
  return (
    <Box flexDirection="column">
      <Text bold>Resume session</Text>
      <Text dimColor>
        {props.isResuming === true
          ? `Resuming ${shortSessionId(selectedSession?.sessionId ?? "")}`
          : "↑/↓ or j/k to move · Enter to resume · Esc to cancel"}
      </Text>
      {props.sessions.slice(windowStart, windowEnd).map((session, offset) => (
        <SessionOption
          key={session.sessionId}
          session={session}
          isSelected={windowStart + offset === position.selectedIndex}
          now={now}
        />
      ))}
      <Text
        color={props.error === undefined ? undefined : "red"}
        dimColor={props.error === undefined}
        wrap="truncate-end"
      >
        {props.error === undefined
          ? formatWindowStatus(windowStart, windowEnd, props.sessions.length)
          : `Resume failed: ${singleLine(props.error)}`}
      </Text>
    </Box>
  );
}

export function ResumeSessionPickerLoading(props: { onCancel: () => void }) {
  useInput((_input, key) => {
    if (key.escape) {
      props.onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Resume session</Text>
      <Text dimColor>Loading sessions for this workspace… · Esc to cancel</Text>
    </Box>
  );
}

function SessionOption(props: {
  session: SessionSummary;
  isSelected: boolean;
  now: Date;
}) {
  const selectable = isSessionSelectable(props.session);
  const marker = props.isSelected ? "❯ " : "  ";
  const preview =
    singleLine(props.session.firstUserPromptPreview ?? "") || "(no prompt)";

  return (
    <Box flexDirection="column">
      <Text
        color={props.isSelected && selectable ? "cyan" : undefined}
        bold={props.isSelected && selectable}
        dimColor={!selectable}
        wrap="truncate-end"
      >
        {marker}
        {formatRelativeTime(props.session.updatedAt, props.now)} ·{" "}
        {props.session.turnCount} {props.session.turnCount === 1 ? "turn" : "turns"} ·{" "}
        {sessionStatusText(props.session)}
      </Text>
      <Box marginLeft={2} overflow="hidden">
        <Text dimColor={!selectable} wrap="truncate-end">
          {preview}
        </Text>
      </Box>
      <Box marginLeft={2} overflow="hidden">
        <Box flexGrow={1} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {singleLine(props.session.modelName)}
          </Text>
        </Box>
        <Text dimColor> {shortSessionId(props.session.sessionId)}</Text>
      </Box>
    </Box>
  );
}

export function isSessionSelectable(session: SessionSummary): boolean {
  return session.status === "resumable" || session.status === "interrupted";
}

export function formatRelativeTime(updatedAt: string, now: Date): string {
  const timestamp = Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid session timestamp: ${updatedAt}`);
  }

  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
  if (elapsedSeconds < 60) {
    return "just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return formatAgo(elapsedMinutes, "minute");
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return formatAgo(elapsedHours, "hour");
  }

  return formatAgo(Math.floor(elapsedHours / 24), "day");
}

function initialSelectedIndex(sessions: readonly SessionSummary[]): number {
  const selectableIndex = sessions.findIndex(isSessionSelectable);
  return selectableIndex === -1 ? 0 : selectableIndex;
}

function keepSelectionVisible(
  windowStart: number,
  selectedIndex: number,
  visibleItemCount: number,
  itemCount: number,
): number {
  const maxWindowStart = Math.max(0, itemCount - visibleItemCount);
  let nextWindowStart = clamp(windowStart, 0, maxWindowStart);
  if (selectedIndex < nextWindowStart) {
    nextWindowStart = selectedIndex;
  } else if (selectedIndex >= nextWindowStart + visibleItemCount) {
    nextWindowStart = selectedIndex - visibleItemCount + 1;
  }
  return clamp(nextWindowStart, 0, maxWindowStart);
}

function sessionStatusText(session: SessionSummary): string {
  switch (session.status) {
    case "resumable":
      return "resumable";
    case "interrupted":
      return "interrupted · completes record; no tool retry";
    case "current":
      return "current session · not selectable";
    case "active":
      return "in use by another Tinker process";
    case "incomplete":
      return "initialization incomplete · cannot resume";
    case "unavailable":
      return `unavailable: ${singleLine(session.statusDetail ?? "") || "session data is unavailable"}`;
  }
}

function shortSessionId(sessionId: string): string {
  return `${sessionId.slice(0, 8)}…`;
}

function formatWindowStatus(start: number, end: number, total: number): string {
  if (start === 0 && end === total) {
    return `${total} ${total === 1 ? "session" : "sessions"}`;
  }
  return `Showing ${start + 1}–${end} / ${total}${start > 0 ? " · ↑ more above" : ""}${end < total ? " · ↓ more below" : ""}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatAgo(value: number, unit: "minute" | "hour" | "day"): string {
  return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}
