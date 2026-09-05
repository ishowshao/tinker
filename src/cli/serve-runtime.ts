import { createRuntimeSession } from "../agent/runtime-session";
import { parseSessionId } from "../ids/runtime-id";
import {
  buildSystemPrompt,
  loadProjectInstructions,
  projectInstructionManifest,
} from "../instructions/project-instructions";
import { createReasoningEffortController } from "../model/reasoning-effort";
import { resolveSessionDatabasePath } from "../session/session-store";
import { SessionCatalog } from "../session/session-catalog";
import { loadSkillCatalog } from "../skills/skill-loader";
import type { RemoteWorkspaceConfig } from "../remote/config";
import type { HostedRuntimeFactory } from "../agent/runtime-hosted-session";
import { deriveRunnerConfig, resolvePublicConfig } from "./config";
import { resolveSessionProfileName } from "./model-profiles";
import {
  createRunnerModelClient,
  createWebFetchRefiner,
  RUNTIME_INSTRUCTIONS,
} from "./runner-dependencies";

/** Service composition reuses the existing configuration/provider/runtime contracts. */
export function createHostedRuntimeFactory(
  workspaces: readonly RemoteWorkspaceConfig[],
  env: NodeJS.ProcessEnv,
  homeRoot?: string,
): HostedRuntimeFactory {
  return async ({ record, sink }) => {
    const workspace = workspaces.find((entry) => entry.id === record.workspaceId);
    if (!workspace || workspace.path !== record.workspacePath)
      throw new Error("Managed workspace configuration changed.");
    const sessionId = parseSessionId(record.id);
    const publicConfig = await resolvePublicConfig({
      env: { ...env, TINKER_WORKSPACE: workspace.path },
      cwd: workspace.path,
    });
    let profileName = workspace.profile;
    if (record.initialized && publicConfig.mode === "profile") {
      const summary = await new SessionCatalog({
        workspaceRoot: workspace.path,
        homeRoot,
      }).get(sessionId);
      profileName = resolveSessionProfileName(publicConfig.profiles, summary);
    }
    const config = deriveRunnerConfig(publicConfig, {
      sessionId,
      ...(profileName ? { profileName } : {}),
    });
    const reasoning = createReasoningEffortController(config.reasoning);
    const projectInstructions = await loadProjectInstructions(workspace.path);
    const runtime = await createRuntimeSession({
      workspaceRoot: workspace.path,
      ...(homeRoot === undefined ? {} : { homeRoot }),
      ...(record.initialized
        ? { selection: { mode: "resume" as const, sessionId } }
        : { selection: { mode: "new" as const, sessionId } }),
      modelName: config.modelName,
      profileName: config.profileName,
      maxIterations: config.maxIterations,
      includeReasoningContent: config.includeReasoningContent,
      contextProfile: config.contextProfile,
      contextBudget: config.contextBudget,
      modelClient: createRunnerModelClient(config, undefined, env, reasoning),
      systemPrompt: buildSystemPrompt({
        workspaceRoot: workspace.path,
        runtimeInstructions: RUNTIME_INSTRUCTIONS(workspace.path),
        projectInstructions,
      }),
      projectInstruction: projectInstructionManifest(projectInstructions),
      skillCatalog: await loadSkillCatalog({ workspaceRoot: workspace.path }),
      presentationSinks: [sink],
      assistantTextDeltaSink: sink,
      toolingConfig: publicConfig.tooling,
      webFetchRefiner: createWebFetchRefiner(config, env, reasoning),
      enableAskUser: true,
      bashGuard: {
        mode: config.bashGuardMode,
        source: config.bashGuardSource,
        surface: "tui",
      },
    });
    try {
      return {
        runtime,
        databasePath: await resolveSessionDatabasePath(
          workspace.path,
          sessionId,
          homeRoot,
        ),
        modelName: config.modelName,
      };
    } catch (error) {
      await runtime.dispose({
        type: "initialization_failed",
        error: "Cannot open remote history reader.",
      });
      throw error;
    }
  };
}
