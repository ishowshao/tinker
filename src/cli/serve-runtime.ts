import { parseSessionId } from "../ids/runtime-id";
import { resolveSessionDatabasePath } from "../session/session-store";
import { SessionCatalog } from "../session/session-catalog";
import type { RemoteWorkspaceConfig } from "../remote/config";
import type { HostedRuntimeFactory } from "../agent/runtime-hosted-session";
import { deriveRunnerConfig, resolvePublicConfig } from "./config";
import { resolveSessionProfileName } from "./model-profiles";
import { createInteractiveRuntimeSession } from "./interactive-runtime";

/** Service composition reuses the existing configuration/provider/runtime contracts. */
export function createHostedRuntimeFactory(
  workspaces:
    | readonly RemoteWorkspaceConfig[]
    | (() => readonly RemoteWorkspaceConfig[]),
  env: NodeJS.ProcessEnv,
  homeRoot?: string,
): HostedRuntimeFactory {
  const entries = () => (typeof workspaces === "function" ? workspaces() : workspaces);
  const factory: HostedRuntimeFactory = async ({ record, sink, lease }) => {
    const workspace = entries().find((entry) => entry.id === record.workspaceId);
    if (!workspace || workspace.path !== record.workspacePath)
      throw new Error("Managed workspace configuration changed.");
    const sessionId = parseSessionId(record.id);
    const publicConfig = await resolvePublicConfig({
      env: { ...env, TINKER_WORKSPACE: workspace.path },
      cwd: workspace.path,
    });
    let profileName = record.profileName ?? workspace.profile;
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
    const runtime = await createInteractiveRuntimeSession({
      config,
      sessionLease: lease,
      workspaceRoot: workspace.path,
      ...(homeRoot === undefined ? {} : { homeRoot }),
      selection: { mode: record.initialized ? "resume" : "new", sessionId },
      toolingConfig: publicConfig.tooling,
      env,
      sink,
      owner: "service",
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
        profileName: config.profileName,
        modelCatalog: await factory.profiles!(workspace.id),
      };
    } catch (error) {
      await runtime.dispose({
        type: "initialization_failed",
        error: "Cannot open remote history reader.",
      });
      throw error;
    }
  };
  const readConfig = async (workspaceId: string) => {
    const workspace = entries().find((entry) => entry.id === workspaceId);
    if (!workspace) throw new Error("Workspace is not configured.");
    return resolvePublicConfig({
      env: { ...env, TINKER_WORKSPACE: workspace.path },
      cwd: workspace.path,
    });
  };
  factory.profiles = async (workspaceId) => {
    const config = await readConfig(workspaceId);
    if (config.mode !== "profile") return undefined;
    return {
      defaultProfile: config.profiles.defaultProfile,
      profiles: [...config.profiles.profiles.values()].map(
        ({ name, model, contextWindowTokens, maxSupportedOutputTokens }) => ({
          name,
          model,
          contextWindowTokens,
          maxSupportedOutputTokens,
        }),
      ),
    };
  };
  factory.persistDefaultProfile = async (workspaceId, profileName) => {
    const config = await readConfig(workspaceId);
    if (config.mode !== "profile")
      throw new Error("Model profiles are not configured.");
    await config.persistDefaultProfile(profileName);
  };
  return factory;
}
