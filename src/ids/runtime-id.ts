import { createUuidV7 } from "./uuid-v7";

export type RuntimeId<Name extends string> = string & {
  readonly __runtimeId: Name;
};

export type SessionId = RuntimeId<"session">;
export type TurnId = RuntimeId<"turn">;
export type IterationId = RuntimeId<"iteration">;
export type ToolCallId = RuntimeId<"tool-call">;

export type RuntimeIdFactory = {
  createSessionId(): SessionId;
  createTurnId(): TurnId;
  createIterationId(): IterationId;
  createToolCallId(): ToolCallId;
};

export const runtimeIdFactory: RuntimeIdFactory = {
  createSessionId: () => createUuidV7() as SessionId,
  createTurnId: () => createUuidV7() as TurnId,
  createIterationId: () => createUuidV7() as IterationId,
  createToolCallId: () => createUuidV7() as ToolCallId,
};
