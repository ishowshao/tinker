import { describe, expect, test } from "bun:test";
import { readRunnerConfig, SYSTEM_PROMPT } from "../cli/config";
import { TEST_CONTEXT_PROFILE } from "./test-runtime";

describe("runner config", () => {
  test("requires an explicit model context profile", () => {
    withEnvValues(
      {
        TINKER_CONTEXT_WINDOW_TOKENS: undefined,
        TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: undefined,
      },
      () => {
        expect(() => readRunnerConfig()).toThrow(
          "TINKER_CONTEXT_WINDOW_TOKENS is required",
        );
      },
    );
  });

  test("derives strict DeepSeek and 256K budgets", () => {
    withEnvValues(
      {
        TINKER_CONTEXT_WINDOW_TOKENS: "1048576",
        TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: "393216",
      },
      () => {
        expect(readRunnerConfig().contextBudget).toMatchObject({
          requestMaxOutputTokens: 131_072,
          inputBudgetTokens: 917_504,
          triggerTokens: 734_003,
          triggerRatio: 0.8,
        });
      },
    );

    withEnvValues(
      {
        TINKER_CONTEXT_WINDOW_TOKENS: String(256 * 1_024),
        TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: String(64 * 1_024),
      },
      () => {
        expect(readRunnerConfig().contextBudget).toMatchObject({
          requestMaxOutputTokens: 65_536,
          inputBudgetTokens: 196_608,
          triggerTokens: 157_286,
        });
      },
    );
  });

  test("fast-fails invalid profile values and incompatible limits", () => {
    for (const invalid of ["", "0", "-1", "1.5", "128K", "9007199254740992"]) {
      withEnvValues(
        {
          TINKER_CONTEXT_WINDOW_TOKENS: invalid,
          TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: "1",
        },
        () => {
          expect(() => readRunnerConfig()).toThrow("TINKER_CONTEXT_WINDOW_TOKENS");
        },
      );
    }

    withEnvValues(
      {
        TINKER_CONTEXT_WINDOW_TOKENS: "100",
        TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: "101",
      },
      () => {
        expect(() => readRunnerConfig()).toThrow(
          "maxSupportedOutputTokens must not exceed contextWindowTokens",
        );
      },
    );
  });

  test("rejects a WebFetch refiner model that differs from the main model", () => {
    withEnv("TINKER_WEBFETCH_REFINE_MODEL", "other-model", () => {
      expect(() =>
        readRunnerConfig({
          modelName: "main-model",
          contextProfile: TEST_CONTEXT_PROFILE,
        }),
      ).toThrow("TINKER_WEBFETCH_REFINE_MODEL must match TINKER_MODEL");
    });
  });

  test("does not include reasoning content by default", () => {
    withEnv("TINKER_INCLUDE_REASONING_CONTENT", undefined, () => {
      expect(
        readRunnerConfig({ contextProfile: TEST_CONTEXT_PROFILE })
          .includeReasoningContent,
      ).toBe(false);
    });
  });

  test("enables reasoning content with env flag", () => {
    withEnv("TINKER_INCLUDE_REASONING_CONTENT", "true", () => {
      expect(
        readRunnerConfig({ contextProfile: TEST_CONTEXT_PROFILE })
          .includeReasoningContent,
      ).toBe(true);
    });
  });

  test("rejects invalid reasoning content env flag", () => {
    withEnv("TINKER_INCLUDE_REASONING_CONTENT", "maybe", () => {
      expect(() => readRunnerConfig({ contextProfile: TEST_CONTEXT_PROFILE })).toThrow(
        "TINKER_INCLUDE_REASONING_CONTENT must be one of",
      );
    });
  });

  test("reads max iterations from the new environment variable", () => {
    withEnv("TINKER_MAX_ITERATIONS", "7", () => {
      expect(
        readRunnerConfig({ contextProfile: TEST_CONTEXT_PROFILE }).maxIterations,
      ).toBe(7);
    });
  });

  test("fast-fails an invalid max iterations value", () => {
    withEnv("TINKER_MAX_ITERATIONS", "0", () => {
      expect(() => readRunnerConfig({ contextProfile: TEST_CONTEXT_PROFILE })).toThrow(
        "TINKER_MAX_ITERATIONS must be a positive integer",
      );
    });
  });
});

describe("system prompt", () => {
  test("guides content search toward Grep", () => {
    const prompt = SYSTEM_PROMPT("/tmp/workspace");

    expect(prompt).toContain("Use Grep to search file contents.");
    expect(prompt).toContain(
      "Do not use Bash with grep or rg for routine content searches.",
    );
    expect(prompt).toContain('output_mode="files_with_matches"');
    expect(prompt).toContain("head_limit and offset");
  });

  test("keeps tool responsibility boundaries", () => {
    const prompt = SYSTEM_PROMPT("/tmp/workspace");

    expect(prompt).toContain("Use Glob to find files by name or path pattern.");
    expect(prompt).toContain("Use Read to open specific files returned by Grep.");
    expect(prompt).toContain("Use Edit to replace exact strings in files.");
    expect(prompt).toContain("Use Bash to run tests");
  });
});

function withEnv(name: string, value: string | undefined, callback: () => void): void {
  const previous = process.env[name];

  try {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }

    callback();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

function withEnvValues(
  values: Record<string, string | undefined>,
  callback: () => void,
): void {
  const entries = Object.entries(values);
  const previous = new Map(entries.map(([name]) => [name, process.env[name]]));
  try {
    for (const [name, value] of entries) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
