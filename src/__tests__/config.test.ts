import { describe, expect, test } from "bun:test";
import { readRunnerConfig, SYSTEM_PROMPT } from "../cli/config";

describe("runner config", () => {
  test("does not include reasoning content by default", () => {
    withEnv("TINKER_INCLUDE_REASONING_CONTENT", undefined, () => {
      expect(readRunnerConfig().includeReasoningContent).toBe(false);
    });
  });

  test("enables reasoning content with env flag", () => {
    withEnv("TINKER_INCLUDE_REASONING_CONTENT", "true", () => {
      expect(readRunnerConfig().includeReasoningContent).toBe(true);
    });
  });

  test("rejects invalid reasoning content env flag", () => {
    withEnv("TINKER_INCLUDE_REASONING_CONTENT", "maybe", () => {
      expect(() => readRunnerConfig()).toThrow(
        "TINKER_INCLUDE_REASONING_CONTENT must be one of",
      );
    });
  });

  test("reads max iterations from the new environment variable", () => {
    withEnv("TINKER_MAX_ITERATIONS", "7", () => {
      expect(readRunnerConfig().maxIterations).toBe(7);
    });
  });

  test("fast-fails an invalid max iterations value", () => {
    withEnv("TINKER_MAX_ITERATIONS", "0", () => {
      expect(() => readRunnerConfig()).toThrow(
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
