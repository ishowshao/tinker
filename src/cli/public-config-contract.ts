import path from "node:path";
import { rgPath } from "@vscode/ripgrep";

export type PublicConfigValueKind = "non-empty-string" | "positive-integer" | "boolean";

export type PublicConfigField = {
  readonly name: string;
  readonly valueKind: PublicConfigValueKind;
  readonly requiredIn: "always" | "env-mode" | "never";
  readonly appliesIn: "always" | "env-mode";
  readonly defaultValue?: string | number | boolean;
  readonly defaultSource?: "process-cwd" | "bundled-ripgrep";
  readonly secret: boolean;
  readonly section: "model" | "workspace" | "tooling";
  readonly description: string;
};

function publicField<const T extends PublicConfigField>(field: T): Readonly<T> {
  return Object.freeze(field);
}

export const PUBLIC_CONFIG_FIELDS = Object.freeze([
  publicField({
    name: "TINKER_MODELS",
    valueKind: "non-empty-string",
    requiredIn: "never",
    appliesIn: "always",
    secret: false,
    section: "model",
    description:
      "Optional model profiles JSON path. Relative paths resolve from the process cwd.",
  }),
  publicField({
    name: "TINKER_MODEL",
    valueKind: "non-empty-string",
    requiredIn: "env-mode",
    appliesIn: "env-mode",
    secret: false,
    section: "model",
    description: "Model name used when model profiles are not configured.",
  }),
  publicField({
    name: "TINKER_BASE_URL",
    valueKind: "non-empty-string",
    requiredIn: "env-mode",
    appliesIn: "env-mode",
    secret: false,
    section: "model",
    description: "OpenAI-compatible Chat Completions API base URL.",
  }),
  publicField({
    name: "TINKER_API_KEY",
    valueKind: "non-empty-string",
    requiredIn: "env-mode",
    appliesIn: "env-mode",
    secret: true,
    section: "model",
    description: "API credential for the configured model endpoint.",
  }),
  publicField({
    name: "TINKER_CONTEXT_WINDOW_TOKENS",
    valueKind: "positive-integer",
    requiredIn: "env-mode",
    appliesIn: "env-mode",
    secret: false,
    section: "model",
    description: "Model context-window size in tokens.",
  }),
  publicField({
    name: "TINKER_MAX_SUPPORTED_OUTPUT_TOKENS",
    valueKind: "positive-integer",
    requiredIn: "env-mode",
    appliesIn: "env-mode",
    secret: false,
    section: "model",
    description: "Maximum output-token count supported by the model.",
  }),
  publicField({
    name: "TINKER_INCLUDE_REASONING_CONTENT",
    valueKind: "boolean",
    requiredIn: "never",
    appliesIn: "env-mode",
    defaultValue: false,
    secret: false,
    section: "model",
    description: "Include provider reasoning content in the model response mapping.",
  }),
  publicField({
    name: "TINKER_STREAM",
    valueKind: "boolean",
    requiredIn: "never",
    appliesIn: "env-mode",
    defaultValue: true,
    secret: false,
    section: "model",
    description: "Use streaming Chat Completions transport.",
  }),
  publicField({
    name: "TINKER_WEBFETCH_REFINE_MODEL",
    valueKind: "non-empty-string",
    requiredIn: "never",
    appliesIn: "env-mode",
    secret: false,
    section: "model",
    description: "Optional WebFetch refiner model; currently must match TINKER_MODEL.",
  }),
  publicField({
    name: "TINKER_WORKSPACE",
    valueKind: "non-empty-string",
    requiredIn: "never",
    appliesIn: "always",
    defaultSource: "process-cwd",
    secret: false,
    section: "workspace",
    description: "Workspace path. Relative paths resolve from the process cwd.",
  }),
  publicField({
    name: "TINKER_MAX_ITERATIONS",
    valueKind: "positive-integer",
    requiredIn: "never",
    appliesIn: "always",
    defaultValue: 512,
    secret: false,
    section: "workspace",
    description: "Maximum agent-loop iterations per turn.",
  }),
  publicField({
    name: "EXA_API_KEY",
    valueKind: "non-empty-string",
    requiredIn: "never",
    appliesIn: "always",
    secret: true,
    section: "tooling",
    description: "Enables WebSearch and the Exa WebFetch backend when set.",
  }),
  publicField({
    name: "TINKER_MCP_TIMEOUT_MS",
    valueKind: "positive-integer",
    requiredIn: "never",
    appliesIn: "always",
    defaultValue: 60_000,
    secret: false,
    section: "tooling",
    description: "MCP tool-call timeout in milliseconds.",
  }),
  publicField({
    name: "TINKER_MCP_MAX_OBSERVATION_CHARS",
    valueKind: "positive-integer",
    requiredIn: "never",
    appliesIn: "always",
    defaultValue: 40_000,
    secret: false,
    section: "tooling",
    description: "Maximum model-visible characters in one MCP result.",
  }),
  publicField({
    name: "TINKER_BASH_DEFAULT_TIMEOUT_MS",
    valueKind: "positive-integer",
    requiredIn: "never",
    appliesIn: "always",
    defaultValue: 5_000,
    secret: false,
    section: "tooling",
    description: "Default Bash foreground timeout in milliseconds.",
  }),
  publicField({
    name: "TINKER_BASH_MAX_TIMEOUT_MS",
    valueKind: "positive-integer",
    requiredIn: "never",
    appliesIn: "always",
    defaultValue: 600_000,
    secret: false,
    section: "tooling",
    description: "Maximum Bash foreground timeout in milliseconds.",
  }),
  publicField({
    name: "TINKER_GREP_TIMEOUT_MS",
    valueKind: "positive-integer",
    requiredIn: "never",
    appliesIn: "always",
    defaultValue: 20_000,
    secret: false,
    section: "tooling",
    description: "Bundled ripgrep invocation timeout in milliseconds.",
  }),
  publicField({
    name: "TINKER_GREP_MAX_BUFFER_BYTES",
    valueKind: "positive-integer",
    requiredIn: "never",
    appliesIn: "always",
    defaultValue: 20_000_000,
    secret: false,
    section: "tooling",
    description: "Maximum buffered output from one ripgrep invocation.",
  }),
  publicField({
    name: "TINKER_WEBFETCH_REFINE_THRESHOLD",
    valueKind: "positive-integer",
    requiredIn: "never",
    appliesIn: "always",
    defaultValue: 2_000,
    secret: false,
    section: "tooling",
    description: "Content-length threshold that enables WebFetch refinement.",
  }),
  publicField({
    name: "TINKER_RIPGREP_PATH",
    valueKind: "non-empty-string",
    requiredIn: "never",
    appliesIn: "always",
    defaultSource: "bundled-ripgrep",
    secret: false,
    section: "tooling",
    description: "Explicit diagnostic override for the bundled ripgrep executable.",
  }),
]);

