export const IMAGE_INPUT_POLICY = Object.freeze({
  transport: "openai-chat-image-url-data-v1",
  allowedMimeTypes: Object.freeze(["image/png", "image/jpeg", "image/webp"] as const),
  maxBytesPerImage: 20 * 1024 * 1024,
  maxImagesPerMessage: 8,
  maxImagesPerRequest: 8,
  maxProviderLongEdge: 2048,
  maxLongEdge: 4096,
  maxPixels: 8_847_360,
  maxRequestBodyBytes: 90_000_000,
  allowUpscale: false,
  resizePolicy: "sharp-auto-orient-lanczos3-round-v1",
  outputEncodingPolicy: "preserve-input-format-fixed-encoding-v1",
  imageTokenBuckets: Object.freeze([
    Object.freeze({ maxLongEdge: 512, planningTokens: 384 }),
    Object.freeze({ maxLongEdge: 1024, planningTokens: 1408 }),
    Object.freeze({ maxLongEdge: 1536, planningTokens: 3072 }),
    Object.freeze({ maxLongEdge: 2048, planningTokens: 5504 }),
  ] as const),
  imageTokensUseTextCorrectionFactor: false,
  retryPolicy: "none",
} as const);

export const IMAGE_INPUT_POLICY_VERSION = "image-input-policy-v2" as const;

export function providerImageDimensions(
  width: number,
  height: number,
): { readonly width: number; readonly height: number } {
  requireDimension(width, "width");
  requireDimension(height, "height");
  const longEdge = Math.max(width, height);
  if (longEdge <= IMAGE_INPUT_POLICY.maxProviderLongEdge) {
    return Object.freeze({ width, height });
  }
  const scale = IMAGE_INPUT_POLICY.maxProviderLongEdge / longEdge;
  let targetWidth = Math.max(1, Math.round(width * scale));
  let targetHeight = Math.max(1, Math.round(height * scale));
  if (targetWidth > IMAGE_INPUT_POLICY.maxProviderLongEdge) {
    targetWidth = IMAGE_INPUT_POLICY.maxProviderLongEdge;
  }
  if (targetHeight > IMAGE_INPUT_POLICY.maxProviderLongEdge) {
    targetHeight = IMAGE_INPUT_POLICY.maxProviderLongEdge;
  }
  return Object.freeze({ width: targetWidth, height: targetHeight });
}

export function imagePlanningTokens(width: number, height: number): number {
  requireDimension(width, "width");
  requireDimension(height, "height");
  const longEdge = Math.max(width, height);
  const bucket = IMAGE_INPUT_POLICY.imageTokenBuckets.find(
    (candidate) => longEdge <= candidate.maxLongEdge,
  );
  if (bucket === undefined) {
    throw new Error("Materialized image exceeds the provider image size policy.");
  }
  return bucket.planningTokens;
}

function requireDimension(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Image ${name} must be a positive safe integer.`);
  }
}
