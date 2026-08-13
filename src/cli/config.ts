import path from "node:path";
import type { SessionId } from "../ids/runtime-id";
import {
  createModelContextProfile,
  deriveModelContextBudget,
  type ModelContextBudget,
  type ModelContextProfile,
} from "../model/model-context-profile";
import type { ModelApi } from "../model/model-api";
import {
  loadModelProfiles,
  persistDefaultProfile,
  profileToContextProfile,
  type ModelInputModality,
  type ModelProfile,
  type ModelProfiles,
  type ModelTokenEstimatorProfile,
  unknownProfileError,
} from "./model-profiles";
import type { MemoryEmbeddingConfig } from "../memory/contracts";
import type { ReasoningEffortConfig } from "../model/reasoning-effort";
import {
  parsePublicEnvironment,
  type ParsedPublicEnvironment,
  type PublicToolingConfig,
} from "./public-config-contract";

export type RunnerConfig = {
  readonly sessionId: SessionId;
  readonly workspaceRoot: string;
  readonly modelName: string;
  readonly api: ModelApi;
  readonly apiKey: string;
  readonly apiBase: string;
  readonly maxIterations: number;
  readonly reasoning?: ReasoningEffortConfig;
  readonly includeReasoningContent: boolean;
  readonly stream: boolean;
  readonly contextProfile: ModelContextProfile;
  readonly contextBudget: ModelContextBudget;
  readonly profileName?: string;
  readonly inputModalities: readonly ModelInputModality[];
  readonly tokenEstimator?: ModelTokenEstimatorProfile;
  readonly bashGuardMode: "guard" | "yolo";
  readonly bashGuardSource: "default" | "environment" | "cli";
};

export type RunnerConfigSelection = {
  readonly sessionId: SessionId;
  readonly profileName?: string;
  readonly yolo?: boolean;
};

type RunnerConfigTemplate = Omit<RunnerConfig, "sessionId">;

export type ResolvedMemoryConfig = {
  readonly profile: ModelProfile;
  readonly contextBudget: ModelContextBudget;
  readonly embedding: MemoryEmbeddingConfig;
};

export type ResolvedPublicConfig =
  | {
      readonly mode: "env";
      readonly tooling: PublicToolingConfig;
      readonly template: RunnerConfigTemplate;
    }
  | {
      readonly mode: "profile";
      readonly tooling: PublicToolingConfig;
      readonly profiles: ModelProfiles;
      readonly templates: ReadonlyMap<string, RunnerConfigTemplate>;
      readonly memory?: ResolvedMemoryConfig;
      readonly persistDefaultProfile: (profileName: string) => Promise<void>;
    };

export async function resolvePublicConfig(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}): Promise<ResolvedPublicConfig> {
  const environment = parsePublicEnvironment(input.env, input.cwd);
  const profiles =
    environment.mode === "profile"
      ? await loadModelProfiles(environment.modelsPath)
      : undefined;
  return createResolvedPublicConfig(environment, profiles);
}

export function createResolvedPublicConfig(
  environment: ParsedPublicEnvironment,
  profiles?: ModelProfiles,
): ResolvedPublicConfig {
  if (environment.mode === "profile") {
    if (profiles === undefined) {
      throw new Error("Resolved profile-mode config requires loaded model profiles.");
    }
    const templates = new Map(
      [...profiles.profiles].map(([name, profile]) => [
        name,
        runnerConfigTemplateFromProfile(environment, profile),
      ]),
    );
    const memory =
      profiles.memory === undefined
        ? undefined
        : resolveMemoryConfig(profiles, profiles.memory.profile);
    return Object.freeze({
      mode: "profile",
      tooling: environment.tooling,
      profiles,
      templates,
      ...(memory === undefined ? {} : { memory }),
      persistDefaultProfile: (profileName: string) =>
        persistDefaultProfile(profileName, environment.modelsPath),
    });
  }

  if (profiles !== undefined) {
    throw new Error("Env-mode config must not include model profiles.");
  }
  return Object.freeze({
    mode: "env",
    tooling: environment.tooling,
    template: runnerConfigTemplateFromEnvironment(environment),
  });
}

