import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ObservationBuilder } from "../observation/observation-builder";
import { decodeStoredToolRawResult } from "../session/session-tool-result-codec";
import { createGrepToolExecutor, type GrepToolOptions } from "../tools/grep";
import { createTestRuntime } from "./test-runtime";

async function withWorkspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tinker-grep-context-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function search(
  root: string,
  args: Record<string, unknown>,
  ripgrep?: GrepToolOptions["ripgrep"],
) {
  const executor = createGrepToolExecutor({
    workspaceRoot: root,
    cwdState: { cwd: root },
    ripgrep,
  });
  const call = createTestRuntime().toolCall({
    name: "Grep",
    args: { output_mode: "content", ...args },
  });
  const raw = await executor.execute(call.args, call, {
    signal: new AbortController().signal,
  });
  if (raw.kind !== "grep") throw new Error("Expected Grep result");
  expect(raw.ok).toBe(true);
  // Exercise the same raw-result decoding boundary used by resumed sessions.
  const restored = decodeStoredToolRawResult(JSON.parse(JSON.stringify(raw)));
  return {
    raw,
    text: new ObservationBuilder().build({ call, raw: restored }).displayText,
  };
}

describe("Grep context pagination", () => {
  test("real multiline matches retain snippets on both long Unicode lines", async () => {
    await withWorkspace(async (root) => {
      await writeFile(
        path.join(root, "multi.txt"),
        "界".repeat(600) + "START\r\nEND" + "😀".repeat(600) + "\n",
      );
      const { raw, text } = await search(root, {
        pattern: "START\\r?\\nEND",
        multiline: true,
        head_limit: 1,
      });
      expect(text).toBe(
        "multi.txt:1:[... 500 code points omitted ...]" +
          "界".repeat(100) +
          "START\n" +
          "multi.txt:2:END" +
          "😀".repeat(100) +
          "[... 500 code points omitted ...]",
      );
      expect(raw).toMatchObject({
        totalResults: 1,
        returnedResults: 1,
        numLines: 2,
        paginationUnit: "match_events",
        hasMore: false,
      });
    });
  });

  test("long-line snippets survive real rg, persistence, observation and pagination", async () => {
    await withWorkspace(async (root) => {
      await writeFile(
        path.join(root, "long.txt"),
        "context" +
          "x".repeat(600) +
          "\n" +
          "界😀".repeat(350) +
          "NEEDLE_END\n" +
          "x".repeat(700) +
          "NEEDLE_END\n",
      );
      const first = await search(root, {
        pattern: "NEEDLE_END",
        "-B": 1,
        head_limit: 1,
      });
      expect(first.text).toContain("long.txt-1-context");
      expect(first.text).toContain(
        "long.txt:2:[... 600 code points omitted ...]" +
          "界😀".repeat(50) +
          "NEEDLE_END",
      );
      expect(first.raw).toMatchObject({
        totalResults: 2,
        returnedResults: 1,
        nextOffset: 1,
        numLines: 2,
      });
      const second = await search(root, {
        pattern: "NEEDLE_END",
        "-B": 1,
        head_limit: 1,
        offset: 1,
      });
      expect(second.text).toContain(
        "long.txt:3:[... 600 code points omitted ...]" + "x".repeat(100) + "NEEDLE_END",
      );
      expect(second.raw).toMatchObject({ returnedResults: 1, hasMore: false });
    });
  });

  test("a single hit retains all after-context and has no next page", async () => {
    await withWorkspace(async (root) => {
      await writeFile(
        path.join(root, "many.ts"),
        [
          "start",
          ...Array.from({ length: 300 }, (_, i) => `match_${i + 1}`),
          "end",
          "",
        ].join("\n"),
      );
      const { raw, text } = await search(root, {
        pattern: "match_1$",
        "-A": 3,
        head_limit: 1,
      });
      expect(text).toBe(
        "many.ts:2:match_1\nmany.ts-3-match_2\nmany.ts-4-match_3\nmany.ts-5-match_4",
      );
      expect(raw).toMatchObject({
        totalResults: 1,
        returnedResults: 1,
        numLines: 4,
        paginationUnit: "matching_lines",
        hasMore: false,
        searchIncomplete: false,
        contextMayBeIncomplete: false,
      });
      expect(raw.nextOffset).toBeUndefined();
      expect(raw.truncated).toBeUndefined();
    });
  });

  test.each([
    {
      contextArgs: { "-B": 2 },
      expected: "a.txt-2-before1\na.txt-3-before2\na.txt:4:HIT",
    },
    {
      contextArgs: { "-A": 2 },
      expected: "a.txt:4:HIT\na.txt-5-after1\na.txt-6-after2",
    },
    {
      contextArgs: { context: 2 },
      expected:
        "a.txt-2-before1\na.txt-3-before2\na.txt:4:HIT\na.txt-5-after1\na.txt-6-after2",
    },
    {
      contextArgs: { "-C": 2 },
      expected:
        "a.txt-2-before1\na.txt-3-before2\na.txt:4:HIT\na.txt-5-after1\na.txt-6-after2",
    },
    {
      contextArgs: { "-B": 1, "-A": 2 },
      expected: "a.txt-3-before2\na.txt:4:HIT\na.txt-5-after1\na.txt-6-after2",
    },
    {
      contextArgs: { context: 1, "-C": 2, "-B": 3, "-A": 3 },
      expected: "a.txt-3-before2\na.txt:4:HIT\na.txt-5-after1",
    },
    {
      contextArgs: { "-C": 1, "-B": 3, "-A": 3 },
      expected: "a.txt-3-before2\na.txt:4:HIT\na.txt-5-after1",
    },
    { contextArgs: { context: 0, "-B": 3, "-A": 3 }, expected: "a.txt:4:HIT" },
  ])("keeps the hit with its resolved context: $contextArgs", async ({
    contextArgs,
    expected,
  }) => {
    await withWorkspace(async (root) => {
      await writeFile(
        path.join(root, "a.txt"),
        "outside\nbefore1\nbefore2\nHIT\nafter1\nafter2\noutside\n",
      );
      expect(
        (await search(root, { pattern: "HIT", head_limit: 1, ...contextArgs })).text,
      ).toBe(expected);
    });
  });

  test("nearby hits do not consume the page or recursively expand its context", async () => {
    await withWorkspace(async (root) => {
      await writeFile(
        path.join(root, "a.txt"),
        "start\nHIT1\nHIT2\nHIT3\nafter\nend\n",
      );
      const args = { pattern: "HIT", "-A": 1, head_limit: 1 };
      const first = await search(root, args);
      expect(first.text).toBe(
        "a.txt:2:HIT1\na.txt:3:HIT2\n\nMore results available; nextOffset=1.",
      );
      expect(first.raw).toMatchObject({
        totalResults: 3,
        returnedResults: 1,
        numLines: 2,
        hasMore: true,
        searchIncomplete: false,
      });
      const second = await search(root, { ...args, offset: first.raw.nextOffset });
      expect(second.text).toBe(
        "a.txt:3:HIT2\na.txt:4:HIT3\n\nMore results available; nextOffset=2.",
      );
      const third = await search(root, { ...args, offset: second.raw.nextOffset });
      expect(third.text).toBe("a.txt:4:HIT3\na.txt-5-after\n\nEnd of results.");
      expect(third.raw.hasMore).toBe(false);
      const merged = await search(root, { pattern: "HIT", context: 1, head_limit: 2 });
      expect(merged.raw.content).toBe(
        "a.txt-1-start\na.txt:2:HIT1\na.txt:3:HIT2\na.txt:4:HIT3",
      );
      expect(merged.raw.returnedResults).toBe(2);
    });
  });

  test("disjoint windows and file boundaries retain only the selected contexts", async () => {
    await withWorkspace(async (root) => {
      await writeFile(path.join(root, "a.txt"), "HIT\nafter\nskip\nskip\nbefore\nHIT");
      await writeFile(path.join(root, "b.txt"), "before\nHIT\nafter\n");
      const { raw, text } = await search(root, {
        pattern: "HIT",
        context: 1,
        head_limit: 2,
      });
      expect(raw.content).toBe(
        "a.txt:1:HIT\na.txt-2-after\na.txt-5-before\na.txt:6:HIT",
      );
      expect(raw.numFiles).toBe(1);
      expect(text).toContain("nextOffset=2");
      const second = await search(root, {
        pattern: "HIT",
        context: 1,
        head_limit: 2,
        offset: 2,
        "-n": false,
      });
      expect(second.text).toBe(
        "b.txt-before\nb.txt:HIT\nb.txt-after\n\nEnd of results.",
      );
      expect(second.raw).toMatchObject({
        returnedResults: 1,
        hasMore: false,
        contextMayBeIncomplete: false,
      });
    });
  });

  test("multiline match events remain whole on each page with before/after context", async () => {
    await withWorkspace(async (root) => {
      await writeFile(
        path.join(root, "a.txt"),
        "before\nBEGIN\nEND\nafter\ngap\nbefore\nBEGIN\nEND\nafter\n",
      );
      const args = {
        pattern: "BEGIN\\nEND",
        multiline: true,
        context: 1,
        head_limit: 1,
      };
      const first = await search(root, args);
      expect(first.raw.content).toBe(
        "a.txt-1-before\na.txt:2:BEGIN\na.txt:3:END\na.txt-4-after",
      );
      expect(first.raw).toMatchObject({
        totalResults: 2,
        returnedResults: 1,
        numLines: 4,
        paginationUnit: "match_events",
        nextOffset: 1,
      });
      const second = await search(root, { ...args, offset: first.raw.nextOffset });
      expect(second.text).toBe(
        "a.txt-6-before\na.txt:7:BEGIN\na.txt:8:END\na.txt-9-after\n\nEnd of results.",
      );
      const noContext = await search(root, { ...args, context: 0 });
      expect(noContext.raw.content).toBe("a.txt:2:BEGIN\na.txt:3:END");
    });
  });

  test("multiple occurrences on one line consume one content result", async () => {
    await withWorkspace(async (root) => {
      await writeFile(path.join(root, "a.txt"), "HIT HIT\nafter\nHIT\n");
      const { raw } = await search(root, { pattern: "HIT", "-A": 1, head_limit: 1 });
      expect(raw).toMatchObject({
        totalResults: 2,
        returnedResults: 1,
        nextOffset: 1,
        content: "a.txt:1:HIT HIT\na.txt-2-after",
      });
    });
  });

  test("default limit counts 250 hits, while unlimited and exhausted pages use the same offsets", async () => {
    await withWorkspace(async (root) => {
      await writeFile(
        path.join(root, "a.txt"),
        "before\nHIT\nafter\ngap\n".repeat(251),
      );
      const args = { pattern: "HIT", context: 1 };
      const first = await search(root, args);
      expect(first.raw).toMatchObject({
        totalResults: 251,
        returnedResults: 250,
        numLines: 750,
        nextOffset: 250,
      });
      expect(first.raw.content?.split("\n").at(-1)).toBe("a.txt-999-after");
      const rest = await search(root, { ...args, offset: 250, head_limit: 0 });
      expect(rest.raw).toMatchObject({
        returnedResults: 1,
        numLines: 3,
        hasMore: false,
      });
      const full = await search(root, { ...args, head_limit: 0 });
      expect(full.raw).toMatchObject({
        returnedResults: 251,
        numLines: 753,
        hasMore: false,
      });
      const empty = await search(root, { ...args, offset: 251 });
      expect(empty.text).toBe(
        "No results on this page at offset 251.\n\nEnd of results.",
      );
      expect(empty.raw).toMatchObject({
        returnedResults: 0,
        numLines: 0,
        hasMore: false,
      });
      expect((await search(root, { ...args, pattern: "missing" })).text).toBe(
        "No matches found",
      );
    });
  });

  test("buffer-limited searches distinguish collected pages from incomplete context", async () => {
    await withWorkspace(async (root) => {
      await writeFile(path.join(root, "a.txt"), "HIT\nafter\n".repeat(1000));
      const { raw, text } = await search(
        root,
        { pattern: "HIT", "-A": 1, head_limit: 1 },
        { maxBufferBytes: 4096 },
      );
      expect(raw).toMatchObject({
        searchIncomplete: true,
        contextMayBeIncomplete: true,
        hasMore: true,
        nextOffset: 1,
        returnedResults: 1,
      });
      expect(text).toContain("More collected results available; nextOffset=1.");
      expect(text).toContain("Warning: results are incomplete.");
      expect(text).toContain(
        "requested context may be incomplete because the search stopped early",
      );
    });
  });

  test("timeout after a hit warns about missing after-context without inventing a next page", async () => {
    await withWorkspace(async (root) => {
      const executable = path.join(root, "fake-rg");
      await writeFile(
        path.join(root, "partial.jsonl"),
        JSON.stringify({
          type: "match",
          data: { path: { text: "a.txt" }, line_number: 2, lines: { text: "HIT\n" } },
        }) + "\n",
      );
      await writeFile(
        executable,
        '#!/bin/sh\ncat "$(dirname "$0")/partial.jsonl"\nexec sleep 5\n',
      );
      await chmod(executable, 0o755);
      const { raw, text } = await search(
        root,
        { pattern: "HIT", "-A": 3, head_limit: 1 },
        { command: executable, timeoutMs: 1000 },
      );
      expect(raw).toMatchObject({
        content: "a.txt:2:HIT",
        searchIncomplete: true,
        contextMayBeIncomplete: true,
        hasMore: false,
        totalResults: 1,
      });
      expect(text).toContain("timed out");
      expect(text).toContain("requested context may be incomplete");
      expect(text).not.toContain("nextOffset");
    });
  });
});
