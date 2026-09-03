import { Database } from "bun:sqlite";
import type {
  ContextRevisionId,
  ContextSurfaceId,
  IterationId,
  MessageId,
  ProtocolFrameId,
  SessionId,
  ToolCallId,
  TurnId,
} from "../ids/runtime-id";
import type { ToolDefinition } from "../tools/types";
import {
  SUPPORTED_TOOL_OBSERVATION_FORMATS,
  immutableCanonicalClone,
  immutableRecord,
  type CanonicalMessageRecord,
  type ProtocolContextView,
  type ProtocolFrame,
  type ToolCompletion,
  type ToolResultRecord,
} from "../context/protocol-frame";
import {
  validateStoredContextSurface,
  type StoredContextSurfaceV8,
} from "../context/context-surface";
import type {
  StoredContextRevisionV8,
  StoredContextOverrideV8,
  SwapOverride,
} from "../context/context-revision";
import {
  SWAP_OBSERVATION_FORMAT,
  SWAP_TOOL_IMAGE_FORMAT,
} from "../context/context-swap-renderer";
import { SUPPORTED_RECALL_RETIREMENT_CONTRACT_VERSIONS } from "../context/recall-retirement-contract";
import type { ToolCall, ToolResultContent } from "../agent/types";
import {
  toolResultDisplayText,
  validateToolResultContent,
} from "../agent/tool-result-content";
import {
  parseImageAssetId,
  parseImageAttachmentId,
  validateOriginalImageName,
  validateUserMessage,
  type ImageAssetRef,
  type UserImageAttachment,
} from "../image/image-types";
import type { ProjectInstructionManifest } from "../instructions/project-instructions";
import type {
  ActiveSkillManifestEntry,
  SkillCatalogManifestEntry,
} from "../skills/skill-catalog";
import {
  SKILL_ACTIVATION_RECEIPT_FORMAT,
  SKILL_POLICY_VERSION,
} from "../skills/skill-context";
import type { StoredSkillActivation } from "./session-store-contracts";
import { decodeStoredToolRawResult } from "./session-tool-result-codec";
import {
  assertObjectKeys,
  enumFromSql,
  nullableNumberFromSql,
  nullableStringFromSql,
  nullableTextFromSql,
  numberFromJson,
  numberFromSql,
  parseJson,
  recordFromSql,
  sha256FromSql,
  stringFromSql,
  timestampFromSql,
  timestampValue,
} from "./session-store-value-codecs";

export function decodeFrame(rowValue: unknown): ProtocolFrame {
  const row = recordFromSql(rowValue, "protocol frame");
  const state = enumFromSql(row.state, ["open", "closed"] as const, "frame state");
  const kind = enumFromSql(
    row.kind,
    ["system", "user", "assistant_text", "tool_exchange"] as const,
    "frame kind",
  );
  const lastOrdinal = nullableNumberFromSql(row.last_ordinal, "last_ordinal");
  const closedAt = nullableStringFromSql(row.closed_at, "closed_at");
  return immutableRecord({
    frameId: stringFromSql(row.frame_id, "frame_id") as ProtocolFrameId,
    sessionId: stringFromSql(row.session_id, "session_id") as SessionId,
    ...(row.turn_id === null
      ? {}
      : { turnId: stringFromSql(row.turn_id, "turn_id") as TurnId }),
    ...(row.iteration_id === null
      ? {}
      : {
          iterationId: stringFromSql(row.iteration_id, "iteration_id") as IterationId,
        }),
    kind,
    state,
    firstOrdinal: numberFromSql(row.first_ordinal, "first_ordinal"),
    ...(lastOrdinal === null ? {} : { lastOrdinal }),
    createdAt: timestampFromSql(row.created_at, "created_at"),
    ...(closedAt === null ? {} : { closedAt: timestampValue(closedAt, "closed_at") }),
  });
}

