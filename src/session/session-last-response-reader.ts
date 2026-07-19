import { Database } from "bun:sqlite";
import { realpath } from "node:fs/promises";
import { contentHash } from "../context/protocol-frame";
import type { SessionId } from "../ids/runtime-id";
import { SessionError, sessionOpenError, sessionReadError } from "./session-errors";
import { verifySessionSchema } from "./session-schema";
import { decodeStoredToolCalls, sessionDatabasePath } from "./session-store";

const OPERATION = "read_last_assistant_response";

export async function readLastAssistantResponse(input: {
  workspaceRoot: string;
  sessionId: SessionId;
}): Promise<string | undefined> {
  const workspaceRoot = await realpath(input.workspaceRoot);
  let database: Database;
  try {
    database = new Database(sessionDatabasePath(workspaceRoot, input.sessionId), {
      readonly: true,
      strict: true,
      safeIntegers: true,
    });
  } catch (error) {
    throw sessionOpenError(OPERATION, input.sessionId, error);
  }

  try {
    return readResponse(database, {
      workspaceRoot,
      sessionId: input.sessionId,
    });
  } finally {
    database.close();
  }
}

function readResponse(
  database: Database,
  input: { workspaceRoot: string; sessionId: SessionId },
): string | undefined {
  try {
    verifySessionSchema(database, input.sessionId);
    const metaRows = database
      .query("SELECT session_id, workspace_root FROM session_meta")
      .all() as Array<Record<string, unknown>>;
    if (
      metaRows.length !== 1 ||
      metaRows[0]?.session_id !== input.sessionId ||
      metaRows[0]?.workspace_root !== input.workspaceRoot
    ) {
      throw integrityError(
        input.sessionId,
        "Session identity does not match the requested last response.",
      );
    }

    const row = database
      .query(
        `SELECT
           t.turn_id,
           t.turn_number,
           t.final_message_id,
           m.message_id,
           m.session_id AS message_session_id,
           m.turn_id AS message_turn_id,
           m.role,
           m.content,
           m.content_sha256,
           m.tool_calls_json
         FROM turns t
         LEFT JOIN messages m ON m.message_id = t.final_message_id
         WHERE t.session_id = ? AND t.status = 'completed'
         ORDER BY t.turn_number DESC
         LIMIT 1`,
      )
      .get(input.sessionId) as Record<string, unknown> | null;
    if (row === null) {
      return undefined;
    }

    return decodeResponse(row, input.sessionId);
  } catch (error) {
    throw sessionReadError(OPERATION, input.sessionId, error);
  }
}

function decodeResponse(
  row: Record<string, unknown>,
  sessionId: SessionId,
): string | undefined {
  const turnId = requireNonEmptyString(row.turn_id, "turn ID", sessionId);
  requirePositiveInteger(row.turn_number, "turn number", sessionId);
  const finalMessageId = requireNonEmptyString(
    row.final_message_id,
    "final message ID",
    sessionId,
  );
  if (
    row.message_id !== finalMessageId ||
    row.message_session_id !== sessionId ||
    row.message_turn_id !== turnId
  ) {
    throw integrityError(
      sessionId,
      `Final message ${finalMessageId} does not match turn ${turnId}.`,
    );
  }
  if (row.role !== "assistant") {
    throw integrityError(
      sessionId,
      `Final message ${finalMessageId} is not assistant.`,
    );
  }

  const toolCalls =
    row.tool_calls_json === null
      ? []
      : decodeStoredToolCalls(
          requireNonEmptyString(
            row.tool_calls_json,
            "final message tool calls",
            sessionId,
          ),
        );
  if (toolCalls.length !== 0) {
    throw integrityError(
      sessionId,
      `Final message ${finalMessageId} still contains tool calls.`,
    );
  }

  const content = requireNullableString(
    row.content,
    "final message content",
    sessionId,
  );
  const storedHash = requireNonEmptyString(
    row.content_sha256,
    "final message content hash",
    sessionId,
  );
  if (contentHash(content) !== storedHash) {
    throw integrityError(
      sessionId,
      `Final message ${finalMessageId} content hash does not match.`,
    );
  }
  return content === null || content.trim() === "" ? undefined : content;
}

function requireNonEmptyString(
  value: unknown,
  name: string,
  sessionId: SessionId,
): string {
  if (typeof value !== "string" || value === "") {
    throw integrityError(sessionId, `Stored ${name} must be non-empty text.`);
  }
  return value;
}

function requireNullableString(
  value: unknown,
  name: string,
  sessionId: SessionId,
): string | null {
  if (value !== null && typeof value !== "string") {
    throw integrityError(sessionId, `Stored ${name} must be text or null.`);
  }
  return value;
}

function requirePositiveInteger(
  value: unknown,
  name: string,
  sessionId: SessionId,
): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw integrityError(sessionId, `Stored ${name} must be a positive integer.`);
  }
  return number;
}

function integrityError(sessionId: SessionId, message: string): SessionError {
  return new SessionError("SESSION_INTEGRITY_FAILED", OPERATION, message, {
    sessionId,
  });
}
