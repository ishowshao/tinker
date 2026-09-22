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
    await harness.type("this must not start a task");
    await harness.waitForScreen("this must not start a task");
    await harness.press("enter");
    await harness.waitForScreen("supports session creation");
    expect(model.requests).toBe(1);
    // Rejected input remains editable under the existing admission UX.
    for (let attempt = 0; attempt < 40 && !harness.promptReady(); attempt += 1) {
      await harness.press("ctrl_u");
      await Bun.sleep(25);
    }
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
