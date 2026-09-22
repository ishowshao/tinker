import { startSupervisor } from "./service-supervisor";
import { loadPackageMetadata } from "./package-metadata";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionId } from "../ids/runtime-id";
import { inspectSessionLock, SessionLease } from "../session/session-lock";
import { SessionError } from "../session/session-errors";
import { SERVICE_LEASE_ID } from "../remote/service-store";
import {
  discoverLocalService,
  localServicePaths,
  type LocalServiceInstance,
  type LocalServiceTarget,
} from "../remote/local-service-discovery";

const STARTUP_LEASE_ID = parseSessionId("00000000-0000-7000-8000-000000000002");

/** Shared by the explicit background command and the default client entry. */
export async function ensureLocalService(
  target: LocalServiceTarget,
  env: NodeJS.ProcessEnv,
  timeoutMs = 30000,
): Promise<LocalServiceInstance> {
  const version = (await loadPackageMetadata()).version;
  const checkVersion = (instance: LocalServiceInstance) => {
    if (instance.appVersion && instance.appVersion !== version)
      throw new Error(
        "A different Tinker version is running. Use tinker serve --restart before connecting; active work is not interrupted automatically.",
      );
    return instance;
  };
  const paths = localServicePaths(target.config.stateDirectory);
  if (process.platform === "win32")
    throw new Error("Background service startup currently requires macOS/Linux.");
  const deadline = Date.now() + timeoutMs;
  const existing = await discoverLocalService(target);
  if (existing) return checkVersion(existing);
  await mkdir(paths.startup, { recursive: true, mode: 0o700 });
  await chmod(target.config.stateDirectory, 0o700);
  await chmod(paths.startup, 0o700);
  let lease: SessionLease | undefined;
  while (Date.now() < deadline && !lease) {
    const running = await discoverLocalService(target);
    if (running) return checkVersion(running);
    try {
      lease = await SessionLease.acquire({
        sessionDirectory: paths.startup,
        sessionId: STARTUP_LEASE_ID,
      });
    } catch (error) {
      // A competing process may still be writing its freshly-created lease.
      if (
        !(error instanceof SessionError) ||
        !["SESSION_LOCKED", "SESSION_LOCK_CORRUPT"].includes(error.code)
      )
        throw error;
      await Bun.sleep(50);
    }
  }
  if (!lease)
    throw new Error(
      `Timed out waiting for service startup ownership. Check ${paths.startup}.`,
    );
  let supervised = false;
  let child: ChildProcess | undefined;
  let childFailure: Error | undefined;
  try {
    while (Date.now() < deadline) {
      const running = await discoverLocalService(target);
      if (running) return checkVersion(running);
      if (childFailure) throw childFailure;
      if (child && (child.exitCode !== null || child.signalCode !== null))
        throw new Error(`Service exited before becoming ready. Check ${paths.log}.`);
      if (!child && !supervised) {
        const ownership = await inspectSessionLock({
          sessionDirectory: target.config.stateDirectory,
          sessionId: SERVICE_LEASE_ID,
        });
        // A foreground service or an orphaned starter's child may be initializing.
        // Never kill it, steal its lease, or start a second runtime owner.
        if (ownership === "none" || ownership === "stale") {
          supervised = await startSupervisor(target);
          if (supervised) continue;
          const log = await open(
            paths.log,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_APPEND |
              constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await log.chmod(0o600);
            child = spawn(
              process.execPath,
              [
                fileURLToPath(new URL("./index.ts", import.meta.url)),
                "serve",
                "--config",
                target.configPath,
              ],
              {
                cwd: path.dirname(target.configPath),
                env: { ...env, TINKER_HOME: target.homeRoot },
                detached: true,
                stdio: ["ignore", log.fd, log.fd],
              },
            );
            child.once("error", () => {
              childFailure = new Error(
                `Could not launch the service. Check ${paths.log}.`,
              );
            });
            child.unref();
          } finally {
            await log.close();
          }
        }
      }
      await Bun.sleep(50);
    }
    throw new Error(
      `Service is not ready. A live owner is left running; check ${paths.log} and ${paths.instance}.`,
    );
  } finally {
    await lease.release();
  }
}
