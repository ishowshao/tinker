import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { createUuidV7, isCanonicalUuidV7 } from "../ids/uuid-v7";
import {
  MAX_MEMORIES_PER_TURN,
  MAX_MEMORY_TEXT_BYTES,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SEARCH_LIMIT,
  MemoryError,
  type MemoryEmbeddingIdentity,
  type MemoryPaths,
  type MemorySearchMatch,
  type MemoryWriteBatch,
  type MemoryWriteResult,
} from "./contracts";
import {
  cosineFromNormalized,
  decodeEmbedding,
  encodeEmbedding,
  expectedEmbeddingBlobBytes,
} from "./vector";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

const CREATE_MEMORY_META_SQL = `CREATE TABLE memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT`;

const CREATE_MEMORIES_SQL = `CREATE TABLE memories (
  memory_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL UNIQUE,
  embedding BLOB NOT NULL,
  source_workspace TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT`;

const CREATE_MEMORIES_INDEX_SQL = `CREATE INDEX memories_created_at
ON memories(created_at DESC)`;

const EXPECTED_SCHEMA = new Map([
  ["index:memories_created_at", CREATE_MEMORIES_INDEX_SQL],
  ["table:memories", CREATE_MEMORIES_SQL],
  ["table:memory_meta", CREATE_MEMORY_META_SQL],
]);

export type OpenMemoryStoreInput = {
  readonly paths?: MemoryPaths;
  readonly embedding: MemoryEmbeddingIdentity;
  readonly busyTimeoutMs?: number;
  readonly clock?: () => string;
  readonly createMemoryId?: () => string;
};

export function resolveMemoryPaths(homeRoot = os.homedir()): MemoryPaths {
  const directory = path.join(homeRoot, ".tinker", "memory");
  return Object.freeze({
    directory,
    database: path.join(directory, "memory.sqlite"),
    log: path.join(directory, "memory-log.jsonl"),
    extractedLog: path.join(directory, "extracted-memories.log"),
  });
}

export class MemoryStore {
  readonly paths: MemoryPaths;
  readonly dimensions: number;
  private closed = false;

  private constructor(
    private readonly database: Database,
    input: Required<Pick<OpenMemoryStoreInput, "clock" | "createMemoryId">> & {
      readonly paths: MemoryPaths;
      readonly embedding: MemoryEmbeddingIdentity;
    },
  ) {
    this.paths = input.paths;
    this.dimensions = input.embedding.dimensions;
    this.clock = input.clock;
    this.createMemoryId = input.createMemoryId;
  }

  private readonly clock: () => string;
  private readonly createMemoryId: () => string;

  static async open(input: OpenMemoryStoreInput): Promise<MemoryStore> {
    const paths = input.paths ?? resolveMemoryPaths();
    validateMemoryPaths(paths);
    validateEmbeddingIdentity(input.embedding);
    const busyTimeoutMs = input.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1) {
      throw new MemoryError(
        "memory_store_config_invalid",
        "Memory SQLite busy timeout must be a positive safe integer.",
      );
    }

    await ensurePrivateDirectory(paths.directory);
    await validatePrivateOptionalFile(paths.log);
    await validatePrivateOptionalFile(paths.extractedLog);
    await validatePrivateOptionalFile(`${paths.database}-wal`);
    await validatePrivateOptionalFile(`${paths.database}-shm`);
    await ensurePrivateFile(paths.database);

