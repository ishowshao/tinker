import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { AssistantMessage, UserMessage } from "../agent/types";
import {
  IMAGE_INPUT_POLICY,
  IMAGE_INPUT_POLICY_VERSION,
} from "../image/image-input-policy";
import type { ImageAssetId, ImageAssetRef } from "../image/image-types";
import type { ModelContextBudget } from "./model-context-profile";
import type { InputTokenEstimator } from "./input-token-estimator";
import {
  ModelRequestMediaAggregateError,
  ProviderResponseError,
  type ProviderResponseErrorCode,
} from "./model-client";
import type {
  MaterializedModelRequest,
  ModelClient,
  ModelMaterializeOptions,
  ModelMessageProtocol,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedMediaDescriptor,
  PreparedModelRequest,
  PreparedPromptSegment,
} from "./model-client";
import {
  fromOpenAIChatCompletion,
  parseImageAssetUrlMarker,
  toOpenAIChatMessages,
  toOpenAIChatTools,
} from "./openai-chat-mapping";
import { accumulateOpenAIChatCompletionChunks } from "./openai-chat-stream";
import { MoonshotInputTokenEstimator } from "./moonshot-input-token-estimator";
import { sha256, stableJsonStringify } from "./model-request-preflight";

const OPENAI_CHAT_SERIALIZATION_VERSION = "openai-chat-v2";
const OPENAI_CHAT_TIMEOUT_MS = 30 * 60 * 1_000;

export class OpenAIChatModelClient implements ModelClient {
  readonly messageProtocol: ModelMessageProtocol = Object.freeze({
    adapter: "openai-chat",
    serializationVersion: OPENAI_CHAT_SERIALIZATION_VERSION,
  });
  readonly inputTokenEstimator?: InputTokenEstimator;
  private readonly client: OpenAI;
  private readonly preparedRequests = new WeakSet<object>();
  private readonly materializedRequests = new WeakSet<object>();
  private readonly provider: string;
  private readonly stream: boolean;
  readonly inputModalities: readonly ("text" | "image")[];

  constructor(
    private readonly options: {
      apiKey: string;
      contextBudget: ModelContextBudget;
      baseURL?: string;
      includeReasoningContent?: boolean;
      inputModalities?: readonly ("text" | "image")[];
      tokenEstimator?: {
        kind: "moonshot-estimate-token-count-v1";
        model: string;
        apiBase: string;
        apiKey: string;
        timeoutMs: number;
        maxRetries: 0;
      };
      model: string;
      providerName?: string;
      stream?: boolean;
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {
    this.provider = options.providerName ?? "openai-compatible";
    this.stream = options.stream ?? true;
    this.inputModalities = Object.freeze([...(options.inputModalities ?? ["text"])]);
    const supportsImages = this.inputModalities.includes("image");
    if (!this.inputModalities.includes("text")) {
      throw new Error('OpenAI chat input modalities must include "text".');
    }
    if (supportsImages && options.tokenEstimator === undefined) {
      throw new Error("Image-capable OpenAI chat requires a token estimator.");
    }
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? OPENAI_CHAT_TIMEOUT_MS,
      // Retries are orchestrated by the agent loop so they surface as
      // cancellable, observable runtime events instead of hidden SDK waits.
      maxRetries: 0,
      fetch: options.fetch,
    });
    if (options.tokenEstimator !== undefined) {
      this.inputTokenEstimator = new MoonshotInputTokenEstimator({
        apiKey: options.tokenEstimator.apiKey,
        baseURL: options.tokenEstimator.apiBase,
        model: options.tokenEstimator.model,
        timeoutMs: options.tokenEstimator.timeoutMs,
        fetch: options.fetch,
      });
    }
  }

