import type { AgentMessage, AssistantMessage, IterationIdentity } from "../agent/types";
import type { RuntimeSessionContext } from "../agent/runtime-session";
import type { ToolDefinition } from "../tools/types";
import type { ImageAssetStore } from "../image/image-asset-store";
import type { ImageAssetRef } from "../image/image-types";
import type { ReasoningEffortController } from "./reasoning-effort";

export interface ModelClient {
  readonly messageProtocol: ModelMessageProtocol;
  readonly inputModalities: readonly ModelInputModality[];
  readonly toolResultModalities: readonly ToolResultModality[];
  readonly reasoningEffort?: ReasoningEffortController;
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

export type ModelInputModality = "text" | "image";
export type ToolResultModality = "text" | "image";

export function validateModelModalities(input: {
  readonly profileName?: string;
  readonly adapter: ModelMessageProtocol["adapter"];
  readonly inputModalities: readonly ModelInputModality[];
  readonly toolResultModalities: readonly ToolResultModality[];
  readonly adapterToolResultModalities: readonly ToolResultModality[];
}): {
  readonly inputModalities: readonly ModelInputModality[];
  readonly toolResultModalities: readonly ToolResultModality[];
} {
  const inputModalities = normalizeModalities(input.inputModalities, "model input");
  const toolResultModalities = normalizeModalities(
    input.toolResultModalities,
    "tool result",
  );
  if (toolResultModalities.includes("image") && !inputModalities.includes("image")) {
    throw new Error(
      'Image tool results require "image" in the model input modalities.',
    );
  }
  const unsupported = toolResultModalities.find(
    (modality) => !input.adapterToolResultModalities.includes(modality),
  );
  if (unsupported !== undefined) {
    const subject =
      input.profileName === undefined
        ? "Model configuration"
        : `Profile ${JSON.stringify(input.profileName)}`;
    throw new Error(
      `${subject} declares ${unsupported} tool results, but adapter ${JSON.stringify(input.adapter)} does not support them.`,
    );
  }
  return Object.freeze({ inputModalities, toolResultModalities });
}

function normalizeModalities(
  modalities: readonly (ModelInputModality | ToolResultModality)[],
  label: string,
): readonly ("text" | "image")[] {
  if (
    modalities.length === 0 ||
    modalities.some((modality) => modality !== "text" && modality !== "image") ||
    new Set(modalities).size !== modalities.length ||
    !modalities.includes("text")
  ) {
    throw new Error(`${label} modalities must be unique and include "text".`);
  }
  return Object.freeze(modalities.includes("image") ? ["text", "image"] : ["text"]);
}

export class ModelRequestMediaAggregateError extends Error {
  readonly code = "MODEL_REQUEST_MEDIA_AGGREGATE_LIMIT";

  constructor(message: string) {
    super(message);
    this.name = "ModelRequestMediaAggregateError";
  }
}

export const MODEL_MESSAGE_PROTOCOL_ADAPTERS = [
  "openai-chat",
  "openai-responses",
  "fake",
] as const;

export type ModelMessageProtocol = {
  adapter: (typeof MODEL_MESSAGE_PROTOCOL_ADAPTERS)[number];
  serializationVersion: string;
};

export type ModelRequestOptions = {
  signal: AbortSignal;
  onTextDelta?: (content: string) => void;
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
  media?: readonly PreparedMediaOccurrence[];
};

export type PreparedMediaOccurrence = {
  readonly asset: ImageAssetRef;
  readonly source: "user_attachment" | "tool_result";
  readonly messageOrdinal: number;
  readonly blockPosition: number;
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

export type ProviderResponseErrorCode =
  | "reasoning_only_assistant"
  | "invalid_provider_response"
  | "invalid_provider_stream"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_request_error";

export type ProviderResponseDiagnostics = {
  provider: string;
  model: string;
  path?: string;
  finishReason?: string;
  contentChars?: number;
  reasoningChars?: number;
  toolCallCount?: number;
  usage?: ModelUsage;
};

export class ProviderResponseError extends Error {
  constructor(
    readonly code: ProviderResponseErrorCode,
    message: string,
    readonly diagnostics: ProviderResponseDiagnostics,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderResponseError";
  }
}
