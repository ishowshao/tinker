import { expect, test } from "bun:test";
import { RemoteInteractionModel } from "./helpers/remote-interaction-model";
import {
  RemoteExecutionModel,
  remoteTuiFixture,
} from "./helpers/remote-tui-test-support";
import { until } from "./helpers/remote-test-support";
import { startPtyTui, type PtyTuiHarness } from "./helpers/pty-tui-harness";

function terminal(
  f: Awaited<ReturnType<typeof remoteTuiFixture>>,
  initialScreen?: string,
) {
  return startPtyTui({
    fakeModel: "must-not-run",
    rows: 50,
    columns: 140,
    initialScreen,
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
}

async function command(harness: PtyTuiHarness, text: string) {
  await harness.type(text);
  await harness.waitForScreen(
    text === "/clear" ? "Start a new session and clear conversation" : text,
  );
  await harness.press("enter");
}

test("PTY: simultaneous full TUIs share execution while switching and process exit preserve server ownership", async () => {
  const model = new RemoteExecutionModel(false);
  const f = await remoteTuiFixture(model);
  const terminals: PtyTuiHarness[] = [];
  try {
    const first = await terminal(f);
    terminals.push(first);
    const second = await terminal(f);
    terminals.push(second);
    expect(f.factoryCalls()).toBe(1);
    await command(first, "MULTI_TERMINAL_ORIGINAL");
    await first.waitForScreen("REMOTE_STREAM_1");
    await second.waitForScreen("REMOTE_STREAM_1");
    await second.waitForScreen("Send a follow-up for the active turn");
    const task = f.service
      .session(f.sessionId)
      .view()
      .operations.find((operation) => operation.kind === "prompt")!;
    expect(task).toBeDefined();
    expect(model.calls).toHaveLength(1);

    // Closing the actual submitting process must leave server execution running.
    await first.signalTui("SIGTERM");
    expect(await first.waitForExit(3000)).toBeDefined();
    expect(model.aborted).toBe(false);
    expect(f.store.get(task.requestId).status).toBe("running");
    model.calls[0].release();
    expect((await f.terminal(task)).status).toBe("completed");
    await second.waitForScreen("REMOTE_DONE_1");
    await second.waitForPromptReady();

    // Each terminal owns its selection; clearing one must not move a reconnecting peer.
    await command(second, "/clear");
    await second.waitForScreen((screen) => !screen.includes("REMOTE_STREAM_1"));
    await second.waitForPromptReady();
    await command(second, "MULTI_TERMINAL_INDEPENDENT");
    await second.waitForScreen("REMOTE_STREAM_2");
    expect(model.calls[1].input).not.toContain("MULTI_TERMINAL_ORIGINAL");
    expect(f.factoryCalls()).toBe(2);
    const reconnected = await terminal(f);
    terminals.push(reconnected);
    await reconnected.waitForScreen("REMOTE_DONE_1");
    expect(reconnected.screenText()).not.toContain("MULTI_TERMINAL_INDEPENDENT");
    model.calls[1].release();
    await second.waitForScreen("REMOTE_DONE_2");
    expect(model.calls).toHaveLength(2);
    expect(f.factoryCalls()).toBe(2);
    expect(
      f.service
        .session(f.sessionId)
        .history()
        .messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  } finally {
    for (const harness of terminals) await harness.dispose();
    await f.cleanup();
  }
}, 30000);

test("PTY: simultaneous question responses settle once and dismiss the interaction in both full TUIs", async () => {
  const model = new RemoteInteractionModel("question", 1);
  const f = await remoteTuiFixture(model);
  const terminals: PtyTuiHarness[] = [];
  try {
    const task = await f.prompt("MULTI_TERMINAL_QUESTION");
    await until(() => f.service.session(f.sessionId).view().interaction);
    const first = await terminal(f, "Tinker asks");
    terminals.push(first);
    const second = await terminal(f, "Tinker asks");
    terminals.push(second);
    await first.waitForScreen("Second choice");
    await second.waitForScreen("Second choice");
    await second.press("down");
    await Promise.all([first.press("enter"), second.press("enter")]);
    await first.waitForScreen("REMOTE_INTERACTION_DONE");
    await second.waitForScreen("REMOTE_INTERACTION_DONE");
    await first.waitForScreen((screen) => !screen.includes("Tinker asks"));
    await second.waitForScreen((screen) => !screen.includes("Tinker asks"));
    expect((await f.terminal(task)).status).toBe("completed");
    expect(model.requests).toHaveLength(2);
    expect(
      f.store
        .operations(f.sessionId)
        .filter(
          (operation) =>
            operation.kind === "answer" && operation.status === "completed",
        ),
    ).toHaveLength(1);
    expect(
      f.service
        .session(f.sessionId)
        .history()
        .messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(f.factoryCalls()).toBe(1);
  } finally {
    for (const harness of terminals) await harness.dispose();
    await f.cleanup();
  }
}, 20000);
