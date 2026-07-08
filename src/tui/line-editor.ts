export type LineEditorState = {
  value: string;
  cursor: number;
};

export function createLineEditorState(value = ""): LineEditorState {
  return { value, cursor: codePointLength(value) };
}

export function insert(state: LineEditorState, text: string): LineEditorState {
  if (text === "") {
    return state;
  }

  const chars = [...state.value];
  const inserted = [...text];
  chars.splice(state.cursor, 0, ...inserted);
  return { value: chars.join(""), cursor: state.cursor + inserted.length };
}

export function backspace(state: LineEditorState): LineEditorState {
  if (state.cursor === 0) {
    return state;
  }

  const chars = [...state.value];
  chars.splice(state.cursor - 1, 1);
  return { value: chars.join(""), cursor: state.cursor - 1 };
}

export function deleteForward(state: LineEditorState): LineEditorState {
  const chars = [...state.value];
  if (state.cursor >= chars.length) {
    return state;
  }

  chars.splice(state.cursor, 1);
  return { value: chars.join(""), cursor: state.cursor };
}

export function moveLeft(state: LineEditorState): LineEditorState {
  return state.cursor === 0 ? state : { ...state, cursor: state.cursor - 1 };
}

export function moveRight(state: LineEditorState): LineEditorState {
  return state.cursor >= codePointLength(state.value)
    ? state
    : { ...state, cursor: state.cursor + 1 };
}

export function moveToStart(state: LineEditorState): LineEditorState {
  return { ...state, cursor: 0 };
}

export function moveToEnd(state: LineEditorState): LineEditorState {
  return { ...state, cursor: codePointLength(state.value) };
}

export function splitAtCursor(state: LineEditorState): {
  before: string;
  at: string;
  after: string;
} {
  const chars = [...state.value];
  return {
    before: chars.slice(0, state.cursor).join(""),
    at: chars[state.cursor] ?? " ",
    after: chars.slice(state.cursor + 1).join(""),
  };
}

function codePointLength(value: string): number {
  return [...value].length;
}
