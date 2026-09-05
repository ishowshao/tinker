import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatMessageSource } from "../context/context-source";
import { textToolResultContent } from "../agent/tool-result-content";
import type { ToolCall } from "../agent/types";
import type { RecallRawResult } from "../tools/types";
import { runtimeIdFactory } from "../ids/runtime-id";
import { ObservationBuilder } from "../observation/observation-builder";
import { createSessionHistoryAccess } from "../session/session-history-access";
import { SessionStore } from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import {
  createRecallGetToolExecutor,
  createRecallSearchToolExecutor,
} from "../tools/recall";
import { createDefaultTooling, ToolRegistry, ToolRuntime } from "../tools/registry";
import { createTestRuntime, finalizeTestSessionStore } from "./test-runtime";

const signal = new AbortController().signal;
const roots: string[] = [];
const stores: SessionStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0))
    await store.close("tui_exit").catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "recall-sessions-")),
  );
  roots.push(root);
  const homeRoot = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other");
  for (const directory of [homeRoot, workspaceRoot, otherWorkspace])
    await mkdir(directory);
  const create = async (workspace: string, content: string) => {
    const store = await SessionStore.createNew({
      workspaceRoot: workspace,
      homeRoot,
      sessionId: runtimeIdFactory.createSessionId(),
      modelName: "test-model",
      systemPrompt: "system",
      idFactory: runtimeIdFactory,
    });
    stores.push(store);
    finalizeTestSessionStore(store, { systemPrompt: "system" });
    appendTurn(store, content);
    return store;
  };
  const current = await create(workspaceRoot, "current-only-anchor");
  const target = await create(otherWorkspace, "target-only-anchor 历史🙂".repeat(40));
  const historyAccess = createSessionHistoryAccess({
    historyReader: current.historyReader(),
    workspaceRoot,
    homeRoot,
  });
  const registry = new ToolRegistry();
  registry.register(createRecallSearchToolExecutor({ historyAccess }));
  registry.register(createRecallGetToolExecutor({ historyAccess }));
  const runtime = new ToolRuntime(registry);
  const identity = createTestRuntime();
  const execute = (name: string, args: unknown, selectedSignal = signal) =>
    runtime.execute(identity.toolCall({ name, args }), { signal: selectedSignal });
  return {
    root,
    homeRoot,
    workspaceRoot,
    otherWorkspace,
    current,
    target,
    create,
    historyAccess,
    execute,
  };
}

