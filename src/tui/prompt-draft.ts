import type { ImportedImageAsset } from "../image/image-asset-store";
import {
  imageLabel,
  validateImageAssetRef,
  validateOriginalImageName,
  validateUserMessage,
  type CodePointRange,
  type ImageAttachmentId,
  type ImageAssetRef,
  type UserMessage,
} from "../image/image-types";
import { IMAGE_INPUT_POLICY } from "../image/image-input-policy";
import {
  backspace,
  createLineEditorState,
  deleteForward,
  deleteToLineStart,
  insert,
  moveDown,
  moveLeft,
  moveRight,
  moveToLineEnd,
  moveToLineStart,
  moveUp,
  type LineEditorState,
} from "./line-editor";

export type PromptElement = {
  readonly kind: "image";
  readonly attachmentId: ImageAttachmentId;
  readonly label: string;
  readonly range: CodePointRange;
};

export type DraftImageAttachment = {
  readonly attachmentId: ImageAttachmentId;
  readonly asset: ImageAssetRef;
  readonly originalName: string;
};

export type PromptDraft = {
  readonly editor: LineEditorState;
  readonly elements: readonly PromptElement[];
  readonly attachments: readonly DraftImageAttachment[];
};

export function createPromptDraft(value = ""): PromptDraft {
  return Object.freeze({
    editor: Object.freeze(createLineEditorState(value)),
    elements: Object.freeze([]),
    attachments: Object.freeze([]),
  });
}

export function validatePromptDraft(draft: PromptDraft): void {
  const chars = [...draft.editor.value];
  if (
    !Number.isSafeInteger(draft.editor.cursor) ||
    draft.editor.cursor < 0 ||
    draft.editor.cursor > chars.length
  ) {
    throw new Error("Prompt draft cursor is outside the text.");
  }
  if (
    draft.editor.preferredColumn !== undefined &&
    (!Number.isSafeInteger(draft.editor.preferredColumn) ||
      draft.editor.preferredColumn < 0)
  ) {
    throw new Error("Prompt draft preferred column is invalid.");
  }
  if (draft.elements.length !== draft.attachments.length) {
    throw new Error("Prompt draft image elements and attachments are unbalanced.");
  }
  if (draft.elements.length > IMAGE_INPUT_POLICY.maxImagesPerMessage) {
    throw new Error(
      `Prompt has ${draft.elements.length} images; maximum is ${IMAGE_INPUT_POLICY.maxImagesPerMessage}.`,
    );
  }
  const attachments = new Map(
    draft.attachments.map((attachment) => [attachment.attachmentId, attachment]),
  );
  if (attachments.size !== draft.attachments.length) {
    throw new Error("Prompt draft attachment IDs must be unique.");
  }
  let previousEnd = -1;
  for (let index = 0; index < draft.elements.length; index += 1) {
    const element = draft.elements[index];
    const attachment = attachments.get(element.attachmentId);
    if (attachment === undefined) {
      throw new Error("Prompt image element has no attachment.");
    }
    if (element.label !== imageLabel(index + 1)) {
      throw new Error("Prompt image labels are not continuously numbered.");
    }
    if (
      element.range.start < previousEnd ||
      element.range.start < 0 ||
      element.range.end <= element.range.start ||
      element.range.end > chars.length ||
      chars.slice(element.range.start, element.range.end).join("") !== element.label
    ) {
      throw new Error("Prompt image element range is invalid.");
    }
    validateImageAssetRef(attachment.asset);
    validateOriginalImageName(attachment.originalName);
    attachments.delete(element.attachmentId);
    previousEnd = element.range.end;
  }
  if (attachments.size !== 0) {
    throw new Error("Prompt image attachment has no element.");
  }
  if (draft.elements.length > 0) {
    validateUserMessage(draftToUserMessage(draft));
  }
  if (
    draft.elements.some(
      (element) =>
        element.range.start < draft.editor.cursor &&
        draft.editor.cursor < element.range.end,
    )
  ) {
    throw new Error("Prompt draft cursor is inside an atomic image element.");
  }
}

export function insertDraftImage(
  draft: PromptDraft,
  input: {
    replace: CodePointRange;
    attachmentId: ImageAttachmentId;
    imported: ImportedImageAsset;
  },
): PromptDraft {
  validatePromptDraft(draft);
  if (draft.attachments.length >= IMAGE_INPUT_POLICY.maxImagesPerMessage) {
    throw new Error(
      `A prompt can contain at most ${IMAGE_INPUT_POLICY.maxImagesPerMessage} images.`,
    );
  }
  if (
    input.replace.start < 0 ||
    input.replace.end < input.replace.start ||
    input.replace.end > [...draft.editor.value].length
  ) {
    throw new Error("Image insertion range is invalid.");
  }
  const provisionalLabel = imageLabel(draft.elements.length + 1);
  const suffix = [...draft.editor.value].slice(input.replace.end);
  const separator = suffix[0] === " " || suffix[0] === "\t" ? "" : " ";
  const edited = applyDraftEdit(
    draft,
    input.replace,
    `${provisionalLabel}${separator}`,
  );
  const insertedRange = Object.freeze({
    start: input.replace.start,
    end: input.replace.start + [...provisionalLabel].length,
  });
  const withImage: PromptDraft = Object.freeze({
    editor: edited.editor,
    elements: Object.freeze(
      [
        ...edited.elements,
        Object.freeze({
          kind: "image" as const,
          attachmentId: input.attachmentId,
          label: provisionalLabel,
          range: insertedRange,
        }),
      ].sort((left, right) => left.range.start - right.range.start),
    ),
    attachments: Object.freeze([
      ...edited.attachments,
      Object.freeze({
        attachmentId: input.attachmentId,
        asset: input.imported.asset,
        originalName: input.imported.originalName,
      }),
    ]),
  });
  return renumberDraft(withImage);
}

