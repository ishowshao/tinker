import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeIdFactory } from "../ids/runtime-id";
import {
  parseImageAssetId,
  parseImageAttachmentId,
  type ImageAttachmentId,
} from "../image/image-types";
import { stableJsonStringify } from "../model/model-request-preflight";
import {
  createPromptDraft,
  validatePromptDraft,
  type DraftImageAttachment,
  type PromptDraft,
  type PromptElement,
} from "./prompt-draft";

const DEFAULT_MAX_ENTRIES = 200;

export type PromptHistoryEntry =
  | { readonly version: 1; readonly text: string }
  | {
      readonly version: 2;
      readonly text: string;
      readonly elements: readonly PromptElement[];
      readonly attachments: readonly DraftImageAttachment[];
    };

export type LoadedPromptHistoryRecord =
  | {
      readonly kind: "valid";
      readonly lineNumber: number;
      readonly entry: PromptHistoryEntry;
    }
  | {
      readonly kind: "invalid";
      readonly lineNumber: number;
      readonly errorCode: "INVALID_JSON" | "UNSUPPORTED_VERSION" | "INVALID_ENTRY";
    };

export type PromptHistoryOptions = {
  filePath?: string;
  entries?: string[];
  records?: LoadedPromptHistoryRecord[];
  maxEntries?: number;
};

export class PromptHistory {
  readonly filePath?: string;
  private readonly maxEntries: number;
  private items: LoadedPromptHistoryRecord[];

  constructor(options: PromptHistoryOptions = {}) {
    this.filePath = options.filePath;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const records =
      options.records ??
      (options.entries ?? []).map((text, index) => ({
        kind: "valid" as const,
        lineNumber: index + 1,
        entry: Object.freeze({ version: 1 as const, text }),
      }));
    this.items = trimToMax(records, this.maxEntries);
  }

  static async load(
    filePath: string,
    options: { maxEntries?: number } = {},
  ): Promise<PromptHistory> {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return new PromptHistory({ filePath, maxEntries: options.maxEntries });
      }
      throw error;
    }

    const records: LoadedPromptHistoryRecord[] = [];
    for (const [index, line] of content.split("\n").entries()) {
      if (line.trim() === "") {
        continue;
      }
      records.push(parsePromptLine(line, index + 1));
    }
    return new PromptHistory({
      filePath,
      records,
      maxEntries: options.maxEntries,
    });
  }

  get records(): readonly LoadedPromptHistoryRecord[] {
    return this.items;
  }

  get entries(): readonly string[] {
    return this.items.flatMap((record) =>
      record.kind === "valid" ? [record.entry.text] : [],
    );
  }

  async append(prompt: string | PromptDraft): Promise<void> {
    const entry =
      typeof prompt === "string"
        ? Object.freeze({ version: 1 as const, text: prompt })
        : historyEntryFromDraft(prompt);
    if (entry.text === "") {
      return;
    }
    const previous = this.items.at(-1);
    if (
      previous?.kind === "valid" &&
      historySemanticKey(previous.entry) === historySemanticKey(entry)
    ) {
      return;
    }
    const lineNumber = (this.items.at(-1)?.lineNumber ?? 0) + 1;
    this.items = trimToMax(
      [...this.items, { kind: "valid", lineNumber, entry }],
      this.maxEntries,
    );

    if (this.filePath === undefined) {
      return;
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const serialized =
      entry.version === 1 ? JSON.stringify(entry.text) : stableJsonStringify(entry);
    await appendFile(this.filePath, `${serialized}\n`, "utf8");
  }
}

export function restorePromptHistoryEntry(
  entry: PromptHistoryEntry,
  idFactory: Pick<RuntimeIdFactory, "createImageAttachmentId">,
): PromptDraft {
  if (entry.version === 1) {
    return createPromptDraft(entry.text);
  }
  const remap = new Map<ImageAttachmentId, ImageAttachmentId>();
  for (const attachment of entry.attachments) {
    remap.set(attachment.attachmentId, idFactory.createImageAttachmentId());
  }
  const elements = entry.elements.map((element) =>
    Object.freeze({
      ...element,
      attachmentId: requireRemapped(remap, element.attachmentId),
      range: Object.freeze({ ...element.range }),
    }),
  );
  const attachments = entry.attachments.map((attachment) =>
    Object.freeze({
      ...attachment,
      attachmentId: requireRemapped(remap, attachment.attachmentId),
      asset: Object.freeze({ ...attachment.asset }),
    }),
  );
  const draft = Object.freeze({
    editor: Object.freeze({
      value: entry.text,
      cursor: [...entry.text].length,
    }),
    elements: Object.freeze(elements),
    attachments: Object.freeze(attachments),
  });
  validatePromptDraft(draft);
  return draft;
}

