import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { createRemoteCertificates } from "../../scripts/remote/certificates";
import { startRemoteHttpServer } from "../remote/http-server";
import { remoteFixture, RemoteTestModel } from "./helpers/remote-test-support";
import { startPtyTui } from "./helpers/pty-tui-harness";

test("PTY: full service TUI displays history, creates and reconnects sessions without local execution", async () => {
  const model = new RemoteTestModel();
  const f = await remoteFixture(model);
  const certificates = path.join(f.root, "certificates");
  await createRemoteCertificates(certificates, []);
  const token = randomBytes(32).toString("base64url");
  const server = startRemoteHttpServer(f.service, {
    stateDirectory: path.join(f.root, "service"),
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      certFile: path.join(certificates, "app.crt"),
      keyFile: path.join(certificates, "app.key"),
    },
    devices: [
      {
        id: "terminal",
        name: "Terminal",
        tokenSha256: createHash("sha256").update(token).digest("hex"),
      },
    ],
    workspaces: f.workspaces,
  });
  let harness;
  try {
    model.release();
    await f.terminal(await f.prompt("REMOTE_HISTORY_SENTINEL"));
    const configPath = path.join(f.root, "client.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        url: `https://127.0.0.1:${server.port}`,
        token,
        caFile: path.join(certificates, "ca.crt"),
      }),
    );
    harness = await startPtyTui({
      fakeModel: "must-not-run",
      rows: 45,
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
    await harness.waitForScreen("REMOTE_HISTORY_SENTINEL");
    await harness.waitForScreen("Complete answer 1");
    expect(harness.screenText()).toContain("Tinker");
    await harness.waitForScreen("online · completed");
    expect(harness.screenText()).not.toContain("Service:");
    const screen = harness.screenText();
    expect(screen.lastIndexOf("online · completed")).toBeGreaterThan(
      screen.lastIndexOf("test-model ·"),
    );

    await harness.type("/clear");
    await harness.waitForScreen("Start a new session and clear conversation");
    await harness.press("enter");
    await harness.waitForScreen(
      (screen) =>
        !screen.includes("REMOTE_HISTORY_SENTINEL") && screen.includes("Tinker"),
    );
    await harness.waitForPromptReady();
    await harness.type(`/resume ${f.sessionId}`);
    await harness.waitForScreen(`/resume ${f.sessionId}`);
    await harness.press("enter");
    await harness.waitForScreen("REMOTE_HISTORY_SENTINEL");
    await harness.waitForPromptReady();
    await harness.type("REMOTE_NEW_TASK");
    await harness.waitForScreen("REMOTE_NEW_TASK");
    await harness.press("enter");
    await harness.waitForScreen("Complete answer 2");
    expect(model.requests).toBe(2);
    await harness.waitForPromptReady();
    await harness.type("/quit");
    await harness.waitForScreen("Exit the TUI");
    await harness.press("enter");
    expect(await harness.waitForExit(3000)).toEqual({ code: 0, signal: null });
    expect(f.factoryCalls()).toBe(2);
  } finally {
    await harness?.dispose();
    await server.stopTransport();
    await f.cleanup();
  }
}, 25000);

test("PTY: full service TUI streams, steers, renders tools and stops an attached task with Esc", async () => {
  const { RemoteExecutionModel, remoteTuiFixture } = await import(
    "./helpers/remote-tui-test-support"
  );
  const model = new RemoteExecutionModel();
  const f = await remoteTuiFixture(model);
  let harness;
  const start = (initialScreen?: string) =>
    startPtyTui({
      initialScreen,
      fakeModel: "must-not-run",
      rows: 50,
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
  try {
    harness = await start();
    await harness.waitForPromptReady();
    await harness.type("PTY_REMOTE_EXECUTE");
    await harness.waitForScreen("PTY_REMOTE_EXECUTE");
    await harness.press("enter");
    await harness.waitForScreen("REMOTE_STREAM_1");
    expect(harness.screenText()).not.toContain("REMOTE_DONE_1");
    await harness.waitForScreen("Send a follow-up for the active turn");
    await harness.type("PTY_REMOTE_FOLLOWUP");
    await harness.waitForScreen("PTY_REMOTE_FOLLOWUP");
    await harness.press("enter");
    await harness.waitForScreen("Follow-up queued for the active turn (1 pending).");
    model.calls[0].release();
    await harness.waitForScreen("sleep 1");
    await harness.waitForScreen("REMOTE_STREAM_2");
    expect(model.calls[1].input).toContain("PTY_REMOTE_FOLLOWUP");
    await harness.waitForScreen("REMOTE_TOOL_DONE");
    await harness.waitForScreen((screen) => !screen.includes("(1 pending)"));
    // Process exit detaches without stopping the model; the next terminal attaches live.
    await harness.dispose();
    harness = undefined;
    expect(model.aborted).toBe(false);
    harness = await start("Send a follow-up for the active turn");
    await harness.waitForScreen("REMOTE_STREAM_2");
    // Ink may paint the restored view before its input effect subscribes.
    // Retry the idempotent stop key until the service observes cancellation.
    const stopDeadline = Date.now() + 5000;
    while (!model.aborted && Date.now() < stopDeadline) {
      await harness.press("escape");
      await Bun.sleep(100);
    }
    expect(model.aborted, harness.diagnosticText("attached task cancelled")).toBe(true);
    await harness.waitForPromptReady();
    await harness.type("/quit");
    await harness.waitForScreen("Exit the TUI");
    await harness.press("enter");
    expect(await harness.waitForExit(3000)).toEqual({ code: 0, signal: null });
  } finally {
    await harness?.dispose();
    await f.cleanup();
  }
}, 25000);
