import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runOneShot } from "../cli/run-runner";
import { FakeModelClient } from "../model/fake-model-client";
import type {
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import type { SessionId } from "../ids/runtime-id";
import {
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
} from "./test-runtime";

class MemoryWriter {
  output = "";

  write(chunk: string): void {
    this.output += chunk;
  }
}

class BackgroundTaskModel extends TestModelClient {
  private calls = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      if (options.identity === undefined) {
        throw new Error("Expected model request identity.");
      }
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...options.identity.runtimeSession.createToolCall(
              options.identity.iteration,
              1,
            ),
            providerToolCallId: "call_background",
            name: "Bash",
            args: {
              command: "echo $$; sleep 30",
              run_in_background: true,
            },
          },
        ],
      });
    }

    await Bun.sleep(50);
    return testModelOutput(prepared, {
      role: "assistant",
      content: "Background task started.",
    });
  }
}

describe("runOneShot", () => {
  test("runs without Ink and writes JSONL events", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-run-"));
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    try {
      const code = await runOneShot("Create notes.txt with one line: hello.", {
        sessionId: "test-session" as SessionId,
        workspaceRoot: workspace,
        modelName: "fake",
        contextProfile: TEST_CONTEXT_PROFILE,
        modelClient: new FakeModelClient("write-notes", {
          model: "fake",
          contextBudget: TEST_CONTEXT_BUDGET,
        }),
        stdout,
        stderr,
      });

      expect(code).toBe(0);
      expect(stderr.output).toBe("");
      expect(stdout.output).toContain("session.started sessionId=test-session");
      expect(stdout.output).toContain("assistant.progress iteration=1");
      expect(stdout.output).toContain("I will create notes.txt.");
      expect(stdout.output).toContain("tool.started name=Write path=notes.txt");
      expect(stdout.output).toContain("turn.finished status=completed");
      expect(stdout.output).toContain("Created notes.txt");
      expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe(
        "hello.\n",
      );

      const jsonl = await readFile(
        path.join(workspace, ".tinker", "sessions", "test-session", "events.jsonl"),
        "utf8",
      );
      expect(jsonl).toContain('"type":"session.started"');
      expect(jsonl).toContain('"type":"tool.observation"');
      expect(jsonl).toContain('"type":"turn.finished"');
      const events = jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const turnFinished = events.find((event) => event.type === "turn.finished");
      const turnFinishedData = turnFinished?.data as
        | Record<string, unknown>
        | undefined;
      expect(turnFinishedData).toMatchObject({
        status: "completed",
        finalText: "Created notes.txt with one line: hello.",
        messageCount: 5,
        lastIteration: { iterationNumber: 2 },
      });
      expect(turnFinishedData).not.toHaveProperty("result");
      expect(JSON.stringify(turnFinished)).not.toContain('"messages"');

      const sessionDirectory = path.join(
        workspace,
        ".tinker",
        "sessions",
        "test-session",
      );
      expect((await stat(sessionDirectory)).mode & 0o777).toBe(0o700);
      expect(
        (await stat(path.join(sessionDirectory, "session.sqlite"))).mode & 0o777,
      ).toBe(0o600);
      expect(
        (await stat(path.join(sessionDirectory, "events.jsonl"))).mode & 0o777,
      ).toBe(0o600);

      const observations = await readFile(
        path.join(workspace, ".tinker", "sessions", "test-session", "observations.md"),
        "utf8",
      );
      expect(observations).toContain("# Tinker Session test-session");
      expect(observations).toContain("- Prompt");
      expect(observations).toContain("Create notes.txt with one line: hello.");
      expect(observations).toContain("- Assistant");
      expect(observations).toContain("I will create notes.txt.");
      expect(observations).toContain("- Write");
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
        sessionId: "background-session" as SessionId,
        workspaceRoot: workspace,
        modelName: "fake",
        contextProfile: TEST_CONTEXT_PROFILE,
        modelClient: new BackgroundTaskModel(),
        stdout,
        stderr,
      });
      expect(code).toBe(0);
      expect(stderr.output).toBe("");

      const jsonl = await readFile(
        path.join(
          workspace,
          ".tinker",
          "sessions",
          "background-session",
          "events.jsonl",
        ),
        "utf8",
      );
      const events = jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const finished = events.find((event) => event.type === "bash.task.finished");
      expect(finished).toBeDefined();
      const finishedData = finished?.data as Record<string, unknown> | undefined;
      expect((finishedData?.task as Record<string, unknown> | undefined)?.status).toBe(
        "killed",
      );

      const rawEvent = events.find((event) => event.type === "tool.raw_result");
      const rawEventData = rawEvent?.data as Record<string, unknown> | undefined;
      const raw = rawEventData?.raw as Record<string, unknown> | undefined;
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
