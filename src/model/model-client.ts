import type { AgentMessage, AssistantMessage, IterationIdentity } from "../agent/types";
import type { RuntimeSessionContext } from "../agent/runtime-session";
import type { ToolDefinition } from "../tools/types";

export interface ModelClient {
  readonly messageProtocol: ModelMessageProtocol;
  prepare(input: ModelRequestInput): PreparedModelRequest;
  request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput>;
}

export type ModelMessageProtocol = {
  adapter: "openai-chat" | "fake";
  serializationVersion: string;
};

export type ModelRequestOptions = {
  signal: AbortSignal;
  identity?: {
    iteration: IterationIdentity;
    runtimeSession: RuntimeSessionContext;
  };
};

export type ModelRequestInput = {
  messages: AgentMessage[];
  tools: ToolDefinition[];
};

export type PreparedPromptSegmentKind =
  | "kernel"
  | "user"
  | "assistant"
  | "tool"
  | "tool_schema"
  | "protocol";

export type PreparedPromptSegment = {
  kind: PreparedPromptSegmentKind;
  normalizedText: string;
};

export type PreparedModelRequest = {
  provider: string;
  model: string;
  payload: unknown;
  promptSegments: readonly PreparedPromptSegment[];
  requestConfigHash: string;
  toolSchemaHash: string;
  requestMaxOutputTokens: number;
  assistantReplaySegments(message: AssistantMessage): PreparedPromptSegment[];
};

export type ModelRequestOutput = {
  message: AssistantMessage;
  finishReason?: string;
  usage: ModelUsage;
  rawResponse?: unknown;
};

export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  reasoningTokens?: number;
};
