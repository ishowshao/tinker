import type { Database } from "bun:sqlite";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import type { SessionId } from "../ids/runtime-id";
import { SessionError } from "./session-errors";

export const SESSION_APPLICATION_ID = 0x544b5231;
export const SESSION_SCHEMA_VERSION = 9;

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
      schema_version INTEGER NOT NULL CHECK (schema_version = 9),
      schema_fingerprint TEXT NOT NULL,
      initialization_state TEXT NOT NULL CHECK (initialization_state IN ('creating', 'ready')),
      session_id TEXT NOT NULL UNIQUE,
      workspace_root TEXT NOT NULL,
      model_name TEXT NOT NULL,
      system_prompt_sha256 TEXT NOT NULL,
      project_instruction_file TEXT CHECK (project_instruction_file IS NULL OR project_instruction_file IN ('AGENTS.md', 'CLAUDE.md')),
      project_instruction_byte_length INTEGER CHECK (project_instruction_byte_length IS NULL OR project_instruction_byte_length >= 1),
      project_instruction_sha256 TEXT CHECK (project_instruction_sha256 IS NULL OR length(project_instruction_sha256) = 64),
      session_compatibility_json TEXT,
      session_compatibility_sha256 TEXT,
      active_revision_id TEXT,
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
      CHECK ((session_compatibility_json IS NULL) = (session_compatibility_sha256 IS NULL)),
      CHECK ((project_instruction_file IS NULL) = (project_instruction_byte_length IS NULL)),
      CHECK ((project_instruction_file IS NULL) = (project_instruction_sha256 IS NULL)),
      CHECK (
        (initialization_state = 'creating' AND session_compatibility_json IS NULL AND active_revision_id IS NULL) OR
        (initialization_state = 'ready' AND session_compatibility_json IS NOT NULL AND active_revision_id IS NOT NULL)
      )
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
          observation_format IS NOT NULL AND length(observation_format) > 0 AND synthetic_reason IS NULL AND synthetic_detail IS NULL) OR
        (completion_kind = 'synthetic' AND raw_json IS NULL AND raw_sha256 IS NULL AND
          observation_format IS NULL AND synthetic_reason IS NOT NULL)
      ),
      CHECK ((synthetic_reason = 'failed_active') = (synthetic_detail IS NOT NULL))
    ) STRICT`,
  },
  {
    type: "table",
    name: "image_assets",
    sql: `CREATE TABLE image_assets (
      asset_id TEXT PRIMARY KEY
        CHECK (length(asset_id) = 64 AND asset_id NOT GLOB '*[^0-9a-f]*'),
      mime_type TEXT NOT NULL
        CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
      byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      created_at TEXT NOT NULL
    ) STRICT`,
  },
  {
    type: "table",
    name: "message_image_attachments",
    sql: `CREATE TABLE message_image_attachments (
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL CHECK (length(attachment_id) = 36),
      asset_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      label TEXT NOT NULL CHECK (length(label) > 0),
      range_start INTEGER NOT NULL CHECK (range_start >= 0),
      range_end INTEGER NOT NULL CHECK (range_end > range_start),
      original_name TEXT NOT NULL CHECK (length(original_name) > 0),
      PRIMARY KEY (message_id, attachment_id),
      UNIQUE (message_id, position),
      UNIQUE (message_id, label),
      UNIQUE (message_id, range_start, range_end),
      FOREIGN KEY (message_id) REFERENCES messages(message_id),
      FOREIGN KEY (asset_id) REFERENCES image_assets(asset_id)
    ) STRICT`,
  },
  {
    type: "table",
    name: "context_surfaces",
    sql: `CREATE TABLE context_surfaces (
      surface_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      system_prompt TEXT NOT NULL CHECK (length(system_prompt) > 0),
      system_prompt_sha256 TEXT NOT NULL CHECK (length(system_prompt_sha256) = 64),
      recall_contract_version TEXT NOT NULL CHECK (length(recall_contract_version) BETWEEN 1 AND 64),
      project_instruction_json TEXT CHECK (project_instruction_json IS NULL OR json_valid(project_instruction_json)),
      skill_catalog_json TEXT NOT NULL CHECK (json_valid(skill_catalog_json)),
      skill_catalog_sha256 TEXT NOT NULL CHECK (length(skill_catalog_sha256) = 64),
      active_skills_json TEXT NOT NULL CHECK (json_valid(active_skills_json)),
      active_skills_sha256 TEXT NOT NULL CHECK (length(active_skills_sha256) = 64),
      tool_definitions_json TEXT NOT NULL CHECK (json_valid(tool_definitions_json)),
      tool_definitions_sha256 TEXT NOT NULL CHECK (length(tool_definitions_sha256) = 64),
      tool_schema_sha256 TEXT NOT NULL CHECK (length(tool_schema_sha256) = 64),
      request_config_sha256 TEXT NOT NULL CHECK (length(request_config_sha256) = 64),
      request_max_output_tokens INTEGER NOT NULL CHECK (request_max_output_tokens >= 1),
      surface_sha256 TEXT NOT NULL CHECK (length(surface_sha256) = 64),
      created_at TEXT NOT NULL,
      UNIQUE (session_id, surface_id),
      FOREIGN KEY (session_id) REFERENCES session_meta(session_id)
    ) STRICT`,
  },
  {
    type: "table",
    name: "context_revisions",
    sql: `CREATE TABLE context_revisions (
      revision_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
      parent_revision_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('initial_full', 'swap_only', 'surface_refresh', 'prefix_retirement', 'skills_update')),
      surface_id TEXT NOT NULL,
      surface_sha256 TEXT NOT NULL CHECK (length(surface_sha256) = 64),
      keep_from_ordinal INTEGER NOT NULL CHECK (keep_from_ordinal >= 1),
      source_through_ordinal INTEGER NOT NULL CHECK (source_through_ordinal >= 1),
      added_override_count INTEGER NOT NULL CHECK (added_override_count >= 0),
      active_override_count INTEGER NOT NULL CHECK (active_override_count >= 0),
      active_override_manifest_sha256 TEXT NOT NULL CHECK (length(active_override_manifest_sha256) = 64),
      canonical_sequence_sha256 TEXT NOT NULL CHECK (length(canonical_sequence_sha256) = 64),
      rendered_message_sha256 TEXT NOT NULL CHECK (length(rendered_message_sha256) = 64),
      policy_version TEXT,
      renderer_format TEXT,
      plan_sha256 TEXT CHECK (plan_sha256 IS NULL OR length(plan_sha256) = 64),
      change_manifest_sha256 TEXT CHECK (change_manifest_sha256 IS NULL OR length(change_manifest_sha256) = 64),
      activation_manifest_sha256 TEXT CHECK (activation_manifest_sha256 IS NULL OR length(activation_manifest_sha256) = 64),
      retired_through_ordinal INTEGER CHECK (retired_through_ordinal IS NULL OR retired_through_ordinal >= 2),
      retired_turn_count INTEGER CHECK (retired_turn_count IS NULL OR retired_turn_count >= 1),
      retired_frame_count INTEGER CHECK (retired_frame_count IS NULL OR retired_frame_count >= 1),
      retired_message_count INTEGER CHECK (retired_message_count IS NULL OR retired_message_count >= 1),
      created_at TEXT NOT NULL,
      UNIQUE (session_id, revision_number),
      FOREIGN KEY (session_id) REFERENCES session_meta(session_id),
      FOREIGN KEY (parent_revision_id) REFERENCES context_revisions(revision_id),
      FOREIGN KEY (session_id, surface_id) REFERENCES context_surfaces(session_id, surface_id),
      CHECK (
        (kind = 'initial_full' AND revision_number = 1 AND parent_revision_id IS NULL AND
          source_through_ordinal = 1 AND added_override_count = 0 AND
          active_override_count = 0 AND policy_version IS NULL AND
          renderer_format IS NULL AND plan_sha256 IS NULL AND change_manifest_sha256 IS NULL AND activation_manifest_sha256 IS NULL AND
          retired_through_ordinal IS NULL AND retired_turn_count IS NULL AND
          retired_frame_count IS NULL AND retired_message_count IS NULL) OR
        (kind = 'swap_only' AND revision_number >= 2 AND parent_revision_id IS NOT NULL AND
          added_override_count >= 1 AND active_override_count >= added_override_count AND
          policy_version = 'swap-only-v1' AND
          renderer_format = 'swap-observation-v1' AND plan_sha256 IS NOT NULL AND
          change_manifest_sha256 IS NULL AND activation_manifest_sha256 IS NULL AND retired_through_ordinal IS NULL AND
          retired_turn_count IS NULL AND retired_frame_count IS NULL AND
          retired_message_count IS NULL) OR
        (kind = 'surface_refresh' AND revision_number >= 2 AND parent_revision_id IS NOT NULL AND
          added_override_count = 0 AND policy_version IS NULL AND renderer_format IS NULL AND
          plan_sha256 IS NULL AND change_manifest_sha256 IS NOT NULL AND activation_manifest_sha256 IS NULL AND
          retired_through_ordinal IS NULL AND retired_turn_count IS NULL AND
          retired_frame_count IS NULL AND retired_message_count IS NULL) OR
        (kind = 'prefix_retirement' AND revision_number >= 2 AND parent_revision_id IS NOT NULL AND
          keep_from_ordinal > 1 AND retired_through_ordinal = keep_from_ordinal - 1 AND
          added_override_count = 0 AND policy_version = 'recall-first-retirement-v1' AND
          renderer_format IS NULL AND plan_sha256 IS NOT NULL AND
          change_manifest_sha256 IS NULL AND activation_manifest_sha256 IS NULL AND retired_turn_count >= 1 AND
          retired_frame_count >= 1 AND retired_message_count >= 1)
        OR
        (kind = 'skills_update' AND revision_number >= 2 AND parent_revision_id IS NOT NULL AND
          added_override_count >= 1 AND active_override_count >= added_override_count AND
          policy_version = 'agent-skills-v1' AND
          renderer_format = 'skill-activation-receipt-v1' AND plan_sha256 IS NULL AND
          change_manifest_sha256 IS NOT NULL AND activation_manifest_sha256 IS NOT NULL AND
          retired_through_ordinal IS NULL AND retired_turn_count IS NULL AND
          retired_frame_count IS NULL AND retired_message_count IS NULL)
      )
    ) STRICT`,
  },
  {
    type: "table",
    name: "context_overrides",
    sql: `CREATE TABLE context_overrides (
      introduced_revision_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      frame_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
      representation TEXT NOT NULL CHECK (representation = 'swapped'),
      renderer_format TEXT NOT NULL CHECK (renderer_format IN ('swap-observation-v1', 'skill-activation-receipt-v1')),
      source TEXT NOT NULL,
      original_content_sha256 TEXT NOT NULL CHECK (length(original_content_sha256) = 64),
      rendered_content TEXT NOT NULL CHECK (length(rendered_content) > 0),
      rendered_content_sha256 TEXT NOT NULL CHECK (length(rendered_content_sha256) = 64),
      original_bytes INTEGER NOT NULL CHECK (original_bytes > 0),
      rendered_bytes INTEGER NOT NULL CHECK (rendered_bytes > 0),
      byte_savings INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (introduced_revision_id, message_id),
      UNIQUE (session_id, message_id),
      UNIQUE (introduced_revision_id, ordinal),
      FOREIGN KEY (introduced_revision_id) REFERENCES context_revisions(revision_id),
      FOREIGN KEY (session_id) REFERENCES session_meta(session_id),
      FOREIGN KEY (message_id) REFERENCES messages(message_id),
      FOREIGN KEY (frame_id) REFERENCES protocol_frames(frame_id),
      CHECK (original_bytes = rendered_bytes + byte_savings),
      CHECK (renderer_format <> 'swap-observation-v1' OR byte_savings > 0)
    ) STRICT`,
  },
  {
    type: "table",
    name: "skill_activations",
    sql: `CREATE TABLE skill_activations (
      activation_message_id TEXT PRIMARY KEY REFERENCES messages(message_id),
      tool_call_id TEXT NOT NULL UNIQUE REFERENCES tool_results(tool_call_id),
      session_id TEXT NOT NULL REFERENCES session_meta(session_id),
      name TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('project', 'user')),
      skill_file_sha256 TEXT NOT NULL CHECK (length(skill_file_sha256) = 64),
      state TEXT NOT NULL CHECK (state IN ('pending', 'dispatched', 'promoted', 'rejected')),
      dispatched_iteration_id TEXT REFERENCES iterations(iteration_id),
      settled_revision_id TEXT REFERENCES context_revisions(revision_id),
      rejection_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (state = 'pending' AND dispatched_iteration_id IS NULL AND settled_revision_id IS NULL AND rejection_reason IS NULL) OR
        (state = 'dispatched' AND dispatched_iteration_id IS NOT NULL AND settled_revision_id IS NULL AND rejection_reason IS NULL) OR
        (state = 'promoted' AND dispatched_iteration_id IS NOT NULL AND settled_revision_id IS NOT NULL AND rejection_reason IS NULL) OR
        (state = 'rejected' AND settled_revision_id IS NOT NULL AND rejection_reason IS NOT NULL)
      )
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
    name: "idx_context_revisions_session_number",
    sql: "CREATE INDEX idx_context_revisions_session_number ON context_revisions(session_id, revision_number)",
  },
  {
    type: "index",
    name: "idx_context_overrides_revision_ordinal",
    sql: "CREATE INDEX idx_context_overrides_revision_ordinal ON context_overrides(introduced_revision_id, ordinal)",
  },
  {
    type: "index",
    name: "idx_skill_activations_session_state",
    sql: "CREATE INDEX idx_skill_activations_session_state ON skill_activations(session_id, state, activation_message_id)",
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
    name: "idx_message_image_attachments_asset",
    sql: "CREATE INDEX idx_message_image_attachments_asset ON message_image_attachments(asset_id)",
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
        AND NOT (
          role = 'tool' AND name IN ('Recall', 'RecallSearch', 'RecallGet')
        )`,
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
        AND NOT (
          NEW.role = 'tool' AND NEW.name IN ('Recall', 'RecallSearch', 'RecallGet')
        )
      BEGIN
        INSERT INTO message_fts(rowid, content)
        VALUES (NEW.rowid, NEW.content);
      END`,
  },
  ...immutableTriggers("messages"),
  ...immutableTriggers("tool_results"),
  ...immutableTriggers("image_assets"),
  ...immutableTriggers("message_image_attachments"),
  ...immutableTriggers("context_surfaces"),
  ...immutableTriggers("context_revisions"),
  ...immutableTriggers("context_overrides"),
  {
    type: "trigger",
    name: "skill_activations_no_delete",
    sql: `CREATE TRIGGER skill_activations_no_delete BEFORE DELETE ON skill_activations
      BEGIN SELECT RAISE(ABORT, 'skill_activations cannot be deleted'); END`,
  },
  {
    type: "trigger",
    name: "skill_activations_validate_insert",
    sql: `CREATE TRIGGER skill_activations_validate_insert BEFORE INSERT ON skill_activations
      WHEN NOT (
        NEW.session_id = (SELECT session_id FROM session_meta WHERE singleton = 1) AND
        NEW.state = 'pending' AND NEW.dispatched_iteration_id IS NULL AND
        NEW.settled_revision_id IS NULL AND NEW.rejection_reason IS NULL AND
        EXISTS (
          SELECT 1 FROM messages m
          JOIN tool_results tr ON tr.tool_message_id = m.message_id
          WHERE m.message_id = NEW.activation_message_id
            AND m.session_id = NEW.session_id AND m.tool_call_id = NEW.tool_call_id
            AND m.name = 'Skill' AND m.role = 'tool' AND m.origin = 'tool'
            AND tr.tool_call_id = NEW.tool_call_id AND tr.session_id = NEW.session_id
            AND tr.completion_kind = 'returned'
            AND json_extract(tr.raw_json, '$.kind') = 'skill'
            AND json_extract(tr.raw_json, '$.ok') = 1
            AND json_extract(tr.raw_json, '$.status') = 'loaded'
            AND json_extract(tr.raw_json, '$.name') = NEW.name
            AND json_extract(tr.raw_json, '$.scope') = NEW.scope
            AND json_extract(tr.raw_json, '$.sha256') = NEW.skill_file_sha256
        )
      )
      BEGIN SELECT RAISE(ABORT, 'invalid skill activation insert'); END`,
  },
  {
    type: "trigger",
    name: "skill_activations_monotonic_update",
    sql: `CREATE TRIGGER skill_activations_monotonic_update BEFORE UPDATE ON skill_activations
      WHEN NOT (
        OLD.activation_message_id = NEW.activation_message_id AND
        OLD.tool_call_id = NEW.tool_call_id AND OLD.session_id = NEW.session_id AND
        OLD.name = NEW.name AND OLD.scope = NEW.scope AND
        OLD.skill_file_sha256 = NEW.skill_file_sha256 AND OLD.created_at = NEW.created_at AND
        ((OLD.state = 'pending' AND NEW.state = 'dispatched' AND
          NEW.dispatched_iteration_id IS NOT NULL AND NEW.settled_revision_id IS NULL AND NEW.rejection_reason IS NULL) OR
         (OLD.state = 'pending' AND NEW.state = 'rejected' AND
          NEW.dispatched_iteration_id IS NULL AND NEW.settled_revision_id IS NOT NULL AND NEW.rejection_reason IS NOT NULL) OR
         (OLD.state = 'dispatched' AND NEW.state IN ('promoted', 'rejected') AND
          NEW.dispatched_iteration_id = OLD.dispatched_iteration_id AND
          NEW.settled_revision_id IS NOT NULL AND
          ((NEW.state = 'promoted' AND NEW.rejection_reason IS NULL) OR
           (NEW.state = 'rejected' AND NEW.rejection_reason IS NOT NULL))))
      )
      BEGIN SELECT RAISE(ABORT, 'invalid skill activation transition'); END`,
  },
  {
    type: "trigger",
    name: "context_revisions_validate_insert",
    sql: `CREATE TRIGGER context_revisions_validate_insert
      BEFORE INSERT ON context_revisions
      WHEN NOT (
        NEW.session_id = (SELECT session_id FROM session_meta WHERE singleton = 1) AND
        ((NEW.kind = 'initial_full' AND NEW.revision_number = 1 AND
          (SELECT initialization_state FROM session_meta WHERE singleton = 1) = 'creating' AND
          (SELECT active_revision_id FROM session_meta WHERE singleton = 1) IS NULL AND
          NOT EXISTS (SELECT 1 FROM context_revisions WHERE session_id = NEW.session_id) AND
          NEW.surface_sha256 = (SELECT surface_sha256 FROM context_surfaces WHERE surface_id = NEW.surface_id)) OR
         (NEW.kind = 'swap_only' AND
          NEW.parent_revision_id = (SELECT active_revision_id FROM session_meta WHERE singleton = 1) AND
          NEW.revision_number = 1 + COALESCE((
            SELECT revision_number FROM context_revisions
            WHERE revision_id = NEW.parent_revision_id AND session_id = NEW.session_id
          ), 0) AND
          NEW.source_through_ordinal = COALESCE((SELECT MAX(ordinal) FROM messages), 0) AND
          EXISTS (SELECT 1 FROM protocol_frames WHERE state = 'closed' AND last_ordinal = NEW.source_through_ordinal) AND
          NEW.surface_id = (SELECT surface_id FROM context_revisions WHERE revision_id = NEW.parent_revision_id) AND
          NEW.surface_sha256 = (SELECT surface_sha256 FROM context_revisions WHERE revision_id = NEW.parent_revision_id) AND
          NEW.keep_from_ordinal = (SELECT keep_from_ordinal FROM context_revisions WHERE revision_id = NEW.parent_revision_id) AND
          NEW.active_override_count = (SELECT active_override_count FROM context_revisions WHERE revision_id = NEW.parent_revision_id) + NEW.added_override_count) OR
         (NEW.kind = 'surface_refresh' AND
          NEW.parent_revision_id = (SELECT active_revision_id FROM session_meta WHERE singleton = 1) AND
          NEW.revision_number = 1 + COALESCE((
            SELECT revision_number FROM context_revisions
            WHERE revision_id = NEW.parent_revision_id AND session_id = NEW.session_id
          ), 0) AND
          NEW.source_through_ordinal = COALESCE((SELECT MAX(ordinal) FROM messages), 0) AND
          EXISTS (SELECT 1 FROM protocol_frames WHERE state = 'closed' AND last_ordinal = NEW.source_through_ordinal) AND
          NEW.surface_id <> (SELECT surface_id FROM context_revisions WHERE revision_id = NEW.parent_revision_id) AND
          NEW.surface_sha256 = (SELECT surface_sha256 FROM context_surfaces WHERE surface_id = NEW.surface_id) AND
          NEW.keep_from_ordinal = (SELECT keep_from_ordinal FROM context_revisions WHERE revision_id = NEW.parent_revision_id) AND
          NEW.active_override_count = (SELECT active_override_count FROM context_revisions WHERE revision_id = NEW.parent_revision_id) AND
          NEW.active_override_manifest_sha256 = (SELECT active_override_manifest_sha256 FROM context_revisions WHERE revision_id = NEW.parent_revision_id)) OR
         (NEW.kind = 'skills_update' AND
          NEW.parent_revision_id = (SELECT active_revision_id FROM session_meta WHERE singleton = 1) AND
          NEW.revision_number = 1 + COALESCE((
            SELECT revision_number FROM context_revisions
            WHERE revision_id = NEW.parent_revision_id AND session_id = NEW.session_id
          ), 0) AND
          NEW.source_through_ordinal = COALESCE((SELECT MAX(ordinal) FROM messages), 0) AND
          EXISTS (SELECT 1 FROM protocol_frames WHERE state = 'closed' AND last_ordinal = NEW.source_through_ordinal) AND
          NEW.surface_sha256 = (SELECT surface_sha256 FROM context_surfaces WHERE surface_id = NEW.surface_id) AND
          NEW.keep_from_ordinal = (SELECT keep_from_ordinal FROM context_revisions WHERE revision_id = NEW.parent_revision_id) AND
          NEW.active_override_count = (SELECT active_override_count FROM context_revisions WHERE revision_id = NEW.parent_revision_id) + NEW.added_override_count) OR
         (NEW.kind = 'prefix_retirement' AND
          NEW.parent_revision_id = (SELECT active_revision_id FROM session_meta WHERE singleton = 1) AND
          NEW.revision_number = 1 + COALESCE((
            SELECT revision_number FROM context_revisions
            WHERE revision_id = NEW.parent_revision_id AND session_id = NEW.session_id
          ), 0) AND
          NEW.source_through_ordinal = COALESCE((SELECT MAX(ordinal) FROM messages), 0) AND
          EXISTS (SELECT 1 FROM protocol_frames WHERE state = 'closed' AND last_ordinal = NEW.source_through_ordinal) AND
          NEW.surface_id = (SELECT surface_id FROM context_revisions WHERE revision_id = NEW.parent_revision_id) AND
          NEW.surface_sha256 = (SELECT surface_sha256 FROM context_revisions WHERE revision_id = NEW.parent_revision_id) AND
          NEW.keep_from_ordinal > (SELECT keep_from_ordinal FROM context_revisions WHERE revision_id = NEW.parent_revision_id) AND
          EXISTS (
            SELECT 1 FROM messages m
            JOIN protocol_frames pf ON pf.frame_id = m.frame_id
            JOIN turns t ON t.turn_id = m.turn_id
            WHERE m.ordinal = NEW.keep_from_ordinal AND m.role = 'user'
              AND pf.kind = 'user' AND pf.state = 'closed'
              AND pf.first_ordinal = NEW.keep_from_ordinal
              AND pf.last_ordinal = NEW.keep_from_ordinal
              AND (
                t.status <> 'open' OR (
                  NOT EXISTS (SELECT 1 FROM iterations WHERE outcome = 'open') AND
                  NOT EXISTS (SELECT 1 FROM protocol_frames WHERE state = 'open')
                )
              )
          ) AND
          EXISTS (
            SELECT 1 FROM messages m
            JOIN protocol_frames pf ON pf.frame_id = m.frame_id
            JOIN turns t ON t.turn_id = m.turn_id
            WHERE m.ordinal = NEW.keep_from_ordinal - 1
              AND pf.state = 'closed' AND pf.last_ordinal = NEW.keep_from_ordinal - 1
              AND t.status <> 'open'
          ) AND
          NEW.active_override_count = (
            SELECT COUNT(*) FROM context_overrides co
            JOIN context_revisions introduced
              ON introduced.revision_id = co.introduced_revision_id
            JOIN context_revisions parent
              ON parent.revision_id = NEW.parent_revision_id
            WHERE introduced.revision_number <= parent.revision_number
              AND co.ordinal >= NEW.keep_from_ordinal
          )))
      )
      BEGIN SELECT RAISE(ABORT, 'invalid context revision insert'); END`,
  },
  {
    type: "trigger",
    name: "context_overrides_validate_insert",
    sql: `CREATE TRIGGER context_overrides_validate_insert
      BEFORE INSERT ON context_overrides
      WHEN NOT (
        EXISTS (
          SELECT 1 FROM context_revisions cr
          WHERE cr.revision_id = NEW.introduced_revision_id
            AND cr.session_id = NEW.session_id
            AND ((cr.kind = 'swap_only' AND NEW.renderer_format = 'swap-observation-v1') OR
                 (cr.kind = 'skills_update' AND NEW.renderer_format = 'skill-activation-receipt-v1'))
            AND NEW.ordinal >= cr.keep_from_ordinal
            AND NEW.ordinal <= cr.source_through_ordinal
        ) AND
        EXISTS (
          SELECT 1
          FROM messages m
          JOIN protocol_frames pf ON pf.frame_id = m.frame_id
          JOIN tool_results tr ON tr.tool_message_id = m.message_id
          WHERE m.message_id = NEW.message_id
            AND m.session_id = NEW.session_id
            AND m.frame_id = NEW.frame_id
            AND m.ordinal = NEW.ordinal
            AND m.role = 'tool'
            AND m.content_sha256 = NEW.original_content_sha256
            AND length(CAST(m.content AS BLOB)) = NEW.original_bytes
            AND pf.session_id = NEW.session_id
            AND pf.kind = 'tool_exchange'
            AND pf.state = 'closed'
            AND tr.session_id = NEW.session_id
            AND tr.frame_id = NEW.frame_id
            AND tr.observation_sha256 = NEW.original_content_sha256
            AND (NEW.renderer_format <> 'skill-activation-receipt-v1' OR
                 (m.name = 'Skill' AND tr.completion_kind = 'returned' AND
                  json_extract(tr.raw_json, '$.kind') = 'skill' AND
                  json_extract(tr.raw_json, '$.ok') = 1 AND
                  json_extract(tr.raw_json, '$.status') = 'loaded'))
        ) AND
        NEW.source = 'ctx://message/' || NEW.message_id AND
        length(CAST(NEW.rendered_content AS BLOB)) = NEW.rendered_bytes AND
        (NEW.renderer_format <> 'swap-observation-v1' OR NEW.rendered_bytes < NEW.original_bytes)
      )
      BEGIN SELECT RAISE(ABORT, 'invalid context override insert'); END`,
  },
  {
    type: "trigger",
    name: "context_measurement_active_insert",
    sql: `CREATE TRIGGER context_measurement_active_insert
      BEFORE INSERT ON context_measurement_state
      WHEN NOT EXISTS (
        SELECT 1 FROM session_meta sm
        WHERE sm.singleton = 1 AND sm.session_id = NEW.session_id
          AND sm.active_revision_id = NEW.revision_id
      )
      BEGIN SELECT RAISE(ABORT, 'context measurement revision is not active'); END`,
  },
  {
    type: "trigger",
    name: "context_measurement_active_update",
    sql: `CREATE TRIGGER context_measurement_active_update
      BEFORE UPDATE ON context_measurement_state
      WHEN NOT EXISTS (
        SELECT 1 FROM session_meta sm
        WHERE sm.singleton = 1 AND sm.session_id = NEW.session_id
          AND sm.active_revision_id = NEW.revision_id
      )
      BEGIN SELECT RAISE(ABORT, 'context measurement revision is not active'); END`,
  },
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
        OLD.project_instruction_file IS NEW.project_instruction_file AND
        OLD.project_instruction_byte_length IS NEW.project_instruction_byte_length AND
        OLD.project_instruction_sha256 IS NEW.project_instruction_sha256 AND
        OLD.created_at = NEW.created_at AND
        NEW.next_turn_number >= OLD.next_turn_number AND
        NEW.next_event_sequence >= OLD.next_event_sequence AND
        NEW.open_count >= OLD.open_count AND
        ((OLD.initialization_state = 'creating' AND NEW.initialization_state IN ('creating', 'ready')) OR
         (OLD.initialization_state = 'ready' AND NEW.initialization_state = 'ready')) AND
        (OLD.session_compatibility_json IS NULL OR NEW.session_compatibility_json = OLD.session_compatibility_json) AND
        (OLD.session_compatibility_sha256 IS NULL OR NEW.session_compatibility_sha256 = OLD.session_compatibility_sha256) AND
        ((OLD.active_revision_id IS NULL AND NEW.active_revision_id IS NOT NULL AND
          OLD.initialization_state = 'creating' AND NEW.initialization_state = 'ready' AND
          EXISTS (
            SELECT 1 FROM context_revisions initial
            WHERE initial.revision_id = NEW.active_revision_id
              AND initial.session_id = OLD.session_id
              AND initial.kind = 'initial_full'
          )) OR OLD.active_revision_id = NEW.active_revision_id OR EXISTS (
          SELECT 1
          FROM context_revisions previous
          JOIN context_revisions next
            ON next.parent_revision_id = previous.revision_id
           AND next.session_id = previous.session_id
           AND next.revision_number = previous.revision_number + 1
          WHERE previous.revision_id = OLD.active_revision_id
            AND next.revision_id = NEW.active_revision_id
            AND next.session_id = OLD.session_id
            AND next.kind IN ('swap_only', 'surface_refresh', 'prefix_retirement', 'skills_update')
            AND next.added_override_count = (
              SELECT COUNT(*) FROM context_overrides
              WHERE introduced_revision_id = next.revision_id
            )
            AND ((next.kind = 'swap_only' AND
                  next.keep_from_ordinal = previous.keep_from_ordinal AND
                  next.active_override_count = previous.active_override_count + next.added_override_count AND
                  next.surface_id = previous.surface_id) OR
                 (next.kind = 'surface_refresh' AND
                  next.keep_from_ordinal = previous.keep_from_ordinal AND
                  next.active_override_count = previous.active_override_count AND
                  next.added_override_count = 0 AND
                  next.active_override_manifest_sha256 = previous.active_override_manifest_sha256 AND
                  next.surface_id <> previous.surface_id) OR
                 (next.kind = 'skills_update' AND
                  next.keep_from_ordinal = previous.keep_from_ordinal AND
                  next.active_override_count = previous.active_override_count + next.added_override_count AND
                  next.surface_sha256 = (SELECT surface_sha256 FROM context_surfaces WHERE surface_id = next.surface_id)) OR
                 (next.kind = 'prefix_retirement' AND
                  next.keep_from_ordinal > previous.keep_from_ordinal AND
                  next.added_override_count = 0 AND
                  next.surface_id = previous.surface_id AND
                  next.active_override_count = (
                    SELECT COUNT(*) FROM context_overrides co
                    JOIN context_revisions introduced
                      ON introduced.revision_id = co.introduced_revision_id
                    WHERE introduced.revision_number <= previous.revision_number
                      AND co.ordinal >= next.keep_from_ordinal
                  )))
            AND NOT EXISTS (SELECT 1 FROM context_measurement_state)
        ))
      )
      BEGIN SELECT RAISE(ABORT, 'invalid session metadata transition'); END`,
  },
];

export const SESSION_SCHEMA_V9_FINGERPRINT = sha256(
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

const PRE_SPLIT_RECALL_SCHEMA_V9_FINGERPRINT =
  "27c61d806778689f88211b6eaa6dd9dc3a730dfd4133c862006140576b2ecd10";

const PRE_ACTIVE_TURN_RETIREMENT_SCHEMA_V9_FINGERPRINT =
  "263a0415b343a922efc65aab4a3387a8b31de18e82245ce67b9296b7a02f4a26";

const ACTIVE_TURN_RETIREMENT_TRIGGER_FRAGMENT = `AND (
                t.status <> 'open' OR (
                  NOT EXISTS (SELECT 1 FROM iterations WHERE outcome = 'open') AND
                  NOT EXISTS (SELECT 1 FROM protocol_frames WHERE state = 'open')
                )
              )`;

const preActiveTurnRetirementSchemaDefinitions = replaceSchemaDefinitionSql(
  schemaDefinitions,
  "trigger",
  "context_revisions_validate_insert",
  (sql) =>
    replaceExactSqlFragment(
      sql,
      ACTIVE_TURN_RETIREMENT_TRIGGER_FRAGMENT,
      "AND t.status <> 'open'",
    ),
);

const preSplitRecallSchemaDefinitions = replaceSchemaDefinitionSql(
  replaceSchemaDefinitionSql(
    preActiveTurnRetirementSchemaDefinitions,
    "view",
    "recall_documents",
    () => `CREATE VIEW recall_documents AS
      SELECT rowid AS docid, content
      FROM messages
      WHERE role IN ('user', 'assistant', 'tool')
        AND content IS NOT NULL
        AND length(content) > 0
        AND NOT (role = 'tool' AND name = 'Recall')`,
  ),
  "trigger",
  "messages_recall_index",
  () => `CREATE TRIGGER messages_recall_index
      AFTER INSERT ON messages
      WHEN NEW.role IN ('user', 'assistant', 'tool')
        AND NEW.content IS NOT NULL
        AND length(NEW.content) > 0
        AND NOT (NEW.role = 'tool' AND NEW.name = 'Recall')
      BEGIN
        INSERT INTO message_fts(rowid, content)
        VALUES (NEW.rowid, NEW.content);
      END`,
);

export function upgradeRecallIndexContract(database: Database): boolean {
  const applicationId = Number(singlePragmaValue(database, "PRAGMA application_id"));
  const userVersion = Number(singlePragmaValue(database, "PRAGMA user_version"));
  if (
    applicationId !== SESSION_APPLICATION_ID ||
    userVersion !== SESSION_SCHEMA_VERSION
  ) {
    return false;
  }
  const meta = database
    .query(
      `SELECT schema_version, schema_fingerprint
       FROM session_meta WHERE singleton = 1`,
    )
    .get() as { schema_version: unknown; schema_fingerprint: unknown } | null;
  if (
    meta === null ||
    Number(meta.schema_version) !== SESSION_SCHEMA_VERSION ||
    meta.schema_fingerprint !== PRE_SPLIT_RECALL_SCHEMA_V9_FINGERPRINT
  ) {
    return false;
  }
  const recallView = schemaDefinitions.find(
    (definition) =>
      definition.type === "view" && definition.name === "recall_documents",
  );
  const recallTrigger = schemaDefinitions.find(
    (definition) =>
      definition.type === "trigger" && definition.name === "messages_recall_index",
  );
  const metadataTrigger = schemaDefinitions.find(
    (definition) =>
      definition.type === "trigger" &&
      definition.name === "session_meta_monotonic_update",
  );
  if (
    recallView === undefined ||
    recallTrigger === undefined ||
    metadataTrigger === undefined
  ) {
    throw new Error("Recall index schema definitions are missing.");
  }
  database.exec("DROP TRIGGER messages_recall_index");
  database.exec("DROP VIEW recall_documents");
  database.exec(recallView.sql);
  database.exec(recallTrigger.sql);
  rebuildRecallIndex(database);
  database.exec("DROP TRIGGER session_meta_monotonic_update");
  database
    .query(
      `UPDATE session_meta SET schema_fingerprint = ?
       WHERE singleton = 1 AND schema_fingerprint = ?`,
    )
    .run(
      PRE_ACTIVE_TURN_RETIREMENT_SCHEMA_V9_FINGERPRINT,
      PRE_SPLIT_RECALL_SCHEMA_V9_FINGERPRINT,
    );
  database.exec(metadataTrigger.sql);
  return true;
}

export function upgradeActiveTurnRetirementContract(database: Database): boolean {
  const applicationId = Number(singlePragmaValue(database, "PRAGMA application_id"));
  const userVersion = Number(singlePragmaValue(database, "PRAGMA user_version"));
  if (
    applicationId !== SESSION_APPLICATION_ID ||
    userVersion !== SESSION_SCHEMA_VERSION
  ) {
    return false;
  }
  const meta = database
    .query(
      `SELECT schema_version, schema_fingerprint
       FROM session_meta WHERE singleton = 1`,
    )
    .get() as { schema_version: unknown; schema_fingerprint: unknown } | null;
  if (
    meta === null ||
    Number(meta.schema_version) !== SESSION_SCHEMA_VERSION ||
    meta.schema_fingerprint !== PRE_ACTIVE_TURN_RETIREMENT_SCHEMA_V9_FINGERPRINT
  ) {
    return false;
  }
  const revisionTrigger = schemaDefinitions.find(
    (definition) =>
      definition.type === "trigger" &&
      definition.name === "context_revisions_validate_insert",
  );
  const metadataTrigger = schemaDefinitions.find(
    (definition) =>
      definition.type === "trigger" &&
      definition.name === "session_meta_monotonic_update",
  );
  if (revisionTrigger === undefined || metadataTrigger === undefined) {
    throw new Error("Active-turn retirement schema definitions are missing.");
  }
  database.exec("DROP TRIGGER context_revisions_validate_insert");
  database.exec(revisionTrigger.sql);
  database.exec("DROP TRIGGER session_meta_monotonic_update");
  database
    .query(
      `UPDATE session_meta SET schema_fingerprint = ?
       WHERE singleton = 1 AND schema_fingerprint = ?`,
    )
    .run(
      SESSION_SCHEMA_V9_FINGERPRINT,
      PRE_ACTIVE_TURN_RETIREMENT_SCHEMA_V9_FINGERPRINT,
    );
  database.exec(metadataTrigger.sql);
  return true;
}

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
    try {
      database.exec(definition.sql);
    } catch (error) {
      throw new Error(
        `Failed to create session schema ${definition.type} ${definition.name}.`,
        { cause: error },
      );
    }
  }
}

export function dropSessionCloneTriggers(database: Database): void {
  for (const definition of schemaDefinitions) {
    if (definition.type === "trigger") {
      database.exec(`DROP TRIGGER ${definition.name}`);
    }
  }
}

export function reinstallSessionCloneTriggers(database: Database): void {
  for (const definition of schemaDefinitions) {
    if (definition.type === "trigger") {
      database.exec(definition.sql);
    }
  }
}

export function verifyReadableSessionSchema(
  database: Database,
  sessionId?: SessionId,
): "current" | "migratable" {
  verifySessionSchemaVersion(database, sessionId);
  const meta = database
    .query(
      `SELECT schema_version, schema_fingerprint
       FROM session_meta WHERE singleton = 1`,
    )
    .get() as { schema_version: unknown; schema_fingerprint: unknown } | null;
  if (
    meta === null ||
    Number(meta.schema_version) !== SESSION_SCHEMA_VERSION ||
    typeof meta.schema_fingerprint !== "string"
  ) {
    throw new SessionError(
      "SESSION_SCHEMA_INVALID",
      "verify_readable_schema",
      "Session schema metadata is invalid.",
      { sessionId },
    );
  }

  let expectedDefinitions: readonly SchemaDefinition[];
  let compatibility: "current" | "migratable";
  if (meta.schema_fingerprint === SESSION_SCHEMA_V9_FINGERPRINT) {
    expectedDefinitions = schemaDefinitions;
    compatibility = "current";
  } else if (
    meta.schema_fingerprint === PRE_ACTIVE_TURN_RETIREMENT_SCHEMA_V9_FINGERPRINT
  ) {
    expectedDefinitions = preActiveTurnRetirementSchemaDefinitions;
    compatibility = "migratable";
  } else if (meta.schema_fingerprint === PRE_SPLIT_RECALL_SCHEMA_V9_FINGERPRINT) {
    expectedDefinitions = preSplitRecallSchemaDefinitions;
    compatibility = "migratable";
  } else {
    throw new SessionError(
      "SESSION_SCHEMA_INVALID",
      "verify_readable_schema",
      "Session schema is neither current nor a recognized migration source.",
      { sessionId },
    );
  }
  verifySessionSchemaDefinitions(database, expectedDefinitions, sessionId);
  return compatibility;
}

export function verifySessionSchema(database: Database, sessionId?: SessionId): void {
  verifySessionSchemaVersion(database, sessionId);
  verifySessionSchemaDefinitions(database, schemaDefinitions, sessionId);
}

function verifySessionSchemaVersion(database: Database, sessionId?: SessionId): void {
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
}

function verifySessionSchemaDefinitions(
  database: Database,
  expectedDefinitions: readonly SchemaDefinition[],
  sessionId?: SessionId,
): void {
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
  for (const expected of expectedDefinitions) {
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
      "Session FTS configuration does not match schema v9.",
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

function replaceSchemaDefinitionSql(
  definitions: readonly SchemaDefinition[],
  type: SchemaDefinition["type"],
  name: string,
  replace: (sql: string) => string,
): readonly SchemaDefinition[] {
  const target = definitions.find(
    (definition) => definition.type === type && definition.name === name,
  );
  if (target === undefined) {
    throw new Error(`Schema definition is missing: ${type} ${name}.`);
  }
  return definitions.map((definition) =>
    definition === target
      ? { ...definition, sql: replace(definition.sql) }
      : definition,
  );
}

function replaceExactSqlFragment(
  sql: string,
  currentFragment: string,
  previousFragment: string,
): string {
  const replaced = sql.replace(currentFragment, previousFragment);
  if (replaced === sql) {
    throw new Error("Schema definition does not contain its historical fragment.");
  }
  return replaced;
}
