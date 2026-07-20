export const IMAGE_INPUT_POLICY = Object.freeze({
  transport: "openai-chat-image-url-data-v1",
  allowedMimeTypes: Object.freeze(["image/png", "image/jpeg", "image/webp"] as const),
  maxBytesPerImage: 20 * 1024 * 1024,
  maxImagesPerMessage: 8,
  maxImagesPerRequest: 8,
  maxLongEdge: 4096,
  maxPixels: 8_847_360,
  maxRequestBodyBytes: 90_000_000,
  planningTokensPerImage: 2048,
  retryPolicy: "none",
} as const);

export const IMAGE_INPUT_POLICY_VERSION = "image-input-policy-v1" as const;
