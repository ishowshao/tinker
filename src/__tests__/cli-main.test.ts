import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import type { SessionId } from "../ids/runtime-id";
import type { ResolvedPublicConfig, RunnerConfig } from "../cli/config";
import {
  BOOTSTRAP_FAILURE_MESSAGE,
  main,
  type MainDependencies,
  type MainInput,
} from "../cli/main";
import { PromptInputError } from "../cli/prompt-source";
import { DEFAULT_PUBLIC_TOOLING_CONFIG } from "../cli/public-config-contract";
import { TEST_CONTEXT_BUDGET, TEST_CONTEXT_PROFILE } from "./test-runtime";

type MutableMainInput = { -readonly [Key in keyof MainInput]: MainInput[Key] };
type MutableDependencies = {
  -readonly [Key in keyof MainDependencies]: MainDependencies[Key];
};

class MemoryWriter {
  output = "";

  write(chunk: string): boolean {
    this.output += chunk;
    return true;
  }
}

describe("CLI main boundary", () => {
  test("handles help, version, and usage before loading config or runners", async () => {
    for (const expected of [
      { args: ["--help"], code: 0, stdout: "Usage: tinker" },
      { args: ["--version"], code: 0, stdout: "1.3.0\n" },
      { args: ["--unknown"], code: 2, stderr: "unknown option" },
      { args: ["run"], code: 2, stderr: "Exactly one prompt source" },
    ] as const) {
      const state = testInput([...expected.args]);
      let downstreamLoads = 0;
      const code = await main(state.input, {
        loadPackageMetadata: async () => ({ name: "tinker-agent", version: "1.3.0" }),
        loadConfigBoundary: async () => {
          downstreamLoads += 1;
          throw new Error("must not load");
        },
        loadTuiRunner: async () => {
          downstreamLoads += 1;
          throw new Error("must not load");
        },
        loadOneShotRunner: async () => {
          downstreamLoads += 1;
          throw new Error("must not load");
        },
      });

      expect(code).toBe(expected.code);
      expect(downstreamLoads).toBe(0);
      if (expected.stdout !== undefined) {
        expect(state.stdout.output).toContain(expected.stdout);
        expect(state.stderr.output).toBe("");
      } else {
        expect(state.stdout.output).toBe("");
        expect(state.stderr.output).toContain(expected.stderr ?? "");
      }
    }
  });

  test("maps package metadata failure to one fixed reinstall message", async () => {
    const state = testInput(["--help"]);
    const code = await main(state.input, {
      loadPackageMetadata: async () => {
        throw new Error("/private/package.json secret parse failure");
      },
    });

    expect(code).toBe(1);
    expect(state.stdout.output).toBe("");
    expect(state.stderr.output).toBe(BOOTSTRAP_FAILURE_MESSAGE);
  });

  test("resolves config and derives one-shot config before reading stdin", async () => {
    const state = testInput(["run", "--stdin"]);
    let stdinRead = false;
    state.input.stdin = {
      [Symbol.asyncIterator]() {
        stdinRead = true;
        return Readable.from(["secret prompt"])[Symbol.asyncIterator]();
      },
    };
    let runnerLoaded = false;
    const code = await main(state.input, {
      ...successfulDependencies(),
      loadConfigBoundary: async () => ({
        resolvePublicConfig: async () => {
          throw new Error("TINKER_MODEL is required");
        },
        deriveRunnerConfig: () => {
          throw new Error("must not derive");
        },
      }),
      loadOneShotRunner: async () => {
        runnerLoaded = true;
        throw new Error("must not load");
      },
    });

    expect(code).toBe(1);
    expect(stdinRead).toBe(false);
    expect(runnerLoaded).toBe(false);
    expect(state.stderr.output).toContain(
      "Configuration failed: TINKER_MODEL is required",
    );
  });

  test("dispatches argument, stdin, and file text through the same one-shot runner boundary", async () => {
    for (const entry of [
      { args: ["run", " argument \n"], text: " argument \n" },
      { args: ["run", "--stdin"], text: "stdin\r\n" },
      { args: ["run", "--file", "prompt.md"], text: "file prompt\n" },
    ]) {
      const state = testInput(entry.args);
      const order: string[] = [];
      let received = "";
      const dependencies = successfulDependencies(order);
      dependencies.resolvePromptSource = async () => {
        order.push("prompt");
        return { text: entry.text, byteLength: Buffer.byteLength(entry.text) };
      };
      dependencies.loadOneShotRunner = async () => {
        order.push("runner-load");
        return {
          runOneShot: async (prompt) => {
            order.push("runner");
            received = prompt;
            return 0;
          },
        };
      };

      expect(await main(state.input, dependencies)).toBe(0);
      expect(received).toBe(entry.text);
      expect(order).toEqual([
        "config-load",
        "config-resolve",
        "config-derive",
        "prompt",
        "runner-load",
        "runner",
      ]);
    }
  });

  test("loads only the TUI runner for the default command", async () => {
    const state = testInput([]);
    let tuiRuns = 0;
    let oneShotLoads = 0;
    const dependencies = successfulDependencies();
    dependencies.loadTuiRunner = async () => ({
      runTui: async () => {
        tuiRuns += 1;
      },
    });
    dependencies.loadOneShotRunner = async () => {
      oneShotLoads += 1;
      throw new Error("must not load");
    };

    expect(await main(state.input, dependencies)).toBe(0);
    expect(tuiRuns).toBe(1);
    expect(oneShotLoads).toBe(0);
  });

  test("does not load a runner after Prompt validation fails", async () => {
    const state = testInput(["run", "--stdin"]);
    let runnerLoads = 0;
    const dependencies = successfulDependencies();
    dependencies.resolvePromptSource = async () => {
      throw new PromptInputError("Prompt from standard input must not be empty.", 2);
    };
    dependencies.loadOneShotRunner = async () => {
      runnerLoads += 1;
      throw new Error("must not load");
    };

    expect(await main(state.input, dependencies)).toBe(2);
    expect(runnerLoads).toBe(0);
    expect(state.stderr.output).toBe(
      "Prompt input failed: Prompt from standard input must not be empty.\n",
    );
  });

  test("copies args, env, and cwd before the first await", async () => {
    const args = ["run", "original"];
    const env: NodeJS.ProcessEnv = { MARKER: "original" };
    const state = testInput(args, env, "/original-cwd");
    let seenArgs: readonly string[] = [];
    let seenEnv: NodeJS.ProcessEnv = {};
    let seenCwd = "";
    const dependencies = successfulDependencies();
    dependencies.loadPackageMetadata = async () => {
      args.splice(0, args.length, "--unknown");
      env.MARKER = "mutated";
      state.input.cwd = "/mutated-cwd";
      return { name: "tinker-agent", version: "1.3.0" };
    };
    dependencies.parseCommandLine = async (capturedArgs) => {
      seenArgs = capturedArgs;
      return {
        type: "command",
        command: {
          type: "run",
          promptSource: { kind: "argument", value: "original" },
        },
      };
    };
    dependencies.loadConfigBoundary = async () => ({
      resolvePublicConfig: async (input) => {
        seenEnv = input.env;
        seenCwd = input.cwd;
        return publicConfig();
      },
      deriveRunnerConfig: () => runnerConfig(),
    });

    expect(await main(state.input, dependencies)).toBe(0);
    expect(seenArgs).toEqual(["run", "original"]);
    expect(seenEnv.MARKER).toBe("original");
    expect(seenCwd).toBe("/original-cwd");
  });

  test("bounds and sanitizes unexpected errors without a stack", async () => {
    const state = testInput(["run", "hello"]);
    const dependencies = successfulDependencies();
    dependencies.parseCommandLine = async () => {
      throw new Error(`boom\n${String.fromCharCode(27)}[31m${"x".repeat(900)}`);
    };

    expect(await main(state.input, dependencies)).toBe(1);
    expect(state.stderr.output).toStartWith("Tinker failed unexpectedly: boom\\n");
    expect(state.stderr.output).not.toContain(String.fromCharCode(27));
    expect(state.stderr.output).not.toContain("cli-main.test.ts");
    expect(Buffer.byteLength(state.stderr.output)).toBeLessThan(560);
    expect(state.stderr.output).toContain("...[truncated]");
  });

  test("waits for output backpressure before returning", async () => {
    let drained = false;
    const writer = {
      output: "",
      write(chunk: string) {
        this.output += chunk;
        queueMicrotask(() => {
          drained = true;
          this.listener?.();
        });
        return false;
      },
      listener: undefined as (() => void) | undefined,
      once(_event: "drain", listener: () => void) {
        this.listener = listener;
      },
    };
    const state = testInput(["--version"]);
    state.input.stdout = writer;

    expect(
      await main(state.input, {
        loadPackageMetadata: async () => ({ name: "tinker-agent", version: "1.3.0" }),
      }),
    ).toBe(0);
    expect(drained).toBe(true);
    expect(writer.output).toBe("1.3.0\n");
  });
});

