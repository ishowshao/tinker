import type { RemoteFailure } from "./failures";
import {
  parseSessionOperation,
  type SessionOperation,
  type SessionOperationResult,
} from "./session-operations";
import { validateUserMessage, type UserImageAttachment } from "../image/image-types";
import type { RunAgentResult } from "../agent/types";
import type { QueueFollowUpResult } from "../agent/runtime-session-contracts";
import type {
  RemoteHistoryPage,
  RemoteMessage,
} from "../session/remote-history-reader";

export const REMOTE_PROTOCOL_VERSION = 1;
export type OperationStatus =
  | "accepted"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type RemoteOperationInput = { requestId: string } & (
  | { kind: "create"; workspaceId: string; title?: string; profileName?: string }
  | { kind: "delete_session"; sessionId: string; targetSessionId: string }
  | SessionOperation
  | { kind: "adopt"; workspaceId: string; sessionId: string }
  | {
      kind: "prompt";
      sessionId: string;
      prompt: string;
      attachments?: readonly UserImageAttachment[];
    }
  | {
      kind: "provider_retry";
      sessionId: string;
      interactionId: string;
      decision: "retry" | "stop";
    }
  | { kind: "follow_up"; sessionId: string; targetRequestId: string; prompt: string }
  | { kind: "stop"; sessionId: string; targetRequestId: string }
  | {
      kind: "answer";
      sessionId: string;
      interactionId: string;
      selectedIndex: number | null;
    }
  | {
      kind: "confirm";
      sessionId: string;
      interactionId: string;
      decision: "allow" | "deny";
    }
);

export type OperationReceipt = {
  requestId: string;
  sessionId: string;
  kind: RemoteOperationInput["kind"];
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
  turnId?: string;
  prompt?: string;
  attachments?: readonly UserImageAttachment[];
  sessionResult?: SessionOperationResult;
  failure?: RemoteFailure;
  error?: string;
  result?: RunAgentResult;
  followUp?: QueueFollowUpResult;
  hasFollowUps?: boolean;
};

export type RemoteSessionInfo = {
  id: string;
  workspaceId: string;
  title: string;
  modelName: string;
  owner: "service" | "local";
  status: string;
  updatedAt: string;
};

export type RemoteInteraction =
  | {
      id: string;
      kind: "question";
      question: string;
      options: readonly { description: string }[];
    }
  | { id: string; kind: "confirmation"; command: string; reason: string };

export type RemoteTool = {
  id: string;
  name: string;
  arguments: string;
  status: "running" | "completed" | "failed" | "cancelled";
  detail?: string;
};

export type RemoteActivity = {
  session: RemoteSessionInfo;
  status: "idle" | OperationStatus;
  activeRequestId?: string;
  activeTurnId?: string;
  streaming?: { iterationId: string; attempt: number; text: string };
  tools: RemoteTool[];
  interaction?: RemoteInteraction;
  operations: OperationReceipt[];
  error?: string;
};

export type RemoteView = RemoteActivity & { history: RemoteHistoryPage };
export type RemoteChange = { activity: RemoteActivity; messages: RemoteMessage[] };
export type RemoteCursor = { epoch: string; sequence: number };
export type RemoteFrame = { version: 1; epoch: string; sequence: number } & (
  | { type: "snapshot"; view: RemoteView }
  | { type: "event"; change: RemoteChange }
);

export class RemoteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

export function isTerminal(status: OperationStatus): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function requireId(value: unknown, name: string, uuid = false): string {
  if (typeof value !== "string" || !(uuid ? UUID : ID).test(value)) {
    throw new RemoteError(400, "INVALID_REQUEST", `${name} is invalid.`);
  }
  return value;
}

