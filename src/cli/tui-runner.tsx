import { render } from "ink";
import {
  createRuntimeSession,
  type RuntimeSession,
  type SessionDisposeReason,
} from "../agent/runtime-session";
import { TuiEventStream } from "../events/tui-event-stream";
import { App } from "../tui/app";
import { readCurrentGitBranch } from "../tui/git-branch";
import { PromptHistory } from "../tui/prompt-history";
import {
  createRunnerModelClient,
  createWebFetchRefinerFromEnv,
  promptHistoryPath,
  readRunnerConfig,
  SYSTEM_PROMPT,
} from "./config";

export async function runTui(): Promise<void> {
  const config = readRunnerConfig();
  const modelClient = createRunnerModelClient(config);
  const eventStream = new TuiEventStream();
  let session: RuntimeSession | undefined;
  let instance: ReturnType<typeof render> | undefined;
  let disposeReason: SessionDisposeReason = { type: "tui_exit" };
  let primaryError: unknown;
  let quitRequested = false;

  try {
    session = await createRuntimeSession({
      sessionId: config.sessionId,
      workspaceRoot: config.workspaceRoot,
      modelName: config.modelName,
      maxIterations: config.maxIterations,
      includeReasoningContent: config.includeReasoningContent,
      systemPrompt: SYSTEM_PROMPT(config.workspaceRoot),
      modelClient,
      presentationSinks: [eventStream],
      webFetchRefiner: createWebFetchRefinerFromEnv(config.modelName),
    });
    const promptHistory = await PromptHistory.load(
      promptHistoryPath(config.workspaceRoot),
    );
    const runtimeSession = session;

    instance = render(
      <App
        modelName={config.modelName}
        workspaceRoot={config.workspaceRoot}
        sessionId={runtimeSession.sessionId}
        eventStream={eventStream}
        run={(userPrompt, signal) => runtimeSession.executeTurn({ userPrompt, signal })}
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
    if (session !== undefined) {
      try {
        await session.dispose(disposeReason);
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
