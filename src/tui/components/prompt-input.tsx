import os from "node:os";
import path from "node:path";
import { Box, Text, useInput, usePaste } from "ink";
import { useState } from "react";
import type { ContextUsageSnapshot } from "../../agent/context-meter";
import { formatContextUsageLine } from "../context-format";
import {
  backspace,
  createLineEditorState,
  deleteForward,
  deleteToLineStart,
  insert,
  type LineEditorState,
  moveDown,
  moveLeft,
  moveRight,
  moveToLineEnd,
  moveToLineStart,
  moveUp,
  splitAtCursor,
} from "../line-editor";
import { matchSlashCommands, type SlashCommand } from "../slash-commands";

export type PromptInputProps = {
  modelName: string;
  workspaceRoot: string;
  gitBranch?: string;
  contextUsage?: ContextUsageSnapshot;
  isDisabled?: boolean;
  placeholder?: string;
  history?: { entries: readonly string[] };
  commands?: readonly SlashCommand[];
  onSubmit: (value: string) => void;
};

type HistoryNavigation = {
  index: number;
  originalDraft: LineEditorState;
  browsing: boolean;
};

type PromptInputState = {
  editor: LineEditorState;
  navigation?: HistoryNavigation;
  suggestionIndex: number;
  suggestionsDismissed: boolean;
};

function createPromptInputState(value = ""): PromptInputState {
  return {
    editor: createLineEditorState(value),
    suggestionIndex: 0,
    suggestionsDismissed: false,
  };
}

