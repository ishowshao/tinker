import type { RuntimeSession } from "../agent/runtime-session";
import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import type {
  AssistantTextDeltaSink,
  AssistantTextDeltaUpdate,
} from "../agent/assistant-text-delta";
import { createUuidV7 } from "../ids/uuid-v7";
import type { SessionId } from "../ids/runtime-id";
import { ResumeProjectionReader } from "../session/resume-projection";
import { SessionCatalog } from "../session/session-catalog";
import type { TuiSessionView } from "../tui/tui-session-controller";
import { TuiProjectionStore } from "../tui/tui-projection-store";
import {
  LocalWorkspaceClient,
  createLocalSessionBinding,
  type OwnedSessionBinding,
} from "../client/local-workspace-client";
import type { SessionClient, ClientConnection } from "../client/session-client";
import {
  deriveRunnerConfig,
  type ResolvedPublicConfig,
  type RunnerConfig,
} from "./config";
import { createInteractiveRuntimeSession } from "./interactive-runtime";
import { resolveSessionProfileName } from "./model-profiles";
import type { ClientModelProfile } from "../client/model-catalog";

export async function createLocalTuiClient(options: {
  publicConfig: ResolvedPublicConfig;
  initialRunnerConfig: RunnerConfig;
  env: NodeJS.ProcessEnv;
  workspaceRoot: string;
}): Promise<ClientConnection<TuiSessionView>> {
  const { workspaceRoot } = options;
  const config = options.initialRunnerConfig;
  const profiles =
    options.publicConfig.mode === "profile" ? options.publicConfig.profiles : undefined;
  const createSessionForConfig = async (
    sessionConfig: RunnerConfig,
    mode: "new" | "resume",
    sessionId: SessionId,
    sink: EventSink & AssistantTextDeltaSink,
  ): Promise<RuntimeSession> =>
    createInteractiveRuntimeSession({
      config: sessionConfig,
      workspaceRoot,
      selection: { mode, sessionId },
      toolingConfig: options.publicConfig.tooling,
      env: options.env,
      sink,
      owner: "local-tui",
    });

  const projectionStore = new TuiProjectionStore({
    sessionId: config.sessionId,
    modelName: config.modelName,
    workspaceRoot,
  });
  const initialSession = await createSessionForConfig(
    config,
    "new",
    config.sessionId,
    projectionStore,
  );
  try {
    const catalog = new SessionCatalog({ workspaceRoot });

    const openStoredSession = async (
      sessionId: SessionId,
    ): Promise<OwnedSessionBinding<TuiProjectionStore>> => {
      const deferred = new DeferredProjectionSink();
      const summary = await catalog.get(sessionId);
      const resumeConfig = deriveRunnerConfig(options.publicConfig, {
        sessionId,
        ...(profiles === undefined
          ? {}
          : { profileName: resolveSessionProfileName(profiles, summary) }),
      });
      const runtimeSession = await createSessionForConfig(
        resumeConfig,
        "resume",
        sessionId,
        deferred,
      );
      const targetProjection = new TuiProjectionStore({
        sessionId,
        modelName: resumeConfig.modelName,
        workspaceRoot,
      });
      try {
        targetProjection.hydrate(
          await ResumeProjectionReader.read({
            workspaceRoot,
            sessionId,
            modelName: resumeConfig.modelName,
          }),
        );
        await deferred.attach(targetProjection);
      } catch (error) {
        await runtimeSession
          .dispose({ type: "runner_failed", error: errorMessage(error) })
          .catch(() => undefined);
        throw error;
      }
      return createLocalSessionBinding({
        runtimeSession,
        modelName: resumeConfig.modelName,
        workspaceRoot,
        profileName: resumeConfig.profileName,
        projectionStore: targetProjection,
      });
    };

    const createNewSessionBinding = async (
      sessionConfig: RunnerConfig,
    ): Promise<OwnedSessionBinding<TuiProjectionStore>> => {
      const freshProjectionStore = new TuiProjectionStore({
        sessionId: sessionConfig.sessionId,
        modelName: sessionConfig.modelName,
        workspaceRoot,
      });
      const runtimeSession = await createSessionForConfig(
        sessionConfig,
        "new",
        sessionConfig.sessionId,
        freshProjectionStore,
      );
      return createLocalSessionBinding({
        runtimeSession,
        modelName: sessionConfig.modelName,
        workspaceRoot,
        profileName: sessionConfig.profileName,
        projectionStore: freshProjectionStore,
      });
    };

    const createSessionWithProfile = async (
      profile: ClientModelProfile,
    ): Promise<OwnedSessionBinding<TuiProjectionStore>> => {
      if (profiles === undefined) {
        throw new Error("Model profiles are not configured.");
      }
      return createNewSessionBinding(
        deriveRunnerConfig(options.publicConfig, {
          sessionId: createUuidV7() as SessionId,
          profileName: profile.name,
        }),
      );
    };

    const createFreshSession = async (
      current: SessionClient<TuiProjectionStore>,
    ): Promise<OwnedSessionBinding<TuiProjectionStore>> => {
      const sessionId = createUuidV7() as SessionId;
      if (profiles === undefined) {
        return createNewSessionBinding(
          deriveRunnerConfig(options.publicConfig, { sessionId }),
        );
      }
      if (current.profileName === undefined) {
        throw new Error("Current session does not have a model profile.");
      }
      return createNewSessionBinding(
        deriveRunnerConfig(options.publicConfig, {
          sessionId,
          profileName: current.profileName,
        }),
      );
    };

    const client = new LocalWorkspaceClient(
      createLocalSessionBinding({
        runtimeSession: initialSession,
        modelName: config.modelName,
        workspaceRoot,
        profileName: config.profileName,
        projectionStore,
      }),
      catalog,
      openStoredSession,
      createSessionWithProfile,
      createFreshSession,
    );
    return {
      client,
      // Transitional local ownership retains today's exit cleanup policy.
      close: (reason) =>
        client.dispose(
          reason.type === "client_exit"
            ? { type: "tui_exit" }
            : { type: "runner_failed", error: reason.error },
        ),
    };
  } catch (error) {
    await initialSession
      .dispose({ type: "initialization_failed", error: errorMessage(error) })
      .catch(() => undefined);
    throw error;
  }
}

class DeferredProjectionSink implements EventSink, AssistantTextDeltaSink {
  readonly name = "deferred-tui-projection";
  private target?: TuiProjectionStore;
  private readonly buffered: AgentEvent[] = [];

  async append(event: AgentEvent): Promise<void> {
    if (this.target === undefined) {
      this.buffered.push(event);
      return;
    }
    await this.target.append(event);
  }

  updateAssistantTextDelta(update: AssistantTextDeltaUpdate): void {
    this.target?.updateAssistantTextDelta(update);
  }

  async attach(target: TuiProjectionStore): Promise<void> {
    if (this.target !== undefined) {
      throw new Error("Deferred projection sink is already attached.");
    }
    this.target = target;
    for (const event of this.buffered) {
      await target.append(event);
    }
    this.buffered.length = 0;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