export type ModelProfileField = {
  readonly name: string;
  readonly valueKind: PublicConfigValueKind | "input-modalities" | "token-estimator";
  readonly required: boolean;
  readonly defaultValue?: string | number | boolean | readonly string[];
  readonly secret: boolean;
  readonly description: string;
};

function profileField<const T extends ModelProfileField>(field: T): Readonly<T> {
  return Object.freeze(field);
}

export const MODEL_PROFILE_FIELDS = Object.freeze([
  profileField({
    name: "model",
    valueKind: "non-empty-string",
    required: true,
    secret: false,
    description: "Provider model name.",
  }),
  profileField({
    name: "apiBase",
    valueKind: "non-empty-string",
    required: true,
    secret: false,
    description: "OpenAI-compatible API base URL.",
  }),
  profileField({
    name: "apiKey",
    valueKind: "non-empty-string",
    required: true,
    secret: true,
    description: "API credential for this profile.",
  }),
  profileField({
    name: "contextWindowTokens",
    valueKind: "positive-integer",
    required: true,
    secret: false,
    description: "Model context-window size in tokens.",
  }),
  profileField({
    name: "maxSupportedOutputTokens",
    valueKind: "positive-integer",
    required: true,
    secret: false,
    description: "Maximum output-token count supported by the model.",
  }),
  profileField({
    name: "includeReasoningContent",
    valueKind: "boolean",
    required: false,
    defaultValue: false,
    secret: false,
    description: "Include provider reasoning content in response mapping.",
  }),
  profileField({
    name: "stream",
    valueKind: "boolean",
    required: false,
    defaultValue: true,
    secret: false,
    description: "Use streaming Chat Completions transport.",
  }),
  profileField({
    name: "inputModalities",
    valueKind: "input-modalities",
    required: false,
    defaultValue: Object.freeze(["text"] as const),
    secret: false,
    description: "Accepted model input modalities.",
  }),
  profileField({
    name: "tokenEstimator",
    valueKind: "token-estimator",
    required: false,
    secret: true,
    description: "Required independent token estimator for image profiles.",
  }),
]);

