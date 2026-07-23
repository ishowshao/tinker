import { Command, CommanderError } from "commander";
import { PUBLIC_CLI_CONTRACT } from "./public-cli-contract";
import type { PromptSource } from "./prompt-source";
import { CliUsageError, type CliCommandScope } from "./output";

export type CliCommand =
  | { readonly type: "tui"; readonly profileName?: string }
  | {
      readonly type: "run";
      readonly profileName?: string;
      readonly promptSource: PromptSource;
    };

export type CommandLineResult =
  | { readonly type: "command"; readonly command: CliCommand }
  | {
      readonly type: "terminal";
      readonly stdout: string;
      readonly stderr: string;
    };

const SUCCESSFUL_TERMINAL_CODES = new Set([
  "commander.help",
  "commander.helpDisplayed",
  "commander.version",
]);

export async function parseCommandLine(
  args: readonly string[],
  packageVersion: string,
): Promise<CommandLineResult> {
  const scopeHint = preflightArgv(args);
  let stdout = "";
  let stderr = "";
  let selectedCommand: CliCommand | undefined;
  const contract = PUBLIC_CLI_CONTRACT;

  const program = new Command()
    .name(contract.name)
    .description(contract.description)
    .helpOption(contract.helpFlags)
    .version(packageVersion, contract.versionFlags)
    .option(contract.tui.profileOption.flags, contract.tui.profileOption.description)
    .helpCommand(contract.helpCommand.command, contract.helpCommand.description)
    .showHelpAfterError('Run "tinker --help" for usage.')
    .showSuggestionAfterError(false)
    .allowExcessArguments(false)
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    });

  program.action(() => {
    const { profile } = program.opts<{ profile?: string }>();
    selectedCommand = Object.freeze({
      type: "tui",
      ...(profile === undefined
        ? {}
        : { profileName: validateProfile(profile, "root") }),
    });
  });

  program
    .command(contract.run.command)
    .description(contract.run.description)
    .option(contract.run.profileOption.flags, contract.run.profileOption.description)
    .option(contract.run.stdinOption.flags, contract.run.stdinOption.description)
    .option(contract.run.fileOption.flags, contract.run.fileOption.description)
    .addHelpText("after", `\n${contract.run.helpAfter}\n`)
    .showHelpAfterError('Run "tinker run --help" for usage.')
    .showSuggestionAfterError(false)
    .allowExcessArguments(false)
    .exitOverride()
    .action(
      (
        prompt: string | undefined,
        options: { profile?: string; stdin?: boolean; file?: string },
      ) => {
        const sources: PromptSource[] = [];
        if (prompt !== undefined) {
          sources.push({ kind: "argument", value: prompt });
        }
        if (options.stdin === true) {
          sources.push({ kind: "stdin" });
        }
        if (options.file !== undefined) {
          if (options.file.length === 0) {
            throw new CliUsageError("--file requires a non-empty path.", "run");
          }
          sources.push({ kind: "file", filePath: options.file });
        }
        if (sources.length === 0) {
          throw new CliUsageError(
            "Exactly one prompt source is required: [prompt], --stdin, or --file <path>.",
            "run",
          );
        }
        if (sources.length > 1) {
          throw new CliUsageError(
            "Prompt sources are mutually exclusive: use [prompt], --stdin, or --file <path>.",
            "run",
          );
        }
        const promptSource = sources[0];
        if (promptSource === undefined) {
          throw new CliUsageError("A prompt source is required.", "run");
        }
        selectedCommand = Object.freeze({
          type: "run",
          ...(options.profile === undefined
            ? {}
            : { profileName: validateProfile(options.profile, "run") }),
          promptSource,
        });
      },
    );

  try {
    await program.parseAsync([...args], { from: "user" });
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw error;
    }
    if (error instanceof CommanderError) {
      if (SUCCESSFUL_TERMINAL_CODES.has(error.code)) {
        return Object.freeze({ type: "terminal", stdout, stderr });
      }
      throw new CliUsageError(commanderErrorDetail(error), scopeHint);
    }
    throw error;
  }

  if (selectedCommand === undefined) {
    throw new Error("Commander completed without selecting a command.");
  }
  const topLevelProfile = program.opts<{ profile?: string }>().profile;
  if (selectedCommand.type === "run" && topLevelProfile !== undefined) {
    throw new CliUsageError(
      "The top-level --profile option only applies to the TUI; place --profile after run.",
      "run",
    );
  }
  return Object.freeze({ type: "command", command: selectedCommand });
}

