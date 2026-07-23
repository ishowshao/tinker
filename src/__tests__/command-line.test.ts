import { describe, expect, test } from "bun:test";
import {
  parseCommandLine,
  type CliCommand,
  type CommandLineResult,
} from "../cli/command-line";
import { CliUsageError, renderUsageError } from "../cli/output";

const VERSION = "9.8.7";

describe("CLI command line", () => {
  test("selects the TUI for empty argv and a single top-level profile", async () => {
    expect(await parseCommand([])).toEqual({ type: "tui" });
    expect(await parseCommand(["--profile", "kimi"])).toEqual({
      type: "tui",
      profileName: "kimi",
    });
    expect(await parseCommand(["-p", " glm "])).toEqual({
      type: "tui",
      profileName: " glm ",
    });
  });

  test("parses all three one-shot prompt sources without joining argv", async () => {
    expect(await parseCommand(["run", "hello world"])).toEqual({
      type: "run",
      promptSource: { kind: "argument", value: "hello world" },
    });
    expect(await parseCommand(["run", "--stdin"])).toEqual({
      type: "run",
      promptSource: { kind: "stdin" },
    });
    expect(await parseCommand(["run", "--file", "prompt.md"])).toEqual({
      type: "run",
      promptSource: { kind: "file", filePath: "prompt.md" },
    });
  });

  test("keeps the run profile in the subcommand scope", async () => {
    expect(await parseCommand(["run", "--profile", "kimi", "hello"])).toEqual({
      type: "run",
      profileName: "kimi",
      promptSource: { kind: "argument", value: "hello" },
    });
    expect(await parseCommand(["run", "--stdin", "-p-name"])).toEqual({
      type: "run",
      profileName: "-name",
      promptSource: { kind: "stdin" },
    });
  });

  test("accepts attached leading-dash values and -- protected prompts", async () => {
    expect(await parseCommand(["run", "--file=-prompt.md"])).toEqual({
      type: "run",
      promptSource: { kind: "file", filePath: "-prompt.md" },
    });
    expect(await parseCommand(["run", "--profile=-name", "--", "-leading"])).toEqual({
      type: "run",
      profileName: "-name",
      promptSource: { kind: "argument", value: "-leading" },
    });
  });

  test("rejects missing, conflicting, duplicate, and excess prompt sources", async () => {
    await expectUsage(["run"], "Exactly one prompt source", "run");
    await expectUsage(["run", "hello", "--stdin"], "mutually exclusive", "run");
    await expectUsage(
      ["run", "--stdin", "--file", "prompt.md"],
      "mutually exclusive",
      "run",
    );
    await expectUsage(["run", "--stdin", "--stdin"], "only be specified once", "run");
    await expectUsage(
      ["run", "--file", "a", "--file", "b"],
      "only be specified once",
      "run",
    );
    await expectUsage(["run", "hello", "world"], "too many arguments", "run");
  });

  test("rejects duplicate profile options in each command scope", async () => {
    await expectUsage(["--profile", "a", "-p", "b"], "only be specified once", "root");
    await expectUsage(
      ["run", "-p", "a", "--profile", "b", "hello"],
      "only be specified once",
      "run",
    );
  });

  test("rejects separated option-looking values before Commander can consume them", async () => {
    await expectUsage(["--profile", "--help"], "argument missing", "root");
    await expectUsage(
      ["run", "--profile", "--unknown", "hello"],
      "argument missing",
      "run",
    );
    await expectUsage(["run", "--file", "--stdin"], "argument missing", "run");
    await expectUsage(["run", "--file="], "non-empty path", "run");
    await expectUsage(["--profile="], "non-empty value", "root");
  });

  test("rejects a top-level profile combined with run after parsing", async () => {
    await expectUsage(
      ["--profile", "kimi", "run", "hello"],
      "only applies to the TUI",
      "run",
    );
  });

  test("renders root help, run help, help commands, and bare version as terminal success", async () => {
    const rootHelp = await parseCommandLine(["--help"], VERSION);
    expectTerminal(rootHelp, "Usage: tinker [options] [command]");
    expect(rootHelp.type === "terminal" && rootHelp.stdout).toContain("--profile");

    const runHelp = await parseCommandLine(["run", "--help"], VERSION);
    expectTerminal(runHelp, "Usage: tinker run [options] [prompt]");
    expect(runHelp.type === "terminal" && runHelp.stdout).toContain("--stdin");
    expect(runHelp.type === "terminal" && runHelp.stdout).toContain("--file <path>");
    expect(runHelp.type === "terminal" && runHelp.stdout).toContain(
      "complex or sensitive prompts",
    );

    expectTerminal(
      await parseCommandLine(["help"], VERSION),
      "Usage: tinker [options] [command]",
    );
    expectTerminal(
      await parseCommandLine(["help", "run"], VERSION),
      "Usage: tinker run [options] [prompt]",
    );

    const version = await parseCommandLine(["--version"], VERSION);
    expect(version).toEqual({ type: "terminal", stdout: `${VERSION}\n`, stderr: "" });
    expect(await parseCommandLine(["-V"], VERSION)).toEqual(version);
  });

  test("lets valid terminal help bypass post-parse profile invariants", async () => {
    expectTerminal(
      await parseCommandLine(["--profile", "kimi", "--help"], VERSION),
      "Usage: tinker",
    );
    expectTerminal(
      await parseCommandLine(["--profile", "kimi", "help", "run"], VERSION),
      "Usage: tinker run",
    );
    expectTerminal(
      await parseCommandLine(["run", "--profile", "kimi", "--help"], VERSION),
      "Usage: tinker run",
    );
  });

  test("rejects unknown commands and options without suggestions", async () => {
    const unknownCommand = await captureUsage(["rn"]);
    expect(unknownCommand.message).toContain("unknown command 'rn'");
    expect(unknownCommand.message).not.toContain("Did you mean");

    const rootOption = await captureUsage(["--unknown"]);
    expect(renderUsageError(rootOption)).toEndWith('Run "tinker --help" for usage.\n');

    const runOption = await captureUsage(["run", "--unknown"]);
    expect(renderUsageError(runOption)).toEndWith(
      'Run "tinker run --help" for usage.\n',
    );
    await expectUsage(["run", "--version"], "unknown option", "run");
  });

  test("creates a fresh Commander instance for every parse", async () => {
    expect(await parseCommand([])).toEqual({ type: "tui" });
    expect(await parseCommand(["run", "next"])).toEqual({
      type: "run",
      promptSource: { kind: "argument", value: "next" },
    });
    expect(await parseCommand([])).toEqual({ type: "tui" });
  });
});

async function parseCommand(args: readonly string[]): Promise<CliCommand> {
  const result = await parseCommandLine(args, VERSION);
  if (result.type !== "command") {
    throw new Error("Expected a runtime command.");
  }
  return result.command;
}

async function captureUsage(args: readonly string[]): Promise<CliUsageError> {
  try {
    await parseCommandLine(args, VERSION);
  } catch (error) {
    if (error instanceof CliUsageError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a CLI usage error.");
}

async function expectUsage(
  args: readonly string[],
  message: string,
  scope: "root" | "run",
): Promise<void> {
  const error = await captureUsage(args);
  expect(error.message).toContain(message);
  expect(error.scope).toBe(scope);
}

function expectTerminal(result: CommandLineResult, output: string): void {
  expect(result.type).toBe("terminal");
  if (result.type !== "terminal") {
    return;
  }
  expect(result.stdout).toContain(output);
  expect(result.stderr).toBe("");
}
