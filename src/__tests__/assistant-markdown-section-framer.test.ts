import { describe, expect, test } from "bun:test";
import { MarkdownSectionFramer } from "../tui/assistant-markdown-section-framer";

describe("MarkdownSectionFramer", () => {
  test("waits for a complete heading line and preserves raw source offsets", () => {
    const framer = new MarkdownSectionFramer();

    expect(framer.push("## 第一节\n😀 正文\r\n\r\n## 第")).toEqual([]);
    const frames = framer.push("二节\r\n后续");

    const first = "## 第一节\n😀 正文\r\n\r\n";
    expect(frames).toEqual([{ markdown: first, start: 0, end: first.length }]);
    expect(framer.finish()).toEqual({
      content: `${first}## 第二节\r\n后续`,
      tail: "## 第二节\r\n后续",
      sealedEnd: first.length,
      framingStopped: false,
    });
  });

  test("emits a non-empty preamble and multiple consecutive sections in order", () => {
    const framer = new MarkdownSectionFramer();
    const frames = framer.push("导语\n\n# A\n## B\n### C\n");

    expect(frames.map((frame) => frame.markdown)).toEqual([
      "导语\n\n",
      "# A\n",
      "## B\n",
    ]);
    expect(framer.finish().tail).toBe("### C\n");
  });

  test("accepts only root ATX headings as boundaries", () => {
    const framer = new MarkdownSectionFramer();
    const source = [
      "## Root one",
      "```md",
      "## fenced",
      "```",
      "> ## quoted",
      "- item",
      "  ## listed",
      "<div>",
      "## raw html",
      "</div>",
      "",
      "## Root two",
      "tail",
    ].join("\n");

    const frames = framer.push(`${source}\n`);

    expect(frames).toHaveLength(1);
    expect(frames[0]?.markdown).toContain("## fenced");
    expect(frames[0]?.markdown).toContain("## quoted");
    expect(frames[0]?.markdown).toContain("## listed");
    expect(frames[0]?.markdown).toContain("## raw html");
    expect(framer.finish().tail).toBe("## Root two\ntail\n");
  });

  test("does not frame paragraphs, blank lines, Setext headings, or thematic breaks", () => {
    const framer = new MarkdownSectionFramer();
    const source = "paragraph\n\nSetext\n===\n\n---\n\nmore\n";

    expect(framer.push(source)).toEqual([]);
    expect(framer.finish().tail).toBe(source);
  });

  test("stops early framing for reference-style syntax but permits inline links", () => {
    const reference = new MarkdownSectionFramer();
    expect(reference.push("## A\nSee [documentation][ref].\n\n## B\n")).toEqual([]);
    expect(reference.finish()).toMatchObject({
      tail: "## A\nSee [documentation][ref].\n\n## B\n",
      framingStopped: true,
    });

    const shortcut = new MarkdownSectionFramer();
    expect(shortcut.push("## A\nSee [documentation].\n\n## B\n")).toEqual([]);
    expect(shortcut.finish().framingStopped).toBe(true);

    const inline = new MarkdownSectionFramer();
    expect(
      inline
        .push("## A\nSee [documentation](https://example.com).\n\n## B\n")
        .map((frame) => frame.markdown),
    ).toEqual(["## A\nSee [documentation](https://example.com).\n\n"]);
    expect(inline.finish().framingStopped).toBe(false);
  });

  test("keeps an already sealed prefix while conservatively buffering a dependent tail", () => {
    const framer = new MarkdownSectionFramer();
    expect(
      framer.push("## Safe\nbody\n\n## Deferred\n").map((frame) => frame.markdown),
    ).toEqual(["## Safe\nbody\n\n"]);
    expect(
      framer.push("See [later].\n\n## Still buffered\n").map((frame) => frame.markdown),
    ).toEqual([]);

    expect(framer.finish()).toMatchObject({
      tail: "## Deferred\nSee [later].\n\n## Still buffered\n",
      framingStopped: true,
    });
  });

  test("does not emit a heading-only response and reset isolates attempts", () => {
    const framer = new MarkdownSectionFramer();
    expect(framer.push("## Only\nbody")).toEqual([]);
    expect(framer.finish().tail).toBe("## Only\nbody");

    framer.reset();
    expect(framer.push("no headings")).toEqual([]);
    expect(framer.finish()).toEqual({
      content: "no headings",
      tail: "no headings",
      sealedEnd: 0,
      framingStopped: false,
    });
  });
});
