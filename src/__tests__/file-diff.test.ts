import { describe, expect, test } from "bun:test";
import {
  MAX_PATCH_LINES,
  computeFilePatch,
  countPatchChanges,
  parseDiffHunks,
} from "../tools/file-diff";

describe("computeFilePatch", () => {
  test("produces hunks with line numbers and context", () => {
    const oldContent = "one\ntwo\nthree\nfour\nfive\n";
    const newContent = "one\ntwo\nTHREE\nfour\nfive\n";

    const patch = computeFilePatch({
      filePath: "notes.txt",
      oldContent,
      newContent,
    });

    expect(patch.truncated).toBe(false);
    expect(patch.hunks).toHaveLength(1);
    expect(patch.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1 });
    expect(patch.hunks[0]?.lines).toEqual([
      " one",
      " two",
      "-three",
      "+THREE",
      " four",
      " five",
    ]);
  });

  test("marks all lines as additions for a new file", () => {
    const patch = computeFilePatch({
      filePath: "new.txt",
      oldContent: "",
      newContent: "a\nb\n",
    });

    expect(patch.hunks).toHaveLength(1);
    expect(patch.hunks[0]?.lines).toEqual(["+a", "+b"]);
  });

  test("truncates patches beyond the line limit", () => {
    const oldContent = "";
    const newContent = Array.from(
      { length: MAX_PATCH_LINES + 50 },
      (_, index) => `line ${index}`,
    ).join("\n");

    const patch = computeFilePatch({
      filePath: "big.txt",
      oldContent,
      newContent,
    });

    const totalLines = patch.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    expect(patch.truncated).toBe(true);
    expect(totalLines).toBe(MAX_PATCH_LINES);
  });
});

describe("countPatchChanges", () => {
  test("counts additions and deletions across hunks", () => {
    const changes = countPatchChanges([
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        lines: [" ctx", "-old", "+new", "+extra"],
      },
    ]);

    expect(changes).toEqual({ additions: 2, deletions: 1 });
  });
});

describe("parseDiffHunks", () => {
  test("round-trips hunks produced by computeFilePatch", () => {
    const patch = computeFilePatch({
      filePath: "notes.txt",
      oldContent: "a\n",
      newContent: "b\n",
    });

    expect(parseDiffHunks(patch.hunks)).toEqual(patch.hunks);
  });

  test("rejects malformed values", () => {
    expect(parseDiffHunks(undefined)).toBeUndefined();
    expect(parseDiffHunks("not-an-array")).toBeUndefined();
    expect(parseDiffHunks([{ oldStart: 1 }])).toBeUndefined();
    expect(
      parseDiffHunks([
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [42] },
      ]),
    ).toBeUndefined();
  });
});
