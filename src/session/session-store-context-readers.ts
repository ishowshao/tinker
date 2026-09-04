import type { Database } from "bun:sqlite";
import type { StoredContextRevisionV8 } from "../context/context-revision";
import type {
  ActiveTurnBoundary,
  ClosedTurnBoundary,
} from "../context/prefix-retirement-planner";
import { type ProtocolContextView } from "../context/protocol-frame";
import type { ContextRevisionId, SessionId, TurnId } from "../ids/runtime-id";
import {
  type StoredMeasuredContextState,
  type StoredSessionMetaV10,
} from "./session-store-contracts";
import { requireItem } from "./session-store-sql";
import {
  enumFromSql,
  numberFromSql,
  recordFromSql,
  sha256FromSql,
  stringFromSql,
  timestampFromSql,
} from "./session-store-value-codecs";

export function requireActiveRevisionId(meta: StoredSessionMetaV10): ContextRevisionId {
  if (meta.initializationState !== "ready" || meta.activeRevisionId === null) {
    throw new Error("Session has no active context revision.");
  }
  return meta.activeRevisionId;
}

export function previousRevision(
  revisions: readonly StoredContextRevisionV8[],
  revision: StoredContextRevisionV8,
): StoredContextRevisionV8 | undefined {
  return revisions[revision.revisionNumber - 2];
}

function decodeMeasuredContextState(
  value: unknown,
  expectedSessionId: SessionId,
): StoredMeasuredContextState {
  const row = recordFromSql(value, "context measurement state");
  const sessionId = stringFromSql(row.session_id, "session_id") as SessionId;
  if (sessionId !== expectedSessionId) {
    throw new Error(
      `Context measurement session ID ${sessionId} does not match store.`,
    );
  }
  const promptTokens = numberFromSql(row.prompt_tokens, "prompt_tokens");
  const completionTokens = numberFromSql(row.completion_tokens, "completion_tokens");
  const totalTokens = numberFromSql(row.total_tokens, "total_tokens");
  if (totalTokens !== promptTokens + completionTokens) {
    throw new Error(
      "Context measurement total_tokens must equal prompt_tokens + completion_tokens.",
    );
  }

  timestampFromSql(row.updated_at, "updated_at");
  return Object.freeze({
    revisionId: stringFromSql(row.revision_id, "revision_id") as ContextRevisionId,
    anchor: Object.freeze({
      totalTokens,
      promptTokens,
      completionTokens,
      segmentCount: numberFromSql(row.segment_count, "segment_count"),
      prefixHash: sha256FromSql(row.prefix_hash, "prefix_hash"),
      requestConfigHash: sha256FromSql(row.request_config_hash, "request_config_hash"),
      toolSchemaHash: sha256FromSql(row.tool_schema_hash, "tool_schema_hash"),
    }),
  });
}

export function readRetirementBoundaries(
  database: Database,
  canonical: ProtocolContextView,
  activeTurnId?: TurnId,
): {
  readonly closedTurns: readonly ClosedTurnBoundary[];
  readonly activeTurn?: ActiveTurnBoundary;
} {
  const rows = database
    .query("SELECT * FROM turns ORDER BY turn_number")
    .all() as Array<Record<string, unknown>>;
  const boundaries: ClosedTurnBoundary[] = [];
  let activeTurn: ActiveTurnBoundary | undefined;
  let expectedOrdinal = 2;
  for (let index = 0; index < rows.length; index += 1) {
    const row = requireItem(rows, index, "turn row");
    const turnId = stringFromSql(row.turn_id, "turn_id") as TurnId;
    const turnNumber = numberFromSql(row.turn_number, "turn_number");
    const status = enumFromSql(
      row.status,
      ["open", "completed", "failed", "cancelled", "interrupted"] as const,
      "turn status",
    );
    const frames = canonical.frames.filter((frame) => frame.turnId === turnId);
    const messages = canonical.messages.filter(
      (message) => message.role !== "system" && message.turnId === turnId,
    );
    const firstMessage = messages[0];
    const lastMessage = messages.at(-1);
    if (status === "open") {
      if (
        activeTurnId === undefined ||
        turnId !== activeTurnId ||
        index !== rows.length - 1 ||
        turnNumber !== index + 1 ||
        messages.length < 1 ||
        frames.length < 1 ||
        firstMessage?.role !== "user" ||
        firstMessage.ordinal !== expectedOrdinal ||
        lastMessage?.ordinal !== canonical.messages.length ||
        frames.some((frame) => frame.state !== "closed")
      ) {
        throw new Error(`Turn ${turnId} has an invalid active boundary.`);
      }
      activeTurn = Object.freeze({
        turnId,
        turnNumber,
        firstOrdinal: expectedOrdinal,
      });
      expectedOrdinal = canonical.messages.length + 1;
      continue;
    }
    let nextFrameOrdinal = expectedOrdinal;
    for (const frame of frames) {
      if (
        frame.state !== "closed" ||
        frame.firstOrdinal !== nextFrameOrdinal ||
        frame.lastOrdinal === undefined
      ) {
        throw new Error(`Turn ${turnId} has an invalid closed frame boundary.`);
      }
      nextFrameOrdinal = frame.lastOrdinal + 1;
    }
    if (
      turnNumber !== index + 1 ||
      frames.length < 1 ||
      messages.length < 1 ||
      firstMessage?.role !== "user" ||
      firstMessage.ordinal !== expectedOrdinal ||
      lastMessage === undefined ||
      nextFrameOrdinal !== lastMessage.ordinal + 1
    ) {
      throw new Error(`Turn ${turnId} has an invalid canonical boundary.`);
    }
    boundaries.push(
      Object.freeze({
        turnId,
        turnNumber,
        status,
        firstOrdinal: expectedOrdinal,
        lastOrdinal: lastMessage.ordinal,
        frameCount: frames.length,
        messageCount: messages.length,
      }),
    );
    expectedOrdinal = lastMessage.ordinal + 1;
  }
  if (expectedOrdinal !== canonical.messages.length + 1) {
    throw new Error("Closed turn boundaries do not cover canonical history.");
  }
  if ((activeTurnId === undefined) !== (activeTurn === undefined)) {
    throw new Error("Active retirement boundary does not match the open turn.");
  }
  return Object.freeze({
    closedTurns: Object.freeze(boundaries),
    ...(activeTurn === undefined ? {} : { activeTurn }),
  });
}

export function loadMeasuredContextState(
  database: Database,
  sessionId: SessionId,
): StoredMeasuredContextState | undefined {
  const rows = database.query("SELECT * FROM context_measurement_state").all();
  if (rows.length > 1) {
    throw new Error(
      `Expected at most one context measurement row; found ${rows.length}.`,
    );
  }
  const row = rows[0];
  return row === undefined ? undefined : decodeMeasuredContextState(row, sessionId);
}
