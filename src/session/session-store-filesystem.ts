import path from "node:path";
import { chmod, lstat, mkdir, realpath, rmdir, unlink } from "node:fs/promises";
import type { SessionId } from "../ids/runtime-id";
import { canonicalHomeRoot, workspaceStorageRoot } from "./workspace-storage";
import { SessionError } from "./session-errors";

export async function assertPathMissing(
  filePath: string,
  sessionId: SessionId,
): Promise<void> {
  try {
    await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new SessionError(
    "SESSION_ALREADY_EXISTS",
    "clone_session",
    `Session directory already exists: ${filePath}.`,
    { sessionId },
  );
}

export async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new Error("Session workspace root must be absolute.");
  }
  return realpath(workspaceRoot);
}

export async function ensureSessionsRoot(
  workspaceRoot: string,
  homeRoot?: string,
): Promise<string> {
  const tinkerRoot = workspaceStorageRoot(
    workspaceRoot,
    await canonicalHomeRoot(homeRoot),
  );
  const sessionsRoot = path.join(tinkerRoot, "sessions");
  await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  await validateSessionsRoot(sessionsRoot);
  await chmod(tinkerRoot, 0o700);
  await chmod(sessionsRoot, 0o700);
  return sessionsRoot;
}

export async function validateSessionsRoot(
  sessionsRoot: string,
  sessionId?: SessionId,
): Promise<void> {
  const tinkerRoot = path.dirname(sessionsRoot);
  for (const directory of [tinkerRoot, sessionsRoot]) {
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SessionError(
          "SESSION_STORE_NOT_FOUND",
          "validate_session_root",
          `Session root does not exist: ${directory}.`,
          { sessionId, cause: error },
        );
      }
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new SessionError(
        "SESSION_PERMISSION_INVALID",
        "validate_session_root",
        `Session root must not be a symlink: ${directory}.`,
        { sessionId },
      );
    }
  }
  if ((await realpath(sessionsRoot)) !== sessionsRoot) {
    throw new SessionError(
      "SESSION_PERMISSION_INVALID",
      "validate_session_root",
      `Session root resolves outside its canonical path: ${sessionsRoot}.`,
      { sessionId },
    );
  }
}

export function safeSessionDirectory(
  sessionsRoot: string,
  sessionId: SessionId,
): string {
  const value = String(sessionId);
  if (
    value.trim() === "" ||
    value !== value.trim() ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new SessionError(
      "SESSION_ID_INVALID",
      "resolve_session_path",
      `Unsafe session ID: ${JSON.stringify(value)}.`,
      { sessionId },
    );
  }
  const directory = path.join(sessionsRoot, value);
  if (path.dirname(directory) !== sessionsRoot) {
    throw new SessionError(
      "SESSION_ID_INVALID",
      "resolve_session_path",
      `Session ID escapes the sessions directory: ${JSON.stringify(value)}.`,
      { sessionId },
    );
  }
  return directory;
}

export async function validateSecureDirectory(
  directory: string,
  sessionId: SessionId,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionError(
        "SESSION_STORE_NOT_FOUND",
        "open_session",
        `Session directory does not exist: ${directory}.`,
        { sessionId, cause: error },
      );
    }
    throw error;
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid())
  ) {
    throw new SessionError(
      "SESSION_PERMISSION_INVALID",
      "open_session",
      `Session directory must be an owner-only real directory: ${directory}.`,
      { sessionId },
    );
  }
}

export async function validateSecureFile(
  filePath: string,
  sessionId: SessionId,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionError(
        "SESSION_STORE_NOT_FOUND",
        "open_session",
        `Session database does not exist: ${filePath}.`,
        { sessionId, cause: error },
      );
    }
    throw error;
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid())
  ) {
    throw new SessionError(
      "SESSION_PERMISSION_INVALID",
      "open_session",
      `Session database must be an owner-only regular file: ${filePath}.`,
      { sessionId },
    );
  }
}

export async function validateSecureOptionalFile(
  filePath: string,
  sessionId: SessionId,
): Promise<void> {
  try {
    await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  await validateSecureFile(filePath, sessionId);
}

export async function removeKnownInitializationFiles(
  sessionDirectory: string,
): Promise<void> {
  for (const name of [
    "session.sqlite-wal",
    "session.sqlite-shm",
    "session.sqlite",
    "events.jsonl",
    "observations.md",
    "active.lock.reclaim",
    "active.lock",
  ]) {
    await unlinkIfExists(path.join(sessionDirectory, name));
  }
  try {
    await rmdir(sessionDirectory);
  } catch (error) {
    if (
      !new Set(["ENOENT", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")
    ) {
      throw error;
    }
  }
}

export async function chmodIfExists(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