  prepare(input: ModelRequestInput): PreparedModelRequest {
    const messages = toOpenAIChatMessages(input.messages, {
      includeReasoningContent: this.options.includeReasoningContent,
    });
    const tools = input.tools.length > 0 ? toOpenAIChatTools(input.tools) : undefined;
    const payload = deepFreeze({
      model: this.options.model,
      messages,
      ...(tools === undefined ? {} : { tools, tool_choice: "auto" as const }),
      max_completion_tokens: this.options.contextBudget.requestMaxOutputTokens,
      ...(this.stream
        ? {
            stream: true as const,
            stream_options: { include_usage: true as const },
          }
        : {}),
    });
    const toolSegments = (tools ?? []).map(
      (tool): PreparedPromptSegment => ({
        kind: "tool_schema",
        normalizedText: stableJsonStringify(tool),
      }),
    );
    const messageSegments = input.messages.map(
      (message, index): PreparedPromptSegment =>
        message.role === "user" && message.attachments !== undefined
          ? imageUserSegment(message)
          : {
              kind: segmentKind(message.role),
              normalizedText: stableJsonStringify(messages[index]),
            },
    );
    const mediaOccurrenceCount = messageSegments.reduce(
      (total, segment) => total + (segment.media?.length ?? 0),
      0,
    );
    const requestConfigHash = sha256(
      stableJsonStringify({
        adapter: this.messageProtocol.adapter,
        serializationVersion: this.messageProtocol.serializationVersion,
        endpoint: normalizedEndpointPolicy(this.options.baseURL),
        model: this.options.model,
        requestMaxOutputTokens: this.options.contextBudget.requestMaxOutputTokens,
        includeReasoningContent: this.options.includeReasoningContent === true,
        stream: this.stream,
        inputModalities: this.inputModalities,
        requestPolicy: { toolChoice: "auto" },
        imagePolicy: {
          version: IMAGE_INPUT_POLICY_VERSION,
          ...IMAGE_INPUT_POLICY,
        },
        ...(this.inputTokenEstimator === undefined
          ? {}
          : { tokenEstimator: this.inputTokenEstimator.compatibility }),
      }),
    );
    const prepared: PreparedModelRequest = {
      provider: this.provider,
      model: this.options.model,
      payload,
      promptSegments: Object.freeze([...toolSegments, ...messageSegments]),
      requestConfigHash,
      toolSchemaHash: sha256(
        toolSegments.map((segment) => segment.normalizedText).join("\n"),
      ),
      requestMaxOutputTokens: this.options.contextBudget.requestMaxOutputTokens,
      mediaOccurrenceCount,
      assistantReplaySegments: (message) => this.assistantReplaySegments(message),
    };
    Object.freeze(prepared);
    this.preparedRequests.add(prepared);
    return prepared;
  }

  async materialize(
    prepared: PreparedModelRequest,
    options: ModelMaterializeOptions,
  ): Promise<MaterializedModelRequest> {
    this.assertPrepared(prepared);
    options.signal.throwIfAborted();
    if (prepared.mediaOccurrenceCount > IMAGE_INPUT_POLICY.maxImagesPerRequest) {
      throw new ModelRequestMediaAggregateError(
        `Model request has ${prepared.mediaOccurrenceCount} images; maximum is ${IMAGE_INPUT_POLICY.maxImagesPerRequest}.`,
      );
    }
    if (prepared.mediaOccurrenceCount > 0 && !this.inputModalities.includes("image")) {
      throw new Error("Current model profile does not support image input.");
    }

    const assets = distinctPreparedAssets(prepared.promptSegments);
    const lowerLengths = new Map<ImageAssetId, number>();
    for (const asset of assets.values()) {
      lowerLengths.set(asset.assetId, dataUrlLength(asset));
    }
    const markerCount = countImageMarkers(prepared.payload);
    if (markerCount !== prepared.mediaOccurrenceCount) {
      throw new Error("Prepared image marker count does not match media descriptors.");
    }
    const lowerBodyBytes = exactJsonBodyBytes(prepared.payload, lowerLengths);
    assertBodyLimit(lowerBodyBytes, prepared.mediaOccurrenceCount);

    const dataUrls = new Map<ImageAssetId, string>();
    for (const asset of assets.values()) {
      options.signal.throwIfAborted();
      const bytes = await options.assetStore.readVerified(asset, {
        signal: options.signal,
      });
      dataUrls.set(
        asset.assetId,
        `data:${asset.mimeType};base64,${bytes.toString("base64")}`,
      );
      await yieldToEventLoop();
    }
    options.signal.throwIfAborted();
    const exactLengths = new Map(
      [...dataUrls].map(([assetId, value]) => [assetId, value.length] as const),
    );
    const bodyBytes = exactJsonBodyBytes(prepared.payload, exactLengths);
    assertBodyLimit(bodyBytes, prepared.mediaOccurrenceCount);
    const payload = deepFreeze(materializePayload(prepared.payload, dataUrls));
    const materialized = Object.freeze({ ...prepared, payload, bodyBytes });
    this.materializedRequests.add(materialized);
    return materialized;
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.assertPrepared(prepared);
    if (prepared.mediaOccurrenceCount > 0 && !this.materializedRequests.has(prepared)) {
      throw new Error("Image request must be materialized before provider dispatch.");
    }

    const response = this.stream
      ? accumulateOpenAIChatCompletionChunks(
          await this.collectStreamingChunks(prepared, options.signal),
          { provider: this.provider, model: this.options.model },
        )
      : await this.requestNonStreaming(prepared, options.signal);

    return fromOpenAIChatCompletion(response, {
      identity: options.identity,
      provider: this.provider,
      model: this.options.model,
    });
  }

