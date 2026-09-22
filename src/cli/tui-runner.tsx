import { render } from "ink";
import { realpath } from "node:fs/promises";
import type { ClientCloseReason } from "../client/session-client";
import { createLocalTuiClient } from "./local-tui-client";
import { App } from "../tui/app";
import { readCurrentGitBranch } from "../tui/git-branch";
import { PromptHistory } from "../tui/prompt-history";
import {
  promptHistoryPath,
  type ResolvedPublicConfig,
  type RunnerConfig,
} from "./config";
import { loadProjectSlashCommands } from "../tui/project-slash-commands";
import { createWorkspaceFileLister } from "../tui/workspace-file-search";
import { clipboardWriterForEnvironment } from "../tui/clipboard";
import { listMemoryFiles } from "../memory/memory-files";
import { prepareShikiHighlighter } from "../tui/shiki-highlighter";

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
  let connection: Awaited<ReturnType<typeof createLocalTuiClient>> | undefined;
  let instance: ReturnType<typeof render> | undefined;
  let closeReason: ClientCloseReason = { type: "client_exit" };
  let primaryError: unknown;
  let quitRequested = false;

  try {
    const projectSlashCommands = await loadProjectSlashCommands(workspaceRoot);
    connection = await createLocalTuiClient({ ...options, workspaceRoot });
    const promptHistory = await PromptHistory.load(
      await promptHistoryPath(workspaceRoot),
    );

    await shikiPreparation;
    instance = render(
      <App
        sessionController={connection.client}
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
        listStoredMemories={() => listMemoryFiles()}
      />,
      { incrementalRendering: true },
    );
    await instance.waitUntilExit();
  } catch (error) {
    primaryError = error;
    closeReason = { type: "client_failed", error: errorMessage(error) };
  } finally {
    instance?.unmount();
    restoreStdin();
    if (connection !== undefined) {
      try {
        await connection.close(closeReason);
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