export function parseOperation(value: unknown): RemoteOperationInput {
  const object = requireObject(value);
  const requestId = requireId(object.requestId, "requestId", true);
  const kind = object.kind;
  const sessionId = () => requireId(object.sessionId, "sessionId", true);
  let result: RemoteOperationInput;
  switch (kind) {
    case "compact":
    case "retire":
    case "undo":
    case "fork":
    case "reasoning":
    case "yolo":
    case "switch_model":
    case "default_profile":
      result = { requestId, ...parseSessionOperation(object) };
      break;
    case "create":
      result = {
        requestId,
        kind,
        workspaceId: requireId(object.workspaceId, "workspaceId"),
        ...(object.profileName === undefined
          ? {}
          : { profileName: requireText(object.profileName, "profileName", 240) }),
        ...(object.title === undefined
          ? {}
          : { title: requireText(object.title, "title", 240) }),
      };
      break;
    case "delete_session":
      result = {
        kind,
        requestId,
        sessionId: sessionId(),
        targetSessionId: requireId(object.targetSessionId, "targetSessionId", true),
      };
      break;
    case "adopt":
      result = {
        requestId,
        kind,
        workspaceId: requireId(object.workspaceId, "workspaceId"),
        sessionId: sessionId(),
      };
      break;
    case "prompt":
      result = {
        requestId,
        kind,
        sessionId: sessionId(),
        prompt: requireText(object.prompt, "prompt", 64 * 1024),
        ...(object.attachments === undefined
          ? {}
          : { attachments: object.attachments as readonly UserImageAttachment[] }),
      };
      try {
        validateUserMessage({
          role: "user",
          content: result.prompt,
          attachments: result.attachments,
        });
      } catch (error) {
        throw new RemoteError(
          400,
          "INVALID_IMAGE_MESSAGE",
          error instanceof Error ? error.message : String(error),
        );
      }
      break;
    case "follow_up":
      result = {
        requestId,
        kind,
        sessionId: sessionId(),
        targetRequestId: requireId(object.targetRequestId, "targetRequestId", true),
        prompt: requireText(object.prompt, "prompt", 64 * 1024),
      };
      break;
    case "stop":
      result = {
        requestId,
        kind,
        sessionId: sessionId(),
        targetRequestId: requireId(object.targetRequestId, "targetRequestId", true),
      };
      break;
    case "provider_retry":
      if (object.decision !== "retry" && object.decision !== "stop")
        throw new RemoteError(
          400,
          "INVALID_REQUEST",
          "decision must be retry or stop.",
        );
      result = {
        requestId,
        kind,
        sessionId: sessionId(),
        interactionId: requireId(object.interactionId, "interactionId", true),
        decision: object.decision,
      };
      break;
    case "confirm":
      if (object.decision !== "allow" && object.decision !== "deny") {
        throw new RemoteError(
          400,
          "INVALID_REQUEST",
          "decision must be allow or deny.",
        );
      }
      result = {
        requestId,
        kind,
        sessionId: sessionId(),
        interactionId: requireId(object.interactionId, "interactionId", true),
        decision: object.decision,
      };
      break;
    case "answer": {
      const selectedIndex = object.selectedIndex;
      if (
        selectedIndex !== null &&
        (typeof selectedIndex !== "number" ||
          !Number.isSafeInteger(selectedIndex) ||
          selectedIndex < 0)
      ) {
        throw new RemoteError(
          400,
          "INVALID_REQUEST",
          "selectedIndex must be a nonnegative integer or null.",
        );
      }
      result = {
        requestId,
        kind,
        sessionId: sessionId(),
        interactionId: requireId(object.interactionId, "interactionId", true),
        selectedIndex,
      };
      break;
    }
    default:
      throw new RemoteError(400, "INVALID_REQUEST", "Unknown operation kind.");
  }
  if (Object.keys(object).some((key) => !(key in result))) {
    throw new RemoteError(400, "INVALID_REQUEST", "Unexpected operation field.");
  }
  return result;
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteError(400, "INVALID_REQUEST", "Expected an object.");
  }
  return value as Record<string, unknown>;
}

export function requireText(value: unknown, name: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > maxBytes
  ) {
    throw new RemoteError(
      400,
      "INVALID_REQUEST",
      `${name} must contain 1–${maxBytes} bytes.`,
    );
  }
  return value;
}