export function loadMessageImageAttachments(
  database: Database,
): Map<string, readonly UserImageAttachment[]> {
  const rows = database
    .query(
      `SELECT mia.*, ia.mime_type, ia.byte_length, ia.width, ia.height,
              ia.created_at AS asset_created_at
       FROM message_image_attachments mia
       JOIN image_assets ia ON ia.asset_id = mia.asset_id
       JOIN messages m ON m.message_id = mia.message_id
       ORDER BY m.ordinal, mia.position`,
    )
    .all();
  const mutable = new Map<string, UserImageAttachment[]>();
  for (const rowValue of rows) {
    const row = recordFromSql(rowValue, "message image attachment");
    const messageId = stringFromSql(row.message_id, "attachment message_id");
    const attachments = mutable.get(messageId) ?? [];
    const position = numberFromSql(row.position, "attachment position");
    if (position !== attachments.length) {
      throw new Error(
        `Image attachment positions for message ${messageId} are not continuous.`,
      );
    }
    timestampFromSql(row.asset_created_at, "image asset created_at");
    const attachment = immutableRecord<UserImageAttachment>({
      attachmentId: parseImageAttachmentId(
        stringFromSql(row.attachment_id, "attachment_id"),
      ),
      assetId: parseImageAssetId(stringFromSql(row.asset_id, "asset_id")),
      mimeType: enumFromSql(
        row.mime_type,
        ["image/png", "image/jpeg", "image/webp"] as const,
        "image mime_type",
      ),
      byteLength: numberFromSql(row.byte_length, "image byte_length"),
      width: numberFromSql(row.width, "image width"),
      height: numberFromSql(row.height, "image height"),
      label: stringFromSql(row.label, "attachment label"),
      range: immutableRecord({
        start: numberFromSql(row.range_start, "attachment range_start"),
        end: numberFromSql(row.range_end, "attachment range_end"),
      }),
      originalName: stringFromSql(row.original_name, "attachment original_name"),
    });
    validateOriginalImageName(attachment.originalName);
    attachments.push(attachment);
    mutable.set(messageId, attachments);
  }
  return new Map(
    [...mutable].map(([messageId, attachments]) => [
      messageId,
      Object.freeze(attachments),
    ]),
  );
}

export function loadToolMessageContentBlocks(
  database: Database,
): Map<string, readonly ToolResultContent[]> {
  const rows = database
    .query(
      `SELECT tcb.*, ia.mime_type, ia.byte_length, ia.width, ia.height,
              ia.created_at AS asset_created_at
       FROM tool_message_content_blocks tcb
       LEFT JOIN image_assets ia ON ia.asset_id = tcb.asset_id
       JOIN messages m ON m.message_id = tcb.message_id
       ORDER BY m.ordinal, tcb.position`,
    )
    .all();
  const mutable = new Map<string, ToolResultContent[]>();
  for (const rowValue of rows) {
    const row = recordFromSql(rowValue, "tool message content block");
    const messageId = stringFromSql(row.message_id, "tool block message_id");
    const blocks = mutable.get(messageId) ?? [];
    const position = numberFromSql(row.position, "tool block position");
    if (position !== blocks.length) {
      throw new Error(
        `Tool content block positions for message ${messageId} are not continuous.`,
      );
    }
    const kind = enumFromSql(row.kind, ["text", "image"] as const, "tool block kind");
    const block: ToolResultContent =
      kind === "text"
        ? immutableRecord({
            type: "text",
            text: stringFromSql(row.text_content, "tool block text_content"),
          })
        : immutableRecord({
            type: "image",
            asset: immutableRecord({
              assetId: parseImageAssetId(
                stringFromSql(row.asset_id, "tool block asset_id"),
              ),
              mimeType: enumFromSql(
                row.mime_type,
                ["image/png", "image/jpeg", "image/webp"] as const,
                "tool block image mime_type",
              ),
              byteLength: numberFromSql(
                row.byte_length,
                "tool block image byte_length",
              ),
              width: numberFromSql(row.width, "tool block image width"),
              height: numberFromSql(row.height, "tool block image height"),
            }),
          });
    if (kind === "image") {
      timestampFromSql(row.asset_created_at, "tool block image asset created_at");
    }
    blocks.push(block);
    mutable.set(messageId, blocks);
  }
  return new Map(
    [...mutable].map(([messageId, blocks]) => {
      validateToolResultContent(blocks);
      return [messageId, Object.freeze(blocks)] as const;
    }),
  );
}

