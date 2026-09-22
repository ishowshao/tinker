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
    const runtime = await createInteractiveRuntimeSession({
      config,
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
