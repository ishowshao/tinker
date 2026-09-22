import { expect, test } from "bun:test";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { createRemoteCertificates } from "../../scripts/remote/certificates";
import { ensureLocalService } from "../cli/local-service-start";
import {
  loadLocalServiceTarget,
  discoverLocalService,
} from "../remote/local-service-discovery";
import { RemoteClient } from "../remote/client";
import { SessionCatalog } from "../session/session-catalog";
import { createPtyTuiFixture, type PtyTuiHarness } from "./helpers/pty-tui-harness";

async function enter(terminal: PtyTuiHarness, text: string) {
  await terminal.waitForPromptReady();
  await terminal.type(text);
  await terminal.waitForScreen(text === "/quit" ? "Exit the TUI" : text);
  await terminal.press("enter");
}

test("PTY: register the current workspace and adopt local history only after its TUI exits", async () => {
  const f = await createPtyTuiFixture();
  const home = await realpath(f.homeRoot);
  const env = {
    PATH: process.env.PATH,
    TINKER_HOME: home,
    TINKER_API_KEY: "pty-placeholder-key",
    TINKER_BASE_URL: "https://api.example.test/v1",
    TINKER_CONTEXT_WINDOW_TOKENS: String(128 * 1024),
    TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: String(16 * 1024),
    TINKER_MODEL: "pty-test-model",
    TINKER_MODELS: "",
    TINKER_STREAM: "false",
    TINKER_TEST_FAKE_MODEL: "pty-echo-history",
  };
  const configPath = path.join(home, "service.json");
  const base = path.join(home, "initial-workspace");
  await mkdir(base);
  const certs = path.join(home, "certs");
  await createRemoteCertificates(certs, []);
  const token = randomBytes(32).toString("base64url");
  await Bun.write(
    configPath,
    JSON.stringify({
      version: 1,
      hostname: "127.0.0.1",
      port: 0,
      tls: {
        certFile: path.join(certs, "app.crt"),
        keyFile: path.join(certs, "app.key"),
      },
      devices: [
        {
          id: "terminal",
          name: "Terminal",
          tokenSha256: createHash("sha256").update(token).digest("hex"),
        },
      ],
      workspaces: [{ id: "initial", name: "Initial", path: base }],
    }),
  );
  const target = await loadLocalServiceTarget(configPath, env);
  const terminals: PtyTuiHarness[] = [];
  let pid: number | undefined;
  let transport: RemoteClient | undefined;
  try {
    const local = await f.start({
      fakeModel: "pty-echo-history",
      environment: { TINKER_HOME: home },
    });
    terminals.push(local);
    await enter(local, "PTY_FIRST");
    await local.waitForScreen("PTY_TURN_ONE_DONE");
    const summary = (
      await new SessionCatalog({
        workspaceRoot: f.workspaceRoot,
        homeRoot: home,
      }).listAll()
    )[0];
    expect(summary.status).toBe("active");
    const instance = await ensureLocalService(target, env);
    pid = instance.pid;
    const clientPath = path.join(home, "client.json");
    await Bun.write(
      clientPath,
      JSON.stringify({ url: instance.url, token, caFile: path.join(certs, "ca.crt") }),
    );
    transport = new RemoteClient(
      {
        url: instance.url,
        token,
        ca: await readFile(path.join(certs, "ca.crt"), "utf8"),
        statePath: path.join(home, "state.json"),
      },
      false,
    );
    const args = [
      "connect",
      "--config",
      clientPath,
      "--tui",
      "--service-config",
      configPath,
      "--session",
      summary.sessionId,
    ];
    expect((await transport.workspaces()).workspaces).toHaveLength(1);
    await enter(local, "/quit");
    expect((await local.waitForExit(3000))?.code).toBe(0);
    await local.dispose();

    const connected = await f.start({
      fakeModel: "must-not-run",
      cliArgs: args,
      environment: { TINKER_HOME: home },
    });
    terminals.push(connected);
    await connected.waitForScreen("PTY_TURN_ONE_DONE");
    const workspace = await transport.resolveWorkspace(await realpath(f.workspaceRoot));
    expect(workspace.id).toStartWith("local-");
    expect((await transport.workspaces()).workspaces).toHaveLength(2);
    await enter(connected, "PTY_SECOND");
    await connected.waitForScreen("PTY_TURN_TWO_DONE");
    expect(connected.screenText().match(/PTY_TURN_ONE_DONE/gu)).toHaveLength(1);
    expect(
      (
        await new SessionCatalog({
          workspaceRoot: f.workspaceRoot,
          homeRoot: home,
        }).get(summary.sessionId)
      ).turnCount,
    ).toBe(2);
    await enter(connected, "/quit");
    expect((await connected.waitForExit(3000))?.code).toBe(0);
    await connected.dispose();
    expect((await discoverLocalService(target))?.pid).toBe(pid);
    // Subsequent terminals need no workspace ID or registration flag.
    const again = await f.start({
      fakeModel: "must-not-run",
      cliArgs: [
        "connect",
        "--config",
        clientPath,
        "--tui",
        "--session",
        summary.sessionId,
      ],
      environment: { TINKER_HOME: home },
    });
    terminals.push(again);
    await again.waitForScreen("PTY_TURN_TWO_DONE");
    expect((await transport.workspaces()).workspaces).toHaveLength(2);
    await enter(again, "/quit");
    expect((await again.waitForExit(3000))?.code).toBe(0);
  } finally {
    for (const terminal of terminals) await terminal.dispose();
    await transport?.close();
    if (pid) {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + 5000;
      while (
        await Bun.file(path.join(target.config.stateDirectory, "active.lock")).exists()
      ) {
        expect(Date.now(), "Isolated service did not release its lease.").toBeLessThan(
          deadline,
        );
        await Bun.sleep(25);
      }
    }
    await f.dispose();
  }
}, 30000);
