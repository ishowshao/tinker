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
      apiBase: "https://api.deepseek.com/v1",
      apiKey: "sk-deepseek",
      contextWindowTokens: 128000,
      maxSupportedOutputTokens: 8192,
      includeReasoningContent: false,
    });

    const gpt4o = result.profiles.get("gpt-4o");
    expect(gpt4o).toMatchObject({
      name: "gpt-4o",
      model: "gpt-4o",
      includeReasoningContent: true,
    });
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
    const error = await loadModelProfiles({ TINKER_MODELS: missingPath }).catch(
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
      await persistDefaultProfile("gpt-4o", { TINKER_MODELS: configPath });
      const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
        default: string;
      };
      expect(persisted.default).toBe("gpt-4o");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("rejects persisting an unknown default profile", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-models-"));
    const configPath = path.join(directory, "models.json");
    try {
      await writeFile(configPath, VALID_JSON, { mode: 0o600 });
      const error = await persistDefaultProfile("typo", {
        TINKER_MODELS: configPath,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Available profiles: deepseek, gpt-4o",
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
