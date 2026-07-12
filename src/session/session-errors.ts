import type {
  MessageId,
  ProtocolFrameId,
  SessionId,
  ToolCallId,
} from "../ids/runtime-id";

export type SessionErrorCode =
  | "SESSION_STORE_NOT_FOUND"
  | "SESSION_ALREADY_EXISTS"
  | "SESSION_ID_INVALID"
  | "SESSION_PERMISSION_INVALID"
  | "SESSION_LOCKED"
  | "SESSION_LOCK_CORRUPT"
  | "SESSION_SCHEMA_UNSUPPORTED"
  | "SESSION_SCHEMA_INVALID"
  | "SESSION_INTEGRITY_FAILED"
  | "SESSION_WORKSPACE_MISMATCH"
  | "SESSION_RUNTIME_MISMATCH"
  | "SESSION_PROTOCOL_INVALID"
  | "SESSION_RECALL_INDEX_INVALID"
  | "SESSION_READ_FAILED"
  | "SESSION_WRITE_FAILED"
  | "SESSION_RECOVERY_FAILED"
  | "SESSION_DELETE_BLOCKED";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  readonly operation: string;
  readonly sessionId?: SessionId;
  readonly frameId?: ProtocolFrameId;
  readonly messageId?: MessageId;
  readonly toolCallId?: ToolCallId;
  readonly sqliteCode?: string;

  constructor(
    code: SessionErrorCode,
    operation: string,
    message: string,
    details: {
      sessionId?: SessionId;
      frameId?: ProtocolFrameId;
      messageId?: MessageId;
      toolCallId?: ToolCallId;
      sqliteCode?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "SessionError";
    this.code = code;
    this.operation = operation;
    Object.assign(this, details);
  }
}

export function sessionWriteError(
  operation: string,
  sessionId: SessionId,
  error: unknown,
): SessionError {
  if (error instanceof SessionError) {
    return error;
  }
  const sqliteCode = sqliteErrorCode(error);
  return new SessionError(
    "SESSION_WRITE_FAILED",
    operation,
    `Session store write failed during ${operation}${sqliteCode === undefined ? "" : ` (${sqliteCode})`}.`,
    { sessionId, sqliteCode, cause: error },
  );
}

export function sessionOpenError(
  operation: string,
  sessionId: SessionId,
  error: unknown,
): SessionError {
  if (error instanceof SessionError) {
    return error;
  }
  const sqliteCode = sqliteErrorCode(error);
  const code: SessionErrorCode =
    sqliteCode?.includes("CORRUPT") === true || sqliteCode?.includes("NOTADB") === true
      ? "SESSION_INTEGRITY_FAILED"
      : sqliteCode?.includes("CANTOPEN") === true ||
          sqliteCode?.includes("READONLY") === true
        ? "SESSION_PERMISSION_INVALID"
        : "SESSION_INTEGRITY_FAILED";
  return new SessionError(
    code,
    operation,
    `Session store open failed during ${operation}${sqliteCode === undefined ? "" : ` (${sqliteCode})`}.`,
    { sessionId, sqliteCode, cause: error },
  );
}

export function sessionReadError(
  operation: string,
  sessionId: SessionId,
  error: unknown,
): SessionError {
  if (error instanceof SessionError) {
    return error;
  }
  const sqliteCode = sqliteErrorCode(error);
  return new SessionError(
    "SESSION_READ_FAILED",
    operation,
    `Session history read failed during ${operation}${sqliteCode === undefined ? "" : ` (${sqliteCode})`}.`,
    { sessionId, sqliteCode, cause: error },
  );
}

export function sqliteErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