export function insertDraftText(draft: PromptDraft, text: string): PromptDraft {
  return applyEditorOperation(draft, (editor) => insert(editor, text));
}

export function replaceDraftText(
  draft: PromptDraft,
  range: CodePointRange,
  replacement: string,
): PromptDraft {
  validatePromptDraft(draft);
  const length = [...draft.editor.value].length;
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end > length
  ) {
    throw new Error("Prompt replacement range is invalid.");
  }
  return applyDraftEdit(draft, range, replacement);
}

export function backspaceDraft(draft: PromptDraft): PromptDraft {
  return applyEditorOperation(draft, backspace);
}

export function deleteForwardDraft(draft: PromptDraft): PromptDraft {
  return applyEditorOperation(draft, deleteForward);
}

export function deleteToLineStartDraft(draft: PromptDraft): PromptDraft {
  return applyEditorOperation(draft, deleteToLineStart);
}

export function moveDraftLeft(draft: PromptDraft): PromptDraft {
  const element = draft.elements.find(
    (entry) => entry.range.end === draft.editor.cursor,
  );
  return withCursor(
    draft,
    element?.range.start ?? moveLeft(draft.editor).cursor,
    "left",
  );
}

export function moveDraftRight(draft: PromptDraft): PromptDraft {
  const element = draft.elements.find(
    (entry) => entry.range.start === draft.editor.cursor,
  );
  return withCursor(
    draft,
    element?.range.end ?? moveRight(draft.editor).cursor,
    "right",
  );
}

export function moveDraftUp(draft: PromptDraft): PromptDraft {
  const moved = moveUp(draft.editor);
  return withEditorCursor(draft, moved, "up");
}

export function moveDraftDown(draft: PromptDraft): PromptDraft {
  const moved = moveDown(draft.editor);
  return withEditorCursor(draft, moved, "down");
}

export function moveDraftToLineStart(draft: PromptDraft): PromptDraft {
  return withEditorCursor(draft, moveToLineStart(draft.editor), "left");
}

export function moveDraftToLineEnd(draft: PromptDraft): PromptDraft {
  return withEditorCursor(draft, moveToLineEnd(draft.editor), "right");
}

export function draftSubmissionSnapshot(draft: PromptDraft): {
  readonly draft: PromptDraft;
  readonly userMessage: UserMessage;
} {
  validatePromptDraft(draft);
  const chars = [...draft.editor.value];
  let start = 0;
  while (start < chars.length && chars[start].trim() === "") {
    start += 1;
  }
  let end = chars.length;
  while (end > start && chars[end - 1].trim() === "") {
    end -= 1;
  }
  let normalized = draft;
  if (end < chars.length) {
    normalized = applyDraftEdit(normalized, { start: end, end: chars.length }, "");
  }
  if (start > 0) {
    normalized = applyDraftEdit(normalized, { start: 0, end: start }, "");
  }
  validatePromptDraft(normalized);
  const userMessage = draftToUserMessage(normalized);
  validateUserMessage(userMessage);
  return Object.freeze({ draft: normalized, userMessage });
}

export function draftToUserMessage(draft: PromptDraft): UserMessage {
  const attachmentsById = new Map(
    draft.attachments.map((attachment) => [attachment.attachmentId, attachment]),
  );
  return Object.freeze({
    role: "user",
    content: draft.editor.value,
    ...(draft.elements.length === 0
      ? {}
      : {
          attachments: Object.freeze(
            draft.elements.map((element) => {
              const attachment = attachmentsById.get(element.attachmentId);
              if (attachment === undefined) {
                throw new Error("Prompt image attachment disappeared.");
              }
              return Object.freeze({
                attachmentId: element.attachmentId,
                assetId: attachment.asset.assetId,
                label: element.label,
                range: element.range,
                mimeType: attachment.asset.mimeType,
                byteLength: attachment.asset.byteLength,
                width: attachment.asset.width,
                height: attachment.asset.height,
                originalName: attachment.originalName,
              });
            }),
          ),
        }),
  });
}

export function promptDraftChanged(left: PromptDraft, right: PromptDraft): boolean {
  return (
    left.editor.value !== right.editor.value ||
    left.editor.cursor !== right.editor.cursor ||
    left.editor.preferredColumn !== right.editor.preferredColumn ||
    left.elements !== right.elements ||
    left.attachments !== right.attachments
  );
}

