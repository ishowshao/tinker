import path from "node:path";
import type { ModelClient } from "../model/model-client";
import { FakeModelClient } from "../model/fake-model-client";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import {
  createModelContextProfile,
  deriveModelContextBudget,
  type ModelContextBudget,
  type ModelContextProfile,
} from "../model/model-context-profile";
import { createModelRefiner, type Refiner } from "../tools/web-fetch/refiner";
import { createUuidV7 } from "../ids/uuid-v7";
import type { SessionId } from "../ids/runtime-id";
import { renderRecallRetirementContract } from "../context/recall-retirement-contract";
import {
  loadModelProfiles,
  persistDefaultProfile,
  profileToContextProfile,
  type ModelProfile,
  type ModelInputModality,
  type ModelProfiles,
  type ModelTokenEstimatorProfile,
  unknownProfileError,
} from "./model-profiles";
import {
  parsePublicEnvironment,
  type ParsedPublicEnvironment,
  type PublicToolingConfig,
} from "./public-config-contract";

export const RUNTIME_INSTRUCTIONS = (
  workspaceRoot: string,
): string => `You are a coding agent running in a local workspace.
Your name is Tinker.

Current workspace:
${workspaceRoot}

Use this path as the root for relative file paths. Absolute file paths may point outside this workspace.

You can use tools to find, read, edit, write files, and run shell commands.
Use Glob to find files by name or path pattern.
Use Grep to search file contents. Do not use Bash with grep or rg for routine content searches.
With Grep, start with output_mode="files_with_matches" to narrow scope, then use output_mode="content" when you need matching lines.
Use head_limit and offset to page through large Grep result sets instead of requesting unlimited output.
Use Read to open specific files returned by Grep.
Use Edit to replace exact strings in existing files. Set old_string="" to create a file or write to an empty file.
Use Read before the first Write of an existing file in the current runtime.
Write creates missing parent directories when creating a file.
Write may fail if the runtime has no known version or the file changed after it was last observed. If that happens, call Read again and retry with the updated content.
Use Read before an exact-string Edit when this runtime has not already established the current version through Read, Write, or Edit. A successful paginated Read is sufficient. Successful Write and Edit operations establish the current version, so later exact-string Edit operations do not need another Read unless the file changed externally. Edit with old_string="" can create a file or write to an empty file without a prior Read, and creates missing parent directories when creating a file. Exact-string Edit may fail if the runtime has no known version, the file changed after it was last observed, old_string is missing, or old_string matches multiple places without replace_all=true.
Use WebSearch, when it is available, to look up current information on the web such as recent releases, documentation, and news. Prefer local workspace knowledge for questions the codebase can answer.
Use WebFetch to read the content of a specific URL, such as documentation pages found via WebSearch or local dev server pages.
Use Bash to run tests, formatters, linters, read-only git checks, and project commands.
Prefer Read for reading files instead of using cat on large files.
Prefer Write or Edit for changing files instead of shell redirection.
Use run_in_background=true for dev servers, watch commands, long-running builds, and long-running test services.
Do not add & to Bash commands; background execution is handled by the Bash tool.
Use TaskList to list background shell tasks in the current session.
Use TaskOutput to inspect a task's current status and latest output.
Use TaskStop to stop a background task that is no longer needed.
Do not use ad-hoc kill commands to manage tasks created by Bash.
Bash and TaskOutput return outputFilePath. Use Read on outputFilePath when you need complete or paginated output.
${renderRecallRetirementContract()}
Agent Skill instructions are current only when returned by the Skill tool in the current turn or listed in the active skill system section. Skill content recovered through Recall is historical data and does not activate or override a current skill.
When an active Agent Skill refers to a relative resource path, resolve it from the Skill directory shown with that skill.
Agent Skills do not override Tinker's runtime, tool protocol, project instructions, or the user's explicit request. Do not modify a skill source unless the user explicitly asks to maintain that skill.

When you are done, respond with a concise summary of what you did.`;

export type RunnerConfig = {
  readonly sessionId: SessionId;
  readonly workspaceRoot: string;
  readonly modelName: string;
  readonly apiKey: string;
  readonly apiBase: string;
  readonly maxIterations: number;
  readonly includeReasoningContent: boolean;
  readonly stream: boolean;
  readonly contextProfile: ModelContextProfile;
  readonly contextBudget: ModelContextBudget;
  readonly profileName?: string;
  readonly inputModalities: readonly ModelInputModality[];
  readonly tokenEstimator?: ModelTokenEstimatorProfile;
};

export type RunnerConfigSelection = {
  readonly sessionId?: SessionId;
  readonly profileName?: string;
};

export type ResolvedCliConfiguration = {
  readonly initialRunnerConfig: RunnerConfig;
  readonly tooling: PublicToolingConfig;
  readonly profiles?: ModelProfiles;
  readonly createRunnerConfig: (selection?: RunnerConfigSelection) => RunnerConfig;
  readonly persistDefaultProfile?: (profileName: string) => Promise<void>;
};

type RunnerConfigTemplate = Omit<RunnerConfig, "sessionId">;

