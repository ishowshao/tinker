import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { MemoryStore, resolveMemoryPaths } from "../memory/memory-store";
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
  test("initializes schema v1, writes atomically, deduplicates, searches, and reopens", async () => {
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
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
          {
            text: "The user prefers strict fail-fast configuration.",
            embedding: normalizeEmbedding([0, 1, 0], 3),
          },
        ],
      });
      expect(first).toMatchObject({ written: 2, duplicate: 0 });
      expect(first.inserted.map((memory) => memory.text)).toEqual([
        "Tinker source changes require bun run check.",
        "The user prefers strict fail-fast configuration.",
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
      expect(
        store.search(normalizeEmbedding([0.9, 0.1, 0], 3)).map((match) => match.text),
      ).toEqual([
        "Tinker source changes require bun run check.",
        "The user prefers strict fail-fast configuration.",
      ]);
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
            embedding: normalizeEmbedding([1, 0, 0], 3),
          },
          {
            text: "second insertion",
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
    const timestamps = ["2026-07-25T09:00:00.000Z", "2026-07-26T10:00:00.000Z"];
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
            embedding: normalizeEmbedding([0, 1, 0], 3),
          },
          {
            text: "newer second",
            embedding: normalizeEmbedding([0, 0, 1], 3),
          },
        ],
      });

      expect(store.listStoredMemories()).toEqual([
        {
          memoryId: "00000000-0000-7000-8000-00000000000c",
          text: "newer second",
          sourceWorkspace: "/workspace/newer",
          createdAt: "2026-07-26T10:00:00.000Z",
        },
        {
          memoryId: "00000000-0000-7000-8000-00000000000b",
          text: "newer first",
          sourceWorkspace: "/workspace/newer",
          createdAt: "2026-07-26T10:00:00.000Z",
        },
        {
          memoryId: "00000000-0000-7000-8000-00000000000a",
          text: "older memory",
          sourceWorkspace: "/workspace/older",
          createdAt: "2026-07-25T09:00:00.000Z",
        },
      ]);
      store.close();
      expect(() => store.listStoredMemories()).toThrow("store is closed");
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

  test("rolls back the whole batch when a later insert fails", async () => {
    const fixture = await createFixture();
    const duplicateId = "00000000-0000-7000-8000-000000000001";
    try {
      const store = await MemoryStore.open({
        paths: fixture.paths,
        embedding: EMBEDDING,
        createMemoryId: () => duplicateId,
      });
      expect(() =>
        store.insertBatch({
          ...fixture.source,
          candidates: [
            {
              text: "candidate one",
              embedding: normalizeEmbedding([1, 0, 0], 3),
            },
            {
              text: "candidate two",
              embedding: normalizeEmbedding([0, 1, 0], 3),
            },
          ],
        }),
      ).toThrow();
      expect(store.count()).toBe(0);
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
        embedding: normalizeEmbedding([6 - index, index + 1, 0], 3),
      }));
      store.insertBatch({
        ...fixture.source,
        candidates: candidates.slice(0, 4),
      });
      store.insertBatch({
        ...fixture.source,
        candidates: candidates.slice(4),
      });

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
