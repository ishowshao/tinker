import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  countSourceLines,
  findSourceLineViolations,
  MAX_SOURCE_LINES,
} from "../../scripts/check-source-lines";

test("source line counts include comments and blank lines without a phantom final line", () => {
  expect(countSourceLines("")).toBe(0);
  expect(countSourceLines("\n")).toBe(1);
  expect(countSourceLines("// comment\n\ncode\n")).toBe(3);
  expect(countSourceLines("// comment\r\n\r\ncode")).toBe(3);
  expect(countSourceLines("first\rsecond\r")).toBe(2);
});

test("source line limit includes nested tests, fixtures and hidden files at the exact boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tinker-source-lines-"));
  try {
    const source = path.join(root, "src");
    await mkdir(path.join(source, "__tests__", "fixtures"), { recursive: true });
    const exact = "// comment\n".repeat(MAX_SOURCE_LINES);
    const over = "\n".repeat(MAX_SOURCE_LINES + 1);
    await Bun.write(path.join(source, "allowed.ts"), exact);
    await Bun.write(path.join(source, "__tests__", "allowed.test.tsx"), exact);
    await Bun.write(path.join(source, "__tests__", "too-long.test.ts"), `${exact}code`);
    await Bun.write(path.join(source, "__tests__", "fixtures", "host.py"), over);
    await Bun.write(path.join(source, ".hidden.ts"), over);
    await Bun.write(path.join(root, "outside.ts"), over);

    expect(await findSourceLineViolations(source)).toEqual(
      [
        { file: "__tests__/fixtures/host.py", lines: MAX_SOURCE_LINES + 1 },
        { file: "__tests__/too-long.test.ts", lines: MAX_SOURCE_LINES + 1 },
        { file: ".hidden.ts", lines: MAX_SOURCE_LINES + 1 },
      ].sort((left, right) => left.file.localeCompare(right.file)),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
