import type { Database } from "bun:sqlite";
import {
  formatMessageSource,
  parseMessageSource,
  type MessageSource,
} from "../context/context-source";
import { contentHash } from "../context/protocol-frame";
import type { MessageId, SessionId } from "../ids/runtime-id";
import { SessionError, sessionReadError } from "./session-errors";

export type RecallRole = "user" | "assistant" | "tool";

export type RecallSearchInput = {
  query: string;
  roles?: readonly RecallRole[];
  toolNames?: readonly string[];
  turnFrom?: number;
  turnTo?: number;
  limit: number;
  offset: number;
  snapshotThroughOrdinal?: number;
};

export type RecallSearchFilters = {
  roles?: readonly RecallRole[];
  toolNames?: readonly string[];
  turnFrom?: number;
  turnTo?: number;
};

export type RecallSearchHit = {
  source: MessageSource;
  messageId: MessageId;
  ordinal: number;
  role: RecallRole;
  origin: "user" | "model" | "tool" | "runtime";
  toolName?: string;
  turnNumber: number;
  iterationNumber?: number;
  createdAt: string;
  contentSha256: string;
  excerpt: string;
};

export type RecallSearchPage = {
  strategy: "fts5_trigram" | "substring";
  snapshotThroughOrdinal: number;
  offset: number;
  limit: number;
  hits: readonly RecallSearchHit[];
  nextOffset?: number;
};

export type RecallGetInput = {
  source: MessageSource;
  byteOffset: number;
  byteLimit: number;
};

export type RecallGetPage = {
  source: MessageSource;
  messageId: MessageId;
  ordinal: number;
  role: RecallRole;
  origin: "user" | "model" | "tool" | "runtime";
  toolName?: string;
  turnNumber: number;
  iterationNumber?: number;
  createdAt: string;
  contentSha256: string;
  totalBytes: number;
  byteOffset: number;
  returnedBytes: number;
  content: string;
  nextByteOffset?: number;
};

export interface SessionHistoryReader {
  readonly sessionId: SessionId;
  search(input: RecallSearchInput): RecallSearchPage;
  get(input: RecallGetInput): RecallGetPage;
}

export type RecallHistoryErrorCode =
  | "RECALL_SOURCE_NOT_FOUND"
  | "RECALL_PAGE_INVALID"
  | "RECALL_SNAPSHOT_INVALID";

export class RecallHistoryError extends Error {
  constructor(
    readonly code: RecallHistoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RecallHistoryError";
  }
}

type RecallRow = {
  message_id: unknown;
  ordinal: unknown;
  role: unknown;
  origin: unknown;
  name: unknown;
  turn_number: unknown;
  iteration_number: unknown;
  created_at: unknown;
  content_sha256: unknown;
  content: unknown;
  observation_sha256?: unknown;
};

export function createSessionHistoryReader(input: {
  database: Database;
  sessionId: SessionId;
  requireOpen: () => void;
}): SessionHistoryReader {
  return Object.freeze(new SqliteSessionHistoryReader(input));
}

export function isRecallableMessage(input: {
  role: string;
  content: string | null;
  toolName?: string | null;
}): boolean {
  return (
    (input.role === "user" || input.role === "assistant" || input.role === "tool") &&
    input.content !== null &&
    input.content.length > 0 &&
    !(input.role === "tool" && input.toolName === "Recall")
  );
}

class SqliteSessionHistoryReader implements SessionHistoryReader {
  readonly sessionId: SessionId;
  private readonly database: Database;
  private readonly requireStoreOpen: () => void;

  constructor(input: {
    database: Database;
    sessionId: SessionId;
    requireOpen: () => void;
  }) {
    this.database = input.database;
    this.sessionId = input.sessionId;
    this.requireStoreOpen = input.requireOpen;
  }

