import {
  createRuntimeSession,
  type CreateRuntimeSessionInput,
} from "../agent/runtime-session";
import type { AssistantTextDeltaSink } from "../agent/assistant-text-delta";
import type { EventSink } from "../events/event-sink";
import {
  buildSystemPrompt,
  loadProjectInstructions,
  projectInstructionManifest,
} from "../instructions/project-instructions";
import { createReasoningEffortController } from "../model/reasoning-effort";
import { loadSkillCatalog } from "../skills/skill-loader";
import type { RunnerConfig } from "./config";
import type { PublicToolingConfig } from "./public-config-contract";
import {
  createRunnerModelClient,
  createWebFetchRefiner,
  RUNTIME_INSTRUCTIONS,
} from "./runner-dependencies";

type InteractiveRuntimeInput = {
  sessionLease?: CreateRuntimeSessionInput["sessionLease"];
  config: RunnerConfig;
  workspaceRoot: string;
  homeRoot?: string;
  selection: CreateRuntimeSessionInput["selection"];
  toolingConfig: PublicToolingConfig;
  env: NodeJS.ProcessEnv;
  sink: EventSink & AssistantTextDeltaSink;
  owner: "local-tui" | "service";
};

// Both interactive owners expose the same runtime interaction and undo capabilities.
const CAPABILITIES = {
  "local-tui": { enableTurnUndo: true, enableProviderRetryPrompt: true },
  service: { enableTurnUndo: true, enableProviderRetryPrompt: true },
} as const;

/** Composition only: callers retain config selection and runtime ownership. */
export async function buildInteractiveRuntimeInput(
  input: InteractiveRuntimeInput,
): Promise<CreateRuntimeSessionInput> {
  const { config, workspaceRoot, env, sink } = input;
  const reasoning = createReasoningEffortController(config.reasoning);
  const modelClient = createRunnerModelClient(config, undefined, env, reasoning);
  const projectInstructions = await loadProjectInstructions(workspaceRoot);
  const skillCatalog = await loadSkillCatalog({ workspaceRoot });
  return {
    sessionLease: input.sessionLease,
    workspaceRoot,
    ...(input.homeRoot === undefined ? {} : { homeRoot: input.homeRoot }),
    ...(input.selection.mode === "new"
      ? { selection: input.selection }
      : { selection: input.selection }),
    modelName: config.modelName,
    profileName: config.profileName,
    maxIterations: config.maxIterations,
    includeReasoningContent: config.includeReasoningContent,
    contextProfile: config.contextProfile,
    contextBudget: config.contextBudget,
    modelClient,
    systemPrompt: buildSystemPrompt({
      workspaceRoot,
      runtimeInstructions: RUNTIME_INSTRUCTIONS(workspaceRoot),
      projectInstructions,
    }),
    projectInstruction: projectInstructionManifest(projectInstructions),
    skillCatalog,
    presentationSinks: [sink],
    assistantTextDeltaSink: sink,
    toolingConfig: input.toolingConfig,
    webFetchRefiner: createWebFetchRefiner(config, env, reasoning),
    ...CAPABILITIES[input.owner],
    enableAskUser: true,
    // "tui" currently denotes an interactive guard, including hosted sessions.
    bashGuard: {
      mode: config.bashGuardMode,
      source: config.bashGuardSource,
      surface: "tui",
    },
  };
}

export async function createInteractiveRuntimeSession(input: InteractiveRuntimeInput) {
  return createRuntimeSession(await buildInteractiveRuntimeInput(input));
}
