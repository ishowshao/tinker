import type { ContextRevisionId, SessionId } from "../ids/runtime-id";
import {
  createModelContextProfile,
  type ModelContextProfile,
} from "../model/model-context-profile";
import {
  MODEL_MESSAGE_PROTOCOL_ADAPTERS,
  type ModelMessageProtocol,
} from "../model/model-client";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import { immutableCanonicalClone } from "../context/protocol-frame";
import type { ProjectInstructionManifest } from "../instructions/project-instructions";
import {
  IMAGE_INPUT_POLICY,
  IMAGE_INPUT_POLICY_VERSION,
} from "../image/image-input-policy";
import type {
  SessionCompatibilityContract,
  StoredSessionMetaV10,
} from "./session-store-contracts";
import {
  assertObjectKeys,
  enumFromSql,
  nullableNumberFromSql,
  nullableStringFromSql,
  numberFromJson,
  numberFromSql,
  parseJson,
  recordFromSql,
  sha256FromSql,
  stringFromSql,
  timestampFromSql,
} from "./session-store-value-codecs";

export function createSessionCompatibilityContract(input: {
  modelName: string;
  profileName?: string;
  includeReasoningContent: boolean;
  contextProfile: ModelContextProfile;
  messageProtocol: ModelMessageProtocol;
  inputModalities: readonly ("text" | "image")[];
  toolResultModalities: readonly ("text" | "image")[];
}): SessionCompatibilityContract {
  if (input.modelName.trim() === "") {
    throw new Error("Session compatibility model name must not be empty.");
  }
  if (input.profileName !== undefined && input.profileName.trim() === "") {
    throw new Error("Session compatibility profile name must not be empty.");
  }
  if (typeof input.includeReasoningContent !== "boolean") {
    throw new Error("Session compatibility reasoning replay flag must be boolean.");
  }
  if (
    !MODEL_MESSAGE_PROTOCOL_ADAPTERS.includes(input.messageProtocol.adapter) ||
    input.messageProtocol.serializationVersion.trim() === ""
  ) {
    throw new Error("Session compatibility message protocol is invalid.");
  }
  const inputModalities = normalizeInputModalities(input.inputModalities);
  const toolResultModalities = normalizeInputModalities(input.toolResultModalities);
  if (toolResultModalities.includes("image") && !inputModalities.includes("image")) {
    throw new Error("Session compatibility image tool results require image input.");
  }
  return Object.freeze({
    modelName: input.modelName,
    ...(input.profileName === undefined ? {} : { profileName: input.profileName }),
    includeReasoningContent: input.includeReasoningContent,
    contextProfile: Object.freeze(createModelContextProfile(input.contextProfile)),
    messageProtocol: immutableCanonicalClone(input.messageProtocol),
    media: Object.freeze({
      policyVersion: IMAGE_INPUT_POLICY_VERSION,
      policySha256: sha256(
        stableJsonStringify({
          version: IMAGE_INPUT_POLICY_VERSION,
          ...IMAGE_INPUT_POLICY,
        }),
      ),
      inputModalities,
      toolResultModalities,
    }),
  });
}

export function normalizeSessionCompatibilityContract(
  contract: SessionCompatibilityContract,
): SessionCompatibilityContract {
  return createSessionCompatibilityContract({
    modelName: contract.modelName,
    ...(contract.profileName === undefined
      ? {}
      : { profileName: contract.profileName }),
    includeReasoningContent: contract.includeReasoningContent,
    contextProfile: contract.contextProfile,
    messageProtocol: contract.messageProtocol,
    inputModalities: contract.media.inputModalities,
    toolResultModalities: contract.media.toolResultModalities,
  });
}

function normalizeInputModalities(
  modalities: readonly ("text" | "image")[],
): readonly ("text" | "image")[] {
  if (
    modalities.length === 0 ||
    modalities.some((value) => value !== "text" && value !== "image") ||
    new Set(modalities).size !== modalities.length ||
    !modalities.includes("text")
  ) {
    throw new Error("Session compatibility input modalities are invalid.");
  }
  return Object.freeze(
    modalities.includes("image") ? (["text", "image"] as const) : (["text"] as const),
  );
}

