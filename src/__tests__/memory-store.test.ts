import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { MemoryStore, resolveMemoryPaths } from "../memory/memory-store";
import { buildFtsMatchExpression } from "../memory/memory-store";
import {
  cosineFromNormalized,
  decodeEmbedding,
  encodeEmbedding,
  normalizeEmbedding,
} from "../memory/vector";
import type { SessionId, TurnId } from "../ids/runtime-id";
import { ExtractedMemoryLog, MemoryLog } from "../memory/memory-log";

const EMBEDDING = Object.freeze({
  name: "test-space",
  kind: "openai-compatible" as const,
  model: "test-embedding",
  dimensions: 3,
});

describe("memory vectors", () => {
  test("round-trips normalized Float32 vectors and computes cosine", () => {
    const vector = normalizeEmbedding([3, 4, 0], 3);
    const decoded = decodeEmbedding(encodeEmbedding(vector), 12);

    expect([...decoded]).toEqual([...vector]);
    expect(cosineFromNormalized(vector, decoded)).toBeCloseTo(1, 6);
    expect(cosineFromNormalized(vector, normalizeEmbedding([0, 0, 2], 3))).toBe(0);
  });

  test("rejects invalid dimensions, values, norms, BLOB types, and byte lengths", () => {
    expect(() => normalizeEmbedding([1, 2], 3)).toThrow("expected 3");
    expect(() => normalizeEmbedding([1, Number.NaN, 3], 3)).toThrow("non-finite");
    expect(() => normalizeEmbedding([0, 0, 0], 3)).toThrow("non-zero");
    expect(() => decodeEmbedding("not-a-blob", 12)).toThrow("not a SQLite BLOB");
    expect(() => decodeEmbedding(new Uint8Array(8), 12)).toThrow(
      "8 bytes; expected 12",
    );
  });
});

