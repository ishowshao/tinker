import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { prepareDefaultServiceConfig } from "../cli/default-service-config";
import { ensureLocalService } from "../cli/local-service-start";
import { runServe } from "../cli/serve-runner";
import { prepareServiceUpgrade } from "../cli/update-services";
import {
  discoverLocalService,
  loadLocalServiceTarget,
  publishLocalService,
  type LocalServiceInstance,
} from "../remote/local-service-discovery";

test("upgrade stops an idle detached server, blocks concurrent startup, and verifies a fresh server", async () => {
  const root = await realpath(await mkdtemp("/tmp/tinker-upgrade-"));
  const env = { PATH: process.env.PATH, TINKER_HOME: root };
  const configPath = await prepareDefaultServiceConfig(env);
  const target = await loadLocalServiceTarget(configPath, env);
  const stdout = { write: () => true };
  const packageRoot = await realpath(path.resolve(import.meta.dir, "../.."));
  let plan: Awaited<ReturnType<typeof prepareServiceUpgrade>> | undefined;
  try {
    const first = await ensureLocalService(target, env);
    expect(first.idleShutdownSupported).toBe(true);
    expect(first.busy).toBe(false);
    // Restrict the test to its own service; never control a developer's live server.
    const findServices = async () => [{ instance: first, supervised: false }];
    plan = await prepareServiceUpgrade(packageRoot, env, findServices);
    expect(await discoverLocalService(target)).toBeUndefined();
    expect(
      String(
        await ensureLocalService(target, env, 100).catch((error: unknown) => error),
      ),
    ).toContain("startup ownership");
    await plan.restart(first.appVersion!);
    const next = await discoverLocalService(target);
    expect(next?.instanceId).not.toBe(first.instanceId);
    expect(next?.appVersion).toBe(first.appVersion);
    expect(next?.homeRoot).toBe(root);
    expect(plan.restartInstructions).toContain(configPath);
  } finally {
    await plan?.release();
    await runServe({ configPath, env, stdout, stop: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("upgrade refuses busy and older servers before trying to load or stop them", async () => {
  const packageRoot = path.resolve(import.meta.dir, "../..");
  for (const supported of [true, false]) {
    const instance = {
      configPath: "/not-accessed/service.json",
      homeRoot: "/not-accessed",
      appVersion: "3.0.0",
      idleShutdownSupported: supported,
      busy: true,
    } as LocalServiceInstance;
    expect(
      String(
        await prepareServiceUpgrade(packageRoot, {}, async () => [
          { instance, supervised: false },
        ]).catch((error: unknown) => error),
      ),
    ).toContain(supported ? "update postponed" : "Cannot safely restart");
  }
});

test("a service becoming busy during preparation restores an earlier stopped server", async () => {
  const root = await realpath(await mkdtemp("/tmp/tinker-upgrade-race-"));
  const env = { PATH: process.env.PATH, TINKER_HOME: root };
  const configPath = await prepareDefaultServiceConfig(env);
  const target = await loadLocalServiceTarget(configPath, env);
  const otherEnv = { ...env, TINKER_HOME: path.join(root, "other") };
  const otherConfig = await prepareDefaultServiceConfig(otherEnv);
  const other = await loadLocalServiceTarget(otherConfig, otherEnv);
  const packageRoot = await realpath(path.resolve(import.meta.dir, "../.."));
  let unpublish: (() => Promise<void>) | undefined;
  let idleOnlyReceived = false;
  try {
    const first = await ensureLocalService(target, env);
    await mkdir(other.config.stateDirectory, { recursive: true, mode: 0o700 });
    unpublish = await publishLocalService(other, "busy-after-probe", 12345, undefined, {
      appVersion: first.appVersion!,
      status: () => ({ busy: false }),
      shutdown: async (force, idleOnly) => {
        expect(force).toBe(false);
        idleOnlyReceived = idleOnly === true;
        throw new Error("Service is busy; update postponed");
      },
    });
    const second = (await discoverLocalService(other))!;
    const failure = await prepareServiceUpgrade(packageRoot, env, async () => [
      { instance: first, supervised: false },
      { instance: second, supervised: false },
    ]).catch((error: unknown) => error);
    expect(String(failure)).toContain("update postponed");
    expect(String(failure)).not.toContain("Could not restore");
    expect(idleOnlyReceived).toBe(true);
    const restored = await discoverLocalService(target);
    expect(restored?.appVersion).toBe(first.appVersion);
    expect(restored?.instanceId).not.toBe(first.instanceId);
    expect((await discoverLocalService(other))?.instanceId).toBe(second.instanceId);
  } finally {
    await unpublish?.();
    await runServe({
      configPath,
      env,
      stdout: { write: () => true },
      stop: true,
      force: true,
    });
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
