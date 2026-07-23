import { expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type ProcessExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

test(
  "exits the complete TUI process after /quit in a real PTY",
  async () => {
    const repositoryRoot = path.join(import.meta.dir, "../..");
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-pty-quit-"));
    const environment = isolatedTuiEnvironment(workspace);
    const child = spawn(
      "python3",
      [
        path.join(import.meta.dir, "fixtures/pty-host.py"),
        "node",
        path.join(repositoryRoot, "bin/tinker.js"),
      ],
      {
        cwd: workspace,
        env: environment,
        stdio: "pipe",
      },
    );
    let terminalOutput = "";
    let harnessError = "";
    let spawnError: Error | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      terminalOutput += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      harnessError += chunk;
    });
    child.once("error", (error) => {
      spawnError = error;
    });

    try {
      await waitFor(
        () => terminalOutput.includes("Tinker"),
        child,
        () => spawnError,
        10_000,
        "Tinker did not render its initial PTY frame",
      );

      const outputBeforeInput = terminalOutput.length;
      child.stdin.write("/quit");
      await waitFor(
        () => terminalOutput.slice(outputBeforeInput).includes("Exit the TUI"),
        child,
        () => spawnError,
        2_000,
        "/quit did not render in the PTY input",
      );
      child.stdin.write("\r");
      const exit = await waitForExit(child, 2_000);
      if (exit === undefined) {
        throw new Error(
          [
            "Tinker did not exit within 2 seconds after /quit.",
            "Terminal output:",
            terminalOutput.slice(-4_000),
            "PTY harness stderr:",
            harnessError.slice(-2_000),
          ].join("\n"),
        );
      }
      expect(exit).toEqual({ code: 0, signal: null });
    } finally {
      await stopProcess(child);
      await rm(workspace, { recursive: true });
    }
  },
  { timeout: 20_000 },
);

function isolatedTuiEnvironment(workspace: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("TINKER_") || name === "EXA_API_KEY") {
      delete environment[name];
    }
  }
  delete environment.CI;
  Object.assign(environment, {
    HOME: workspace,
    NO_COLOR: "1",
    TERM: "xterm-256color",
    TINKER_API_KEY: "pty-placeholder-key",
    TINKER_BASE_URL: "https://api.example.test/v1",
    TINKER_CONTEXT_WINDOW_TOKENS: String(128 * 1_024),
    TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: String(16 * 1_024),
    TINKER_MODEL: "pty-test-model",
    TINKER_MODELS: "",
    TINKER_TEST_FAKE_MODEL: "pty-quit",
    TINKER_WORKSPACE: workspace,
  });
  return environment;
}

async function waitFor(
  predicate: () => boolean,
  child: ChildProcessWithoutNullStreams,
  readSpawnError: () => Error | undefined,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    const spawnError = readSpawnError();
    if (spawnError !== undefined) {
      throw spawnError;
    }
    const exit = processExit(child);
    if (exit !== undefined) {
      throw new Error(
        `${timeoutMessage}: process exited early with ${JSON.stringify(exit)}.`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`${timeoutMessage} within ${timeoutMs}ms.`);
    }
    await Bun.sleep(25);
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<ProcessExit | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exit = processExit(child);
    if (exit !== undefined) {
      return exit;
    }
    await Bun.sleep(25);
  }
  return processExit(child);
}

function processExit(child: ChildProcessWithoutNullStreams): ProcessExit | undefined {
  if (child.exitCode === null && child.signalCode === null) {
    return undefined;
  }
  return { code: child.exitCode, signal: child.signalCode };
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (processExit(child) !== undefined) {
    return;
  }
  child.kill("SIGTERM");
  if ((await waitForExit(child, 2_000)) !== undefined) {
    return;
  }
  child.kill("SIGKILL");
  await waitForExit(child, 2_000);
}
