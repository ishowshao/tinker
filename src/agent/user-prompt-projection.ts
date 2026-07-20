import type { UserMessage } from "./types";
import type { CodePointRange } from "../image/image-types";
import { validateUserMessage } from "../image/image-types";

export const MAX_TIMELINE_PROMPT_CODE_POINTS = 4_000;

export type UserPromptProjection = {
  readonly version: 1;
  readonly text: string;
  readonly images: readonly {
    readonly label: string;
    readonly range: CodePointRange;
    readonly originalName: string;
  }[];
  readonly omittedImageCount: number;
};

export function projectUserMessage(message: UserMessage): UserPromptProjection {
  validateUserMessage(message);
  return Object.freeze({
    version: 1,
    text: message.content,
    images: Object.freeze(
      (message.attachments ?? []).map((attachment) =>
        Object.freeze({
          label: attachment.label,
          range: Object.freeze({ ...attachment.range }),
          originalName: attachment.originalName,
        }),
      ),
    ),
    omittedImageCount: 0,
  });
}

export function truncateUserPromptProjection(
  projection: UserPromptProjection,
  maxCodePoints: number,
): UserPromptProjection {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 0) {
    throw new Error("Prompt projection limit must be a non-negative safe integer.");
  }
  const chars = [...projection.text];
  if (chars.length <= maxCodePoints) {
    return projection;
  }
  let end = maxCodePoints;
  const splitImage = projection.images.find(
    (image) => image.range.start < end && end < image.range.end,
  );
  if (splitImage !== undefined) {
    end = splitImage.range.start;
  }
  const images = projection.images.filter((image) => image.range.end <= end);
  return Object.freeze({
    version: 1,
    text: `${chars.slice(0, end).join("")}\n…`,
    images: Object.freeze(images),
    omittedImageCount:
      projection.omittedImageCount + projection.images.length - images.length,
  });
}