export function decodeMeta(
  value: unknown,
  expectedSessionId: SessionId,
): StoredSessionMetaV10 {
  const row = recordFromSql(value, "session metadata");
  const sessionId = stringFromSql(row.session_id, "session_id") as SessionId;
  if (sessionId !== expectedSessionId) {
    throw new Error(`Metadata session ID ${sessionId} does not match directory.`);
  }
  const schemaVersion = numberFromSql(row.schema_version, "schema_version");
  if (schemaVersion !== 10) {
    throw new Error(
      `Session metadata schema version must be 10; received ${schemaVersion}.`,
    );
  }
  const projectInstructionFile = nullableStringFromSql(
    row.project_instruction_file,
    "project_instruction_file",
  );
  const projectInstructionByteLength = nullableNumberFromSql(
    row.project_instruction_byte_length,
    "project_instruction_byte_length",
  );
  const projectInstructionSha256 = nullableStringFromSql(
    row.project_instruction_sha256,
    "project_instruction_sha256",
  );
  if (
    (projectInstructionFile === null) !== (projectInstructionByteLength === null) ||
    (projectInstructionFile === null) !== (projectInstructionSha256 === null)
  ) {
    throw new Error("Project instruction metadata must be entirely set or null.");
  }
  if (
    projectInstructionFile !== null &&
    projectInstructionFile !== "AGENTS.md" &&
    projectInstructionFile !== "CLAUDE.md"
  ) {
    throw new Error(`Invalid project instruction file ${projectInstructionFile}.`);
  }
  const projectInstruction: ProjectInstructionManifest | undefined =
    projectInstructionFile === null ||
    projectInstructionByteLength === null ||
    projectInstructionSha256 === null
      ? undefined
      : {
          path: projectInstructionFile === "AGENTS.md" ? "AGENTS.md" : "CLAUDE.md",
          byteLength: projectInstructionByteLength,
          sha256: sha256FromSql(projectInstructionSha256, "project_instruction_sha256"),
        };
  const initializationState = enumFromSql(
    row.initialization_state,
    ["creating", "ready"] as const,
    "initialization_state",
  );
  const sessionCompatibilityJson = nullableStringFromSql(
    row.session_compatibility_json,
    "session_compatibility_json",
  );
  const sessionCompatibilitySha256 = nullableStringFromSql(
    row.session_compatibility_sha256,
    "session_compatibility_sha256",
  );
  const activeRevisionId = nullableStringFromSql(
    row.active_revision_id,
    "active_revision_id",
  ) as ContextRevisionId | null;
  const modelName = stringFromSql(row.model_name, "model_name");
  const storedContract =
    sessionCompatibilityJson === null
      ? undefined
      : decodeSessionCompatibilityContract(sessionCompatibilityJson);
  if (
    (sessionCompatibilityJson === null) !== (sessionCompatibilitySha256 === null) ||
    (sessionCompatibilityJson !== null &&
      sha256(sessionCompatibilityJson) !== sessionCompatibilitySha256) ||
    (initializationState === "creating") !== (activeRevisionId === null) ||
    (initializationState === "creating") !== (sessionCompatibilityJson === null) ||
    (storedContract !== undefined &&
      (storedContract.modelName !== modelName ||
        stableJsonStringify(storedContract) !== sessionCompatibilityJson))
  ) {
    throw new Error("Session compatibility or initialization metadata is invalid.");
  }
  return {
    schemaVersion,
    schemaFingerprint: stringFromSql(row.schema_fingerprint, "schema_fingerprint"),
    initializationState,
    sessionId,
    workspaceRoot: stringFromSql(row.workspace_root, "workspace_root"),
    modelName,
    systemPromptSha256: stringFromSql(row.system_prompt_sha256, "system_prompt_sha256"),
    ...(projectInstruction === undefined ? {} : { projectInstruction }),
    sessionCompatibilityJson,
    sessionCompatibilitySha256,
    activeRevisionId,
    nextTurnNumber: numberFromSql(row.next_turn_number, "next_turn_number"),
    nextEventSequence: numberFromSql(row.next_event_sequence, "next_event_sequence"),
    openCount: numberFromSql(row.open_count, "open_count"),
    createdAt: timestampFromSql(row.created_at, "created_at"),
    updatedAt: timestampFromSql(row.updated_at, "updated_at"),
    lastOpenedAt: timestampFromSql(row.last_opened_at, "last_opened_at"),
    lastClosedAt:
      row.last_closed_at === null
        ? null
        : timestampFromSql(row.last_closed_at, "last_closed_at"),
    lastCloseReason:
      row.last_close_reason === null
        ? null
        : enumFromSql(
            row.last_close_reason,
            [
              "oneshot_complete",
              "tui_exit",
              "session_switch",
              "runner_failed",
              "initialization_failed",
            ] as const,
            "last_close_reason",
          ),
  };
}

