import { describe, expect, test } from "bun:test";
import { parseGrepOutput } from "../tools/grep-output";

function parseLines(
  text: string | Buffer,
  matches: { start: number; end: number }[] = [],
  type = "match",
) {
  const records = parseGrepOutput(
    JSON.stringify({
      type,
      data: {
        path: { text: "/workspace/a.txt" },
        lines: typeof text === "string" ? { text } : { bytes: text.toString("base64") },
        line_number: 7,
        submatches: matches,
      },
    }) + "\n",
    "content",
    "/workspace",
    false,
  );
  const record = records[0];
  if (record.kind !== "match" && record.kind !== "context")
    throw new Error("Expected content");
  expect(record.lineNumber).toBe(7);
  return record.lines;
}

function matchAt(prefix: string, match: string) {
  const start = Buffer.byteLength(prefix);
  return { start, end: start + Buffer.byteLength(match) };
}

describe("Grep long-line excerpts", () => {
  test("uses a strict 500 code-point threshold and preserves CRLF line boundaries", () => {
    const text = "界😀".repeat(250);
    expect(parseLines(text + "\r\n")).toEqual([text]);
    expect(parseLines(text + "!\r\n")).toEqual([
      text + "[... 1 code points omitted ...]",
    ]);
  });

  test.each([
    0, 700, 1400,
  ])("retains matches at offset %i, including line ends", (start) => {
    const prefix = "x".repeat(start);
    const suffix = "y".repeat(1400 - start);
    const [line] = parseLines(prefix + "NEEDLE_END" + suffix + "\n", [
      matchAt(prefix, "NEEDLE_END"),
    ]);
    expect(line).toContain(
      "x".repeat(Math.min(start, 100)) +
        "NEEDLE_END" +
        "y".repeat(Math.min(suffix.length, 100)),
    );
    expect(line).toContain("code points omitted");
    expect(line).not.toContain("Omitted long");
  });

  test("uses byte offsets correctly with Unicode and base64 invalid UTF-8 prefixes", () => {
    const prefix = Buffer.concat([
      Buffer.from([0xff]),
      Buffer.from("界😀".repeat(350)),
    ]);
    const bytes = Buffer.concat([prefix, Buffer.from("NEEDLE_END\n")]);
    expect(
      parseLines(bytes, [{ start: prefix.length, end: prefix.length + 10 }]),
    ).toEqual(["[... 601 code points omitted ...]" + "界😀".repeat(50) + "NEEDLE_END"]);
  });

  test("merges nearby windows and keeps distant matches within the per-line budget", () => {
    const text =
      "x".repeat(600) +
      "FIRST" +
      "y".repeat(10) +
      "SECOND" +
      "z".repeat(800) +
      "THIRD" +
      "q".repeat(600);
    const matches = ["FIRST", "SECOND", "THIRD"].map((word) =>
      matchAt(text.slice(0, text.indexOf(word)), word),
    );
    const [line] = parseLines(text, matches);
    expect(line).toContain("FIRST" + "y".repeat(10) + "SECOND");
    expect(line).toContain("THIRD");
    expect(line.match(/code points omitted/g)).toHaveLength(3);
  });

  test("bounds output for huge matches and numerous separate matches", () => {
    const [huge] = parseLines("a".repeat(5000), [{ start: 0, end: 5000 }]);
    expect(huge).toBe("a".repeat(500) + "[... 4500 code points omitted ...]");
    const text = ("x".repeat(600) + "HIT").repeat(20);
    const matches = Array.from(text.matchAll(/HIT/g), (match) => ({
      start: match.index,
      end: match.index + 3,
    }));
    const [line] = parseLines(text, matches);
    expect(line).toContain("HIT");
    expect(
      [...line.replace(/\[\.\.\. \d+ code points omitted \.\.\.\]/g, "")].length,
    ).toBeLessThanOrEqual(500);
    expect(line.length).toBeLessThan(700);
  });

  test("locates cross-line matches and zero-width end matches without changing line counts", () => {
    const prefix = "界".repeat(600);
    const text = prefix + "START\r\nEND" + "😀".repeat(600) + "\n";
    const lines = parseLines(text, [matchAt(prefix, "START\r\nEND")]);
    expect(lines).toEqual([
      "[... 500 code points omitted ...]" + "界".repeat(100) + "START",
      "END" + "😀".repeat(100) + "[... 500 code points omitted ...]",
    ]);
    expect(parseLines(prefix, [{ start: 1800, end: 1800 }])).toEqual([
      "[... 500 code points omitted ...]" + "界".repeat(100),
    ]);
  });

  test("retains context prefixes and rejects invalid submatch offsets", () => {
    expect(parseLines("prefix" + "x".repeat(600), [], "context")).toEqual([
      "prefix" + "x".repeat(494) + "[... 106 code points omitted ...]",
    ]);
    for (const range of [
      { start: -1, end: 1 },
      { start: 2, end: 1 },
      { start: 0, end: 4 },
    ]) {
      expect(() => parseLines("abc", [range])).toThrow("submatch offsets");
    }
  });
});
