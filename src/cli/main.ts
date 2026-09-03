import type { SessionId } from "../ids/runtime-id";
import { createUuidV7 } from "../ids/uuid-v7";
import { parseCommandLine, type CommandLineResult } from "./command-line";
import type {
  ResolvedPublicConfig,
  RunnerConfig,
  RunnerConfigSelection,
} from "./config";
import {
  CliUsageError,
  flushCliOutput,
  renderCliFailure,
  renderUsageError,
  writeCliOutput,
  type CliOutputWriter,
} from "./output";
import { loadPackageMetadata, type PackageMetadata } from "./package-metadata";
import {
  PromptInputError,
  resolvePromptSource,
  type PromptReadable,
  type PromptSource,
  type ResolvedPrompt,
} from "./prompt-source";

export const BOOTSTRAP_FAILURE_MESSAGE =
  "Tinker failed to start. Reinstall tinker-agent.\n";

export type MainInput = {
  readonly args: readonly string[];
  readonly stdin: PromptReadable;
  readonly stdout: CliOutputWriter;
  readonly stderr: CliOutputWriter;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
};

type ConfigBoundary = {
  readonly resolvePublicConfig: (input: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
  }) => Promise<ResolvedPublicConfig>;
  readonly deriveRunnerConfig: (
    snapshot: ResolvedPublicConfig,
    selection: RunnerConfigSelection,
  ) => RunnerConfig;
};

type TuiRunner = {
  readonly runTui: (options: {
    readonly publicConfig: ResolvedPublicConfig;
    readonly initialRunnerConfig: RunnerConfig;
    readonly env: NodeJS.ProcessEnv;
    readonly version: string;
  }) => Promise<void>;
};

type OneShotRunner = {
  readonly runOneShot: (
    prompt: string,
    options: {
      readonly config: RunnerConfig;
      readonly tooling: ResolvedPublicConfig["tooling"];
      readonly stdout: CliOutputWriter;
      readonly stderr: CliOutputWriter;
      readonly env: NodeJS.ProcessEnv;
    },
  ) => Promise<number>;
};

type UpdateRunner = {
  readonly runUpdate: (options: {
    readonly metadata: PackageMetadata;
    readonly stdout: CliOutputWriter;
    readonly env: NodeJS.ProcessEnv;
  }) => Promise<number>;
};

export type MainDependencies = {
  readonly loadPackageMetadata: () => Promise<PackageMetadata>;
  readonly parseCommandLine: (
    args: readonly string[],
    packageVersion: string,
  ) => Promise<CommandLineResult>;
  readonly loadConfigBoundary: () => Promise<ConfigBoundary>;
  readonly createSessionId: () => SessionId;
  readonly resolvePromptSource: (
    source: PromptSource,
    input: { readonly stdin: PromptReadable; readonly cwd: string },
  ) => Promise<ResolvedPrompt>;
  readonly loadTuiRunner: () => Promise<TuiRunner>;
  readonly loadOneShotRunner: () => Promise<OneShotRunner>;
  readonly loadUpdateRunner: () => Promise<UpdateRunner>;
};

const DEFAULT_DEPENDENCIES: MainDependencies = {
  loadPackageMetadata,
  parseCommandLine,
  loadConfigBoundary: () => import("./config"),
  createSessionId: () => createUuidV7() as SessionId,
  resolvePromptSource,
  loadTuiRunner: () => import("./tui-runner"),
  loadOneShotRunner: () => import("./run-runner"),
  loadUpdateRunner: () => import("./update-runner"),
};

export async function main(
  input: MainInput,
  injected: Partial<MainDependencies> = {},
): Promise<number> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...injected };
  const args = Object.freeze([...input.args]);
  const env = Object.freeze({ ...input.env }) as NodeJS.ProcessEnv;
  const cwd = input.cwd;
  const finish = async (exitCode: number): Promise<number> => {
    await flushCliOutput(input.stdout);
    await flushCliOutput(input.stderr);
    return exitCode;
  };

  try {
    let metadata: PackageMetadata;
    try {
      metadata = await dependencies.loadPackageMetadata();
    } catch {
      await writeCliOutput(input.stderr, BOOTSTRAP_FAILURE_MESSAGE);
      return finish(1);
    }

    let parsed: CommandLineResult;
    try {
      parsed = await dependencies.parseCommandLine(args, metadata.version);
    } catch (error) {
      if (error instanceof CliUsageError) {
        await writeCliOutput(input.stderr, renderUsageError(error));
        return finish(2);
      }
      throw error;
    }

    if (parsed.type === "terminal") {
      await writeCliOutput(input.stdout, parsed.stdout);
      await writeCliOutput(input.stderr, parsed.stderr);
      return finish(0);
    }

    if (parsed.command.type === "update") {
      try {
        const runner = await dependencies.loadUpdateRunner();
        return finish(
          await runner.runUpdate({
            metadata,
            stdout: input.stdout,
            env,
          }),
        );
      } catch (error) {
        await writeCliOutput(input.stderr, renderCliFailure("Update failed", error));
        return finish(1);
      }
    }

    let configBoundary: ConfigBoundary;
    let publicConfig: ResolvedPublicConfig;
    let runnerConfig: RunnerConfig;
    try {
      configBoundary = await dependencies.loadConfigBoundary();
      publicConfig = await configBoundary.resolvePublicConfig({ env, cwd });
      runnerConfig = configBoundary.deriveRunnerConfig(publicConfig, {
        sessionId: dependencies.createSessionId(),
        ...(parsed.command.profileName === undefined
          ? {}
          : { profileName: parsed.command.profileName }),
        ...(parsed.command.type === "run" && parsed.command.yolo ? { yolo: true } : {}),
      });
    } catch (error) {
      await writeCliOutput(
        input.stderr,
        renderCliFailure("Configuration failed", error),
      );
      return finish(1);
    }

    if (parsed.command.type === "tui") {
      try {
        const runner = await dependencies.loadTuiRunner();
        await runner.runTui({
          publicConfig,
          initialRunnerConfig: runnerConfig,
          env,
          version: metadata.version,
        });
        return finish(0);
      } catch (error) {
        await writeCliOutput(input.stderr, renderCliFailure("Runtime failed", error));
        return finish(1);
      }
    }

    let prompt: ResolvedPrompt;
    try {
      prompt = await dependencies.resolvePromptSource(parsed.command.promptSource, {
        stdin: input.stdin,
        cwd,
      });
    } catch (error) {
      if (error instanceof PromptInputError) {
        await writeCliOutput(
          input.stderr,
          renderCliFailure("Prompt input failed", error),
        );
        return finish(error.exitCode);
      }
      await writeCliOutput(
        input.stderr,
        renderCliFailure("Prompt input failed", error),
      );
      return finish(1);
    }

    try {
      const runner = await dependencies.loadOneShotRunner();
      const exitCode = await runner.runOneShot(prompt.text, {
        config: runnerConfig,
        tooling: publicConfig.tooling,
        stdout: input.stdout,
        stderr: input.stderr,
        env,
      });
      return finish(exitCode);
    } catch (error) {
      await writeCliOutput(input.stderr, renderCliFailure("Runtime failed", error));
      return finish(1);
    }
  } catch (error) {
    await writeCliOutput(
      input.stderr,
      renderCliFailure("Tinker failed unexpectedly", error),
    );
    return finish(1);
  }
}