export type ModelTokenEstimatorField = {
  readonly name: string;
  readonly valueKind: PublicConfigValueKind | "literal-string" | "literal-number";
  readonly required: true;
  readonly secret: boolean;
  readonly literalValue?: string | number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description: string;
};

function estimatorField<const T extends ModelTokenEstimatorField>(
  field: T,
): Readonly<T> {
  return Object.freeze(field);
}

export const MODEL_TOKEN_ESTIMATOR_FIELDS = Object.freeze([
  estimatorField({
    name: "kind",
    valueKind: "literal-string",
    required: true,
    secret: false,
    literalValue: "moonshot-estimate-token-count-v1",
    description: "Estimator protocol discriminator.",
  }),
  estimatorField({
    name: "model",
    valueKind: "non-empty-string",
    required: true,
    secret: false,
    description: "Estimator model name.",
  }),
  estimatorField({
    name: "apiBase",
    valueKind: "non-empty-string",
    required: true,
    secret: false,
    description: "Estimator API base URL.",
  }),
  estimatorField({
    name: "apiKey",
    valueKind: "non-empty-string",
    required: true,
    secret: true,
    description: "Estimator API credential.",
  }),
  estimatorField({
    name: "timeoutMs",
    valueKind: "positive-integer",
    required: true,
    secret: false,
    minimum: 1_000,
    maximum: 60_000,
    description: "Estimator request timeout in milliseconds.",
  }),
  estimatorField({
    name: "maxRetries",
    valueKind: "literal-number",
    required: true,
    secret: false,
    literalValue: 0,
    description: "Estimator retry count; retries are disabled.",
  }),
]);

export type ModelTokenEstimatorKind = Extract<
  (typeof MODEL_TOKEN_ESTIMATOR_FIELDS)[number],
  { readonly name: "kind" }
>["literalValue"];

export type ModelTokenEstimatorMaxRetries = Extract<
  (typeof MODEL_TOKEN_ESTIMATOR_FIELDS)[number],
  { readonly name: "maxRetries" }
>["literalValue"];

export const MODEL_PROFILES_DOCUMENT_FIELDS = Object.freeze([
  Object.freeze({ name: "default", valueKind: "non-empty-string" as const }),
  Object.freeze({ name: "profiles", valueKind: "profiles-map" as const }),
]);

export type PublicToolingConfig = {
  readonly exaApiKey?: string;
  readonly mcpTimeoutMs: number;
  readonly mcpMaxObservationChars: number;
  readonly bashDefaultTimeoutMs: number;
  readonly bashMaxTimeoutMs: number;
  readonly grepTimeoutMs: number;
  readonly grepMaxBufferBytes: number;
  readonly webFetchRefineThreshold: number;
  readonly ripgrepPath: string;
};

type ParsedCommonEnvironment = {
  readonly workspaceRoot: string;
  readonly maxIterations: number;
  readonly tooling: PublicToolingConfig;
};

export type ParsedPublicEnvironment =
  | (ParsedCommonEnvironment & {
      readonly mode: "profile";
      readonly modelsPath: string;
    })
  | (ParsedCommonEnvironment & {
      readonly mode: "env";
      readonly modelName: string;
      readonly apiBase: string;
      readonly apiKey: string;
      readonly contextWindowTokens: number;
      readonly maxSupportedOutputTokens: number;
      readonly includeReasoningContent: boolean;
      readonly stream: boolean;
      readonly webFetchRefineModel?: string;
    });

type PublicConfigFieldName = (typeof PUBLIC_CONFIG_FIELDS)[number]["name"];
type ParsedPrimitive = string | number | boolean | undefined;

const PUBLIC_CONFIG_FIELD_MAP = new Map<string, PublicConfigField>(
  PUBLIC_CONFIG_FIELDS.map((field) => [field.name, field]),
);

