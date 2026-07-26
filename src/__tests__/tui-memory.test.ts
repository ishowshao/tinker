import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolvedPublicConfig } from "../cli/config";
import { parseModelProfiles } from "../cli/model-profiles";
import { parsePublicEnvironment } from "../cli/public-config-contract";
import { initializeTuiMemory } from "../cli/tui-memory";
import { MemoryError } from "../memory/contracts";
import { MemoryStore, resolveMemoryPaths } from "../memory/memory-store";

describe("TUI memory initialization", () => {
  test("keeps memory silently disabled when the top-level config is absent", async () => {
    const homeRoot = await mkdtemp(path.join(os.tmpdir(), "tinker-tui-memory-"));
    let coordinatorCreations = 0;
    try {
      const result = await initializeTuiMemory({
        env: {},
        paths: resolveMemoryPaths(homeRoot),
        createCoordinator: async () => {
          coordinatorCreations += 1;
          throw new Error("must not be called");
        },
      });
      expect(result).toEqual({});
      expect(coordinatorCreations).toBe(0);
    } finally {
      await rm(homeRoot, { recursive: true });
    }
  });

  test("enables one coordinator for valid profile configuration", async () => {
    const homeRoot = await mkdtemp(path.join(os.tmpdir(), "tinker-tui-memory-"));
    try {
      const result = await initializeTuiMemory({
        config: resolvedMemoryConfig(),
        env: { TINKER_TEST_FAKE_MODEL: "memory-extraction-test" },
        paths: resolveMemoryPaths(homeRoot),
      });
      expect(result.coordinator).toBeDefined();
      expect(result.notice).toBeUndefined();
      result.coordinator?.dispose();
    } finally {
      await rm(homeRoot, { recursive: true });
    }
  });

  test("degrades to one local notice and one init diagnostic without a coordinator", async () => {
    const homeRoot = await mkdtemp(path.join(os.tmpdir(), "tinker-tui-memory-"));
    const paths = resolveMemoryPaths(homeRoot);
    let attempts = 0;
    try {
      const result = await initializeTuiMemory({
        config: resolvedMemoryConfig(),
        env: {},
        paths,
        createCoordinator: async () => {
          attempts += 1;
          throw new MemoryError("memory_schema_invalid", "test schema is incompatible");
        },
      });

      expect(attempts).toBe(1);
      expect(result.coordinator).toBeUndefined();
      expect(result.notice).toBe("memory disabled: test schema is incompatible");
      const diagnostics = (await readFile(paths.log, "utf8"))
        .trim()
        .split("\n")
        .map(parseJsonRecord);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        kind: "init",
        outcome: "failed",
        reason: "memory_schema_invalid",
      });
      expect(typeof diagnostics[0]?.at).toBe("string");
    } finally {
      await rm(homeRoot, { recursive: true });
    }
  });

  test("disables memory on embedding identity mismatch without changing stored data", async () => {
    const homeRoot = await mkdtemp(path.join(os.tmpdir(), "tinker-tui-memory-"));
    const paths = resolveMemoryPaths(homeRoot);
    const config = resolvedMemoryConfig();
    try {
      const initialized = await MemoryStore.open({
        paths,
        embedding: config.embedding,
      });
      initialized.close();
      const result = await initializeTuiMemory({
        config: {
          ...config,
          embedding: {
            ...config.embedding,
            name: "other-space",
          },
        },
        env: { TINKER_TEST_FAKE_MODEL: "memory-extraction-test" },
        paths,
      });

      expect(result.coordinator).toBeUndefined();
      expect(result.notice).toContain("memory disabled:");
      expect(result.notice).toContain("does not match");
      const reopened = await MemoryStore.open({
        paths,
        embedding: config.embedding,
      });
      expect(reopened.count()).toBe(0);
      reopened.close();
    } finally {
      await rm(homeRoot, { recursive: true });
    }
  });

  test("disables memory without repairing unsafe database permissions", async () => {
    const homeRoot = await mkdtemp(path.join(os.tmpdir(), "tinker-tui-memory-"));
    const paths = resolveMemoryPaths(homeRoot);
    const config = resolvedMemoryConfig();
    try {
      const initialized = await MemoryStore.open({
        paths,
        embedding: config.embedding,
      });
      initialized.close();
      await chmod(paths.database, 0o644);

      const result = await initializeTuiMemory({
        config,
        env: { TINKER_TEST_FAKE_MODEL: "memory-extraction-test" },
        paths,
      });

      expect(result.coordinator).toBeUndefined();
      expect(result.notice).toContain("memory disabled:");
      expect((await stat(paths.database)).mode & 0o777).toBe(0o644);
    } finally {
      await rm(homeRoot, { recursive: true });
    }
  });
});

function resolvedMemoryConfig() {
  const profiles = parseModelProfiles(
    JSON.stringify({
      default: "work",
      profiles: {
        work: {
          model: "work-model",
          apiBase: "https://work.example.test/v1",
          apiKey: "work-key",
          contextWindowTokens: 128_000,
          maxSupportedOutputTokens: 8_192,
        },
        memory: {
          model: "memory-model",
          apiBase: "https://memory.example.test/v1",
          apiKey: "memory-key",
          contextWindowTokens: 64_000,
          maxSupportedOutputTokens: 4_096,
        },
      },
      memory: {
        profile: "memory",
        embedding: {
          name: "global-memory-v1",
          kind: "openai-compatible",
          model: "embedding-3",
          apiBase: "https://embedding.example.test/v1",
          apiKey: "embedding-key",
          dimensions: 3,
        },
      },
    }),
    "/test/models.json",
  );
  const environment = parsePublicEnvironment(
    {
      TINKER_MODELS: "/test/models.json",
      TINKER_WORKSPACE: "/test/workspace",
    },
    "/test",
  );
  const resolved = createResolvedPublicConfig(environment, profiles);
  if (resolved.mode !== "profile" || resolved.memory === undefined) {
    throw new Error("Expected resolved memory configuration.");
  }
  return resolved.memory;
}

function parseJsonRecord(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}
