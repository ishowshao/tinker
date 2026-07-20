import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { imageAssetIdForBytes, type UserMessage } from "../image/image-types";
import { runtimeIdFactory } from "../ids/runtime-id";
import {
  backspaceDraft,
  createPromptDraft,
  deleteForwardDraft,
  draftSubmissionSnapshot,
  insertDraftImage,
  insertDraftText,
  moveDraftLeft,
  moveDraftRight,
  validatePromptDraft,
  type PromptDraft,
} from "../tui/prompt-draft";
import { PromptHistory, restorePromptHistoryEntry } from "../tui/prompt-history";
import {
  projectUserMessage,
  truncateUserPromptProjection,
} from "../agent/user-prompt-projection";

describe("structured image Prompt draft", () => {
  test("inserts images at code-point ranges and keeps emoji offsets exact", () => {
    let draft = createPromptDraft("🙂 compare @shot now");
    draft = insertDraftImage(draft, {
      replace: { start: 10, end: 15 },
      attachmentId: runtimeIdFactory.createImageAttachmentId(),
      imported: importedImage("shot", "shot.png"),
    });

    expect(draft.editor.value).toBe("🙂 compare [Image #1] now");
    expect(draft.elements).toEqual([
      expect.objectContaining({
        label: "[Image #1]",
        range: { start: 10, end: 20 },
      }),
    ]);
    expect(draft.editor.cursor).toBe(20);
    validatePromptDraft(draft);
  });

  test("deletes an image atomically and renumbers without changing identity", () => {
    let draft = createPromptDraft("");
    const firstId = runtimeIdFactory.createImageAttachmentId();
    const secondId = runtimeIdFactory.createImageAttachmentId();
    draft = insertDraftImage(draft, {
      replace: { start: 0, end: 0 },
      attachmentId: firstId,
      imported: importedImage("first", "first.png"),
    });
    draft = insertDraftImage(draft, {
      replace: {
        start: draft.editor.cursor,
        end: draft.editor.cursor,
      },
      attachmentId: secondId,
      imported: importedImage("second", "second.webp"),
    });

    const first = draft.elements[0];
    draft = withCursor(draft, first.range.end);
    draft = backspaceDraft(draft);

    expect(draft.elements).toHaveLength(1);
    expect(draft.elements[0]).toMatchObject({
      attachmentId: secondId,
      label: "[Image #1]",
    });
    expect(draft.attachments.map((attachment) => attachment.attachmentId)).toEqual([
      secondId,
    ]);
    expect(draft.editor.value).not.toContain("[Image #2]");
    validatePromptDraft(draft);
  });

  test("Delete and horizontal movement never split an image element", () => {
    let draft = insertDraftImage(createPromptDraft("x"), {
      replace: { start: 1, end: 1 },
      attachmentId: runtimeIdFactory.createImageAttachmentId(),
      imported: importedImage("atomic", "atomic.jpg"),
    });
    const image = draft.elements[0];

    draft = withCursor(draft, image.range.start);
    expect(moveDraftRight(draft).editor.cursor).toBe(image.range.end);
    expect(moveDraftLeft(withCursor(draft, image.range.end)).editor.cursor).toBe(
      image.range.start,
    );
    const deleted = deleteForwardDraft(draft);
    expect(deleted.elements).toHaveLength(0);
    expect(deleted.attachments).toHaveLength(0);
    expect(deleted.editor.value).toBe("x ");
  });

  test("rejects a literal duplicate label and trims without detaching ranges", () => {
    const draft = insertDraftImage(createPromptDraft("  @shot  "), {
      replace: { start: 2, end: 7 },
      attachmentId: runtimeIdFactory.createImageAttachmentId(),
      imported: importedImage("trim", "trim.png"),
    });
    const normalized = draftSubmissionSnapshot(draft);
    expect(normalized.userMessage.content).toBe("[Image #1]");
    expect(normalized.userMessage.attachments?.[0]?.range).toEqual({
      start: 0,
      end: 10,
    });

    expect(() => insertDraftText(draft, "[Image #1]")).toThrow("unbound literal");
  });
});

describe("image Prompt history and projection", () => {
  test("round-trips v2 entries, remaps IDs, and deduplicates semantically", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-image-history-"));
    const filePath = path.join(workspace, "prompt-history.jsonl");
    try {
      const originalId = runtimeIdFactory.createImageAttachmentId();
      const draft = insertDraftImage(createPromptDraft("inspect @screen"), {
        replace: { start: 8, end: 15 },
        attachmentId: originalId,
        imported: importedImage("history", "screen.png"),
      });
      const history = new PromptHistory({ filePath });
      await history.append(draft);
      const loaded = await PromptHistory.load(filePath);
      const record = loaded.records[0];
      if (record?.kind !== "valid") throw new Error("Expected valid history.");
      const restored = restorePromptHistoryEntry(record.entry, runtimeIdFactory);

      expect(restored.editor.cursor).toBe([...restored.editor.value].length);
      expect(restored.elements[0]?.attachmentId).not.toBe(originalId);
      expect(restored.attachments[0]?.asset).toEqual(draft.attachments[0]?.asset);
      await loaded.append(restored);
      expect((await readFile(filePath, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("retains invalid physical history records with their line numbers", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-bad-history-"));
    const filePath = path.join(workspace, "prompt-history.jsonl");
    try {
      await writeFile(filePath, '"valid"\n{"version":99}\n{"version":2\n', "utf8");
      const loaded = await PromptHistory.load(filePath);
      expect(loaded.records).toEqual([
        expect.objectContaining({ kind: "valid", lineNumber: 1 }),
        { kind: "invalid", lineNumber: 2, errorCode: "UNSUPPORTED_VERSION" },
        { kind: "invalid", lineNumber: 3, errorCode: "INVALID_JSON" },
      ]);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("truncates a shared projection without splitting an image label", () => {
    const message = imageMessage("abc [Image #1] tail", {
      start: 4,
      end: 14,
    });
    const projected = truncateUserPromptProjection(projectUserMessage(message), 9);
    expect(projected).toEqual({
      version: 1,
      text: "abc \n…",
      images: [],
      omittedImageCount: 1,
    });
    expect(JSON.stringify(projected)).not.toContain("assetId");
    expect(JSON.stringify(projected)).not.toContain("attachmentId");
  });
});

function importedImage(seed: string, originalName: string) {
  const bytes = Buffer.from(seed);
  return Object.freeze({
    asset: Object.freeze({
      assetId: imageAssetIdForBytes(bytes),
      mimeType: originalName.endsWith(".webp")
        ? ("image/webp" as const)
        : originalName.endsWith(".jpg")
          ? ("image/jpeg" as const)
          : ("image/png" as const),
      byteLength: bytes.length,
      width: 1,
      height: 1,
    }),
    originalName,
  });
}

function withCursor(draft: PromptDraft, cursor: number): PromptDraft {
  const next = Object.freeze({
    ...draft,
    editor: Object.freeze({ value: draft.editor.value, cursor }),
  });
  validatePromptDraft(next);
  return next;
}

function imageMessage(
  content: string,
  range: { start: number; end: number },
): UserMessage {
  const imported = importedImage("projection", "checkout.png");
  return Object.freeze({
    role: "user",
    content,
    attachments: Object.freeze([
      Object.freeze({
        attachmentId: runtimeIdFactory.createImageAttachmentId(),
        ...imported.asset,
        label: "[Image #1]",
        range: Object.freeze(range),
        originalName: imported.originalName,
      }),
    ]),
  });
}
