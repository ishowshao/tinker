import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { runtimeIdFactory } from "../ids/runtime-id";
import type { IterationIdentity, TurnIdentity } from "../agent/types";
import { SessionError } from "../session/session-errors";
import {
  SESSION_APPLICATION_ID,
  SESSION_SCHEMA_V5_FINGERPRINT,
  SESSION_SCHEMA_VERSION,
  verifySessionSchema,
} from "../session/session-schema";
import { SessionStore, createRuntimeContract } from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import { TEST_CONTEXT_BUDGET, TEST_CONTEXT_PROFILE } from "./test-runtime";

describe("session schema identity", () => {
  test("persists all three schema identities and rejects structural drift", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-schema-"));
    const sessionId = runtimeIdFactory.createSessionId();
    try {
      const store = await createReadyStore(workspace, sessionId);
      const databasePath = store.databasePath;
      await store.close("tui_exit");

      let database = new Database(databasePath, { readonly: true });
      expect(pragmaNumber(database, "application_id")).toBe(SESSION_APPLICATION_ID);
      expect(pragmaNumber(database, "user_version")).toBe(SESSION_SCHEMA_VERSION);
      expect(
        (
          database.query("SELECT schema_fingerprint FROM session_meta").get() as {
            schema_fingerprint: string;
          }
        ).schema_fingerprint,
      ).toBe(SESSION_SCHEMA_V5_FINGERPRINT);
      expect(
        database
          .query(
            `SELECT type, name FROM sqlite_schema
             WHERE name = 'recall_documents'
                OR name = 'messages_recall_index'
                OR name LIKE 'message_fts%'
             ORDER BY type, name`,
          )
          .all(),
      ).toEqual([
        { type: "table", name: "message_fts" },
        { type: "table", name: "message_fts_config" },
        { type: "table", name: "message_fts_data" },
        { type: "table", name: "message_fts_docsize" },
        { type: "table", name: "message_fts_idx" },
        { type: "trigger", name: "messages_recall_index" },
        { type: "view", name: "recall_documents" },
      ]);
      database.close();

      database = new Database(databasePath, { readwrite: true });
      database.exec("DROP INDEX idx_messages_frame_ordinal");
      database.close();
      const error = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("SESSION_SCHEMA_INVALID");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects unsafe database permissions before opening SQLite", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-permission-"));
    const sessionId = runtimeIdFactory.createSessionId();
    try {
      const store = await createReadyStore(workspace, sessionId);
      const databasePath = store.databasePath;
      await store.close("tui_exit");
      await chmod(databasePath, 0o644);
      const error = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("SESSION_PERMISSION_INVALID");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects FTS configuration drift instead of rebuilding it", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-fts-config-"));
    const sessionId = runtimeIdFactory.createSessionId();
    try {
      const store = await createReadyStore(workspace, sessionId);
      const databasePath = store.databasePath;
      await store.close("tui_exit");
      const database = new Database(databasePath, { readwrite: true });
      database
        .query("INSERT INTO message_fts(message_fts, rank) VALUES ('automerge', 2)")
        .run();
      database.close();

      const error = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("SESSION_SCHEMA_INVALID");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects older schemas without migration", () => {
    for (const version of [1, 2, 4]) {
      const sessionId = runtimeIdFactory.createSessionId();
      const database = new Database(":memory:");
      try {
        database.exec(`PRAGMA application_id = ${SESSION_APPLICATION_ID}`);
        database.exec(`PRAGMA user_version = ${version}`);
        const error = catchError(() => verifySessionSchema(database, sessionId));
        expect(error).toBeInstanceOf(SessionError);
        expect((error as SessionError).code).toBe("SESSION_SCHEMA_UNSUPPORTED");
      } finally {
        database.close();
      }
    }
  });

  test("rebuilds index-only corruption from verified canonical history", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-rebuild-"));
    const sessionId = runtimeIdFactory.createSessionId();
    let reopened: SessionStore | undefined;
    try {
      const store = await createReadyStore(workspace, sessionId);
      appendTextTurn(store);
      const canonicalHash = store
        .loadProtocolView()
        .messages.find((message) => message.role === "user")?.contentSha256;
      const databasePath = store.databasePath;
      await store.close("tui_exit");

      const database = new Database(databasePath, { readwrite: true });
      const row = database
        .query(
          "SELECT rowid, content FROM messages WHERE role = 'user' ORDER BY ordinal LIMIT 1",
        )
        .get() as { rowid: number | bigint; content: string };
      database
        .query(
          `INSERT INTO message_fts(message_fts, rowid, content)
           VALUES ('delete', ?, ?)`,
        )
        .run(row.rowid, row.content);
      database.close();

      reopened = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId,
      });
      expect(reopened.recoverInterruptedState(runtimeIdFactory)).toMatchObject({
        recallIndexRebuilt: true,
        syntheticCompletionCount: 0,
      });
      expect(
        reopened.loadProtocolView().messages.find((message) => message.role === "user")
          ?.contentSha256,
      ).toBe(canonicalHash);
      expect(
        reopened.historyReader().search({
          query: "rebuild-keyword",
          limit: 10,
          offset: 0,
        }).hits,
      ).toHaveLength(1);
    } finally {
      await reopened?.close("tui_exit").catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("rolls back the canonical mutation when the FTS trigger fails", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-fts-rollback-"));
    const sessionId = runtimeIdFactory.createSessionId();
    let store: SessionStore | undefined;
    try {
      store = await createReadyStore(workspace, sessionId);
      const database = new Database(store.databasePath, { readwrite: true });
      database.exec("DROP TABLE message_fts");
      database.close();

      const ledger = new SqliteSessionLedger(store, runtimeIdFactory);
      const turn: TurnIdentity = {
        sessionId,
        turnId: runtimeIdFactory.createTurnId(),
        turnNumber: 1,
      };
      expect(() => ledger.beginTurn({ turn, userPrompt: "must roll back" })).toThrow(
        "begin_turn commit failed",
      );

      const inspection = new Database(store.databasePath, { readonly: true });
      expect(inspection.query("SELECT COUNT(*) AS count FROM turns").get()).toEqual({
        count: 0,
      });
      expect(
        inspection
          .query("SELECT COUNT(*) AS count FROM messages WHERE role = 'user'")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        inspection.query("SELECT next_turn_number FROM session_meta").get(),
      ).toEqual({ next_turn_number: 1 });
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
  store.finalizeRuntimeContract(
    createRuntimeContract({
      modelName: "test-model",
      includeReasoningContent: false,
      contextProfile: TEST_CONTEXT_PROFILE,
      contextBudget: TEST_CONTEXT_BUDGET,
      systemPrompt: "system",
      toolSchemaSha256: "a".repeat(64),
      requestConfigSha256: "b".repeat(64),
    }),
  );
  return store;
}

function pragmaNumber(database: Database, name: string): number {
  const row = database.query(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Number(Object.values(row)[0]);
}

function appendTextTurn(store: SessionStore): void {
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
  const pending = ledger.beginTurn({ turn, userPrompt: "rebuild-keyword" });
  store.beginIteration(iteration);
  pending.agent.appendAssistant({
    iteration,
    message: { role: "assistant", content: "done" },
    provider: "test",
    model: "test-model",
  });
  pending.finish({ status: "completed", finalText: "done", lastIteration: iteration });
}

function catchError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw.");
}
