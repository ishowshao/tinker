import { describe, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runtimeIdFactory } from "../ids/runtime-id";
import { SessionError } from "../session/session-errors";
import { SessionLease } from "../session/session-lock";

describe("SessionLease", () => {
  test("blocks an active writer and safely reclaims a stale owner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-lock-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const directory = path.join(root, sessionId);
    await mkdir(directory, { mode: 0o700 });
    try {
      const owner = await SessionLease.acquire({
        sessionDirectory: directory,
        sessionId,
        dependencies: {
          hostname: () => "test-host",
          pid: 101,
          processStartedAt: "2026-07-12T00:00:00.000Z",
          now: () => "2026-07-12T00:00:01.000Z",
          createLockId: () => "owner-lock",
          isProcessAlive: () => "alive",
        },
      });
      const conflict = await SessionLease.acquire({
        sessionDirectory: directory,
        sessionId,
        dependencies: {
          hostname: () => "test-host",
          pid: 202,
          processStartedAt: "2026-07-12T00:00:02.000Z",
          now: () => "2026-07-12T00:00:03.000Z",
          createLockId: () => "contender-lock",
          isProcessAlive: () => "alive",
        },
      }).catch((error: unknown) => error);
      expect(conflict).toBeInstanceOf(SessionError);
      expect((conflict as SessionError).code).toBe("SESSION_LOCKED");

      const successor = await SessionLease.acquire({
        sessionDirectory: directory,
        sessionId,
        dependencies: {
          hostname: () => "test-host",
          pid: 303,
          processStartedAt: "2026-07-12T00:00:04.000Z",
          now: () => "2026-07-12T00:00:05.000Z",
          createLockId: () => "successor-lock",
          isProcessAlive: () => "dead",
        },
      });
      const staleRelease = await owner.release().catch((error: unknown) => error);
      expect(staleRelease).toBeInstanceOf(SessionError);
      expect((staleRelease as SessionError).code).toBe("SESSION_LOCK_CORRUPT");
      await successor.release();
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("does not delete a corrupt lock record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-lock-corrupt-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const directory = path.join(root, sessionId);
    await mkdir(directory, { mode: 0o700 });
    const lockPath = path.join(directory, "active.lock");
    await writeFile(lockPath, "not-json\n", { mode: 0o600 });
    await chmod(lockPath, 0o600);
    try {
      const error = await SessionLease.acquire({
        sessionDirectory: directory,
        sessionId,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("SESSION_LOCK_CORRUPT");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("blocks another process and reclaims its lock after SIGKILL", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-lock-process-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const directory = path.join(root, sessionId);
    const markerPath = path.join(root, "ready");
    await mkdir(directory, { mode: 0o700 });
    const child = Bun.spawn(
      [
        "bun",
        path.join(import.meta.dir, "fixtures", "session-lock-holder.ts"),
        directory,
        sessionId,
        markerPath,
      ],
      { cwd: process.cwd(), stdout: "ignore", stderr: "pipe" },
    );
    try {
      await waitForFile(markerPath);
      const locked = await SessionLease.acquire({
        sessionDirectory: directory,
        sessionId,
      }).catch((error: unknown) => error);
      expect(locked).toBeInstanceOf(SessionError);
      expect((locked as SessionError).code).toBe("SESSION_LOCKED");

      child.kill(9);
      await child.exited;
      const recovered = await SessionLease.acquire({
        sessionDirectory: directory,
        sessionId,
      });
      await recovered.release();
    } finally {
      child.kill(9);
      await child.exited.catch(() => undefined);
      await rm(root, { recursive: true });
    }
  });
});

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(filePath);
      return;
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}
