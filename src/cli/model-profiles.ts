import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  createModelContextProfile,
  type ModelContextProfile,
} from "../model/model-context-profile";
import {
  MEMORY_CONFIG_FIELDS,
  MEMORY_EMBEDDING_FIELDS,
  MODEL_PROFILE_FIELDS,
  MODEL_PROFILES_DOCUMENT_FIELDS,
  MODEL_TOKEN_ESTIMATOR_FIELDS,
  type ModelTokenEstimatorKind,
  type ModelTokenEstimatorMaxRetries,
} from "./public-config-contract";
import type { MemoryEmbeddingConfig } from "../memory/contracts";

export type ModelProfile = {
  readonly name: string;
  readonly model: string;
  readonly apiBase: string;
  readonly apiKey: string;
  readonly contextWindowTokens: number;
  readonly maxSupportedOutputTokens: number;
  readonly includeReasoningContent: boolean;
  readonly stream: boolean;
  readonly inputModalities: readonly ModelInputModality[];
  readonly tokenEstimator?: ModelTokenEstimatorProfile;
};

export type ModelInputModality = "text" | "image";

export type ModelTokenEstimatorProfile = {
  readonly kind: ModelTokenEstimatorKind;
  readonly model: string;
  readonly apiBase: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxRetries: ModelTokenEstimatorMaxRetries;
};

export type ModelProfiles = {
  readonly defaultProfile: string;
  readonly profiles: ReadonlyMap<string, ModelProfile>;
  readonly memory?: MemoryConfig;
};

export type MemoryConfig = {
  readonly profile: string;
  readonly embedding: MemoryEmbeddingConfig;
};

export async function loadModelProfiles(configPath: string): Promise<ModelProfiles> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read model profiles at ${configPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return parseModelProfiles(raw, configPath);
}

