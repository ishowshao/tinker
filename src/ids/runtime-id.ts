import { createUuidV7 } from "./uuid-v7";

export type RuntimeId<Name extends string> = string & {
  readonly __runtimeId: Name;
};

export type SessionId = RuntimeId<"session">;
export type TurnId = RuntimeId<"turn">;
export type IterationId = RuntimeId<"iteration">;
export type ToolCallId = RuntimeId<"tool-call">;
export type MessageId = RuntimeId<"message">;
export type ProtocolFrameId = RuntimeId<"protocol-frame">;
export type ContextRevisionId = RuntimeId<"context-revision">;

export type RuntimeIdFactory = {
  createSessionId(): SessionId;
  createTurnId(): TurnId;
  createIterationId(): IterationId;
  createToolCallId(): ToolCallId;
  createMessageId(): MessageId;
  createProtocolFrameId(): ProtocolFrameId;
  createContextRevisionId(): ContextRevisionId;
};

export const runtimeIdFactory: RuntimeIdFactory = {
  createSessionId: () => createUuidV7() as SessionId,
  createTurnId: () => createUuidV7() as TurnId,
  createIterationId: () => createUuidV7() as IterationId,
  createToolCallId: () => createUuidV7() as ToolCallId,
  createMessageId: () => createUuidV7() as MessageId,
  createProtocolFrameId: () => createUuidV7() as ProtocolFrameId,
  createContextRevisionId: () => createUuidV7() as ContextRevisionId,
};

const canonicalUuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class SessionIdParseError extends Error {
  readonly code = "SESSION_ID_INVALID" as const;

  constructor(value: string) {
    super(`Invalid session ID: ${JSON.stringify(value)}.`);
    this.name = "SessionIdParseError";
  }
}

export class MessageIdParseError extends Error {
  readonly code = "MESSAGE_ID_INVALID" as const;

  constructor(value: string) {
    super(`Invalid message ID: ${JSON.stringify(value)}.`);
    this.name = "MessageIdParseError";
  }
}

export function parseSessionId(value: string): SessionId {
  if (!canonicalUuidV7Pattern.test(value)) {
    throw new SessionIdParseError(value);
  }
  return value as SessionId;
}

export function parseMessageId(value: string): MessageId {
  if (!canonicalUuidV7Pattern.test(value)) {
    throw new MessageIdParseError(value);
  }
  return value as MessageId;
}
