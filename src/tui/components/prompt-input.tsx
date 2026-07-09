import { Box, Text, useInput } from "ink";
import { useState } from "react";
import {
  backspace,
  createLineEditorState,
  deleteForward,
  insert,
  type LineEditorState,
  moveLeft,
  moveRight,
  moveToEnd,
  moveToStart,
  splitAtCursor,
} from "../line-editor";
import { matchSlashCommands, type SlashCommand } from "../slash-commands";

export type PromptInputProps = {
  isDisabled?: boolean;
  placeholder?: string;
  history?: { entries: readonly string[] };
  commands?: readonly SlashCommand[];
  onSubmit: (value: string) => void;
};

type HistoryNavigation = {
  index: number;
  draft: string;
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

      if (editor.value === current.editor.value) {
        return { ...current, editor };
      }

      return { ...current, editor, suggestionIndex: 0, suggestionsDismissed: false };
    });
  };

  const navigateUp = () => {
    setState((current) => {
      const entries = props.history?.entries ?? [];

      if (current.navigation === undefined) {
        if (entries.length === 0) {
          return current;
        }

        const index = entries.length - 1;
        return {
          editor: createLineEditorState(entries[index] ?? ""),
          navigation: { index, draft: current.editor.value },
          suggestionIndex: 0,
          suggestionsDismissed: true,
        };
      }

      if (current.navigation.index === 0) {
        return current;
      }

      const index = current.navigation.index - 1;
      return {
        editor: createLineEditorState(entries[index] ?? ""),
        navigation: { ...current.navigation, index },
        suggestionIndex: 0,
        suggestionsDismissed: true,
      };
    });
  };

  const navigateDown = () => {
    setState((current) => {
      if (current.navigation === undefined) {
        return current;
      }

      const entries = props.history?.entries ?? [];

      if (current.navigation.index >= entries.length - 1) {
        return createPromptInputState(current.navigation.draft);
      }

      const index = current.navigation.index + 1;
      return {
        editor: createLineEditorState(entries[index] ?? ""),
        navigation: { ...current.navigation, index },
        suggestionIndex: 0,
        suggestionsDismissed: true,
      };
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
          updateEditor(moveToStart);
        } else if (input === "e") {
          updateEditor(moveToEnd);
        } else if (input === "d") {
          updateEditor(deleteForward);
        }
        return;
      }

      if (key.meta || key.pageUp || key.pageDown) {
        return;
      }

      const lineBreakIndex = firstLineBreakIndex(input);
      if (lineBreakIndex !== undefined) {
        submit(insert(state.editor, input.slice(0, lineBreakIndex)).value);
        return;
      }

      if (input !== "") {
        updateEditor((editor) => insert(editor, input));
      }
    },
    { isActive: props.isDisabled !== true },
  );

  const showSuggestions = suggestions.length > 0 && props.isDisabled !== true;

  return (
    <Box flexDirection="column">
      <Box>
        <Text>Input: </Text>
        {renderEditor(state.editor, props)}
      </Box>
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
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}

function firstLineBreakIndex(value: string): number | undefined {
  const carriageReturn = value.indexOf("\r");
  const lineFeed = value.indexOf("\n");

  if (carriageReturn === -1) {
    return lineFeed === -1 ? undefined : lineFeed;
  }

  if (lineFeed === -1) {
    return carriageReturn;
  }

  return Math.min(carriageReturn, lineFeed);
}