  private async collectStreamingChunks(
    prepared: PreparedModelRequest,
    signal: AbortSignal,
  ): Promise<unknown[]> {
    try {
      const stream = await this.client.chat.completions.create(
        prepared.payload as ChatCompletionCreateParamsStreaming,
        { signal },
      );
      const chunks: unknown[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      return chunks;
    } catch (error) {
      throw sanitizedProviderError(error, this.provider, this.options.model);
    }
  }

  private async requestNonStreaming(
    prepared: PreparedModelRequest,
    signal: AbortSignal,
  ) {
    try {
      return await this.client.chat.completions.create(
        prepared.payload as ChatCompletionCreateParamsNonStreaming,
        { signal },
      );
    } catch (error) {
      throw sanitizedProviderError(error, this.provider, this.options.model);
    }
  }

  private assistantReplaySegments(message: AssistantMessage): PreparedPromptSegment[] {
    const [mapped] = toOpenAIChatMessages([message], {
      includeReasoningContent: this.options.includeReasoningContent,
    });
    if (mapped === undefined) {
      throw new Error("OpenAI assistant replay mapping produced no message.");
    }
    return [
      {
        kind: "assistant",
        normalizedText: stableJsonStringify(mapped),
      },
    ];
  }

  private assertPrepared(prepared: PreparedModelRequest): void {
    if (
      !this.preparedRequests.has(prepared) &&
      !this.materializedRequests.has(prepared)
    ) {
      throw new Error(
        `OpenAI chat request was not prepared by this client (provider=${this.provider}, model=${this.options.model}).`,
      );
    }
    if (
      prepared.provider !== this.provider ||
      prepared.model !== this.options.model ||
      prepared.requestMaxOutputTokens !==
        this.options.contextBudget.requestMaxOutputTokens
    ) {
      throw new Error(
        "Prepared OpenAI chat request configuration does not match client.",
      );
    }
  }
}

export function exactJsonBodyBytes(
  value: unknown,
  imageDataUrlLengths: ReadonlyMap<ImageAssetId, number>,
): number {
  const assetId = parseImageAssetUrlMarker(value);
  if (assetId !== undefined) {
    const length = imageDataUrlLengths.get(assetId);
    if (!Number.isSafeInteger(length) || length === undefined || length < 1) {
      throw new Error(
        `Missing materialized length for image ${assetId.slice(0, 12)}….`,
      );
    }
    return length + 2;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const serialized: unknown = JSON.stringify(value);
    if (typeof serialized !== "string") {
      throw new Error("JSON primitive did not serialize to a string.");
    }
    return Buffer.byteLength(serialized, "utf8");
  }
  if (Array.isArray(value)) {
    const entries: readonly unknown[] = value;
    return (
      2 +
      Math.max(0, entries.length - 1) +
      entries.reduce<number>(
        (total, entry) => total + exactJsonBodyBytes(entry, imageDataUrlLengths),
        0,
      )
    );
  }
  if (typeof value !== "object" || value === undefined) {
    throw new Error(`Cannot size non-JSON value of type ${typeof value}.`);
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, entry]) => entry !== undefined,
  );
  return (
    2 +
    Math.max(0, entries.length - 1) +
    entries.reduce(
      (total, [key, entry]) =>
        total +
        Buffer.byteLength(JSON.stringify(key), "utf8") +
        1 +
        exactJsonBodyBytes(entry, imageDataUrlLengths),
      0,
    )
  );
}

