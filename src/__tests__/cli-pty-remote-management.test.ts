import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { memoryDirectory } from "../memory/memory-files";
import { CapabilityModel } from "./helpers/remote-capability-model";
import { remoteTuiFixture } from "./helpers/remote-tui-test-support";
import { startPtyTui } from "./helpers/pty-tui-harness";
import { until } from "./helpers/remote-test-support";

test("PTY: service global memory and confirmed session deletion use the existing TUI", async () => {
  const model = new CapabilityModel();
  const f = await remoteTuiFixture(model);
  let harness;
  try {
    const notes = path.join(memoryDirectory(f.root), "notes");
    await mkdir(notes, { recursive: true });
    await Bun.write(
      path.join(notes, "memory.md"),
      "# REMOTE_MEMORY_NOTE\n\nREMOTE_MEMORY_DETAIL",
    );
    harness = await startPtyTui({
      fakeModel: "must-not-run",
      rows: 45,
      columns: 140,
      cliArgs: [
        "connect",
        "--config",
        f.configPath,
        "--tui",
        "--workspace",
        "test",
        "--session",
        f.sessionId,
      ],
    });
    await harness.type("/memory");
    await harness.waitForScreen("/memory");
    await harness.press("enter");
    await harness.waitForScreen("Global memory");
    await harness.waitForScreen("REMOTE_MEMORY_DETAIL");
    await harness.press("escape");
    await harness.waitForPromptReady();
    await harness.type("/clear");
    await harness.waitForScreen("Start a new session");
    await harness.press("enter");
    await harness.waitForScreen(
      (screen) => !screen.includes(f.sessionId) && screen.includes("Tinker"),
    );
    await harness.waitForPromptReady();
    await until(() => f.service.session(f.sessionId).connectedClients === 0);
    const command = `/session delete ${f.sessionId} --confirm`;
    await harness.type(command);
    await harness.waitForScreen(command);
    await harness.press("enter");
    await harness.waitForScreen(`Deleted session ${f.sessionId}.`);
    expect(f.store.session(f.sessionId)).toBeUndefined();
    expect(model.inputs).toHaveLength(0);
    await harness.waitForPromptReady();
    await harness.type("/quit");
    await harness.waitForScreen("Exit the TUI");
    await harness.press("enter");
    expect(await harness.waitForExit(3000)).toEqual({ code: 0, signal: null });
  } finally {
    await harness?.dispose();
    await f.cleanup();
  }
}, 20000);

test("PTY: server project commands, branch display and prompt-history navigation remain available", async () => {
  const model = new CapabilityModel();
  const f = await remoteTuiFixture(model);
  let harness;
  try {
    const git = Bun.spawn(
      ["git", "init", "--initial-branch=server-branch", f.workspace],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await git.exited).toBe(0);
    await Bun.write(
      path.join(f.workspace, ".tinker.json"),
      JSON.stringify({
        version: 1,
        slashCommands: [
          {
            name: "server-command",
            description: "Server command",
            prompt: "SERVER_PROJECT_PROMPT",
          },
        ],
      }),
    );
    const { PromptHistory } = await import("../tui/prompt-history");
    const { promptHistoryPath } = await import("../cli/config");
    const history = await PromptHistory.load(
      await promptHistoryPath(f.workspace, f.root),
    );
    await history.append("HISTORY_ON_SERVER");
    harness = await startPtyTui({
      fakeModel: "must-not-run",
      rows: 45,
      columns: 140,
      cliArgs: [
        "connect",
        "--config",
        f.configPath,
        "--tui",
        "--workspace",
        "test",
        "--session",
        f.sessionId,
      ],
    });
    await harness.waitForScreen("server-branch");
    await harness.press("up");
    await harness.waitForScreen("HISTORY_ON_SERVER");
    await harness.press("ctrl_u");
    await harness.waitForPromptReady();
    await harness.type("/server-command");
    await harness.waitForScreen("Server command");
    await harness.press("enter");
    await harness.waitForScreen("CAPABILITY_DONE");
    expect(model.inputs[0]).toContain("SERVER_PROJECT_PROMPT");
  } finally {
    await harness?.dispose();
    await f.cleanup();
  }
}, 20000);
