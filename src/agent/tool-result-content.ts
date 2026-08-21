import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import { validateImageAssetRef } from "../image/image-types";
import { IMAGE_INPUT_POLICY } from "../image/image-input-policy";
import type { ToolResultContent } from "./types";

export function canonicalToolResultContentHash(
  content: readonly ToolResultContent[],
): string {
  validateToolResultContent(content);
  return sha256(stableJsonStringify(content));
}

export function validateToolResultContent(content: readonly ToolResultContent[]): void {
  if (content.length === 0) {
    throw new Error("Tool result content must be a non-empty array.");
  }
  let previousWasText = false;
  let imageCount = 0;
  for (const block of content) {
    switch (block.type) {
      case "text":
        if (block.text.trim() === "") {
          throw new Error("Tool result text blocks must not be empty.");
        }
        if (previousWasText) {
          throw new Error("Consecutive tool result text blocks must be merged.");
        }
        previousWasText = true;
        break;
      case "image":
        validateImageAssetRef(block.asset);
        imageCount += 1;
        previousWasText = false;
        break;
    }
  }
  if (imageCount > IMAGE_INPUT_POLICY.maxImagesPerMessage) {
    throw new Error("Tool result content exceeds the per-message image limit.");
  }
}

export function textToolResultContent(text: string): readonly ToolResultContent[] {
  const content = Object.freeze([Object.freeze({ type: "text" as const, text })]);
  validateToolResultContent(content);
  return content;
}

export function toolResultDisplayText(content: readonly ToolResultContent[]): string {
  validateToolResultContent(content);
  return content
    .map((block) =>
      block.type === "text"
        ? block.text
        : `[Image: ${block.asset.mimeType}, ${block.asset.width}x${block.asset.height}, ${block.asset.byteLength} bytes, asset=${shortAssetId(block.asset.assetId)}]`,
    )
    .join("\n");
}

export function toolResultText(content: readonly ToolResultContent[]): string {
  validateToolResultContent(content);
  if (content.some((block) => block.type === "image")) {
    throw new Error("Text-only tool result mapping received an image block.");
  }
  return content
    .map((block) => {
      if (block.type !== "text") {
        throw new Error("Text-only tool result mapping received an image block.");
      }
      return block.text;
    })
    .join("\n");
}

function shortAssetId(assetId: string): string {
  return `${assetId.slice(0, 12)}…`;
}
