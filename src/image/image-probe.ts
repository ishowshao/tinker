import sharp from "sharp";
import { IMAGE_INPUT_POLICY } from "./image-input-policy";
import {
  imageAssetIdForBytes,
  type ImageAssetRef,
  type ImageMimeType,
} from "./image-types";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ImageProbeOptions = {
  fullDecode?: boolean;
  sourceName?: string;
};

export class ImageNotRecognizedError extends Error {
  readonly code = "IMAGE_NOT_RECOGNIZED" as const;
}

export class UnsupportedImageFormatError extends Error {
  readonly code = "IMAGE_FORMAT_UNSUPPORTED" as const;
}

export async function probeImageBytes(
  bytes: Buffer,
  options: ImageProbeOptions = {},
): Promise<ImageAssetRef> {
  if (bytes.length < 1) {
    throw new Error("Image file is empty.");
  }
  if (bytes.length > IMAGE_INPUT_POLICY.maxBytesPerImage) {
    throw new Error(
      `Image is ${bytes.length} bytes; maximum is ${IMAGE_INPUT_POLICY.maxBytesPerImage}.`,
    );
  }

  const container = inspectContainer(bytes, options.sourceName);
  let metadata;
  try {
    const instance = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: IMAGE_INPUT_POLICY.maxPixels,
      unlimited: false,
      sequentialRead: true,
    });
    metadata = await instance.metadata();
    if (options.fullDecode !== false) {
      await instance.raw().toBuffer();
    }
  } catch (error) {
    throw new Error(`Image decode failed: ${errorMessage(error)}.`, {
      cause: error,
    });
  }

  const mimeType = mimeTypeForSharpFormat(metadata.format);
  if (mimeType !== container.mimeType) {
    throw new Error(
      `Image container and decoder disagree on format (${container.mimeType} vs ${mimeType}).`,
    );
  }
  const width = requireDimension(metadata.width, "width");
  const height = requireDimension(metadata.height, "height");
  const decoderAnimated =
    (metadata.pages ?? 1) > 1 || metadata.pageHeight !== undefined;
  if (container.animated || decoderAnimated) {
    throw new Error("Animated images are not supported.");
  }
  if (
    width > IMAGE_INPUT_POLICY.maxLongEdge ||
    height > IMAGE_INPUT_POLICY.maxLongEdge
  ) {
    throw new Error(
      `Image dimensions ${width}x${height} exceed ${IMAGE_INPUT_POLICY.maxLongEdge}px.`,
    );
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > IMAGE_INPUT_POLICY.maxPixels) {
    throw new Error(
      `Image pixel count ${pixels} exceeds ${IMAGE_INPUT_POLICY.maxPixels}.`,
    );
  }

  return Object.freeze({
    assetId: imageAssetIdForBytes(bytes),
    mimeType,
    byteLength: bytes.length,
    width,
    height,
  });
}

function inspectContainer(
  bytes: Buffer,
  sourceName?: string,
): {
  mimeType: ImageMimeType;
  animated: boolean;
} {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { mimeType: "image/png", animated: inspectPng(bytes) };
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { mimeType: "image/jpeg", animated: false };
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mimeType: "image/webp", animated: inspectWebp(bytes) };
  }
  const prefix = bytes.subarray(0, Math.min(bytes.length, 512));
  const looksUnsupported =
    prefix.subarray(0, 6).toString("ascii") === "GIF87a" ||
    prefix.subarray(0, 6).toString("ascii") === "GIF89a" ||
    prefix.toString("utf8").trimStart().startsWith("<svg") ||
    /\.(?:apng|avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(
      sourceName ?? "",
    );
  if (looksUnsupported) {
    throw new UnsupportedImageFormatError(
      "Image format is unsupported or the image content is invalid.",
    );
  }
  throw new ImageNotRecognizedError("Selected file is not an image.");
}

function inspectPng(bytes: Buffer): boolean {
  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let sawIend = false;
  let animated = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) {
      throw new Error("PNG container is truncated.");
    }
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || chunkEnd > bytes.length) {
      throw new Error("PNG chunk length or type is invalid.");
    }
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) {
      throw new Error("PNG must begin with a valid IHDR chunk.");
    }
    if (type === "acTL") {
      if (length !== 8) {
        throw new Error("PNG acTL chunk is invalid.");
      }
      animated = true;
    }
    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== bytes.length) {
        throw new Error("PNG IEND chunk or trailing data is invalid.");
      }
      sawIend = true;
      break;
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  if (!sawIend) {
    throw new Error("PNG container has no IEND chunk.");
  }
  return animated;
}

function inspectWebp(bytes: Buffer): boolean {
  const declaredSize = bytes.readUInt32LE(4) + 8;
  if (declaredSize !== bytes.length) {
    throw new Error("WebP RIFF size does not match the file length.");
  }
  let offset = 12;
  let animated = false;
  let chunkCount = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) {
      throw new Error("WebP container is truncated.");
    }
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const paddedEnd = dataStart + length + (length % 2);
    if (!/^[ -~]{4}$/.test(type) || paddedEnd > bytes.length) {
      throw new Error("WebP chunk length or type is invalid.");
    }
    if (type === "VP8X") {
      if (length !== 10) {
        throw new Error("WebP VP8X chunk is invalid.");
      }
      animated ||= (bytes[dataStart] & 0x02) !== 0;
    }
    if (type === "ANIM" || type === "ANMF") {
      animated = true;
    }
    chunkCount += 1;
    offset = paddedEnd;
  }
  if (offset !== bytes.length || chunkCount === 0) {
    throw new Error("WebP container has an invalid chunk boundary.");
  }
  return animated;
}

function mimeTypeForSharpFormat(format: string | undefined): ImageMimeType {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      throw new Error(`Unsupported decoded image format: ${String(format)}.`);
  }
}

function requireDimension(value: number | undefined, name: string): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
    throw new Error(`Decoded image ${name} must be a positive safe integer.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