    const walExisted = await pathExists(`${paths.database}-wal`);
    const shmExisted = await pathExists(`${paths.database}-shm`);
    let database: Database | undefined;
    try {
      database = new Database(paths.database, {
        create: false,
        readwrite: true,
        strict: true,
        safeIntegers: true,
      });
      configureDatabase(database, busyTimeoutMs);
      initializeOrVerifySchema(database, input.embedding);
      await secureCreatedAuxiliaryFile(`${paths.database}-wal`, walExisted);
      await secureCreatedAuxiliaryFile(`${paths.database}-shm`, shmExisted);
      await validatePrivateFile(paths.database);
      await ensurePrivateFile(paths.extractedLog);
      return new MemoryStore(database, {
        paths,
        embedding: Object.freeze({ ...input.embedding }),
        clock: input.clock ?? (() => new Date().toISOString()),
        createMemoryId: input.createMemoryId ?? createUuidV7,
      });
    } catch (error) {
      database?.close();
      if (error instanceof MemoryError) {
        throw error;
      }
      const code =
        sqliteCode(error) === "SQLITE_BUSY"
          ? "memory_store_busy"
          : "memory_store_open_failed";
      throw new MemoryError(code, "Global memory store could not be opened.", {
        cause: error,
      });
    }
  }

  insertBatch(input: MemoryWriteBatch): MemoryWriteResult {
    this.requireOpen();
    validateWriteBatch(input, this.dimensions);
    if (input.candidates.length === 0) {
      return Object.freeze({
        written: 0,
        duplicate: 0,
        inserted: Object.freeze([]),
      });
    }

    const createdAt = this.clock();
    requireUtcTimestamp(createdAt, "Memory creation timestamp");
    const inserted: MemoryWriteResult["inserted"][number][] = [];
    runImmediateTransaction(this.database, () => {
      const insert = this.database.query(
        `INSERT INTO memories (
           memory_id, text, text_sha256, embedding, source_workspace,
           source_session_id, source_turn_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(text_sha256) DO NOTHING`,
      );
      for (const candidate of input.candidates) {
        const memoryId = this.createMemoryId();
        if (!isCanonicalUuidV7(memoryId)) {
          throw new MemoryError(
            "memory_write_failed",
            "Memory ID factory did not produce a UUIDv7.",
          );
        }
        const result = insert.run(
          memoryId,
          candidate.text,
          sha256(candidate.text),
          encodeEmbedding(candidate.embedding),
          input.workspaceRoot,
          input.sessionId,
          input.turnId,
          createdAt,
        );
        const changes = Number(result.changes);
        if (changes !== 0 && changes !== 1) {
          throw new MemoryError(
            "memory_write_failed",
            `Memory insert changed ${changes} rows.`,
          );
        }
        if (changes === 1) {
          inserted.push(
            Object.freeze({
              memoryId,
              text: candidate.text,
              createdAt,
            }),
          );
        }
      }
    });
    return Object.freeze({
      written: inserted.length,
      duplicate: input.candidates.length - inserted.length,
      inserted: Object.freeze(inserted),
    });
  }

  search(
    queryEmbedding: Float32Array,
    limit = MEMORY_SEARCH_LIMIT,
  ): readonly MemorySearchMatch[] {
    this.requireOpen();
    if (
      queryEmbedding.length !== this.dimensions ||
      [...queryEmbedding].some((value) => !Number.isFinite(value))
    ) {
      throw new MemoryError(
        "memory_embedding_dimensions_invalid",
        "Query embedding does not match the memory embedding space.",
      );
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new MemoryError(
        "memory_search_limit_invalid",
        "Memory search limit must be a positive safe integer.",
      );
    }

    const expectedBlobBytes = expectedEmbeddingBlobBytes(this.dimensions);
    const matches: MemorySearchMatch[] = [];
    const rows = this.database
      .query(
        `SELECT memory_id, text, embedding, source_workspace, created_at
         FROM memories`,
      )
      .iterate();
    for (const rowValue of rows) {
      const row = sqlRecord(rowValue, "memory row");
      const embedding = decodeEmbedding(row.embedding, expectedBlobBytes);
      matches.push(
        Object.freeze({
          memoryId: sqlString(row.memory_id, "memory_id"),
          text: sqlString(row.text, "memory text"),
          score: cosineFromNormalized(queryEmbedding, embedding),
          sourceWorkspace: sqlString(row.source_workspace, "memory source_workspace"),
          createdAt: requireUtcTimestamp(
            sqlString(row.created_at, "memory created_at"),
            "memory created_at",
          ),
        }),
      );
    }
    matches.sort(
      (left, right) =>
        right.score - left.score ||
        right.createdAt.localeCompare(left.createdAt) ||
        left.memoryId.localeCompare(right.memoryId),
    );
    return Object.freeze(matches.slice(0, limit));
  }

  count(): number {
    this.requireOpen();
    const row = this.database.query("SELECT COUNT(*) AS count FROM memories").get();
    const count = sqlRecord(row, "memory count").count;
    const number = typeof count === "bigint" ? Number(count) : count;
    if (!Number.isSafeInteger(number) || (number as number) < 0) {
      throw new MemoryError("memory_store_read_failed", "Memory count is invalid.");
    }
    return number as number;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.database.close();
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new MemoryError("memory_store_closed", "Global memory store is closed.");
    }
  }
}

function configureDatabase(database: Database, busyTimeoutMs: number): void {
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  const busyRow = sqlRecord(
    database.query("PRAGMA busy_timeout").get(),
    "busy_timeout",
  );
  if (!Object.values(busyRow).some((value) => Number(value) === busyTimeoutMs)) {
    throw new MemoryError(
      "memory_wal_unavailable",
      "SQLite busy timeout could not be enabled.",
    );
  }

  const walRow = sqlRecord(
    database.query("PRAGMA journal_mode = WAL").get(),
    "journal_mode",
  );
  if (
    !Object.values(walRow).some(
      (value) => typeof value === "string" && value.toLowerCase() === "wal",
    )
  ) {
    throw new MemoryError(
      "memory_wal_unavailable",
      "SQLite WAL mode could not be enabled.",
    );
  }
}

