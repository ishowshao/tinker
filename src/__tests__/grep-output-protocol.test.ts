import { describe, expect, test } from "bun:test";
import { parseGrepOutput } from "../tools/grep-output";
import { formatGrepPath } from "../tools/grep-path";
import { buildRipgrepArgs } from "../tools/grep";
import type { GrepOutputMode } from "../tools/types";

const root = "/workspace";
function event(overrides: Record<string, unknown> = {}) {
  return (
    JSON.stringify({
      type: "match",
      data: {
        path: { text: `${root}/fake:999\nreal.txt` },
        lines: { text: "match\n" },
        line_number: 1,
        ...overrides,
      },
    }) + "\n"
  );
}

describe("Grep output protocols", () => {
  test.each([
    "content",
    "files_with_matches",
    "count",
    "count-matches",
  ] as GrepOutputMode[])("%s fixes ordering and disables external output configuration", (mode) => {
    const args = buildRipgrepArgs({ pattern: "match" }, mode, root);
    expect(args).toContain("--no-config");
    expect(args.slice(args.indexOf("--sort"), args.indexOf("--sort") + 2)).toEqual([
      "--sort",
      "path",
    ]);
    expect(args).toContain(mode === "content" ? "--json" : "--null");
  });

  test("NUL-delimited paths preserve control characters and digits", () => {
    const path = `${root}/fake:999\nreal.txt`;
    expect(parseGrepOutput(`${path}\0`, "files_with_matches", root, false)).toEqual([
      { kind: "file", filePath: "fake:999\nreal.txt" },
    ]);
    expect(parseGrepOutput(`${path}\0${1}\n`, "count", root, false)).toEqual([
      { kind: "count", filePath: "fake:999\nreal.txt", count: 1 },
    ]);
  });

  test("only complete records survive truncation, even when a path contains newlines", () => {
    const prefix = `${root}/a.txt`;
    expect(
      parseGrepOutput(
        `${prefix}\0${root}/fake:999\nreal`,
        "files_with_matches",
        root,
        true,
      ),
    ).toEqual([{ kind: "file", filePath: "a.txt" }]);
    expect(
      parseGrepOutput(
        `${prefix}\0${2}\n${root}/fake:999\nreal.txt\0${999}`,
        "count-matches",
        root,
        true,
      ),
    ).toEqual([{ kind: "count", filePath: "a.txt", count: 2 }]);
    expect(
      parseGrepOutput(event() + '{"type":"match"', "content", root, true),
    ).toHaveLength(1);
    expect(parseGrepOutput("incomplete", "files_with_matches", root, true)).toEqual([]);
  });

  test("malformed complete records fail instead of silently becoming zero counts", () => {
    for (const value of ["abc", "-1", "1.5", "", "9007199254740992"]) {
      expect(() =>
        parseGrepOutput(`${root}/a\0${value}\n`, "count", root, false),
      ).toThrow("Invalid count");
    }
    expect(() => parseGrepOutput(`${root}/a:2\n`, "count", root, false)).toThrow("NUL");
    expect(() => parseGrepOutput(`${root}/a\0${1}`, "count", root, false)).toThrow(
      "Unterminated",
    );
    expect(() => parseGrepOutput("invalid json\n", "content", root, true)).toThrow();
    expect(() =>
      parseGrepOutput(event({ line_number: 0 }), "content", root, false),
    ).toThrow("line number");
    expect(() => parseGrepOutput(event({ path: {} }), "content", root, false)).toThrow(
      "encoding",
    );
  });

  test("JSON event decoding supports base64 text and preserves multiline boundaries", () => {
    const records = parseGrepOutput(
      event({
        path: { bytes: Buffer.from(`${root}/a.txt`).toString("base64") },
        lines: { bytes: Buffer.from("one\r\ntwo\n").toString("base64") },
        line_number: 8,
      }),
      "content",
      root,
      false,
    );
    expect(records).toEqual([
      { kind: "match", filePath: "a.txt", lineNumber: 8, lines: ["one", "two"] },
    ]);
    expect(
      parseGrepOutput(
        event({ lines: { text: "x".repeat(501) + "\n" } }),
        "content",
        root,
        false,
      )[0],
    ).toMatchObject({ lines: ["[Omitted long matching line]"] });
  });

  test("escaped path display round-trips and never contains literal control characters", () => {
    for (const filePath of [
      "line\nbreak.txt",
      "tab\tcr\r.txt",
      'quote".txt',
      "literal\\n.txt",
      "escape\x1b.txt",
      "delete\x7f.txt",
      "bidi\u202e.txt",
      "tag\u{e0001}.txt",
    ]) {
      const display = formatGrepPath(filePath);
      expect(JSON.parse(display)).toBe(filePath);
      expect(display).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    }
    expect(formatGrepPath("normal.txt")).toBe("normal.txt");
  });
});