export const DEFAULT_PUBLIC_TOOLING_CONFIG: PublicToolingConfig = Object.freeze({
  mcpTimeoutMs: defaultNumber("TINKER_MCP_TIMEOUT_MS"),
  mcpMaxObservationChars: defaultNumber("TINKER_MCP_MAX_OBSERVATION_CHARS"),
  bashDefaultTimeoutMs: defaultNumber("TINKER_BASH_DEFAULT_TIMEOUT_MS"),
  bashMaxTimeoutMs: defaultNumber("TINKER_BASH_MAX_TIMEOUT_MS"),
  grepTimeoutMs: defaultNumber("TINKER_GREP_TIMEOUT_MS"),
  grepMaxBufferBytes: defaultNumber("TINKER_GREP_MAX_BUFFER_BYTES"),
  webFetchRefineThreshold: defaultNumber("TINKER_WEBFETCH_REFINE_THRESHOLD"),
  ripgrepPath: rgPath,
});

export function parsePublicEnvironment(
  env: NodeJS.ProcessEnv,
  cwd: string,
): ParsedPublicEnvironment {
  const configuredModelsPath = optionalRawString(env.TINKER_MODELS);
  const mode = configuredModelsPath === undefined ? "env" : "profile";
  const values = {} as Record<PublicConfigFieldName, ParsedPrimitive>;

  for (const field of PUBLIC_CONFIG_FIELDS) {
    if (field.appliesIn === "env-mode" && mode !== "env") {
      values[field.name] = undefined;
      continue;
    }
    values[field.name] = parseEnvironmentField(field, env[field.name], mode, cwd);
  }

  const workspaceRoot = path.resolve(
    cwd,
    requiredStringValue(values, "TINKER_WORKSPACE"),
  );
  const maxIterations = requiredNumberValue(values, "TINKER_MAX_ITERATIONS");
  const exaApiKey = optionalStringValue(values, "EXA_API_KEY");
  const tooling = Object.freeze({
    ...(exaApiKey === undefined ? {} : { exaApiKey }),
    mcpTimeoutMs: requiredNumberValue(values, "TINKER_MCP_TIMEOUT_MS"),
    mcpMaxObservationChars: requiredNumberValue(
      values,
      "TINKER_MCP_MAX_OBSERVATION_CHARS",
    ),
    bashDefaultTimeoutMs: requiredNumberValue(values, "TINKER_BASH_DEFAULT_TIMEOUT_MS"),
    bashMaxTimeoutMs: requiredNumberValue(values, "TINKER_BASH_MAX_TIMEOUT_MS"),
    grepTimeoutMs: requiredNumberValue(values, "TINKER_GREP_TIMEOUT_MS"),
    grepMaxBufferBytes: requiredNumberValue(values, "TINKER_GREP_MAX_BUFFER_BYTES"),
    webFetchRefineThreshold: requiredNumberValue(
      values,
      "TINKER_WEBFETCH_REFINE_THRESHOLD",
    ),
    ripgrepPath: requiredStringValue(values, "TINKER_RIPGREP_PATH"),
  });

  if (tooling.bashDefaultTimeoutMs > tooling.bashMaxTimeoutMs) {
    throw new Error(
      `TINKER_BASH_DEFAULT_TIMEOUT_MS must not exceed TINKER_BASH_MAX_TIMEOUT_MS; received ${tooling.bashDefaultTimeoutMs} > ${tooling.bashMaxTimeoutMs}.`,
    );
  }

  const common = { workspaceRoot, maxIterations, tooling };
  if (mode === "profile") {
    if (configuredModelsPath === undefined) {
      throw new Error("Profile mode requires TINKER_MODELS.");
    }
    return Object.freeze({
      ...common,
      mode,
      modelsPath: path.isAbsolute(configuredModelsPath)
        ? configuredModelsPath
        : path.resolve(cwd, configuredModelsPath),
    });
  }

  const modelName = requiredStringValue(values, "TINKER_MODEL");
  const webFetchRefineModel = optionalStringValue(
    values,
    "TINKER_WEBFETCH_REFINE_MODEL",
  );
  if (webFetchRefineModel !== undefined && webFetchRefineModel !== modelName) {
    throw new Error(
      `TINKER_WEBFETCH_REFINE_MODEL must match TINKER_MODEL in F2; received ${JSON.stringify(webFetchRefineModel)} for main model ${JSON.stringify(modelName)}.`,
    );
  }

  return Object.freeze({
    ...common,
    mode,
    modelName,
    apiBase: requiredStringValue(values, "TINKER_BASE_URL"),
    apiKey: requiredStringValue(values, "TINKER_API_KEY"),
    contextWindowTokens: requiredNumberValue(values, "TINKER_CONTEXT_WINDOW_TOKENS"),
    maxSupportedOutputTokens: requiredNumberValue(
      values,
      "TINKER_MAX_SUPPORTED_OUTPUT_TOKENS",
    ),
    includeReasoningContent: requiredBooleanValue(
      values,
      "TINKER_INCLUDE_REASONING_CONTENT",
    ),
    stream: requiredBooleanValue(values, "TINKER_STREAM"),
    ...(webFetchRefineModel === undefined ? {} : { webFetchRefineModel }),
  });
}