export async function persistDefaultProfile(
  profileName: string,
  configPath: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read model profiles at ${configPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const json = JSON.parse(raw) as Record<string, unknown>;
  if (json.default === profileName) {
    return;
  }

  const profileValues = json.profiles;
  if (!isRecord(profileValues) || profileValues[profileName] === undefined) {
    const available = isRecord(profileValues) ? Object.keys(profileValues) : [];
    throw unknownProfileNamesError(profileName, available);
  }
  json.default = profileName;
  parseModelProfiles(JSON.stringify(json), configPath);
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(json, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, configPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error(
      `Failed to persist default model profile at ${configPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function parseModelProfiles(raw: string, sourcePath: string): ModelProfiles {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in model profiles ${sourcePath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (!isRecord(json)) {
    throw new Error(`Model profiles ${sourcePath} must be a JSON object.`);
  }
  assertKnownKeys(
    json,
    MODEL_PROFILES_DOCUMENT_FIELDS.map((field) => field.name),
    `Model profiles ${sourcePath}`,
  );

  const defaultProfile = json.default;
  if (typeof defaultProfile !== "string" || defaultProfile.trim() === "") {
    throw new Error(
      `Model profiles ${sourcePath} requires a non-empty string "default" field.`,
    );
  }

  const profilesValue = json.profiles;
  if (!isRecord(profilesValue)) {
    throw new Error(
      `Model profiles ${sourcePath} requires an object "profiles" field.`,
    );
  }

  if (profilesValue[defaultProfile] === undefined) {
    throw new Error(
      `Model profiles ${sourcePath}: default profile "${defaultProfile}" is not defined in "profiles".`,
    );
  }

  const profiles = new Map<string, ModelProfile>();

  for (const [profileName, profileValue] of Object.entries(profilesValue)) {
    profiles.set(profileName, parseProfile(profileName, profileValue, sourcePath));
  }

  const memory =
    json.memory === undefined
      ? undefined
      : parseMemoryConfig(json.memory, profiles, sourcePath);
  return Object.freeze({
    defaultProfile,
    profiles,
    ...(memory === undefined ? {} : { memory }),
  });
}

export function resolveModelProfile(
  profiles: ModelProfiles | undefined,
  profileName: string | undefined,
): ModelProfile | undefined {
  if (profiles === undefined) {
    return undefined;
  }

  const name = profileName ?? profiles.defaultProfile;
  return profiles.profiles.get(name);
}

export function resolveSessionProfileName(
  profiles: ModelProfiles,
  session: { profileName?: string; modelName: string },
): string {
  if (session.profileName !== undefined) {
    if (!profiles.profiles.has(session.profileName)) {
      throw unknownProfileError(session.profileName, profiles);
    }
    return session.profileName;
  }

  const matches = [...profiles.profiles.values()].filter(
    (profile) => profile.model === session.modelName,
  );
  if (matches.length === 1) {
    return matches[0].name;
  }
  if (matches.length === 0) {
    throw new Error(
      `Legacy session model ${JSON.stringify(session.modelName)} does not match any configured profile.`,
    );
  }
  throw new Error(
    `Legacy session model ${JSON.stringify(session.modelName)} matches multiple profiles: ${matches.map((profile) => profile.name).join(", ")}.`,
  );
}

export function unknownProfileError(
  profileName: string,
  profiles: ModelProfiles,
): Error {
  return unknownProfileNamesError(profileName, [...profiles.profiles.keys()]);
}

function unknownProfileNamesError(
  profileName: string,
  profileNames: readonly string[],
): Error {
  const available = profileNames.join(", ");
  return new Error(
    `Unknown model profile ${JSON.stringify(profileName)}. Available profiles: ${available}.`,
  );
}

export function profileToContextProfile(profile: ModelProfile): ModelContextProfile {
  return createModelContextProfile({
    contextWindowTokens: profile.contextWindowTokens,
    maxSupportedOutputTokens: profile.maxSupportedOutputTokens,
  });
}

function parseProfile(
  profileName: string,
  value: unknown,
  sourcePath: string,
): ModelProfile {
  const where = `Model profiles ${sourcePath}: profile "${profileName}"`;

  if (profileName.trim() === "") {
    throw new Error(`${where} has an empty name.`);
  }

  if (!isRecord(value)) {
    throw new Error(`${where} must be an object.`);
  }

  assertKnownKeys(
    value,
    MODEL_PROFILE_FIELDS.map((field) => field.name),
    where,
  );

  const model = parseProfileString(value, "model", where);
  const apiBase = parseProfileString(value, "apiBase", where);
  const apiKey = parseProfileString(value, "apiKey", where);

  const contextWindowTokens = parseProfilePositiveInteger(
    value,
    "contextWindowTokens",
    where,
  );
  const maxSupportedOutputTokens = parseProfilePositiveInteger(
    value,
    "maxSupportedOutputTokens",
    where,
  );

  const includeReasoningContent = parseProfileBoolean(
    value,
    "includeReasoningContent",
    where,
  );
  const stream = parseProfileBoolean(value, "stream", where);

  const inputModalities = parseInputModalities(
    value.inputModalities,
    `${where}: "inputModalities"`,
  );
  const tokenEstimator =
    value.tokenEstimator === undefined
      ? undefined
      : parseTokenEstimator(value.tokenEstimator, `${where}: "tokenEstimator"`);
  if (inputModalities.includes("image") && tokenEstimator === undefined) {
    throw new Error(
      `${where}: image input requires a complete "tokenEstimator" configuration.`,
    );
  }

  createModelContextProfile({
    contextWindowTokens,
    maxSupportedOutputTokens,
  });

  return Object.freeze({
    name: profileName,
    model,
    apiBase,
    apiKey,
    contextWindowTokens,
    maxSupportedOutputTokens,
    includeReasoningContent,
    stream,
    inputModalities,
    ...(tokenEstimator === undefined ? {} : { tokenEstimator }),
  });
}

function parseMemoryConfig(
  value: unknown,
  profiles: ReadonlyMap<string, ModelProfile>,
  sourcePath: string,
): MemoryConfig {
  const where = `Model profiles ${sourcePath}: "memory"`;
  if (!isRecord(value)) {
    throw new Error(`${where} must be an object.`);
  }
  assertKnownKeys(
    value,
    MEMORY_CONFIG_FIELDS.map((field) => field.name),
    where,
  );
  const profile = requireString(value.profile, `${where}.profile`);
  if (!profiles.has(profile)) {
    throw unknownProfileNamesError(profile, [...profiles.keys()]);
  }
  const embedding = parseMemoryEmbedding(value.embedding, `${where}.embedding`);
  return Object.freeze({ profile, embedding });
}

function parseMemoryEmbedding(value: unknown, where: string): MemoryEmbeddingConfig {
  if (!isRecord(value)) {
    throw new Error(`${where} must be an object.`);
  }
  assertKnownKeys(
    value,
    MEMORY_EMBEDDING_FIELDS.map((field) => field.name),
    where,
  );
  const name = requireString(value.name, `${where}.name`);
  if (value.kind !== "openai-compatible") {
    throw new Error(`${where}.kind must be "openai-compatible".`);
  }
  const model = requireString(value.model, `${where}.model`);
  const apiBase = requireString(value.apiBase, `${where}.apiBase`);
  requireHttpUrl(apiBase, `${where}.apiBase`);
  const apiKey = requireString(value.apiKey, `${where}.apiKey`);
  const dimensions = requirePositiveInteger(value.dimensions, `${where}.dimensions`);
  return Object.freeze({
    name,
    kind: "openai-compatible",
    model,
    apiBase,
    apiKey,
    dimensions,
  });
}

function parseInputModalities(
  value: unknown,
  name: string,
): readonly ModelInputModality[] {
  if (value === undefined) {
    const defaultValue = modelProfileField("inputModalities").defaultValue;
    return defaultValue;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array.`);
  }
  const modalities = value.map((rawEntry): ModelInputModality => {
    const entry: unknown = rawEntry;
    if (entry !== "text" && entry !== "image") {
      throw new Error(`${name} contains an unsupported modality.`);
    }
    return entry;
  });
  if (new Set(modalities).size !== modalities.length) {
    throw new Error(`${name} must not contain duplicates.`);
  }
  if (!modalities.includes("text")) {
    throw new Error(`${name} must include "text".`);
  }
  return Object.freeze(
    modalities.includes("image") ? (["text", "image"] as const) : (["text"] as const),
  );
}

function parseTokenEstimator(value: unknown, name: string): ModelTokenEstimatorProfile {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object.`);
  }
  assertKnownKeys(
    value,
    MODEL_TOKEN_ESTIMATOR_FIELDS.map((field) => field.name),
    name,
  );
  const kindField = tokenEstimatorField("kind");
  if (value.kind !== kindField.literalValue) {
    throw new Error(`${name}.kind must be ${JSON.stringify(kindField.literalValue)}.`);
  }
  const model = parseTokenEstimatorString(value, "model", name);
  const apiBase = parseTokenEstimatorString(value, "apiBase", name);
  const apiKey = parseTokenEstimatorString(value, "apiKey", name);
  const timeoutField = tokenEstimatorField("timeoutMs");
  if (timeoutField.valueKind !== "positive-integer") {
    throw new Error("Token estimator timeoutMs contract kind is invalid.");
  }
  const timeoutMs = requirePositiveInteger(value.timeoutMs, `${name}.timeoutMs`);
  if (
    timeoutField.minimum === undefined ||
    timeoutField.maximum === undefined ||
    timeoutMs < timeoutField.minimum ||
    timeoutMs > timeoutField.maximum
  ) {
    throw new Error(
      `${name}.timeoutMs must be between ${timeoutField.minimum} and ${timeoutField.maximum}.`,
    );
  }
  const maxRetriesField = tokenEstimatorField("maxRetries");
  if (value.maxRetries !== maxRetriesField.literalValue) {
    throw new Error(`${name}.maxRetries must be ${maxRetriesField.literalValue}.`);
  }
  return Object.freeze({
    kind: kindField.literalValue,
    model,
    apiBase,
    apiKey,
    timeoutMs,
    maxRetries: maxRetriesField.literalValue,
  });
}

type ModelProfileFieldName = (typeof MODEL_PROFILE_FIELDS)[number]["name"];
type ModelTokenEstimatorFieldName =
  (typeof MODEL_TOKEN_ESTIMATOR_FIELDS)[number]["name"];

function modelProfileField<Name extends ModelProfileFieldName>(
  name: Name,
): Extract<(typeof MODEL_PROFILE_FIELDS)[number], { readonly name: Name }> {
  const field = MODEL_PROFILE_FIELDS.find((candidate) => candidate.name === name);
  if (field === undefined) {
    throw new Error(`Missing model profile field contract for ${name}.`);
  }
  return field as Extract<
    (typeof MODEL_PROFILE_FIELDS)[number],
    { readonly name: Name }
  >;
}

function tokenEstimatorField<Name extends ModelTokenEstimatorFieldName>(
  name: Name,
): Extract<(typeof MODEL_TOKEN_ESTIMATOR_FIELDS)[number], { readonly name: Name }> {
  const field = MODEL_TOKEN_ESTIMATOR_FIELDS.find(
    (candidate) => candidate.name === name,
  );
  if (field === undefined) {
    throw new Error(`Missing token estimator field contract for ${name}.`);
  }
  return field as Extract<
    (typeof MODEL_TOKEN_ESTIMATOR_FIELDS)[number],
    { readonly name: Name }
  >;
}

function parseProfileString(
  value: Record<string, unknown>,
  name: "model" | "apiBase" | "apiKey",
  where: string,
): string {
  const field = modelProfileField(name);
  if (field.valueKind !== "non-empty-string") {
    throw new Error(`Model profile field ${name} has an invalid contract kind.`);
  }
  return requireString(value[name], `${where}: ${JSON.stringify(name)}`);
}

function parseProfilePositiveInteger(
  value: Record<string, unknown>,
  name: "contextWindowTokens" | "maxSupportedOutputTokens",
  where: string,
): number {
  const field = modelProfileField(name);
  if (field.valueKind !== "positive-integer") {
    throw new Error(`Model profile field ${name} has an invalid contract kind.`);
  }
  return requirePositiveInteger(value[name], `${where}: ${JSON.stringify(name)}`);
}

function parseProfileBoolean(
  value: Record<string, unknown>,
  name: "includeReasoningContent" | "stream",
  where: string,
): boolean {
  const field = modelProfileField(name);
  if (field.valueKind !== "boolean" || typeof field.defaultValue !== "boolean") {
    throw new Error(`Model profile field ${name} has an invalid boolean contract.`);
  }
  return value[name] === undefined
    ? field.defaultValue
    : parseBoolean(value[name], `${where}: ${JSON.stringify(name)}`);
}

function parseTokenEstimatorString(
  value: Record<string, unknown>,
  name: "model" | "apiBase" | "apiKey",
  where: string,
): string {
  const field = tokenEstimatorField(name);
  if (field.valueKind !== "non-empty-string") {
    throw new Error(`Token estimator field ${name} has an invalid contract kind.`);
  }
  return requireString(value[name], `${where}.${name}`);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    throw new Error(`${name} contains unknown field ${JSON.stringify(unknown)}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function requireHttpUrl(value: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL.`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(`${name} must be a valid HTTP(S) URL.`);
  }
}

function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`${name} must be a boolean.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
