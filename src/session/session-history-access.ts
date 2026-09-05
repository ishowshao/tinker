import { Database } from "bun:sqlite";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import { parseSessionId, type SessionId } from "../ids/runtime-id";
import { SessionError } from "./session-errors";
import {
  createSessionHistoryReader,
  RecallHistoryError,
  type SessionHistoryReader,
} from "./session-history-reader";
import { verifyReadableSessionSchema } from "./session-schema";
import {
  safeSessionDirectory,
  validateSecureDirectory,
  validateSecureFile,
  validateSecureOptionalFile,
  validateSessionsRoot,
} from "./session-store-filesystem";
import { canonicalHomeRoot, workspaceStorageRoot } from "./workspace-storage";

export type RecallSessionErrorCode =
  | "RECALL_SESSION_NOT_FOUND"
  | "RECALL_SESSION_AMBIGUOUS"
  | "RECALL_SESSION_UNSUPPORTED"
  | "RECALL_SESSION_UNAVAILABLE";

export class RecallSessionError extends Error {
  constructor(
    readonly code: RecallSessionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RecallSessionError";
  }
}

export interface SessionHistoryAccess {
  readonly currentSessionId: SessionId;
  withHistoryReader<T>(
    sessionId: SessionId | undefined,
    signal: AbortSignal,
    read: (reader: SessionHistoryReader, workspaceRoot: string) => T,
  ): Promise<T>;
}

/** External history never goes through execution locks, recovery or migrations. */
export function createSessionHistoryAccess(input: {
  historyReader: SessionHistoryReader;
  workspaceRoot: string;
  homeRoot?: string;
}): SessionHistoryAccess {
  return {
    currentSessionId: input.historyReader.sessionId,
    async withHistoryReader(sessionId, signal, read) {
      throwIfTurnCancelled(signal);
      if (sessionId === undefined || sessionId === input.historyReader.sessionId) {
        const result = read(input.historyReader, input.workspaceRoot);
        throwIfTurnCancelled(signal);
        return result;
      }
      // Defence in depth: this session API also rejects non-canonical IDs.
      parseSessionId(sessionId);
      try {
        const location = await locateHistorySession({ ...input, sessionId, signal });
        throwIfTurnCancelled(signal);
        await validateHistoryFiles(location.databasePath, sessionId);
        throwIfTurnCancelled(signal);
        const database = new Database(location.databasePath, {
          readonly: true,
          strict: true,
          safeIntegers: true,
        });
        try {
          // Connection-local only. Never change journal mode or ignore a live WAL.
          database.exec("PRAGMA busy_timeout = 250");
          const result = database.transaction(() => {
            throwIfTurnCancelled(signal);
            if (verifyReadableSessionSchema(database, sessionId) !== "current") {
              throw new RecallSessionError(
                "RECALL_SESSION_UNSUPPORTED",
                "Selected session requires migration; Recall does not upgrade history.",
              );
            }
            const workspaceRoot = validateHistoryIdentity(
              database,
              location,
              sessionId,
            );
            const reader = createSessionHistoryReader({
              database,
              sessionId,
              requireOpen: () => throwIfTurnCancelled(signal),
            });
            const value = read(reader, workspaceRoot);
            throwIfTurnCancelled(signal);
            return value;
          })();
          throwIfTurnCancelled(signal);
          return result;
        } finally {
          database.close(true);
        }
      } catch (error) {
        throwIfTurnCancelled(signal);
        if (
          error instanceof RecallSessionError ||
          error instanceof RecallHistoryError
        ) {
          throw error;
        }
        const code =
          error instanceof SessionError && error.code === "SESSION_SCHEMA_UNSUPPORTED"
            ? "RECALL_SESSION_UNSUPPORTED"
            : "RECALL_SESSION_UNAVAILABLE";
        const reason = error instanceof Error ? error.message : "Unknown read failure";
        throw new RecallSessionError(
          code,
          `Selected session ${sessionId}: ${reason.slice(0, 400)}`,
          { cause: error },
        );
      }
    },
  };
}