  search(input: RecallSearchInput): RecallSearchPage {
    const snapshot = this.resolveSnapshot(input.snapshotThroughOrdinal);
    const strategy = [...input.query].length >= 3 ? "fts5_trigram" : "substring";
    const { predicates, values } = searchPredicates(input, snapshot);
    const matchPredicate =
      strategy === "fts5_trigram"
        ? "message_fts MATCH ?"
        : `(instr(m.content, ?) > 0 OR
            instr(lower(m.content), lower(?)) > 0)`;
    const matchValues =
      strategy === "fts5_trigram"
        ? [`"${input.query.replaceAll('"', '""')}"`]
        : [input.query, input.query];
    // Pin FTS as the outer loop; otherwise SQLite prefers the session/ordinal
    // index and executes one virtual-table scan per canonical message.
    const source =
      strategy === "fts5_trigram"
        ? `message_fts
           CROSS JOIN messages m ON m.rowid = message_fts.rowid`
        : `recall_documents rd
           JOIN messages m ON m.rowid = rd.docid`;

    let rows: RecallRow[];
    try {
      this.requireStoreOpen();
      rows = this.database
        .query(
          `SELECT
             m.message_id, m.ordinal, m.role, m.origin, m.name,
             t.turn_number, i.iteration_number, m.created_at,
             m.content_sha256, m.content
           FROM ${source}
           JOIN turns t ON t.turn_id = m.turn_id
           LEFT JOIN iterations i ON i.iteration_id = m.iteration_id
           WHERE ${matchPredicate}
             AND ${predicates.join(" AND ")}
           ORDER BY
             CASE WHEN instr(m.content, ?) > 0 THEN 0 ELSE 1 END ASC,
             length(m.content) ASC,
             m.ordinal DESC,
             m.message_id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(
          ...matchValues,
          this.sessionId,
          ...values,
          input.query,
          input.limit + 1,
          input.offset,
        ) as RecallRow[];
    } catch (error) {
      throw sessionReadError("recall_search", this.sessionId, error);
    }

    let decoded: Array<RecallSearchHit & { content: string }>;
    try {
      decoded = rows.map((row) => {
        const metadata = decodeRecallRow(row);
        return {
          ...metadata,
          excerpt: buildExcerpt(metadata.content, input.query),
        };
      });
    } catch (error) {
      throw sessionReadError("decode_recall_search", this.sessionId, error);
    }
    const hasNext = decoded.length > input.limit;
    const hits = decoded.slice(0, input.limit).map(({ content, ...hit }) => {
      void content;
      return hit;
    });
    return Object.freeze({
      strategy,
      snapshotThroughOrdinal: snapshot,
      offset: input.offset,
      limit: input.limit,
      hits: Object.freeze(hits),
      ...(hasNext ? { nextOffset: input.offset + input.limit } : {}),
    });
  }

  get(input: RecallGetInput): RecallGetPage {
    const messageId = parseMessageSource(input.source);
    let row: RecallRow | null;
    try {
      this.requireStoreOpen();
      row = this.database
        .query(
          `SELECT
             m.message_id, m.ordinal, m.role, m.origin, m.name,
             t.turn_number, i.iteration_number, m.created_at,
             m.content_sha256, m.content, tr.observation_sha256
           FROM recall_documents rd
           JOIN messages m ON m.rowid = rd.docid
           JOIN turns t ON t.turn_id = m.turn_id
           LEFT JOIN iterations i ON i.iteration_id = m.iteration_id
           LEFT JOIN tool_results tr ON tr.tool_message_id = m.message_id
           WHERE m.session_id = ? AND m.message_id = ?`,
        )
        .get(this.sessionId, messageId) as RecallRow | null;
    } catch (error) {
      throw sessionReadError("recall_get", this.sessionId, error);
    }
    if (row === null) {
      throw new RecallHistoryError(
        "RECALL_SOURCE_NOT_FOUND",
        "The source was not found in recallable history for the current session.",
      );
    }

    let metadata: ReturnType<typeof decodeRecallRow>;
    try {
      metadata = decodeRecallRow(row);
    } catch (error) {
      throw sessionReadError("decode_recall_get", this.sessionId, error);
    }
    const actualHash = contentHash(metadata.content);
    const observationHash = row.observation_sha256;
    if (
      actualHash !== metadata.contentSha256 ||
      (metadata.role === "tool" && observationHash !== metadata.contentSha256)
    ) {
      throw new SessionError(
        "SESSION_READ_FAILED",
        "verify_recall_content",
        "Canonical Recall content failed its integrity check.",
        { sessionId: this.sessionId, messageId },
      );
    }

    const page = sliceUtf8Page(metadata.content, input.byteOffset, input.byteLimit);
    return Object.freeze({
      source: formatMessageSource(metadata.messageId),
      messageId: metadata.messageId,
      ordinal: metadata.ordinal,
      role: metadata.role,
      origin: metadata.origin,
      ...(metadata.toolName === undefined ? {} : { toolName: metadata.toolName }),
      turnNumber: metadata.turnNumber,
      ...(metadata.iterationNumber === undefined
        ? {}
        : { iterationNumber: metadata.iterationNumber }),
      createdAt: metadata.createdAt,
      contentSha256: metadata.contentSha256,
      ...page,
    });
  }

  private resolveSnapshot(requested: number | undefined): number {
    let maximum: number;
    try {
      this.requireStoreOpen();
      const row = this.database
        .query("SELECT MAX(ordinal) AS maximum FROM messages WHERE session_id = ?")
        .get(this.sessionId) as { maximum: unknown } | null;
      maximum = safeInteger(row?.maximum, "maximum message ordinal");
      if (requested !== undefined) {
        const exists = this.database
          .query(
            "SELECT 1 AS present FROM messages WHERE session_id = ? AND ordinal = ?",
          )
          .get(this.sessionId, requested);
        if (exists === null) {
          throw new RecallHistoryError(
            "RECALL_SNAPSHOT_INVALID",
            "The supplied search snapshot is not valid for the current session.",
          );
        }
      }
    } catch (error) {
      if (error instanceof RecallHistoryError) {
        throw error;
      }
      throw sessionReadError("resolve_recall_snapshot", this.sessionId, error);
    }
    return requested ?? maximum;
  }
}

function searchPredicates(
  input: RecallSearchInput,
  snapshot: number,
): { predicates: string[]; values: Array<string | number> } {
  const predicates = ["m.session_id = ?", "m.ordinal <= ?"];
  const values: Array<string | number> = [snapshot];

  if (input.roles !== undefined) {
    predicates.push(`m.role IN (${input.roles.map(() => "?").join(", ")})`);
    values.push(...input.roles);
  }
  if (input.toolNames !== undefined) {
    predicates.push("m.role = 'tool'");
    predicates.push(`m.name IN (${input.toolNames.map(() => "?").join(", ")})`);
    values.push(...input.toolNames);
  }
  if (input.turnFrom !== undefined) {
    predicates.push("t.turn_number >= ?");
    values.push(input.turnFrom);
  }
  if (input.turnTo !== undefined) {
    predicates.push("t.turn_number <= ?");
    values.push(input.turnTo);
  }
  return { predicates, values };
}

function decodeRecallRow(row: RecallRow): {
  source: MessageSource;
  messageId: MessageId;
  ordinal: number;
  role: RecallRole;
  origin: "user" | "model" | "tool" | "runtime";
  toolName?: string;
  turnNumber: number;
  iterationNumber?: number;
  createdAt: string;
  contentSha256: string;
  content: string;
} {
  const messageId = nonEmptyString(row.message_id, "message_id") as MessageId;
  const role = enumValue(
    row.role,
    ["user", "assistant", "tool"] as const,
    "message role",
  );
  const origin = enumValue(
    row.origin,
    ["user", "model", "tool", "runtime"] as const,
    "message origin",
  );
  const content = nonEmptyString(row.content, "message content");
  const toolName =
    row.name === null ? undefined : nonEmptyString(row.name, "tool name");
  if (!isRecallableMessage({ role, content, toolName })) {
    throw new Error("Recall query returned a message outside the allowlist.");
  }
  const iterationNumber =
    row.iteration_number === null
      ? undefined
      : safeInteger(row.iteration_number, "iteration_number");
  return {
    source: formatMessageSource(messageId),
    messageId,
    ordinal: safeInteger(row.ordinal, "ordinal"),
    role,
    origin,
    ...(toolName === undefined ? {} : { toolName }),
    turnNumber: safeInteger(row.turn_number, "turn_number"),
    ...(iterationNumber === undefined ? {} : { iterationNumber }),
    createdAt: nonEmptyString(row.created_at, "created_at"),
    contentSha256: nonEmptyString(row.content_sha256, "content_sha256"),
    content,
  };
}

function sliceUtf8Page(
  content: string,
  byteOffset: number,
  byteLimit: number,
): {
  totalBytes: number;
  byteOffset: number;
  returnedBytes: number;
  content: string;
  nextByteOffset?: number;
} {
  const bytes = Buffer.from(content, "utf8");
  if (
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0 ||
    byteOffset >= bytes.length ||
    !isUtf8Boundary(bytes, byteOffset) ||
    !Number.isSafeInteger(byteLimit) ||
    byteLimit < 1
  ) {
    throw new RecallHistoryError(
      "RECALL_PAGE_INVALID",
      "The requested byte page is outside the content or not on a UTF-8 boundary.",
    );
  }
  let end = Math.min(bytes.length, byteOffset + byteLimit);
  while (end > byteOffset && end < bytes.length && !isUtf8Boundary(bytes, end)) {
    end -= 1;
  }
  if (end === byteOffset) {
    throw new RecallHistoryError(
      "RECALL_PAGE_INVALID",
      "The byte limit is too small to return a complete UTF-8 code point.",
    );
  }
  const returnedBytes = end - byteOffset;
  return {
    totalBytes: bytes.length,
    byteOffset,
    returnedBytes,
    content: bytes.subarray(byteOffset, end).toString("utf8"),
    ...(end < bytes.length ? { nextByteOffset: end } : {}),
  };
}

function buildExcerpt(content: string, query: string): string {
  const maximumBytes = 480;
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= maximumBytes) {
    return content;
  }

  let occurrence = content.indexOf(query);
  if (occurrence < 0 && isAscii(query)) {
    occurrence = asciiCaseInsensitiveIndex(content, query);
  }
  const occurrenceByte =
    occurrence < 0 ? 0 : Buffer.byteLength(content.slice(0, occurrence), "utf8");
  const queryBytes = Buffer.byteLength(query, "utf8");
  const contentBudget = maximumBytes - 6;
  const center = occurrenceByte + Math.min(queryBytes, contentBudget) / 2;
  let start = Math.max(0, Math.floor(center - contentBudget / 2));
  let end = Math.min(bytes.length, start + contentBudget);
  if (end === bytes.length) {
    start = Math.max(0, end - contentBudget);
  }
  while (start < end && !isUtf8Boundary(bytes, start)) {
    start += 1;
  }
  while (end > start && end < bytes.length && !isUtf8Boundary(bytes, end)) {
    end -= 1;
  }
  return `${start > 0 ? "…" : ""}${bytes.subarray(start, end).toString("utf8")}${end < bytes.length ? "…" : ""}`;
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80;
}

function isAscii(value: string): boolean {
  return [...value].every((character) => character.charCodeAt(0) <= 0x7f);
}

function asciiCaseInsensitiveIndex(content: string, query: string): number {
  for (let start = 0; start <= content.length - query.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < query.length; offset += 1) {
      if (
        asciiFold(content.charCodeAt(start + offset)) !==
        asciiFold(query.charCodeAt(offset))
      ) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return start;
    }
  }
  return -1;
}

function asciiFold(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function safeInteger(value: unknown, name: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return number;
}

function enumValue<const TValues extends readonly string[]>(
  value: unknown,
  values: TValues,
  name: string,
): TValues[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${name} has an invalid value.`);
  }
  return value;
}
