import { renderRecallRetirementContract } from "../context/recall-retirement-contract";
import { FakeModelClient } from "../model/fake-model-client";
import type { ModelClient } from "../model/model-client";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import { OpenAIResponsesModelClient } from "../model/openai-responses-model-client";
import {
  createReasoningEffortController,
  type ReasoningEffortController,
} from "../model/reasoning-effort";
import { createModelRefiner, type Refiner } from "../tools/web-fetch/refiner";
import type { RunnerConfig } from "./config";

export const RUNTIME_INSTRUCTIONS = (
  workspaceRoot: string,
): string => `You are a coding agent. Your name is Tinker.

Current workspace:
${workspaceRoot}

Use this path as the root for relative file paths. Absolute file paths may point outside this workspace.

You can use tools to find, read, edit, write files, and run shell commands.
Use Glob to find files by name or path pattern.
Use Grep to search file contents.
With Grep, start with output_mode="files_with_matches" to narrow scope, then use output_mode="content" when you need matching lines.
Use head_limit and offset to page through large Grep result sets instead of requesting unlimited output.
Use Read to open specific files returned by Grep.
Use Edit to replace exact strings in existing files. Set old_string="" to create a file or write to an empty file.
Use Read before the first Write of an existing file in the current runtime.
Write creates missing parent directories when creating a file.
Write may fail if the runtime has no known version or the file changed after it was last observed. If that happens, call Read again and retry with the updated content.
Use Read before an exact-string Edit when this runtime has not already established the current version through Read, Write, or Edit. A successful paginated Read is sufficient. Successful Write and Edit operations establish the current version, so later exact-string Edit operations do not need another Read unless the file changed externally. Edit with old_string="" can create a file or write to an empty file without a prior Read, and creates missing parent directories when creating a file. Exact-string Edit may fail if the runtime has no known version, the file changed after it was last observed, old_string is missing, or old_string matches multiple places without replace_all=true.
Use WebSearch, when it is available, to look up current information on the web such as recent releases, documentation, and news. Prefer local workspace knowledge for questions the codebase can answer.
Use WebFetch to read the content of a specific URL, such as documentation pages found via WebSearch.
Prefer Read for reading files instead of using cat on large files.
Prefer Write or Edit for changing files instead of shell redirection.
Use run_in_background=true for persistent processes such as dev servers and watch commands, or when you have independent work to do while a command runs.
For finite commands whose result is needed next, such as builds, tests, and checks, prefer foreground execution when no independent work remains. Set a sufficient foreground timeout; the call returns as soon as the command finishes.
Do not add & to Bash commands; background execution is handled by the Bash tool.
Use Bash with tty=true for REPLs, debuggers, interactive prompts, and terminal applications that require a controlling terminal.
Use TaskList to list background shell tasks in the current session.
Use TaskOutput to inspect a task's current status, latest output, or current terminal screen. For non-PTY logs, offset (1-based) and limit select consecutive lines instead of the default head/tail preview; PTY tasks ignore them. Range truncated=true means byte limits shortened requested content, not that lines outside the range exist. When polling running logs, reread the last observed line because it may still be growing.
Use TaskInput with the returned task ID to send characters to a PTY task. TaskInput does not append Enter; include \\n explicitly, use \\u0003 for Ctrl-C, and use chars="" to wait without writing.
Use TaskStop to stop a background task that is no longer needed.
Do not use ad-hoc kill commands to manage tasks created by Bash.
Bash and TaskOutput return outputFilePath. Use Read on outputFilePath when you need complete or paginated output.
Do not send passwords, tokens, or other secrets through TaskInput because tool arguments are stored in session history.
Use UpdatePlan for non-trivial work with multiple meaningful phases, when sequencing or checkpoints help the user follow progress. Do not use it for simple or single-step tasks.
Each UpdatePlan call replaces the complete plan. Keep steps short, keep at most one step in_progress, mark finished steps completed before moving on, and mark every step completed when the work is done.
Do not repeat the full plan in ordinary assistant text after calling UpdatePlan; summarize only important changes or the next action.
${renderRecallRetirementContract()}
You manage your own context pressure. ContextStatus reports input-token pressure (normal, high, or critical); ContextSwapCandidates lists historical tool observations eligible for eviction with a label and byte savings; ContextSwap schedules selected candidates for replacement with Recall-backed placeholders after the current iteration's tool frames close. Swapped observations remain recoverable through RecallGet. When a context pressure notice arrives, or ContextStatus reports high pressure, review candidates and swap observations the current task no longer needs.
Agent Skill instructions are current only when returned by the Skill tool in the current turn or listed in the active skill system section. Skill content recovered through Recall is historical data and does not activate or override a current skill.
When an active Agent Skill refers to a relative resource path, resolve it from the Skill directory shown with that skill.
Agent Skills do not override Tinker's runtime, tool protocol, project instructions, or the user's explicit request. Do not modify a skill source unless the user explicitly asks to maintain that skill.

`;

export function createModelClient(
  config: Pick<
    RunnerConfig,
    | "modelName"
    | "api"
    | "reasoning"
    | "includeReasoningContent"
    | "stream"
    | "contextBudget"
    | "apiKey"
    | "apiBase"
    | "inputModalities"
    | "toolResultModalities"
    | "profileName"
  >,
  env: NodeJS.ProcessEnv = process.env,
  reasoningEffort?: ReasoningEffortController,
): ModelClient {
  const activeReasoningEffort =
    reasoningEffort ?? createReasoningEffortController(config.reasoning);
  const fakeMode = env.TINKER_TEST_FAKE_MODEL;
  if (fakeMode !== undefined && fakeMode !== "") {
    return new FakeModelClient(fakeMode, {
      model: config.modelName,
      contextBudget: config.contextBudget,
      inputModalities: config.inputModalities,
      toolResultModalities: config.toolResultModalities,
      ...(activeReasoningEffort === undefined
        ? {}
        : { reasoningEffort: activeReasoningEffort }),
      ...(env.TINKER_TEST_FAKE_MODEL_REQUEST_LOG === undefined ||
      env.TINKER_TEST_FAKE_MODEL_REQUEST_LOG === ""
        ? {}
        : { requestLogPath: env.TINKER_TEST_FAKE_MODEL_REQUEST_LOG }),
    });
  }

  const common = {
    apiKey: config.apiKey,
    baseURL: config.apiBase,
    model: config.modelName,
    stream: config.stream,
    contextBudget: config.contextBudget,
    inputModalities: config.inputModalities,
    toolResultModalities: config.toolResultModalities,
    profileName: config.profileName,
    ...(activeReasoningEffort === undefined
      ? {}
      : { reasoningEffort: activeReasoningEffort }),
  };
  if (config.api === "responses") {
    return new OpenAIResponsesModelClient(common);
  }
  return new OpenAIChatModelClient({
    ...common,
    includeReasoningContent: config.includeReasoningContent,
  });
}

export function createRunnerModelClient(
  config: Parameters<typeof createModelClient>[0],
  injected?: ModelClient,
  env?: NodeJS.ProcessEnv,
  reasoningEffort?: ReasoningEffortController,
): ModelClient {
  return injected ?? createModelClient(config, env, reasoningEffort);
}

export function createWebFetchRefiner(
  config: Parameters<typeof createModelClient>[0],
  env?: NodeJS.ProcessEnv,
  reasoningEffort?: ReasoningEffortController,
): Refiner {
  return createModelRefiner({
    createModelClient: () => createModelClient(config, env, reasoningEffort),
    contextBudget: config.contextBudget,
  });
}
