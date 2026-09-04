import type { Database } from "bun:sqlite";
import {
  canonicalToolResultContentHash,
  toolResultDisplayText,
  validateToolResultContent,
} from "../agent/tool-result-content";
import {
  validateStoredContextSurface,
  type StoredContextSurfaceV8,
} from "../context/context-surface";
import {
  userMessageHash,
  type CanonicalMessageRecord,
  type ProtocolFrame,
  type ToolResultRecord,
} from "../context/protocol-frame";
import { validateUserMessage, type ImageAssetRef } from "../image/image-types";
import { stableJsonStringify } from "../model/model-request-preflight";
import { imageAssetRefFromAttachment } from "./session-store-record-codecs";
import { requireItem } from "./session-store-sql";
import { numberFromSql, timestampFromSql } from "./session-store-value-codecs";

export function insertPendingSkillActivation(
  database: Database,
  message: CanonicalMessageRecord,
  result: ToolResultRecord,
  now: string,
): void {
  if (
    message.role !== "tool" ||
    result.completion.kind !== "returned" ||
    result.completion.raw.kind !== "skill" ||
    !result.completion.raw.ok ||
    result.completion.raw.status !== "loaded"
  ) {
    return;
  }
  const raw = result.completion.raw;
  if (message.name !== "Skill" || message.messageId !== result.toolMessageId) {
    throw new Error("Loaded Agent Skill completion has invalid tool identity.");
  }
  database
    .query(
      `INSERT INTO skill_activations (
        activation_message_id, tool_call_id, session_id, name, scope,
        skill_file_sha256, state, dispatched_iteration_id, settled_revision_id,
        rejection_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      message.messageId,
      result.toolCallId,
      result.sessionId,
      raw.name,
      raw.scope,
      raw.sha256,
      now,
      now,
    );
}

export function insertFrame(database: Database, frame: ProtocolFrame): void {
  database
    .query(
      `INSERT INTO protocol_frames (
      frame_id, session_id, turn_id, iteration_id, kind, state,
      first_ordinal, last_ordinal, created_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      frame.frameId,
      frame.sessionId,
      frame.turnId ?? null,
      frame.iterationId ?? null,
      frame.kind,
      frame.state,
      frame.firstOrdinal,
      frame.lastOrdinal ?? null,
      frame.createdAt,
      frame.closedAt ?? null,
    );
}

export function insertMessage(
  database: Database,
  message: CanonicalMessageRecord,
): void {
  const assistant = message.role === "assistant" ? message : undefined;
  const tool = message.role === "tool" ? message : undefined;
  const turnId = "turnId" in message ? message.turnId : null;
  const iterationId = "iterationId" in message ? message.iterationId : null;
  const reasoningPresent =
    assistant !== undefined && assistant.reasoningContent !== undefined ? 1 : 0;
  database
    .query(
      `INSERT INTO messages (
      message_id, session_id, frame_id, ordinal, role, turn_id, iteration_id,
      content, content_sha256, reasoning_content, reasoning_content_present,
      tool_calls_json, provider, model, tool_call_id, provider_tool_call_id,
      name, origin, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      message.messageId,
      message.sessionId,
      message.frameId,
      message.ordinal,
      message.role,
      turnId,
      iterationId,
      message.role === "tool" ? message.displayText : message.content,
      message.contentSha256,
      assistant?.reasoningContent ?? null,
      reasoningPresent,
      assistant?.toolCalls === undefined
        ? null
        : stableJsonStringify(assistant.toolCalls),
      assistant?.provider ?? null,
      assistant?.model ?? null,
      tool?.toolCallId ?? null,
      tool?.providerToolCallId ?? null,
      tool?.name ?? null,
      message.origin,
      message.createdAt,
    );
  if (message.role === "user" && message.attachments !== undefined) {
    insertMessageImageAttachments(database, message);
  }
  if (message.role === "tool") {
    insertToolMessageContentBlocks(database, message);
  }
}

function insertMessageImageAttachments(
  database: Database,
  message: Extract<CanonicalMessageRecord, { role: "user" }>,
): void {
  const userMessage = {
    role: "user" as const,
    content: message.content,
    attachments: message.attachments,
  };

  validateUserMessage(userMessage);
  if (userMessageHash(userMessage) !== message.contentSha256) {
    throw new Error("User image attachment hash does not match the message hash.");
  }
  for (let position = 0; position < message.attachments!.length; position += 1) {
    const attachment = requireItem(message.attachments!, position, "image attachment");
    ensureImageAsset(
      database,
      imageAssetRefFromAttachment(attachment),
      message.createdAt,
    );
    database
      .query(
        `INSERT INTO message_image_attachments (
           message_id, attachment_id, asset_id, position, label,
           range_start, range_end, original_name
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.messageId,
        attachment.attachmentId,
        attachment.assetId,
        position,
        attachment.label,
        attachment.range.start,
        attachment.range.end,
        attachment.originalName,
      );
  }
}

function insertToolMessageContentBlocks(
  database: Database,
  message: Extract<CanonicalMessageRecord, { role: "tool" }>,
): void {
  validateToolResultContent(message.content);
  if (
    canonicalToolResultContentHash(message.content) !== message.contentSha256 ||
    toolResultDisplayText(message.content) !== message.displayText
  ) {
    throw new Error("Tool content blocks do not match canonical message metadata.");
  }
  for (let position = 0; position < message.content.length; position += 1) {
    const block = requireItem(message.content, position, "tool content block");
    if (block.type === "image") {
      ensureImageAsset(database, block.asset, message.createdAt);
    }
    database
      .query(
        `INSERT INTO tool_message_content_blocks (
           message_id, position, kind, text_content, asset_id
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        message.messageId,
        position,
        block.type,
        block.type === "text" ? block.text : null,
        block.type === "image" ? block.asset.assetId : null,
      );
  }
}

function ensureImageAsset(
  database: Database,
  asset: ImageAssetRef,
  createdAt: string,
): void {
  const existing = database
    .query(
      `SELECT mime_type, byte_length, width, height, created_at
       FROM image_assets WHERE asset_id = ?`,
    )
    .get(asset.assetId) as {
    mime_type: unknown;
    byte_length: unknown;
    width: unknown;
    height: unknown;
    created_at: unknown;
  } | null;
  if (existing === null) {
    database
      .query(
        `INSERT INTO image_assets (
           asset_id, mime_type, byte_length, width, height, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        asset.assetId,
        asset.mimeType,
        asset.byteLength,
        asset.width,
        asset.height,
        createdAt,
      );
    return;
  }

  timestampFromSql(existing.created_at, "image asset created_at");
  if (
    existing.mime_type !== asset.mimeType ||
    numberFromSql(existing.byte_length, "image asset byte_length") !==
      asset.byteLength ||
    numberFromSql(existing.width, "image asset width") !== asset.width ||
    numberFromSql(existing.height, "image asset height") !== asset.height
  ) {
    throw new Error(`Image asset metadata conflicts for ${asset.assetId}.`);
  }
}

export function insertToolResult(database: Database, result: ToolResultRecord): void {
  const returned = result.completion.kind === "returned" ? result.completion : null;
  const synthetic = result.completion.kind === "synthetic" ? result.completion : null;
  database
    .query(
      `INSERT INTO tool_results (
      tool_call_id, session_id, frame_id, tool_message_id, completion_kind,
      raw_json, raw_sha256, observation_format, synthetic_reason,
      synthetic_detail, observation_sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      result.toolCallId,
      result.sessionId,
      result.frameId,
      result.toolMessageId,
      result.completion.kind,
      returned === null ? null : stableJsonStringify(returned.raw),
      returned?.rawSha256 ?? null,
      returned?.observationFormat ?? null,
      synthetic?.reason ?? null,
      synthetic?.detail ?? null,
      result.observationSha256,
      result.createdAt,
    );
}

export function insertContextSurface(
  database: Database,
  surface: StoredContextSurfaceV8,
): void {
  validateStoredContextSurface(surface);
  database
    .query(
      `INSERT INTO context_surfaces (
        surface_id, session_id, system_prompt, system_prompt_sha256,
        recall_contract_version,
        project_instruction_json, skill_catalog_json, skill_catalog_sha256,
        active_skills_json, active_skills_sha256, tool_definitions_json,
        tool_definitions_sha256, tool_schema_sha256, request_config_sha256,
        request_max_output_tokens, surface_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      surface.surfaceId,
      surface.sessionId,
      surface.systemPrompt,
      surface.systemPromptSha256,
      surface.recallContractVersion,
      surface.projectInstruction === undefined
        ? null
        : stableJsonStringify(surface.projectInstruction),
      stableJsonStringify(surface.skillCatalog),
      surface.skillCatalogSha256,
      stableJsonStringify(surface.activeSkills),
      surface.activeSkillsSha256,
      stableJsonStringify(surface.toolDefinitions),
      surface.toolDefinitionsSha256,
      surface.toolSchemaSha256,
      surface.requestConfigSha256,
      surface.requestMaxOutputTokens,
      surface.surfaceSha256,
      surface.createdAt,
    );
}
