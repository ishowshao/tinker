import { expect, test } from "bun:test";
import path from "node:path";
import { realpath, readFile } from "node:fs/promises";
import { prepareDefaultServiceConfig } from "../cli/default-service-config";
import { runServe } from "../cli/serve-runner";
import { loadRemoteClientConfig, RemoteClient } from "../remote/client";
import { SessionCatalog } from "../session/session-catalog";
import { SessionStore } from "../session/session-store";
import { createPtyTuiFixture, type PtyTuiHarness } from "./helpers/pty-tui-harness";
import { submitPrompt, quitTui } from "./helpers/pty-product-test-support";

test("PTY: idle service unloads a detached full TUI, keeps exclusive ownership and restores history when resumed", async () => {
  const f = await createPtyTuiFixture();
  const home = await realpath(f.homeRoot);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", TINKER_HOME: home };
  const configPath = await prepareDefaultServiceConfig(env);
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  await Bun.write(
    configPath,
    JSON.stringify({
      ...config,
      resident: { idleTimeoutMs: 100, shutdownGraceMs: 500 },
    }),
  );
  let terminal: PtyTuiHarness | undefined;
  let remote: RemoteClient | undefined;
  try {
    terminal = await f.start({
      cliArgs: [],
      fakeModel: "pty-echo-history",
      environment: env,
    });
    await submitPrompt(terminal, "PTY_FIRST");
    await terminal.waitForScreen("PTY_TURN_ONE_DONE");
    const catalog = new SessionCatalog({
      workspaceRoot: f.workspaceRoot,
      homeRoot: home,
    });
    const previous = (await catalog.listAll())[0];
    remote = new RemoteClient(
      await loadRemoteClientConfig(path.join(path.dirname(configPath), "client.json")),
      false,
    );
    await quitTui(terminal);
    await terminal.dispose();
    terminal = undefined;
    const deadline = Date.now() + 5000;
    let loaded = 1;
    while (Date.now() < deadline) {
      loaded = (await remote.request<{ loadedSessions: number }>("/v1/service"))
        .loadedSessions;
      if (loaded === 0) break;
      await Bun.sleep(25);
    }
    expect(loaded).toBe(0);
    expect(
      String(
        await SessionStore.openExisting({
          workspaceRoot: f.workspaceRoot,
          homeRoot: home,
          sessionId: previous.sessionId,
        }).catch((error: unknown) => error),
      ),
    ).toContain("active in pid");
    terminal = await f.start({
      cliArgs: [],
      fakeModel: "must-not-run",
      environment: env,
    });
    await submitPrompt(terminal, `/resume ${previous.sessionId}`);
    await terminal.waitForScreen("PTY_TURN_ONE_DONE");
    await submitPrompt(terminal, "PTY_SECOND");
    await terminal.waitForScreen("PTY_TURN_TWO_DONE");
    expect((await catalog.get(previous.sessionId)).turnCount).toBe(2);
    await quitTui(terminal);
  } finally {
    await terminal?.dispose();
    await remote?.close();
    await runServe({
      configPath,
      env,
      stdout: { write: () => true },
      stop: true,
      force: true,
    });
    await f.dispose();
  }
}, 20000);
