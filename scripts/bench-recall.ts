import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { formatMessageSource } from "../src/context/context-source";
import { contentHash } from "../src/context/protocol-frame";
import { runtimeIdFactory, type MessageId } from "../src/ids/runtime-id";
import { createSessionHistoryReader } from "../src/session/session-history-reader";
import {
  SESSION_SCHEMA_V2_FINGERPRINT,
  SESSION_SCHEMA_VERSION,
  configureWritableDatabase,
  createSessionSchema,
  rebuildRecallIndex,
  verifyRecallIndex,
  verifySessionSchema,
  verifySqliteIntegrity,
} from "../src/session/session-schema";

const messageCount = positiveInteger(Bun.argv[2], 10_000, "message count");
const sampleCount = positiveInteger(Bun.argv[3], 100, "sample count");
const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-recall-bench-"));
const databasePath = path.join(directory, "session.sqlite");
let database: Database | undefined;

try {
  database = new Database(databasePath, { create: true, strict: true, safeIntegers: true });
  configureWritableDatabase(database);
  createSessionSchema(database);
  const sessionId = runtimeIdFactory.createSessionId();
  const revisionId = runtimeIdFactory.createContextRevisionId();
  const timestamp = "2026-07-12T00:00:00.000Z";
  database
    .query(
      `INSERT INTO session_meta (
         singleton, schema_version, schema_fingerprint, initialization_state,
         session_id, workspace_root, model_name, system_prompt_sha256,
         tool_schema_sha256, runtime_contract_json, runtime_contract_sha256,
         active_revision_id, next_turn_number, next_event_sequence, open_count,
         created_at, updated_at, last_opened_at, last_closed_at, last_close_reason
       ) VALUES (1, ?, ?, 'creating', ?, ?, 'benchmark-model', ?, NULL, NULL, NULL,
         ?, ?, 1, 1, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      SESSION_SCHEMA_VERSION,
      SESSION_SCHEMA_V2_FINGERPRINT,
      sessionId,
      directory,
      contentHash("benchmark system prompt"),
      revisionId,
      messageCount + 1,
      timestamp,
      timestamp,
      timestamp,
    );
  database
    .query(
      `INSERT INTO context_revisions (
         revision_id, session_id, revision_number, kind, keep_from_ordinal, created_at
       ) VALUES (?, ?, 1, 'initial_full', 1, ?)`,
    )
    .run(revisionId, sessionId, timestamp);
  insertSystemMessage(database, sessionId, timestamp);
  const baselineBytes = sqliteAllocatedBytes(database);

  let largeMessageId: MessageId | undefined;
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

  const openStartedAt = performance.now();
  database = new Database(databasePath, {
    readwrite: true,
    strict: true,
    safeIntegers: true,
  });
  configureWritableDatabase(database);
  verifySessionSchema(database, sessionId);
  verifySqliteIntegrity(database, sessionId);
  verifyRecallIndex(database, sessionId);
  const openValidationMs = performance.now() - openStartedAt;

  let open = true;
  const reader = createSessionHistoryReader({
    database,
    sessionId,
    requireOpen: () => {
      if (!open) {
        throw new Error("benchmark database is closed");
      }
    },
  });
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
    throw new Error("Benchmark did not create its large message.");
  }
  reader.get({
    source: formatMessageSource(largeMessageId),
    byteOffset: 0,
    byteLimit: 20_000,
  });
  const rssAfterGet = process.memoryUsage().rss;

  const rebuildStartedAt = performance.now();
  rebuildRecallIndex(database, sessionId);
  verifyRecallIndex(database, sessionId);
  const rebuildMs = performance.now() - rebuildStartedAt;
  open = false;
  database.close();
  database = undefined;

  console.log(
    JSON.stringify(
      {
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
          openSchemaSqliteAndIndexValidation: round(openValidationMs),
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
          sampledPeakDelta:
            Math.max(rssAfterSearch, rssAfterGet) - rssBeforePages,
        },
      },
      null,
      2,
    ),
  );
} finally {
  database?.close();
  await rm(directory, { recursive: true });
}

function insertSystemMessage(
  database: Database,
  sessionId: string,
  timestamp: string,
): void {
  const frameId = runtimeIdFactory.createProtocolFrameId();
  const content = "benchmark system prompt";
  database
    .query(
      `INSERT INTO protocol_frames (
         frame_id, session_id, turn_id, iteration_id, kind, state,
         first_ordinal, last_ordinal, created_at, closed_at
       ) VALUES (?, ?, NULL, NULL, 'system', 'closed', 1, 1, ?, ?)`,
    )
    .run(frameId, sessionId, timestamp, timestamp);
  database
    .query(
      `INSERT INTO messages (
         message_id, session_id, frame_id, ordinal, role, turn_id, iteration_id,
         content, content_sha256, reasoning_content, reasoning_content_present,
         tool_calls_json, provider, model, tool_call_id, provider_tool_call_id,
         name, origin, created_at
       ) VALUES (?, ?, ?, 1, 'system', NULL, NULL, ?, ?, NULL, 0,
         NULL, NULL, NULL, NULL, NULL, NULL, 'runtime', ?)`,
    )
    .run(
      runtimeIdFactory.createMessageId(),
      sessionId,
      frameId,
      content,
      contentHash(content),
      timestamp,
    );
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

function percentiles(values: number[]): { p50: number; p95: number } {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: round(sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0),
    p95: round(sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0),
  };
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Recall benchmark ${name} must be a positive safe integer.`);
  }
  return parsed;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
