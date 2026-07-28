import { describe, expect, test } from "bun:test";
import {
  createTuiShikiHighlighter,
  getPreparedShikiHighlighter,
  prepareShikiHighlighter,
} from "../tui/shiki-highlighter";

describe("TUI Shiki highlighter", () => {
  test("prepares the configured bundled languages once", async () => {
    const first = prepareShikiHighlighter();
    expect(prepareShikiHighlighter()).toBe(first);
    await first;

    expect(getPreparedShikiHighlighter()).toBeFunction();
  });

  test("creates a synchronous ANSI highlighter after initialization", async () => {
    const highlighter = await createTuiShikiHighlighter(async () => ({
      codeToTokensBase: () => [
        [{ content: "const", color: "#ff0000" }, { content: " value" }],
      ],
    }));

    expect(highlighter).toBeDefined();
    expect(highlighter?.("const value", "typescript")).toBe(
      "\u001b[38;2;255;0;0mconst\u001b[39m value",
    );
    expect(highlighter?.("plain", undefined)).toBe("plain");
  });

  test("settles to unavailable when initialization fails", async () => {
    const highlighter = await createTuiShikiHighlighter(async () => {
      throw new Error("shiki unavailable");
    });

    expect(highlighter).toBeUndefined();
  });

  test("falls back to source text when tokenization rejects a language", async () => {
    const highlighter = await createTuiShikiHighlighter(async () => ({
      codeToTokensBase: () => {
        throw new Error("unknown language");
      },
    }));

    expect(highlighter?.("source", "unknown")).toBe("source");
  });
});
