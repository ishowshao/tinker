import { describe, expect, test } from "bun:test";
import {
  backspace,
  createLineEditorState,
  deleteForward,
  insert,
  moveLeft,
  moveRight,
  moveToEnd,
  moveToStart,
  splitAtCursor,
} from "../tui/line-editor";

describe("line editor", () => {
  test("creates state with cursor at end", () => {
    expect(createLineEditorState()).toEqual({ value: "", cursor: 0 });
    expect(createLineEditorState("abc")).toEqual({ value: "abc", cursor: 3 });
  });

  test("inserts text at the cursor", () => {
    const state = insert(createLineEditorState("hello"), " world");
    expect(state).toEqual({ value: "hello world", cursor: 11 });
  });

  test("inserts text in the middle", () => {
    const middle = { value: "held", cursor: 2 };
    expect(insert(middle, "llo wor")).toEqual({ value: "hello world", cursor: 9 });
  });

  test("inserting empty text is a no-op", () => {
    const state = createLineEditorState("abc");
    expect(insert(state, "")).toBe(state);
  });

  test("counts cursor by code points for wide characters", () => {
    const state = insert(createLineEditorState("你好"), "😀");
    expect(state.cursor).toBe(3);
    expect(state.value).toBe("你好😀");

    const backOne = moveLeft(state);
    expect(insert(backOne, "世界").value).toBe("你好世界😀");
  });

  test("backspace removes the character before the cursor", () => {
    expect(backspace(createLineEditorState("abc"))).toEqual({
      value: "ab",
      cursor: 2,
    });
    expect(backspace({ value: "abc", cursor: 1 })).toEqual({ value: "bc", cursor: 0 });
  });

  test("backspace at the start is a no-op", () => {
    const state = { value: "abc", cursor: 0 };
    expect(backspace(state)).toBe(state);
  });

  test("deleteForward removes the character at the cursor", () => {
    expect(deleteForward({ value: "abc", cursor: 1 })).toEqual({
      value: "ac",
      cursor: 1,
    });
  });

  test("deleteForward at the end is a no-op", () => {
    const state = createLineEditorState("abc");
    expect(deleteForward(state)).toBe(state);
  });

  test("moves the cursor within bounds", () => {
    const state = createLineEditorState("ab");
    expect(moveLeft(state).cursor).toBe(1);
    expect(moveLeft(moveLeft(state)).cursor).toBe(0);
    expect(moveLeft(moveLeft(moveLeft(state))).cursor).toBe(0);
    expect(moveRight({ value: "ab", cursor: 0 }).cursor).toBe(1);
    expect(moveRight(state).cursor).toBe(2);
    expect(moveToStart(state).cursor).toBe(0);
    expect(moveToEnd({ value: "ab", cursor: 0 }).cursor).toBe(2);
  });

  test("splits the value around the cursor", () => {
    expect(splitAtCursor({ value: "abc", cursor: 1 })).toEqual({
      before: "a",
      at: "b",
      after: "c",
    });
    expect(splitAtCursor(createLineEditorState("abc"))).toEqual({
      before: "abc",
      at: " ",
      after: "",
    });
  });
});
