import { describe, expect, test } from "bun:test";
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

  test("deletes to the line start while preserving text after the cursor", () => {
    expect(deleteToLineStart({ value: "first\nsecond\nthird", cursor: 9 })).toEqual({
      value: "first\nond\nthird",
      cursor: 6,
    });
    expect(deleteToLineStart({ value: "first\n你😀好", cursor: 8 })).toEqual({
      value: "first\n好",
      cursor: 6,
    });
  });

  test("joins the current line to the previous line when already at line start", () => {
    const joined = deleteToLineStart({ value: "first\nond\nthird", cursor: 6 });
    expect(joined).toEqual({ value: "firstond\nthird", cursor: 5 });
    expect(deleteToLineStart(joined)).toEqual({ value: "ond\nthird", cursor: 0 });
  });

  test("is a no-op at the first line start", () => {
    const state = { value: "first\nsecond", cursor: 0 };
    expect(deleteToLineStart(state)).toBe(state);
  });

  test("moves the cursor within bounds", () => {
    const state = createLineEditorState("ab");
    expect(moveLeft(state).cursor).toBe(1);
    expect(moveLeft(moveLeft(state)).cursor).toBe(0);
    expect(moveLeft(moveLeft(moveLeft(state))).cursor).toBe(0);
    expect(moveRight({ value: "ab", cursor: 0 }).cursor).toBe(1);
    expect(moveRight(state).cursor).toBe(2);
    expect(moveToLineStart(state).cursor).toBe(0);
    expect(moveToLineEnd({ value: "ab", cursor: 0 }).cursor).toBe(2);
  });

  test("moves to the start and end of the current logical line", () => {
    const value = "first\nsecond\nthird";

    expect(moveToLineStart({ value, cursor: 9 }).cursor).toBe(6);
    expect(moveToLineEnd({ value, cursor: 9 }).cursor).toBe(12);
    expect(moveToLineStart({ value, cursor: 12 }).cursor).toBe(6);
    expect(moveToLineEnd({ value, cursor: 12 }).cursor).toBe(18);
    expect(moveToLineStart({ value, cursor: 15 }).cursor).toBe(13);
    expect(moveToLineEnd({ value, cursor: 15 }).cursor).toBe(18);
    expect(moveToLineStart({ value: "first\n", cursor: 6 }).cursor).toBe(0);
    expect(moveToLineEnd({ value: "first\n", cursor: 6 }).cursor).toBe(6);
  });

  test("repeatedly moves across line starts and ends", () => {
    const value = "first\nsecond\nthird";

    const thirdStart = moveToLineStart({ value, cursor: 15 });
    const secondStart = moveToLineStart(thirdStart);
    expect(thirdStart.cursor).toBe(13);
    expect(secondStart.cursor).toBe(6);
    expect(moveToLineStart(secondStart).cursor).toBe(0);
    expect(moveToLineStart({ value, cursor: 0 }).cursor).toBe(0);

    const firstEnd = moveToLineEnd({ value, cursor: 2 });
    const secondEnd = moveToLineEnd(firstEnd);
    const thirdEnd = moveToLineEnd(secondEnd);
    expect(firstEnd.cursor).toBe(5);
    expect(secondEnd.cursor).toBe(12);
    expect(thirdEnd.cursor).toBe(18);
    expect(moveToLineEnd(thirdEnd).cursor).toBe(18);
    expect(moveToLineStart({ value: "\nsecond", cursor: 1 }).cursor).toBe(0);
    expect(moveToLineEnd({ value: "\nsecond", cursor: 0 }).cursor).toBe(7);
  });

  test("moves by code point within lines containing wide characters", () => {
    const value = "你\n😀x";
    expect(moveToLineStart({ value, cursor: 3 }).cursor).toBe(2);
    expect(moveToLineEnd({ value, cursor: 3 }).cursor).toBe(4);
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