function initializeOrVerifySchema(
  database: Database,
  embedding: MemoryEmbeddingIdentity,
): void {
  let started = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    started = true;
    const objects = applicationSchemaObjects(database);
    if (objects.length === 0) {
      database.exec(CREATE_MEMORY_META_SQL);
      database.exec(CREATE_MEMORIES_SQL);
      database.exec(CREATE_MEMORIES_INDEX_SQL);
      const insert = database.query(
        "INSERT INTO memory_meta(key, value) VALUES (?, ?)",
      );
      for (const [key, value] of metadataEntries(embedding)) {
        insert.run(key, value);
      }
    }
    verifySchema(database, embedding);
    database.exec("COMMIT");
    started = false;
  } catch (error) {
    if (started) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the initialization failure.
      }
    }
    if (error instanceof MemoryError) {
      throw error;
    }
    const code =
      sqliteCode(error) === "SQLITE_BUSY"
        ? "memory_store_busy"
        : "memory_schema_invalid";
    throw new MemoryError(code, "Global memory schema initialization failed.", {
      cause: error,
    });
  }
}

function verifySchema(database: Database, embedding: MemoryEmbeddingIdentity): void {
  const objects = applicationSchemaObjects(database);
  if (objects.length !== EXPECTED_SCHEMA.size) {
    throw new MemoryError(
      "memory_schema_invalid",
      "Global memory schema has unexpected objects.",
    );
  }
  for (const row of objects) {
    const key = `${row.type}:${row.name}`;
    const expected = EXPECTED_SCHEMA.get(key);
    if (expected === undefined || normalizeSql(row.sql) !== normalizeSql(expected)) {
      throw new MemoryError(
        "memory_schema_invalid",
        `Global memory schema object ${key} is incompatible.`,
      );
    }
  }

  const rows = database
    .query("SELECT key, value FROM memory_meta ORDER BY key")
    .all()
    .map((value) => sqlRecord(value, "memory metadata"));
  const actual = new Map(
    rows.map((row) => [
      sqlString(row.key, "memory metadata key"),
      sqlString(row.value, "memory metadata value"),
    ]),
  );
  const expected = new Map(metadataEntries(embedding));
  if (
    actual.size !== expected.size ||
    [...expected].some(([key, value]) => actual.get(key) !== value)
  ) {
    const identityKeys = [
      "embedding_profile",
      "embedding_kind",
      "embedding_model",
      "embedding_dimensions",
    ];
    const identityMismatch = identityKeys.some(
      (key) => actual.has(key) && actual.get(key) !== expected.get(key),
    );
    throw new MemoryError(
      identityMismatch ? "memory_embedding_identity_mismatch" : "memory_schema_invalid",
      identityMismatch
        ? "Configured embedding profile does not match the existing global memory database."
        : "Global memory metadata is invalid.",
    );
  }

  const storedDimensions = Number(actual.get("embedding_dimensions"));
  expectedEmbeddingBlobBytes(storedDimensions);
}

