import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCall } from "../agent/types";
import {
  createTestHistoryReader,
  createTestRuntime,
  type TestToolCallInput,
} from "./test-runtime";
import { ObservationBuilder } from "../observation/observation-builder";
import type { ShellTaskManager, ShellTaskSnapshot } from "../tools/bash-task";
import { createDefaultTooling as createDefaultToolingBase } from "../tools/registry";
import type { ToolExecutionContext, ToolRawResult } from "../tools/types";
import { TurnCancelledError } from "../agent/turn-cancellation";

const testToolContext: ToolExecutionContext = {
  signal: new AbortController().signal,
};

function createDefaultTooling(
  options: Omit<
    Parameters<typeof createDefaultToolingBase>[0],
    "runtimeSession" | "historyReader"
  >,
) {
  const testRuntime = createTestRuntime();
  const tooling = createDefaultToolingBase({
    ...options,
    runtimeSession: testRuntime.runtimeSession,
    historyReader: createTestHistoryReader(testRuntime.runtimeSession.sessionId),
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
  test("denies a dangerous command before spawning it", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bash-"));
    const marker = path.join(workspace, "spawned");

    try {
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        bashGuard: {
          surface: "one-shot",
          confirm: async () => "deny",
        },
      });
      const raw = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_guard_deny",
          name: "Bash",
          args: { command: `shutdown; touch ${marker}`, tty: true },
        }),
      );

      expect(raw.ok).toBe(false);
      expect(raw.taskId).toBe("");
      expect(raw.outputFilePath).toBe("");
      expect(raw.tty).toBe(true);
      expect(raw.error).toContain("Non-interactive mode cannot confirm");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("allows a confirmed dangerous command and guards background execution", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bash-"));
    const requests: string[] = [];

    try {
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        bashGuard: {
          surface: "tui",
          confirm: async (_call, request) => {
            requests.push(request.command);
            return "allow";
          },
        },
      });
      const raw = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_guard_allow",
          name: "Bash",
          args: {
            command: "dd if=/dev/null of=/dev/null count=0",
            run_in_background: true,
          },
        }),
      );

      expect(requests).toEqual(["dd if=/dev/null of=/dev/null count=0"]);
      expect(raw.ok).toBe(true);
      expect(raw.backgrounded).toBe(true);
      await tooling.dispose();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("runs a safe PTY command in one-shot guard mode without confirmation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bash-"));
    const requests: string[] = [];
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      bashGuard: {
        surface: "one-shot",
        confirm: async (_call, request) => {
          requests.push(request.command);
          return "deny";
        },
      },
    });

    try {
      const raw = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_safe_pty",
          name: "Bash",
          args: {
            command:
              'printf \'\\033[31msafe-pty\\033[0m %s %s %s %s\\n\' "$TERM" "$PAGER" "$GIT_PAGER" "$NO_COLOR"',
            tty: true,
          },
        }),
      );
      expect(requests).toEqual([]);
      expect(raw.ok).toBe(true);
      expect(raw.tty).toBe(true);
      expect(raw.screen).toContain("safe-pty xterm-256color cat cat 1");
      expect(raw.screen).not.toContain("\x1b");
      expect(await readFile(raw.outputFilePath, "utf8")).toContain("\x1b[31m");
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("does not spawn while confirmation is pending and respects cancellation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bash-"));
    const controller = new AbortController();
    let confirmationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      confirmationStarted = resolve;
    });

    try {
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        bashGuard: {
          surface: "tui",
          confirm: async (_call, _request, signal) => {
            confirmationStarted?.();
            return new Promise<"allow" | "deny">((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  reject(
                    signal.reason instanceof Error
                      ? signal.reason
                      : new Error("cancelled"),
                  );
                },
                { once: true },
              );
            });
          },
        },
      });
      const execution = tooling.runtime.execute(
        {
          providerToolCallId: "call_guard_cancel",
          name: "Bash",
          args: { command: "reboot" },
        },
        { signal: controller.signal },
      );
      await started;
      controller.abort(new TurnCancelledError("user"));

      expect(execution).rejects.toBeInstanceOf(TurnCancelledError);
      expect(tooling.taskManager.listBackgroundTasks()).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

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
        properties: { tty: { type: "boolean" } },
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

      const invalidTty = await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Bash",
        args: { command: "echo nope", tty: "yes" },
      });
      expect(invalidTty.ok).toBe(false);
      expect("error" in invalidTty ? invalidTty.error : "").toContain("Bash.tty");
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

  test("disables color output by default for Bash child processes", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bash-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_1",
          name: "Bash",
          args: { command: 'printf "%s" "$NO_COLOR"' },
        }),
      );

      expect(raw.ok).toBe(true);
      expect(raw.status).toBe("completed");
      expect(raw.preview).toBe("1");
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

      try {
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
        const completedTask = await waitForTaskTerminal(
          tooling.taskManager,
          backgroundRaw.taskId,
        );
        expect(completedTask.status).toBe("completed");
        expect(completedTask.exitCode).toBe(0);
        expect(await readFile(backgroundRaw.outputFilePath, "utf8")).toContain(
          realWorkspace,
        );
        expect(tooling.bashState.cwd).toBe(realSubdir);
      } finally {
        await tooling.dispose();
      }
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
      expect(raw.preview).toContain(
        "... output omitted: lines 101-105 (5 lines). Full output is available at outputFilePath.",
      );
      expect(raw.preview).toContain("line-106");
      expect(raw.preview).toContain("line-205");
      expect(raw.preview).not.toContain("line-105\n");

      const oneOmitted = asBashRawResult(
        await tooling.runtime.execute({
          providerToolCallId: "call_2",
          name: "Bash",
          args: { command: "for i in $(seq 1 201); do echo line-$i; done" },
        }),
      );
      expect(oneOmitted.preview).toContain(
        "... output omitted: lines 101-101 (1 line). Full output is available at outputFilePath.",
      );
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

async function waitForTaskTerminal(
  taskManager: ShellTaskManager,
  taskId: string,
): Promise<ShellTaskSnapshot> {
  const deadline = Date.now() + 2_000;
  let lastStatus = "missing";

  while (Date.now() < deadline) {
    const task = taskManager.inspectTask(taskId)?.task;
    if (task !== undefined) {
      lastStatus = task.status;
      if (
        task.status === "completed" ||
        task.status === "failed" ||
        task.status === "killed"
      ) {
        return task;
      }
    }

    await Bun.sleep(10);
  }

  throw new Error(
    `Timed out waiting for task ${taskId} to finish. Last status: ${lastStatus}`,
  );
}