function appendTurn(store: SessionStore, content: string, open = false) {
  const ledger = new SqliteSessionLedger(store, runtimeIdFactory);
  const turn = {
    sessionId: store.sessionId,
    turnId: runtimeIdFactory.createTurnId(),
    turnNumber: store.nextTurnNumber(),
  };
  const pending = ledger.beginTurn({ turn, userMessage: { role: "user", content } });
  if (!open) {
    const iteration = {
      ...turn,
      iterationId: runtimeIdFactory.createIterationId(),
      iterationNumber: 1,
    };
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
}

function editDatabase(store: SessionStore, edit: (db: Database) => void) {
  const db = new Database(store.databasePath);
  try {
    edit(db);
  } finally {
    db.close();
  }
}

function editMetadata(store: SessionStore, edit: (db: Database) => void) {
  editDatabase(store, (db) => {
    const trigger = db
      .query(
        "SELECT sql FROM sqlite_schema WHERE name = 'session_meta_monotonic_update'",
      )
      .get() as { sql: string };
    db.exec("DROP TRIGGER session_meta_monotonic_update");
    edit(db);
    db.exec(trigger.sql);
  });
}

function readState(store: SessionStore) {
  const db = new Database(store.databasePath, { readonly: true });
  try {
    return {
      meta: db.query("SELECT * FROM session_meta").all(),
      turns: db.query("SELECT * FROM turns").all(),
      schema: db.query("SELECT * FROM sqlite_schema").all(),
    };
  } finally {
    db.close();
  }
}

describe("Recall session selection", () => {
  test("selects same/cross workspace history without Memory and preserves provenance, UTF-8 pages and snapshots", async () => {
    const f = await fixture();
    const same = await f.create(f.workspaceRoot, "same-workspace-anchor");
    for (const target of [same, f.target]) {
      const query = target === same ? "same-workspace-anchor" : "target-only-anchor";
      const result = await f.execute("RecallSearch", {
        sessionId: target.sessionId,
        query,
      });
      expect(result).toMatchObject({
        kind: "recall",
        ok: true,
        sessionId: target.sessionId,
        workspaceRoot: target.workspaceRoot,
      });
      if (result.kind !== "recall" || !result.ok || result.mode !== "search")
        throw new Error("Expected search");
      expect(result.page.hits).toHaveLength(1);
      const source = result.page.hits[0].source;
      const parts: string[] = [];
      let byte_offset = 0;
      for (;;) {
        const get = await f.execute("RecallGet", {
          sessionId: target.sessionId,
          source,
          byte_offset,
          byte_limit: 256,
        });
        if (get.kind !== "recall" || !get.ok || get.mode !== "get")
          throw new Error("Expected get");
        expect(get.page.contentSha256).toBe(result.page.hits[0].contentSha256);
        expect(get.sessionId).toBe(target.sessionId);
        parts.push(get.page.content);
        if (get.page.nextByteOffset === undefined) break;
        byte_offset = get.page.nextByteOffset;
      }
      expect(parts.join("")).toBe(
        target.historyReader().get({ source, byteOffset: 0, byteLimit: 20_000 })
          .content,
      );
      expect(await f.execute("RecallGet", { source })).toMatchObject({
        ok: false,
        errorCode: "RECALL_SOURCE_NOT_FOUND",
      });
      expect(
        await f.execute("RecallSearch", {
          sessionId: target.sessionId,
          query: "current-only-anchor",
        }),
      ).toMatchObject({ ok: true, page: { hits: [] } });
      const text = new ObservationBuilder().build({
        call: createTestRuntime().toolCall({ name: "RecallSearch", args: {} }),
        raw: result,
      }).displayText;
      expect(text).toContain(`sessionId=${target.sessionId}`);
      expect(text).toContain("do not mix snapshots across sessions");
      expect(text).toContain("partial history");
      appendTurn(target, `${query} later`);
      expect(
        await f.execute("RecallSearch", {
          sessionId: target.sessionId,
          query,
          snapshot_through_ordinal: result.page.snapshotThroughOrdinal,
        }),
      ).toMatchObject({ ok: true, page: { hits: result.page.hits } });
      expect(
        await f.execute("RecallSearch", {
          sessionId: target.sessionId,
          query,
          snapshot_through_ordinal: 999_999,
        }),
      ).toMatchObject({ ok: false, errorCode: "RECALL_SNAPSHOT_INVALID" });
    }
    const defaultResult = await f.execute("RecallSearch", {
      query: "current-only-anchor",
    });
    expect(
      await f.execute("RecallSearch", {
        sessionId: f.current.sessionId,
        query: "current-only-anchor",
      }),
    ).toEqual(defaultResult);
    expect(defaultResult).toMatchObject({
      sessionId: f.current.sessionId,
      workspaceRoot: f.workspaceRoot,
    });
  });

  test("default tooling exposes external Recall without a Memory dependency", async () => {
    const f = await fixture();
    const tooling = createDefaultTooling({
      workspaceRoot: f.workspaceRoot,
      homeRoot: f.homeRoot,
      historyReader: f.current.historyReader(),
      runtimeSession: createTestRuntime().runtimeSession,
    });
    try {
      expect(tooling.registry.get("MemorySearch")).toBeUndefined();
      const result = await tooling.runtime.execute(
        createTestRuntime().toolCall({
          name: "RecallSearch",
          args: { sessionId: f.target.sessionId, query: "target-only-anchor" },
        }),
        { signal },
      );
      expect(result).toMatchObject({
        kind: "recall",
        ok: true,
        sessionId: f.target.sessionId,
      });
    } finally {
      await tooling.dispose();
    }
  });

  test("invalid IDs never fall back; missing targets and home isolation are explicit", async () => {
    const f = await fixture();
    for (const sessionId of [
      null,
      "",
      " ",
      "../escape",
      "a/b",
      42,
      f.target.sessionId.toUpperCase(),
    ]) {
      for (const name of ["RecallSearch", "RecallGet"]) {
        expect(
          await f.execute(name, {
            sessionId,
            ...(name === "RecallSearch"
              ? { query: "current-only-anchor" }
              : { source: formatMessageSource(runtimeIdFactory.createMessageId()) }),
          }),
        ).toMatchObject({ ok: false, errorCode: "RECALL_ARGS_INVALID" });
      }
    }
    expect(
      await f.execute("RecallSearch", {
        sessionId: runtimeIdFactory.createSessionId(),
        query: "anchor",
      }),
    ).toMatchObject({ ok: false, errorCode: "RECALL_SESSION_NOT_FOUND" });
    const isolated = createSessionHistoryAccess({
      historyReader: f.current.historyReader(),
      workspaceRoot: f.workspaceRoot,
      homeRoot: f.otherWorkspace,
    });
    expect(
      isolated.withHistoryReader(f.target.sessionId, signal, () => true),
    ).rejects.toMatchObject({ code: "RECALL_SESSION_NOT_FOUND" });
  });

  test("current ID reuses the reader even with inaccessible home; external IDs never do", async () => {
    const f = await fixture();
    const reader = f.current.historyReader();
    const access = createSessionHistoryAccess({
      historyReader: reader,
      workspaceRoot: f.workspaceRoot,
      homeRoot: "/nonexistent-recall-home",
    });
    for (const id of [undefined, f.current.sessionId]) {
      await access.withHistoryReader(id, signal, (selected) =>
        expect(selected).toBe(reader),
      );
    }
    expect(
      access.withHistoryReader(f.target.sessionId, signal, () => true),
    ).rejects.toMatchObject({ code: "RECALL_SESSION_UNAVAILABLE" });
  });

  test("duplicate IDs remain ambiguous even when a candidate is in the current workspace", async () => {
    const f = await fixture();
    const duplicate = path.join(
      path.dirname(f.current.sessionDirectory),
      f.target.sessionId,
    );
    await cp(f.target.sessionDirectory, duplicate, { recursive: true });
    expect(
      await f.execute("RecallSearch", {
        sessionId: f.target.sessionId,
        query: "anchor",
      }),
    ).toMatchObject({ ok: false, errorCode: "RECALL_SESSION_AMBIGUOUS" });
  });

  test("active WAL and partial turns are readable without taking locks or recovering state", async () => {
    const f = await fixture();
    await f.historyAccess.withHistoryReader(f.target.sessionId, signal, (reader) => {
      const first = reader.search({ query: "snapshot-anchor", limit: 20, offset: 0 });
      appendTurn(f.target, "snapshot-anchor");
      expect(reader.search({ query: "snapshot-anchor", limit: 20, offset: 0 })).toEqual(
        first,
      );
    });
    expect(
      await f.execute("RecallSearch", {
        sessionId: f.target.sessionId,
        query: "snapshot-anchor",
      }),
    ).toMatchObject({
      ok: true,
      page: { hits: [expect.objectContaining({ excerpt: "snapshot-anchor" })] },
    });
    appendTurn(f.target, "open-tail-anchor", true);
    const before = readState(f.target);
    const lock = await readFile(path.join(f.target.sessionDirectory, "active.lock"));
    expect(
      await f.execute("RecallSearch", {
        sessionId: f.target.sessionId,
        query: "open-tail-anchor",
      }),
    ).toMatchObject({
      ok: true,
      page: { hits: [expect.objectContaining({ excerpt: "open-tail-anchor" })] },
    });
    expect(readState(f.target)).toEqual(before);
    expect(await readFile(path.join(f.target.sessionDirectory, "active.lock"))).toEqual(
      lock,
    );
    // Two SQL reads in one access call observe a single committed snapshot.
    await f.historyAccess.withHistoryReader(f.target.sessionId, signal, (reader) => {
      const first = reader.search({ query: "snapshot-anchor", limit: 20, offset: 0 });
      editDatabase(f.target, (db) =>
        db.exec("UPDATE session_meta SET updated_at = 'writer-during-snapshot'"),
      );
      expect(reader.search({ query: "snapshot-anchor", limit: 20, offset: 0 })).toEqual(
        first,
      );
    });
  });

  test("static canonical files stay unchanged and deleted workspaces remain readable", async () => {
    const f = await fixture();
    const cloneId = runtimeIdFactory.createSessionId();
    await f.target.cloneTo({ targetSessionId: cloneId });
    const databasePath = path.join(
      path.dirname(f.target.sessionDirectory),
      cloneId,
      "session.sqlite",
    );
    await f.target.close("tui_exit");
    await rm(f.otherWorkspace, { recursive: true });
    const before = await readFile(databasePath);
    expect(
      await f.execute("RecallSearch", {
        sessionId: cloneId,
        query: "target-only-anchor",
      }),
    ).toMatchObject({ ok: true, workspaceRoot: f.otherWorkspace });
    expect(await readFile(databasePath)).toEqual(before);
  });

  test("rejects unsafe permissions without repair", async () => {
    const f = await fixture();
    for (const file of [
      f.target.sessionDirectory,
      f.target.databasePath,
      `${f.target.databasePath}-wal`,
      `${f.target.databasePath}-shm`,
    ]) {
      const mode = file === f.target.sessionDirectory ? 0o700 : 0o600;
      await chmod(file, mode | 0o044);
      expect(
        await f.execute("RecallSearch", {
          sessionId: f.target.sessionId,
          query: "anchor",
        }),
      ).toMatchObject({ ok: false, errorCode: "RECALL_SESSION_UNAVAILABLE" });
      await chmod(file, mode);
    }
  });

  test("rejects symlinked files and incomplete project scans rather than claiming absence", async () => {
    const f = await fixture();
    await f.target.close("tui_exit");
    await rename(f.target.databasePath, `${f.target.databasePath}.saved`);
    await symlink(`${f.target.databasePath}.saved`, f.target.databasePath);
    expect(
      await f.execute("RecallSearch", {
        sessionId: f.target.sessionId,
        query: "anchor",
      }),
    ).toMatchObject({ ok: false, errorCode: "RECALL_SESSION_UNAVAILABLE" });
    const projects = path.dirname(
      path.dirname(path.dirname(f.current.sessionDirectory)),
    );
    await symlink(f.otherWorkspace, path.join(projects, "alias"));
    expect(
      await f.execute("RecallSearch", {
        sessionId: runtimeIdFactory.createSessionId(),
        query: "anchor",
      }),
    ).toMatchObject({ ok: false, errorCode: "RECALL_SESSION_UNAVAILABLE" });
  });

  test("validates metadata identity, initialization and schema without execution compatibility", async () => {
    const f = await fixture();
    const before = readState(f.target);
    editMetadata(f.target, (db) =>
      db.exec(
        "UPDATE session_meta SET model_name = 'obsolete-model', workspace_root = '/moved/elsewhere'",
      ),
    );
    expect(
      await f.execute("RecallSearch", {
        sessionId: f.target.sessionId,
        query: "anchor",
      }),
    ).toMatchObject({ ok: false, errorCode: "RECALL_SESSION_UNAVAILABLE" });
    editMetadata(f.target, (db) =>
      db.query("UPDATE session_meta SET workspace_root = ?").run(f.otherWorkspace),
    );
    expect(
      await f.execute("RecallSearch", {
        sessionId: f.target.sessionId,
        query: "anchor",
      }),
    ).toMatchObject({ ok: true });
    editDatabase(f.target, (db) => db.exec("PRAGMA user_version = 999"));
    expect(
      await f.execute("RecallSearch", {
        sessionId: f.target.sessionId,
        query: "anchor",
      }),
    ).toMatchObject({ ok: false, errorCode: "RECALL_SESSION_UNSUPPORTED" });
    expect(readState(f.target).schema).toEqual(before.schema);
  });

  test("corrupt content is an ordinary error, exposes no body and leaves current session usable", async () => {
    const f = await fixture();
    const hit = f.target
      .historyReader()
      .search({ query: "target-only-anchor", limit: 10, offset: 0 }).hits[0];
    editDatabase(f.target, (db) => {
      const trigger = db
        .query("SELECT sql FROM sqlite_schema WHERE name = 'messages_no_update'")
        .get() as { sql: string };
      db.exec("DROP TRIGGER messages_no_update");
      db.query("UPDATE messages SET content_sha256 = ? WHERE message_id = ?").run(
        "0".repeat(64),
        hit.messageId,
      );
      db.exec(trigger.sql);
    });
    for (const [name, args] of [
      ["RecallSearch", { query: "target-only-anchor" }],
      ["RecallGet", { source: hit.source }],
    ] as const) {
      const result = await f.execute(name, { ...args, sessionId: f.target.sessionId });
      expect(result).toMatchObject({
        kind: "recall",
        ok: false,
        errorCode: "RECALL_SESSION_UNAVAILABLE",
      });
      expect(JSON.stringify(result)).not.toContain("历史");
    }
    expect(
      await f.execute("RecallSearch", { query: "current-only-anchor" }),
    ).toMatchObject({ ok: true });
    appendTurn(f.current, "still-works");
    const controller = new AbortController();
    controller.abort();
    expect(
      f.execute(
        "RecallSearch",
        { sessionId: f.target.sessionId, query: "anchor" },
        controller.signal,
      ),
    ).rejects.toBeDefined();
    expect(
      f.historyAccess.withHistoryReader(f.target.sessionId, signal, () => {
        throw new Error("callback failure");
      }),
    ).rejects.toMatchObject({ code: "RECALL_SESSION_UNAVAILABLE" });
    // Connection is released even when callback/cancellation fails.
    await f.target.close("tui_exit");
    await rename(f.target.databasePath, `${f.target.databasePath}.released`);
  });

  test("old and new Recall results survive resume/fork unchanged and remain excluded from Recall", async () => {
    const f = await fixture();
    const result = await f.execute("RecallSearch", {
      sessionId: f.target.sessionId,
      query: "target-only-anchor",
    });
    if (result.kind !== "recall" || !result.ok)
      throw new Error("Expected Recall success");
    const {
      sessionId: _sessionId,
      workspaceRoot: _workspaceRoot,
      ...oldResult
    } = result;
    void _sessionId;
    void _workspaceRoot;
    const ledger = new SqliteSessionLedger(f.current, runtimeIdFactory);
    const turn = {
      sessionId: f.current.sessionId,
      turnId: runtimeIdFactory.createTurnId(),
      turnNumber: f.current.nextTurnNumber(),
    };
    const iteration = {
      ...turn,
      iterationId: runtimeIdFactory.createIterationId(),
      iterationNumber: 1,
    };
    const pending = ledger.beginTurn({
      turn,
      userMessage: { role: "user", content: "persist history results" },
    });
    f.current.beginIteration(iteration);
    const calls: ToolCall[] = [oldResult, result].map((_, index) => ({
      ...iteration,
      toolCallId: runtimeIdFactory.createToolCallId(),
      toolCallNumber: index + 1,
      providerToolCallId: `recall-${index}`,
      name: "RecallSearch",
      args: { query: "target-only-anchor" },
    }));
    pending.agent.appendAssistant({
      iteration,
      message: { role: "assistant", toolCalls: calls },
      provider: "test",
      model: "test-model",
    });
    pending.agent.commitToolCompletions(
      [oldResult, result].map((raw: RecallRawResult, index) => ({
        call: calls[index],
        kind: "returned" as const,
        raw: { kind: "recall" as const, ...raw },
        observation: textToolResultContent(`copied-recall-secret ${index}`),
      })),
    );
    f.current.finishIterationForContinuation(iteration);
    const finalIteration = {
      ...turn,
      iterationId: runtimeIdFactory.createIterationId(),
      iterationNumber: 2,
    };
    f.current.beginIteration(finalIteration);
    pending.agent.appendAssistant({
      iteration: finalIteration,
      message: { role: "assistant", content: "done" },
      provider: "test",
      model: "test-model",
    });
    pending.finish({
      status: "completed",
      finalText: "done",
      lastIteration: finalIteration,
    });
    const before = f.current.loadProtocolView().toolResults;
    const cloneId = runtimeIdFactory.createSessionId();
    await f.current.cloneTo({ targetSessionId: cloneId });
    await f.current.close("tui_exit");
    for (const sessionId of [f.current.sessionId, cloneId]) {
      const reopened = await SessionStore.openExisting({
        workspaceRoot: f.workspaceRoot,
        homeRoot: f.homeRoot,
        sessionId,
      });
      stores.push(reopened);
      expect(
        reopened.loadProtocolView().toolResults.map((entry) => entry.completion),
      ).toEqual(before.map((entry) => entry.completion));
      const external = createSessionHistoryAccess({
        historyReader: f.target.historyReader(),
        workspaceRoot: f.otherWorkspace,
        homeRoot: f.homeRoot,
      });
      await external.withHistoryReader(sessionId, signal, (reader) => {
        expect(
          reader.search({ query: "copied-recall-secret", limit: 10, offset: 0 }).hits,
        ).toEqual([]);
      });
    }
  });

  test("rejects mismatched session identity, incomplete initialization and unavailable indexes", async () => {
    const f = await fixture();
    editMetadata(f.target, (db) =>
      db
        .query("UPDATE session_meta SET session_id = ?")
        .run(runtimeIdFactory.createSessionId()),
    );
    expect(
      await f.execute("RecallSearch", {
        sessionId: f.target.sessionId,
        query: "anchor",
      }),
    ).toMatchObject({ ok: false, errorCode: "RECALL_SESSION_UNAVAILABLE" });
    editMetadata(f.target, (db) =>
      db.query("UPDATE session_meta SET session_id = ?").run(f.target.sessionId),
    );
    const unready = await SessionStore.createNew({
      workspaceRoot: f.workspaceRoot,
      homeRoot: f.homeRoot,
      sessionId: runtimeIdFactory.createSessionId(),
      modelName: "test-model",
      systemPrompt: "system",
      idFactory: runtimeIdFactory,
    });
    stores.push(unready);
    expect(
      await f.execute("RecallSearch", {
        sessionId: unready.sessionId,
        query: "anchor",
      }),
    ).toMatchObject({ ok: false, errorCode: "RECALL_SESSION_UNAVAILABLE" });
    editDatabase(f.target, (db) => db.exec("DROP TABLE message_fts"));
    expect(
      await f.execute("RecallSearch", {
        sessionId: f.target.sessionId,
        query: "anchor",
      }),
    ).toMatchObject({ ok: false, errorCode: "RECALL_SESSION_UNAVAILABLE" });
  });

  test("recognized migratable schemas are rejected without migration", async () => {
    const f = await fixture();
    editMetadata(f.target, (db) => {
      const trigger = db
        .query(
          "SELECT sql FROM sqlite_schema WHERE name = 'context_revisions_validate_insert'",
        )
        .get() as { sql: string };
      const previous = trigger.sql.replace(
        `AND (\n                t.status <> 'open' OR (\n                  NOT EXISTS (SELECT 1 FROM iterations WHERE outcome = 'open') AND\n                  NOT EXISTS (SELECT 1 FROM protocol_frames WHERE state = 'open')\n                )\n              )`,
        "AND t.status <> 'open'",
      );
      expect(previous).not.toBe(trigger.sql);
      db.exec("DROP TRIGGER context_revisions_validate_insert");
      db.exec(previous);
      db.query("UPDATE session_meta SET schema_fingerprint = ?").run(
        "263a0415b343a922efc65aab4a3387a8b31de18e82245ce67b9296b7a02f4a26",
      );
    });
    const before = readState(f.target);
    expect(
      await f.execute("RecallSearch", {
        sessionId: f.target.sessionId,
        query: "anchor",
      }),
    ).toMatchObject({ ok: false, errorCode: "RECALL_SESSION_UNSUPPORTED" });
    expect(readState(f.target)).toEqual(before);
  });

  test("busy waits are bounded and cancellation after reading releases the snapshot", async () => {
    const f = await fixture();
    const cloneId = runtimeIdFactory.createSessionId();
    await f.target.cloneTo({ targetSessionId: cloneId });
    const databasePath = path.join(
      path.dirname(f.target.sessionDirectory),
      cloneId,
      "session.sqlite",
    );
    // The clone is standalone DELETE-journal storage with no lingering writer.
    // A separate process is needed: POSIX record locks are process-scoped.
    const blocker = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      const { Database } = require("bun:sqlite");
      const db = new Database(process.argv[1]);
      db.query("PRAGMA wal_checkpoint(TRUNCATE)").all();
      db.query("PRAGMA journal_mode = DELETE").get();
      db.exec("BEGIN EXCLUSIVE");
      console.log("locked", db.inTransaction, JSON.stringify(db.query("PRAGMA journal_mode").get()));
      await Bun.sleep(1500);
      db.exec("ROLLBACK");
      db.close(true);
    `,
        databasePath,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const ready = blocker.stdout.getReader();
    const readiness = new TextDecoder().decode((await ready.read()).value);
    if (!readiness) throw new Error(await new Response(blocker.stderr).text());
    expect(readiness).toContain('locked true {"journal_mode":"delete"}');
    ready.releaseLock();
    try {
      const started = performance.now();
      expect(
        await f.execute("RecallSearch", {
          sessionId: cloneId,
          query: "anchor",
        }),
      ).toMatchObject({ ok: false, errorCode: "RECALL_SESSION_UNAVAILABLE" });
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await blocker.stdin.end();
      expect(await blocker.exited).toBe(0);
    }
    const controller = new AbortController();
    const cancelled = await f.historyAccess
      .withHistoryReader(cloneId, controller.signal, (reader) => {
        reader.search({ query: "anchor", limit: 10, offset: 0 });
        controller.abort();
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(cancelled).toBeInstanceOf(Error);
    const writer = new Database(databasePath);
    try {
      writer.exec("BEGIN EXCLUSIVE; ROLLBACK");
    } finally {
      writer.close();
    }
    expect(
      await f.execute("RecallSearch", {
        sessionId: f.target.sessionId,
        query: "anchor",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await f.execute("RecallSearch", { query: "current-only-anchor" }),
    ).toMatchObject({ ok: true });
  });

  test("unreadable databases are not confused with empty search results", async () => {
    const f = await fixture();
    await f.target.close("tui_exit");
    await rm(`${f.target.databasePath}-wal`, { force: true });
    await rm(`${f.target.databasePath}-shm`, { force: true });
    await writeFile(f.target.databasePath, "not sqlite");
    expect(
      await f.execute("RecallSearch", {
        sessionId: f.target.sessionId,
        query: "anchor",
      }),
    ).toMatchObject({ ok: false, errorCode: "RECALL_SESSION_UNAVAILABLE" });
  });
});