export function decodeMessage(
  rowValue: unknown,
  attachments?: readonly UserImageAttachment[],
  toolContentBlocks?: readonly ToolResultContent[],
): CanonicalMessageRecord {
  const row = recordFromSql(rowValue, "message");
  const base = {
    messageId: stringFromSql(row.message_id, "message_id") as MessageId,
    sessionId: stringFromSql(row.session_id, "session_id") as SessionId,
    frameId: stringFromSql(row.frame_id, "frame_id") as ProtocolFrameId,
    ordinal: numberFromSql(row.ordinal, "ordinal"),
    contentSha256: stringFromSql(row.content_sha256, "content_sha256"),
    createdAt: timestampFromSql(row.created_at, "created_at"),
  };
  const role = enumFromSql(
    row.role,
    ["system", "user", "assistant", "tool"] as const,
    "message role",
  );
  switch (role) {
    case "system":
      if (attachments !== undefined || toolContentBlocks !== undefined) {
        throw new Error("System messages cannot have media relation rows.");
      }
      return immutableRecord({
        ...base,
        role,
        content: stringFromSql(row.content, "content"),
        origin: "runtime",
      });
    case "user": {
      if (toolContentBlocks !== undefined) {
        throw new Error("User messages cannot have tool content blocks.");
      }
      const message = {
        ...base,
        role,
        turnId: stringFromSql(row.turn_id, "turn_id") as TurnId,
        content: stringFromSql(row.content, "content"),
        ...(attachments === undefined ? {} : { attachments }),
        origin: "user",
      } as const;
      validateUserMessage({
        role: "user",
        content: message.content,
        ...(message.attachments === undefined
          ? {}
          : { attachments: message.attachments }),
      });
      return immutableRecord(message);
    }
    case "assistant": {
      if (attachments !== undefined || toolContentBlocks !== undefined) {
        throw new Error("Assistant messages cannot have media relation rows.");
      }
      const content = nullableTextFromSql(row.content, "content");
      const reasoningPresent = numberFromSql(
        row.reasoning_content_present,
        "reasoning_content_present",
      );
      if (reasoningPresent !== 0 && reasoningPresent !== 1) {
        throw new Error("reasoning_content_present must be 0 or 1.");
      }
      const toolCalls =
        row.tool_calls_json === null
          ? undefined
          : decodeStoredToolCalls(
              stringFromSql(row.tool_calls_json, "tool_calls_json"),
            );
      return immutableRecord({
        ...base,
        role,
        turnId: stringFromSql(row.turn_id, "turn_id") as TurnId,
        iterationId: stringFromSql(row.iteration_id, "iteration_id") as IterationId,
        content,
        ...(reasoningPresent === 0
          ? {}
          : {
              reasoningContent: nullableTextFromSql(
                row.reasoning_content,
                "reasoning_content",
              ),
            }),
        ...(toolCalls === undefined ? {} : { toolCalls }),
        provider: stringFromSql(row.provider, "provider"),
        model: stringFromSql(row.model, "model"),
        origin: "model",
      });
    }
    case "tool": {
      if (attachments !== undefined) {
        throw new Error("Tool messages cannot have image attachments.");
      }
      if (toolContentBlocks === undefined) {
        throw new Error("Tool messages must have persisted content blocks.");
      }
      validateToolResultContent(toolContentBlocks);
      const displayText = stringFromSql(row.content, "content");
      if (toolResultDisplayText(toolContentBlocks) !== displayText) {
        throw new Error("Tool message display projection does not match its blocks.");
      }
      return immutableRecord({
        ...base,
        role,
        turnId: stringFromSql(row.turn_id, "turn_id") as TurnId,
        iterationId: stringFromSql(row.iteration_id, "iteration_id") as IterationId,
        toolCallId: stringFromSql(row.tool_call_id, "tool_call_id") as ToolCallId,
        providerToolCallId: stringFromSql(
          row.provider_tool_call_id,
          "provider_tool_call_id",
        ),
        name: stringFromSql(row.name, "name"),
        content: toolContentBlocks,
        displayText,
        origin: enumFromSql(row.origin, ["tool", "runtime"] as const, "tool origin"),
      });
    }
  }
}

export function imageAssetRefFromAttachment(
  attachment: UserImageAttachment,
): ImageAssetRef {
  return Object.freeze({
    assetId: attachment.assetId,
    mimeType: attachment.mimeType,
    byteLength: attachment.byteLength,
    width: attachment.width,
    height: attachment.height,
  });
}