function testInput(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const input = {
    args,
    stdin: Readable.from([]),
    stdout,
    stderr,
    cwd,
    env,
  } as MutableMainInput;
  return { input, stdout, stderr };
}

function successfulDependencies(order: string[] = []): MutableDependencies {
  return {
    loadPackageMetadata: async () => ({ name: "tinker-agent", version: "1.3.0" }),
    parseCommandLine: async (args, version) => {
      const { parseCommandLine } = await import("../cli/command-line");
      return parseCommandLine(args, version);
    },
    loadConfigBoundary: async () => {
      order.push("config-load");
      return {
        resolvePublicConfig: async () => {
          order.push("config-resolve");
          return publicConfig();
        },
        deriveRunnerConfig: () => {
          order.push("config-derive");
          return runnerConfig();
        },
      };
    },
    createSessionId: () => "main-session" as SessionId,
    resolvePromptSource: async (source) => {
      if (source.kind !== "argument") {
        throw new Error("Test prompt resolver requires an argument.");
      }
      return { text: source.value, byteLength: Buffer.byteLength(source.value) };
    },
    loadTuiRunner: async () => ({ runTui: async () => undefined }),
    loadOneShotRunner: async () => ({ runOneShot: async () => 0 }),
  };
}

function publicConfig(): ResolvedPublicConfig {
  return {
    mode: "env",
    tooling: DEFAULT_PUBLIC_TOOLING_CONFIG,
    template: {
      ...runnerConfig(),
      sessionId: undefined,
    },
  } as unknown as ResolvedPublicConfig;
}

function runnerConfig(): RunnerConfig {
  return {
    sessionId: "main-session" as SessionId,
    workspaceRoot: "/workspace",
    modelName: "test-model",
    apiKey: "test-key",
    apiBase: "https://api.example.test/v1",
    maxIterations: 8,
    includeReasoningContent: false,
    stream: true,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    inputModalities: Object.freeze(["text"] as const),
  };
}
