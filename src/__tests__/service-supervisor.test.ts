import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareDefaultServiceConfig } from "../cli/default-service-config";
import {
  loadLocalServiceTarget,
  discoverLocalService,
  publishLocalService,
  localServicePaths,
} from "../remote/local-service-discovery";
import { runServe } from "../cli/serve-runner";
import {
  launchAgentPlist,
  supervisorPaths,
  launchctl,
} from "../cli/service-supervisor";
import { assertServiceUpgradeSafe } from "../cli/service-upgrade";

async function fixture() {
  const root = await realpath(await mkdtemp("/tmp/tinker-supervisor-"));
  const env = { PATH: process.env.PATH, TINKER_HOME: root };
  const configPath = await prepareDefaultServiceConfig(env);
  const target = await loadLocalServiceTarget(configPath, env);
  let output = "";
  const stdout = {
    write: (text: string) => {
      output += text;
      return true;
    },
  };
  return {
    root,
    env,
    target,
    output: () => output,
    run: (options: Partial<Parameters<typeof runServe>[0]>) =>
      runServe({ env, stdout, configPath, ...options }),
  };
}

test("resident management commands stop and restart a real detached service without trusting stale PIDs", async () => {
  const f = await fixture();
  try {
    await f.run({ background: true });
    const initial = await discoverLocalService(f.target);
    expect(initial?.appVersion).toBeDefined();
    expect(
      String(
        await assertServiceUpgradeSafe(path.resolve(import.meta.dir, "../..")).catch(
          (error: unknown) => error,
        ),
      ),
    ).toContain("Stop the running service");
    await f.run({ restart: true });
    const next = await discoverLocalService(f.target);
    expect(next?.instanceId).not.toBe(initial?.instanceId);
    await f.run({ stop: true });
    expect(await discoverLocalService(f.target)).toBeUndefined();
    await f.run({ stop: true });
    expect(f.output()).toContain('"status":"stopped"');
  } finally {
    await f.run({ stop: true, force: true });
    await rm(f.root, { recursive: true, force: true });
  }
}, 15000);

test("LaunchAgent configuration uses foreground execution, conditional keepalive and private environment indirection", async () => {
  const f = await fixture();
  try {
    const plist = launchAgentPlist(f.target);
    expect(plist).toContain("PathState");
    expect(plist).toContain("TINKER_SERVICE_ENV_FILE");
    expect(plist).not.toContain("--background");
    expect(plist).not.toContain("apiKey");
    expect(plist).toContain("ExitTimeOut");
    expect(supervisorPaths(f.target).plist).toContain(
      "Library/LaunchAgents/dev.tinker.service.",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("supervised graceful exits retain the upgrade guard during restart backoff", async () => {
  const f = await fixture();
  const descriptor = `${localServicePaths(f.target.config.stateDirectory).socket}.json`;
  let unpublish: (() => Promise<void>) | undefined;
  try {
    await mkdir(f.target.config.stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(supervisorPaths(f.target).enabled, "enabled\n", { mode: 0o600 });
    unpublish = await publishLocalService(f.target, "test-epoch", 12345);
    await unpublish();
    unpublish = undefined;
    expect(await Bun.file(descriptor).exists()).toBe(true);
    expect(
      String(
        await assertServiceUpgradeSafe(path.resolve(import.meta.dir, "../..")).catch(
          (error: unknown) => error,
        ),
      ),
    ).toContain("Disable the supervised service");
  } finally {
    await unpublish?.();
    await rm(descriptor, { force: true });
    await rm(f.root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin" || process.env.TINKER_TEST_LAUNCHD !== "1")(
  "real launchd install, crash restart, deliberate stop, start and uninstall leave no test job",
  async () => {
    const f = await fixture();
    const files = supervisorPaths(f.target);
    try {
      await f.run({ install: true });
      await launchctl(["print", files.job]);
      expect((await stat(files.environment)).mode & 0o777).toBe(0o600);
      expect((await stat(files.plist)).mode & 0o777).toBe(0o600);
      const first = await discoverLocalService(f.target);
      expect(first).toBeDefined();
      await f.run({ install: true });
      expect((await discoverLocalService(f.target))?.pid).toBe(first!.pid);
      process.kill(first!.pid, "SIGKILL");
      expect(
        String(
          await assertServiceUpgradeSafe(path.resolve(import.meta.dir, "../..")).catch(
            (error: unknown) => error,
          ),
        ),
      ).toContain("Disable the supervised service");
      let next: Awaited<ReturnType<typeof discoverLocalService>>;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        next = await discoverLocalService(f.target);
        if (next && next.instanceId !== first!.instanceId) break;
        await Bun.sleep(100);
      }
      expect(next?.instanceId).toBeDefined();
      expect(next?.instanceId).not.toBe(first!.instanceId);
      await f.run({ stop: true });
      await Bun.sleep(500);
      expect(await discoverLocalService(f.target)).toBeUndefined();
      expect(await Bun.file(files.enabled).exists()).toBe(false);
      await f.run({ background: true });
      expect(await discoverLocalService(f.target)).toBeDefined();
      await f.run({ uninstall: true });
      expect(await Bun.file(files.plist).exists()).toBe(false);
      expect(await discoverLocalService(f.target)).toBeUndefined();
    } finally {
      await f.run({ uninstall: true, force: true });
      expect(await Bun.file(files.plist).exists()).toBe(false);
      await rm(f.root, { recursive: true, force: true });
    }
  },
  45000,
);