export function decodeToolResult(rowValue: unknown): ToolResultRecord {
  const row = recordFromSql(rowValue, "tool result");
  const kind = enumFromSql(
    row.completion_kind,
    ["returned", "synthetic"] as const,
    "completion kind",
  );
  let completion: ToolCompletion;
  if (kind === "returned") {
    completion = immutableRecord({
      kind,
      raw: decodeStoredToolRawResult(
        parseJson(stringFromSql(row.raw_json, "raw_json"), "raw_json"),
      ),
      rawSha256: stringFromSql(row.raw_sha256, "raw_sha256"),
      observationFormat: enumFromSql(
        row.observation_format,
        SUPPORTED_TOOL_OBSERVATION_FORMATS,
        "observation format",
      ),
    });
  } else {
    const reason = enumFromSql(
      row.synthetic_reason,
      [
        "cancelled_active",
        "skipped_after_cancel",
        "failed_active",
        "skipped_after_failure",
        "interrupted_active",
        "skipped_after_interruption",
      ] as const,
      "synthetic reason",
    );
    completion = immutableRecord({
      kind,
      reason,
      ...(row.synthetic_detail === null
        ? {}
        : {
            detail: stringFromSql(row.synthetic_detail, "synthetic_detail"),
          }),
    });
  }
  return immutableRecord({
    sessionId: stringFromSql(row.session_id, "session_id") as SessionId,
    frameId: stringFromSql(row.frame_id, "frame_id") as ProtocolFrameId,
    toolCallId: stringFromSql(row.tool_call_id, "tool_call_id") as ToolCallId,
    toolMessageId: stringFromSql(row.tool_message_id, "tool_message_id") as MessageId,
    completion,
    observationSha256: stringFromSql(row.observation_sha256, "observation_sha256"),
    createdAt: timestampFromSql(row.created_at, "created_at"),
  });
}

export function decodeContextSurface(rowValue: unknown): StoredContextSurfaceV8 {
  const row = recordFromSql(rowValue, "context surface");
  const projectInstruction =
    row.project_instruction_json === null
      ? undefined
      : decodeProjectInstructionManifest(
          parseJson(
            stringFromSql(row.project_instruction_json, "project_instruction_json"),
            "project_instruction_json",
          ),
        );
  const toolDefinitions = decodeToolDefinitions(
    parseJson(
      stringFromSql(row.tool_definitions_json, "tool_definitions_json"),
      "tool_definitions_json",
    ),
  );
  const skillCatalog = decodeSkillCatalogManifest(
    parseJson(
      stringFromSql(row.skill_catalog_json, "skill_catalog_json"),
      "skill_catalog_json",
    ),
  );
  const activeSkills = decodeActiveSkillsManifest(
    parseJson(
      stringFromSql(row.active_skills_json, "active_skills_json"),
      "active_skills_json",
    ),
  );
  const surface = Object.freeze({
    surfaceId: stringFromSql(row.surface_id, "surface_id") as ContextSurfaceId,
    sessionId: stringFromSql(row.session_id, "session_id") as SessionId,
    systemPrompt: stringFromSql(row.system_prompt, "system_prompt"),
    systemPromptSha256: sha256FromSql(row.system_prompt_sha256, "system_prompt_sha256"),
    recallContractVersion: enumFromSql(
      row.recall_contract_version,
      SUPPORTED_RECALL_RETIREMENT_CONTRACT_VERSIONS,
      "recall_contract_version",
    ),
    ...(projectInstruction === undefined ? {} : { projectInstruction }),
    skillCatalog,
    skillCatalogSha256: sha256FromSql(row.skill_catalog_sha256, "skill_catalog_sha256"),
    activeSkills,
    activeSkillsSha256: sha256FromSql(row.active_skills_sha256, "active_skills_sha256"),
    toolDefinitions,
    toolDefinitionsSha256: sha256FromSql(
      row.tool_definitions_sha256,
      "tool_definitions_sha256",
    ),
    toolSchemaSha256: sha256FromSql(row.tool_schema_sha256, "tool_schema_sha256"),
    requestConfigSha256: sha256FromSql(
      row.request_config_sha256,
      "request_config_sha256",
    ),
    requestMaxOutputTokens: numberFromSql(
      row.request_max_output_tokens,
      "request_max_output_tokens",
    ),
    surfaceSha256: sha256FromSql(row.surface_sha256, "surface_sha256"),
    createdAt: timestampFromSql(row.created_at, "created_at"),
  });
  validateStoredContextSurface(surface);
  return surface;
}

