import OpenAI from "openai";
import type { AgentMessage, UserMessage } from "../agent/types";
import {
  IMAGE_INPUT_POLICY,
  imagePlanningTokens,
  providerImageDimensions,
} from "../image/image-input-policy";
import type { ImageAssetId, ImageAssetRef } from "../image/image-types";
import { materializeProviderImage, type ProviderImage } from "../image/provider-image";
import {
  ModelRequestMediaAggregateError,
  ProviderResponseError,
  type MaterializedModelRequest,
  type ModelMaterializeOptions,
  type ModelRequestInput,
  type PreparedMediaOccurrence,
  type PreparedModelRequest,
  type PreparedPromptSegment,
  type ProviderResponseErrorCode,
} from "./model-client";
import { parseImageAssetUrlMarker } from "./openai-image-mapping";
import { stableJsonStringify } from "./model-request-preflight";

export async function materializeOpenAIRequest(
  prepared: PreparedModelRequest,
  options: ModelMaterializeOptions,
): Promise<MaterializedModelRequest> {
  options.signal.throwIfAborted();
  if (prepared.mediaOccurrenceCount > IMAGE_INPUT_POLICY.maxImagesPerRequest) {
    throw new ModelRequestMediaAggregateError(
      `Model request has ${prepared.mediaOccurrenceCount} images; maximum is ${IMAGE_INPUT_POLICY.maxImagesPerRequest}.`,
    );
  }

  const assets = distinctPreparedAssets(prepared.promptSegments);
  const markerCount = countImageMarkers(prepared.payload);
  if (markerCount !== prepared.mediaOccurrenceCount) {
    throw new Error("Prepared image marker count does not match media descriptors.");
  }
  const dataUrls = new Map<ImageAssetId, string>();
  const providerImages = new Map<ImageAssetId, ProviderImage>();
  for (const asset of assets.values()) {
    options.signal.throwIfAborted();
    const bytes = await options.assetStore.readVerified(asset, {
      signal: options.signal,
    });
    const image = await materializeProviderImage(bytes, asset.mimeType);
    providerImages.set(asset.assetId, image);
    dataUrls.set(
      asset.assetId,
      `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
    );
    await yieldToEventLoop();
  }
  options.signal.throwIfAborted();
  const exactLengths = new Map(
    [...dataUrls].map(([assetId, value]) => [assetId, value.length] as const),
  );
  const bodyBytes = exactJsonBodyBytes(prepared.payload, exactLengths);
  assertOpenAIRequestBodyLimit(bodyBytes, prepared.mediaOccurrenceCount);
  const payload = deepFreeze(materializePayload(prepared.payload, dataUrls));
  return Object.freeze({
    ...prepared,
    payload,
    promptSegments: materializedPromptSegments(prepared.promptSegments, providerImages),
    bodyBytes,
  });
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

export function imageUserSegment(
  message: UserMessage,
  messageOrdinal: number,
): PreparedPromptSegment {
  const media = message.attachments!.map(
    (attachment, blockPosition): PreparedMediaOccurrence => {
      const dimensions = providerImageDimensions(attachment.width, attachment.height);
      return Object.freeze({
        asset: Object.freeze({
          assetId: attachment.assetId,
          mimeType: attachment.mimeType,
          byteLength: attachment.byteLength,
          width: attachment.width,
          height: attachment.height,
        }),
        source: "user_attachment",
        messageOrdinal,
        blockPosition,
        width: dimensions.width,
        height: dimensions.height,
        planningTokens: imagePlanningTokens(dimensions.width, dimensions.height),
      });
    },
  );
  return Object.freeze({
    kind: "user",
    normalizedText: message.content,
    media: Object.freeze(media),
  });
}

export function imageToolSegment(
  message: Extract<AgentMessage, { role: "tool" }>,
  messageOrdinal: number,
  normalizedText: string,
): PreparedPromptSegment {
  const media = message.content.flatMap((block, blockPosition) => {
    if (block.type !== "image") {
      return [];
    }
    const dimensions = providerImageDimensions(block.asset.width, block.asset.height);
    return [
      Object.freeze<PreparedMediaOccurrence>({
        asset: Object.freeze({ ...block.asset }),
        source: "tool_result",
        messageOrdinal,
        blockPosition,
        width: dimensions.width,
        height: dimensions.height,
        planningTokens: imagePlanningTokens(dimensions.width, dimensions.height),
      }),
    ];
  });
  return Object.freeze({
    kind: "tool",
    normalizedText,
    ...(media.length === 0 ? {} : { media: Object.freeze(media) }),
  });
}

export function normalizedEndpointPolicy(baseURL: string | undefined): string {
  const url = new URL(baseURL ?? "https://api.openai.com/v1");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.protocol}//${url.host}${pathname}`;
}

export function segmentKind(
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

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export function sanitizedProviderError(
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

function distinctPreparedAssets(
  segments: readonly PreparedPromptSegment[],
): Map<ImageAssetId, ImageAssetRef> {
  const assets = new Map<ImageAssetId, ImageAssetRef>();
  for (const segment of segments) {
    for (const media of segment.media ?? []) {
      const asset = media.asset;
      const existing = assets.get(asset.assetId);
      if (
        existing !== undefined &&
        stableJsonStringify(existing) !== stableJsonStringify(asset)
      ) {
        throw new Error(`Conflicting descriptors for image ${asset.assetId}.`);
      }
      assets.set(asset.assetId, asset);
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

export function assertOpenAIRequestBodyLimit(
  bodyBytes: number,
  imageCount: number,
): void {
  if (bodyBytes > IMAGE_INPUT_POLICY.maxRequestBodyBytes) {
    throw new ModelRequestMediaAggregateError(
      `Model request is ${bodyBytes} UTF-8 bytes with ${imageCount} images; maximum is ${IMAGE_INPUT_POLICY.maxRequestBodyBytes}.`,
    );
  }
}

function materializedPromptSegments(
  segments: readonly PreparedPromptSegment[],
  images: ReadonlyMap<ImageAssetId, ProviderImage>,
): readonly PreparedPromptSegment[] {
  return Object.freeze(
    segments.map((segment) =>
      segment.media === undefined
        ? segment
        : Object.freeze({
            ...segment,
            media: Object.freeze(
              segment.media.map((media) => {
                const image = images.get(media.asset.assetId);
                if (image === undefined) {
                  throw new Error(
                    `Image ${media.asset.assetId.slice(0, 12)}… was not materialized.`,
                  );
                }
                return Object.freeze({
                  ...media,
                  width: image.width,
                  height: image.height,
                  planningTokens: image.planningTokens,
                });
              }),
            ),
          }),
    ),
  );
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function providerErrorCode(error: unknown): ProviderResponseErrorCode {
  const status = providerErrorStatus(error);
  if (status === 429) {
    return "provider_rate_limited";
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return "provider_unavailable";
  }
  // Explicit HTTP failures take precedence over payload or transport hints.
  if (status !== undefined) return "provider_request_error";
  const code = errorField(error, "code");
  if (code === "server_error") return "provider_unavailable";
  if (code === "rate_limit_exceeded") return "provider_rate_limited";
  if (error instanceof OpenAI.APIConnectionError || isTransportFailure(error)) {
    return "provider_unavailable";
  }
  return "provider_request_error";
}

const TRANSIENT_TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function isTransportFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  // Fetch may wrap a socket error in TypeError.cause after headers arrive.
  for (let depth = 0; error !== undefined && depth < 8; depth += 1) {
    if (seen.has(error)) return false;
    seen.add(error);
    if (
      errorField(error, "name") === "AbortError" ||
      error instanceof OpenAI.APIUserAbortError ||
      providerErrorStatus(error) !== undefined
    ) {
      return false;
    }
    const code = errorField(error, "code");
    if (code !== undefined) {
      return typeof code === "string" && TRANSIENT_TRANSPORT_CODES.has(code);
    }
    error = errorField(error, "cause");
  }
  return false;
}

function errorField(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

function providerErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
