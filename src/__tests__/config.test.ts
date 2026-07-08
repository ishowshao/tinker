import { describe, expect, test } from "bun:test";
import { readRunnerConfig } from "../cli/config";

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