export function decodeContextRevision(rowValue: unknown): StoredContextRevisionV8 {
  const row = recordFromSql(rowValue, "context revision");
  const kind = enumFromSql(
    row.kind,
    [
      "initial_full",
      "swap_only",
      "surface_refresh",
      "prefix_retirement",
      "skills_update",
    ] as const,
    "context revision kind",
  );
  const common = {
    revisionId: stringFromSql(row.revision_id, "revision_id") as ContextRevisionId,
    sessionId: stringFromSql(row.session_id, "session_id") as SessionId,
    surfaceId: stringFromSql(row.surface_id, "surface_id") as ContextSurfaceId,
    surfaceSha256: sha256FromSql(row.surface_sha256, "surface_sha256"),
    keepFromOrdinal: numberFromSql(row.keep_from_ordinal, "keep_from_ordinal"),
    sourceThroughOrdinal: numberFromSql(
      row.source_through_ordinal,
      "source_through_ordinal",
    ),
    addedOverrideCount: numberFromSql(row.added_override_count, "added_override_count"),
    activeOverrideCount: numberFromSql(
      row.active_override_count,
      "active_override_count",
    ),
    activeOverrideManifestSha256: sha256FromSql(
      row.active_override_manifest_sha256,
      "active_override_manifest_sha256",
    ),
    canonicalSequenceSha256: sha256FromSql(
      row.canonical_sequence_sha256,
      "canonical_sequence_sha256",
    ),
    renderedMessageSha256: sha256FromSql(
      row.rendered_message_sha256,
      "rendered_message_sha256",
    ),
    createdAt: timestampFromSql(row.created_at, "created_at"),
  };
  if (common.keepFromOrdinal < 1) {
    throw new Error("Context revision keep_from_ordinal must be positive.");
  }
  const revisionNumber = numberFromSql(row.revision_number, "revision_number");
  const parentRevisionId = nullableStringFromSql(
    row.parent_revision_id,
    "parent_revision_id",
  ) as ContextRevisionId | null;
  if (kind === "initial_full") {
    if (
      revisionNumber !== 1 ||
      parentRevisionId !== null ||
      common.sourceThroughOrdinal !== 1 ||
      common.addedOverrideCount !== 0 ||
      common.activeOverrideCount !== 0 ||
      common.keepFromOrdinal !== 1 ||
      row.policy_version !== null ||
      row.renderer_format !== null ||
      row.plan_sha256 !== null ||
      row.change_manifest_sha256 !== null ||
      row.activation_manifest_sha256 !== null ||
      !hasNoRetirementFields(row)
    ) {
      throw new Error("Initial context revision row is invalid.");
    }
    return Object.freeze({
      ...common,
      revisionNumber: 1,
      parentRevisionId: null,
      kind,
      keepFromOrdinal: 1,
      sourceThroughOrdinal: 1,
      addedOverrideCount: 0,
      activeOverrideCount: 0,
    });
  }
  if (
    kind === "swap_only" &&
    (revisionNumber < 2 ||
      parentRevisionId === null ||
      common.addedOverrideCount < 1 ||
      common.activeOverrideCount < common.addedOverrideCount)
  ) {
    throw new Error("Swap context revision row is invalid.");
  }
  if (kind === "swap_only") {
    if (
      row.change_manifest_sha256 !== null ||
      row.activation_manifest_sha256 !== null ||
      !hasNoRetirementFields(row)
    ) {
      throw new Error("Swap context revision has a change manifest.");
    }
    return Object.freeze({
      ...common,
      revisionNumber,
      parentRevisionId: parentRevisionId!,
      kind,
      policyVersion: enumFromSql(
        row.policy_version,
        ["swap-only-v1"] as const,
        "context revision policy",
      ),
      rendererFormat: enumFromSql(
        row.renderer_format,
        [SWAP_OBSERVATION_FORMAT] as const,
        "context revision renderer format",
      ),
      planSha256: sha256FromSql(row.plan_sha256, "plan_sha256"),
    });
  }
  if (kind === "skills_update") {
    if (
      revisionNumber < 2 ||
      parentRevisionId === null ||
      common.addedOverrideCount < 1 ||
      common.activeOverrideCount < common.addedOverrideCount ||
      row.plan_sha256 !== null ||
      !hasNoRetirementFields(row)
    ) {
      throw new Error("Agent Skills context revision row is invalid.");
    }
    return Object.freeze({
      ...common,
      revisionNumber,
      parentRevisionId,
      kind,
      policyVersion: enumFromSql(
        row.policy_version,
        [SKILL_POLICY_VERSION] as const,
        "Agent Skills context revision policy",
      ),
      rendererFormat: enumFromSql(
        row.renderer_format,
        [SKILL_ACTIVATION_RECEIPT_FORMAT] as const,
        "Agent Skills context revision renderer format",
      ),
      changeManifestSha256: sha256FromSql(
        row.change_manifest_sha256,
        "change_manifest_sha256",
      ),
      activationManifestSha256: sha256FromSql(
        row.activation_manifest_sha256,
        "activation_manifest_sha256",
      ),
    });
  }
  if (kind === "prefix_retirement") {
    const retiredThroughOrdinal = numberFromSql(
      row.retired_through_ordinal,
      "retired_through_ordinal",
    );
    const retiredTurnCount = numberFromSql(
      row.retired_turn_count,
      "retired_turn_count",
    );
    const retiredFrameCount = numberFromSql(
      row.retired_frame_count,
      "retired_frame_count",
    );
    const retiredMessageCount = numberFromSql(
      row.retired_message_count,
      "retired_message_count",
    );
    if (
      revisionNumber < 2 ||
      parentRevisionId === null ||
      common.keepFromOrdinal <= 1 ||
      common.addedOverrideCount !== 0 ||
      retiredThroughOrdinal !== common.keepFromOrdinal - 1 ||
      retiredTurnCount < 1 ||
      retiredFrameCount < 1 ||
      retiredMessageCount < 1 ||
      row.renderer_format !== null ||
      row.change_manifest_sha256 !== null ||
      row.activation_manifest_sha256 !== null
    ) {
      throw new Error("Prefix retirement revision row is invalid.");
    }
    return Object.freeze({
      ...common,
      revisionNumber,
      parentRevisionId,
      kind,
      addedOverrideCount: 0,
      policyVersion: enumFromSql(
        row.policy_version,
        ["recall-first-retirement-v1"] as const,
        "context revision policy",
      ),
      planSha256: sha256FromSql(row.plan_sha256, "plan_sha256"),
      retiredThroughOrdinal,
      retiredTurnCount,
      retiredFrameCount,
      retiredMessageCount,
    });
  }
  if (
    revisionNumber < 2 ||
    parentRevisionId === null ||
    common.addedOverrideCount !== 0 ||
    row.policy_version !== null ||
    row.renderer_format !== null ||
    row.plan_sha256 !== null ||
    row.activation_manifest_sha256 !== null ||
    !hasNoRetirementFields(row)
  ) {
    throw new Error("Surface context revision row is invalid.");
  }
  return Object.freeze({
    ...common,
    revisionNumber,
    parentRevisionId,
    kind,
    addedOverrideCount: 0,
    changeManifestSha256: sha256FromSql(
      row.change_manifest_sha256,
      "change_manifest_sha256",
    ),
  });
}

