import type { AgentMessage, AssistantMessage, IterationIdentity } from "../agent/types";
import type { RuntimeSessionContext } from "../agent/runtime-session";
import type { ToolDefinition } from "../tools/types";
import type { ImageAssetStore } from "../image/image-asset-store";
import type { CodePointRange, ImageAssetId, ImageMimeType } from "../image/image-types";
import type { InputTokenEstimator } from "./input-token-estimator";

export interface ModelClient {
  readonly messageProtocol: ModelMessageProtocol;
  readonly inputTokenEstimator?: InputTokenEstimator;
  readonly inputModalities?: readonly ("text" | "image")[];
  prepare(input: ModelRequestInput): PreparedModelRequest;
  materialize?(
    prepared: PreparedModelRequest,
    options: ModelMaterializeOptions,
  ): Promise<MaterializedModelRequest>;
  request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput>;
}

export class ModelRequestMediaAggregateError extends Error {
  readonly code = "MODEL_REQUEST_MEDIA_AGGREGATE_LIMIT";

  constructor(message: string) {
    super(message);
    this.name = "ModelRequestMediaAggregateError";
  }
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
  media?: readonly PreparedMediaDescriptor[];
};

export type PreparedMediaDescriptor = {
  assetId: ImageAssetId;
  label: string;
  range: CodePointRange;
  mimeType: ImageMimeType;
  byteLength: number;
  width: number;
  height: number;
  planningTokens: number;
};

export type PreparedModelRequest = {
  provider: string;
  model: string;
  payload: unknown;
  promptSegments: readonly PreparedPromptSegment[];
  requestConfigHash: string;
  toolSchemaHash: string;
  requestMaxOutputTokens: number;
  mediaOccurrenceCount: number;
  assistantReplaySegments(message: AssistantMessage): PreparedPromptSegment[];
};

export type ModelMaterializeOptions = {
  assetStore: ImageAssetStore;
  signal: AbortSignal;
};

export type MaterializedModelRequest = PreparedModelRequest & {
  readonly bodyBytes: number;
};

export async function materializeModelRequest(
  model: ModelClient,
  prepared: PreparedModelRequest,
  options: ModelMaterializeOptions,
): Promise<MaterializedModelRequest> {
  if (model.materialize !== undefined) {
    return model.materialize(prepared, options);
  }
  if (prepared.mediaOccurrenceCount !== 0) {
    throw new Error("Model client does not implement image request materialization.");
  }
  return prepared as MaterializedModelRequest;
}

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
