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

export type PromptInputProps = {
  isDisabled?: boolean;
  placeholder?: string;
  history?: { entries: readonly string[] };
  onSubmit: (value: string) => void;
};

type HistoryNavigation = {
  index: number;
  draft: string;
};

type PromptInputState = {
  editor: LineEditorState;
  navigation?: HistoryNavigation;
};

export function PromptInput(props: PromptInputProps) {
  const [state, setState] = useState<PromptInputState>({
    editor: createLineEditorState(),
  });

  const submit = (value: string) => {
    props.onSubmit(value);
    setState({ editor: createLineEditorState() });
  };

  const updateEditor = (update: (editor: LineEditorState) => LineEditorState) => {
    setState((current) => ({ ...current, editor: update(current.editor) }));
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
        };
      }

      if (current.navigation.index === 0) {
        return current;
      }

      const index = current.navigation.index - 1;
      return {
        editor: createLineEditorState(entries[index] ?? ""),
        navigation: { ...current.navigation, index },
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
        return { editor: createLineEditorState(current.navigation.draft) };
      }

      const index = current.navigation.index + 1;
      return {
        editor: createLineEditorState(entries[index] ?? ""),
        navigation: { ...current.navigation, index },
      };
    });
  };

  useInput(
    (input, key) => {
      if (key.return) {
        submit(state.editor.value);
        return;
      }

      if (key.upArrow) {
        navigateUp();
        return;
      }

      if (key.downArrow) {
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

      if (key.escape || key.tab || key.meta || key.pageUp || key.pageDown) {
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

  return (
    <Box>
      <Text>Input: </Text>
      {renderEditor(state.editor, props)}
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
