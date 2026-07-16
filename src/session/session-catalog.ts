import path from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { parseSessionId, type SessionId } from "../ids/runtime-id";
import { SessionError } from "./session-errors";
import { inspectSessionLock } from "./session-lock";
import { SessionStore } from "./session-store";
import { verifySessionSchema } from "./session-schema";

export type SessionSummary = {
  sessionId: SessionId;
  modelName: string;
  profileName?: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  firstUserPromptPreview?: string;
  status:
    | "current"
    | "resumable"
    | "interrupted"
    | "active"
    | "incomplete"
    | "unavailable";
  databaseBytes: number;
  statusDetail?: string;
};

export class SessionCatalog {
  private readonly workspaceRootPromise: Promise<string>;

  constructor(private readonly input: { workspaceRoot: string; limit?: number }) {
    this.workspaceRootPromise = realpath(input.workspaceRoot);
  }

  async list(currentSessionId?: SessionId): Promise<readonly SessionSummary[]> {
    const workspaceRoot = await this.workspaceRootPromise;
    const sessionsRoot = path.join(workspaceRoot, ".tinker", "sessions");
    let entries;
    try {
      entries = await readdir(sessionsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      let sessionId: SessionId;
      try {
        sessionId = parseSessionId(entry.name);
      } catch {
        continue;
      }
      const directory = path.join(sessionsRoot, entry.name);
      summaries.push(
        await readSummary(directory, sessionId, workspaceRoot, currentSessionId),
      );
    }

    return Object.freeze(
      summaries
        .filter(
          (summary) =>
            summary.turnCount > 0 ||
            summary.status === "incomplete" ||
            summary.status === "unavailable",
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, this.input.limit ?? 20),
    );
  }

  async get(
    sessionId: SessionId,
    currentSessionId?: SessionId,
  ): Promise<SessionSummary> {
    const workspaceRoot = await this.workspaceRootPromise;
    const directory = path.join(workspaceRoot, ".tinker", "sessions", sessionId);
    return readSummary(directory, sessionId, workspaceRoot, currentSessionId);
  }

  async delete(sessionId: SessionId, currentSessionId?: SessionId): Promise<void> {
    if (sessionId === currentSessionId) {
      throw new SessionError(
        "SESSION_DELETE_BLOCKED",
        "delete_session",
        "Cannot delete the current session.",
        { sessionId },
      );
    }
    const workspaceRoot = await this.workspaceRootPromise;
    const store = await SessionStore.openExisting({
      workspaceRoot,
      sessionId,
      allowIncomplete: true,
    });
    try {
      await store.deleteFromDisk();
    } catch (error) {
      await store.abandon().catch(() => undefined);
      throw error;
    }
  }
}

async function readSummary(
  directory: string,
  sessionId: SessionId,
  workspaceRoot: string,
  currentSessionId?: SessionId,
): Promise<SessionSummary> {
  const databasePath = path.join(directory, "session.sqlite");
  let database: Database | undefined;
  try {
    database = new Database(databasePath, {
      readonly: true,
      strict: true,
      safeIntegers: true,
    });
    verifySessionSchema(database, sessionId);
    const meta = database.query("SELECT * FROM session_meta").all() as Array<
      Record<string, unknown>
    >;
    if (meta.length !== 1) {
      throw new Error(`Expected one session_meta row; found ${meta.length}.`);
    }
    const row = meta[0];
    if (row.session_id !== sessionId || row.workspace_root !== workspaceRoot) {
      throw new Error("Session identity or workspace does not match.");
    }
    const turnCount = toSafeNumber(
      (
        database.query("SELECT COUNT(*) AS count FROM turns").get() as {
          count: unknown;
        }
      ).count,
    );
    const firstPrompt = database
      .query(
        `SELECT content FROM messages
         WHERE role = 'user' ORDER BY ordinal LIMIT 1`,
      )
      .get() as { content: string } | null;
    const openState = toSafeNumber(
      (
        database
          .query(
            `SELECT
              (SELECT COUNT(*) FROM turns WHERE status = 'open') +
              (SELECT COUNT(*) FROM protocol_frames WHERE state = 'open') AS count`,
          )
          .get() as { count: unknown }
      ).count,
    );
    const lock = await inspectSessionLock({ sessionDirectory: directory, sessionId });
    const initializationState = requireString(
      row.initialization_state,
      "initialization_state",
    );
    const status =
      sessionId === currentSessionId
        ? "current"
        : initializationState !== "ready"
          ? "incomplete"
          : lock === "active"
            ? "active"
            : lock === "corrupt"
              ? "unavailable"
              : openState > 0 || lock === "stale"
                ? "interrupted"
                : "resumable";
    return {
      sessionId,
      modelName: requireString(row.model_name, "model_name"),
      ...profileNameFromRuntimeContract(row.runtime_contract_json),
      createdAt: requireTimestamp(row.created_at, "created_at"),
      updatedAt: requireTimestamp(row.updated_at, "updated_at"),
      turnCount,
      ...(firstPrompt === null
        ? {}
        : { firstUserPromptPreview: preview(firstPrompt.content) }),
      status,
      databaseBytes: await sessionDatabaseBytes(databasePath),
      ...(lock === "corrupt" ? { statusDetail: "lock is corrupt" } : {}),
    };
  } catch (error) {
    const fallback = await stat(directory);
    return {
      sessionId,
      modelName: "unavailable",
      createdAt: fallback.birthtime.toISOString(),
      updatedAt: fallback.mtime.toISOString(),
      turnCount: 0,
      status: "unavailable",
      databaseBytes: await sessionDatabaseBytes(databasePath),
      statusDetail: errorMessage(error),
    };
  } finally {
    database?.close();
  }
}

function profileNameFromRuntimeContract(value: unknown): { profileName?: string } {
  if (value === null) {
    return {};
  }
  if (typeof value !== "string") {
    throw new Error("Session runtime contract must be JSON text.");
  }
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Session runtime contract must be an object.");
  }
  const profileName = (parsed as Record<string, unknown>).profileName;
  if (profileName === undefined) {
    return {};
  }
  return { profileName: requireString(profileName, "profileName") };
}

async function sessionDatabaseBytes(databasePath: string): Promise<number> {
  let total = 0;
  for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      total += (await stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return total;
}

function preview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 120);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireTimestamp(value: unknown, name: string): string {
  const timestamp = requireString(value, name);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${name} must be a timestamp.`);
  }
  return timestamp;
}

function toSafeNumber(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error("SQLite count is not a safe non-negative integer.");
  }
  return number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
