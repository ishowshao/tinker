import { Box, Text, useInput, usePaste, useWindowSize } from "ink";
import { useReducer, useRef } from "react";
import type { SessionSummary } from "../../session/session-catalog";
import {
  backspace,
  createLineEditorState,
  deleteForward,
  deleteToLineStart,
  insert,
  moveLeft,
  moveRight,
  moveToLineEnd,
  moveToLineStart,
  splitAtCursor,
  type LineEditorState,
} from "../line-editor";

const SESSION_ROWS = 1;
const BROWSE_CHROME_ROWS = 3;
const SEARCH_CHROME_ROWS = 4;
const MAX_DISPLAYED_SESSIONS = 20;
const MARKER_COLUMN_WIDTH = 2;
const TIME_COLUMN_WIDTH = 10;
const TURN_COLUMN_WIDTH = 11;
const STATUS_COLUMN_WIDTH = 13;
const PROFILE_COLUMN_WIDTH = 16;
const SESSION_ROW_BACKGROUNDS = ["#1c1c1c", "#101010"] as const;

export type ResumeSessionPickerProps = {
  sessions: readonly SessionSummary[];
  isResuming?: boolean;
  error?: string;
  now?: Date;
  viewportRows?: number;
  viewportColumns?: number;
  visibleItemCount?: number;
  onCancel: () => void;
  onSelect: (session: SessionSummary) => void;
};

type PickerState = {
  mode: "browse" | "search";
  editor: LineEditorState;
  selectedIndex: number;
  windowStart: number;
};

type PickerAction =
  | { type: "enter_search" }
  | { type: "clear_search" }
  | { type: "move_selection"; direction: -1 | 1 }
  | { type: "move_editor_cursor"; update: (editor: LineEditorState) => LineEditorState }
  | { type: "change_query"; update: (editor: LineEditorState) => LineEditorState };

export function ResumeSessionPicker(props: ResumeSessionPickerProps) {
  if (props.sessions.length === 0) {
    throw new Error("ResumeSessionPicker requires at least one session.");
  }

  return <ResumeSessionPickerContent {...props} />;
}

