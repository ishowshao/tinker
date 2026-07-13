import {
  createRuntimeSession,
  type RuntimeSession,
  type SessionDisposeReason,
} from "../agent/runtime-session";
import { StdoutEventPrinter, type WritableLike } from "../events/stdout-event-printer";
import type { ModelClient } from "../model/model-client";
import {
  buildSystemPrompt,
  loadProjectInstructions,
  projectInstructionManifest,
} from "../instructions/project-instructions";
import {
  createRunnerModelClient,
  createWebFetchRefinerFromEnv,
  readRunnerConfig,
  RUNTIME_INSTRUCTIONS,
  type RunnerConfigOverrides,
} from "./config";
import { realpath } from "node:fs/promises";

export type RunOneShotOptions = RunnerConfigOverrides & {
  modelClient?: ModelClient;
  stdout?: WritableLike;
  stderr?: WritableLike;
  eventLogPath?: string | false;
};

export async function runOneShot(
  userPrompt: string,
  options: RunOneShotOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let session: RuntimeSession | undefined;
  let disposeReason: SessionDisposeReason = { type: "oneshot_complete" };
  let primaryError: unknown;
  let exitCode = 1;

  try {
    const config = readRunnerConfig(options);
    const workspaceRoot = await realpath(config.workspaceRoot);
    const projectInstructions = await loadProjectInstructions(workspaceRoot);
    const systemPrompt = buildSystemPrompt({
      workspaceRoot,
      runtimeInstructions: RUNTIME_INSTRUCTIONS(workspaceRoot),
      projectInstructions,
    });
    const modelClient = createRunnerModelClient(config, options.modelClient);
    session = await createRuntimeSession({
      selection: { mode: "new", sessionId: config.sessionId },
      workspaceRoot,
      modelName: config.modelName,
      maxIterations: config.maxIterations,
      includeReasoningContent: config.includeReasoningContent,
      contextProfile: config.contextProfile,
      contextBudget: config.contextBudget,
      systemPrompt,
      projectInstruction: projectInstructionManifest(projectInstructions),
      modelClient,
      presentationSinks: [new StdoutEventPrinter(stdout, stderr)],
      persistence:
        options.eventLogPath === false ? false : { eventLogPath: options.eventLogPath },
      webFetchRefiner: createWebFetchRefinerFromEnv(config),
    });

    const result = await session.executeTurn({
      userPrompt,
      signal: new AbortController().signal,
    });
    if (result.status === "completed") {
      stdout.write(`\n${result.finalText}\n`);
      exitCode = 0;
    }
  } catch (error) {
    primaryError = error;
    disposeReason = { type: "runner_failed", error: errorMessage(error) };
    stderr.write(`Runtime failed: ${errorMessage(error)}\n`);
  } finally {
    if (session !== undefined) {
      try {
        await session.dispose(disposeReason);
      } catch (error) {
        exitCode = 1;
        if (primaryError === undefined) {
          stderr.write(`Runtime cleanup failed: ${errorMessage(error)}\n`);
        } else {
          const combined = new AggregateError(
            [primaryError, error],
            "Runtime execution and cleanup failed.",
          );
          stderr.write(`Runtime cleanup failed: ${errorMessage(combined)}\n`);
        }
      }
    }
  }

  return exitCode;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
