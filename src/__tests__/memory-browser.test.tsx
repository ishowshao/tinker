import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { StoredMemorySummary } from "../memory/contracts";
import {
  formatMemoryCreatedAt,
  MemoryBrowser,
  normalizeMemoryDisplayText,
} from "../tui/components/memory-browser";

const ESCAPE = "\u001b";
const END = "\u001b[F";

describe("memory browser", () => {
  test("renders an empty snapshot", () => {
    const { lastFrame, cleanup } = render(
      <MemoryBrowser
        memories={[]}
        viewportRows={7}
        viewportColumns={50}
        onClose={() => undefined}
      />,
    );

    expect(lastFrame()).toContain("Global memory");
    expect(lastFrame()).toContain("No stored memories.");
    expect(lastFrame()).toContain("0 memories");
    cleanup();
  });

  test("projects unsafe text without changing the stored memory", async () => {
    const original = "first\tpart\r\n\rsecond\u0000\u007f\u0085";
    const memory = storedMemory({ text: original });
    const { lastFrame, cleanup } = render(
      <MemoryBrowser
        memories={[memory]}
        viewportRows={10}
        viewportColumns={70}
        onClose={() => undefined}
      />,
    );
    await Bun.sleep(25);

    const frame = lastFrame() ?? "";
    expect(frame).toContain(formatMemoryCreatedAt(memory.createdAt));
    expect(frame).toContain(memory.sourceWorkspace);
    expect(frame).toContain("first    part");
    expect(frame).toContain("second���");
    expect(frame).not.toContain("\u0000");
    expect(memory.text).toBe(original);
    expect(normalizeMemoryDisplayText("a\rb\tc\u001b")).toBe("a\nb    c�");
    cleanup();
  });

  test("scrolls Ink-wrapped physical lines and clamps after resize", async () => {
    let closeCount = 0;
    const first = storedMemory({
      memoryId: "memory-1",
      text: Array.from({ length: 16 }, (_, index) => `wrapped-${index + 1}`).join(" "),
    });
    const second = storedMemory({
      memoryId: "memory-2",
      text: "FINAL_MEMORY_TEXT",
      sourceWorkspace: "/workspace/second",
    });
    const renderBrowser = (viewportRows: number, viewportColumns: number) => (
      <MemoryBrowser
        memories={[first, second]}
        viewportRows={viewportRows}
        viewportColumns={viewportColumns}
        onClose={() => {
          closeCount += 1;
        }}
      />
    );
    const { stdin, lastFrame, rerender, cleanup } = render(renderBrowser(7, 28));
    await Bun.sleep(25);

    expect(lastFrame()).toContain("1–4 /");
    expect(lastFrame()).not.toContain("FINAL_MEMORY_TEXT");
    await press(stdin, "j");
    expect(lastFrame()).toContain("2–5 /");
    await press(stdin, "j");
    expect(lastFrame()).not.toContain("wrapped-1 ");
    await press(stdin, END);
    expect(lastFrame()).toContain("FINAL_MEMORY_TEXT");

    rerender(renderBrowser(9, 40));
    await Bun.sleep(25);
    expect(lastFrame()).toContain("FINAL_MEMORY_TEXT");

    await press(stdin, ESCAPE);
    expect(closeCount).toBe(1);
    cleanup();
  });
});

function storedMemory(
  overrides: Partial<StoredMemorySummary> = {},
): StoredMemorySummary {
  return {
    memoryId: "memory-1",
    text: "Stored memory text.",
    sourceWorkspace: "/workspace/example",
    createdAt: "2026-07-26T06:32:00.000Z",
    ...overrides,
  };
}

async function press(stdin: { write: (data: string) => void }, input: string) {
  stdin.write(input);
  await Bun.sleep(25);
}