describe("MemoryStore", () => {
  test("initializes schema v2, writes atomically, deduplicates, searches, and reopens", async () => {
    const fixture = await createFixture();
    try {
      let store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        clock: () => "2026-07-25T10:00:00.000Z",
      });
      const first = store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "Tinker source changes require bun run check.",
            summary: "Turn recorded the Tinker quality gate after a source change.",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });
      const second = store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "The user prefers strict fail-fast configuration.",
            summary: "",
            embedding: normalizeEmbedding([0, 1, 0], 3),
          },
        ],
      });
      expect(first).toMatchObject({ written: 1, duplicate: 0 });
      expect(second).toMatchObject({ written: 1, duplicate: 0 });
      expect(first.inserted.map((memory) => memory.text)).toEqual([
        "Tinker source changes require bun run check.",
      ]);
      expect(
        first.inserted.every(
          (memory) => memory.createdAt === "2026-07-25T10:00:00.000Z",
        ),
      ).toBe(true);

      const duplicate = store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "Tinker source changes require bun run check.",
            summary: "A reworded duplicate summary.",
            embedding: normalizeEmbedding([0, 0, 1], 3),
          },
        ],
      });
      expect(duplicate).toEqual({
        written: 0,
        duplicate: 1,
        inserted: [],
      });
      expect(store.count()).toBe(2);
      const matches = store.search(normalizeEmbedding([0.9, 0.1, 0], 3));
      expect(matches.map((match) => match.text)).toEqual([
        "Tinker source changes require bun run check.",
        "The user prefers strict fail-fast configuration.",
      ]);
      expect(matches[0]).toMatchObject({
        summary: "Turn recorded the Tinker quality gate after a source change.",
        sourceSessionId: fixture.source.sessionId,
      });
      expect(matches[1]).toMatchObject({ summary: "" });
      store.close();

      store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      expect(store.count()).toBe(2);
      expect((await stat(fixture.paths.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(fixture.paths.database)).mode & 0o777).toBe(0o600);
      expect((await stat(fixture.paths.extractedLog)).mode & 0o777).toBe(0o600);
      for (const suffix of ["-wal", "-shm"]) {
        const mode = await stat(`${fixture.paths.database}${suffix}`).then(
          (value) => value.mode & 0o777,
          () => undefined,
        );
        if (mode !== undefined) {
          expect(mode).toBe(0o600);
        }
      }
      store.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("uses deterministic cosine tie-breaks", async () => {
    const fixture = await createFixture();
    const ids = [
      "00000000-0000-7000-8000-00000000000b",
      "00000000-0000-7000-8000-00000000000a",
    ];
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        clock: () => "2026-07-25T10:00:00.000Z",
        createMemoryId: () => ids.shift()!,
      });
      store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "first insertion",
            summary: "",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });
      store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "second insertion",
            summary: "",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });
      expect(
        store.search(normalizeEmbedding([1, 0, 0], 3)).map((match) => match.text),
      ).toEqual(["second insertion", "first insertion"]);
      store.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("lists a complete read-only snapshot in creation and ID order", async () => {
    const fixture = await createFixture();
    const timestamps = [
      "2026-07-25T09:00:00.000Z",
      "2026-07-26T10:00:00.000Z",
      "2026-07-26T10:00:00.000Z",
    ];
    const ids = [
      "00000000-0000-7000-8000-00000000000a",
      "00000000-0000-7000-8000-00000000000b",
      "00000000-0000-7000-8000-00000000000c",
    ];
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        clock: () => timestamps.shift()!,
        createMemoryId: () => ids.shift()!,
      });
      expect(store.listStoredMemories()).toEqual([]);
      store.insertBatch({
        ...fixture.source,
        workspaceRoot: "/workspace/older",
        candidates: [
          {
            text: "older memory",
            summary: "older summary",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });
      store.insertBatch({
        ...fixture.source,
        workspaceRoot: "/workspace/newer",
        candidates: [
          {
            text: "newer first",
            summary: "",
            embedding: normalizeEmbedding([0, 1, 0], 3),
          },
        ],
      });
      store.insertBatch({
        ...fixture.source,
        workspaceRoot: "/workspace/newer",
        candidates: [
          {
            text: "newer second",
            summary: "newer second summary",
            embedding: normalizeEmbedding([0, 0, 1], 3),
          },
        ],
      });

      expect(store.listStoredMemories()).toEqual([
        {
          memoryId: "00000000-0000-7000-8000-00000000000c",
          text: "newer second",
          summary: "newer second summary",
          sourceWorkspace: "/workspace/newer",
          sourceSessionId: fixture.source.sessionId,
          createdAt: "2026-07-26T10:00:00.000Z",
        },
        {
          memoryId: "00000000-0000-7000-8000-00000000000b",
          text: "newer first",
          summary: "",
          sourceWorkspace: "/workspace/newer",
          sourceSessionId: fixture.source.sessionId,
          createdAt: "2026-07-26T10:00:00.000Z",
        },
        {
          memoryId: "00000000-0000-7000-8000-00000000000a",
          text: "older memory",
          summary: "older summary",
          sourceWorkspace: "/workspace/older",
          sourceSessionId: fixture.source.sessionId,
          createdAt: "2026-07-25T09:00:00.000Z",
        },
      ]);
      store.close();
      expect(() => store.listStoredMemories()).toThrow("store is closed");
    } finally {
      await fixture.cleanup();
    }
  });

  test("gets one stored memory by id including its source turn", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        clock: () => "2026-07-25T10:00:00.000Z",
        createMemoryId: () => "00000000-0000-7000-8000-00000000000a",
      });
      store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "stored memory",
            summary: "stored summary",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });

      expect(store.getById("00000000-0000-7000-8000-00000000000a")).toEqual({
        memoryId: "00000000-0000-7000-8000-00000000000a",
        text: "stored memory",
        summary: "stored summary",
        sourceWorkspace: fixture.source.workspaceRoot,
        sourceSessionId: fixture.source.sessionId,
        sourceTurnId: fixture.source.turnId,
        createdAt: "2026-07-25T10:00:00.000Z",
      });
      expect(store.getById("00000000-0000-7000-8000-00000000000b")).toBeUndefined();

      store.close();
      expect(() => store.getById("00000000-0000-7000-8000-00000000000a")).toThrow(
        "store is closed",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test("updates memory content and FTS atomically while preserving identity and unchanged embeddings", async () => {
    const fixture = await createFixture();
    const ids = [
      "00000000-0000-7000-8000-00000000000a",
      "00000000-0000-7000-8000-00000000000b",
    ];
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        clock: () => "2026-07-25T10:00:00.000Z",
        createMemoryId: () => ids.shift()!,
      });
      const firstId = store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "original searchable memory",
            summary: "legacy detail marker",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      }).inserted[0].memoryId;
      const secondId = store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "duplicate target memory",
            summary: "conflict record",
            embedding: normalizeEmbedding([0, 1, 0], 3),
          },
        ],
      }).inserted[0].memoryId;
      const target = store.getByIdForMutation(firstId);
      if (target === undefined) {
        throw new Error("Expected a mutation target.");
      }
      const originalEmbedding = [...target.embedding];
      const originalEmbeddingBytes = storedEmbeddingBytes(
        fixture.paths.database,
        firstId,
      );

      expect(
        store.updateMemory({
          memoryId: firstId,
          text: target.text,
          summary: "replacement detail marker",
          embedding: target.embedding,
        }),
      ).toEqual({ ok: true, memoryId: firstId });
      expect([...store.getByIdForMutation(firstId)!.embedding]).toEqual(
        originalEmbedding,
      );
      expect(storedEmbeddingBytes(fixture.paths.database, firstId)).toEqual(
        originalEmbeddingBytes,
      );
      expect(store.searchFts(["legacy detail"])).toEqual([]);
      expect(store.searchFts(["replacement detail"])[0]?.memoryId).toBe(firstId);

      expect(
        store.updateMemory({
          memoryId: firstId,
          text: "new searchable memory",
          summary: "replacement detail marker",
          embedding: normalizeEmbedding([0, 0, 1], 3),
        }),
      ).toEqual({ ok: true, memoryId: firstId });
      expect(store.searchFts(["original searchable"])).toEqual([]);
      expect(store.searchFts(["new searchable"])[0]?.memoryId).toBe(firstId);
      expect(store.search(normalizeEmbedding([0, 0, 1], 3))[0]?.memoryId).toBe(firstId);
      expect(store.getById(firstId)).toMatchObject({
        memoryId: firstId,
        sourceWorkspace: fixture.source.workspaceRoot,
        sourceSessionId: fixture.source.sessionId,
        sourceTurnId: fixture.source.turnId,
        createdAt: "2026-07-25T10:00:00.000Z",
      });

      expect(
        store.updateMemory({
          memoryId: firstId,
          text: "duplicate target memory",
          summary: "must not be written",
          embedding: normalizeEmbedding([1, 1, 0], 3),
        }),
      ).toEqual({
        ok: false,
        code: "memory_duplicate",
        conflictMemoryId: secondId,
      });
      expect(store.getById(firstId)).toMatchObject({
        text: "new searchable memory",
        summary: "replacement detail marker",
      });
      expect(
        store.updateMemory({
          memoryId: "00000000-0000-7000-8000-00000000000c",
          text: "missing target",
          summary: "",
          embedding: normalizeEmbedding([1, 0, 0], 3),
        }),
      ).toEqual({ ok: false, code: "memory_not_found" });
      store.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("deletes memory with its FTS row and allows the same text to be recreated", async () => {
    const fixture = await createFixture();
    const ids = [
      "00000000-0000-7000-8000-00000000000a",
      "00000000-0000-7000-8000-00000000000b",
    ];
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        createMemoryId: () => ids.shift()!,
      });
      const text = "recreatable deletion target";
      const firstId = store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text,
            summary: "delete this record",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      }).inserted[0].memoryId;

      expect(store.deleteMemory(firstId)).toEqual({
        ok: true,
        memoryId: firstId,
      });
      expect(store.getById(firstId)).toBeUndefined();
      expect(store.searchFts(["deletion target"])).toEqual([]);
      expect(store.deleteMemory(firstId)).toEqual({
        ok: false,
        code: "memory_not_found",
      });

      const recreated = store.insertBatch({
        ...fixture.source,
        candidates: [
          { text, summary: "new record", embedding: normalizeEmbedding([0, 1, 0], 3) },
        ],
      });
      expect(recreated).toMatchObject({ written: 1, duplicate: 0 });
      expect(recreated.inserted[0]?.memoryId).not.toBe(firstId);
      expect(store.searchFts(["deletion target"])).toHaveLength(1);
      store.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("rolls back create, update, and delete when a transaction fails", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        createMemoryId: () => "00000000-0000-7000-8000-00000000000a",
      });
      const database = new Database(fixture.paths.database);
      database.exec(
        "CREATE TRIGGER reject_memory_insert AFTER INSERT ON memories BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END",
      );
      expect(() =>
        store.insertBatch({
          ...fixture.source,
          candidates: [
            {
              text: "rolled back insertion",
              summary: "",
              embedding: normalizeEmbedding([1, 0, 0], 3),
            },
          ],
        }),
      ).toThrow("write transaction failed");
      expect(store.count()).toBe(0);
      expect(store.searchFts(["rolled back"])).toEqual([]);
      database.exec("DROP TRIGGER reject_memory_insert");

      const memoryId = store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "stable transaction target",
            summary: "stable summary",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      }).inserted[0].memoryId;
      database.exec(
        "CREATE TRIGGER reject_memory_update AFTER UPDATE ON memories BEGIN SELECT RAISE(ABORT, 'injected update failure'); END",
      );
      expect(() =>
        store.updateMemory({
          memoryId,
          text: "corrupt update target",
          summary: "corrupt summary",
          embedding: normalizeEmbedding([0, 1, 0], 3),
        }),
      ).toThrow("write transaction failed");
      expect(store.getById(memoryId)).toMatchObject({
        text: "stable transaction target",
        summary: "stable summary",
      });
      expect(store.searchFts(["stable transaction"])).toHaveLength(1);
      expect(store.searchFts(["corrupt update"])).toEqual([]);
      database.exec("DROP TRIGGER reject_memory_update");

      database.exec(
        "CREATE TRIGGER reject_memory_delete AFTER DELETE ON memories BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END",
      );
      expect(() => store.deleteMemory(memoryId)).toThrow("write transaction failed");
      expect(store.getById(memoryId)).toBeDefined();
      expect(store.searchFts(["stable transaction"])).toHaveLength(1);
      database.close();
      store.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("builds FTS match expressions with quoting, escaping, and short-term drops", () => {
    expect(buildFtsMatchExpression(["memory"])).toBe('"memory"');
    expect(buildFtsMatchExpression(['we"ird', "bun run"])).toBe(
      '"we""ird" OR "bun run"',
    );
    expect(buildFtsMatchExpression(["ab", "  ", "x"])).toBeNull();
    expect(buildFtsMatchExpression(["ab", "schema"])).toBe('"schema"');
    expect(buildFtsMatchExpression([])).toBeNull();
  });

  test("syncs inserted rows into the FTS index and skips duplicates", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        clock: () => "2026-07-25T10:00:00.000Z",
      });
      expect(store.ftsAvailable).toBe(true);
      store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "记忆 schema v2 升级需要删除旧库",
            summary: "用户决定不做迁移，直接废弃旧库。",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });
      store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "记忆 schema v2 升级需要删除旧库",
            summary: "重复内容不应进入索引。",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });

      const hits = store.searchFts(["schema v2"]);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        text: "记忆 schema v2 升级需要删除旧库",
        sourceSessionId: fixture.source.sessionId,
      });
      expect(store.searchFts(["不存在的词xyz"])).toEqual([]);
      store.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("creates and backfills the FTS index for an existing v2 database", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        clock: () => "2026-07-25T10:00:00.000Z",
      });
      store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "hybrid recall backfill target",
            summary: "既有记忆，FTS 表缺失时应被回填。",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });
      store.close();

      const external = new Database(fixture.paths.database, { strict: true });
      external.exec("DROP TABLE memories_fts");
      external.close();

      const reopened = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      expect(reopened.ftsAvailable).toBe(true);
      expect(reopened.searchFts(["backfill"])).toHaveLength(1);
      expect(reopened.searchFts(["既有记忆"])).toHaveLength(1);
      reopened.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("rebuilds the FTS index when its structure drifted", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        clock: () => "2026-07-25T10:00:00.000Z",
      });
      store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "结构漂移后中文检索必须恢复",
            summary: "unicode61 cannot segment Chinese text.",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });
      store.close();

      const external = new Database(fixture.paths.database, { strict: true });
      external.exec("DROP TABLE memories_fts");
      external.exec(
        `CREATE VIRTUAL TABLE memories_fts USING fts5(
           text, summary, content='memories', content_rowid='rowid',
           tokenize='unicode61'
         )`,
      );
      external.close();

      const reopened = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      expect(reopened.ftsAvailable).toBe(true);
      expect(reopened.searchFts(["中文检索"])).toHaveLength(1);
      reopened.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("rebuilds the FTS index when its content lags behind memories", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        clock: () => "2026-07-25T10:00:00.000Z",
      });
      store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "lagging index rebuild target",
            summary: "索引行数落后时应触发 rebuild。",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });
      store.close();

      const external = new Database(fixture.paths.database, { strict: true });
      external.exec("DROP TABLE memories_fts");
      external.exec(
        `CREATE VIRTUAL TABLE memories_fts USING fts5(
           text, summary, content='memories', content_rowid='rowid',
           tokenize='trigram'
         )`,
      );
      external.close();

      const reopened = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      expect(reopened.ftsAvailable).toBe(true);
      expect(reopened.searchFts(["rebuild target"])).toHaveLength(1);
      reopened.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("ranks FTS hits with the text column weighted above summary", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        clock: () => "2026-07-25T10:00:00.000Z",
      });
      store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "RRF fusion ranks keyword recall",
            summary: "这条摘要不含目标词组，只有 text 命中。",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });
      store.insertBatch({
        ...fixture.source,
        turnId: "memory-test-turn-2" as TurnId,
        candidates: [
          {
            text: "另一条记忆，主题不同",
            summary: "这条的 summary 提到了 RRF fusion 这个词组。",
            embedding: normalizeEmbedding([0, 1, 0], 3),
          },
        ],
      });

      const hits = store.searchFts(["RRF fusion"]);
      expect(hits).toHaveLength(2);
      expect(hits[0]?.text).toBe("RRF fusion ranks keyword recall");
      expect(hits[1]?.text).toBe("另一条记忆，主题不同");
      store.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("lists memories without decoding embeddings and rejects an invalid row", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        clock: () => "2026-07-25T10:00:00.000Z",
      });
      const inserted = store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "stored memory",
            summary: "",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      }).inserted[0];
      const database = new Database(fixture.paths.database);
      database
        .query("UPDATE memories SET embedding = ? WHERE memory_id = ?")
        .run(new Uint8Array([1]), inserted.memoryId);
      expect(store.listStoredMemories()).toHaveLength(1);

      database
        .query("UPDATE memories SET created_at = ? WHERE memory_id = ?")
        .run("not-a-timestamp", inserted.memoryId);
      database.close();
      expect(() => store.listStoredMemories()).toThrow("UTC ISO-8601 timestamp");
      store.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects batches with more than one candidate without writing", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      expect(() =>
        store.insertBatch({
          ...fixture.source,
          candidates: [
            {
              text: "candidate one",
              summary: "",
              embedding: normalizeEmbedding([1, 0, 0], 3),
            },
            {
              text: "candidate two",
              summary: "",
              embedding: normalizeEmbedding([0, 1, 0], 3),
            },
          ],
        }),
      ).toThrow("at most 1 candidate");
      expect(store.count()).toBe(0);
      store.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("enforces the summary byte limit while allowing an empty summary", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      expect(() =>
        store.insertBatch({
          ...fixture.source,
          candidates: [
            {
              text: "oversized summary candidate",
              summary: "记".repeat(1_366),
              embedding: normalizeEmbedding([1, 0, 0], 3),
            },
          ],
        }),
      ).toThrow("text, summary, or embedding is invalid");
      expect(store.count()).toBe(0);

      const accepted = store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "boundary summary candidate",
            summary: "记".repeat(1_365),
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });
      expect(accepted.written).toBe(1);
      expect(store.search(normalizeEmbedding([1, 0, 0], 3))[0]?.summary).toBe(
        "记".repeat(1_365),
      );
      store.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("supports concurrent WAL connections", async () => {
    const fixture = await createFixture();
    try {
      const first = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      const second = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      first.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "visible through the second connection",
            summary: "",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });
      expect(second.count()).toBe(1);
      first.close();
      second.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("returns a fixed top five without a similarity threshold", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      const candidates = Array.from({ length: 6 }, (_, index) => ({
        text: `candidate ${index}`,
        summary: "",
        embedding: normalizeEmbedding([6 - index, index + 1, 0], 3),
      }));
      for (const candidate of candidates) {
        store.insertBatch({
          ...fixture.source,
          candidates: [candidate],
        });
      }

      const matches = store.search(normalizeEmbedding([1, 0, 0], 3));
      expect(matches).toHaveLength(5);
      expect(matches.map((match) => match.text)).not.toContain("candidate 5");
      store.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects incompatible embedding identity without changing the database", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      store.close();

      for (const mismatch of [
        { ...EMBEDDING, name: "other-space" },
        { ...EMBEDDING, model: "other-model" },
        { ...EMBEDDING, dimensions: 4 },
      ]) {
        expect(
          MemoryStore.open({
            paths: fixture.paths,
            embedding: mismatch,
          }),
        ).rejects.toMatchObject({
          code: "memory_embedding_identity_mismatch",
        });
      }
      const reopened = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      expect(reopened.count()).toBe(0);
      reopened.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects a schema v1 database with a deletion directive", async () => {
    const fixture = await createFixture();
    try {
      await mkdir(fixture.paths.directory, { recursive: true, mode: 0o700 });
      const database = new Database(fixture.paths.database, {
        create: true,
        readwrite: true,
        strict: true,
      });
      database.exec(`CREATE TABLE memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT`);
      database.exec(`CREATE TABLE memories (
        memory_id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        text_sha256 TEXT NOT NULL UNIQUE,
        embedding BLOB NOT NULL,
        source_workspace TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_turn_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT`);
      database.exec(`CREATE INDEX memories_created_at
      ON memories(created_at DESC)`);
      const insert = database.query(
        "INSERT INTO memory_meta(key, value) VALUES (?, ?)",
      );
      insert.run("schema_version", "1");
      insert.run("embedding_profile", EMBEDDING.name);
      insert.run("embedding_kind", EMBEDDING.kind);
      insert.run("embedding_model", EMBEDDING.model);
      insert.run("embedding_dimensions", String(EMBEDDING.dimensions));
      database.close();
      await chmod(fixture.paths.database, 0o600);

      const error = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "memory_schema_unsupported" });
      expect((error as Error).message).toContain(fixture.paths.database);
      expect((error as Error).message).toContain("-wal");
      expect((error as Error).message).toContain("restart");
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects a v2-shaped database whose metadata predates schema v2", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      store.close();
      const database = new Database(fixture.paths.database);
      database
        .query("UPDATE memory_meta SET value = ? WHERE key = ?")
        .run("1", "schema_version");
      database.close();

      const error = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "memory_schema_unsupported" });
      expect((error as Error).message).toContain("Delete");
      expect((error as Error).message).toContain(fixture.paths.database);
    } finally {
      await fixture.cleanup();
    }
  });

  test("allows embedding API routing and credentials to rotate", async () => {
    const fixture = await createFixture();
    const initialEmbedding = {
      ...EMBEDDING,
      apiBase: "https://first.example.test/v1",
      apiKey: "first-key",
    };
    const rotatedEmbedding = {
      ...EMBEDDING,
      apiBase: "https://proxy.example.test/v1",
      apiKey: "rotated-key",
    };
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: initialEmbedding,
      });
      store.insertBatch({
        ...fixture.source,
        candidates: [
          {
            text: "Identity remains stable across provider routing changes.",
            summary: "",
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
        ],
      });
      store.close();

      const reopened = await MemoryStore.open({
        paths: fixture.paths,
        embedding: rotatedEmbedding,
      });
      expect(reopened.count()).toBe(1);
      reopened.close();
    } finally {
      await fixture.cleanup();
    }
  });

  test("refuses insecure existing permissions instead of repairing them", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      store.close();
      await chmod(fixture.paths.database, 0o644);

      expect(
        MemoryStore.open({
          paths: fixture.paths,
          embedding: EMBEDDING,
        }),
      ).rejects.toMatchObject({ code: "memory_path_insecure" });
      expect((await stat(fixture.paths.database)).mode & 0o777).toBe(0o644);
    } finally {
      await fixture.cleanup();
    }
  });

  test("degrades when schema initialization cannot acquire the write lock", async () => {
    const fixture = await createFixture();
    let holder: Database | undefined;
    try {
      const initialized = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      initialized.close();
      holder = new Database(fixture.paths.database, {
        create: false,
        readwrite: true,
      });
      holder.exec("PRAGMA journal_mode = WAL");
      holder.exec("BEGIN IMMEDIATE");

      expect(
        MemoryStore.open({
          paths: fixture.paths,
          embedding: EMBEDDING,
          busyTimeoutMs: 20,
        }),
      ).rejects.toMatchObject({ code: "memory_store_busy" });
      holder.exec("ROLLBACK");
      holder.close();
      holder = undefined;

      const reopened = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      reopened.close();
    } finally {
      if (holder !== undefined) {
        holder.exec("ROLLBACK");
        holder.close();
      }
      await fixture.cleanup();
    }
  });

  test("swallows diagnostic write failures without repairing insecure paths", async () => {
    const fixture = await createFixture();
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
      });
      store.close();
      await chmod(fixture.paths.directory, 0o755);
      const log = new MemoryLog(fixture.paths.log);

      expect(
        log.append({
          at: "2026-07-25T10:00:00.000Z",
          kind: "init",
          outcome: "failed",
          reason: "memory_path_insecure",
        }),
      ).resolves.toBeUndefined();
      expect((await stat(fixture.paths.directory)).mode & 0o777).toBe(0o755);
      const exists = await stat(fixture.paths.log).then(
        () => true,
        () => false,
      );
      expect(exists).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test("writes extracted memories as compact private text blocks", async () => {
    const fixture = await createFixture();
    try {
      const log = new ExtractedMemoryLog(fixture.paths.extractedLog);
      await log.append({
        at: "2026-07-25T10:00:00.000Z",
        workspace: fixture.source.workspaceRoot,
        turnId: fixture.source.turnId,
        memories: [
          {
            memoryId: "00000000-0000-7000-8000-000000000001",
            text: "First memory\nwith a second line.",
            createdAt: "2026-07-25T10:00:00.000Z",
          },
          {
            memoryId: "00000000-0000-7000-8000-000000000002",
            text: "Second memory.",
            createdAt: "2026-07-25T10:00:00.000Z",
          },
        ],
      });

      expect(await readFile(fixture.paths.extractedLog, "utf8")).toBe(
        [
          `[2026-07-25T10:00:00.000Z] workspace=${JSON.stringify(fixture.source.workspaceRoot)} turn=memory-test-turn written=2`,
          '- 00000000-0000-7000-8000-000000000001 | "First memory\\nwith a second line."',
          '- 00000000-0000-7000-8000-000000000002 | "Second memory."',
          "",
          "",
        ].join("\n"),
      );
      expect((await stat(fixture.paths.extractedLog)).mode & 0o777).toBe(0o600);
    } finally {
      await fixture.cleanup();
    }
  });
});

async function createFixture() {
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "tinker-memory-store-"));
  const workspaceRoot = path.join(homeRoot, "workspace");
  return {
    paths: resolveMemoryPaths(homeRoot),
    source: {
      workspaceRoot,
      sessionId: "memory-test-session" as SessionId,
      turnId: "memory-test-turn" as TurnId,
    },
    cleanup: () => rm(homeRoot, { recursive: true }),
  };
}

function storedEmbeddingBytes(databasePath: string, memoryId: string): number[] {
  const database = new Database(databasePath);
  try {
    const row = database
      .query("SELECT embedding FROM memories WHERE memory_id = ?")
      .get(memoryId);
    if (
      typeof row !== "object" ||
      row === null ||
      !("embedding" in row) ||
      !(row.embedding instanceof Uint8Array)
    ) {
      throw new Error(`Missing stored memory ${memoryId}.`);
    }
    return [...row.embedding];
  } finally {
    database.close();
  }
}
