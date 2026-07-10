import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runOneShot } from "../cli/run-runner";
import { FakeModelClient } from "../model/fake-model-client";
import type { ModelClient, ModelStepOutput } from "../model/model-client";

class MemoryWriter {
  output = "";

  write(chunk: string): void {
    this.output += chunk;
  }
}

class BackgroundTaskModel implements ModelClient {
  private calls = 0;

  async step(): Promise<ModelStepOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "call_background",
              name: "Bash",
              args: {
                command: "echo $$; sleep 30",
                run_in_background: true,
              },
            },
          ],
        },
      };
    }

    await Bun.sleep(50);
    return { message: { role: "assistant", content: "Background task started." } };
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
      expect(stdout.output).toContain("assistant.progress step=1");
      expect(stdout.output).toContain("I will create notes.txt.");
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
      expect(observations).toContain("## Step 1 - Assistant");
      expect(observations).toContain("I will create notes.txt.");
      expect(observations).toContain("## Step 1 - Write");
      expect(observations).toContain("Write succeeded for notes.txt.");
      expect(observations).toContain("## Final");
      expect(observations).toContain("Created notes.txt");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("stops background tasks before returning", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-run-"));
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    try {
      const code = await runOneShot("Start a background task.", {
        runId: "background-run",
        workspaceRoot: workspace,
        modelName: "fake",
        modelClient: new BackgroundTaskModel(),
        stdout,
        stderr,
      });
      expect(code).toBe(0);
      expect(stderr.output).toBe("");

      const jsonl = await readFile(
        path.join(workspace, ".tinker", "runs", "background-run.jsonl"),
        "utf8",
      );
      const events = jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const finished = events.find((event) => event.type === "bash.task.finished");
      expect(finished).toBeDefined();
      expect((finished?.task as Record<string, unknown> | undefined)?.status).toBe(
        "killed",
      );

      const rawEvent = events.find((event) => event.type === "tool.raw_result");
      const raw = rawEvent?.raw as Record<string, unknown> | undefined;
      const outputFilePath = raw?.outputFilePath;
      expect(outputFilePath).toBeString();
      const pid = Number(
        (await readFile(outputFilePath as string, "utf8")).trim().split("\n")[0],
      );
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