function parsePromptLine(line: string, lineNumber: number): LoadedPromptHistoryRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "invalid", lineNumber, errorCode: "INVALID_JSON" };
  }
  if (typeof parsed === "string") {
    return parsed === ""
      ? { kind: "invalid", lineNumber, errorCode: "INVALID_ENTRY" }
      : {
          kind: "valid",
          lineNumber,
          entry: Object.freeze({ version: 1, text: parsed }),
        };
  }
  if (!isRecord(parsed)) {
    return { kind: "invalid", lineNumber, errorCode: "INVALID_ENTRY" };
  }
  if (parsed.version !== 2) {
    return { kind: "invalid", lineNumber, errorCode: "UNSUPPORTED_VERSION" };
  }
  try {
    const entry = decodeV2Entry(parsed);
    return { kind: "valid", lineNumber, entry };
  } catch {
    return { kind: "invalid", lineNumber, errorCode: "INVALID_ENTRY" };
  }
}

function decodeV2Entry(record: Record<string, unknown>): PromptHistoryEntry {
  assertKeys(record, ["version", "text", "elements", "attachments"]);
  if (
    typeof record.text !== "string" ||
    !Array.isArray(record.elements) ||
    !Array.isArray(record.attachments) ||
    record.elements.length === 0
  ) {
    throw new Error("Invalid Prompt history v2 entry.");
  }
  const elements = record.elements.map((value): PromptElement => {
    const element = requireRecord(value);
    assertKeys(element, ["kind", "attachmentId", "label", "range"]);
    const range = requireRecord(element.range);
    assertKeys(range, ["start", "end"]);
    if (
      element.kind !== "image" ||
      typeof element.attachmentId !== "string" ||
      typeof element.label !== "string" ||
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end)
    ) {
      throw new Error("Invalid Prompt history image element.");
    }
    return Object.freeze({
      kind: "image",
      attachmentId: parseImageAttachmentId(element.attachmentId),
      label: element.label,
      range: Object.freeze({ start: range.start as number, end: range.end as number }),
    });
  });
  const attachments = record.attachments.map((value): DraftImageAttachment => {
    const attachment = requireRecord(value);
    assertKeys(attachment, ["attachmentId", "asset", "originalName"]);
    const asset = requireRecord(attachment.asset);
    assertKeys(asset, ["assetId", "mimeType", "byteLength", "width", "height"]);
    if (
      typeof attachment.attachmentId !== "string" ||
      typeof attachment.originalName !== "string" ||
      typeof asset.assetId !== "string" ||
      (asset.mimeType !== "image/png" &&
        asset.mimeType !== "image/jpeg" &&
        asset.mimeType !== "image/webp") ||
      !Number.isSafeInteger(asset.byteLength) ||
      !Number.isSafeInteger(asset.width) ||
      !Number.isSafeInteger(asset.height)
    ) {
      throw new Error("Invalid Prompt history image attachment.");
    }
    return Object.freeze({
      attachmentId: parseImageAttachmentId(attachment.attachmentId),
      asset: Object.freeze({
        assetId: parseImageAssetId(asset.assetId),
        mimeType: asset.mimeType,
        byteLength: asset.byteLength as number,
        width: asset.width as number,
        height: asset.height as number,
      }),
      originalName: attachment.originalName,
    });
  });
  const draft = Object.freeze({
    editor: Object.freeze({
      value: record.text,
      cursor: [...record.text].length,
    }),
    elements: Object.freeze(elements),
    attachments: Object.freeze(attachments),
  });
  validatePromptDraft(draft);
  return historyEntryFromDraft(draft);
}

function historyEntryFromDraft(draft: PromptDraft): PromptHistoryEntry {
  validatePromptDraft(draft);
  if (draft.elements.length === 0) {
    return Object.freeze({ version: 1, text: draft.editor.value });
  }
  return Object.freeze({
    version: 2,
    text: draft.editor.value,
    elements: Object.freeze(
      draft.elements.map((element) =>
        Object.freeze({
          ...element,
          range: Object.freeze({ ...element.range }),
        }),
      ),
    ),
    attachments: Object.freeze(
      draft.attachments.map((attachment) =>
        Object.freeze({
          ...attachment,
          asset: Object.freeze({ ...attachment.asset }),
        }),
      ),
    ),
  });
}

function historySemanticKey(entry: PromptHistoryEntry): string {
  return stableJsonStringify(
    entry.version === 1
      ? entry
      : {
          version: 2,
          text: entry.text,
          elements: entry.elements.map((element) => {
            const { attachmentId, ...semantic } = element;
            void attachmentId;
            return semantic;
          }),
          attachments: entry.attachments.map((attachment) => {
            const { attachmentId, ...semantic } = attachment;
            void attachmentId;
            return semantic;
          }),
        },
  );
}

function requireRemapped(
  remap: ReadonlyMap<ImageAttachmentId, ImageAttachmentId>,
  previous: ImageAttachmentId,
): ImageAttachmentId {
  const value = remap.get(previous);
  if (value === undefined) {
    throw new Error("Prompt history attachment remap is incomplete.");
  }
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Expected an object.");
  }
  return value;
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (stableJsonStringify(actual) !== stableJsonStringify(wanted)) {
    throw new Error("Prompt history object keys are invalid.");
  }
}

function trimToMax<T>(entries: T[], maxEntries: number): T[] {
  return entries.length > maxEntries
    ? entries.slice(entries.length - maxEntries)
    : entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
