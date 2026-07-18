import type { ProjectInstructionManifest } from "../instructions/project-instructions";
import type { ContextSurfaceId, SessionId } from "../ids/runtime-id";
import type { PreparedModelRequest } from "../model/model-client";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import type { ToolDefinition } from "../tools/types";
import { immutableCanonicalClone } from "./protocol-frame";
import {
  CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
  isSupportedRecallRetirementContractVersion,
  type RecallRetirementContractVersion,
} from "./recall-retirement-contract";

export type ContextSurfaceComponent =
  | "system_prompt"
  | "project_instruction"
  | "tool_definitions"
  | "request_config";

export type ContextSurfaceChanges = {
  readonly systemPrompt: boolean;
  readonly projectInstruction: boolean;
  readonly toolDefinitions: boolean;
  readonly requestConfig: boolean;
};

export type StoredContextSurfaceV7 = {
  readonly surfaceId: ContextSurfaceId;
  readonly sessionId: SessionId;
  readonly systemPrompt: string;
  readonly systemPromptSha256: string;
  readonly recallContractVersion: RecallRetirementContractVersion;
  readonly projectInstruction?: ProjectInstructionManifest;
  readonly toolDefinitions: readonly ToolDefinition[];
  readonly toolDefinitionsSha256: string;
  readonly toolSchemaSha256: string;
  readonly requestConfigSha256: string;
  readonly requestMaxOutputTokens: number;
  readonly surfaceSha256: string;
  readonly createdAt: string;
};

export function createContextSurface(input: {
  surfaceId: ContextSurfaceId;
  sessionId: SessionId;
  systemPrompt: string;
  recallContractVersion: RecallRetirementContractVersion;
  projectInstruction?: ProjectInstructionManifest;
  toolDefinitions: readonly ToolDefinition[];
  prepared: Pick<
    PreparedModelRequest,
    "requestConfigHash" | "requestMaxOutputTokens" | "toolSchemaHash"
  >;
  createdAt: string;
}): StoredContextSurfaceV7 {
  if (input.surfaceId.trim() === "" || input.sessionId.trim() === "") {
    throw new Error("Context surface identity must not be empty.");
  }
  if (input.systemPrompt.trim() === "") {
    throw new Error("Context surface system prompt must not be empty.");
  }
  if (input.recallContractVersion !== CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION) {
    throw new Error("New context surfaces must use the current Recall contract.");
  }
  if (
    !Number.isSafeInteger(input.prepared.requestMaxOutputTokens) ||
    input.prepared.requestMaxOutputTokens < 1
  ) {
    throw new Error("Context surface output token limit must be positive.");
  }
  assertSha256(input.prepared.requestConfigHash, "requestConfigHash");
  assertSha256(input.prepared.toolSchemaHash, "toolSchemaHash");
  validateProjectInstruction(input.projectInstruction);
  validateToolDefinitions(input.toolDefinitions);

  const toolDefinitions = Object.freeze(
    immutableCanonicalClone([...input.toolDefinitions]),
  );
  const projectInstruction =
    input.projectInstruction === undefined
      ? undefined
      : Object.freeze(immutableCanonicalClone(input.projectInstruction));
  const systemPromptSha256 = sha256(input.systemPrompt);
  const toolDefinitionsSha256 = sha256(stableJsonStringify(toolDefinitions));
  const manifest = {
    systemPromptSha256,
    recallContractVersion: input.recallContractVersion,
    ...(projectInstruction === undefined ? {} : { projectInstruction }),
    toolDefinitionsSha256,
    toolSchemaSha256: input.prepared.toolSchemaHash,
    requestConfigSha256: input.prepared.requestConfigHash,
    requestMaxOutputTokens: input.prepared.requestMaxOutputTokens,
  };

  return Object.freeze({
    surfaceId: input.surfaceId,
    sessionId: input.sessionId,
    systemPrompt: input.systemPrompt,
    systemPromptSha256,
    recallContractVersion: input.recallContractVersion,
    ...(projectInstruction === undefined ? {} : { projectInstruction }),
    toolDefinitions,
    toolDefinitionsSha256,
    toolSchemaSha256: input.prepared.toolSchemaHash,
    requestConfigSha256: input.prepared.requestConfigHash,
    requestMaxOutputTokens: input.prepared.requestMaxOutputTokens,
    surfaceSha256: sha256(stableJsonStringify(manifest)),
    createdAt: input.createdAt,
  });
}