export function PromptInput(props: PromptInputProps) {
  const [state, setState] = useState<PromptInputState>(createPromptInputState);

  const suggestions = state.suggestionsDismissed
    ? []
    : matchSlashCommands(state.editor.value, props.commands);
  const selectedIndex =
    suggestions.length === 0
      ? 0
      : Math.min(state.suggestionIndex, suggestions.length - 1);

  const submit = (value: string) => {
    props.onSubmit(value);
    setState(createPromptInputState());
  };

  const updateEditor = (update: (editor: LineEditorState) => LineEditorState) => {
    setState((current) => {
      const editor = update(current.editor);

      if (!editorChanged(current.editor, editor)) {
        return current;
      }

      return applyEditorChange(current, editor);
    });
  };

  const navigateUp = () => {
    setState((current) => {
      const entries = props.history?.entries ?? [];

      if (current.navigation?.browsing === true) {
        return navigateHistoryUp(current, entries);
      }

      const editor = moveUp(current.editor);
      if (editorChanged(current.editor, editor)) {
        return applyEditorChange(current, editor);
      }

      return navigateHistoryUp(current, entries);
    });
  };

  const navigateDown = () => {
    setState((current) => {
      const entries = props.history?.entries ?? [];

      if (current.navigation?.browsing === true) {
        return navigateHistoryDown(current, entries);
      }

      const editor = moveDown(current.editor);
      return editorChanged(current.editor, editor)
        ? applyEditorChange(current, editor)
        : navigateHistoryDown(current, entries);
    });
  };

  useInput(
    (input, key) => {
      const selected = suggestions[selectedIndex];

      if (key.return) {
        if (selected !== undefined) {
          submit(`/${selected.name}`);
          return;
        }

        submit(state.editor.value);
        return;
      }

      if (key.tab) {
        if (selected !== undefined) {
          setState(createPromptInputState(`/${selected.name} `));
        }
        return;
      }

      if (key.escape) {
        if (suggestions.length > 0) {
          setState((current) => ({ ...current, suggestionsDismissed: true }));
        }
        return;
      }

      if (key.upArrow) {
        if (suggestions.length > 0) {
          setState((current) => ({
            ...current,
            suggestionIndex:
              (selectedIndex + suggestions.length - 1) % suggestions.length,
          }));
          return;
        }

        navigateUp();
        return;
      }

      if (key.downArrow) {
        if (suggestions.length > 0) {
          setState((current) => ({
            ...current,
            suggestionIndex: (selectedIndex + 1) % suggestions.length,
          }));
          return;
        }

        navigateDown();
        return;
      }

      if (key.leftArrow) {
        updateEditor(moveLeft);
        return;
      }

      if (key.rightArrow) {
        updateEditor(moveRight);
        return;
      }

      if (key.backspace || key.delete) {
        updateEditor(backspace);
        return;
      }

      if (key.ctrl) {
        if (input === "a") {
          updateEditor(moveToLineStart);
        } else if (input === "e") {
          updateEditor(moveToLineEnd);
        } else if (input === "d") {
          updateEditor(deleteForward);
        } else if (input === "u") {
          updateEditor(deleteToLineStart);
        }
        return;
      }

      if (key.meta || key.pageUp || key.pageDown) {
        return;
      }

      if (input !== "") {
        updateEditor((editor) => insert(editor, normalizeLineBreaks(input)));
      }
    },
    { isActive: props.isDisabled !== true },
  );

  usePaste(
    (text) => {
      updateEditor((editor) => insert(editor, normalizeLineBreaks(text)));
    },
    { isActive: props.isDisabled !== true },
  );

  const showSuggestions = suggestions.length > 0 && props.isDisabled !== true;

  return (
    <Box flexDirection="column">
      <Box width="100%" borderStyle="single" borderLeft={false} borderRight={false}>
        {renderEditor(state.editor, props)}
      </Box>
      {showSuggestions ? null : (
        <Box>
          <Text dimColor>
            {props.modelName} · {formatWorkspacePath(props.workspaceRoot)}
            {props.gitBranch === undefined ? null : ` · ${props.gitBranch}`}
          </Text>
          {props.contextUsage === undefined ? null : (
            <>
              <Text dimColor> · </Text>
              <Text
                color={contextColor(props.contextUsage.pressure)}
                dimColor={props.contextUsage.pressure === "normal"}
              >
                {formatContextUsageLine(props.contextUsage)}
              </Text>
            </>
          )}
        </Box>
      )}
      {showSuggestions ? (
        <Box flexDirection="column">
          {suggestions.map((command, index) => (
            <Text key={command.name}>
              {index === selectedIndex ? "❯ " : "  "}/{command.name}
              <Text dimColor> {command.description}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function contextColor(
  pressure: ContextUsageSnapshot["pressure"],
): "yellow" | "red" | undefined {
  if (pressure === "blocked") {
    return "red";
  }
  return pressure === "triggered" ? "yellow" : undefined;
}

function formatWorkspacePath(workspaceRoot: string): string {
  const home = os.homedir();
  const relative = path.relative(home, workspaceRoot);

  if (relative === "") {
    return home;
  }

  const isInsideHome =
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);

  return isInsideHome ? `~${path.sep}${relative}` : workspaceRoot;
}

function renderEditor(editor: LineEditorState, props: PromptInputProps) {
  if (editor.value === "") {
    const placeholder = props.placeholder ?? "";

    if (props.isDisabled === true) {
      return <Text dimColor>{placeholder}</Text>;
    }

    if (placeholder === "") {
      return <Text inverse> </Text>;
    }

    return (
      <Text>
        <Text inverse>{placeholder.slice(0, 1)}</Text>
        <Text dimColor>{placeholder.slice(1)}</Text>
      </Text>
    );
  }

  if (props.isDisabled === true) {
    return <Text>{editor.value}</Text>;
  }

  const { before, at, after } = splitAtCursor(editor);
  if (at === "\n") {
    return (
      <Text>
        {before}
        <Text inverse> </Text>
        {"\n"}
        {after}
      </Text>
    );
  }

  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}

function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function editorChanged(before: LineEditorState, after: LineEditorState): boolean {
  return before.value !== after.value || before.cursor !== after.cursor;
}

function applyEditorChange(
  state: PromptInputState,
  editor: LineEditorState,
): PromptInputState {
  const valueChanged = state.editor.value !== editor.value;
  let navigation = state.navigation;

  if (valueChanged) {
    navigation = undefined;
  } else if (navigation !== undefined) {
    navigation = { ...navigation, browsing: false };
  }

  return {
    ...state,
    editor,
    navigation,
    suggestionIndex: valueChanged ? 0 : state.suggestionIndex,
    suggestionsDismissed: valueChanged ? false : state.suggestionsDismissed,
  };
}

function navigateHistoryUp(
  state: PromptInputState,
  entries: readonly string[],
): PromptInputState {
  if (entries.length === 0) {
    return state;
  }

  if (state.navigation === undefined) {
    const index = entries.length - 1;
    return showHistoryEntry(state, entries, {
      index,
      originalDraft: state.editor,
      browsing: true,
    });
  }

  if (state.navigation.index === 0) {
    return {
      ...state,
      navigation: { ...state.navigation, browsing: true },
    };
  }

  const navigation = {
    ...state.navigation,
    index: state.navigation.index - 1,
    browsing: true,
  };
  return showHistoryEntry(state, entries, navigation);
}

function navigateHistoryDown(
  state: PromptInputState,
  entries: readonly string[],
): PromptInputState {
  const navigation = state.navigation;
  if (navigation === undefined) {
    return state;
  }

  if (navigation.index >= entries.length - 1) {
    return {
      editor: navigation.originalDraft,
      suggestionIndex: 0,
      suggestionsDismissed: false,
    };
  }

  const nextNavigation = {
    ...navigation,
    index: navigation.index + 1,
    browsing: true,
  };
  return showHistoryEntry(state, entries, nextNavigation);
}

function showHistoryEntry(
  state: PromptInputState,
  entries: readonly string[],
  navigation: HistoryNavigation,
): PromptInputState {
  const entry = entries[navigation.index];
  if (entry === undefined) {
    throw new Error(`History entry ${navigation.index} does not exist`);
  }

  return {
    ...state,
    editor: createLineEditorState(entry),
    navigation,
    suggestionIndex: 0,
    suggestionsDismissed: true,
  };
}
