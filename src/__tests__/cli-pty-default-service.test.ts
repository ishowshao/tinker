import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  defaultServiceConfigPath,
  discoverLocalService,
  loadLocalServiceTarget,
} from "../remote/local-service-discovery";
import { SessionCatalog } from "../session/session-catalog";
import { createPtyTuiFixture, type PtyTuiHarness } from "./helpers/pty-tui-harness";
import { submitPrompt, quitTui } from "./helpers/pty-product-test-support";

const profile = (model: string) => ({
  model,
  apiBase: "https://api.example.test/v1",
  apiKey: "placeholder",
  contextWindowTokens: 131072,
  maxSupportedOutputTokens: 16384,
  stream: false,
});

test("PTY: default entry boots a shared service, preserves profile selection and resumes history after terminal exit", async () => {
  const f = await createPtyTuiFixture({
    homeFiles: {
      "models.json": JSON.stringify({
        default: "alpha",
        profiles: { alpha: profile("alpha-model"), beta: profile("beta-model") },
      }),
    },
  });
  const other = await createPtyTuiFixture();
  const home = await realpath(f.homeRoot);
  const env = { TINKER_HOME: home, TINKER_MODELS: path.join(home, "models.json") };
  const configPath = defaultServiceConfigPath(env);
  const terminals: PtyTuiHarness[] = [];
  try {
    const started = await Promise.allSettled([
      f.start({
        cliArgs: ["--profile", "beta"],
        fakeModel: "pty-echo-history",
        environment: env,
      }),
      other.start({ cliArgs: [], fakeModel: "pty-echo-history", environment: env }),
    ]);
    for (const result of started)
      if (result.status === "fulfilled") terminals.push(result.value);
    for (const result of started) if (result.status === "rejected") throw result.reason;
    const [first, second] = terminals;
    await first.waitForScreen("beta-model");
    expect(first.screenText()).not.toContain("preview");
    await submitPrompt(first, "PTY_FIRST");
    await first.waitForScreen("PTY_TURN_ONE_DONE");
    const target = await loadLocalServiceTarget(configPath, env);
    const instance = await discoverLocalService(target);
    expect(instance).toBeDefined();
    const catalog = new SessionCatalog({
      workspaceRoot: f.workspaceRoot,
      homeRoot: home,
    });
    const previous = (await catalog.listAll())[0];
    expect(previous.profileName).toBe("beta");
    // No arguments in another workspace: same home and service, a separate session and default profile.
    await second.waitForScreen("alpha-model");
    expect((await discoverLocalService(target))?.instanceId).toBe(instance!.instanceId);
    await quitTui(second);
    await second.dispose();
    await quitTui(first);
    await first.dispose();
    expect((await discoverLocalService(target))?.pid).toBe(instance!.pid);
    // Default entry again creates a new session; /resume attaches the hosted old one.
    const again = await f.start({
      cliArgs: [],
      fakeModel: "must-not-run",
      environment: env,
    });
    terminals.push(again);
    await again.waitForScreen("alpha-model");
    await submitPrompt(again, `/resume ${previous.sessionId}`);
    await again.waitForScreen("PTY_TURN_ONE_DONE");
    await again.waitForPromptReady();
    await submitPrompt(again, "PTY_SECOND");
    await again.waitForScreen("PTY_TURN_TWO_DONE");
    expect((await catalog.get(previous.sessionId)).turnCount).toBe(2);
    await quitTui(again);
    await again.dispose();
    // Explicit independent mode still works and does not replace the shared service.
    const local = await f.start({
      cliArgs: ["--local", "--profile", "beta"],
      fakeModel: "must-not-run",
      environment: env,
    });
    terminals.push(local);
    await local.waitForScreen("beta-model");
    expect(local.screenText()).not.toContain("online");
    expect((await discoverLocalService(target))?.instanceId).toBe(instance!.instanceId);
    await quitTui(local);
  } finally {
    for (const terminal of terminals) await terminal.dispose();
    if (await Bun.file(configPath).exists()) {
      const target = await loadLocalServiceTarget(configPath, env);
      const instance = await discoverLocalService(target);
      if (instance) process.kill(instance.pid, "SIGTERM");
      const deadline = Date.now() + 5000;
      while (
        await Bun.file(path.join(target.config.stateDirectory, "active.lock")).exists()
      ) {
        expect(Date.now()).toBeLessThan(deadline);
        await Bun.sleep(25);
      }
    }
    await other.dispose();
    await f.dispose();
  }
}, 35000);
