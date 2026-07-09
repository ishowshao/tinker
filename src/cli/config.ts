import path from "node:path";
import type { ModelClient } from "../model/model-client";
import { FakeModelClient } from "../model/fake-model-client";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import { createModelRefiner, type Refiner } from "../tools/web-fetch/refiner";
import { createUuidV7 } from "../ids/uuid-v7";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-v4-flash";
export const DEFAULT_MAX_STEPS = 100;
export const DEFAULT_INCLUDE_REASONING_CONTENT = false;

export const SYSTEM_PROMPT = (
  workspaceRoot: string,
): string => `You are a coding agent running in a local workspace.

Current workspace:
${workspaceRoot}

Use this path as the root for relative file paths. You may use workspace-local absolute paths when useful.

You can use tools to find, read, edit, write files, and run shell commands.
Use Glob to find files by name or path pattern.
Use Grep to search file contents. Do not use Bash with grep or rg for routine content searches.
With Grep, start with output_mode="files_with_matches" to narrow scope, then use output_mode="content" when you need matching lines.
Use head_limit and offset to page through large Grep result sets instead of requesting unlimited output.
Use Read to open specific files returned by Grep.
Use Edit to replace exact strings in files.
Use Read before Write when modifying an existing file.
Write may fail if the file was not read first or changed after it was read. If that happens, call Read again and retry with the updated content.
Use Read on the full file before Edit. Edit may fail if the file was not fully read first, changed after it was read, old_string is missing, or old_string matches multiple places without replace_all=true.
Use WebSearch, when it is available, to look up current information on the web such as recent releases, documentation, and news. Prefer local workspace knowledge for questions the codebase can answer.
Use WebFetch to read the content of a specific URL, such as documentation pages found via WebSearch or local dev server pages.
Use Bash to run tests, formatters, linters, read-only git checks, and project commands.
Prefer Read for reading files instead of using cat on large files.
Prefer Write or Edit for changing files instead of shell redirection.
Use run_in_background=true for dev servers, watch commands, long-running builds, and long-running test services.
Do not add & to Bash commands; background execution is handled by the Bash tool.
Bash output is written to outputFilePath. Use Read on outputFilePath when you need the complete output.

When you are done, respond with a concise summary of what you did.`;

export type RunnerConfig = {
  runId: string;
  workspaceRoot: string;
  modelName: string;
  maxSteps: number;
  includeReasoningContent: boolean;
};

export function readRunnerConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    runId: overrides.runId ?? createUuidV7(),
    workspaceRoot: path.resolve(
      overrides.workspaceRoot ?? process.env.TINKER_WORKSPACE ?? process.cwd(),
    ),
    modelName: overrides.modelName ?? process.env.TINKER_MODEL ?? DEFAULT_MODEL,
    maxSteps:
      overrides.maxSteps ??
      parsePositiveInteger(process.env.TINKER_MAX_STEPS, DEFAULT_MAX_STEPS),
    includeReasoningContent:
      overrides.includeReasoningContent ??
      parseBoolean(
        process.env.TINKER_INCLUDE_REASONING_CONTENT,
        DEFAULT_INCLUDE_REASONING_CONTENT,
        "TINKER_INCLUDE_REASONING_CONTENT",
      ),
  };
}

export function createModelClientFromEnv(
  modelName: string,
  options: { includeReasoningContent?: boolean } = {},
): ModelClient {
  const fakeMode = process.env.TINKER_TEST_FAKE_MODEL;
  if (fakeMode !== undefined && fakeMode !== "") {
    return new FakeModelClient(fakeMode);
  }

  const apiKey = process.env.API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error("API_KEY is required. Put it in .env or the process environment.");
  }

  return new OpenAIChatModelClient({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    includeReasoningContent:
      options.includeReasoningContent ?? DEFAULT_INCLUDE_REASONING_CONTENT,
    model: modelName,
  });
}

export function createWebFetchRefinerFromEnv(mainModelName: string): Refiner {
  return createModelRefiner({
    createModelClient: () => {
      const refineModelName = process.env.TINKER_WEBFETCH_REFINE_MODEL;
      return createModelClientFromEnv(
        refineModelName === undefined || refineModelName.trim() === ""
          ? mainModelName
          : refineModelName,
      );
    },
  });
}

export function eventLogPath(workspaceRoot: string, runId: string): string {
  return path.join(workspaceRoot, ".tinker", "runs", `${runId}.jsonl`);
}

export function observationLogPath(workspaceRoot: string, runId: string): string {
  return path.join(workspaceRoot, ".tinker", "runs", `${runId}.observations.md`);
}

export function promptHistoryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tinker", "prompt-history.jsonl");
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(
    `${name} must be one of true/false, 1/0, yes/no, or on/off; received ${value}`,
  );
}