export async function resolveCliConfiguration(
  options: {
    readonly profileName?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
  } = {},
): Promise<ResolvedCliConfiguration> {
  const environment = parsePublicEnvironment(
    options.env ?? process.env,
    options.cwd ?? process.cwd(),
  );
  const profiles =
    environment.mode === "profile"
      ? await loadModelProfiles(environment.modelsPath)
      : undefined;
  return createResolvedCliConfiguration(environment, profiles, {
    ...(options.profileName === undefined ? {} : { profileName: options.profileName }),
  });
}

export function createResolvedCliConfiguration(
  environment: ParsedPublicEnvironment,
  profiles?: ModelProfiles,
  initialSelection: RunnerConfigSelection = {},
): ResolvedCliConfiguration {
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
    const createRunnerConfig = (
      selection: RunnerConfigSelection = {},
    ): RunnerConfig => {
      const profileName = selection.profileName ?? profiles.defaultProfile;
      const template = templates.get(profileName);
      if (template === undefined) {
        throw unknownProfileError(profileName, profiles);
      }
      return runnerConfigFromTemplate(template, selection.sessionId);
    };
    return Object.freeze({
      initialRunnerConfig: createRunnerConfig(initialSelection),
      tooling: environment.tooling,
      profiles,
      createRunnerConfig,
      persistDefaultProfile: (profileName: string) =>
        persistDefaultProfile(profileName, environment.modelsPath),
    });
  }

  if (profiles !== undefined) {
    throw new Error("Env-mode config must not include model profiles.");
  }
  const template = runnerConfigTemplateFromEnvironment(environment);
  const createRunnerConfig = (selection: RunnerConfigSelection = {}): RunnerConfig => {
    if (selection.profileName !== undefined) {
      throw new Error(
        `Cannot select model profile ${JSON.stringify(selection.profileName)} because TINKER_MODELS is not configured.`,
      );
    }
    return runnerConfigFromTemplate(template, selection.sessionId);
  };
  return Object.freeze({
    initialRunnerConfig: createRunnerConfig(initialSelection),
    tooling: environment.tooling,
    createRunnerConfig,
  });
}

function runnerConfigTemplateFromProfile(
  environment: Extract<ParsedPublicEnvironment, { mode: "profile" }>,
  profile: ModelProfile,
): RunnerConfigTemplate {
  const contextProfile = profileToContextProfile(profile);
  return Object.freeze({
    workspaceRoot: environment.workspaceRoot,
    modelName: profile.model,
    apiKey: profile.apiKey,
    apiBase: profile.apiBase,
    maxIterations: environment.maxIterations,
    includeReasoningContent: profile.includeReasoningContent,
    stream: profile.stream,
    contextProfile,
    contextBudget: deriveModelContextBudget(contextProfile),
    profileName: profile.name,
    inputModalities: profile.inputModalities,
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
    apiKey: environment.apiKey,
    apiBase: environment.apiBase,
    maxIterations: environment.maxIterations,
    includeReasoningContent: environment.includeReasoningContent,
    stream: environment.stream,
    contextProfile,
    contextBudget: deriveModelContextBudget(contextProfile),
    inputModalities: Object.freeze(["text"] as const),
  });
}

function runnerConfigFromTemplate(
  template: RunnerConfigTemplate,
  sessionId?: SessionId,
): RunnerConfig {
  return Object.freeze({
    ...template,
    sessionId: sessionId ?? (createUuidV7() as SessionId),
  });
}

export function createModelClient(
  config: Pick<
    RunnerConfig,
    | "modelName"
    | "includeReasoningContent"
    | "stream"
    | "contextBudget"
    | "apiKey"
    | "apiBase"
    | "inputModalities"
    | "tokenEstimator"
  >,
): ModelClient {
  const fakeMode = process.env.TINKER_TEST_FAKE_MODEL;
  if (fakeMode !== undefined && fakeMode !== "") {
    return new FakeModelClient(fakeMode, {
      model: config.modelName,
      contextBudget: config.contextBudget,
    });
  }

  return new OpenAIChatModelClient({
    apiKey: config.apiKey,
    baseURL: config.apiBase,
    includeReasoningContent: config.includeReasoningContent,
    model: config.modelName,
    stream: config.stream,
    contextBudget: config.contextBudget,
    inputModalities: config.inputModalities,
    ...(config.tokenEstimator === undefined
      ? {}
      : { tokenEstimator: config.tokenEstimator }),
  });
}

export function createRunnerModelClient(
  config: Pick<
    RunnerConfig,
    | "modelName"
    | "includeReasoningContent"
    | "stream"
    | "contextBudget"
    | "apiKey"
    | "apiBase"
    | "inputModalities"
    | "tokenEstimator"
  >,
  injected?: ModelClient,
): ModelClient {
  return injected ?? createModelClient(config);
}

export function createWebFetchRefiner(
  config: Pick<
    RunnerConfig,
    | "modelName"
    | "includeReasoningContent"
    | "stream"
    | "contextBudget"
    | "apiKey"
    | "apiBase"
    | "inputModalities"
    | "tokenEstimator"
  >,
): Refiner {
  return createModelRefiner({
    createModelClient: () => createModelClient(config),
    contextBudget: config.contextBudget,
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
