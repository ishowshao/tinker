import { expect, test } from "bun:test";
import path from "node:path";
import { processFixture } from "./helpers/remote-recovery-support";
import { startPtyTui } from "./helpers/pty-tui-harness";

test("PTY: server restart replaces printed history once and subsequent turns remain visible", async () => {
  const f = await processFixture();
  let terminal;
  try {
    const configPath = path.join(f.root, "tui-client.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        url: f.config.url,
        token: f.config.token,
        caFile: path.join(f.root, "certificates/ca.crt"),
      }),
    );
    terminal = await startPtyTui({
      fakeModel: "must-not-run",
      rows: 50,
      columns: 140,
      cliArgs: [
        "connect",
        "--config",
        configPath,
        "--tui",
        "--workspace",
        "test",
        "--session",
        f.sessionId,
      ],
    });
    // Submit through the live terminal so its Static cache holds pre-restart IDs.
    await terminal.type("BEFORE_SERVER_RESTART");
    await terminal.waitForScreen("BEFORE_SERVER_RESTART");
    await terminal.press("enter");
    await terminal.waitForScreen("BASELINE_DONE");
    await terminal.waitForPromptReady();
    expect(terminal.screenText().match(/BASELINE_DONE/gu)).toHaveLength(1);

    f.server.child.kill("SIGKILL");
    await f.server.child.exited;
    await terminal.waitForScreen("offline");
    const restarted = await f.start(f.server.port);
    expect(restarted.epoch).not.toBe(f.server.epoch);
    await terminal.waitForScreen("online · completed", { timeoutMs: 10000 });
    await terminal.waitForScreen("BASELINE_DONE");
    expect(terminal.screenText().match(/BASELINE_DONE/gu)).toHaveLength(1);
    expect(terminal.screenText().match(/BEFORE_SERVER_RESTART/gu)).toHaveLength(1);

    await terminal.waitForPromptReady();
    await terminal.type("AFTER_SERVER_RESTART");
    await terminal.waitForScreen("AFTER_SERVER_RESTART");
    await terminal.press("enter");
    await terminal.waitForScreen(
      (screen) => (screen.match(/BASELINE_DONE/gu) ?? []).length === 2,
    );
    await terminal.waitForPromptReady();
    expect(terminal.screenText().match(/BEFORE_SERVER_RESTART/gu)).toHaveLength(1);
    expect(terminal.screenText().match(/AFTER_SERVER_RESTART/gu)).toHaveLength(1);
    expect(
      (await Bun.file(path.join(f.root, "requests")).text()).trim().split("\n"),
    ).toHaveLength(2);
    await terminal.type("/quit");
    await terminal.waitForScreen("Exit the TUI");
    await terminal.press("enter");
    expect(await terminal.waitForExit(3000)).toEqual({ code: 0, signal: null });
  } finally {
    await terminal?.dispose();
    await f.cleanup();
  }
}, 25000);