function ResumeSessionPickerContent(props: ResumeSessionPickerProps) {
  const windowSize = useWindowSize();
  const rows = props.viewportRows ?? windowSize.rows - 1;
  const columns = Math.max(1, props.viewportColumns ?? windowSize.columns);

  const displayedFor = (value: string): readonly SessionSummary[] => {
    const nextCandidates =
      normalizeSearchText(value) === ""
        ? props.sessions
        : props.sessions.filter((session) => matchesSessionPreview(session, value));
    return nextCandidates.slice(0, MAX_DISPLAYED_SESSIONS);
  };

  const visibleCountFor = (mode: PickerState["mode"], displayedCount: number) => {
    const chromeRows = mode === "search" ? SEARCH_CHROME_ROWS : BROWSE_CHROME_ROWS;
    return Math.min(
      Math.max(displayedCount, 1),
      Math.max(
        1,
        Math.floor(props.visibleItemCount ?? (rows - chromeRows) / SESSION_ROWS),
      ),
    );
  };

  const reduce = (state: PickerState, action: PickerAction): PickerState => {
    switch (action.type) {
      case "enter_search": {
        if (state.mode === "search") {
          return state;
        }
        return { ...state, mode: "search" };
      }
      case "clear_search": {
        const displayed = displayedFor("");
        return {
          mode: "browse",
          editor: createLineEditorState(),
          selectedIndex: initialSelectedIndex(displayed),
          windowStart: 0,
        };
      }
      case "move_selection": {
        const query = state.mode === "search" ? state.editor.value : "";
        const displayed = displayedFor(query);
        if (displayed.length === 0) {
          return state;
        }
        const selectedIndex = clamp(
          state.selectedIndex + action.direction,
          0,
          displayed.length - 1,
        );
        const windowStart = keepSelectionVisible(
          state.windowStart,
          selectedIndex,
          visibleCountFor(state.mode, displayed.length),
          displayed.length,
        );
        if (
          selectedIndex === state.selectedIndex &&
          windowStart === state.windowStart
        ) {
          return state;
        }
        return { ...state, selectedIndex, windowStart };
      }
      case "move_editor_cursor": {
        const editor = action.update(state.editor);
        return editor === state.editor ? state : { ...state, editor };
      }
      case "change_query": {
        const editor = action.update(state.editor);
        if (editor === state.editor) {
          return state;
        }
        const displayed = displayedFor(editor.value);
        return {
          mode: "search",
          editor,
          selectedIndex: displayed.length === 0 ? 0 : initialSelectedIndex(displayed),
          windowStart: 0,
        };
      }
    }
  };

  const [state, baseDispatch] = useReducer(reduce, undefined, () => ({
    mode: "browse" as const,
    editor: createLineEditorState(),
    selectedIndex: initialSelectedIndex(
      props.sessions.slice(0, MAX_DISPLAYED_SESSIONS),
    ),
    windowStart: 0,
  }));
  // Input events can arrive faster than React re-renders. Every state change
  // goes through dispatch, which keeps this ref in sync with the exact action
  // fold, so handlers always read and reduce the latest state instead of a
  // stale render closure.
  const stateRef = useRef(state);
  const dispatch = (action: PickerAction) => {
    stateRef.current = reduce(stateRef.current, action);
    baseDispatch(action);
  };

  const query = state.mode === "search" ? state.editor.value : "";
  const searching = normalizeSearchText(query) !== "";
  const candidates = searching
    ? props.sessions.filter((session) => matchesSessionPreview(session, query))
    : props.sessions;
  const matchCount = candidates.length;
  const displayedSessions = candidates.slice(0, MAX_DISPLAYED_SESSIONS);
  const visibleItemCount = visibleCountFor(state.mode, displayedSessions.length);
  const selectedIndex = clamp(
    state.selectedIndex,
    0,
    Math.max(displayedSessions.length - 1, 0),
  );
  const windowStart = keepSelectionVisible(
    state.windowStart,
    selectedIndex,
    visibleItemCount,
    displayedSessions.length,
  );
  const windowEnd = Math.min(displayedSessions.length, windowStart + visibleItemCount);
  const selectedSession = displayedSessions[selectedIndex];

  const selectCurrent = () => {
    const current = stateRef.current;
    const currentQuery = current.mode === "search" ? current.editor.value : "";
    const displayed = displayedFor(currentQuery);
    const session =
      displayed[clamp(current.selectedIndex, 0, Math.max(displayed.length - 1, 0))];
    if (session !== undefined && isSessionSelectable(session)) {
      props.onSelect(session);
    }
  };

  useInput(
    (input, key) => {
      if (stateRef.current.mode === "search") {
        if (key.escape) {
          dispatch({ type: "clear_search" });
          return;
        }
        if (key.return) {
          selectCurrent();
          return;
        }
        if (key.upArrow) {
          dispatch({ type: "move_selection", direction: -1 });
          return;
        }
        if (key.downArrow) {
          dispatch({ type: "move_selection", direction: 1 });
          return;
        }
        if (key.leftArrow) {
          dispatch({ type: "move_editor_cursor", update: moveLeft });
          return;
        }
        if (key.rightArrow) {
          dispatch({ type: "move_editor_cursor", update: moveRight });
          return;
        }
        if (key.backspace) {
          dispatch({ type: "change_query", update: backspace });
          return;
        }
        if (key.delete) {
          dispatch({ type: "change_query", update: deleteForward });
          return;
        }
        if (key.ctrl) {
          if (input === "a") {
            dispatch({ type: "move_editor_cursor", update: moveToLineStart });
          } else if (input === "e") {
            dispatch({ type: "move_editor_cursor", update: moveToLineEnd });
          } else if (input === "u") {
            dispatch({ type: "change_query", update: deleteToLineStart });
          } else if (input === "d") {
            dispatch({ type: "change_query", update: deleteForward });
          }
          return;
        }
        if (key.meta || key.pageUp || key.pageDown || input === "") {
          return;
        }
        dispatch({
          type: "change_query",
          update: (editor) => insert(editor, normalizeQueryInput(input)),
        });
        return;
      }

      if (key.escape) {
        props.onCancel();
        return;
      }
      if (key.return) {
        selectCurrent();
        return;
      }
      if (input === "/" && !key.ctrl && !key.meta) {
        dispatch({ type: "enter_search" });
        return;
      }

      const direction =
        key.upArrow || (input === "k" && !key.ctrl && !key.meta)
          ? -1
          : key.downArrow || (input === "j" && !key.ctrl && !key.meta)
            ? 1
            : 0;
      if (direction !== 0) {
        dispatch({ type: "move_selection", direction });
      }
    },
    { isActive: props.isResuming !== true },
  );

  usePaste(
    (text) => {
      if (stateRef.current.mode !== "search") {
        return;
      }
      dispatch({
        type: "change_query",
        update: (editor) => insert(editor, normalizeQueryInput(text)),
      });
    },
    { isActive: props.isResuming !== true },
  );

  const now = props.now ?? new Date();
  return (
    <Box width={columns} flexDirection="column" overflow="hidden">
      <Text bold>Resume session</Text>
      {state.mode === "search" ? <SearchLine editor={state.editor} /> : null}
      <Text dimColor>
        {props.isResuming === true
          ? `Resuming ${shortSessionId(selectedSession?.sessionId ?? "")}`
          : state.mode === "search"
            ? "↑/↓ to move · Enter to resume · Esc to clear search"
            : "↑/↓ or j/k to move · / to search · Enter to resume · Esc to cancel"}
      </Text>
      {displayedSessions.slice(windowStart, windowEnd).map((session, offset) => (
        <SessionOption
          key={session.sessionId}
          session={session}
          isSelected={windowStart + offset === selectedIndex}
          now={now}
          rowIndex={windowStart + offset}
          columns={columns}
        />
      ))}
      <Text
        color={props.error === undefined ? undefined : "red"}
        dimColor={props.error === undefined}
        wrap="truncate-end"
      >
        {props.error === undefined
          ? formatFooter({
              searching,
              query,
              matchCount,
              windowStart,
              windowEnd,
              totalCount: props.sessions.length,
              selectedSession,
            })
          : `Resume failed: ${singleLine(props.error)}`}
      </Text>
    </Box>
  );
}