function resolveMemoryConfig(
  profiles: ModelProfiles,
  profileName: string,
): ResolvedMemoryConfig {
  const profile = profiles.profiles.get(profileName);
  if (profile === undefined || profiles.memory === undefined) {
    throw unknownProfileError(profileName, profiles);
  }
  const contextProfile = profileToContextProfile(profile);
  return Object.freeze({
    profile,
    contextBudget: deriveModelContextBudget(contextProfile),
    embedding: profiles.memory.embedding,
  });
}

export function deriveRunnerConfig(
  snapshot: ResolvedPublicConfig,
  selection: RunnerConfigSelection,
): RunnerConfig {
  if (snapshot.mode === "profile") {
    const profileName = selection.profileName ?? snapshot.profiles.defaultProfile;
    const template = snapshot.templates.get(profileName);
    if (template === undefined) {
      throw unknownProfileError(profileName, snapshot.profiles);
    }
    return runnerConfigFromTemplate(template, selection);
  }

  if (selection.profileName !== undefined) {
    throw new Error(
      `Cannot select model profile ${JSON.stringify(selection.profileName)} because TINKER_MODELS is not configured.`,
    );
  }
  return runnerConfigFromTemplate(snapshot.template, selection);
}

function runnerConfigTemplateFromProfile(
  environment: Extract<ParsedPublicEnvironment, { mode: "profile" }>,
  profile: ModelProfile,
): RunnerConfigTemplate {
  const contextProfile = profileToContextProfile(profile);
  return Object.freeze({
    workspaceRoot: environment.workspaceRoot,
    modelName: profile.model,
    api: profile.api,
    apiKey: profile.apiKey,
    apiBase: profile.apiBase,
    maxIterations: environment.maxIterations,
    ...(profile.reasoning === undefined ? {} : { reasoning: profile.reasoning }),
    includeReasoningContent:
      profile.api === "chat-completions" && profile.includeReasoningContent,
    stream: profile.stream,
    contextProfile,
    contextBudget: deriveModelContextBudget(contextProfile),
    profileName: profile.name,
    inputModalities: profile.inputModalities,
    bashGuardMode: environment.bashGuardMode,
    bashGuardSource: environment.bashGuardSource,
    ...(profile.tokenEstimator === undefined
      ? {}
      : { tokenEstimator: profile.tokenEstimator }),
  });
}

function runnerConfigTemplateFromEnvironment(
  environment: Extract<ParsedPublicEnvironment, { mode: "env" }>,
): RunnerConfigTemplate {
  const contextProfile = createModelContextProfile({
    contextWindowTokens: environment.contextWindowTokens,
    maxSupportedOutputTokens: environment.maxSupportedOutputTokens,
  });
  return Object.freeze({
    workspaceRoot: environment.workspaceRoot,
    modelName: environment.modelName,
    api: environment.api,
    apiKey: environment.apiKey,
    apiBase: environment.apiBase,
    maxIterations: environment.maxIterations,
    includeReasoningContent:
      environment.api === "chat-completions" && environment.includeReasoningContent,
    stream: environment.stream,
    contextProfile,
    contextBudget: deriveModelContextBudget(contextProfile),
    inputModalities: Object.freeze(["text"] as const),
    bashGuardMode: environment.bashGuardMode,
    bashGuardSource: environment.bashGuardSource,
  });
}

function runnerConfigFromTemplate(
  template: RunnerConfigTemplate,
  selection: RunnerConfigSelection,
): RunnerConfig {
  return Object.freeze({
    ...template,
    sessionId: selection.sessionId,
    ...(selection.yolo === true
      ? { bashGuardMode: "yolo" as const, bashGuardSource: "cli" as const }
      : {}),
  });
}

export function eventLogPath(workspaceRoot: string, sessionId: SessionId): string {
  return path.join(workspaceRoot, ".tinker", "sessions", sessionId, "events.jsonl");
}

export function observationLogPath(
  workspaceRoot: string,
  sessionId: SessionId,
): string {
  return path.join(workspaceRoot, ".tinker", "sessions", sessionId, "observations.md");
}

export function promptHistoryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tinker", "prompt-history.jsonl");
}