function applicationSchemaObjects(
  database: Database,
): Array<{ readonly type: string; readonly name: string; readonly sql: string }> {
  return database
    .query(
      `SELECT type, name, sql
       FROM sqlite_schema
       WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all()
    .map((value) => {
      const row = sqlRecord(value, "memory schema object");
      return Object.freeze({
        type: sqlString(row.type, "memory schema type"),
        name: sqlString(row.name, "memory schema name"),
        sql: sqlString(row.sql, "memory schema SQL"),
      });
    });
}

function metadataEntries(
  embedding: MemoryEmbeddingIdentity,
): readonly (readonly [string, string])[] {
  return Object.freeze([
    Object.freeze(["schema_version", String(MEMORY_SCHEMA_VERSION)] as const),
    Object.freeze(["embedding_profile", embedding.name] as const),
    Object.freeze(["embedding_kind", embedding.kind] as const),
    Object.freeze(["embedding_model", embedding.model] as const),
    Object.freeze(["embedding_dimensions", String(embedding.dimensions)] as const),
  ]);
}

function runImmediateTransaction(database: Database, operation: () => void): void {
  let started = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    started = true;
    operation();
    database.exec("COMMIT");
    started = false;
  } catch (error) {
    if (started) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the write failure.
      }
    }
    if (error instanceof MemoryError) {
      throw error;
    }
    throw new MemoryError(
      sqliteCode(error) === "SQLITE_BUSY" ? "memory_store_busy" : "memory_write_failed",
      "Global memory write transaction failed.",
      { cause: error },
    );
  }
}

function validateWriteBatch(input: MemoryWriteBatch, dimensions: number): void {
  if (!path.isAbsolute(input.workspaceRoot)) {
    throw new MemoryError(
      "memory_write_invalid",
      "Memory source workspace must be absolute.",
    );
  }
  if (input.sessionId.trim() === "" || input.turnId.trim() === "") {
    throw new MemoryError(
      "memory_write_invalid",
      "Memory source session and turn IDs must not be empty.",
    );
  }
  if (input.candidates.length > MAX_MEMORIES_PER_TURN) {
    throw new MemoryError(
      "memory_write_invalid",
      `A memory batch may contain at most ${MAX_MEMORIES_PER_TURN} candidates.`,
    );
  }
  for (const candidate of input.candidates) {
    if (
      candidate.text.trim() !== candidate.text ||
      Buffer.byteLength(candidate.text, "utf8") < 1 ||
      Buffer.byteLength(candidate.text, "utf8") > MAX_MEMORY_TEXT_BYTES ||
      candidate.embedding.length !== dimensions
    ) {
      throw new MemoryError(
        "memory_write_invalid",
        "Memory candidate text or embedding is invalid.",
      );
    }
  }
}

function validateEmbeddingIdentity(identity: MemoryEmbeddingIdentity): void {
  if (
    identity.name.trim() === "" ||
    identity.model.trim() === "" ||
    identity.kind !== "openai-compatible" ||
    !Number.isSafeInteger(identity.dimensions) ||
    identity.dimensions < 1
  ) {
    throw new MemoryError(
      "memory_store_config_invalid",
      "Memory embedding identity is invalid.",
    );
  }
  expectedEmbeddingBlobBytes(identity.dimensions);
}

function validateMemoryPaths(paths: MemoryPaths): void {
  if (
    !path.isAbsolute(paths.directory) ||
    paths.database !== path.join(paths.directory, "memory.sqlite") ||
    paths.log !== path.join(paths.directory, "memory-log.jsonl") ||
    paths.extractedLog !== path.join(paths.directory, "extracted-memories.log")
  ) {
    throw new MemoryError(
      "memory_store_config_invalid",
      "Global memory paths are invalid.",
    );
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (created !== undefined) {
    await chmod(directory, 0o700);
  }
  const state = await lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new MemoryError(
      "memory_path_insecure",
      "Global memory path is not a real directory.",
    );
  }
  if ((state.mode & 0o777) !== 0o700) {
    throw new MemoryError(
      "memory_path_insecure",
      "Global memory directory permissions must be 0700.",
    );
  }
}

async function ensurePrivateFile(filePath: string): Promise<void> {
  try {
    const handle = await open(filePath, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  await validatePrivateFile(filePath);
}

async function validatePrivateOptionalFile(filePath: string): Promise<void> {
  if (await pathExists(filePath)) {
    await validatePrivateFile(filePath);
  }
}

async function validatePrivateFile(filePath: string): Promise<void> {
  const state = await lstat(filePath);
  if (!state.isFile() || state.isSymbolicLink() || (state.mode & 0o777) !== 0o600) {
    throw new MemoryError(
      "memory_path_insecure",
      `Global memory file permissions must be 0600: ${filePath}.`,
    );
  }
}

async function secureCreatedAuxiliaryFile(
  filePath: string,
  existed: boolean,
): Promise<void> {
  if (!(await pathExists(filePath))) {
    return;
  }
  if (!existed) {
    await chmod(filePath, 0o600);
  }
  await validatePrivateFile(filePath);
}

async function pathExists(filePath: string): Promise<boolean> {
  return lstat(filePath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
}

function normalizeSql(sql: string): string {
  return sql.replaceAll(/\s+/g, " ").replace(/;$/, "").trim();
}

function sqlRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MemoryError("memory_store_read_failed", `${name} must be a SQLite row.`);
  }
  return value as Record<string, unknown>;
}

function sqlString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new MemoryError(
      "memory_store_read_failed",
      `${name} must be a non-empty string.`,
    );
  }
  return value;
}

function requireUtcTimestamp(value: string, name: string): string {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    throw new MemoryError(
      "memory_store_read_failed",
      `${name} must be a UTC ISO-8601 timestamp.`,
    );
  }
  return value;
}

function sqliteCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
