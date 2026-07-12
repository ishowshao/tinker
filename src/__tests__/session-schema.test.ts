import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { runtimeIdFactory } from "../ids/runtime-id";
import { SessionError } from "../session/session-errors";
import {
  SESSION_APPLICATION_ID,
  SESSION_SCHEMA_V1_FINGERPRINT,
  SESSION_SCHEMA_VERSION,
} from "../session/session-schema";
import { SessionStore, createRuntimeContract } from "../session/session-store";
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
      ).toBe(SESSION_SCHEMA_V1_FINGERPRINT);
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