function hasNoRetirementFields(row: Record<string, unknown>): boolean {
  return (
    row.retired_through_ordinal === null &&
    row.retired_turn_count === null &&
    row.retired_frame_count === null &&
    row.retired_message_count === null
  );
}

export function decodeStoredSwapOverride(rowValue: unknown): StoredContextOverrideV8 {
  const row = recordFromSql(rowValue, "context override");
  if (row.representation !== "swapped") {
    throw new Error("Context override representation must be swapped.");
  }
  return Object.freeze({
    introducedRevisionId: stringFromSql(
      row.introduced_revision_id,
      "introduced_revision_id",
    ) as ContextRevisionId,
    frameId: stringFromSql(row.frame_id, "frame_id") as ProtocolFrameId,
    messageId: stringFromSql(row.message_id, "message_id") as MessageId,
    ordinal: numberFromSql(row.ordinal, "ordinal"),
    rendererFormat: enumFromSql(
      row.renderer_format,
      [
        SWAP_OBSERVATION_FORMAT,
        SWAP_TOOL_IMAGE_FORMAT,
        SKILL_ACTIVATION_RECEIPT_FORMAT,
      ] as const,
      "context override renderer format",
    ),
    source: stringFromSql(row.source, "source") as StoredContextOverrideV8["source"],
    originalContentSha256: sha256FromSql(
      row.original_content_sha256,
      "original_content_sha256",
    ),
    renderedContent: stringFromSql(row.rendered_content, "rendered_content"),
    renderedContentSha256: sha256FromSql(
      row.rendered_content_sha256,
      "rendered_content_sha256",
    ),
    originalBytes: numberFromSql(row.original_bytes, "original_bytes"),
    renderedBytes: numberFromSql(row.rendered_bytes, "rendered_bytes"),
    byteSavings: numberFromSql(row.byte_savings, "byte_savings"),
    createdAt: timestampFromSql(row.created_at, "created_at"),
  });
}

export function stripStoredOverride(override: StoredContextOverrideV8): SwapOverride {
  return Object.freeze({
    frameId: override.frameId,
    messageId: override.messageId,
    ordinal: override.ordinal,
    source: override.source,
    originalContentSha256: override.originalContentSha256,
    renderedContent: override.renderedContent,
    renderedContentSha256: override.renderedContentSha256,
    originalBytes: override.originalBytes,
    renderedBytes: override.renderedBytes,
    byteSavings: override.byteSavings,
    ...(override.rendererFormat === SWAP_OBSERVATION_FORMAT
      ? {}
      : { rendererFormat: override.rendererFormat }),
  });
}

