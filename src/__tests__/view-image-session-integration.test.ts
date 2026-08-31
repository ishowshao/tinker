import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { IterationIdentity, ToolCall, TurnIdentity } from "../agent/types";
import { formatMessageSource } from "../context/context-source";
import { runtimeIdFactory } from "../ids/runtime-id";
import { ImageAssetStore } from "../image/image-asset-store";
import { OpenAIResponsesModelClient } from "../model/openai-responses-model-client";
import { ObservationBuilder } from "../observation/observation-builder";
import { ResumeProjectionReader } from "../session/resume-projection";
import { SessionError } from "../session/session-errors";
import {
  createSessionCompatibilityContract,
  SessionStore,
} from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import { VIEW_IMAGE_TOOL_DEFINITION } from "../tools/view-image";
import {
  finalizeTestSessionStore,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
} from "./test-runtime";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

describe("ViewImage session persistence", () => {
  test("round-trips blocks through resume and clone with safe Recall and timeline projections", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-view-session-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const cloneId = runtimeIdFactory.createSessionId();
    let store: SessionStore | undefined;
    let clone: SessionStore | undefined;
    try {
      const fixture = await createFixture(workspace, sessionId);
      store = fixture.store;
      const toolMessage = appendViewImageTurn(fixture);
      expect(toolMessage.content).toEqual(fixture.observation.content);
      expect(toolMessage.displayText).toBe(fixture.observation.displayText);

      const database = new Database(store.databasePath, { readonly: true });
      expect(
        database
          .query(
            `SELECT position, kind, text_content, asset_id
             FROM tool_message_content_blocks
             WHERE message_id = ? ORDER BY position`,
          )
          .all(toolMessage.messageId),
      ).toEqual([
        {
          position: 0,
          kind: "text",
          text_content:
            fixture.observation.content[0]?.type === "text"
              ? fixture.observation.content[0].text
              : null,
          asset_id: null,
        },
        {
          position: 1,
          kind: "image",
          text_content: null,
          asset_id: fixture.asset.assetId,
        },
      ]);
      const stored = database
        .query(
          `SELECT m.content, tr.raw_json
           FROM messages m JOIN tool_results tr ON tr.tool_message_id = m.message_id
           WHERE m.message_id = ?`,
        )
        .get(toolMessage.messageId) as { content: string; raw_json: string };
      database.close();
      expect(stored.content).toBe(fixture.observation.displayText);
      expect(`${stored.content}\n${stored.raw_json}`).not.toContain("data:image");
      expect(`${stored.content}\n${stored.raw_json}`).not.toContain("base64");

      const recalled = store.historyReader().get({
        source: formatMessageSource(toolMessage.messageId),
        byteOffset: 0,
        byteLimit: 8_192,
      });
      expect(recalled.content).toContain(
        fixture.observation.content[0]?.type === "text"
          ? fixture.observation.content[0].text
          : "",
      );
      expect(recalled.content).toContain(
        `[Historical tool image omitted: image/png, 32x18, asset=${fixture.asset.assetId.slice(0, 12)}….]`,
      );
      expect(recalled.content).not.toContain("data:image");

      const projection = await ResumeProjectionReader.read({
        workspaceRoot: workspace,
        sessionId,
        modelName: "test-model",
      });
      expect(
        projection.recentTurns[0]?.items.some(
          (item) =>
            item.text ===
            `ViewImage fixture.png -> image/png, 32x18, ${fixture.asset.byteLength} bytes`,
        ),
      ).toBe(true);

      await store.cloneTo({ targetSessionId: cloneId });
      clone = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId: cloneId,
      });
      const clonedTool = clone
        .loadProtocolView()
        .messages.find((message) => message.role === "tool");
      expect(clonedTool).toMatchObject({
        role: "tool",
        name: "ViewImage",
        content: fixture.observation.content,
        displayText: fixture.observation.displayText,
      });

      await store.close("tui_exit");
      store = undefined;
      store = await SessionStore.openExisting({ workspaceRoot: workspace, sessionId });
      expect(() =>
        store!.assertSessionCompatibility(
          createSessionCompatibilityContract({
            modelName: "test-model",
            profileName: "responses-image-tools",
            includeReasoningContent: false,
            contextProfile: TEST_CONTEXT_PROFILE,
            messageProtocol: fixture.client.messageProtocol,
            inputModalities: ["text", "image"],
            toolResultModalities: ["text", "image"],
          }),
        ),
      ).not.toThrow();
      expect(() =>
        store!.assertSessionCompatibility(
          createSessionCompatibilityContract({
            modelName: "test-model",
            profileName: "responses-image-tools",
            includeReasoningContent: false,
            contextProfile: TEST_CONTEXT_PROFILE,
            messageProtocol: fixture.client.messageProtocol,
            inputModalities: ["text", "image"],
            toolResultModalities: ["text"],
          }),
        ),
      ).toThrow("media");
    } finally {
      await clone?.close("tui_exit").catch(() => undefined);
      await store?.close("tui_exit").catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("fails session open when a tool-result asset is missing", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-view-session-missing-"),
    );
    const sessionId = runtimeIdFactory.createSessionId();
    let store: SessionStore | undefined;
    try {
      const fixture = await createFixture(workspace, sessionId);
      store = fixture.store;
      appendViewImageTurn(fixture);
      await store.close("tui_exit");
      store = undefined;
      await rm(fixture.assetStore.pathFor(fixture.asset.assetId));

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

  test("rejects non-contiguous persisted tool blocks before model use", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-view-session-block-gap-"),
    );
    const sessionId = runtimeIdFactory.createSessionId();
    let store: SessionStore | undefined;
    try {
      const fixture = await createFixture(workspace, sessionId);
      store = fixture.store;
      const message = appendViewImageTurn(fixture);
      const databasePath = store.databasePath;
      await store.close("tui_exit");
      store = undefined;

      const database = new Database(databasePath, { readwrite: true });
      const trigger = database
        .query(
          "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'tool_message_content_blocks_no_update'",
        )
        .get() as { sql: string };
      database.exec("DROP TRIGGER tool_message_content_blocks_no_update");
      database
        .query(
          "UPDATE tool_message_content_blocks SET position = 2 WHERE message_id = ? AND position = 1",
        )
        .run(message.messageId);
      database.exec(trigger.sql);
      database.close();

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
});

async function createFixture(
  workspaceRoot: string,
  sessionId: ReturnType<typeof runtimeIdFactory.createSessionId>,
) {
  const assetStore = await ImageAssetStore.open({ workspaceRoot });
  await writeFile(
    path.join(workspaceRoot, "fixture.png"),
    await sharp({
      create: {
        width: 32,
        height: 18,
        channels: 3,
        background: { r: 30, g: 160, b: 220 },
      },
    })
      .png()
      .toBuffer(),
  );
  const imported = await assetStore.importFile("fixture.png");
  const client = new OpenAIResponsesModelClient({
    apiKey: "test-key",
    model: "test-model",
    contextBudget: TEST_CONTEXT_BUDGET,
    inputModalities: ["text", "image"],
    toolResultModalities: ["text", "image"],
  });
  const store = await SessionStore.createNew({
    workspaceRoot,
    sessionId,
    modelName: "test-model",
    systemPrompt: "system",
    idFactory: runtimeIdFactory,
  });
  finalizeTestSessionStore(store, {
    systemPrompt: "system",
    modelName: "test-model",
    profileName: "responses-image-tools",
    tools: [VIEW_IMAGE_TOOL_DEFINITION],
    modelClient: client,
  });
  const raw = Object.freeze({
    kind: "view_image" as const,
    ok: true,
    filePath: "fixture.png",
    originalName: imported.originalName,
    asset: imported.asset,
  });
  const observation = new ObservationBuilder().build({
    call: {} as ToolCall,
    raw,
  });
  return {
    store,
    assetStore,
    asset: imported.asset,
    client,
    raw,
    observation,
  };
}

function appendViewImageTurn(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const { store } = fixture;
  const ledger = new SqliteSessionLedger(store, runtimeIdFactory);
  const turn: TurnIdentity = {
    sessionId: store.sessionId,
    turnId: runtimeIdFactory.createTurnId(),
    turnNumber: 1,
  };
  const iteration: IterationIdentity = {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 1,
  };
  const call: ToolCall = {
    ...iteration,
    toolCallId: runtimeIdFactory.createToolCallId(),
    toolCallNumber: 1,
    providerToolCallId: "provider-view-image",
    name: "ViewImage",
    args: { file_path: "fixture.png" },
  };
  const pending = ledger.beginTurn({
    turn,
    userMessage: { role: "user", content: "inspect fixture.png" },
  });
  store.beginIteration(iteration);
  pending.agent.appendAssistant({
    iteration,
    message: { role: "assistant", content: "I will inspect it.", toolCalls: [call] },
    provider: "test",
    model: "test-model",
  });
  pending.agent.commitToolCompletions([
    {
      call,
      kind: "returned",
      raw: fixture.raw,
      observation: fixture.observation.content,
    },
  ]);
  store.finishIterationForContinuation(iteration);
  const finalIteration: IterationIdentity = {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 2,
  };
  store.beginIteration(finalIteration);
  pending.agent.appendAssistant({
    iteration: finalIteration,
    message: { role: "assistant", content: "fixture inspected" },
    provider: "test",
    model: "test-model",
  });
  pending.finish({
    status: "completed",
    finalText: "fixture inspected",
    lastIteration: finalIteration,
  });
  const message = store
    .loadProtocolView()
    .messages.find((entry) => entry.role === "tool");
  if (message?.role !== "tool") {
    throw new Error("Expected persisted ViewImage tool message.");
  }
  return message;
}
