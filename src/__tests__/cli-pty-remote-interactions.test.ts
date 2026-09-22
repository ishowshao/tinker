import { expect, test } from "bun:test";
import { RemoteInteractionModel } from "./helpers/remote-interaction-model";
import { remoteTuiFixture } from "./helpers/remote-tui-test-support";
import { startPtyTui } from "./helpers/pty-tui-harness";
import { until } from "./helpers/remote-test-support";

for (const mode of ["question", "confirmation", "retry"] as const) {
  test(`PTY: service ${mode} uses the original interaction controls`, async () => {
    const model = new RemoteInteractionModel(mode, mode === "retry" ? 2 : 1);
    const f = await remoteTuiFixture(model);
    let harness;
    try {
      await Bun.write(`${f.workspace}/guarded-target`, "explicitly denied");
      const receipt = await f.prompt("interactive task");
      await until(() => f.service.session(f.sessionId).view().interaction);
      harness = await startPtyTui({
        fakeModel: "must-not-run",
        rows: 45,
        columns: 140,
        initialScreen:
          mode === "retry"
            ? "Provider request failed"
            : mode === "question"
              ? "Tinker asks"
              : "Dangerous Bash command",
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
      if (mode === "question") {
        await harness.waitForScreen("Second choice");
        await harness.press("down");
        await harness.press("enter");
      } else if (mode === "confirmation") {
        await harness.waitForScreen("y allow / n deny / Esc cancel turn");
        await harness.type("n");
      } else {
        await harness.waitForScreen("Automatic retries exhausted.");
        await harness.press("enter");
        await harness.waitForScreen("REMOTE_RETRY_FAILURE_4");
        await harness.waitForScreen("Automatic retries exhausted.");
        await harness.press("enter");
      }
      await harness.waitForScreen("REMOTE_INTERACTION_DONE");
      expect((await f.terminal(receipt)).status).toBe("completed");
      if (mode === "question")
        expect(model.requests[1].input).toContain("Second choice");
      expect(await Bun.file(`${f.workspace}/guarded-target`).exists()).toBe(true);
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
}

test("PTY: Esc ends a service provider retry without inventing a new prompt", async () => {
  const f = await remoteTuiFixture(new RemoteInteractionModel("retry"));
  let harness;
  try {
    const receipt = await f.prompt("stop retrying");
    await until(() => f.service.session(f.sessionId).view().interaction);
    harness = await startPtyTui({
      fakeModel: "must-not-run",
      rows: 40,
      columns: 140,
      initialScreen: "Automatic retries exhausted.",
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
    await harness.press("escape");
    await harness.waitForPromptReady();
    expect((await f.terminal(receipt)).status).toBe("failed");
    expect(
      f.service
        .session(f.sessionId)
        .history()
        .messages.filter((m) => m.role === "user"),
    ).toHaveLength(1);
  } finally {
    await harness?.dispose();
    await f.cleanup();
  }
}, 15000);
