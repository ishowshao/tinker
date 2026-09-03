import { render } from "ink";
import { realpath } from "node:fs/promises";
import {
  createRuntimeSession,
  type RuntimeSession,
  type SessionDisposeReason,
} from "../agent/runtime-session";
import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import type {
  AssistantTextDeltaSink,
  AssistantTextDeltaUpdate,
} from "../agent/assistant-text-delta";
import { createUuidV7 } from "../ids/uuid-v7";
import type { SessionId } from "../ids/runtime-id";
import {
  buildSystemPrompt,
  loadProjectInstructions,
  projectInstructionManifest,
} from "../instructions/project-instructions";
import { ResumeProjectionReader } from "../session/resume-projection";
import { SessionCatalog } from "../session/session-catalog";
import { App } from "../tui/app";
import { readCurrentGitBranch } from "../tui/git-branch";
import { PromptHistory } from "../tui/prompt-history";
import { TuiProjectionStore } from "../tui/tui-projection-store";
import {
  DefaultTuiSessionController,
  managedTuiBinding,
  type ManagedTuiSessionBinding,
  type TuiSessionBinding,
} from "../tui/tui-session-controller";
import {
  promptHistoryPath,
  deriveRunnerConfig,
  type ResolvedPublicConfig,
  type RunnerConfig,
} from "./config";
import {
  createRunnerModelClient,
  createWebFetchRefiner,
  RUNTIME_INSTRUCTIONS,
} from "./runner-dependencies";
import { resolveSessionProfileName, type ModelProfile } from "./model-profiles";
import { loadSkillCatalog } from "../skills/skill-loader";
import { loadProjectSlashCommands } from "../tui/project-slash-commands";
import { createWorkspaceFileLister } from "../tui/workspace-file-search";
import { clipboardWriterForEnvironment } from "../tui/clipboard";
import { initializeTuiMemory } from "./tui-memory";
import { prepareShikiHighlighter } from "../tui/shiki-highlighter";
import { createReasoningEffortController } from "../model/reasoning-effort";

export type RunTuiOptions = {
  readonly publicConfig: ResolvedPublicConfig;
  readonly initialRunnerConfig: RunnerConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly version: string;
};

