import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  buildBoundedOutputPreview,
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_LINE_BYTES,
  MAX_PREVIEW_LINES,
  PREVIEW_EDGE_LINES,
  takeUtf8Prefix,
  takeUtf8Suffix,
} from "../tools/bounded-output-preview";
import { buildOutputSnapshotFromText } from "../tools/task-output-snapshot";

describe("bounded output preview", () => {
  test("preserves empty and small output exactly and deterministically", () => {
    expect(preview([])).toEqual({ preview: "", truncated: false });

    const lines = ["alpha", "beta", "gamma"];
    const first = preview(lines);
    expect(first).toEqual({
      preview: lines.join("\n"),
      truncated: false,
    });
    for (let index = 0; index < 5; index += 1) {
      expect(preview(lines)).toEqual(first);
    }
  });

  test("keeps 200 lines and windows 201 lines with the same complete and streaming contract", () => {
    const twoHundred = numberedLines(MAX_PREVIEW_LINES);
    expect(preview(twoHundred)).toEqual({
      preview: twoHundred.join("\n"),
      truncated: false,
    });

    const twoHundredOne = numberedLines(MAX_PREVIEW_LINES + 1);
    const complete = preview(twoHundredOne);
    const streaming = buildBoundedOutputPreview({
      outputLines: twoHundredOne.length,
      firstLines: twoHundredOne.slice(0, PREVIEW_EDGE_LINES),
      lastLines: twoHundredOne.slice(-PREVIEW_EDGE_LINES),
    });

    expect(complete).toEqual(streaming);
    expect(complete.truncated).toBe(true);
    expect(complete.omittedLines).toBe(1);
    expect(complete.preview).toContain("line-100\n");
    expect(complete.preview).toContain(
      "... output omitted: lines 101-101 (1 line). Full output is available at outputFilePath.",
    );
    expect(complete.preview).toContain("\nline-102");
    expect(complete.preview).not.toContain("\nline-101\n");
  });

  test("bounds a one-MiB logical line and reports its exact omitted UTF-8 bytes", () => {
    const line = `HEAD-${"x".repeat(1024 * 1024)}-TAIL`;
    const result = preview([line]);
    const marker = result.preview.match(
      /\.\.\. (\d+) UTF-8 bytes omitted from this line \.\.\./,
    );

    expect(result.truncated).toBe(true);
    expect(result.omittedLines).toBeUndefined();
    expect(result.preview.startsWith("HEAD-")).toBe(true);
    expect(result.preview.endsWith("-TAIL")).toBe(true);
    expect(marker).not.toBeNull();
    expect(utf8Bytes(result.preview)).toBeLessThanOrEqual(MAX_PREVIEW_LINE_BYTES);
    expect(utf8Bytes(result.preview)).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);

    const markerText = marker?.[0] ?? "";
    const reportedOmittedBytes = Number(marker?.[1]);
    const retainedOriginalBytes = utf8Bytes(result.preview) - utf8Bytes(markerText);
    expect(reportedOmittedBytes).toBe(utf8Bytes(line) - retainedOriginalBytes);
  });

  test("bounds an 80 by 64-KiB JSONL shape while retaining whole-output markers", () => {
    const lines = Array.from({ length: 80 }, (_, index) => {
      const lineNumber = index + 1;
      return `{"line":${lineNumber},"head":"HEAD-${lineNumber}","payload":"${"x".repeat(64 * 1024)}","tail":"TAIL-${lineNumber}"}`;
    });
    const result = preview(lines);
    const renderedLines = result.preview.split("\n");
    const retainedLines = renderedLines.filter((line) => line.startsWith('{"line":'));

    expect(result.truncated).toBe(true);
    expect(utf8Bytes(result.preview)).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
    expect(
      renderedLines.every((line) => utf8Bytes(line) <= MAX_PREVIEW_LINE_BYTES),
    ).toBe(true);
    expect(result.preview).toContain("HEAD-1");
    expect(result.preview).toContain("TAIL-1");
    expect(result.preview).toContain("HEAD-80");
    expect(result.preview).toContain("TAIL-80");
    expect(result.preview).toContain(
      `... output omitted to fit the ${MAX_PREVIEW_BYTES}-byte preview limit.`,
    );
    expect(result.omittedLines).toBe(lines.length - retainedLines.length);
    expect(preview(lines)).toEqual(result);
  });

  test("uses a total-byte head and tail window below 200 lines", () => {
    const lines = Array.from(
      { length: 8 },
      (_, index) => `line-${index + 1}-${"x".repeat(6_000)}`,
    );
    const result = preview(lines);

    expect(result.truncated).toBe(true);
    expect(result.omittedLines).toBeGreaterThan(0);
    expect(result.preview).toContain("line-1-");
    expect(result.preview).toContain("line-8-");
    expect(result.preview).toContain("output omitted to fit the 32768-byte preview");
    expect(utf8Bytes(result.preview)).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
  });

  test("does not double-count lines omitted by line and total-byte windows", () => {
    const lines = Array.from(
      { length: 240 },
      (_, index) => `record-${index + 1}-${"x".repeat(256)}`,
    );
    const result = preview(lines);
    const retainedLineNumbers = result.preview
      .split("\n")
      .map((line) => line.match(/^record-(\d+)-/)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);

    expect(result.truncated).toBe(true);
    expect(result.preview).toContain("output omitted to fit the 32768-byte preview");
    expect(new Set(retainedLineNumbers).size).toBe(retainedLineNumbers.length);
    expect(result.omittedLines).toBe(lines.length - retainedLineNumbers.length);
    expect(utf8Bytes(result.preview)).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
  });

  test("takes UTF-8 prefixes and suffixes only at complete code-point boundaries", () => {
    expect(takeUtf8Prefix("甲乙丙", 3)).toBe("甲");
    expect(takeUtf8Prefix("甲乙丙", 5)).toBe("甲");
    expect(takeUtf8Suffix("甲乙丙", 3)).toBe("丙");
    expect(takeUtf8Suffix("甲乙丙", 5)).toBe("丙");
    expect(takeUtf8Prefix("A😀B", 4)).toBe("A");
    expect(takeUtf8Prefix("A😀B", 5)).toBe("A😀");
    expect(takeUtf8Suffix("A😀B", 4)).toBe("B");
    expect(takeUtf8Suffix("A😀B", 5)).toBe("😀B");

    const unicodeLine = `头${"😀".repeat(5_000)}尾`;
    const result = preview([unicodeLine]);
    expect(result.preview.startsWith("头")).toBe(true);
    expect(result.preview.endsWith("尾")).toBe(true);
    expect(result.preview).not.toContain("�");
    expect(hasIsolatedSurrogate(result.preview)).toBe(false);
    expect(utf8Bytes(result.preview)).toBeLessThanOrEqual(MAX_PREVIEW_LINE_BYTES);
  });

  test("preserves existing CRLF, LF, CR, and missing-tail-newline semantics", () => {
    const cases = [
      "alpha\r\nbeta\r\n",
      "alpha\nbeta\n",
      "alpha\rbeta\r",
      "alpha\nbeta",
    ];

    for (const text of cases) {
      const snapshot = buildOutputSnapshotFromText(Buffer.from(text));
      expect(snapshot.outputBytes).toBe(utf8Bytes(text));
      expect(snapshot.outputLines).toBe(2);
      expect(snapshot.preview).toBe("alpha\nbeta");
      expect(snapshot.truncated).toBe(false);
    }
  });

  test("counts omission markers inside both byte limits", () => {
    const exactLine = "x".repeat(MAX_PREVIEW_LINE_BYTES);
    expect(preview([exactLine])).toEqual({
      preview: exactLine,
      truncated: false,
    });

    const overlong = preview([`${exactLine}x`]);
    expect(overlong.truncated).toBe(true);
    expect(utf8Bytes(overlong.preview)).toBeLessThanOrEqual(MAX_PREVIEW_LINE_BYTES);

    const total = preview(Array.from({ length: 4 }, () => exactLine));
    expect(total.truncated).toBe(true);
    expect(total.preview).toContain("output omitted to fit the 32768-byte preview");
    expect(utf8Bytes(total.preview)).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
  });
});

function preview(lines: readonly string[]) {
  return buildBoundedOutputPreview({
    outputLines: lines.length,
    lines,
  });
}

function numberedLines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line-${index + 1}`);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function hasIsolatedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
