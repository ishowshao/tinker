import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runOneShot } from "../cli/run-runner";
import { FakeModelClient } from "../model/fake-model-client";
import type {
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
  ModelRequestInput,
} from "../model/model-client";
import type { SessionId } from "../ids/runtime-id";
import {
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";
import {
  estimatePromptSegments,
  INITIAL_CORRECTION_FACTOR,
} from "../model/token-estimator";

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

class ProjectInstructionModel extends TestModelClient {
  readonly prepared: PreparedModelRequest[] = [];
  readonly inputs: ModelRequestInput[] = [];

  prepare(input: ModelRequestInput): PreparedModelRequest {
    const prepared = super.prepare(input);
    this.prepared.push(prepared);
    return prepared;
  }

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push(input);
    return testModelOutput(prepared, {
      role: "assistant",
      content: "done",
    });
  }
}

describe("runOneShot", () => {
  test("loads project instructions before session creation and logs only metadata", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-run-rules-"));
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const model = new ProjectInstructionModel();
    const instructions = "private project rule: use frobnicator\n";
    try {
      await writeFile(path.join(workspace, "AGENTS.md"), instructions);
      const code = await runOneShot("finish", {
        sessionId: "instruction-session" as SessionId,
        workspaceRoot: workspace,
        modelName: "test-model",
        contextProfile: TEST_CONTEXT_PROFILE,
        modelClient: model,
        stdout,
        stderr,
      });

      expect(code).toBe(0);
      expect(stderr.output).toBe("");
      const messages = model.inputs[0]?.messages ?? [];
      expect(messages.filter((message) => message.role === "system")).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: "system" });
      expect(messages[0]?.content).toContain(instructions.trim());

      const eventText = await readFile(
        path.join(
          workspace,
          ".tinker",
          "sessions",
          "instruction-session",
          "events.jsonl",
        ),
        "utf8",
      );
      expect(eventText).not.toContain("use frobnicator");
      const events = eventText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const started = events.find((event) => event.type === "session.started");
      expect(started?.data).toMatchObject({
        projectInstructions: {
          instruction: {
            path: "AGENTS.md",
            byteLength: Buffer.byteLength(instructions),
            sha256: createHash("sha256").update(instructions).digest("hex"),
          },
        },
      });
      const initialUsage = events.find(
        (event) =>
          event.type === "context.usage.updated" &&
          (event.data as { phase?: string }).phase === "initial",
      );
      const initialSnapshot = (
        initialUsage?.data as {
          snapshot?: {
            usedInputTokens?: number;
            rawFullEstimate?: { totalTokens: number };
          };
        }
      ).snapshot;
      const expectedRawTokens = estimatePromptSegments(
        model.prepared[1].promptSegments,
      ).totalTokens;
      expect(initialSnapshot?.rawFullEstimate?.totalTokens).toBe(expectedRawTokens);
      expect(initialSnapshot?.usedInputTokens).toBe(
        Math.ceil(expectedRawTokens * INITIAL_CORRECTION_FACTOR),
      );
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("fails invalid project instructions before creating a session store", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-run-rules-"));
    const stderr = new MemoryWriter();
    const model = new ProjectInstructionModel();
    try {
      await writeFile(path.join(workspace, "AGENTS.md"), " \n");
      const code = await runOneShot("finish", {
        sessionId: "invalid-instruction-session" as SessionId,
        workspaceRoot: workspace,
        modelName: "test-model",
        contextProfile: TEST_CONTEXT_PROFILE,
        modelClient: model,
        stdout: new MemoryWriter(),
        stderr,
      });

      expect(code).toBe(1);
      expect(stderr.output).toContain("AGENTS.md must not be empty");
      expect(model.prepared).toHaveLength(0);
      expect(
        await access(
          path.join(workspace, ".tinker", "sessions", "invalid-instruction-session"),
        ).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

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
      await waitForProcessExit(pid);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await Bun.sleep(10);
  }

  throw new Error(`Process ${pid} is still alive.`);
}

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
