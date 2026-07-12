import { render } from "ink";
import { realpath } from "node:fs/promises";
import {
  createRuntimeSession,
  type RuntimeSession,
  type SessionDisposeReason,
} from "../agent/runtime-session";
import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import type { SessionId } from "../ids/runtime-id";
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
} from "../tui/tui-session-controller";
import {
  createRunnerModelClient,
  createWebFetchRefinerFromEnv,
  promptHistoryPath,
  readRunnerConfig,
  SYSTEM_PROMPT,
} from "./config";

export async function runTui(): Promise<void> {
  const config = readRunnerConfig();
  const workspaceRoot = await realpath(config.workspaceRoot);
  const modelClient = createRunnerModelClient(config);
  const projectionStore = new TuiProjectionStore({
    sessionId: config.sessionId,
    modelName: config.modelName,
    workspaceRoot,
  });
  let controller: DefaultTuiSessionController | undefined;
  let instance: ReturnType<typeof render> | undefined;
  let disposeReason: SessionDisposeReason = { type: "tui_exit" };
  let primaryError: unknown;
  let quitRequested = false;

  try {
    const createSession = async (
      mode: "new" | "resume",
      sessionId: SessionId,
      sink: EventSink,
    ): Promise<RuntimeSession> =>
      createRuntimeSession({
        selection: { mode, sessionId },
        workspaceRoot,
        modelName: config.modelName,
        maxIterations: config.maxIterations,
        includeReasoningContent: config.includeReasoningContent,
        contextProfile: config.contextProfile,
        contextBudget: config.contextBudget,
        systemPrompt: SYSTEM_PROMPT(workspaceRoot),
        modelClient,
        presentationSinks: [sink],
        webFetchRefiner: createWebFetchRefinerFromEnv(config),
      });
    const initialSession = await createSession(
      "new",
      config.sessionId,
      projectionStore,
    );
    const promptHistory = await PromptHistory.load(promptHistoryPath(workspaceRoot));
    const catalog = new SessionCatalog({ workspaceRoot });
    const openStoredSession = async (
      sessionId: SessionId,
    ): Promise<ManagedTuiSessionBinding> => {
      const deferred = new DeferredProjectionSink();
      const runtimeSession = await createSession("resume", sessionId, deferred);
      const targetProjection = new TuiProjectionStore({
        sessionId,
        modelName: config.modelName,
        workspaceRoot,
      });
      try {
        targetProjection.hydrate(
          await ResumeProjectionReader.read({
            workspaceRoot,
            sessionId,
            modelName: config.modelName,
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
        modelName: config.modelName,
        workspaceRoot,
        projectionStore: targetProjection,
      });
    };
    controller = new DefaultTuiSessionController(
      managedTuiBinding({
        runtimeSession: initialSession,
        modelName: config.modelName,
        workspaceRoot,
        projectionStore,
      }),
      catalog,
      openStoredSession,
    );

    instance = render(
      <App
        sessionController={controller}
        readGitBranch={readCurrentGitBranch}
        history={promptHistory}
        onQuit={() => {
          quitRequested = true;
        }}
      />,
    );
    await instance.waitUntilExit();
  } catch (error) {
    primaryError = error;
    disposeReason = { type: "runner_failed", error: errorMessage(error) };
  } finally {
    instance?.unmount();
    restoreStdin();
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

class DeferredProjectionSink implements EventSink {
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
