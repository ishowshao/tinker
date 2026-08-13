import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadModelProfiles,
  parseModelProfiles,
  persistDefaultProfile,
  profileToContextProfile,
  resolveModelProfile,
  resolveSessionProfileName,
  type ModelProfiles,
} from "../cli/model-profiles";

const VALID_JSON = JSON.stringify({
  default: "deepseek",
  profiles: {
    deepseek: {
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com/v1",
      apiKey: "sk-deepseek",
      contextWindowTokens: 128000,
      maxSupportedOutputTokens: 8192,
    },
    "gpt-4o": {
      model: "gpt-4o",
      apiBase: "https://api.openai.com/v1",
      apiKey: "sk-openai",
      contextWindowTokens: 128000,
      maxSupportedOutputTokens: 16384,
      includeReasoningContent: true,
    },
  },
});

describe("parseModelProfiles", () => {
  test("parses valid profiles with default and named entries", () => {
    const result = parseModelProfiles(VALID_JSON, "/test/models.json");
    expect(result.defaultProfile).toBe("deepseek");
    expect(result.profiles.size).toBe(2);

    const deepseek = result.profiles.get("deepseek");
    expect(deepseek).toMatchObject({
      name: "deepseek",
      model: "deepseek-chat",
      api: "chat-completions",
      apiBase: "https://api.deepseek.com/v1",
      apiKey: "sk-deepseek",
      contextWindowTokens: 128000,
      maxSupportedOutputTokens: 8192,
      includeReasoningContent: false,
      stream: true,
      inputModalities: ["text"],
    });

    const gpt4o = result.profiles.get("gpt-4o");
    expect(gpt4o).toMatchObject({
      name: "gpt-4o",
      model: "gpt-4o",
      includeReasoningContent: true,
    });
  });

  test("selects the Responses adapter explicitly", () => {
    const json = JSON.parse(VALID_JSON) as {
      profiles: { deepseek: { api?: string } };
    };
    json.profiles.deepseek.api = "responses";
    const result = parseModelProfiles(JSON.stringify(json), "/test/models.json");

    expect(result.profiles.get("deepseek")?.api).toBe("responses");
  });

  test("parses a provider-specific reasoning effort contract", () => {
    const result = parseModelProfiles(
      profileJson({
        reasoning: {
          supportedEfforts: ["minimal", "balanced", "deep"],
          defaultEffort: "balanced",
        },
      }),
      "/test/models.json",
    );

    const reasoning = result.profiles.get("test")?.reasoning;
    expect(reasoning).toEqual({
      supportedEfforts: ["minimal", "balanced", "deep"],
      defaultEffort: "balanced",
    });
    expect(Object.isFrozen(reasoning)).toBe(true);
    expect(Object.isFrozen(reasoning?.supportedEfforts)).toBe(true);
  });

  test("strictly validates the reasoning effort contract", () => {
    for (const reasoning of [
      null,
      {},
      { supportedEfforts: [], defaultEffort: "medium" },
      { supportedEfforts: ["low", "low"], defaultEffort: "low" },
      { supportedEfforts: ["low effort"], defaultEffort: "low effort" },
      { supportedEfforts: [" low"], defaultEffort: " low" },
      { supportedEfforts: ["reset"], defaultEffort: "reset" },
      { supportedEfforts: ["low", "high"], defaultEffort: "medium" },
      { supportedEfforts: ["low"], defaultEffort: "low", extra: true },
    ]) {
      expect(() =>
        parseModelProfiles(profileJson({ reasoning }), "/test/models.json"),
      ).toThrow();
    }
  });

  test("rejects unknown model APIs", () => {
    const json = JSON.parse(VALID_JSON) as {
      profiles: { deepseek: { api?: string } };
    };
    json.profiles.deepseek.api = "vendor-magic";

    expect(() => parseModelProfiles(JSON.stringify(json), "/test/models.json")).toThrow(
      '"chat-completions", "responses"',
    );
  });

  test("strictly parses the optional atomic-memory configuration", () => {
    const result = parseModelProfiles(memoryJson(), "/test/models.json");
    expect(result.memory).toEqual({
      profile: "deepseek",
      embedding: {
        name: "global-memory-v1",
        kind: "openai-compatible",
        model: "embedding-3",
        apiBase: "https://embedding.example.test/v1",
        apiKey: "embedding-key",
        dimensions: 2_048,
      },
    });
  });

  test("rejects incomplete, unknown, and invalid memory configuration", () => {
    for (const memory of [
      null,
      {},
      { profile: "deepseek" },
      { embedding: validMemoryEmbedding() },
      {
        profile: "missing",
        embedding: validMemoryEmbedding(),
      },
      {
        profile: "deepseek",
        embedding: { ...validMemoryEmbedding(), kind: "custom" },
      },
      {
        profile: "deepseek",
        embedding: { ...validMemoryEmbedding(), apiBase: "not a URL" },
      },
      {
        profile: "deepseek",
        embedding: { ...validMemoryEmbedding(), dimensions: 0 },
      },
      {
        profile: "deepseek",
        embedding: { ...validMemoryEmbedding(), extra: true },
      },
      {
        profile: "deepseek",
        embedding: validMemoryEmbedding(),
        extra: true,
      },
    ]) {
      expect(() =>
        parseModelProfiles(
          JSON.stringify({
            ...JSON.parse(VALID_JSON),
            memory,
          }),
          "/test/models.json",
        ),
      ).toThrow();
    }
  });

  test("rejects invalid JSON", () => {
    expect(() => parseModelProfiles("{ not json", "/test/models.json")).toThrow(
      "Invalid JSON",
    );
  });

  test("rejects a non-object root", () => {
    expect(() => parseModelProfiles("[]", "/test/models.json")).toThrow(
      "must be a JSON object",
    );
  });

  test("rejects unknown top-level and estimator fields", () => {
    expect(() =>
      parseModelProfiles(
        JSON.stringify({
          ...JSON.parse(VALID_JSON),
          unexpected: true,
        }),
        "/test/models.json",
      ),
    ).toThrow('unknown field "unexpected"');
    expect(() =>
      parseModelProfiles(
        profileJson({
          inputModalities: ["text", "image"],
          tokenEstimator: {
            kind: "moonshot-estimate-token-count-v1",
            model: "kimi-k3",
            apiBase: "https://api.moonshot.test/v1",
            apiKey: "estimator-key",
            timeoutMs: 30_000,
            maxRetries: 0,
            unexpected: true,
          },
        }),
        "/test/models.json",
      ),
    ).toThrow('unknown field "unexpected"');
  });

  test("rejects a missing default field", () => {
    const json = JSON.stringify({ profiles: {} });
    expect(() => parseModelProfiles(json, "/test/models.json")).toThrow(
      'non-empty string "default"',
    );
  });

  test("rejects a default that is not in profiles", () => {
    const json = JSON.stringify({ default: "missing", profiles: {} });
    expect(() => parseModelProfiles(json, "/test/models.json")).toThrow(
      'default profile "missing" is not defined',
    );
  });

  test("rejects a missing profiles field", () => {
    const json = JSON.stringify({ default: "deepseek" });
    expect(() => parseModelProfiles(json, "/test/models.json")).toThrow(
      '"profiles" field',
    );
  });

  test("rejects a profile with a missing required field", () => {
    const json = JSON.stringify({
      default: "deepseek",
      profiles: {
        deepseek: {
          model: "deepseek-chat",
          apiBase: "https://api.deepseek.com/v1",
          contextWindowTokens: 128000,
          maxSupportedOutputTokens: 8192,
        },
      },
    });
    expect(() => parseModelProfiles(json, "/test/models.json")).toThrow(
      '"apiKey" must be a non-empty string',
    );
  });

  test("parses an explicit stream=false", () => {
    const json = JSON.stringify({
      default: "deepseek",
      profiles: {
        deepseek: {
          model: "deepseek-chat",
          apiBase: "https://api.deepseek.com/v1",
          apiKey: "sk-xxx",
          contextWindowTokens: 128000,
          maxSupportedOutputTokens: 8192,
          stream: false,
        },
      },
    });
    const result = parseModelProfiles(json, "/test/models.json");
    expect(result.profiles.get("deepseek")?.stream).toBe(false);
  });

  test("rejects a non-boolean stream flag", () => {
    const json = JSON.stringify({
      default: "deepseek",
      profiles: {
        deepseek: {
          model: "deepseek-chat",
          apiBase: "https://api.deepseek.com/v1",
          apiKey: "sk-xxx",
          contextWindowTokens: 128000,
          maxSupportedOutputTokens: 8192,
          stream: "no",
        },
      },
    });
    expect(() => parseModelProfiles(json, "/test/models.json")).toThrow(
      '"stream" must be a boolean',
    );
  });

  test("normalizes explicit image capability and its estimator contract", () => {
    const json = profileJson({
      inputModalities: ["image", "text"],
      tokenEstimator: {
        kind: "moonshot-estimate-token-count-v1",
        model: "kimi-k3",
        apiBase: "https://api.moonshot.test/v1",
        apiKey: "estimator-key",
        timeoutMs: 30_000,
        maxRetries: 0,
      },
    });

    expect(
      parseModelProfiles(json, "/test/models.json").profiles.get("test"),
    ).toMatchObject({
      inputModalities: ["text", "image"],
      tokenEstimator: {
        kind: "moonshot-estimate-token-count-v1",
        model: "kimi-k3",
        apiBase: "https://api.moonshot.test/v1",
        apiKey: "estimator-key",
        timeoutMs: 30_000,
        maxRetries: 0,
      },
    });
  });

  test("rejects invalid modality sets and image profiles without estimators", () => {
    for (const inputModalities of [
      [],
      ["text", "text"],
      ["image"],
      ["text", "audio"],
    ]) {
      expect(() =>
        parseModelProfiles(profileJson({ inputModalities }), "/test/models.json"),
      ).toThrow();
    }
    expect(() =>
      parseModelProfiles(
        profileJson({ inputModalities: ["text", "image"] }),
        "/test/models.json",
      ),
    ).toThrow('requires a complete "tokenEstimator"');
  });

  test("rejects profile-level image policy overrides and estimator retries", () => {
    expect(() =>
      parseModelProfiles(
        profileJson({ imageInput: { maxImages: 99 } }),
        "/test/models.json",
      ),
    ).toThrow('unknown field "imageInput"');
    expect(() =>
      parseModelProfiles(
        profileJson({
          inputModalities: ["text", "image"],
          tokenEstimator: {
            kind: "moonshot-estimate-token-count-v1",
            model: "kimi-k3",
            apiBase: "https://api.moonshot.test/v1",
            apiKey: "estimator-key",
            timeoutMs: 30_000,
            maxRetries: 1,
          },
        }),
        "/test/models.json",
      ),
    ).toThrow("maxRetries must be 0");
  });

  test("requires complete independent estimator routing and credentials", () => {
    const estimator = {
      kind: "moonshot-estimate-token-count-v1",
      model: "kimi-k3",
      apiBase: "https://api.moonshot.test/v1",
      apiKey: "estimator-key",
      timeoutMs: 30_000,
      maxRetries: 0,
    };
    for (const field of ["model", "apiBase", "apiKey"] as const) {
      const incomplete: Record<string, unknown> = { ...estimator };
      delete incomplete[field];
      expect(() =>
        parseModelProfiles(
          profileJson({
            inputModalities: ["text", "image"],
            tokenEstimator: incomplete,
          }),
          "/test/models.json",
        ),
      ).toThrow(field);
    }
  });

  test("rejects a profile with invalid token counts", () => {
    const json = JSON.stringify({
      default: "deepseek",
      profiles: {
        deepseek: {
          model: "deepseek-chat",
          apiBase: "https://api.deepseek.com/v1",
          apiKey: "sk-xxx",
          contextWindowTokens: 0,
          maxSupportedOutputTokens: 8192,
        },
      },
    });
    expect(() => parseModelProfiles(json, "/test/models.json")).toThrow(
      "positive integer",
    );
  });

  test("rejects a profile with an empty name", () => {
    const json = JSON.stringify({
      default: "",
      profiles: {
        "": {
          model: "deepseek-chat",
          apiBase: "https://api.deepseek.com/v1",
          apiKey: "sk-xxx",
          contextWindowTokens: 128000,
          maxSupportedOutputTokens: 8192,
        },
      },
    });
    expect(() => parseModelProfiles(json, "/test/models.json")).toThrow(
      'non-empty string "default"',
    );
  });

  test("accepts profile names with dots, hyphens, and digits", () => {
    const json = JSON.stringify({
      default: "glm-5.2",
      profiles: {
        "glm-5.2": {
          model: "glm-4.6",
          apiBase: "https://open.bigmodel.cn/api/paas/v4",
          apiKey: "sk-xxx",
          contextWindowTokens: 128000,
          maxSupportedOutputTokens: 8192,
        },
      },
    });
    const result = parseModelProfiles(json, "/test/models.json");
    expect(result.profiles.get("glm-5.2")?.model).toBe("glm-4.6");
  });

  test("rejects maxSupportedOutputTokens exceeding contextWindowTokens", () => {
    const json = JSON.stringify({
      default: "deepseek",
      profiles: {
        deepseek: {
          model: "deepseek-chat",
          apiBase: "https://api.deepseek.com/v1",
          apiKey: "sk-xxx",
          contextWindowTokens: 1000,
          maxSupportedOutputTokens: 2000,
        },
      },
    });
    expect(() => parseModelProfiles(json, "/test/models.json")).toThrow(
      "must not exceed contextWindowTokens",
    );
  });
});

function profileJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    default: "test",
    profiles: {
      test: {
        model: "kimi-k3",
        apiBase: "https://api.moonshot.test/v1",
        apiKey: "test-key",
        contextWindowTokens: 128_000,
        maxSupportedOutputTokens: 8_192,
        ...overrides,
      },
    },
  });
}

function memoryJson(): string {
  return JSON.stringify({
    ...JSON.parse(VALID_JSON),
    memory: {
      profile: "deepseek",
      embedding: validMemoryEmbedding(),
    },
  });
}

function validMemoryEmbedding() {
  return {
    name: "global-memory-v1",
    kind: "openai-compatible",
    model: "embedding-3",
    apiBase: "https://embedding.example.test/v1",
    apiKey: "embedding-key",
    dimensions: 2_048,
  };
}

describe("resolveModelProfile", () => {
  const profiles: ModelProfiles = parseModelProfiles(VALID_JSON, "/test/models.json");

  test("returns the default profile when no name is given", () => {
    const result = resolveModelProfile(profiles, undefined);
    expect(result?.name).toBe("deepseek");
  });

  test("returns the named profile", () => {
    const result = resolveModelProfile(profiles, "gpt-4o");
    expect(result?.name).toBe("gpt-4o");
  });

  test("returns undefined for an unknown profile name", () => {
    expect(resolveModelProfile(profiles, "nonexistent")).toBeUndefined();
  });

  test("returns undefined when profiles is undefined", () => {
    expect(resolveModelProfile(undefined, "deepseek")).toBeUndefined();
  });
});