export function decodeSkillActivation(rowValue: unknown): StoredSkillActivation {
  const row = recordFromSql(rowValue, "skill activation");
  const state = enumFromSql(
    row.state,
    ["pending", "dispatched", "promoted", "rejected"] as const,
    "skill activation state",
  );
  const dispatchedIterationId = nullableStringFromSql(
    row.dispatched_iteration_id,
    "dispatched_iteration_id",
  ) as IterationId | null;
  const settledRevisionId = nullableStringFromSql(
    row.settled_revision_id,
    "settled_revision_id",
  ) as ContextRevisionId | null;
  const rejectionReason = nullableStringFromSql(
    row.rejection_reason,
    "rejection_reason",
  );
  if (
    (state === "pending" &&
      (dispatchedIterationId !== null ||
        settledRevisionId !== null ||
        rejectionReason !== null)) ||
    (state === "dispatched" &&
      (dispatchedIterationId === null ||
        settledRevisionId !== null ||
        rejectionReason !== null)) ||
    (state === "promoted" &&
      (dispatchedIterationId === null ||
        settledRevisionId === null ||
        rejectionReason !== null)) ||
    (state === "rejected" &&
      (settledRevisionId === null ||
        rejectionReason === null ||
        rejectionReason.trim() === ""))
  ) {
    throw new Error("Skill activation lifecycle fields are invalid.");
  }
  return Object.freeze({
    activationMessageId: stringFromSql(
      row.activation_message_id,
      "activation_message_id",
    ) as MessageId,
    toolCallId: stringFromSql(row.tool_call_id, "tool_call_id") as ToolCallId,
    sessionId: stringFromSql(row.session_id, "session_id") as SessionId,
    name: stringFromSql(row.name, "skill activation name"),
    scope: enumFromSql(
      row.scope,
      ["project", "user"] as const,
      "skill activation scope",
    ),
    skillFileSha256: sha256FromSql(row.skill_file_sha256, "skill_file_sha256"),
    state,
    ...(dispatchedIterationId === null ? {} : { dispatchedIterationId }),
    ...(settledRevisionId === null ? {} : { settledRevisionId }),
    ...(rejectionReason === null ? {} : { rejectionReason }),
    createdAt: timestampFromSql(row.created_at, "created_at"),
    updatedAt: timestampFromSql(row.updated_at, "updated_at"),
  });
}

export function protocolPrefixView(
  canonical: ProtocolContextView,
  throughOrdinal: number,
): ProtocolContextView {
  const messages = canonical.messages.filter(
    (message) => message.ordinal <= throughOrdinal,
  );
  const messageIds = new Set(messages.map((message) => message.messageId));
  return Object.freeze({
    sessionId: canonical.sessionId,
    faulted: false,
    frames: Object.freeze(
      canonical.frames.filter(
        (frame) =>
          frame.state === "closed" &&
          frame.lastOrdinal !== undefined &&
          frame.lastOrdinal <= throughOrdinal,
      ),
    ),
    messages: Object.freeze(messages),
    toolResults: Object.freeze(
      canonical.toolResults.filter((result) => messageIds.has(result.toolMessageId)),
    ),
  });
}

export function decodeStoredToolCalls(json: string): readonly ToolCall[] {
  const value = parseJson(json, "tool_calls_json");
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("tool_calls_json must contain a non-empty array.");
  }
  const calls = value.map((entry, index): ToolCall => {
    const call = recordFromSql(entry, `tool call ${index}`);
    assertObjectKeys(
      call,
      [
        "args",
        "argsParseError",
        "iterationId",
        "iterationNumber",
        "name",
        "providerToolCallId",
        "rawArgs",
        "sessionId",
        "toolCallId",
        "toolCallNumber",
        "turnId",
        "turnNumber",
      ],
      [
        "args",
        "iterationId",
        "iterationNumber",
        "name",
        "providerToolCallId",
        "sessionId",
        "toolCallId",
        "toolCallNumber",
        "turnId",
        "turnNumber",
      ],
      `tool call ${index}`,
    );
    const toolCallNumber = numberFromJson(call.toolCallNumber, "toolCallNumber");
    return {
      sessionId: stringFromSql(call.sessionId, "sessionId") as SessionId,
      turnId: stringFromSql(call.turnId, "turnId") as TurnId,
      turnNumber: numberFromJson(call.turnNumber, "turnNumber"),
      iterationId: stringFromSql(call.iterationId, "iterationId") as IterationId,
      iterationNumber: numberFromJson(call.iterationNumber, "iterationNumber"),
      toolCallId: stringFromSql(call.toolCallId, "toolCallId") as ToolCallId,
      toolCallNumber,
      providerToolCallId: stringFromSql(call.providerToolCallId, "providerToolCallId"),
      name: stringFromSql(call.name, "name"),
      args: immutableCanonicalClone(call.args),
      ...(call.rawArgs === undefined
        ? {}
        : { rawArgs: stringFromSql(call.rawArgs, "rawArgs") }),
      ...(call.argsParseError === undefined
        ? {}
        : {
            argsParseError: stringFromSql(call.argsParseError, "argsParseError"),
          }),
    };
  });
  return Object.freeze(calls);
}