type HistoryLocation = { databasePath: string; homeRoot: string; projectRoot: string };

async function locateHistorySession(input: {
  workspaceRoot: string;
  homeRoot?: string;
  sessionId: SessionId;
  signal: AbortSignal;
}): Promise<HistoryLocation> {
  const homeRoot = await canonicalHomeRoot(input.homeRoot);
  const currentProject = workspaceStorageRoot(input.workspaceRoot, homeRoot);
  const projectsRoot = path.dirname(currentProject);
  // Do not follow aliases in the storage hierarchy or silently skip failed scans.
  for (const directory of [path.dirname(projectsRoot), projectsRoot]) {
    if (!(await exists(directory))) {
      throw new RecallSessionError(
        "RECALL_SESSION_NOT_FOUND",
        "Selected session does not exist.",
      );
    }
    const stats = await lstat(directory);
    if (!stats.isDirectory() || (await realpath(directory)) !== directory) {
      throw new Error("History storage root must be a canonical real directory.");
    }
  }
  const projects = await readdir(projectsRoot, { withFileTypes: true });
  const roots = new Set([currentProject]);
  for (const project of projects) {
    throwIfTurnCancelled(input.signal);
    if (project.isSymbolicLink()) {
      throw new Error(
        "Cannot complete history lookup through a symlinked project directory.",
      );
    }
    if (project.isDirectory()) roots.add(path.join(projectsRoot, project.name));
  }
  const candidates: HistoryLocation[] = [];
  for (const projectRoot of roots) {
    throwIfTurnCancelled(input.signal);
    const sessionsRoot = path.join(projectRoot, "sessions");
    if (!(await exists(sessionsRoot))) continue;
    await validateSessionsRoot(sessionsRoot, input.sessionId);
    const directory = safeSessionDirectory(sessionsRoot, input.sessionId);
    if (await exists(directory)) {
      candidates.push({
        databasePath: path.join(directory, "session.sqlite"),
        homeRoot,
        projectRoot,
      });
    }
  }
  if (candidates.length === 0) {
    throw new RecallSessionError(
      "RECALL_SESSION_NOT_FOUND",
      "Selected session does not exist.",
    );
  }
  if (candidates.length !== 1) {
    throw new RecallSessionError(
      "RECALL_SESSION_AMBIGUOUS",
      "Selected session ID occurs in multiple project directories.",
    );
  }
  return candidates[0];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function validateHistoryFiles(databasePath: string, sessionId: SessionId) {
  const directory = path.dirname(databasePath);
  await validateSecureDirectory(path.dirname(path.dirname(directory)), sessionId);
  await validateSecureDirectory(path.dirname(directory), sessionId);
  await validateSecureDirectory(directory, sessionId);
  await validateSecureFile(databasePath, sessionId);
  await validateSecureOptionalFile(`${databasePath}-wal`, sessionId);
  await validateSecureOptionalFile(`${databasePath}-shm`, sessionId);
}

function validateHistoryIdentity(
  database: Database,
  location: HistoryLocation,
  sessionId: SessionId,
): string {
  const rows = database
    .query("SELECT session_id, workspace_root, initialization_state FROM session_meta")
    .all() as Array<Record<string, unknown>>;
  const meta = rows[0];
  if (
    rows.length !== 1 ||
    meta?.session_id !== sessionId ||
    meta.initialization_state !== "ready" ||
    typeof meta.workspace_root !== "string" ||
    !path.isAbsolute(meta.workspace_root) ||
    path.normalize(meta.workspace_root) !== meta.workspace_root ||
    workspaceStorageRoot(meta.workspace_root, location.homeRoot) !==
      location.projectRoot
  ) {
    throw new Error(
      "Selected session identity, workspace storage path or initialization state is invalid.",
    );
  }
  // The original workspace may no longer exist. Its stored canonical path is enough.
  return meta.workspace_root;
}
