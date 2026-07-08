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
});
