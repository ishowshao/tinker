import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatMessageSource } from "../src/context/context-source";
import { contentHash } from "../src/context/protocol-frame";
import { runtimeIdFactory, type MessageId } from "../src/ids/runtime-id";
import {
  deriveModelContextBudget,
  type ModelContextProfile,
} from "../src/model/model-context-profile";
import { sha256 } from "../src/model/model-request-preflight";
import {
  configureWritableDatabase,
  rebuildRecallIndex,
  SESSION_SCHEMA_VERSION,
  verifyRecallIndex,
  verifySessionSchema,
  verifySqliteIntegrity,
} from "../src/session/session-schema";
import { createRuntimeContract, SessionStore } from "../src/session/session-store";

const benchmarkSystemPrompt = "Recall benchmark system prompt";
const benchmarkModelName = "g0-recall-benchmark-model";
const benchmarkContextProfile: ModelContextProfile = {
  contextWindowTokens: 1_024 * 1_024,
  maxSupportedOutputTokens: 128 * 1_024,
};
const benchmarkContextBudget = deriveModelContextBudget(benchmarkContextProfile);

export type RecallBenchmarkResult = {
  schemaVersion: number;
  messageCount: number;
  sampleCount: number;
  databaseBytes: {
    baseline: number;
    populated: number;
    increment: number;
    recallFts: number | null;
    file: number;
  };
  timingMs: {
    insert: number;
    openSchemaSqliteAndIndexValidation: number;
    openSessionStoreValidation: number;
    rebuildAndVerify: number;
    firstSearchAfterOpen: number;
    trigramSearch: Percentiles;
    denseTrigramSearch: Percentiles & { sampleCount: number };
    oneCodePointSubstringSearch: Percentiles;
  };
  sampledMemoryBytes: {
    rssBeforePages: number;
    rssAfterSearch: number;
    rssAfterGet: number;
    sampledPeakDelta: number;
  };
};