export async function runTui(options: RunTuiOptions): Promise<void> {
  const shikiPreparation = prepareShikiHighlighter();
  const profiles =
    options.publicConfig.mode === "profile" ? options.publicConfig.profiles : undefined;
  const config = options.initialRunnerConfig;
  const workspaceRoot = await realpath(config.workspaceRoot);
  const memory = await initializeTuiMemory({
    config:
      options.publicConfig.mode === "profile" ? options.publicConfig.memory : undefined,
    env: options.env,
  });
  const memoryCoordinator = memory.coordinator;
  const memoryNotice = memory.notice;
  let controller: DefaultTuiSessionController | undefined;
  let instance: ReturnType<typeof render> | undefined;
  let disposeReason: SessionDisposeReason = { type: "tui_exit" };
  let primaryError: unknown;
  let quitRequested = false;

  try {
    const projectSlashCommands = await loadProjectSlashCommands(workspaceRoot);
    const createSessionForConfig = async (
      sessionConfig: RunnerConfig,
      mode: "new" | "resume",
      sessionId: SessionId,
      sink: EventSink & AssistantTextDeltaSink,
    ): Promise<RuntimeSession> => {
      const reasoningEffort = createReasoningEffortController(sessionConfig.reasoning);
      const modelClient = createRunnerModelClient(
        sessionConfig,
        undefined,
        options.env,
        reasoningEffort,
      );
      const projectInstructions = await loadProjectInstructions(workspaceRoot);
      const skillCatalog = await loadSkillCatalog({ workspaceRoot });
      const common = {
        workspaceRoot,
        modelName: sessionConfig.modelName,
        profileName: sessionConfig.profileName,
        maxIterations: sessionConfig.maxIterations,
        includeReasoningContent: sessionConfig.includeReasoningContent,
        contextProfile: sessionConfig.contextProfile,
        contextBudget: sessionConfig.contextBudget,
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
        webFetchRefiner: createWebFetchRefiner(
          sessionConfig,
          options.env,
          reasoningEffort,
        ),
        toolingConfig: options.publicConfig.tooling,
        enableTurnUndo: true,
        bashGuard: {
          mode: sessionConfig.bashGuardMode,
          source: sessionConfig.bashGuardSource,
          surface: "tui" as const,
        },
        ...(memoryCoordinator === undefined
          ? {}
          : {
              memorySearch: memoryCoordinator.createSearchToolExecutor({
                workspaceRoot,
                sessionId,
              }),
              memoryGet: memoryCoordinator.createGetToolExecutor({
                workspaceRoot,
                sessionId,
              }),
              completedTurnHook: memoryCoordinator,
            }),
      };
      if (mode === "resume") {
        return createRuntimeSession({
          ...common,
          selection: { mode, sessionId },
        });
      }

      return createRuntimeSession({
        ...common,
        selection: { mode, sessionId },
      });
    };

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
    const promptHistory = await PromptHistory.load(
      await promptHistoryPath(workspaceRoot),
    );
    const catalog = new SessionCatalog({ workspaceRoot });

    const openStoredSession = async (
      sessionId: SessionId,
    ): Promise<ManagedTuiSessionBinding> => {
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
      return managedTuiBinding({
        runtimeSession,
        modelName: resumeConfig.modelName,
        workspaceRoot,
        profileName: resumeConfig.profileName,
        projectionStore: targetProjection,
      });
    };

    const createNewSessionBinding = async (
      sessionConfig: RunnerConfig,
    ): Promise<ManagedTuiSessionBinding> => {
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
      return managedTuiBinding({
        runtimeSession,
        modelName: sessionConfig.modelName,
        workspaceRoot,
        profileName: sessionConfig.profileName,
        projectionStore: freshProjectionStore,
      });
    };

    const createSessionWithProfile = async (
      profile: ModelProfile,
    ): Promise<ManagedTuiSessionBinding> => {
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
      current: TuiSessionBinding,
    ): Promise<ManagedTuiSessionBinding> => {
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

    controller = new DefaultTuiSessionController(
      managedTuiBinding({
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

    await shikiPreparation;
    instance = render(
      <App
        sessionController={controller}
        version={options.version}
        readGitBranch={readCurrentGitBranch}
        history={promptHistory}
        projectSlashCommands={projectSlashCommands}
        profiles={profiles}
        persistDefaultProfile={
          options.publicConfig.mode === "profile"
            ? options.publicConfig.persistDefaultProfile
            : undefined
        }
        fileLister={createWorkspaceFileLister({
          command: options.publicConfig.tooling.ripgrepPath,
          timeoutMs: options.publicConfig.tooling.grepTimeoutMs,
          maxBufferBytes: options.publicConfig.tooling.grepMaxBufferBytes,
        })}
        writeClipboard={clipboardWriterForEnvironment(options.env)}
        onQuit={() => {
          quitRequested = true;
        }}
        initialNotice={memoryNotice}
        memoryDisabledNotice={memoryNotice}
        listStoredMemories={
          memoryCoordinator === undefined
            ? undefined
            : () => memoryCoordinator.listStoredMemories()
        }
      />,
      { incrementalRendering: true },
    );
    await instance.waitUntilExit();
  } catch (error) {
    primaryError = error;
    disposeReason = { type: "runner_failed", error: errorMessage(error) };
  } finally {
    instance?.unmount();
    restoreStdin();
    memoryCoordinator?.dispose();
    if (controller !== undefined) {
      try {
        await controller.dispose(disposeReason);
      } catch (error) {
        primaryError =
          primaryError === undefined
            ? error
            : new AggregateError(
                [primaryError, error],
                "TUI runtime and cleanup failed.",
              );
      }
    }
  }

  if (primaryError !== undefined) {
    throw asError(primaryError);
  }
  if (quitRequested) {
    process.exit(0);
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

function restoreStdin(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
