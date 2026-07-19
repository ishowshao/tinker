import { describe, expect, test } from "bun:test";
import {
  findFileMention,
  rankWorkspaceFiles,
  replaceFileMention,
} from "../tui/file-mention";
import { createLineEditorState } from "../tui/line-editor";

describe("file mention", () => {
  test("recognizes @ tokens at input start or after whitespace", () => {
    expect(findFileMention(createLineEditorState("@"))).toEqual({
      start: 0,
      end: 1,
      query: "",
    });
    expect(findFileMention(createLineEditorState("open @src"))).toEqual({
      start: 5,
      end: 9,
      query: "src",
    });
    expect(findFileMention(createLineEditorState("open\t@src"))).toEqual({
      start: 5,
      end: 9,
      query: "src",
    });
    expect(findFileMention(createLineEditorState("open　@src"))).toEqual({
      start: 5,
      end: 9,
      query: "src",
    });
  });

  test("does not activate for mid-word @ or after a completed token", () => {
    expect(findFileMention(createLineEditorState("name@example.com"))).toBeUndefined();
    expect(findFileMention(createLineEditorState("open @src "))).toBeUndefined();
  });

  test("keeps the entire token active while the cursor is inside it", () => {
    expect(findFileMention({ value: "open @source next", cursor: 8 })).toEqual({
      start: 5,
      end: 12,
      query: "source",
    });
  });

  test("replaces the whole token with an unquoted path and one separator", () => {
    const editor = createLineEditorState("看 @old next");
    const mention = findFileMention({ ...editor, cursor: 6 });
    expect(mention).toBeDefined();

    const replaced = replaceFileMention(editor, mention!, "src/空 file.ts");

    expect(replaced.value).toBe("看 src/空 file.ts next");
    expect(replaced.cursor).toBe([..."看 src/空 file.ts "].length);
  });

  test("adds a separator before the end of input or a newline", () => {
    const atEnd = createLineEditorState("@old");
    const beforeNewline = { value: "@old\nnext", cursor: 4 };

    expect(
      replaceFileMention(atEnd, findFileMention(atEnd)!, "path with space.ts"),
    ).toEqual({
      value: "path with space.ts ",
      cursor: [..."path with space.ts "].length,
    });
    expect(
      replaceFileMention(beforeNewline, findFileMention(beforeNewline)!, "src/file.ts"),
    ).toEqual({
      value: "src/file.ts \nnext",
      cursor: [..."src/file.ts "].length,
    });
  });

  test("orders a bare @ by shallow path depth", () => {
    const matches = rankWorkspaceFiles(
      [
        "src/tui/components/prompt-input.tsx",
        "docs/design.md",
        "README.md",
        "src/index.ts",
        "package.json",
      ],
      "",
    );

    expect(matches.map((match) => match.path)).toEqual([
      "package.json",
      "README.md",
      "docs/design.md",
      "src/index.ts",
      "src/tui/components/prompt-input.tsx",
    ]);
  });

  test("fuzzy matches case-insensitively and favors the basename", () => {
    const matches = rankWorkspaceFiles(
      [
        "src/tui/components/prompt-input.tsx",
        "prompt-archive/item.ts",
        "docs/PROMPT-guide.md",
        "src/index.ts",
      ],
      "PI",
    );

    expect(matches[0]?.path).toBe("src/tui/components/prompt-input.tsx");
    expect(matches.map((match) => match.path)).not.toContain("src/index.ts");
    expect(matches[0]?.indices.length).toBe(2);
  });

  test("limits the popup result count", () => {
    const files = Array.from({ length: 12 }, (_, index) => `file-${index}.ts`);
    expect(rankWorkspaceFiles(files, "")).toHaveLength(8);
  });
});