describe("profileToContextProfile", () => {
  test("converts a profile to a context profile", () => {
    const profiles = parseModelProfiles(VALID_JSON, "/test/models.json");
    const profile = profiles.profiles.get("deepseek")!;
    const context = profileToContextProfile(profile);
    expect(context).toEqual({
      contextWindowTokens: 128000,
      maxSupportedOutputTokens: 8192,
    });
  });
});

describe("resolveSessionProfileName", () => {
  const profiles = parseModelProfiles(VALID_JSON, "/test/models.json");

  test("uses the stored profile identity when present", () => {
    expect(
      resolveSessionProfileName(profiles, {
        profileName: "gpt-4o",
        modelName: "ignored",
      }),
    ).toBe("gpt-4o");
  });

  test("resolves a legacy session only when its model name is unique", () => {
    expect(resolveSessionProfileName(profiles, { modelName: "deepseek-chat" })).toBe(
      "deepseek",
    );
    expect(() =>
      resolveSessionProfileName(profiles, { modelName: "missing-model" }),
    ).toThrow("does not match any configured profile");
  });

  test("rejects an ambiguous legacy model name", () => {
    const ambiguous = parseModelProfiles(
      JSON.stringify({
        default: "first",
        profiles: {
          first: {
            model: "shared-model",
            apiBase: "https://first.example/v1",
            apiKey: "first",
            contextWindowTokens: 128000,
            maxSupportedOutputTokens: 8192,
          },
          second: {
            model: "shared-model",
            apiBase: "https://second.example/v1",
            apiKey: "second",
            contextWindowTokens: 128000,
            maxSupportedOutputTokens: 8192,
          },
        },
      }),
      "/test/ambiguous-models.json",
    );
    expect(() =>
      resolveSessionProfileName(ambiguous, { modelName: "shared-model" }),
    ).toThrow("matches multiple profiles: first, second");
  });
});