function preflightArgv(args: readonly string[]): CliCommandScope {
  let scope: CliCommandScope = "root";
  let rootBlocked = false;
  let topProfileOccurrences = 0;
  let runProfileOccurrences = 0;
  let stdinOccurrences = 0;
  let fileOccurrences = 0;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || token === "--") {
      break;
    }

    if (
      (!rootBlocked && scope === "root" && isRootTerminalOption(token)) ||
      (scope === "run" && isRunTerminalOption(token))
    ) {
      return scope;
    }

    if (scope === "root" && !rootBlocked) {
      const profile = readOptionOccurrence(
        args,
        index,
        token,
        "--profile",
        "root",
        "-p",
      );
      if (profile !== undefined) {
        topProfileOccurrences += 1;
        assertSingleOccurrence("--profile", topProfileOccurrences, "root");
        validateProfile(profile.value, "root");
        index += profile.consumedNext ? 1 : 0;
        continue;
      }
      if (token.startsWith("-")) {
        rootBlocked = true;
        continue;
      }
      if (token === "run") {
        scope = "run";
        continue;
      }
      if (token === "help") {
        return "root";
      }
      throw new CliUsageError(`unknown command '${token}'`, "root");
    }

    if (scope !== "run") {
      continue;
    }
    const profile = readOptionOccurrence(args, index, token, "--profile", "run", "-p");
    if (profile !== undefined) {
      runProfileOccurrences += 1;
      assertSingleOccurrence("--profile", runProfileOccurrences, "run");
      validateProfile(profile.value, "run");
      index += profile.consumedNext ? 1 : 0;
      continue;
    }
    const file = readOptionOccurrence(args, index, token, "--file", "run");
    if (file !== undefined) {
      fileOccurrences += 1;
      assertSingleOccurrence("--file", fileOccurrences, "run");
      if (file.value.length === 0) {
        throw new CliUsageError("--file requires a non-empty path.", "run");
      }
      index += file.consumedNext ? 1 : 0;
      continue;
    }
    if (token === "--stdin") {
      stdinOccurrences += 1;
      assertSingleOccurrence("--stdin", stdinOccurrences, "run");
    }
  }
  return scope;
}

function readOptionOccurrence(
  args: readonly string[],
  index: number,
  token: string,
  longName: string,
  scope: CliCommandScope,
  shortName?: string,
): { readonly value: string; readonly consumedNext: boolean } | undefined {
  if (token === longName || token === shortName) {
    const next = args[index + 1];
    if (next === undefined || next.startsWith("-")) {
      throw new CliUsageError(`option '${token}' argument missing`, scope);
    }
    return { value: next, consumedNext: true };
  }
  const longPrefix = `${longName}=`;
  if (token.startsWith(longPrefix)) {
    return { value: token.slice(longPrefix.length), consumedNext: false };
  }
  if (
    shortName !== undefined &&
    token.startsWith(shortName) &&
    token !== shortName &&
    !token.startsWith("--")
  ) {
    return { value: token.slice(shortName.length), consumedNext: false };
  }
  return undefined;
}

function validateProfile(value: string, scope: CliCommandScope): string {
  if (value.trim() === "") {
    throw new CliUsageError("--profile requires a non-empty value.", scope);
  }
  return value;
}

function assertSingleOccurrence(
  option: string,
  count: number,
  scope: CliCommandScope,
): void {
  if (count > 1) {
    throw new CliUsageError(`${option} may only be specified once.`, scope);
  }
}

function isRootTerminalOption(token: string): boolean {
  return (
    token === "--help" || token === "-h" || token === "--version" || token === "-V"
  );
}

function isRunTerminalOption(token: string): boolean {
  return token === "--help" || token === "-h";
}

function commanderErrorDetail(error: CommanderError): string {
  return error.message.replace(/^error:\s*/u, "");
}
