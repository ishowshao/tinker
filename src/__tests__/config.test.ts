import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_ITERATIONS,
  createModelClientFromEnv,
  readRunnerConfig,
  RUNTIME_INSTRUCTIONS,
} from "../cli/config";
import { parseModelProfiles, type ModelProfiles } from "../cli/model-profiles";
import { TEST_CONTEXT_PROFILE } from "./test-runtime";

const TEST_PROFILES_JSON = JSON.stringify({
  default: "deepseek",
  profiles: {
    deepseek: {
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com/v1",
      apiKey: "sk-deepseek",
      contextWindowTokens: 256 * 1024,
      maxSupportedOutputTokens: 64 * 1024,
    },
    glm: {
      model: "glm-4.6",
      apiBase: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "sk-glm",
      contextWindowTokens: 256 * 1024,
      maxSupportedOutputTokens: 64 * 1024,
    },
  },
});

const TEST_PROFILES: ModelProfiles = parseModelProfiles(
  TEST_PROFILES_JSON,
  "/test/models.json",
);

describe("runner config", () => {
  test("requires an explicit model name", () => {
    withEnv("TINKER_MODEL", undefined, () => {
      expect(() => readRunnerConfig({ contextProfile: TEST_CONTEXT_PROFILE })).toThrow(
        "TINKER_MODEL is required",
      );
    });
  });

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

  test("allows long-running turns by default", () => {
    withEnv("TINKER_MAX_ITERATIONS", undefined, () => {
      expect(DEFAULT_MAX_ITERATIONS).toBe(512);
      expect(
        readRunnerConfig({ contextProfile: TEST_CONTEXT_PROFILE }).maxIterations,
      ).toBe(512);
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

describe("profile resolution", () => {
  test("uses the JSON default profile when no override is given", () => {
    withEnv("TINKER_MODEL", "ignored-legacy-value", () => {
      const config = readRunnerConfig({}, TEST_PROFILES);
      expect(config.modelName).toBe("deepseek-chat");
      expect(config.profileName).toBe("deepseek");
    });
  });

  test("uses the override profile name when it matches", () => {
    withEnv("TINKER_MODEL", "ignored-legacy-value", () => {
      const config = readRunnerConfig({ profileName: "glm" }, TEST_PROFILES);
      expect(config.modelName).toBe("glm-4.6");
      expect(config.profileName).toBe("glm");
    });
  });

  test("fast-fails an unknown explicit profile and lists valid names", () => {
    expect(() => readRunnerConfig({ profileName: "typo" }, TEST_PROFILES)).toThrow(
      'Unknown model profile "typo". Available profiles: deepseek, glm.',
    );
  });

  test("ignores TINKER_MODEL entirely when TINKER_MODELS is set", () => {
    withEnv("TINKER_MODEL", "glm", () => {
      const config = readRunnerConfig({}, TEST_PROFILES);
      expect(config.modelName).toBe("deepseek-chat");
      expect(config.profileName).toBe("deepseek");
    });
  });

  test("passes apiKey and apiBase from the resolved profile", () => {
    withEnv("TINKER_MODEL", undefined, () => {
      const config = readRunnerConfig({}, TEST_PROFILES);
      expect(config.apiKey).toBe("sk-deepseek");
      expect(config.apiBase).toBe("https://api.deepseek.com/v1");
    });
  });

  test("falls back to env vars when profiles is undefined", () => {
    withEnvValues(
      {
        TINKER_MODEL: "env-model",
        TINKER_CONTEXT_WINDOW_TOKENS: "1048576",
        TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: "393216",
      },
      () => {
        const config = readRunnerConfig();
        expect(config.modelName).toBe("env-model");
        expect(config.profileName).toBeUndefined();
      },
    );
  });

  test("rejects an explicit profile when profiles are not configured", () => {
    expect(() => readRunnerConfig({ profileName: "glm" })).toThrow(
      'Cannot select model profile "glm" because TINKER_MODELS is not configured.',
    );
  });
});

describe("model client config", () => {
  test("requires the Tinker API key and base URL variables", () => {
    const config = {
      modelName: "test-model",
      includeReasoningContent: false,
      contextBudget: readRunnerConfig({
        modelName: "test-model",
        contextProfile: TEST_CONTEXT_PROFILE,
      }).contextBudget,
    };

    withEnv("TINKER_API_KEY", undefined, () => {
      expect(() => createModelClientFromEnv(config)).toThrow(
        "TINKER_API_KEY is required",
      );
    });

    withEnvValues(
      {
        TINKER_API_KEY: "test-key",
        TINKER_BASE_URL: undefined,
      },
      () => {
        expect(() => createModelClientFromEnv(config)).toThrow(
          "TINKER_BASE_URL is required",
        );
      },
    );
  });
});

describe("system prompt", () => {
  test("guides content search toward Grep", () => {
    const prompt = RUNTIME_INSTRUCTIONS("/tmp/workspace");

    expect(prompt).toContain("Use Grep to search file contents.");
    expect(prompt).toContain(
      "Do not use Bash with grep or rg for routine content searches.",
    );
    expect(prompt).toContain('output_mode="files_with_matches"');
    expect(prompt).toContain("head_limit and offset");
  });

  test("keeps tool responsibility boundaries", () => {
    const prompt = RUNTIME_INSTRUCTIONS("/tmp/workspace");

    expect(prompt).toContain("Use Glob to find files by name or path pattern.");
    expect(prompt).toContain("Use Read to open specific files returned by Grep.");
    expect(prompt).toContain("Use Edit to replace exact strings in files.");
    expect(prompt).toContain("A successful paginated Read is sufficient.");
    expect(prompt).toContain("Use Bash to run tests");
    expect(prompt).toContain(
      "Use Recall to search or retrieve model-visible history from the current session.",
    );
    expect(prompt).toContain(
      "Recall results are historical snapshots, not current workspace state.",
    );
    expect(prompt).toContain(
      "Use Read and Grep to verify current files, and TaskOutput for current task output.",
    );
    expect(prompt).toContain(
      "An empty Recall search does not prove that information does not exist.",
    );
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
