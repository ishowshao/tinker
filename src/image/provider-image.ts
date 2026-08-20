import sharp from "sharp";
import {
  IMAGE_INPUT_POLICY,
  imagePlanningTokens,
  providerImageDimensions,
} from "./image-input-policy";
import type { ImageMimeType } from "./image-types";

export type ProviderImage = {
  readonly bytes: Buffer;
  readonly mimeType: ImageMimeType;
  readonly width: number;
  readonly height: number;
  readonly planningTokens: number;
};

export async function materializeProviderImage(
  bytes: Buffer,
  mimeType: ImageMimeType,
): Promise<ProviderImage> {
  const input = sharp(bytes, {
    failOn: "warning",
    limitInputPixels: IMAGE_INPUT_POLICY.maxPixels,
    unlimited: false,
    sequentialRead: true,
  });
  const metadata = await input.metadata();
  const sourceWidth = requireDimension(metadata.width, "width");
  const sourceHeight = requireDimension(metadata.height, "height");
  const oriented = orientedDimensions(sourceWidth, sourceHeight, metadata.orientation);
  const target = providerImageDimensions(oriented.width, oriented.height);
  const requiresOrientation =
    metadata.orientation !== undefined && metadata.orientation !== 1;
  const requiresResize =
    target.width !== oriented.width || target.height !== oriented.height;

  let outputBytes = bytes;
  if (requiresOrientation || requiresResize) {
    let pipeline = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: IMAGE_INPUT_POLICY.maxPixels,
      unlimited: false,
      sequentialRead: true,
    }).rotate();
    if (requiresResize) {
      pipeline = pipeline.resize(target.width, target.height, {
        fit: "fill",
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: true,
      });
    }
    outputBytes = await encodeInOriginalFormat(pipeline, mimeType);
  }

  const outputMetadata = await sharp(outputBytes).metadata();
  const width = requireDimension(outputMetadata.width, "width");
  const height = requireDimension(outputMetadata.height, "height");
  if (Math.max(width, height) > IMAGE_INPUT_POLICY.maxProviderLongEdge) {
    throw new Error("Materialized image exceeds the provider image size policy.");
  }
  return Object.freeze({
    bytes: outputBytes,
    mimeType,
    width,
    height,
    planningTokens: imagePlanningTokens(width, height),
  });
}

export function orientedDimensions(
  width: number,
  height: number,
  orientation: number | undefined,
): { readonly width: number; readonly height: number } {
  return orientation !== undefined && orientation >= 5 && orientation <= 8
    ? Object.freeze({ width: height, height: width })
    : Object.freeze({ width, height });
}

async function encodeInOriginalFormat(
  pipeline: ReturnType<typeof sharp>,
  mimeType: ImageMimeType,
): Promise<Buffer> {
  switch (mimeType) {
    case "image/png":
      return pipeline.png({ compressionLevel: 6, adaptiveFiltering: false }).toBuffer();
    case "image/jpeg":
      return pipeline.jpeg({ quality: 80, chromaSubsampling: "4:2:0" }).toBuffer();
    case "image/webp":
      return pipeline.webp({ quality: 80, effort: 4 }).toBuffer();
  }
}

function requireDimension(value: number | undefined, name: string): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
    throw new Error(`Decoded image ${name} is invalid.`);
  }
  return value;
}