export function contextSurfaceChanges(
  previous: StoredContextSurfaceV7,
  current: StoredContextSurfaceV7,
): ContextSurfaceChanges {
  return Object.freeze({
    systemPrompt:
      previous.systemPromptSha256 !== current.systemPromptSha256 ||
      previous.recallContractVersion !== current.recallContractVersion,
    projectInstruction:
      stableJsonStringify(previous.projectInstruction ?? null) !==
      stableJsonStringify(current.projectInstruction ?? null),
    toolDefinitions:
      previous.toolDefinitionsSha256 !== current.toolDefinitionsSha256 ||
      previous.toolSchemaSha256 !== current.toolSchemaSha256,
    requestConfig:
      previous.requestConfigSha256 !== current.requestConfigSha256 ||
      previous.requestMaxOutputTokens !== current.requestMaxOutputTokens,
  });
}

export function changedContextSurfaceComponents(
  changes: ContextSurfaceChanges,
): readonly ContextSurfaceComponent[] {
  const changed: ContextSurfaceComponent[] = [];
  if (changes.systemPrompt) changed.push("system_prompt");
  if (changes.projectInstruction) changed.push("project_instruction");
  if (changes.toolDefinitions) changed.push("tool_definitions");
  if (changes.requestConfig) changed.push("request_config");
  return Object.freeze(changed);
}

export function contextSurfaceChangeManifestHash(
  changes: ContextSurfaceChanges,
): string {
  return sha256(stableJsonStringify(changes));
}

export function sameContextSurface(
  previous: StoredContextSurfaceV7,
  current: StoredContextSurfaceV7,
): boolean {
  return previous.surfaceSha256 === current.surfaceSha256;
}

export function validateStoredContextSurface(surface: StoredContextSurfaceV7): void {
  if (surface.systemPromptSha256 !== sha256(surface.systemPrompt)) {
    throw new Error("Context surface system prompt hash does not match.");
  }
  if (!isSupportedRecallRetirementContractVersion(surface.recallContractVersion)) {
    throw new Error("Context surface Recall contract version is unsupported.");
  }
  validateToolDefinitions(surface.toolDefinitions);
  if (
    surface.toolDefinitionsSha256 !==
    sha256(stableJsonStringify(surface.toolDefinitions))
  ) {
    throw new Error("Context surface tool definitions hash does not match.");
  }
  for (const [name, value] of [
    ["toolSchemaSha256", surface.toolSchemaSha256],
    ["requestConfigSha256", surface.requestConfigSha256],
    ["surfaceSha256", surface.surfaceSha256],
  ] as const) {
    assertSha256(value, name);
  }
  const expectedManifest = {
    systemPromptSha256: surface.systemPromptSha256,
    recallContractVersion: surface.recallContractVersion,
    ...(surface.projectInstruction === undefined
      ? {}
      : { projectInstruction: surface.projectInstruction }),
    toolDefinitionsSha256: surface.toolDefinitionsSha256,
    toolSchemaSha256: surface.toolSchemaSha256,
    requestConfigSha256: surface.requestConfigSha256,
    requestMaxOutputTokens: surface.requestMaxOutputTokens,
  };
  if (sha256(stableJsonStringify(expectedManifest)) !== surface.surfaceSha256) {
    throw new Error("Context surface manifest hash does not match.");
  }
}

function validateToolDefinitions(definitions: readonly ToolDefinition[]): void {
  const names = new Set<string>();
  for (const definition of definitions) {
    if (definition.name.trim() === "") {
      throw new Error("Context surface tool name must not be empty.");
    }
    if (names.has(definition.name)) {
      throw new Error(`Context surface contains duplicate tool ${definition.name}.`);
    }
    names.add(definition.name);
    stableJsonStringify(definition);
  }
}

function validateProjectInstruction(
  instruction: ProjectInstructionManifest | undefined,
): void {
  if (instruction === undefined) {
    return;
  }
  if (
    (instruction.path !== "AGENTS.md" && instruction.path !== "CLAUDE.md") ||
    !Number.isSafeInteger(instruction.byteLength) ||
    instruction.byteLength < 1
  ) {
    throw new Error("Context surface project instruction manifest is invalid.");
  }
  assertSha256(instruction.sha256, "projectInstruction.sha256");
}

function assertSha256(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Context surface ${name} must be a SHA-256 hash.`);
  }
}
