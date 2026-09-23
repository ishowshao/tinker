import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { SessionLease } from "../session/session-lock";
import {
  discoverLocalService,
  loadLocalServiceTarget,
  localServicePaths,
  type LocalServiceTarget,
} from "../remote/local-service-discovery";
import { STARTUP_LEASE_ID } from "./local-service-start";
import { stopLocalService } from "./service-control";
import { disableSupervisor, startSupervisor } from "./service-supervisor";
import { findUpgradeServices } from "./service-upgrade";

export type ServiceUpgradePlan = {
  readonly restartInstructions: string;
  restart(version: string): Promise<void>;
  release(): Promise<void>;
};

/** Start a fresh CLI from the installed files, never from the updater's loaded modules. */
async function startInstalledService(
  packageRoot: string,
  target: LocalServiceTarget,
  env: NodeJS.ProcessEnv,
  version: string,
): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(packageRoot, "src/cli/index.ts"),
      "serve",
      "--background",
      "--config",
      target.configPath,
    ],
    {
      env: { ...env, TINKER_HOME: target.homeRoot },
      cwd: path.dirname(target.configPath),
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const [code, diagnostic] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(diagnostic.trim() || `Service startup exited with code ${code}.`);
  const instance = await discoverLocalService(target);
  if (instance?.appVersion !== version || instance.packageRoot !== packageRoot)
    throw new Error(
      `Service did not become ready with version ${version} from ${packageRoot}.`,
    );
}

export async function prepareServiceUpgrade(
  packageRoot: string,
  env: NodeJS.ProcessEnv,
  findServices = findUpgradeServices,
): Promise<ServiceUpgradePlan> {
  packageRoot = await realpath(packageRoot);
  const services = await findServices(packageRoot);
  const leases: SessionLease[] = [];
  const stopped: { target: LocalServiceTarget; version: string }[] = [];
  const release = async () => {
    for (const lease of leases.splice(0)) await lease.release();
  };
  const restartInstructions = () =>
    stopped
      .map(
        ({ target }) =>
          `TINKER_HOME=${quote(target.homeRoot)} tinker serve --config ${quote(target.configPath)} --restart`,
      )
      .join("\n");
  try {
    const targets = [];
    // Inspect every affected service before stopping any of them. Unknown old
    // endpoints must never interpret an idle-only request as an ordinary drain.
    for (const { instance } of services) {
      if (
        !instance.idleShutdownSupported ||
        !instance.homeRoot ||
        !instance.appVersion ||
        typeof instance.busy !== "boolean"
      )
        throw new Error(
          `Cannot safely restart service ${instance.configPath} automatically. Wait for it to become idle, run tinker serve --config ${quote(instance.configPath)} --stop, then retry tinker update.`,
        );
      if (instance.busy)
        throw new Error(
          `Service ${instance.configPath} is busy; update postponed. Wait for work to finish, then retry tinker update.`,
        );
      const target = await loadLocalServiceTarget(instance.configPath, {
        ...env,
        TINKER_HOME: instance.homeRoot,
      });
      if (
        target.config.stateDirectory !== instance.stateDirectory ||
        target.fingerprint !== instance.fingerprint
      )
        throw new Error(
          `Service configuration changed: ${instance.configPath}. Stop it manually before updating.`,
        );
      const startup = localServicePaths(target.config.stateDirectory).startup;
      await mkdir(startup, { recursive: true, mode: 0o700 });
      leases.push(
        await SessionLease.acquire({
          sessionDirectory: startup,
          sessionId: STARTUP_LEASE_ID,
        }),
      );
      targets.push({ target, version: instance.appVersion });
    }
    for (const entry of targets) {
      stopped.push(entry);
      await disableSupervisor(entry.target);
      // The server repeats the busy check atomically with closing admission.
      await stopLocalService(entry.target, false, true);
    }
  } catch (error) {
    await release();
    const failures: string[] = [];
    for (const { target, version } of stopped) {
      try {
        await startSupervisor(target);
        await startInstalledService(packageRoot, target, env, version);
      } catch (restoreError) {
        failures.push(String(restoreError));
      }
    }
    if (failures.length)
      throw new Error(
        `${String(error)}\nCould not restore all services: ${failures.join("; ")}\n${restartInstructions()}`,
        { cause: error },
      );
    throw error;
  }
  return {
    restartInstructions: restartInstructions(),
    release,
    async restart(version) {
      await release();
      const failures: string[] = [];
      for (const { target } of stopped) {
        try {
          await startInstalledService(packageRoot, target, env, version);
        } catch (error) {
          failures.push(`${target.configPath}: ${String(error)}`);
        }
      }
      if (failures.length) throw new Error(failures.join("\n"));
    },
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