function SearchLine(props: { editor: LineEditorState }) {
  const { before, at, after } = splitAtCursor(props.editor);
  return (
    <Text wrap="truncate-end">
      Search: {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
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

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function matchesSessionPreview(session: SessionSummary, query: string): boolean {
  const terms = normalizeSearchText(query).split(" ").filter(Boolean);
  if (terms.length === 0) {
    return true;
  }
  const preview = normalizeSearchText(session.firstUserPromptPreview ?? "");
  return preview !== "" && terms.every((term) => preview.includes(term));
}

function SessionOption(props: {
  session: SessionSummary;
  isSelected: boolean;
  now: Date;
  rowIndex: number;
  columns: number;
}) {
  const selectable = isSessionSelectable(props.session);
  const marker = props.isSelected ? "❯ " : "  ";
  const preview =
    singleLine(props.session.firstUserPromptPreview ?? "") || "(no prompt)";
  const profile = singleLine(props.session.profileName ?? "") || "—";

  return (
    <Box
      width={props.columns}
      height={SESSION_ROWS}
      overflow="hidden"
      backgroundColor={
        SESSION_ROW_BACKGROUNDS[props.rowIndex % SESSION_ROW_BACKGROUNDS.length]
      }
    >
      <SessionCell
        value={marker}
        width={MARKER_COLUMN_WIDTH}
        isSelected={props.isSelected}
        isDisabled={!selectable}
      />
      <SessionCell
        value={formatRelativeTime(props.session.updatedAt, props.now)}
        width={TIME_COLUMN_WIDTH}
        isSelected={props.isSelected}
        isDisabled={!selectable}
        padRight
      />
      <SessionCell
        value={`${props.session.turnCount} ${props.session.turnCount === 1 ? "turn" : "turns"}`}
        width={TURN_COLUMN_WIDTH}
        isSelected={props.isSelected}
        isDisabled={!selectable}
        padRight
      />
      <SessionCell
        value={sessionStatusLabel(props.session)}
        width={STATUS_COLUMN_WIDTH}
        isSelected={props.isSelected}
        isDisabled={!selectable}
        padRight
      />
      <SessionCell
        value={profile}
        width={PROFILE_COLUMN_WIDTH}
        isSelected={props.isSelected}
        isDisabled={!selectable}
        padRight
      />
      <SessionCell
        value={preview}
        isSelected={props.isSelected}
        isDisabled={!selectable}
      />
    </Box>
  );
}

function SessionCell(props: {
  value: string;
  width?: number;
  isSelected: boolean;
  isDisabled: boolean;
  padRight?: boolean;
}) {
  const selected = props.isSelected && !props.isDisabled;
  return (
    <Box
      width={props.width}
      minWidth={props.width === undefined ? 0 : undefined}
      flexGrow={props.width === undefined ? 1 : 0}
      flexShrink={props.width === undefined ? 1 : 0}
      paddingRight={props.padRight === true ? 1 : 0}
      overflow="hidden"
    >
      <Text
        color={selected ? "cyan" : undefined}
        bold={selected}
        dimColor={props.isDisabled}
        wrap="truncate-end"
      >
        {props.value}
      </Text>
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
    return "now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  return `${Math.floor(elapsedHours / 24)}d ago`;
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

function sessionStatusLabel(session: SessionSummary): string {
  return session.status;
}

function sessionStatusDetail(session: SessionSummary): string | undefined {
  switch (session.status) {
    case "resumable":
      return undefined;
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

function formatFooter(input: {
  searching: boolean;
  query: string;
  matchCount: number;
  windowStart: number;
  windowEnd: number;
  totalCount: number;
  selectedSession?: SessionSummary;
}): string {
  const detail =
    input.selectedSession === undefined
      ? undefined
      : sessionStatusDetail(input.selectedSession);
  const withDetail = (status: string) =>
    detail === undefined ? status : `${status} · ${detail}`;

  if (input.searching) {
    if (input.matchCount === 0) {
      return `No sessions match "${singleLine(input.query)}" · Esc to clear search`;
    }
    if (input.matchCount > MAX_DISPLAYED_SESSIONS) {
      return withDetail(
        `Showing ${input.windowStart + 1}–${input.windowEnd} / ${MAX_DISPLAYED_SESSIONS} results · ${input.matchCount} matches total`,
      );
    }
    return withDetail(
      `${input.matchCount} ${input.matchCount === 1 ? "match" : "matches"}`,
    );
  }
  if (input.totalCount > MAX_DISPLAYED_SESSIONS) {
    return withDetail(
      `Showing ${input.windowStart + 1}–${input.windowEnd} / ${MAX_DISPLAYED_SESSIONS} recent · ${input.totalCount} sessions total`,
    );
  }
  return withDetail(
    formatWindowStatus(input.windowStart, input.windowEnd, input.totalCount),
  );
}

function formatWindowStatus(start: number, end: number, total: number): string {
  if (start === 0 && end === total) {
    return `${total} ${total === 1 ? "session" : "sessions"}`;
  }
  return `Showing ${start + 1}–${end} / ${total}${start > 0 ? " · ↑ more above" : ""}${end < total ? " · ↓ more below" : ""}`;
}

function normalizeQueryInput(value: string): string {
  return value.replace(/\s+/g, " ");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
