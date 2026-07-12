import os from "node:os";
import path from "node:path";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { SessionId } from "../ids/runtime-id";
import { SessionError } from "./session-errors";

export type SessionLockRecordV1 = {
  version: 1;
  lockId: string;
  sessionId: SessionId;
  pid: number;
  hostname: string;
  processStartedAt: string;
  acquiredAt: string;
};

export type SessionLeaseDependencies = {
  hostname(): string;
  pid: number;
  processStartedAt: string;
  now(): string;
  createLockId(): string;
  isProcessAlive(pid: number): "alive" | "dead";
};

const defaultDependencies: SessionLeaseDependencies = {
  hostname: os.hostname,
  pid: process.pid,
  processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
  now: () => new Date().toISOString(),
  createLockId: randomUUID,
  isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        return "dead";
      }
      return "alive";
    }
  },
};

export class SessionLease {
  private released = false;
  private lockPath: string;

  private constructor(
    readonly record: SessionLockRecordV1,
    lockPath: string,
  ) {
    this.lockPath = lockPath;
  }

  static async acquire(input: {
    sessionDirectory: string;
    sessionId: SessionId;
    dependencies?: Partial<SessionLeaseDependencies>;
  }): Promise<SessionLease> {
    const dependencies = { ...defaultDependencies, ...input.dependencies };
    const lockPath = path.join(input.sessionDirectory, "active.lock");
    const reclaimPath = path.join(input.sessionDirectory, "active.lock.reclaim");
    const record: SessionLockRecordV1 = {
      version: 1,
      lockId: dependencies.createLockId(),
      sessionId: input.sessionId,
      pid: dependencies.pid,
      hostname: dependencies.hostname(),
      processStartedAt: dependencies.processStartedAt,
      acquiredAt: dependencies.now(),
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new SessionLease(record, lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new SessionError(
            "SESSION_LOCK_CORRUPT",
            "acquire_lease",
            `Cannot create session lock ${lockPath}.`,
            { sessionId: input.sessionId, cause: error },
          );
        }
      }

      let existing: SessionLockRecordV1;
      try {
        existing = await readLockRecord(lockPath, input.sessionId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (
        existing.hostname !== dependencies.hostname() ||
        dependencies.isProcessAlive(existing.pid) === "alive"
      ) {
        throw new SessionError(
          "SESSION_LOCKED",
          "acquire_lease",
          `Session ${input.sessionId} is active in pid ${existing.pid} since ${existing.acquiredAt}.`,
          { sessionId: input.sessionId },
        );
      }

      let reclaimHandle;
      try {
        reclaimHandle = await open(reclaimPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          continue;
        }
        throw new SessionError(
          "SESSION_LOCK_CORRUPT",
          "reclaim_lease",
          `Cannot create reclaim marker for session ${input.sessionId}.`,
          { sessionId: input.sessionId, cause: error },
        );
      }

      try {
        let confirmed: SessionLockRecordV1;
        try {
          confirmed = await readLockRecord(lockPath, input.sessionId);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          throw error;
        }
        if (
          confirmed.lockId !== existing.lockId ||
          confirmed.hostname !== dependencies.hostname() ||
          dependencies.isProcessAlive(confirmed.pid) === "alive"
        ) {
          continue;
        }
        await unlink(lockPath);
      } finally {
        await reclaimHandle.close();
        await unlinkIfExists(reclaimPath);
      }
    }

    throw new SessionError(
      "SESSION_LOCKED",
      "acquire_lease",
      `Session ${input.sessionId} lock changed while it was being acquired.`,
      { sessionId: input.sessionId },
    );
  }

  relocate(sessionDirectory: string): void {
    this.requireActive();
    this.lockPath = path.join(sessionDirectory, "active.lock");
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    const current = await readLockRecord(this.lockPath, this.record.sessionId);
    if (current.lockId !== this.record.lockId) {
      throw new SessionError(
        "SESSION_LOCK_CORRUPT",
        "release_lease",
        `Session lock token changed before release for ${this.record.sessionId}.`,
        { sessionId: this.record.sessionId },
      );
    }
    await unlink(this.lockPath);
    this.released = true;
  }

  private requireActive(): void {
    if (this.released) {
      throw new Error("Cannot use a released SessionLease.");
    }
  }
}

export async function inspectSessionLock(input: {
  sessionDirectory: string;
  sessionId: SessionId;
  dependencies?: Partial<SessionLeaseDependencies>;
}): Promise<"none" | "active" | "stale" | "corrupt"> {
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const lockPath = path.join(input.sessionDirectory, "active.lock");
  try {
    const record = await readLockRecord(lockPath, input.sessionId);
    if (record.hostname !== dependencies.hostname()) {
      return "active";
    }
    return dependencies.isProcessAlive(record.pid) === "alive" ? "active" : "stale";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "none";
    }
    return error instanceof SessionError ? "corrupt" : "corrupt";
  }
}

async function readLockRecord(
  lockPath: string,
  sessionId: SessionId,
): Promise<SessionLockRecordV1> {
  const stats = await lstat(lockPath);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new SessionError(
      "SESSION_LOCK_CORRUPT",
      "read_lease",
      `Session lock has unsafe type or permissions: ${lockPath}.`,
      { sessionId },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    throw new SessionError(
      "SESSION_LOCK_CORRUPT",
      "read_lease",
      `Session lock is not valid JSON: ${lockPath}.`,
      { sessionId, cause: error },
    );
  }
  if (!isLockRecord(parsed) || parsed.sessionId !== sessionId) {
    throw new SessionError(
      "SESSION_LOCK_CORRUPT",
      "read_lease",
      `Session lock does not match session ${sessionId}.`,
      { sessionId },
    );
  }
  return parsed;
}

function isLockRecord(value: unknown): value is SessionLockRecordV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "acquiredAt",
    "hostname",
    "lockId",
    "pid",
    "processStartedAt",
    "sessionId",
    "version",
  ];
  return (
    Object.keys(record).sort().join("\n") === expectedKeys.join("\n") &&
    record.version === 1 &&
    typeof record.lockId === "string" &&
    record.lockId !== "" &&
    typeof record.sessionId === "string" &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.hostname === "string" &&
    record.hostname !== "" &&
    typeof record.processStartedAt === "string" &&
    !Number.isNaN(Date.parse(record.processStartedAt)) &&
    typeof record.acquiredAt === "string" &&
    !Number.isNaN(Date.parse(record.acquiredAt))
  );
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