function applyEditorOperation(
  draft: PromptDraft,
  operation: (editor: LineEditorState) => LineEditorState,
): PromptDraft {
  validatePromptDraft(draft);
  const raw = operation(draft.editor);
  if (raw.value === draft.editor.value) {
    return withEditorCursor(draft, raw, "right");
  }
  const before = [...draft.editor.value];
  const after = [...raw.value];
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const replacement = after.slice(prefix, after.length - suffix).join("");
  return applyDraftEdit(
    draft,
    { start: prefix, end: before.length - suffix },
    replacement,
  );
}

function applyDraftEdit(
  draft: PromptDraft,
  requested: CodePointRange,
  replacement: string,
): PromptDraft {
  const chars = [...draft.editor.value];
  let start = requested.start;
  let end = requested.end;
  const isInsertion = start === end;
  const removedIds = new Set<ImageAttachmentId>();
  for (const element of draft.elements) {
    const intersects = isInsertion
      ? element.range.start < start && start < element.range.end
      : element.range.start < end && start < element.range.end;
    if (intersects) {
      start = Math.min(start, element.range.start);
      end = Math.max(end, element.range.end);
      removedIds.add(element.attachmentId);
    }
  }
  const inserted = [...replacement];
  const delta = inserted.length - (end - start);
  const value = [...chars.slice(0, start), ...inserted, ...chars.slice(end)].join("");
  const elements = draft.elements
    .filter((element) => !removedIds.has(element.attachmentId))
    .map((element) =>
      element.range.start >= end
        ? Object.freeze({
            ...element,
            range: Object.freeze({
              start: element.range.start + delta,
              end: element.range.end + delta,
            }),
          })
        : element,
    );
  const edited: PromptDraft = Object.freeze({
    editor: Object.freeze({ value, cursor: start + inserted.length }),
    elements: Object.freeze(elements),
    attachments: Object.freeze(
      draft.attachments.filter(
        (attachment) => !removedIds.has(attachment.attachmentId),
      ),
    ),
  });
  return renumberDraft(edited);
}

function renumberDraft(draft: PromptDraft): PromptDraft {
  const ordered = [...draft.elements].sort(
    (left, right) => left.range.start - right.range.start,
  );
  const source = [...draft.editor.value];
  const output: string[] = [];
  const elements: PromptElement[] = [];
  let sourceOffset = 0;
  let outputOffset = 0;
  let cursor = draft.editor.cursor;
  for (let index = 0; index < ordered.length; index += 1) {
    const element = ordered[index];
    const prefix = source.slice(sourceOffset, element.range.start);
    output.push(...prefix);
    outputOffset += prefix.length;
    const oldLength = element.range.end - element.range.start;
    const label = imageLabel(index + 1);
    const labelChars = [...label];
    output.push(...labelChars);
    elements.push(
      Object.freeze({
        kind: "image",
        attachmentId: element.attachmentId,
        label,
        range: Object.freeze({
          start: outputOffset,
          end: outputOffset + labelChars.length,
        }),
      }),
    );
    const labelDelta = labelChars.length - oldLength;
    if (cursor >= element.range.end) {
      cursor += labelDelta;
    }
    outputOffset += labelChars.length;
    sourceOffset = element.range.end;
  }
  output.push(...source.slice(sourceOffset));
  const attachmentsById = new Map(
    draft.attachments.map((attachment) => [attachment.attachmentId, attachment]),
  );
  const normalized: PromptDraft = Object.freeze({
    editor: Object.freeze({ value: output.join(""), cursor }),
    elements: Object.freeze(elements),
    attachments: Object.freeze(
      elements.map((element) => {
        const attachment = attachmentsById.get(element.attachmentId);
        if (attachment === undefined) {
          throw new Error("Prompt attachment disappeared while renumbering.");
        }
        return attachment;
      }),
    ),
  });
  validatePromptDraft(normalized);
  return normalized;
}

function withEditorCursor(
  draft: PromptDraft,
  editor: LineEditorState,
  direction: "left" | "right" | "up" | "down",
): PromptDraft {
  const cursor = normalizeCursor(draft.elements, editor.cursor, direction);
  const next = Object.freeze({
    ...draft,
    editor: Object.freeze({ ...editor, cursor }),
  });
  validatePromptDraft(next);
  return next;
}

function withCursor(
  draft: PromptDraft,
  cursor: number,
  direction: "left" | "right" | "up" | "down",
): PromptDraft {
  return withEditorCursor(draft, { value: draft.editor.value, cursor }, direction);
}

function normalizeCursor(
  elements: readonly PromptElement[],
  cursor: number,
  direction: "left" | "right" | "up" | "down",
): number {
  const element = elements.find(
    (entry) => entry.range.start < cursor && cursor < entry.range.end,
  );
  if (element === undefined) {
    return cursor;
  }
  const leftDistance = cursor - element.range.start;
  const rightDistance = element.range.end - cursor;
  if (leftDistance < rightDistance) {
    return element.range.start;
  }
  if (rightDistance < leftDistance) {
    return element.range.end;
  }
  return direction === "left" || direction === "up"
    ? element.range.start
    : element.range.end;
}
