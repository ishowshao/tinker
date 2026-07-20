import { createHash } from "node:crypto";
import { isCanonicalUuidV7 } from "../ids/uuid-v7";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import { IMAGE_INPUT_POLICY } from "./image-input-policy";

export type ImageMimeType = (typeof IMAGE_INPUT_POLICY.allowedMimeTypes)[number];

export type ImageAttachmentId = string & {
  readonly __imageAttachmentId: "image-attachment";
};

export type ImageAssetId = string & {
  readonly __imageAssetId: "image-asset";
};

export type CodePointRange = {
  readonly start: number;
  readonly end: number;
};

export type ImageAssetRef = {
  readonly assetId: ImageAssetId;
  readonly mimeType: ImageMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
};

export type UserImageAttachment = ImageAssetRef & {
  readonly attachmentId: ImageAttachmentId;
  readonly label: string;
  readonly range: CodePointRange;
  readonly originalName: string;
};

export type UserMessage = {
  readonly role: "user";
  readonly content: string;
  readonly attachments?: readonly UserImageAttachment[];
};

export function imageAssetIdForBytes(bytes: Uint8Array): ImageAssetId {
  return createHash("sha256").update(bytes).digest("hex") as ImageAssetId;
}

export function parseImageAssetId(value: string): ImageAssetId {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Invalid image asset ID: ${JSON.stringify(value)}.`);
  }
  return value as ImageAssetId;
}

export function parseImageAttachmentId(value: string): ImageAttachmentId {
  if (!isCanonicalUuidV7(value)) {
    throw new Error(`Invalid image attachment ID: ${JSON.stringify(value)}.`);
  }
  return value as ImageAttachmentId;
}

export function normalizeOriginalImageName(value: string): string {
  const normalized = value.normalize("NFC");
  validateOriginalImageName(normalized);
  return normalized;
}

export function validateOriginalImageName(value: string): void {
  if (
    value === "" ||
    value !== value.normalize("NFC") ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    hasControlCharacter(value) ||
    Buffer.byteLength(value, "utf8") > 255
  ) {
    throw new Error(`Invalid image original name: ${JSON.stringify(value)}.`);
  }
}

export function validateImageAssetRef(asset: ImageAssetRef): void {
  parseImageAssetId(asset.assetId);
  if (!IMAGE_INPUT_POLICY.allowedMimeTypes.includes(asset.mimeType)) {
    throw new Error(`Unsupported image MIME type: ${JSON.stringify(asset.mimeType)}.`);
  }
  requirePositiveSafeInteger(asset.byteLength, "image byteLength");
  requirePositiveSafeInteger(asset.width, "image width");
  requirePositiveSafeInteger(asset.height, "image height");
  if (asset.byteLength > IMAGE_INPUT_POLICY.maxBytesPerImage) {
    throw new Error(
      `Image byte length ${asset.byteLength} exceeds ${IMAGE_INPUT_POLICY.maxBytesPerImage}.`,
    );
  }
  if (
    asset.width > IMAGE_INPUT_POLICY.maxLongEdge ||
    asset.height > IMAGE_INPUT_POLICY.maxLongEdge
  ) {
    throw new Error(
      `Image dimensions ${asset.width}x${asset.height} exceed ${IMAGE_INPUT_POLICY.maxLongEdge}px.`,
    );
  }
  const pixels = asset.width * asset.height;
  if (!Number.isSafeInteger(pixels) || pixels > IMAGE_INPUT_POLICY.maxPixels) {
    throw new Error(
      `Image pixel count ${pixels} exceeds ${IMAGE_INPUT_POLICY.maxPixels}.`,
    );
  }
}

export function validateUserMessage(message: UserMessage): void {
  if (message.role !== "user" || typeof message.content !== "string") {
    throw new Error("Invalid canonical user message.");
  }
  const attachments = message.attachments;
  if (attachments !== undefined && attachments.length === 0) {
    throw new Error("Canonical user message attachments must be omitted when empty.");
  }
  if (attachments === undefined) {
    if (message.content.trim() === "") {
      throw new Error("Canonical user message must not be empty.");
    }
    return;
  }
  if (attachments.length > IMAGE_INPUT_POLICY.maxImagesPerMessage) {
    throw new Error(
      `User message has ${attachments.length} images; maximum is ${IMAGE_INPUT_POLICY.maxImagesPerMessage}.`,
    );
  }
  if (message.content.trim() === "" && attachments.length === 0) {
    throw new Error("Canonical user message must contain text or an image.");
  }

  const chars = [...message.content];
  const attachmentIds = new Set<string>();
  const labels = new Set<string>();
  let previousEnd = -1;
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    parseImageAttachmentId(attachment.attachmentId);
    validateImageAssetRef(attachment);
    validateOriginalImageName(attachment.originalName);
    const expectedLabel = imageLabel(index + 1);
    if (attachment.label !== expectedLabel) {
      throw new Error(
        `Image attachment label must be ${expectedLabel}; received ${attachment.label}.`,
      );
    }
    validateCodePointRange(attachment.range, chars.length);
    if (attachment.range.start < previousEnd) {
      throw new Error("Image attachment ranges must be ordered and non-overlapping.");
    }
    const selected = chars.slice(attachment.range.start, attachment.range.end).join("");
    if (selected !== attachment.label) {
      throw new Error("Image attachment range does not match its label.");
    }
    if (attachmentIds.has(attachment.attachmentId)) {
      throw new Error("Image attachment IDs must be unique within a message.");
    }
    if (labels.has(attachment.label)) {
      throw new Error("Image attachment labels must be unique within a message.");
    }
    attachmentIds.add(attachment.attachmentId);
    labels.add(attachment.label);
    previousEnd = attachment.range.end;
  }

  assertNoUnboundImageLabels(message.content, attachments);
}

export function canonicalUserMessageHash(message: UserMessage): string {
  validateUserMessage(message);
  return sha256(
    stableJsonStringify({
      content: message.content,
      ...(message.attachments === undefined
        ? {}
        : {
            attachments: message.attachments.map((attachment) => ({
              attachmentId: attachment.attachmentId,
              assetId: attachment.assetId,
              label: attachment.label,
              range: attachment.range,
              mimeType: attachment.mimeType,
              byteLength: attachment.byteLength,
              width: attachment.width,
              height: attachment.height,
              originalName: attachment.originalName,
            })),
          }),
    }),
  );
}

export function imageLabel(index: number): string {
  if (
    !Number.isSafeInteger(index) ||
    index < 1 ||
    index > IMAGE_INPUT_POLICY.maxImagesPerMessage
  ) {
    throw new Error(`Image label index is outside the MVP range: ${index}.`);
  }
  return `[Image #${index}]`;
}

export function codePointSlice(value: string, range: CodePointRange): string {
  const chars = [...value];
  validateCodePointRange(range, chars.length);
  return chars.slice(range.start, range.end).join("");
}

function validateCodePointRange(range: CodePointRange, length: number): void {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end <= range.start ||
    range.end > length
  ) {
    throw new Error(
      `Invalid image code-point range [${range.start}, ${range.end}) for length ${length}.`,
    );
  }
}

function assertNoUnboundImageLabels(
  content: string,
  attachments: readonly UserImageAttachment[],
): void {
  const chars = [...content];
  for (const attachment of attachments) {
    const label = [...attachment.label];
    for (let start = 0; start <= chars.length - label.length; start += 1) {
      if (!label.every((char, offset) => chars[start + offset] === char)) {
        continue;
      }
      if (
        start !== attachment.range.start ||
        start + label.length !== attachment.range.end
      ) {
        throw new Error(
          `Prompt contains an unbound literal ${attachment.label}; rewrite it before submitting.`,
        );
      }
    }
  }
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}