export function compatibilityContractDifferences(
  storedJson: string | null,
  current: SessionCompatibilityContract,
): string[] {
  if (storedJson === null) {
    return ["sessionCompatibility"];
  }
  const stored = parseJson(storedJson, "session_compatibility_json");
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return ["sessionCompatibility"];
  }
  const record = stored as Record<string, unknown>;
  const fields: readonly (keyof SessionCompatibilityContract)[] = [
    "modelName",
    "profileName",
    "includeReasoningContent",
    "contextProfile",
    "messageProtocol",
    "media",
  ];
  return fields.filter((key) => {
    const storedValue = record[key];
    const currentValue = current[key];
    if (storedValue === undefined || currentValue === undefined) {
      return storedValue !== currentValue;
    }
    return stableJsonStringify(storedValue) !== stableJsonStringify(currentValue);
  });
}

function decodeSessionCompatibilityContract(
  json: string,
): SessionCompatibilityContract {
  const record = recordFromSql(
    parseJson(json, "session_compatibility_json"),
    "session compatibility contract",
  );
  assertObjectKeys(
    record,
    [
      "modelName",
      "profileName",
      "includeReasoningContent",
      "contextProfile",
      "messageProtocol",
      "media",
    ],
    [
      "modelName",
      "includeReasoningContent",
      "contextProfile",
      "messageProtocol",
      "media",
    ],
    "session compatibility contract",
  );
  const contextProfile = recordFromSql(
    record.contextProfile,
    "session compatibility context profile",
  );
  assertObjectKeys(
    contextProfile,
    ["contextWindowTokens", "maxSupportedOutputTokens"],
    ["contextWindowTokens", "maxSupportedOutputTokens"],
    "session compatibility context profile",
  );
  const messageProtocol = recordFromSql(
    record.messageProtocol,
    "session compatibility message protocol",
  );
  assertObjectKeys(
    messageProtocol,
    ["adapter", "serializationVersion"],
    ["adapter", "serializationVersion"],
    "session compatibility message protocol",
  );
  const media = recordFromSql(record.media, "session compatibility media");
  assertObjectKeys(
    media,
    ["policyVersion", "policySha256", "inputModalities", "toolResultModalities"],
    ["policyVersion", "policySha256", "inputModalities", "toolResultModalities"],
    "session compatibility media",
  );
  const inputModalities = decodeCompatibilityModalities(media.inputModalities, "input");
  const toolResultModalities = decodeCompatibilityModalities(
    media.toolResultModalities,
    "tool result",
  );
  if (toolResultModalities.includes("image") && !inputModalities.includes("image")) {
    throw new Error("Session compatibility image tool results require image input.");
  }
  if (typeof record.includeReasoningContent !== "boolean") {
    throw new Error("Session compatibility reasoning replay flag must be boolean.");
  }
  const modelName = stringFromSql(record.modelName, "compatibility modelName");
  const profileName =
    record.profileName === undefined
      ? undefined
      : stringFromSql(record.profileName, "compatibility profileName");
  const context = createModelContextProfile({
    contextWindowTokens: numberFromJson(
      contextProfile.contextWindowTokens,
      "compatibility contextWindowTokens",
    ),
    maxSupportedOutputTokens: numberFromJson(
      contextProfile.maxSupportedOutputTokens,
      "compatibility maxSupportedOutputTokens",
    ),
  });
  const protocol: ModelMessageProtocol = Object.freeze({
    adapter: enumFromSql(
      messageProtocol.adapter,
      MODEL_MESSAGE_PROTOCOL_ADAPTERS,
      "compatibility message adapter",
    ),
    serializationVersion: stringFromSql(
      messageProtocol.serializationVersion,
      "compatibility serializationVersion",
    ),
  });
  const policyVersion = stringFromSql(
    media.policyVersion,
    "compatibility image policyVersion",
  );
  const policySha256 = stringFromSql(
    media.policySha256,
    "compatibility image policySha256",
  );
  if (!/^[0-9a-f]{64}$/.test(policySha256)) {
    throw new Error("Session image policy hash is invalid.");
  }
  return Object.freeze({
    modelName,
    ...(record.profileName === undefined ? {} : { profileName: profileName! }),
    includeReasoningContent: record.includeReasoningContent,
    contextProfile: Object.freeze(context),
    messageProtocol: protocol,
    media: Object.freeze({
      policyVersion,
      policySha256,
      inputModalities,
      toolResultModalities,
    }),
  });
}

function decodeCompatibilityModalities(
  value: unknown,
  label: string,
): readonly ("text" | "image")[] {
  if (!Array.isArray(value)) {
    throw new Error(`Session compatibility ${label} modalities must be an array.`);
  }
  return normalizeInputModalities(
    value.map((modality) =>
      enumFromSql(
        modality,
        ["text", "image"] as const,
        `compatibility ${label} modality`,
      ),
    ),
  );
}
