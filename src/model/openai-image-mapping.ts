import { parseImageAssetId, type ImageAssetId } from "../image/image-types";

const IMAGE_ASSET_URL_MARKER = Symbol("tinker.image-asset-url-marker");

export type ImageAssetUrlMarker = {
  readonly [IMAGE_ASSET_URL_MARKER]: ImageAssetId;
};

export function imageAssetUrlMarker(assetId: ImageAssetId): ImageAssetUrlMarker {
  parseImageAssetId(assetId);
  return Object.freeze({ [IMAGE_ASSET_URL_MARKER]: assetId });
}

export function parseImageAssetUrlMarker(value: unknown): ImageAssetId | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const assetId = (value as Partial<ImageAssetUrlMarker>)[IMAGE_ASSET_URL_MARKER];
  return typeof assetId === "string" ? parseImageAssetId(assetId) : undefined;
}
