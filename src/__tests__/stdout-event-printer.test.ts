import { describe, expect, test } from "bun:test";
import { StdoutEventPrinter } from "../events/stdout-event-printer";

describe("stdout event printer", () => {
  test("shows the pattern for Grep tool events", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const printer = new StdoutEventPrinter(
      { write: (chunk: string) => stdout.push(chunk) },
      { write: (chunk: string) => stderr.push(chunk) },
    );

    await printer.append({
      type: "tool.started",
      step: 1,
      call: { id: "call_1", name: "Grep", args: { pattern: "foo" } },
    });
    await printer.append({
      type: "tool.finished",
      step: 1,
      call: { id: "call_1", name: "Grep", args: { pattern: "foo" } },
      ok: true,
    });

    expect(stdout).toEqual([
      "tool.started name=Grep pattern=foo\n",
      "tool.finished name=Grep pattern=foo ok=true\n",
    ]);
    expect(stderr).toEqual([]);
  });

  test("prints a unified diff for Edit raw results with a patch", async () => {
    const stdout: string[] = [];
    const printer = new StdoutEventPrinter(
      { write: (chunk: string) => stdout.push(chunk) },
      { write: () => undefined },
    );

    await printer.append({
      type: "tool.raw_result",
      step: 1,
      call: { id: "call_1", name: "Edit", args: { file_path: "notes.txt" } },
      raw: {
        ok: true,
        filePath: "notes.txt",
        patch: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 3,
            lines: [" alpha", "-beta", "+delta", " gamma"],
          },
        ],
        patchTruncated: false,
      },
    });

    expect(stdout).toEqual([
      [
        "tool.diff name=Edit path=notes.txt +1 -1",
        "@@ -1,3 +1,3 @@",
        " alpha",
        "-beta",
        "+delta",
        " gamma",
      ].join("\n") + "\n",
    ]);
  });

  test("ignores raw results without a patch", async () => {
    const stdout: string[] = [];
    const printer = new StdoutEventPrinter(
      { write: (chunk: string) => stdout.push(chunk) },
      { write: () => undefined },
    );

    await printer.append({
      type: "tool.raw_result",
      step: 1,
      call: { id: "call_1", name: "Read", args: { file_path: "notes.txt" } },
      raw: { ok: true, filePath: "notes.txt", content: "alpha" },
    });
    await printer.append({
      type: "tool.raw_result",
      step: 1,
      call: { id: "call_2", name: "Edit", args: { file_path: "notes.txt" } },
      raw: { ok: false, filePath: "notes.txt", error: "old_string was not found." },
    });

    expect(stdout).toEqual([]);
  });
});
