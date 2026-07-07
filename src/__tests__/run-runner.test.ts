import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runOneShot } from "../cli/run-runner";
import { FakeModelClient } from "../model/fake-model-client";

class MemoryWriter {
  output = "";

  write(chunk: string): void {
    this.output += chunk;
  }
}

describe("runOneShot", () => {
  test("runs without Ink and writes JSONL events", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-run-"));
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    try {
      const code = await runOneShot("Create notes.txt with one line: hello.", {
        runId: "test-run",
        workspaceRoot: workspace,
        modelName: "fake",
        modelClient: new FakeModelClient("write-notes"),
        stdout,
        stderr,
      });

      expect(code).toBe(0);
      expect(stderr.output).toBe("");
      expect(stdout.output).toContain("run.started runId=test-run");
      expect(stdout.output).toContain("tool.started name=Write path=notes.txt");
      expect(stdout.output).toContain("run.finished ok=true");
      expect(stdout.output).toContain("Created notes.txt");
      expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe(
        "hello.\n",
      );

      const jsonl = await readFile(
        path.join(workspace, ".tinker", "runs", "test-run.jsonl"),
        "utf8",
      );
      expect(jsonl).toContain('"type":"run.started"');
      expect(jsonl).toContain('"type":"tool.observation"');
      expect(jsonl).toContain('"type":"run.finished"');

      const observations = await readFile(
        path.join(workspace, ".tinker", "runs", "test-run.observations.md"),
        "utf8",
      );
      expect(observations).toContain("# Tinker Run test-run");
      expect(observations).toContain("## Prompt");
      expect(observations).toContain("Create notes.txt with one line: hello.");
      expect(observations).toContain("## Step 1 - Write");
      expect(observations).toContain("Write succeeded for notes.txt.");
      expect(observations).toContain("## Final");
      expect(observations).toContain("Created notes.txt");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
