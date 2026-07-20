import type { MessageId, ProtocolFrameId, SessionId } from "../ids/runtime-id";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import type { ToolRawResult } from "../tools/types";
import type {
  AgentMessage,
  AssistantMessage,
  IterationIdentity,
  ToolCall,
  TurnIdentity,
} from "../agent/types";
import {
  canonicalUserMessageHash,
  validateUserMessage,
  type UserImageAttachment,
  type UserMessage,
} from "../image/image-types";

export const CURRENT_TOOL_OBSERVATION_FORMAT = "tool-observation-v3" as const;
export const SUPPORTED_TOOL_OBSERVATION_FORMATS = [
  "tool-observation-v2",
  CURRENT_TOOL_OBSERVATION_FORMAT,
] as const;
export type SupportedToolObservationFormat =
  (typeof SUPPORTED_TOOL_OBSERVATION_FORMATS)[number];

export type CanonicalMessageBase = {
  readonly messageId: MessageId;
  readonly sessionId: SessionId;
  readonly frameId: ProtocolFrameId;
  readonly ordinal: number;
  readonly contentSha256: string;
  readonly createdAt: string;
};

export type CanonicalMessageRecord =
  | (CanonicalMessageBase & {
      readonly role: "system";
      readonly content: string;
      readonly origin: "runtime";
    })
  | (CanonicalMessageBase & {
      readonly role: "user";
      readonly turnId: TurnIdentity["turnId"];
      readonly content: string;
      readonly attachments?: readonly UserImageAttachment[];
      readonly origin: "user";
    })
  | (CanonicalMessageBase & {
      readonly role: "assistant";
      readonly turnId: TurnIdentity["turnId"];
      readonly iterationId: IterationIdentity["iterationId"];
      readonly content: string | null;
      readonly reasoningContent?: string | null;
      readonly toolCalls?: readonly ToolCall[];
      readonly provider: string;
      readonly model: string;
      readonly origin: "model";
    })
  | (CanonicalMessageBase & {
      readonly role: "tool";
      readonly turnId: TurnIdentity["turnId"];
      readonly iterationId: IterationIdentity["iterationId"];
      readonly toolCallId: ToolCall["toolCallId"];
      readonly providerToolCallId: string;
      readonly name: string;
      readonly content: string;
      readonly origin: "tool" | "runtime";
    });

export type ProtocolFrame = {
  readonly frameId: ProtocolFrameId;
  readonly sessionId: SessionId;
  readonly turnId?: TurnIdentity["turnId"];
  readonly iterationId?: IterationIdentity["iterationId"];
  readonly kind: "system" | "user" | "assistant_text" | "tool_exchange";
  readonly state: "open" | "closed";
  readonly firstOrdinal: number;
  readonly lastOrdinal?: number;
  readonly createdAt: string;
  readonly closedAt?: string;
};

export type SyntheticToolCompletionReason =
  | "cancelled_active"
  | "skipped_after_cancel"
  | "failed_active"
  | "skipped_after_failure"
  | "interrupted_active"
  | "skipped_after_interruption";

export type ToolCompletion =
  | {
      readonly kind: "returned";
      readonly raw: ToolRawResult;
      readonly rawSha256: string;
      readonly observationFormat: SupportedToolObservationFormat;
    }
  | {
      readonly kind: "synthetic";
      readonly reason: SyntheticToolCompletionReason;
      readonly detail?: string;
    };

export type ToolResultRecord = {
  readonly sessionId: SessionId;
  readonly frameId: ProtocolFrameId;
  readonly toolCallId: ToolCall["toolCallId"];
  readonly toolMessageId: MessageId;
  readonly completion: ToolCompletion;
  readonly observationSha256: string;
  readonly createdAt: string;
};

export type ProtocolContextView = {
  readonly sessionId: SessionId;
  readonly faulted: boolean;
  readonly frames: readonly ProtocolFrame[];
  readonly messages: readonly CanonicalMessageRecord[];
  readonly toolResults: readonly ToolResultRecord[];
};