export async function runRecallBenchmark(
  messageCount = 10_000,
  sampleCount = 100,
): Promise<RecallBenchmarkResult> {
  requirePositiveInteger(messageCount, "message count");
  requirePositiveInteger(sampleCount, "sample count");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-recall-bench-"));
  const sessionId = runtimeIdFactory.createSessionId();
  let database: Database | undefined;
  let store: SessionStore | undefined;

  try {
    const bootstrap = await SessionStore.createNew({
      workspaceRoot: workspace,
      sessionId,
      modelName: benchmarkModelName,
      systemPrompt: benchmarkSystemPrompt,
      idFactory: runtimeIdFactory,
    });
    bootstrap.finalizeRuntimeContract(
      createRuntimeContract({
        modelName: benchmarkModelName,
        profileName: "g0-recall-benchmark",
        includeReasoningContent: false,
        contextProfile: benchmarkContextProfile,
        contextBudget: benchmarkContextBudget,
        systemPrompt: benchmarkSystemPrompt,
        toolSchemaSha256: sha256("g0-recall-benchmark-tools"),
        requestConfigSha256: sha256("g0-recall-benchmark-request"),
      }),
    );
    const databasePath = bootstrap.databasePath;
    await bootstrap.close("tui_exit");

    database = openWritableDatabase(databasePath);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const baselineBytes = sqliteAllocatedBytes(database);
    let largeMessageId: MessageId | undefined;
    const timestamp = "2026-07-16T00:00:00.000Z";
    const insertStartedAt = performance.now();
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 1; index <= messageCount; index += 1) {
        const messageId = insertBenchmarkMessage(
          database,
          sessionId,
          index,
          timestamp,
          index === messageCount,
        );
        if (index === messageCount) {
          largeMessageId = messageId;
        }
      }
      database
        .query(
          `UPDATE session_meta
           SET next_turn_number = ?, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(messageCount + 1, timestamp);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const insertMs = performance.now() - insertStartedAt;
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const populatedBytes = sqliteAllocatedBytes(database);
    const ftsBytes = recallFtsBytes(database);
    database.close();
    database = undefined;

    const lowLevelOpenStartedAt = performance.now();
    database = openWritableDatabase(databasePath);
    verifySessionSchema(database, sessionId);
    verifySqliteIntegrity(database, sessionId);
    verifyRecallIndex(database, sessionId);
    const lowLevelOpenValidationMs = performance.now() - lowLevelOpenStartedAt;
    database.close();
    database = undefined;

    const sessionStoreOpenStartedAt = performance.now();
    store = await SessionStore.openExisting({
      workspaceRoot: workspace,
      sessionId,
    });
    const sessionStoreOpenValidationMs = performance.now() - sessionStoreOpenStartedAt;
    const reader = store.historyReader();
    const sparseQuery = `message-${Math.ceil(messageCount / 2)
      .toString()
      .padStart(5, "0")}`;
    const firstSearchStartedAt = performance.now();
    reader.search({ query: sparseQuery, limit: 20, offset: 0 });
    const firstSearchMs = performance.now() - firstSearchStartedAt;
    const trigramSamples = sample(sampleCount, () =>
      reader.search({ query: sparseQuery, limit: 20, offset: 0 }),
    );
    const denseTrigramSampleCount = Math.min(sampleCount, 3);
    const denseTrigramSamples = sample(denseTrigramSampleCount, () =>
      reader.search({ query: "benchmark-keyword", limit: 20, offset: 0 }),
    );
    const substringSamples = sample(sampleCount, () =>
      reader.search({ query: "中", limit: 20, offset: 0 }),
    );

    Bun.gc(true);
    const rssBeforePages = process.memoryUsage().rss;
    reader.search({ query: "group-00000", limit: 20, offset: 0 });
    const rssAfterSearch = process.memoryUsage().rss;
    if (largeMessageId === undefined) {
      throw new Error("Recall benchmark did not create its large message.");
    }
    reader.get({
      source: formatMessageSource(largeMessageId),
      byteOffset: 0,
      byteLimit: 20_000,
    });
    const rssAfterGet = process.memoryUsage().rss;
    await store.close("tui_exit");
    store = undefined;

    database = openWritableDatabase(databasePath);
    const rebuildStartedAt = performance.now();
    rebuildRecallIndex(database, sessionId);
    verifyRecallIndex(database, sessionId);
    const rebuildMs = performance.now() - rebuildStartedAt;
    database.close();
    database = undefined;

    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      messageCount,
      sampleCount,
      databaseBytes: {
        baseline: baselineBytes,
        populated: populatedBytes,
        increment: populatedBytes - baselineBytes,
        recallFts: ftsBytes,
        file: (await stat(databasePath)).size,
      },
      timingMs: {
        insert: round(insertMs),
        openSchemaSqliteAndIndexValidation: round(lowLevelOpenValidationMs),
        openSessionStoreValidation: round(sessionStoreOpenValidationMs),
        rebuildAndVerify: round(rebuildMs),
        firstSearchAfterOpen: round(firstSearchMs),
        trigramSearch: percentiles(trigramSamples),
        denseTrigramSearch: {
          sampleCount: denseTrigramSampleCount,
          ...percentiles(denseTrigramSamples),
        },
        oneCodePointSubstringSearch: percentiles(substringSamples),
      },
      sampledMemoryBytes: {
        rssBeforePages,
        rssAfterSearch,
        rssAfterGet,
        sampledPeakDelta: Math.max(rssAfterSearch, rssAfterGet) - rssBeforePages,
      },
    };
  } finally {
    database?.close();
    await store?.abandon().catch(() => undefined);
    await rm(workspace, { recursive: true });
  }
}

function insertBenchmarkMessage(
  database: Database,
  sessionId: string,
  turnNumber: number,
  timestamp: string,
  large: boolean,
): MessageId {
  const turnId = runtimeIdFactory.createTurnId();
  const frameId = runtimeIdFactory.createProtocolFrameId();
  const messageId = runtimeIdFactory.createMessageId();
  const ordinal = turnNumber + 1;
  const group = `group-${Math.floor((turnNumber - 1) / 20)
    .toString()
    .padStart(5, "0")}`;
  const message = `message-${turnNumber.toString().padStart(5, "0")}`;
  const content = large
    ? `benchmark-keyword 中 ${group} ${message} large-page-marker ${"x".repeat(25_000)}`
    : `benchmark-keyword 中 ${group} ${message}`;
  database
    .query(
      `INSERT INTO turns (
         session_id, turn_id, turn_number, status, next_iteration_number,
         last_iteration_id, final_message_id, terminal_detail_json,
         started_at, finished_at
       ) VALUES (?, ?, ?, 'failed', 1, NULL, NULL, '{}', ?, ?)`,
    )
    .run(sessionId, turnId, turnNumber, timestamp, timestamp);
  database
    .query(
      `INSERT INTO protocol_frames (
         frame_id, session_id, turn_id, iteration_id, kind, state,
         first_ordinal, last_ordinal, created_at, closed_at
       ) VALUES (?, ?, ?, NULL, 'user', 'closed', ?, ?, ?, ?)`,
    )
    .run(frameId, sessionId, turnId, ordinal, ordinal, timestamp, timestamp);
  database
    .query(
      `INSERT INTO messages (
         message_id, session_id, frame_id, ordinal, role, turn_id, iteration_id,
         content, content_sha256, reasoning_content, reasoning_content_present,
         tool_calls_json, provider, model, tool_call_id, provider_tool_call_id,
         name, origin, created_at
       ) VALUES (?, ?, ?, ?, 'user', ?, NULL, ?, ?, NULL, 0,
         NULL, NULL, NULL, NULL, NULL, NULL, 'user', ?)`,
    )
    .run(
      messageId,
      sessionId,
      frameId,
      ordinal,
      turnId,
      content,
      contentHash(content),
      timestamp,
    );
  return messageId;
}

function openWritableDatabase(databasePath: string): Database {
  const database = new Database(databasePath, {
    readwrite: true,
    strict: true,
    safeIntegers: true,
  });
  configureWritableDatabase(database);
  return database;
}

function sqliteAllocatedBytes(database: Database): number {
  const pageCount = pragmaNumber(database, "page_count");
  const pageSize = pragmaNumber(database, "page_size");
  return pageCount * pageSize;
}

function recallFtsBytes(database: Database): number | null {
  try {
    const row = database
      .query(
        `SELECT SUM(pgsize) AS bytes FROM dbstat
         WHERE name IN (
           'message_fts_data', 'message_fts_idx',
           'message_fts_docsize', 'message_fts_config'
         )`,
      )
      .get() as { bytes: number | bigint | null };
    return row.bytes === null ? null : Number(row.bytes);
  } catch {
    return null;
  }
}

function pragmaNumber(database: Database, name: string): number {
  const row = database.query(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Number(Object.values(row)[0]);
}

function sample(count: number, operation: () => unknown): number[] {
  const durations: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    operation();
    durations.push(performance.now() - startedAt);
  }
  return durations;
}

function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: round(sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0),
    p95: round(sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0),
  };
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Recall benchmark ${name} must be a positive safe integer.`);
  }
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  requirePositiveInteger(parsed, name);
  return parsed;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

type Percentiles = { p50: number; p95: number };

if (import.meta.main) {
  const messageCount = parsePositiveInteger(Bun.argv[2], 10_000, "message count");
  const sampleCount = parsePositiveInteger(Bun.argv[3], 100, "sample count");
  console.log(
    JSON.stringify(await runRecallBenchmark(messageCount, sampleCount), null, 2),
  );
}
