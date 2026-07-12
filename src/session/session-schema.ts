import type { Database } from "bun:sqlite";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import type { SessionId } from "../ids/runtime-id";
import { SessionError } from "./session-errors";

export const SESSION_APPLICATION_ID = 0x544b5231;
export const SESSION_SCHEMA_VERSION = 3;

type SchemaDefinition = {
  type: "table" | "index" | "trigger" | "view";
  name: string;
  sql: string;
};

const RECALL_FTS_SHADOW_OBJECTS = [
  { type: "table", name: "message_fts_config" },
  { type: "table", name: "message_fts_data" },
  { type: "table", name: "message_fts_docsize" },
  { type: "table", name: "message_fts_idx" },
] as const;

const RECALL_FTS_CONFIG = [{ key: "version", value: 4 }] as const;

const schemaDefinitions: readonly SchemaDefinition[] = [
  {
    type: "table",
    name: "session_meta",
    sql: `CREATE TABLE session_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 3),
      schema_fingerprint TEXT NOT NULL,
      initialization_state TEXT NOT NULL CHECK (initialization_state IN ('creating', 'ready')),
      session_id TEXT NOT NULL UNIQUE,
      workspace_root TEXT NOT NULL,
      model_name TEXT NOT NULL,
      system_prompt_sha256 TEXT NOT NULL,
      tool_schema_sha256 TEXT,
      runtime_contract_json TEXT,
      runtime_contract_sha256 TEXT,
      active_revision_id TEXT NOT NULL,
      next_turn_number INTEGER NOT NULL CHECK (next_turn_number >= 1),
      next_event_sequence INTEGER NOT NULL CHECK (next_event_sequence >= 1),
      open_count INTEGER NOT NULL CHECK (open_count >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_opened_at TEXT NOT NULL,
      last_closed_at TEXT,
      last_close_reason TEXT CHECK (last_close_reason IS NULL OR last_close_reason IN (
        'oneshot_complete', 'tui_exit', 'session_switch', 'runner_failed', 'initialization_failed'
      )),
      CHECK ((runtime_contract_json IS NULL) = (runtime_contract_sha256 IS NULL)),
      CHECK ((initialization_state = 'creating') OR runtime_contract_json IS NOT NULL)
    ) STRICT`,
  },
  {
    type: "table",
    name: "turns",
    sql: `CREATE TABLE turns (
      session_id TEXT NOT NULL,
      turn_id TEXT PRIMARY KEY,
      turn_number INTEGER NOT NULL CHECK (turn_number >= 1),
      status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'failed', 'cancelled', 'interrupted')),
      next_iteration_number INTEGER NOT NULL CHECK (next_iteration_number >= 1),
      last_iteration_id TEXT,
      final_message_id TEXT,
      terminal_detail_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (session_id, turn_number),
      FOREIGN KEY (session_id) REFERENCES session_meta(session_id),
      FOREIGN KEY (final_message_id) REFERENCES messages(message_id),
      CHECK ((status = 'open') = (finished_at IS NULL))
    ) STRICT`,
  },
  {
    type: "table",
    name: "iterations",
    sql: `CREATE TABLE iterations (
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      iteration_id TEXT PRIMARY KEY,
      iteration_number INTEGER NOT NULL CHECK (iteration_number >= 1),
      outcome TEXT NOT NULL CHECK (outcome IN ('open', 'continue', 'completed', 'failed', 'cancelled', 'interrupted')),
      next_tool_call_number INTEGER NOT NULL CHECK (next_tool_call_number >= 1),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (turn_id, iteration_number),
      FOREIGN KEY (session_id) REFERENCES session_meta(session_id),
      FOREIGN KEY (turn_id) REFERENCES turns(turn_id),
      CHECK ((outcome = 'open') = (finished_at IS NULL))
    ) STRICT`,
  },
  {
    type: "table",
    name: "protocol_frames",
    sql: `CREATE TABLE protocol_frames (
      frame_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      iteration_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('system', 'user', 'assistant_text', 'tool_exchange')),
      state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
      first_ordinal INTEGER NOT NULL CHECK (first_ordinal >= 1),
      last_ordinal INTEGER,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      FOREIGN KEY (session_id) REFERENCES session_meta(session_id),
      FOREIGN KEY (turn_id) REFERENCES turns(turn_id),
      FOREIGN KEY (iteration_id) REFERENCES iterations(iteration_id),
      CHECK ((state = 'open' AND last_ordinal IS NULL AND closed_at IS NULL) OR
             (state = 'closed' AND last_ordinal IS NOT NULL AND closed_at IS NOT NULL)),
      CHECK (last_ordinal IS NULL OR last_ordinal >= first_ordinal)
    ) STRICT`,
  },
  {
    type: "table",
    name: "messages",
    sql: `CREATE TABLE messages (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      frame_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
      turn_id TEXT,
      iteration_id TEXT,
      content TEXT,
      content_sha256 TEXT NOT NULL,
      reasoning_content TEXT,
      reasoning_content_present INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_content_present IN (0, 1)),
      tool_calls_json TEXT,
      provider TEXT,
      model TEXT,
      tool_call_id TEXT,
      provider_tool_call_id TEXT,
      name TEXT,
      origin TEXT NOT NULL CHECK (origin IN ('runtime', 'user', 'model', 'tool')),
      created_at TEXT NOT NULL,
      UNIQUE (session_id, ordinal),
      FOREIGN KEY (session_id) REFERENCES session_meta(session_id),
      FOREIGN KEY (frame_id) REFERENCES protocol_frames(frame_id),
      FOREIGN KEY (turn_id) REFERENCES turns(turn_id),
      FOREIGN KEY (iteration_id) REFERENCES iterations(iteration_id),
      CHECK (tool_calls_json IS NULL OR json_valid(tool_calls_json)),
      CHECK (
        (role = 'system' AND turn_id IS NULL AND iteration_id IS NULL AND content IS NOT NULL AND
          reasoning_content IS NULL AND reasoning_content_present = 0 AND tool_calls_json IS NULL AND provider IS NULL AND model IS NULL AND
          tool_call_id IS NULL AND provider_tool_call_id IS NULL AND name IS NULL AND origin = 'runtime') OR
        (role = 'user' AND turn_id IS NOT NULL AND iteration_id IS NULL AND content IS NOT NULL AND
          reasoning_content IS NULL AND reasoning_content_present = 0 AND tool_calls_json IS NULL AND provider IS NULL AND model IS NULL AND
          tool_call_id IS NULL AND provider_tool_call_id IS NULL AND name IS NULL AND origin = 'user') OR
        (role = 'assistant' AND turn_id IS NOT NULL AND iteration_id IS NOT NULL AND
          provider IS NOT NULL AND model IS NOT NULL AND tool_call_id IS NULL AND
          provider_tool_call_id IS NULL AND name IS NULL AND origin = 'model') OR
        (role = 'tool' AND turn_id IS NOT NULL AND iteration_id IS NOT NULL AND content IS NOT NULL AND
          reasoning_content IS NULL AND reasoning_content_present = 0 AND tool_calls_json IS NULL AND provider IS NULL AND model IS NULL AND
          tool_call_id IS NOT NULL AND provider_tool_call_id IS NOT NULL AND name IS NOT NULL AND
          origin IN ('tool', 'runtime'))
      )
    ) STRICT`,
  },
  {
    type: "table",
    name: "tool_results",
    sql: `CREATE TABLE tool_results (
      tool_call_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      frame_id TEXT NOT NULL,
      tool_message_id TEXT NOT NULL UNIQUE,
      completion_kind TEXT NOT NULL CHECK (completion_kind IN ('returned', 'synthetic')),
      raw_json TEXT,
      raw_sha256 TEXT,
      observation_format TEXT,
      synthetic_reason TEXT CHECK (synthetic_reason IS NULL OR synthetic_reason IN (
        'cancelled_active', 'skipped_after_cancel', 'failed_active', 'skipped_after_failure',
        'interrupted_active', 'skipped_after_interruption'
      )),
      synthetic_detail TEXT,
      observation_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session_meta(session_id),
      FOREIGN KEY (frame_id) REFERENCES protocol_frames(frame_id),
      FOREIGN KEY (tool_message_id) REFERENCES messages(message_id),
      CHECK (raw_json IS NULL OR json_valid(raw_json)),
      CHECK (
        (completion_kind = 'returned' AND raw_json IS NOT NULL AND raw_sha256 IS NOT NULL AND
          observation_format = 'tool-observation-v2' AND synthetic_reason IS NULL AND synthetic_detail IS NULL) OR
        (completion_kind = 'synthetic' AND raw_json IS NULL AND raw_sha256 IS NULL AND
          observation_format IS NULL AND synthetic_reason IS NOT NULL)
      ),
      CHECK ((synthetic_reason = 'failed_active') = (synthetic_detail IS NOT NULL))
    ) STRICT`,
  },
  {
    type: "table",
    name: "context_revisions",
    sql: `CREATE TABLE context_revisions (
      revision_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL CHECK (revision_number = 1),
      kind TEXT NOT NULL CHECK (kind = 'initial_full'),
      keep_from_ordinal INTEGER NOT NULL CHECK (keep_from_ordinal = 1),
      created_at TEXT NOT NULL,
      UNIQUE (session_id, revision_number),
      FOREIGN KEY (session_id) REFERENCES session_meta(session_id)
    ) STRICT`,
  },
  {
    type: "table",
    name: "context_measurement_state",
    sql: `CREATE TABLE context_measurement_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      session_id TEXT NOT NULL UNIQUE,
      revision_id TEXT NOT NULL,
      total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
      prompt_tokens INTEGER NOT NULL CHECK (prompt_tokens >= 0),
      completion_tokens INTEGER NOT NULL CHECK (completion_tokens >= 0),
      segment_count INTEGER NOT NULL CHECK (segment_count >= 0),
      prefix_hash TEXT NOT NULL CHECK (length(prefix_hash) = 64),
      request_config_hash TEXT NOT NULL CHECK (length(request_config_hash) = 64),
      tool_schema_hash TEXT NOT NULL CHECK (length(tool_schema_hash) = 64),
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session_meta(session_id),
      FOREIGN KEY (revision_id) REFERENCES context_revisions(revision_id),
      CHECK (total_tokens = prompt_tokens + completion_tokens)
    ) STRICT`,
  },
  {
    type: "index",
    name: "idx_frames_session_ordinal",
    sql: "CREATE INDEX idx_frames_session_ordinal ON protocol_frames(session_id, first_ordinal)",
  },
  {
    type: "index",
    name: "idx_messages_frame_ordinal",
    sql: "CREATE INDEX idx_messages_frame_ordinal ON messages(frame_id, ordinal)",
  },
  {
    type: "index",
    name: "idx_turns_session_recent",
    sql: "CREATE INDEX idx_turns_session_recent ON turns(session_id, turn_number DESC)",
  },
  {
    type: "view",
    name: "recall_documents",
    sql: `CREATE VIEW recall_documents AS
      SELECT rowid AS docid, content
      FROM messages
      WHERE role IN ('user', 'assistant', 'tool')
        AND content IS NOT NULL
        AND length(content) > 0
        AND NOT (role = 'tool' AND name = 'Recall')`,
  },
  {
    type: "table",
    name: "message_fts",
    sql: `CREATE VIRTUAL TABLE message_fts USING fts5(
      content,
      content='recall_documents',
      content_rowid='docid',
      tokenize='trigram'
    )`,
  },
  {
    type: "trigger",
    name: "messages_recall_index",
    sql: `CREATE TRIGGER messages_recall_index
      AFTER INSERT ON messages
      WHEN NEW.role IN ('user', 'assistant', 'tool')
        AND NEW.content IS NOT NULL
        AND length(NEW.content) > 0
        AND NOT (NEW.role = 'tool' AND NEW.name = 'Recall')
      BEGIN
        INSERT INTO message_fts(rowid, content)
        VALUES (NEW.rowid, NEW.content);
      END`,
  },
  ...immutableTriggers("messages"),
  ...immutableTriggers("tool_results"),
  ...immutableTriggers("context_revisions"),
  {
    type: "trigger",
    name: "protocol_frames_no_delete",
    sql: `CREATE TRIGGER protocol_frames_no_delete BEFORE DELETE ON protocol_frames
      BEGIN SELECT RAISE(ABORT, 'protocol_frames are immutable'); END`,
  },
  {
    type: "trigger",
    name: "protocol_frames_monotonic_update",
    sql: `CREATE TRIGGER protocol_frames_monotonic_update BEFORE UPDATE ON protocol_frames
      WHEN NOT (
        OLD.state = 'open' AND NEW.state = 'closed' AND
        OLD.frame_id = NEW.frame_id AND OLD.session_id = NEW.session_id AND
        OLD.turn_id IS NEW.turn_id AND OLD.iteration_id IS NEW.iteration_id AND
        OLD.kind = NEW.kind AND OLD.first_ordinal = NEW.first_ordinal AND
        OLD.created_at = NEW.created_at AND OLD.last_ordinal IS NULL AND
        NEW.last_ordinal IS NOT NULL AND OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL
      )
      BEGIN SELECT RAISE(ABORT, 'invalid protocol frame transition'); END`,
  },
  {
    type: "trigger",
    name: "turns_no_delete",
    sql: `CREATE TRIGGER turns_no_delete BEFORE DELETE ON turns
      BEGIN SELECT RAISE(ABORT, 'turns cannot be deleted'); END`,
  },
  {
    type: "trigger",
    name: "turns_monotonic_update",
    sql: `CREATE TRIGGER turns_monotonic_update BEFORE UPDATE ON turns
      WHEN NOT (
        OLD.session_id = NEW.session_id AND OLD.turn_id = NEW.turn_id AND
        OLD.turn_number = NEW.turn_number AND OLD.started_at = NEW.started_at AND
        ((OLD.status = 'open' AND
          NEW.status IN ('open', 'completed', 'failed', 'cancelled', 'interrupted') AND
          NEW.next_iteration_number >= OLD.next_iteration_number AND
          (OLD.last_iteration_id IS NULL OR NEW.last_iteration_id = OLD.last_iteration_id OR NEW.status = 'open') AND
          OLD.final_message_id IS NULL AND OLD.terminal_detail_json IS NULL AND OLD.finished_at IS NULL) OR
         (OLD.status <> 'open' AND NEW.status = OLD.status AND
          NEW.next_iteration_number = OLD.next_iteration_number AND
          NEW.last_iteration_id IS OLD.last_iteration_id AND
          NEW.final_message_id IS OLD.final_message_id AND
          NEW.terminal_detail_json IS OLD.terminal_detail_json AND
          NEW.finished_at = OLD.finished_at))
      )
      BEGIN SELECT RAISE(ABORT, 'invalid turn transition'); END`,
  },
  {
    type: "trigger",
    name: "iterations_no_delete",
    sql: `CREATE TRIGGER iterations_no_delete BEFORE DELETE ON iterations
      BEGIN SELECT RAISE(ABORT, 'iterations cannot be deleted'); END`,
  },
  {
    type: "trigger",
    name: "iterations_monotonic_update",
    sql: `CREATE TRIGGER iterations_monotonic_update BEFORE UPDATE ON iterations
      WHEN NOT (
        OLD.session_id = NEW.session_id AND OLD.turn_id = NEW.turn_id AND
        OLD.iteration_id = NEW.iteration_id AND
        OLD.iteration_number = NEW.iteration_number AND OLD.started_at = NEW.started_at AND
        ((OLD.outcome = 'open' AND
          NEW.outcome IN ('open', 'continue', 'completed', 'failed', 'cancelled', 'interrupted') AND
          NEW.next_tool_call_number >= OLD.next_tool_call_number AND OLD.finished_at IS NULL) OR
         (OLD.outcome <> 'open' AND NEW.outcome = OLD.outcome AND
          NEW.next_tool_call_number = OLD.next_tool_call_number AND
          NEW.finished_at = OLD.finished_at))
      )
      BEGIN SELECT RAISE(ABORT, 'invalid iteration transition'); END`,
  },
  {
    type: "trigger",
    name: "session_meta_no_delete",
    sql: `CREATE TRIGGER session_meta_no_delete BEFORE DELETE ON session_meta
      BEGIN SELECT RAISE(ABORT, 'session metadata cannot be deleted'); END`,
  },
  {
    type: "trigger",
    name: "session_meta_monotonic_update",
    sql: `CREATE TRIGGER session_meta_monotonic_update BEFORE UPDATE ON session_meta
      WHEN NOT (
        OLD.singleton = NEW.singleton AND OLD.schema_version = NEW.schema_version AND
        OLD.schema_fingerprint = NEW.schema_fingerprint AND OLD.session_id = NEW.session_id AND
        OLD.workspace_root = NEW.workspace_root AND OLD.model_name = NEW.model_name AND
        OLD.system_prompt_sha256 = NEW.system_prompt_sha256 AND
        OLD.active_revision_id = NEW.active_revision_id AND OLD.created_at = NEW.created_at AND
        NEW.next_turn_number >= OLD.next_turn_number AND
        NEW.next_event_sequence >= OLD.next_event_sequence AND
        NEW.open_count >= OLD.open_count AND
        ((OLD.initialization_state = 'creating' AND NEW.initialization_state IN ('creating', 'ready')) OR
         (OLD.initialization_state = 'ready' AND NEW.initialization_state = 'ready')) AND
        (OLD.tool_schema_sha256 IS NULL OR NEW.tool_schema_sha256 = OLD.tool_schema_sha256) AND
        (OLD.runtime_contract_json IS NULL OR NEW.runtime_contract_json = OLD.runtime_contract_json) AND
        (OLD.runtime_contract_sha256 IS NULL OR NEW.runtime_contract_sha256 = OLD.runtime_contract_sha256)
      )
      BEGIN SELECT RAISE(ABORT, 'invalid session metadata transition'); END`,
  },
];