function parseEnvironmentField(
  field: PublicConfigField,
  rawValue: string | undefined,
  mode: "env" | "profile",
  cwd: string,
): ParsedPrimitive {
  const normalized = rawValue?.trim();
  const missing = normalized === undefined || normalized === "";
  if (missing) {
    if (
      field.requiredIn === "always" ||
      (field.requiredIn === "env-mode" && mode === "env")
    ) {
      throw new Error(`${field.name} is required.`);
    }
    if (field.defaultValue !== undefined) {
      return field.defaultValue;
    }
    if (field.defaultSource === "process-cwd") {
      return cwd;
    }
    if (field.defaultSource === "bundled-ripgrep") {
      return rgPath;
    }
    return undefined;
  }

  if (field.valueKind === "non-empty-string") {
    return normalized;
  }
  if (field.valueKind === "positive-integer") {
    if (!/^\d+$/.test(normalized)) {
      throw positiveIntegerError(field.name, rawValue);
    }
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw positiveIntegerError(field.name, rawValue);
    }
    return parsed;
  }

  const booleanValue = parseBooleanValue(normalized);
  if (booleanValue === undefined) {
    throw new Error(
      `${field.name} must be one of true/false, 1/0, yes/no, or on/off; received ${rawValue}`,
    );
  }
  return booleanValue;
}

function defaultNumber(name: PublicConfigFieldName): number {
  const field = PUBLIC_CONFIG_FIELD_MAP.get(name);
  if (field === undefined || typeof field.defaultValue !== "number") {
    throw new Error(`Public config field ${name} does not declare a numeric default.`);
  }
  return field.defaultValue;
}

function optionalRawString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

function optionalStringValue(
  values: Record<PublicConfigFieldName, ParsedPrimitive>,
  name: PublicConfigFieldName,
): string | undefined {
  const value = values[name];
  if (value === undefined || typeof value === "string") {
    return value;
  }
  throw new Error(`Public config field ${name} did not resolve to a string.`);
}

function requiredStringValue(
  values: Record<PublicConfigFieldName, ParsedPrimitive>,
  name: PublicConfigFieldName,
): string {
  const value = optionalStringValue(values, name);
  if (value === undefined) {
    throw new Error(`Public config field ${name} did not resolve to a string.`);
  }
  return value;
}

function requiredNumberValue(
  values: Record<PublicConfigFieldName, ParsedPrimitive>,
  name: PublicConfigFieldName,
): number {
  const value = values[name];
  if (typeof value !== "number") {
    throw new Error(`Public config field ${name} did not resolve to a number.`);
  }
  return value;
}

function requiredBooleanValue(
  values: Record<PublicConfigFieldName, ParsedPrimitive>,
  name: PublicConfigFieldName,
): boolean {
  const value = values[name];
  if (typeof value !== "boolean") {
    throw new Error(`Public config field ${name} did not resolve to a boolean.`);
  }
  return value;
}

function parseBooleanValue(value: string): boolean | undefined {
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function positiveIntegerError(name: string, value: string | undefined): Error {
  return new Error(
    `${name} must be a positive safe integer; received ${value ?? "undefined"}`,
  );
}