function decodeProjectInstructionManifest(value: unknown): ProjectInstructionManifest {
  const record = recordFromSql(value, "project instruction manifest");
  assertObjectKeys(
    record,
    ["path", "byteLength", "sha256"],
    ["path", "byteLength", "sha256"],
    "project instruction manifest",
  );
  return Object.freeze({
    path: enumFromSql(
      record.path,
      ["AGENTS.md", "CLAUDE.md"] as const,
      "project instruction path",
    ),
    byteLength: numberFromJson(record.byteLength, "project instruction byteLength"),
    sha256: sha256FromSql(record.sha256, "project instruction sha256"),
  });
}

function decodeSkillCatalogManifest(
  value: unknown,
): readonly SkillCatalogManifestEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("skill_catalog_json must contain an array.");
  }
  return Object.freeze(
    value.map((entry, index) => {
      const record = recordFromSql(entry, `skill catalog entry ${index}`);
      assertObjectKeys(
        record,
        [
          "name",
          "scope",
          "directorySha256",
          "descriptionSha256",
          "skillFileSha256",
          "byteLength",
        ],
        [
          "name",
          "scope",
          "directorySha256",
          "descriptionSha256",
          "skillFileSha256",
          "byteLength",
        ],
        `skill catalog entry ${index}`,
      );
      return Object.freeze({
        name: stringFromSql(record.name, "skill name"),
        scope: enumFromSql(record.scope, ["project", "user"] as const, "skill scope"),
        directorySha256: sha256FromSql(record.directorySha256, "skill directorySha256"),
        descriptionSha256: sha256FromSql(
          record.descriptionSha256,
          "skill descriptionSha256",
        ),
        skillFileSha256: sha256FromSql(record.skillFileSha256, "skill skillFileSha256"),
        byteLength: numberFromJson(record.byteLength, "skill byteLength"),
      });
    }),
  );
}

function decodeActiveSkillsManifest(
  value: unknown,
): readonly ActiveSkillManifestEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("active_skills_json must contain an array.");
  }
  return Object.freeze(
    value.map((entry, index) => {
      const record = recordFromSql(entry, `active skill entry ${index}`);
      assertObjectKeys(
        record,
        [
          "name",
          "scope",
          "directorySha256",
          "descriptionSha256",
          "skillFileSha256",
          "byteLength",
          "activationMessageId",
        ],
        [
          "name",
          "scope",
          "directorySha256",
          "descriptionSha256",
          "skillFileSha256",
          "byteLength",
          "activationMessageId",
        ],
        `active skill entry ${index}`,
      );
      const [catalogEntry] = decodeSkillCatalogManifest([
        {
          name: record.name,
          scope: record.scope,
          directorySha256: record.directorySha256,
          descriptionSha256: record.descriptionSha256,
          skillFileSha256: record.skillFileSha256,
          byteLength: record.byteLength,
        },
      ]);
      if (catalogEntry === undefined) {
        throw new Error(`Active skill entry ${index} is missing.`);
      }
      return Object.freeze({
        ...catalogEntry,
        activationMessageId: stringFromSql(
          record.activationMessageId,
          "skill activationMessageId",
        ) as MessageId,
      });
    }),
  );
}

function decodeToolDefinitions(value: unknown): readonly ToolDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error("tool_definitions_json must contain an array.");
  }
  const definitions = value.map((entry, index): ToolDefinition => {
    const record = recordFromSql(entry, `tool definition ${index}`);
    assertObjectKeys(
      record,
      ["name", "description", "parameters"],
      ["name", "description", "parameters"],
      `tool definition ${index}`,
    );
    const parameters = recordFromSql(
      record.parameters,
      `tool definition ${index} parameters`,
    );
    return Object.freeze({
      name: stringFromSql(record.name, `tool definition ${index} name`),
      description: stringFromSql(
        record.description,
        `tool definition ${index} description`,
      ),
      parameters: immutableCanonicalClone(parameters),
    });
  });
  return Object.freeze(definitions);
}
