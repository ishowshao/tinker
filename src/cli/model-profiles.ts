import path from "node:path";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  createModelContextProfile,
  type ModelContextProfile,
} from "../model/model-context-profile";

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
  readonly kind: "moonshot-estimate-token-count-v1";
  readonly model: string;
  readonly apiBase: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxRetries: 0;
};

export type ModelProfiles = {
  readonly defaultProfile: string;
  readonly profiles: ReadonlyMap<string, ModelProfile>;
};

export function modelsConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env.TINKER_MODELS;
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export async function loadModelProfiles(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelProfiles | undefined> {
  const configPath = modelsConfigPath(env);
  if (configPath === undefined) {
    return undefined;
  }

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
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const configPath = modelsConfigPath(env);
  if (configPath === undefined) {
    return;
  }

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

  return { defaultProfile, profiles };
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
    [
      "model",
      "apiBase",
      "apiKey",
      "contextWindowTokens",
      "maxSupportedOutputTokens",
      "includeReasoningContent",
      "stream",
      "inputModalities",
      "tokenEstimator",
    ],
    where,
  );

  const model = requireString(value.model, `${where}: "model"`);
  const apiBase = requireString(value.apiBase, `${where}: "apiBase"`);
  const apiKey = requireString(value.apiKey, `${where}: "apiKey"`);

  const contextWindowTokens = requirePositiveInteger(
    value.contextWindowTokens,
    `${where}: "contextWindowTokens"`,
  );
  const maxSupportedOutputTokens = requirePositiveInteger(
    value.maxSupportedOutputTokens,
    `${where}: "maxSupportedOutputTokens"`,
  );

  const includeReasoningContent =
    value.includeReasoningContent === undefined
      ? false
      : parseBoolean(
          value.includeReasoningContent,
          `${where}: "includeReasoningContent"`,
        );

  const stream =
    value.stream === undefined
      ? true
      : parseBoolean(value.stream, `${where}: "stream"`);

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

function parseInputModalities(
  value: unknown,
  name: string,
): readonly ModelInputModality[] {
  if (value === undefined) {
    return Object.freeze(["text"]);
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
    ["kind", "model", "apiBase", "apiKey", "timeoutMs", "maxRetries"],
    name,
  );
  if (value.kind !== "moonshot-estimate-token-count-v1") {
    throw new Error(`${name}.kind must be "moonshot-estimate-token-count-v1".`);
  }
  const model = requireString(value.model, `${name}.model`);
  const apiBase = requireString(value.apiBase, `${name}.apiBase`);
  const apiKey = requireString(value.apiKey, `${name}.apiKey`);
  const timeoutMs = requirePositiveInteger(value.timeoutMs, `${name}.timeoutMs`);
  if (timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error(`${name}.timeoutMs must be between 1000 and 60000.`);
  }
  if (value.maxRetries !== 0) {
    throw new Error(`${name}.maxRetries must be 0.`);
  }
  return Object.freeze({
    kind: value.kind,
    model,
    apiBase,
    apiKey,
    timeoutMs,
    maxRetries: 0,
  });
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

function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`${name} must be a boolean.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
