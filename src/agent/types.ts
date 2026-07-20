import type { IterationId, SessionId, ToolCallId, TurnId } from "../ids/runtime-id";
import type { UserMessage } from "../image/image-types";

export type {
  CodePointRange,
  ImageAssetId,
  ImageAssetRef,
  ImageAttachmentId,
  ImageMimeType,
  UserImageAttachment,
  UserMessage,
} from "../image/image-types";

export type SessionIdentity = {
  sessionId: SessionId;
};

export type TurnIdentity = SessionIdentity & {
  turnId: TurnId;
  turnNumber: number;
};

export type IterationIdentity = TurnIdentity & {
  iterationId: IterationId;
  iterationNumber: number;
};

export type ToolCallIdentity = IterationIdentity & {
  toolCallId: ToolCallId;
  toolCallNumber: number;
};

export type ToolCall = ToolCallIdentity & {
  providerToolCallId: string;
  name: string;
  args: unknown;
  rawArgs?: string;
  argsParseError?: string;
};

export type AssistantMessage = {
  role: "assistant";
  content?: string | null;
  reasoningContent?: string | null;
  toolCalls?: readonly ToolCall[];
};

export type ToolMessage = {
  role: "tool";
  toolCallId: ToolCallId;
  providerToolCallId: string;
  name: string;
  content: string;
};

export type AgentMessage =
  | { role: "system"; content: string }
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export type TurnCancellation = {
  source: TurnCancellationSource;
  phase: "model_request" | "tool_execution" | "agent_boundary";
  iterationId: IterationId;
  iterationNumber: number;
  toolCallId?: ToolCallId;
  toolName?: string;
};

export type TurnCancellationSource = "user" | "session_dispose";

export type RunAgentResult =
  | {
      status: "completed";
      finalText: string;
      lastIteration: IterationIdentity;
    }
  | {
      status: "failed";
      error: string;
      lastIteration: IterationIdentity;
    }
  | {
      status: "cancelled";
      cancellation: TurnCancellation;
      lastIteration: IterationIdentity;
    };
