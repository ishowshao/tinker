import type {
  ContextCompactionResult,
  ContextRetirementResult,
} from "../context/context-manager";
import type { TurnUndoResult } from "../tools/turn-undo-manager";
import type { ReasoningEffortSnapshot } from "../model/reasoning-effort";
import { requireId, requireText, RemoteError } from "./protocol";

export type SessionOperation = { sessionId: string } & (
  | { kind: "compact" | "retire" | "undo" | "fork" }
  | { kind: "reasoning"; effort: string | null }
  | { kind: "yolo"; enabled: boolean }
  | { kind: "switch_model" | "default_profile"; profileName: string }
);
export type SessionOperationResult =
  | { kind: "compact"; value: ContextCompactionResult }
  | { kind: "retire"; value: ContextRetirementResult }
  | { kind: "undo"; value: TurnUndoResult }
  | { kind: "fork" | "switch_model"; value: string }
  | { kind: "reasoning"; value: ReasoningEffortSnapshot }
  | { kind: "yolo" | "default_profile"; value: null };
export function isSessionOperation(input: { kind: string }): input is SessionOperation {
  return [
    "compact",
    "retire",
    "undo",
    "fork",
    "reasoning",
    "yolo",
    "switch_model",
    "default_profile",
  ].includes(input.kind);
}
export function parseSessionOperation(
  object: Record<string, unknown>,
): SessionOperation {
  const kind = object.kind;
  const sessionId = requireId(object.sessionId, "sessionId", true);
  switch (kind) {
    case "compact":
    case "retire":
    case "undo":
    case "fork":
      return { kind, sessionId };
    case "reasoning":
      return {
        kind,
        sessionId,
        effort:
          object.effort === null ? null : requireText(object.effort, "effort", 100),
      };
    case "yolo":
      if (typeof object.enabled !== "boolean")
        throw new RemoteError(400, "INVALID_REQUEST", "enabled must be boolean.");
      return { kind, sessionId, enabled: object.enabled };
    case "switch_model":
    case "default_profile":
      return {
        kind,
        sessionId,
        profileName: requireText(object.profileName, "profileName", 240),
      };
    default:
      throw new RemoteError(400, "INVALID_REQUEST", "Unknown session operation.");
  }
}