function imageUserSegment(message: UserMessage): PreparedPromptSegment {
  const media = message.attachments!.map(
    (attachment): PreparedMediaDescriptor =>
      Object.freeze({
        assetId: attachment.assetId,
        label: attachment.label,
        range: Object.freeze({ ...attachment.range }),
        mimeType: attachment.mimeType,
        byteLength: attachment.byteLength,
        width: attachment.width,
        height: attachment.height,
        planningTokens: IMAGE_INPUT_POLICY.planningTokensPerImage,
      }),
  );
  return Object.freeze({
    kind: "user",
    normalizedText: message.content,
    media: Object.freeze(media),
  });
}

function distinctPreparedAssets(
  segments: readonly PreparedPromptSegment[],
): Map<ImageAssetId, ImageAssetRef> {
  const assets = new Map<ImageAssetId, ImageAssetRef>();
  for (const segment of segments) {
    for (const media of segment.media ?? []) {
      const asset = Object.freeze({
        assetId: media.assetId,
        mimeType: media.mimeType,
        byteLength: media.byteLength,
        width: media.width,
        height: media.height,
      });
      const existing = assets.get(media.assetId);
      if (
        existing !== undefined &&
        stableJsonStringify(existing) !== stableJsonStringify(asset)
      ) {
        throw new Error(`Conflicting descriptors for image ${media.assetId}.`);
      }
      assets.set(media.assetId, asset);
    }
  }
  return assets;
}

function materializePayload(
  value: unknown,
  dataUrls: ReadonlyMap<ImageAssetId, string>,
): unknown {
  const assetId = parseImageAssetUrlMarker(value);
  if (assetId !== undefined) {
    const dataUrl = dataUrls.get(assetId);
    if (dataUrl === undefined) {
      throw new Error(`Image ${assetId.slice(0, 12)}… was not materialized.`);
    }
    return dataUrl;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materializePayload(entry, dataUrls));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, materializePayload(entry, dataUrls)]),
    );
  }
  return value;
}

function countImageMarkers(value: unknown): number {
  if (parseImageAssetUrlMarker(value) !== undefined) {
    return 1;
  }
  if (Array.isArray(value)) {
    const entries: readonly unknown[] = value;
    return entries.reduce<number>(
      (total, entry) => total + countImageMarkers(entry),
      0,
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (total, entry) => total + countImageMarkers(entry),
      0,
    );
  }
  return 0;
}

function dataUrlLength(asset: ImageAssetRef): number {
  return `data:${asset.mimeType};base64,`.length + 4 * Math.ceil(asset.byteLength / 3);
}

function assertBodyLimit(bodyBytes: number, imageCount: number): void {
  if (bodyBytes > IMAGE_INPUT_POLICY.maxRequestBodyBytes) {
    throw new ModelRequestMediaAggregateError(
      `Model request is ${bodyBytes} UTF-8 bytes with ${imageCount} images; maximum is ${IMAGE_INPUT_POLICY.maxRequestBodyBytes}.`,
    );
  }
}

function normalizedEndpointPolicy(baseURL: string | undefined): string {
  const url = new URL(baseURL ?? "https://api.openai.com/v1");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.protocol}//${url.host}${pathname}`;
}

function segmentKind(
  role: ModelRequestInput["messages"][number]["role"],
): PreparedPromptSegment["kind"] {
  switch (role) {
    case "system":
      return "kernel";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

function sanitizedProviderError(
  error: unknown,
  provider: string,
  model: string,
): ProviderResponseError {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = message
    .replace(
      /data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+/gu,
      "[redacted image data]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [redacted]");
  return new ProviderResponseError(
    providerErrorCode(error),
    sanitized,
    { provider, model },
    { cause: error },
  );
}

function providerErrorCode(error: unknown): ProviderResponseErrorCode {
  const status = providerErrorStatus(error);
  if (status === 429) {
    return "provider_rate_limited";
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return "provider_unavailable";
  }
  if (status === undefined && isProviderConnectionError(error)) {
    return "provider_unavailable";
  }
  return "provider_request_error";
}

function providerErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function isProviderConnectionError(error: unknown): boolean {
  // APIConnectionTimeoutError extends APIConnectionError in the SDK.
  return error instanceof OpenAI.APIConnectionError;
}
