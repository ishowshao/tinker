import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { FileViewer, parseMouseWheelInput } from "../tui/components/file-viewer";
import type { ViewFile } from "../tui/view-file";

const ARROW_RIGHT = "\u001b[C";
const ESCAPE = "\u001b";
const MOUSE_WHEEL_UP = "\u001b[<64;10;5M";
const MOUSE_WHEEL_DOWN = "\u001b[<65;10;5M";

describe("file viewer", () => {
  test("renders a bounded viewport and scrolls with keys and the mouse wheel", async () => {
    let closeCount = 0;
    const file = viewFile(
      Array.from({ length: 10 }, (_, index) => `line-${index + 1}`),
    );
    const { stdin, lastFrame, cleanup } = render(
      <FileViewer
        file={file}
        viewportRows={7}
        viewportColumns={50}
        onClose={() => {
          closeCount += 1;
        }}
      />,
    );

    expect(lastFrame()).toContain("1 │ line-1");
    expect(lastFrame()).toContain("4 │ line-4");
    expect(lastFrame()).not.toContain("5 │ line-5");
    expect(lastFrame()).toContain("1–4 / 10 · 40%");

    await press(stdin, "j");
    expect(lastFrame()).not.toContain("1 │ line-1");
    expect(lastFrame()).toContain("5 │ line-5");

    await press(stdin, MOUSE_WHEEL_DOWN);
    expect(lastFrame()).toContain("5 │ line-5");
    expect(lastFrame()).toContain("8 │ line-8");

    await press(stdin, MOUSE_WHEEL_UP);
    expect(lastFrame()).toContain("2 │ line-2");

    await press(stdin, ESCAPE);
    expect(closeCount).toBe(1);
    cleanup();
  });

  test("scrolls long lines horizontally by terminal columns", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <FileViewer
        file={viewFile(["0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"])}
        viewportRows={5}
        viewportColumns={40}
        onClose={() => undefined}
      />,
    );

    expect(lastFrame()).toContain("1–1 / 1 · 100%");
    await press(stdin, ARROW_RIGHT);
    expect(lastFrame()).toContain("column 9");
    expect(lastFrame()).toContain("89abcdefghijklmnopqrstuvwxyzAB");
    cleanup();
  });

  test("renders an empty readable file", () => {
    const { lastFrame, cleanup } = render(
      <FileViewer
        file={viewFile([])}
        viewportRows={5}
        viewportColumns={40}
        onClose={() => undefined}
      />,
    );

    expect(lastFrame()).toContain("(empty file)");
    expect(lastFrame()).toContain("0 lines · 0 bytes");
    cleanup();
  });

  test("recognizes SGR wheel events and ignores other mouse buttons", () => {
    expect(parseMouseWheelInput(MOUSE_WHEEL_UP)).toBe(-1);
    expect(parseMouseWheelInput(MOUSE_WHEEL_DOWN)).toBe(1);
    expect(parseMouseWheelInput("[<0;10;5M")).toBe(0);
    expect(parseMouseWheelInput("x")).toBe(0);
  });
});

function viewFile(lines: readonly string[]): ViewFile {
  return {
    absolutePath: "/tmp/example.ts",
    displayPath: "example.ts",
    lines,
    sizeBytes: lines.join("\n").length,
  };
}

async function press(stdin: { write: (data: string) => void }, input: string) {
  stdin.write(input);
  await Bun.sleep(25);
}