describe("model profiles file", () => {
  test("fast-fails when an explicitly configured file does not exist", async () => {
    const missingPath = path.join(
      os.tmpdir(),
      `tinker-missing-models-${crypto.randomUUID()}.json`,
    );
    const error = await loadModelProfiles(missingPath).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      `Failed to read model profiles at ${missingPath}`,
    );
  });

  test("persists a validated default profile with an atomic replacement", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-models-"));
    const configPath = path.join(directory, "models.json");
    try {
      await writeFile(configPath, VALID_JSON, { mode: 0o600 });
      await persistDefaultProfile("gpt-4o", configPath);
      const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
        default: string;
      };
      expect(persisted.default).toBe("gpt-4o");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("preserves memory configuration while changing the default profile", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-models-"));
    const configPath = path.join(directory, "models.json");
    try {
      await writeFile(configPath, memoryJson(), { mode: 0o600 });
      await persistDefaultProfile("gpt-4o", configPath);
      const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
        default: string;
        memory: unknown;
      };
      expect(persisted.default).toBe("gpt-4o");
      expect(persisted.memory).toEqual({
        profile: "deepseek",
        embedding: validMemoryEmbedding(),
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("rejects persisting an unknown default profile", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-models-"));
    const configPath = path.join(directory, "models.json");
    try {
      await writeFile(configPath, VALID_JSON, { mode: 0o600 });
      const error = await persistDefaultProfile("typo", configPath).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Available profiles: deepseek, gpt-4o",
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
