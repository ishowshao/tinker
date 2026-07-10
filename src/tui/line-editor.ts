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

export function deleteToLineStart(state: LineEditorState): LineEditorState {
  const chars = [...state.value];
  const lineStart = currentLineStart(chars, state.cursor);

  if (state.cursor > lineStart) {
    chars.splice(lineStart, state.cursor - lineStart);
    return { value: chars.join(""), cursor: lineStart };
  }

  if (lineStart === 0) {
    return state;
  }

  chars.splice(lineStart - 1, 1);
  return { value: chars.join(""), cursor: lineStart - 1 };
}

export function moveLeft(state: LineEditorState): LineEditorState {
  return state.cursor === 0 ? state : { ...state, cursor: state.cursor - 1 };
}

export function moveRight(state: LineEditorState): LineEditorState {
  return state.cursor >= codePointLength(state.value)
    ? state
    : { ...state, cursor: state.cursor + 1 };
}

export function moveToLineStart(state: LineEditorState): LineEditorState {
  const chars = [...state.value];
  const lineStart = currentLineStart(chars, state.cursor);

  if (state.cursor !== lineStart || lineStart === 0) {
    return { ...state, cursor: lineStart };
  }

  return {
    ...state,
    cursor: lineStart === 1 ? 0 : chars.lastIndexOf("\n", lineStart - 2) + 1,
  };
}

export function moveToLineEnd(state: LineEditorState): LineEditorState {
  const chars = [...state.value];
  const lineBreak = chars.indexOf("\n", state.cursor);
  const lineEnd = lineBreak === -1 ? chars.length : lineBreak;

  if (state.cursor !== lineEnd || lineEnd === chars.length) {
    return { ...state, cursor: lineEnd };
  }

  const nextLineBreak = chars.indexOf("\n", lineEnd + 1);
  return {
    ...state,
    cursor: nextLineBreak === -1 ? chars.length : nextLineBreak,
  };
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

function currentLineStart(chars: string[], cursor: number): number {
  return cursor === 0 ? 0 : chars.lastIndexOf("\n", cursor - 1) + 1;
}

function codePointLength(value: string): number {
  return [...value].length;
}
