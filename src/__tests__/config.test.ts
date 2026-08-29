import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createResolvedPublicConfig,
  deriveRunnerConfig,
  resolvePublicConfig,
} from "../cli/config";
import { RUNTIME_INSTRUCTIONS, createModelClient } from "../cli/runner-dependencies";
import type { SessionId } from "../ids/runtime-id";
import { parseModelProfiles, type ModelProfiles } from "../cli/model-profiles";
import {
  DEFAULT_PUBLIC_TOOLING_CONFIG,
  MEMORY_CONFIG_FIELDS,
  MODEL_PROFILE_FIELDS,
  PUBLIC_CONFIG_FIELDS,
  parsePublicEnvironment,
} from "../cli/public-config-contract";
import {
  CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
  renderRecallRetirementContract,
} from "../context/recall-retirement-contract";
const TEST_PROFILES_JSON = JSON.stringify({
  default: "deepseek",
  profiles: {
    deepseek: {
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com/v1",
      apiKey: "sk-deepseek",
      contextWindowTokens: 256 * 1024,
      maxSupportedOutputTokens: 64 * 1024,
      reasoning: {
        supportedEfforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
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

const TEST_CWD = "/test/tinker-cwd";
const TEST_SESSION_ID = "test-config-session" as SessionId;

function envMode(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TINKER_MODEL: "test-model",
    TINKER_BASE_URL: "https://api.example.test/v1",
    TINKER_API_KEY: "test-key",
    TINKER_CONTEXT_WINDOW_TOKENS: String(256 * 1_024),
    TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: String(64 * 1_024),
    ...overrides,
  };
}

describe("public config contract", () => {
  test("declares secrets and behavior-affecting defaults once", () => {
    expect(
      PUBLIC_CONFIG_FIELDS.filter((field) => field.secret).map((field) => field.name),
    ).toEqual(["TINKER_API_KEY", "EXA_API_KEY"]);
    expect(DEFAULT_PUBLIC_TOOLING_CONFIG).toMatchObject({
      mcpTimeoutMs: 60_000,
      mcpMaxObservationChars: 40_000,
      bashDefaultTimeoutMs: 5_000,
      bashMaxTimeoutMs: 600_000,
      grepTimeoutMs: 20_000,
      grepMaxBufferBytes: 20_000_000,
      webFetchRefineThreshold: 2_000,
    });
    expect(
      MODEL_PROFILE_FIELDS.find((field) => field.name === "stream")?.defaultValue,
    ).toBe(true);
    expect(
      MODEL_PROFILE_FIELDS.find((field) => field.name === "api")?.defaultValue,
    ).toBe("chat-completions");
    expect(
      MEMORY_CONFIG_FIELDS.filter((field) => field.secret).map((field) => field.name),
    ).toEqual(["embedding"]);
  });
});

describe("public environment parser", () => {
  test("requires every env-mode model field", () => {
    for (const name of [
      "TINKER_MODEL",
      "TINKER_BASE_URL",
      "TINKER_API_KEY",
      "TINKER_CONTEXT_WINDOW_TOKENS",
      "TINKER_MAX_SUPPORTED_OUTPUT_TOKENS",
    ]) {
      const env = envMode();
      delete env[name];
      expect(() => parsePublicEnvironment(env, TEST_CWD)).toThrow(name);
    }
  });

  test("resolves defaults, workspace paths, and the model budget", () => {
    const environment = parsePublicEnvironment(
      envMode({ TINKER_WORKSPACE: "workspace" }),
      TEST_CWD,
    );
    expect(environment).toMatchObject({
      mode: "env",
      workspaceRoot: path.join(TEST_CWD, "workspace"),
      maxIterations: 512,
      modelName: "test-model",
      api: "chat-completions",
      includeReasoningContent: false,
      stream: true,
      tooling: DEFAULT_PUBLIC_TOOLING_CONFIG,
      bashGuardMode: "guard",
      bashGuardSource: "default",
    });
    const config = deriveRunnerConfig(createResolvedPublicConfig(environment), {
      sessionId: TEST_SESSION_ID,
    });
    expect(config.contextBudget).toMatchObject({
      requestMaxOutputTokens: 65_536,
      inputBudgetTokens: 196_608,
      triggerTokens: 157_286,
      triggerRatio: 0.8,
    });
  });

  test("expands a leading ~ to the home directory in path values", () => {
    const environment = parsePublicEnvironment(
      envMode({ TINKER_WORKSPACE: "~/workspaces/demo" }),
      TEST_CWD,
    );
    expect(environment.workspaceRoot).toBe(path.join(os.homedir(), "workspaces/demo"));

    expect(
      parsePublicEnvironment(envMode({ TINKER_WORKSPACE: "~" }), TEST_CWD)
        .workspaceRoot,
    ).toBe(os.homedir());

    const profile = parsePublicEnvironment(
      { TINKER_MODELS: "~/.tinker/models.json" },
      TEST_CWD,
    );
    expect(profile.mode).toBe("profile");
    if (profile.mode !== "profile") {
      throw new Error("Expected profile mode.");
    }
    expect(profile.modelsPath).toBe(path.join(os.homedir(), ".tinker/models.json"));

    const relative = parsePublicEnvironment(
      envMode({ TINKER_WORKSPACE: "workspaces/demo" }),
      TEST_CWD,
    );
    expect(relative.workspaceRoot).toBe(path.join(TEST_CWD, "workspaces/demo"));
  });

  test("selects and validates the env-mode model API", () => {
    const environment = parsePublicEnvironment(
      envMode({ TINKER_API: "responses" }),
      TEST_CWD,
    );
    expect(environment.mode === "env" && environment.api).toBe("responses");

    expect(() =>
      parsePublicEnvironment(envMode({ TINKER_API: "vendor-magic" }), TEST_CWD),
    ).toThrow('"chat-completions", "responses"');
  });

  test("accepts every documented boolean alias case-insensitively", () => {
    for (const value of ["true", "1", "yes", "on", "TRUE", "On"]) {
      const environment = parsePublicEnvironment(
        envMode({ TINKER_INCLUDE_REASONING_CONTENT: value }),
        TEST_CWD,
      );
      expect(environment.mode === "env" && environment.includeReasoningContent).toBe(
        true,
      );
    }
    for (const value of ["false", "0", "no", "off", "FALSE", "Off"]) {
      const environment = parsePublicEnvironment(
        envMode({ TINKER_STREAM: value }),
        TEST_CWD,
      );
      expect(environment.mode === "env" && environment.stream).toBe(false);
    }
    expect(() =>
      parsePublicEnvironment(envMode({ TINKER_STREAM: "maybe" }), TEST_CWD),
    ).toThrow("TINKER_STREAM must be one of");
  });

  test("resolves TINKER_YOLO and lets the one-shot flag take priority", () => {
    const environment = parsePublicEnvironment(
      envMode({ TINKER_YOLO: "on" }),
      TEST_CWD,
    );
    expect(environment).toMatchObject({
      bashGuardMode: "yolo",
      bashGuardSource: "environment",
    });
    const resolved = createResolvedPublicConfig(environment);
    expect(
      deriveRunnerConfig(resolved, {
        sessionId: TEST_SESSION_ID,
      }),
    ).toMatchObject({
      bashGuardMode: "yolo",
      bashGuardSource: "environment",
    });

    const guarded = createResolvedPublicConfig(
      parsePublicEnvironment(envMode({ TINKER_YOLO: "off" }), TEST_CWD),
    );
    expect(
      deriveRunnerConfig(guarded, {
        sessionId: TEST_SESSION_ID,
        yolo: true,
      }),
    ).toMatchObject({
      bashGuardMode: "yolo",
      bashGuardSource: "cli",
    });
    expect(() =>
      parsePublicEnvironment(envMode({ TINKER_YOLO: "sometimes" }), TEST_CWD),
    ).toThrow("TINKER_YOLO");
  });

  test("fast-fails every invalid public positive integer", () => {
    for (const name of [
      "TINKER_CONTEXT_WINDOW_TOKENS",
      "TINKER_MAX_SUPPORTED_OUTPUT_TOKENS",
      "TINKER_MAX_ITERATIONS",
      "TINKER_MCP_TIMEOUT_MS",
      "TINKER_MCP_MAX_OBSERVATION_CHARS",
      "TINKER_BASH_DEFAULT_TIMEOUT_MS",
      "TINKER_BASH_MAX_TIMEOUT_MS",
      "TINKER_GREP_TIMEOUT_MS",
      "TINKER_GREP_MAX_BUFFER_BYTES",
      "TINKER_WEBFETCH_REFINE_THRESHOLD",
    ]) {
      for (const invalid of ["0", "-1", "1.5", "1e3", "not-a-number"]) {
        expect(() =>
          parsePublicEnvironment(envMode({ [name]: invalid }), TEST_CWD),
        ).toThrow(name);
      }
    }
  });

  test("validates cross-field relationships before runner creation", () => {
    const incompatibleContext = parsePublicEnvironment(
      envMode({
        TINKER_CONTEXT_WINDOW_TOKENS: "100",
        TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: "101",
      }),
      TEST_CWD,
    );
    expect(() => createResolvedPublicConfig(incompatibleContext)).toThrow(
      "maxSupportedOutputTokens must not exceed contextWindowTokens",
    );
    expect(() =>
      parsePublicEnvironment(
        envMode({
          TINKER_BASH_DEFAULT_TIMEOUT_MS: "5001",
          TINKER_BASH_MAX_TIMEOUT_MS: "5000",
        }),
        TEST_CWD,
      ),
    ).toThrow(
      "TINKER_BASH_DEFAULT_TIMEOUT_MS must not exceed TINKER_BASH_MAX_TIMEOUT_MS",
    );
    expect(() =>
      parsePublicEnvironment(
        envMode({ TINKER_WEBFETCH_REFINE_MODEL: "other-model" }),
        TEST_CWD,
      ),
    ).toThrow("TINKER_WEBFETCH_REFINE_MODEL must match TINKER_MODEL");
  });

  test("parses all tooling overrides once", () => {
    const environment = parsePublicEnvironment(
      envMode({
        EXA_API_KEY: "exa-key",
        TINKER_MCP_TIMEOUT_MS: "1",
        TINKER_MCP_MAX_OBSERVATION_CHARS: "2",
        TINKER_BASH_DEFAULT_TIMEOUT_MS: "3",
        TINKER_BASH_MAX_TIMEOUT_MS: "4",
        TINKER_GREP_TIMEOUT_MS: "5",
        TINKER_GREP_MAX_BUFFER_BYTES: "6",
        TINKER_WEBFETCH_REFINE_THRESHOLD: "7",
        TINKER_RIPGREP_PATH: "/diagnostic/rg",
      }),
      TEST_CWD,
    );
    expect(environment.tooling).toEqual({
      exaApiKey: "exa-key",
      mcpTimeoutMs: 1,
      mcpMaxObservationChars: 2,
      bashDefaultTimeoutMs: 3,
      bashMaxTimeoutMs: 4,
      grepTimeoutMs: 5,
      grepMaxBufferBytes: 6,
      webFetchRefineThreshold: 7,
      ripgrepPath: "/diagnostic/rg",
    });
  });
});

describe("model client composition", () => {
  test("selects the configured OpenAI API adapter", () => {
    const responsesConfig = deriveRunnerConfig(
      createResolvedPublicConfig(
        parsePublicEnvironment(
          envMode({
            TINKER_API: "responses",
            TINKER_INCLUDE_REASONING_CONTENT: "true",
          }),
          TEST_CWD,
        ),
      ),
      { sessionId: TEST_SESSION_ID },
    );
    const chatConfig = deriveRunnerConfig(
      createResolvedPublicConfig(parsePublicEnvironment(envMode(), TEST_CWD)),
      { sessionId: TEST_SESSION_ID },
    );

    expect(createModelClient(responsesConfig, {}).messageProtocol.adapter).toBe(
      "openai-responses",
    );
    expect(responsesConfig.includeReasoningContent).toBe(false);
    expect(createModelClient(chatConfig, {}).messageProtocol.adapter).toBe(
      "openai-chat",
    );
  });
});

describe("profile resolution", () => {
  function profileEnvironment(overrides: NodeJS.ProcessEnv = {}) {
    return parsePublicEnvironment(
      {
        TINKER_MODELS: "config/models.json",
        TINKER_MODEL: "ignored",
        TINKER_STREAM: "invalid-but-inapplicable",
        ...overrides,
      },
      TEST_CWD,
    );
  }

  test("uses the JSON default and creates named configs without rereading env", () => {
    const resolved = createResolvedPublicConfig(profileEnvironment(), TEST_PROFILES);
    expect(deriveRunnerConfig(resolved, { sessionId: TEST_SESSION_ID })).toMatchObject({
      modelName: "deepseek-chat",
      profileName: "deepseek",
      apiKey: "sk-deepseek",
      apiBase: "https://api.deepseek.com/v1",
      stream: true,
      reasoning: {
        supportedEfforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
    });
    expect(
      deriveRunnerConfig(resolved, {
        sessionId: TEST_SESSION_ID,
        profileName: "glm",
      }),
    ).toMatchObject({ modelName: "glm-4.6", profileName: "glm" });
    expect(resolved).not.toHaveProperty("sessionId");
  });

  test("pre-resolves one fixed memory extraction profile and embedding profile", () => {
    const profiles = parseModelProfiles(
      JSON.stringify({
        ...JSON.parse(TEST_PROFILES_JSON),
        memory: {
          profile: "glm",
          embedding: {
            name: "global-memory-v1",
            kind: "openai-compatible",
            model: "embedding-3",
            apiBase: "https://embedding.example.test/v1",
            apiKey: "embedding-key",
            dimensions: 2_048,
          },
        },
      }),
      "/test/models.json",
    );
    const resolved = createResolvedPublicConfig(profileEnvironment(), profiles);
    expect(resolved.mode).toBe("profile");
    if (resolved.mode !== "profile") {
      throw new Error("Expected profile mode.");
    }
    expect(resolved.memory).toMatchObject({
      profile: {
        name: "glm",
        model: "glm-4.6",
      },
      embedding: {
        name: "global-memory-v1",
        dimensions: 2_048,
      },
    });
    expect(resolved.memory?.contextBudget).toEqual(
      deriveRunnerConfig(resolved, {
        sessionId: TEST_SESSION_ID,
        profileName: "glm",
      }).contextBudget,
    );
  });

  test("fast-fails invalid mode/profile combinations", () => {
    expect(() =>
      deriveRunnerConfig(
        createResolvedPublicConfig(profileEnvironment(), TEST_PROFILES),
        { sessionId: TEST_SESSION_ID, profileName: "typo" },
      ),
    ).toThrow('Unknown model profile "typo". Available profiles: deepseek, glm.');
    expect(() =>
      deriveRunnerConfig(
        createResolvedPublicConfig(parsePublicEnvironment(envMode(), TEST_CWD)),
        { sessionId: TEST_SESSION_ID, profileName: "glm" },
      ),
    ).toThrow('Cannot select model profile "glm"');
  });

  test("pre-resolves every profile before handing config to a runner", () => {
    const profiles = parseModelProfiles(
      JSON.stringify({
        default: "valid",
        profiles: {
          valid: {
            model: "valid-model",
            apiBase: "https://valid.example/v1",
            apiKey: "valid-key",
            contextWindowTokens: 256 * 1_024,
            maxSupportedOutputTokens: 64 * 1_024,
          },
          unusable: {
            model: "unusable-model",
            apiBase: "https://unusable.example/v1",
            apiKey: "unusable-key",
            contextWindowTokens: 1,
            maxSupportedOutputTokens: 1,
          },
        },
      }),
      "/test/models.json",
    );
    expect(() => createResolvedPublicConfig(profileEnvironment(), profiles)).toThrow(
      "Derived requestMaxOutputTokens must be smaller than contextWindowTokens",
    );
  });

  test("composition-root resolution loads the configured profile file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-config-root-"));
    const configPath = path.join(directory, "models.json");
    try {
      await writeFile(configPath, TEST_PROFILES_JSON);
      const resolved = await resolvePublicConfig({
        cwd: directory,
        env: {
          TINKER_MODELS: "models.json",
          TINKER_WORKSPACE: ".",
        },
      });
      expect(
        deriveRunnerConfig(resolved, {
          sessionId: TEST_SESSION_ID,
          profileName: "glm",
        }),
      ).toMatchObject({
        workspaceRoot: directory,
        modelName: "glm-4.6",
        profileName: "glm",
      });
      expect(resolved.mode).toBe("profile");
      if (resolved.mode !== "profile") {
        throw new Error("Expected profile mode.");
      }
      expect(resolved.profiles.profiles.size).toBe(2);
      expect(resolved.persistDefaultProfile).toBeFunction();

      await resolved.persistDefaultProfile("glm");
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        default: "glm",
      });
      expect(
        deriveRunnerConfig(resolved, { sessionId: TEST_SESSION_ID }),
      ).toMatchObject({ modelName: "deepseek-chat", profileName: "deepseek" });

      await writeFile(
        configPath,
        TEST_PROFILES_JSON.replace("glm-4.6", "externally-mutated-model"),
      );
      expect(
        deriveRunnerConfig(resolved, {
          sessionId: TEST_SESSION_ID,
          profileName: "glm",
        }),
      ).toMatchObject({ modelName: "glm-4.6", profileName: "glm" });
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});

describe("system prompt", () => {
  test("guides content search toward Grep", () => {
    const prompt = RUNTIME_INSTRUCTIONS("/tmp/workspace");

    expect(prompt).toContain("Use Grep to search file contents.");
    expect(prompt).toContain('output_mode="files_with_matches"');
    expect(prompt).toContain("head_limit and offset");
  });

  test("keeps tool responsibility boundaries", () => {
    const prompt = RUNTIME_INSTRUCTIONS("/tmp/workspace");

    expect(prompt).toContain("Use Glob to find files by name or path pattern.");
    expect(prompt).toContain("Use Read to open specific files returned by Grep.");
    expect(prompt).toContain("Use Edit to replace exact strings in existing files.");
    expect(prompt).toContain(
      'Edit with old_string="" can create a file or write to an empty file without a prior Read',
    );
    expect(prompt).toContain(
      "Write creates missing parent directories when creating a file.",
    );
    expect(prompt).toContain("A successful paginated Read is sufficient.");
    expect(prompt).toContain(
      "Successful Write and Edit operations establish the current version",
    );
    expect(prompt).toContain("Use Bash with tty=true");
    expect(prompt).toContain("include \\n explicitly");
    expect(prompt).toContain("Use UpdatePlan for non-trivial work");
    expect(prompt).toContain("Each UpdatePlan call replaces the complete plan");
    expect(prompt).toContain("keep at most one step in_progress");
    expect(prompt).toContain("use \\u0003 for Ctrl-C");
    expect(prompt).not.toContain("\u0003");
    expect(prompt).toContain(
      "Do not send passwords, tokens, or other secrets through TaskInput",
    );
    expect(CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION).toBe("recall-retirement-v2");
    expect(prompt).toContain(renderRecallRetirementContract());
    expect(prompt).toContain("use RecallSearch and then RecallGet");
    expect(prompt).toContain("Recall is historical session state");
    expect(prompt).toContain(
      "An empty RecallSearch does not prove that information does not exist.",
    );
  });
});