export const SESSION_SCHEMA_V3_FINGERPRINT = sha256(
  stableJsonStringify({
    definitions: schemaDefinitions.map((definition) => ({
      type: definition.type,
      name: definition.name,
      sql: normalizeSql(definition.sql),
    })),
    recallFts: {
      config: RECALL_FTS_CONFIG,
      shadowObjects: RECALL_FTS_SHADOW_OBJECTS,
    },
  }),
);

export function configureWritableDatabase(database: Database): void {
  database.exec("PRAGMA foreign_keys = ON");
  const journal = singlePragmaValue(database, "PRAGMA journal_mode = WAL");
  if (String(journal).toLowerCase() !== "wal") {
    throw new Error(`SQLite did not enable WAL mode; received ${String(journal)}.`);
  }
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA busy_timeout = 0");
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA wal_autocheckpoint = 1000");
}

export function createSessionSchema(database: Database): void {
  database.exec(`PRAGMA application_id = ${SESSION_APPLICATION_ID}`);
  database.exec(`PRAGMA user_version = ${SESSION_SCHEMA_VERSION}`);
  for (const definition of schemaDefinitions) {
    database.exec(definition.sql);
  }
}

export function verifySessionSchema(database: Database, sessionId?: SessionId): void {
  const applicationId = Number(singlePragmaValue(database, "PRAGMA application_id"));
  const userVersion = Number(singlePragmaValue(database, "PRAGMA user_version"));
  if (
    applicationId !== SESSION_APPLICATION_ID ||
    userVersion !== SESSION_SCHEMA_VERSION
  ) {
    throw new SessionError(
      "SESSION_SCHEMA_UNSUPPORTED",
      "verify_schema",
      `Unsupported session schema identity application_id=${applicationId} user_version=${userVersion}.`,
      { sessionId },
    );
  }

  const actual = database
    .query(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all() as Array<{ type: string; name: string; sql: string }>;
  const actualByName = new Map(
    actual.map((entry) => [`${entry.type}:${entry.name}`, normalizeSql(entry.sql)]),
  );
  for (const expected of schemaDefinitions) {
    const actualSql = actualByName.get(`${expected.type}:${expected.name}`);
    if (actualSql !== normalizeSql(expected.sql)) {
      throw new SessionError(
        "SESSION_SCHEMA_INVALID",
        "verify_schema",
        `Session schema definition does not match: ${expected.type} ${expected.name}.`,
        { sessionId },
      );
    }
    actualByName.delete(`${expected.type}:${expected.name}`);
  }
  for (const shadow of RECALL_FTS_SHADOW_OBJECTS) {
    const key = `${shadow.type}:${shadow.name}`;
    if (!actualByName.has(key)) {
      throw new SessionError(
        "SESSION_SCHEMA_INVALID",
        "verify_schema",
        `Session schema is missing FTS shadow object: ${key}.`,
        { sessionId },
      );
    }
    actualByName.delete(key);
  }
  if (actualByName.size > 0) {
    throw new SessionError(
      "SESSION_SCHEMA_INVALID",
      "verify_schema",
      `Session schema contains unexpected definitions: ${[...actualByName.keys()].join(", ")}.`,
      { sessionId },
    );
  }

  const actualFtsConfig = database
    .query("SELECT k, v FROM message_fts_config ORDER BY k")
    .all()
    .map((entry) => {
      const row = entry as { k: unknown; v: unknown };
      return { key: String(row.k), value: Number(row.v) };
    });
  if (stableJsonStringify(actualFtsConfig) !== stableJsonStringify(RECALL_FTS_CONFIG)) {
    throw new SessionError(
      "SESSION_SCHEMA_INVALID",
      "verify_schema",
      "Session FTS configuration does not match schema v2.",
      { sessionId },
    );
  }
}

export function verifyRecallIndex(database: Database, sessionId?: SessionId): void {
  try {
    database
      .query(
        `INSERT INTO message_fts(message_fts, rank)
         VALUES ('integrity-check', 1)`,
      )
      .run();
  } catch (error) {
    throw new SessionError(
      "SESSION_RECALL_INDEX_INVALID",
      "verify_recall_index",
      "Session Recall index failed its external-content integrity check.",
      { sessionId, cause: error },
    );
  }
}

export function rebuildRecallIndex(database: Database, sessionId?: SessionId): void {
  try {
    database.query("INSERT INTO message_fts(message_fts) VALUES ('rebuild')").run();
  } catch (error) {
    throw new SessionError(
      "SESSION_RECALL_INDEX_INVALID",
      "rebuild_recall_index",
      "Session Recall index could not be rebuilt from canonical history.",
      { sessionId, cause: error },
    );
  }
}

export function verifySqliteIntegrity(database: Database, sessionId?: SessionId): void {
  const quick = database.query("PRAGMA quick_check").all() as Array<
    Record<string, unknown>
  >;
  if (
    quick.length !== 1 ||
    String(Object.values(quick[0] ?? {})[0]).toLowerCase() !== "ok"
  ) {
    throw new SessionError(
      "SESSION_INTEGRITY_FAILED",
      "quick_check",
      "SQLite quick_check did not return ok.",
      { sessionId },
    );
  }
  const foreignKeys = database.query("PRAGMA foreign_key_check").all();
  if (foreignKeys.length !== 0) {
    throw new SessionError(
      "SESSION_INTEGRITY_FAILED",
      "foreign_key_check",
      "SQLite foreign_key_check found invalid references.",
      { sessionId },
    );
  }
}

function immutableTriggers(table: string): SchemaDefinition[] {
  return [
    {
      type: "trigger",
      name: `${table}_no_update`,
      sql: `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT, '${table} are immutable'); END`,
    },
    {
      type: "trigger",
      name: `${table}_no_delete`,
      sql: `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT, '${table} are immutable'); END`,
    },
  ];
}

function singlePragmaValue(database: Database, sql: string): unknown {
  const row = database.query(sql).get() as Record<string, unknown> | null;
  if (row === null) {
    throw new Error(`SQLite pragma returned no row: ${sql}.`);
  }
  return Object.values(row)[0];
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();
}
