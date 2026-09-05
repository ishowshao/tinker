import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskOutput } from "../tools/task-output";
import { parseTaskOutputArgs } from "../tools/task-tool-args";
import {
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_LINE_BYTES,
} from "../tools/bounded-output-preview";

async function withOutput(run: (output: TaskOutput) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-output-range-"));
  const output = await TaskOutput.create(path.join(directory, "output.log"));
  try {
    await run(output);
  } finally {
    await output.end();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("TaskOutput range arguments", () => {
  test("preserves default mode and supplies independent range defaults", () => {
    expect(parseTaskOutputArgs({ task_id: "task" })).toEqual({
      ok: true,
      taskId: "task",
    });
    expect(parseTaskOutputArgs({ task_id: "task", offset: 100 })).toEqual({
      ok: true,
      taskId: "task",
      range: { offset: 100, limit: 200 },
    });
    expect(parseTaskOutputArgs({ task_id: "task", limit: 500 })).toEqual({
      ok: true,
      taskId: "task",
      range: { offset: 1, limit: 500 },
    });
  });
  test.each([
    0,
    -1,
    1.5,
    "100",
    null,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid ranges %j", (value) => {
    for (const field of ["offset", "limit"]) {
      expect(parseTaskOutputArgs({ task_id: "task", [field]: value })).toMatchObject({
        ok: false,
      });
    }
  });
  test("still rejects unknown arguments and missing task IDs", () => {
    expect(parseTaskOutputArgs({ offset: 1 })).toMatchObject({ ok: false });
    expect(parseTaskOutputArgs({ task_id: "task", cursor: "old" })).toMatchObject({
      ok: false,
    });
  });
});

describe("TaskOutput consecutive range capture", () => {
  test("does not count CRLF terminators against the per-line content limit", async () => {
    await withOutput(async (output) => {
      output.write(Buffer.from("x".repeat(MAX_PREVIEW_LINE_BYTES) + "\r\n"));
      expect((await output.readRange({ offset: 1, limit: 1 })).truncated).toBe(false);
    });
  });

  test("aborts range file reads and detects unexpectedly shortened logs", async () => {
    await withOutput(async (output) => {
      output.write(Buffer.from("one\ntwo\n"));
      await output.end();
      const controller = new AbortController();
      controller.abort();
      const aborted = await output
        .readRange({ offset: 1, limit: 2 }, controller.signal)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(aborted).toBeInstanceOf(Error);
      await truncate(output.filePath, 1);
      const shortened = await output.readRange({ offset: 1, limit: 2 }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(shortened).toBeInstanceOf(Error);
      expect((shortened as Error).message).toContain("captured byte boundary");
    });
  });

  test("returns 500 consecutive lines without head/tail omission and supports random rereads", async () => {
    await withOutput(async (output) => {
      output.write(
        Buffer.from(
          Array.from({ length: 1_200 }, (_, i) => `line ${i + 1}\n`).join(""),
        ),
      );
      for (const ended of [false, true]) {
        if (ended) await output.end();
        const range = await output.readRange({ offset: 100, limit: 500 });
        expect(range.outputLines).toBe(1_200);
        expect(range.truncated).toBe(false);
        expect(range.omittedLines).toBeUndefined();
        expect(range.range).toEqual({
          offset: 100,
          limit: 500,
          displayedStartLine: 100,
          displayedEndLine: 599,
        });
        expect(range.preview.split("\n")).toEqual(
          Array.from({ length: 500 }, (_, i) => `${100 + i}: line ${100 + i}`),
        );
        expect(await output.readRange({ offset: 100, limit: 500 })).toEqual(range);
        expect((await output.readRange({ offset: 2, limit: 1 })).preview).toBe(
          "2: line 2",
        );
      }
      expect(output.snapshot().truncated).toBe(true);
    });
  });

  test("EOF, empty logs, and out-of-range reads are not truncation", async () => {
    await withOutput(async (output) => {
      expect(await output.readRange({ offset: 1, limit: 500 })).toMatchObject({
        preview: "",
        truncated: false,
        outputLines: 0,
      });
      output.write(Buffer.from(Array.from({ length: 350 }, () => "x\n").join("")));
      const range = await output.readRange({ offset: 100, limit: 500 });
      expect(range.truncated).toBe(false);
      expect(range.range?.displayedEndLine).toBe(350);
      const beyond = await output.readRange({
        offset: Number.MAX_SAFE_INTEGER,
        limit: Number.MAX_SAFE_INTEGER,
      });
      expect(beyond).toMatchObject({ preview: "", truncated: false });
      expect(beyond.range?.displayedStartLine).toBeUndefined();
    });
  });

  test("total byte limit stops at a continuous prefix, allowing the next line to be read", async () => {
    await withOutput(async (output) => {
      output.write(
        Buffer.from(
          Array.from({ length: 100 }, () => "x".repeat(2_000) + "\n").join(""),
        ),
      );
      const range = await output.readRange({ offset: 10, limit: 50 });
      const end = range.range?.displayedEndLine ?? 0;
      expect(end).toBeGreaterThan(10);
      expect(end).toBeLessThan(59);
      expect(Buffer.byteLength(range.preview)).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
      expect(range.truncated).toBe(true);
      expect(range.omittedLines).toBe(59 - end);
      expect(
        range.preview.split("\n").map((line) => Number(line.split(":")[0])),
      ).toEqual(Array.from({ length: end - 9 }, (_, i) => i + 10));
      expect(
        (await output.readRange({ offset: end + 1, limit: 1 })).preview,
      ).toStartWith(`${end + 1}: `);
    });
  });

  test("clips a huge Unicode line without corrupting UTF-8 or skipping subsequent lines", async () => {
    await withOutput(async (output) => {
      output.write(Buffer.from("😀".repeat(100_000) + "\nlast\n"));
      const range = await output.readRange({ offset: 1, limit: 2 });
      expect(range.truncated).toBe(true);
      expect(range.omittedLines).toBeUndefined();
      expect(range.preview).toContain("line truncated");
      expect(range.preview).not.toContain("�");
      expect(range.preview).toEndWith("\n2: last");
      expect(Buffer.byteLength(range.preview)).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
    });
  });

  test("captures a fixed byte prefix while later output arrives and rereads a growing last line", async () => {
    await withOutput(async (output) => {
      output.write(Buffer.from("ready\npartial"));
      const pending = output.readRange({ offset: 2, limit: 10 });
      output.write(Buffer.from(" done\nnext\n"));
      expect(await pending).toMatchObject({
        outputLines: 2,
        preview: "2: partial",
        truncated: false,
      });
      expect(await output.readRange({ offset: 2, limit: 10 })).toMatchObject({
        outputLines: 3,
        preview: "2: partial done\n3: next",
        truncated: false,
      });
    });
  });

  test("matches CRLF, blank lines, and split UTF-8 counting", async () => {
    await withOutput(async (output) => {
      const emoji = Buffer.from("😀");
      output.write(Buffer.concat([Buffer.from("one\r\n\nlast"), emoji.subarray(0, 2)]));
      expect(await output.readRange({ offset: 1, limit: 20 })).toMatchObject({
        outputLines: 3,
        preview: "1: one\n2: \n3: last",
        truncated: false,
      });
      output.write(emoji.subarray(2));
      expect((await output.readRange({ offset: 3, limit: 1 })).preview).toBe(
        "3: last😀",
      );
      await output.end();
      expect((await output.readRange({ offset: 3, limit: 1 })).preview).toBe(
        "3: last😀",
      );
    });
  });
});
