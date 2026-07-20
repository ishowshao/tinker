import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { IterationIdentity, TurnIdentity, UserMessage } from "../agent/types";
import { formatMessageSource } from "../context/context-source";
import { runtimeIdFactory } from "../ids/runtime-id";
import { ImageAssetStore } from "../image/image-asset-store";
import type { ImageAssetRef, UserImageAttachment } from "../image/image-types";
import { SessionError } from "../session/session-errors";
import { ResumeProjectionReader } from "../session/resume-projection";
import { SessionStore } from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import { finalizeTestSessionStore } from "./test-runtime";

describe("image session persistence", () => {
  test("persists image relations, clones them, and renders a safe Recall omission", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-image-session-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const cloneId = runtimeIdFactory.createSessionId();
    let store: SessionStore | undefined;
    let clone: SessionStore | undefined;
    try {
      const assetStore = await ImageAssetStore.open({ workspaceRoot: workspace });
      const originalName = 'screen["checkout].png';
      await writeFile(
        path.join(workspace, originalName),
        await sharp({
          create: {
            width: 3,
            height: 2,
            channels: 3,
            background: { r: 10, g: 150, b: 90 },
          },
        })
          .png()
          .toBuffer(),
      );
      const imported = await assetStore.importWorkspaceFile(originalName);
      store = await createReadyStore(workspace, sessionId);
      const message = imageMessage(imported.asset, imported.originalName);
      appendCompletedTurn(store, 1, message);

      const canonicalUser = store
        .loadProtocolView()
        .messages.find((entry) => entry.role === "user");
      if (canonicalUser?.role !== "user") {
        throw new Error("Expected canonical image user message.");
      }
      expect(canonicalUser.attachments).toEqual(message.attachments);

      const inspection = new Database(store.databasePath, { readonly: true });
      expect(
        inspection.query("SELECT COUNT(*) AS count FROM image_assets").get(),
      ).toEqual({ count: 1 });
      expect(
        inspection
          .query("SELECT COUNT(*) AS count FROM message_image_attachments")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        inspection
          .query(
            `SELECT position, label, range_start, range_end, original_name
             FROM message_image_attachments`,
          )
          .get(),
      ).toEqual({
        position: 0,
        label: "[Image #1]",
        range_start: 8,
        range_end: 18,
        original_name: originalName,
      });
      inspection.close();

      const recall = store.historyReader().get({
        source: formatMessageSource(canonicalUser.messageId),
        byteOffset: 0,
        byteLimit: 4_096,
      });
      expect(recall.content).toContain("inspect [Image #1]");
      expect(recall.content).toContain(
        `[Historical image omitted: label=[Image #1], originalName=${JSON.stringify(originalName)}. Ask the user to reattach it.]`,
      );
      const canonicalAttachment = canonicalUser.attachments?.[0];
      if (canonicalAttachment === undefined) {
        throw new Error("Expected canonical image attachment.");
      }
      expect(recall.content).not.toContain(canonicalAttachment.assetId);
      expect(recall.content).not.toContain(canonicalAttachment.attachmentId);
      expect(recall.content).not.toContain(workspace);

      await store.cloneTo({ targetSessionId: cloneId });
      clone = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId: cloneId,
      });
      expect(
        clone.loadProtocolView().messages.find((entry) => entry.role === "user"),
      ).toMatchObject({
        content: message.content,
        attachments: message.attachments,
      });

      const resumed = await ResumeProjectionReader.read({
        workspaceRoot: workspace,
        sessionId: cloneId,
        modelName: "test-model",
      });
      const userItem = resumed.recentTurns[0]?.items.find(
        (item) => item.userPrompt !== undefined,
      );
      expect(userItem).toMatchObject({
        text: "inspect [Image #1]",
        userPrompt: {
          text: "inspect [Image #1]",
          images: [
            {
              label: "[Image #1]",
              range: { start: 8, end: 18 },
              originalName,
            },
          ],
          omittedImageCount: 0,
        },
      });
      expect(JSON.stringify(userItem)).not.toContain("assetId");
      expect(JSON.stringify(userItem)).not.toContain("attachmentId");
    } finally {
      await clone?.close("tui_exit").catch(() => undefined);
      await store?.close("tui_exit").catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("fails session open before use when a referenced asset is missing", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-image-session-missing-"),
    );
    const sessionId = runtimeIdFactory.createSessionId();
    let store: SessionStore | undefined;
    try {
      const assetStore = await ImageAssetStore.open({ workspaceRoot: workspace });
      await writeFile(
        path.join(workspace, "missing.png"),
        await sharp({
          create: {
            width: 1,
            height: 1,
            channels: 3,
            background: { r: 1, g: 2, b: 3 },
          },
        })
          .png()
          .toBuffer(),
      );
      const imported = await assetStore.importWorkspaceFile("missing.png");
      store = await createReadyStore(workspace, sessionId);
      appendCompletedTurn(
        store,
        1,
        imageMessage(imported.asset, imported.originalName),
      );
      await store.close("tui_exit");
      store = undefined;
      await rm(assetStore.pathFor(imported.asset.assetId));

      const error = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("SESSION_INTEGRITY_FAILED");
    } finally {
      await store?.close("tui_exit").catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("immutable triggers and canonical hashing detect attachment tampering", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-image-session-tamper-"),
    );
    const sessionId = runtimeIdFactory.createSessionId();
    let store: SessionStore | undefined;
    try {
      const assetStore = await ImageAssetStore.open({ workspaceRoot: workspace });
      await writeFile(
        path.join(workspace, "tamper.png"),
        await sharp({
          create: {
            width: 1,
            height: 1,
            channels: 3,
            background: { r: 4, g: 5, b: 6 },
          },
        })
          .png()
          .toBuffer(),
      );
      const imported = await assetStore.importWorkspaceFile("tamper.png");
      store = await createReadyStore(workspace, sessionId);
      appendCompletedTurn(
        store,
        1,
        imageMessage(imported.asset, imported.originalName),
      );
      const databasePath = store.databasePath;
      await store.close("tui_exit");
      store = undefined;

      const database = new Database(databasePath, { readwrite: true });
      expect(() =>
        database
          .query("UPDATE message_image_attachments SET original_name = 'blocked.png'")
          .run(),
      ).toThrow("message_image_attachments are immutable");
      database.exec("DROP TRIGGER message_image_attachments_no_update");
      database
        .query("UPDATE message_image_attachments SET original_name = 'tampered.png'")
        .run();
      database.exec(`CREATE TRIGGER message_image_attachments_no_update
        BEFORE UPDATE ON message_image_attachments
        BEGIN SELECT RAISE(ABORT, 'message_image_attachments are immutable'); END`);
      database.close();

      const error = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("SESSION_PROTOCOL_INVALID");
    } finally {
      await store?.close("tui_exit").catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("rolls back turn, message, and attachment rows on asset metadata conflict", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-image-session-atomic-"),
    );
    const sessionId = runtimeIdFactory.createSessionId();
    let store: SessionStore | undefined;
    try {
      store = await createReadyStore(workspace, sessionId);
      const asset: ImageAssetRef = {
        assetId: "a".repeat(64) as ImageAssetRef["assetId"],
        mimeType: "image/png",
        byteLength: 10,
        width: 1,
        height: 1,
      };
      appendCompletedTurn(store, 1, imageMessage(asset, "first.png"));
      const conflict = imageMessage({ ...asset, mimeType: "image/jpeg" }, "second.jpg");
      const ledger = new SqliteSessionLedger(store, runtimeIdFactory);
      const turn: TurnIdentity = {
        sessionId,
        turnId: runtimeIdFactory.createTurnId(),
        turnNumber: 2,
      };
      expect(() => ledger.beginTurn({ turn, userMessage: conflict })).toThrow(
        "begin_turn commit failed",
      );

      const inspection = new Database(store.databasePath, { readonly: true });
      expect(inspection.query("SELECT COUNT(*) AS count FROM turns").get()).toEqual({
        count: 1,
      });
      expect(
        inspection
          .query("SELECT COUNT(*) AS count FROM messages WHERE role = 'user'")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        inspection
          .query("SELECT COUNT(*) AS count FROM message_image_attachments")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        inspection.query("SELECT next_turn_number FROM session_meta").get(),
      ).toEqual({ next_turn_number: 2 });
      inspection.close();
    } finally {
      await store?.close("runner_failed").catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });
});

async function createReadyStore(
  workspaceRoot: string,
  sessionId: ReturnType<typeof runtimeIdFactory.createSessionId>,
): Promise<SessionStore> {
  const store = await SessionStore.createNew({
    workspaceRoot,
    sessionId,
    modelName: "test-model",
    systemPrompt: "system",
    idFactory: runtimeIdFactory,
  });
  finalizeTestSessionStore(store, { systemPrompt: "system" });
  return store;
}

function imageMessage(asset: ImageAssetRef, originalName: string): UserMessage {
  const attachment: UserImageAttachment = Object.freeze({
    attachmentId: runtimeIdFactory.createImageAttachmentId(),
    ...asset,
    label: "[Image #1]",
    range: Object.freeze({ start: 8, end: 18 }),
    originalName,
  });
  return Object.freeze({
    role: "user",
    content: "inspect [Image #1]",
    attachments: Object.freeze([attachment]),
  });
}

function appendCompletedTurn(
  store: SessionStore,
  turnNumber: number,
  userMessage: UserMessage,
): void {
  const ledger = new SqliteSessionLedger(store, runtimeIdFactory);
  const turn: TurnIdentity = {
    sessionId: store.sessionId,
    turnId: runtimeIdFactory.createTurnId(),
    turnNumber,
  };
  const iteration: IterationIdentity = {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 1,
  };
  const pending = ledger.beginTurn({ turn, userMessage });
  store.beginIteration(iteration);
  pending.agent.appendAssistant({
    iteration,
    message: { role: "assistant", content: "done" },
    provider: "test",
    model: "test-model",
  });
  pending.finish({
    status: "completed",
    finalText: "done",
    lastIteration: iteration,
  });
}
