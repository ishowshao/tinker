import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCall } from "../agent/types";
import { createTestRuntime, type TestToolCallInput } from "./test-runtime";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling as createDefaultToolingBase } from "../tools/registry";
import type { ToolExecutionContext, ToolRawResult } from "../tools/types";

const testToolContext: ToolExecutionContext = {
  signal: new AbortController().signal,
};

function createDefaultTooling(
  options: Omit<Parameters<typeof createDefaultToolingBase>[0], "runtimeSession">,
) {
  const testRuntime = createTestRuntime();
  const tooling = createDefaultToolingBase({
    ...options,
    runtimeSession: testRuntime.runtimeSession,
  });
  return {
    ...tooling,
    runtime: {
      execute: (
        call: TestToolCallInput | ToolCall,
        context: ToolExecutionContext = testToolContext,
      ) =>
        tooling.runtime.execute(
          "sessionId" in call ? call : testRuntime.toolCall(call),
          context,
        ),
    },
    testRuntime,
  };
}

describe("Bash tool", () => {
  test("publishes the expected tool schema and rejects invalid arguments", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bash-"));

    try {
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
      });
      const definition = tooling.registry
        .definitions()
        .find((tool) => tool.name === "Bash");

      expect(definition).toBeDefined();
      expect(definition?.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["command"],
      });

      const missingCommand = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Bash",
        args: {},
      });
      expect(missingCommand.ok).toBe(false);
      expect("error" in missingCommand ? missingCommand.error : "").toContain(
        "Bash.command",
      );

      const invalidTimeout = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Bash",
        args: { command: "echo nope", timeout: 0 },
      });
      expect(invalidTimeout.ok).toBe(false);
      expect("error" in invalidTimeout ? invalidTimeout.error : "").toContain(
        "Bash.timeout",
      );
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("runs a foreground command and writes output to a log file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bash-"));

    try {
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
      });
      const call = tooling.testRuntime.toolCall({
        providerToolCallId: "call_1",
        name: "Bash",
        args: { command: "echo hello", description: "print hello" },
      });
      const raw = asBashRawResult(await tooling.runtime.execute(call));

      expect(raw.ok).toBe(true);
      expect(raw.sessionId).toBe(tooling.testRuntime.runtimeSession.sessionId);
      expect(raw.status).toBe("completed");
      expect(raw.exitCode).toBe(0);
      expect(raw.preview).toBe("hello");
      expect(raw.outputLines).toBe(1);
      expect(raw.outputFilePath).toContain(path.join(".tinker", "bash"));
      expect(await readFile(raw.outputFilePath, "utf8")).toBe("hello\n");

      const observation = new ObservationBuilder().build({ call, raw });
      expect(observation.content).toContain("Bash completed.");
      expect(observation.content).toContain("outputFilePath=");
      expect(observation.content).toContain("preview:\nhello");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("interprets informational exit codes as successful results", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bash-"));

    try {
      await writeFile(path.join(workspace, "notes.txt"), "alpha\n", "utf8");
      await writeFile(path.join(workspace, "left.txt"), "left\n", "utf8");
      await writeFile(path.join(workspace, "right.txt"), "right\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const grepRaw = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_1",
          name: "Bash",
          args: { command: "grep missing notes.txt" },
        }),
      );
      expect(grepRaw.ok).toBe(true);
      expect(grepRaw.status).toBe("completed");
      expect(grepRaw.exitCode).toBe(1);
      expect(grepRaw.returnCodeInterpretation).toBe("No matches found.");

      const diffRaw = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_2",
          name: "Bash",
          args: { command: "diff left.txt right.txt" },
        }),
      );
      expect(diffRaw.ok).toBe(true);
      expect(diffRaw.status).toBe("completed");
      expect(diffRaw.exitCode).toBe(1);
      expect(diffRaw.returnCodeInterpretation).toBe("Files differ.");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("returns failed for ordinary non-zero commands", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bash-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_1",
          name: "Bash",
          args: { command: "false" },
        }),
      );

      expect(raw.ok).toBe(false);
      expect(raw.status).toBe("failed");
      expect(raw.exitCode).toBe(1);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("runs commands in the background and keeps writing output", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bash-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_1",
          name: "Bash",
          args: {
            command: "sleep 0.05; echo background-done",
            run_in_background: true,
            description: "write background output",
          },
        }),
      );

      expect(raw.ok).toBe(true);
      expect(raw.status).toBe("running");
      expect(raw.backgrounded).toBe(true);
      await waitForFileContent(raw.outputFilePath, "background-done");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("backgrounds foreground commands that exceed timeout", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bash-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_1",
          name: "Bash",
          args: { command: "sleep 0.05; echo timeout-done", timeout: 1 },
        }),
      );

      expect(raw.ok).toBe(true);
      expect(raw.status).toBe("running");
      expect(raw.timedOut).toBe(true);
      expect(raw.backgroundedDueToTimeout).toBe(true);
      expect(raw.timeoutMs).toBe(1);
      await waitForFileContent(raw.outputFilePath, "timeout-done");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("persists cwd for foreground commands only", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bash-"));

    try {
      await mkdir(path.join(workspace, "subdir"));
      const realWorkspace = await realpath(workspace);
      const realSubdir = await realpath(path.join(workspace, "subdir"));
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const cdRaw = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_1",
          name: "Bash",
          args: { command: "cd subdir" },
        }),
      );
      expect(cdRaw.ok).toBe(true);
      expect(tooling.bashState.cwd).toBe(realSubdir);

      const pwdRaw = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_2",
          name: "Bash",
          args: { command: "pwd" },
        }),
      );
      expect(pwdRaw.preview).toBe(realSubdir);

      const backgroundRaw = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_3",
          name: "Bash",
          args: {
            command: "cd ..; sleep 0.05; pwd",
            run_in_background: true,
          },
        }),
      );
      await waitForFileContent(backgroundRaw.outputFilePath, realWorkspace);
      expect(tooling.bashState.cwd).toBe(realSubdir);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("previews large output with first and last lines only", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bash-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_1",
          name: "Bash",
          args: { command: "for i in $(seq 1 205); do echo line-$i; done" },
        }),
      );

      expect(raw.ok).toBe(true);
      expect(raw.truncated).toBe(true);
      expect(raw.outputLines).toBe(205);
      expect(raw.omittedLines).toBe(5);
      expect(raw.preview).toContain("line-1");
      expect(raw.preview).toContain("line-100");
      expect(raw.preview).toContain("5 lines omitted");
      expect(raw.preview).toContain("line-106");
      expect(raw.preview).toContain("line-205");
      expect(raw.preview).not.toContain("line-105\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

function asBashRawResult(raw: ToolRawResult): Extract<ToolRawResult, { kind: "bash" }> {
  expect(raw.kind).toBe("bash");
  return raw as Extract<ToolRawResult, { kind: "bash" }>;
}

async function waitForFileContent(filePath: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastContent = "";

  while (Date.now() < deadline) {
    try {
      lastContent = await readFile(filePath, "utf8");
      if (lastContent.includes(expected)) {
        return;
      }
    } catch {
      // The background process may not have created any output yet.
    }

    await Bun.sleep(10);
  }

  throw new Error(
    `Timed out waiting for ${JSON.stringify(expected)} in ${filePath}. Last content: ${lastContent}`,
  );
}