export type ReturnedToolCompletionInput = {
  readonly call: ToolCall;
  readonly kind: "returned";
  readonly raw: ToolRawResult;
  readonly observation: string;
};

export type SyntheticToolCompletionInput = {
  readonly call: ToolCall;
  readonly kind: "synthetic";
  readonly reason: SyntheticToolCompletionReason;
  readonly detail?: string;
};

export type ToolCompletionInput =
  | ReturnedToolCompletionInput
  | SyntheticToolCompletionInput;

export function contentHash(content: string | null): string {
  return sha256(stableJsonStringify({ content }));
}

export function userMessageHash(message: UserMessage): string {
  return canonicalUserMessageHash(message);
}

export function rawResultHash(raw: ToolRawResult): string {
  return sha256(stableJsonStringify(raw));
}

export function canonicalClone<T>(value: T): T {
  return JSON.parse(stableJsonStringify(value)) as T;
}

export function immutableCanonicalClone<T>(value: T): T {
  return deepFreeze(canonicalClone(value));
}

export function immutableRecord<T extends object>(value: T): Readonly<T> {
  return deepFreeze(value);
}

export function materializeAgentMessages(
  records: readonly CanonicalMessageRecord[],
): AgentMessage[] {
  return records.map((record): AgentMessage => {
    switch (record.role) {
      case "system":
        return { role: record.role, content: record.content };
      case "user": {
        const message: UserMessage = {
          role: "user",
          content: record.content,
          ...(record.attachments === undefined
            ? {}
            : { attachments: canonicalClone(record.attachments) }),
        };
        validateUserMessage(message);
        return message;
      }
      case "assistant": {
        const message: AssistantMessage = {
          role: "assistant",
          content: record.content,
          ...(record.reasoningContent === undefined
            ? {}
            : { reasoningContent: record.reasoningContent }),
          ...(record.toolCalls === undefined
            ? {}
            : { toolCalls: canonicalClone(record.toolCalls) }),
        };
        return message;
      }
      case "tool":
        return {
          role: "tool",
          toolCallId: record.toolCallId,
          providerToolCallId: record.providerToolCallId,
          name: record.name,
          content: record.content,
        };
    }
  });
}

export function renderSyntheticToolObservation(
  reason: SyntheticToolCompletionReason,
  detail?: string,
): string {
  switch (reason) {
    case "cancelled_active":
      return "Tool execution was cancelled by the user. Side effects may have partially completed; inspect current state before retrying.";
    case "skipped_after_cancel":
      return "Tool call was skipped because the user cancelled the turn.";
    case "failed_active":
      return `Tool execution failed: ${requireSyntheticDetail(detail)}. Side effects may have partially completed; inspect current state before retrying.`;
    case "skipped_after_failure":
      return "Tool call was skipped because an earlier tool call failed.";
    case "interrupted_active":
      return "Tinker was interrupted while this tool call may have been running. Its side-effect state is unknown; inspect current state before retrying.";
    case "skipped_after_interruption":
      return "Tool call was skipped because Tinker was interrupted before it could run.";
  }
}

export function normalizeSyntheticDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.trim();
  if (normalized === "") {
    return "Unknown error";
  }
  return normalized.slice(0, 2_000);
}

export function interruptedCompletionInputs(
  calls: readonly ToolCall[],
): readonly SyntheticToolCompletionInput[] {
  return calls.map((call, index) => ({
    call,
    kind: "synthetic",
    reason: index === 0 ? "interrupted_active" : "skipped_after_interruption",
  }));
}

export function observationForCompletion(input: ToolCompletionInput): string {
  return input.kind === "returned"
    ? input.observation
    : renderSyntheticToolObservation(input.reason, input.detail);
}

function requireSyntheticDetail(detail: string | undefined): string {
  if (detail === undefined || detail.trim() === "") {
    throw new Error("failed_active synthetic completion requires error detail.");
  }
  return detail;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
