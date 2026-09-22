import { inspectSessionLock } from "../session/session-lock";
import { SERVICE_LEASE_ID } from "../remote/service-store";
import {
  shutdownLocalService,
  type LocalServiceTarget,
} from "../remote/local-service-discovery";

/** Uses the private live endpoint; never sends signals to a PID from stale metadata. */
export async function stopLocalService(
  target: LocalServiceTarget,
  force = false,
): Promise<void> {
  await shutdownLocalService(target, force);
  const deadline =
    Date.now() + (target.config.resident?.shutdownGraceMs ?? 30000) + 15000;
  while (Date.now() < deadline) {
    const ownership = await inspectSessionLock({
      sessionDirectory: target.config.stateDirectory,
      sessionId: SERVICE_LEASE_ID,
    });
    if (ownership === "none" || ownership === "stale") return;
    await Bun.sleep(50);
  }
  throw new Error(
    `Service has not released ownership. Inspect ${target.config.stateDirectory}; no process was killed automatically.`,
  );
}
