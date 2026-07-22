import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRuntimeSession,
  type RuntimeSession,
} from "../src/agent/runtime-session";
import type { AssistantMessage } from "../src/agent/types";
import {
  createModelClient,
  resolveCliConfiguration,
  RUNTIME_INSTRUCTIONS,
  type RunnerConfig,
} from "../src/cli/config";
import type { PublicToolingConfig } from "../src/cli/public-config-contract";
import type {
  ContextCompactionResult,
  ContextRetirementResult,
} from "../src/context/context-manager";
import type { EventSink } from "../src/events/event-sink";
import type { AgentEvent } from "../src/events/types";
import { buildSystemPrompt } from "../src/instructions/project-instructions";
import type {
  ModelClient,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  ModelUsage,
  PreparedModelRequest,
} from "../src/model/model-client";
import { estimatePromptSegments } from "../src/model/token-estimator";
import { stableJsonStringify, sha256 } from "../src/model/model-request-preflight";
import { renderRecallRetirementContract } from "../src/context/recall-retirement-contract";
import { RECALL_TOOL_DEFINITION } from "../src/tools/recall";
import type { RecallRawResult } from "../src/tools/types";
import {
  ACTIVE_RECALL_MANIFEST_HASH,
  ACTIVE_RECALL_MANIFEST_VERSION,
  ACTIVE_RECALL_GRADER_VERSION,
  activeRecallCases,
  gradeActiveRecallAnswer,
  type ActiveRecallCase,
  type ActiveRecallGrade,
  type ActiveRecallSuiteName,
  type ActiveRecallView,
} from "./i4-active-recall-manifest";

export const I4_ACTIVE_RECALL_FIXTURE_V1 = Object.freeze({
  version: "active-recall-long-session-fixture-v1",
  turnCount: 10,
  payloadBytes: 12 * 1_024,
} as const);
const allViews: readonly ActiveRecallView[] = Object.freeze([
  "full_history",
  "swap_only",
  "recall_only_retirement",
]);

export type I4ActiveRecallTrial = {
  readonly caseId: string;
  readonly scenario: ActiveRecallCase["scenario"];
  readonly counterfactualGroup?: string;
  readonly positive: boolean;
  readonly view: ActiveRecallView;
  readonly trial: number;
  readonly task: ActiveRecallGrade;
  readonly recall: {
    readonly callCount: number;
    readonly searchCount: number;
    readonly getCount: number;
    readonly successfulSearchCount: number;
    readonly successfulGetCount: number;
    readonly searchFoundTurnOne: boolean;
    readonly gotTurnOne: boolean;
    readonly invalidCallCount: number;
    readonly queries: readonly string[];
    readonly searchHitTurnNumbers: readonly number[];
    readonly getTurnNumbers: readonly number[];
  };
  readonly tools: {
    readonly callCount: number;
    readonly nonRecallCallCount: number;
  };
  readonly provider: {
    readonly requestCount: number;
    readonly latencyMs: number;
    readonly usage: ModelUsage;
    readonly resolvedModels: readonly string[];
  };
  readonly revision: {
    readonly swap?: Pick<ContextCompactionResult, "status" | "outcome">;
    readonly retirement?: Pick<ContextRetirementResult, "status" | "outcome"> & {
      readonly retiredTurnCount?: number;
    };
  };
  readonly payload: {
    readonly expectedHistoricalValueVisible?: boolean;
  };
};

export type I4ActiveRecallReport = {
  readonly schemaVersion: "active-recall-report-v1";
  readonly createdAt: string;
  readonly suite: ActiveRecallSuiteName;
  readonly manifestVersion: typeof ACTIVE_RECALL_MANIFEST_VERSION;
  readonly manifestHash: string;
  readonly graderVersion: typeof ACTIVE_RECALL_GRADER_VERSION;
  readonly recallContractSha256: string;
  readonly recallToolDefinitionSha256: string;
  readonly profile?: string;
  readonly model: string;
  readonly stream: boolean;
  readonly fixture: {
    readonly version: typeof I4_ACTIVE_RECALL_FIXTURE_V1.version;
    readonly turnCount: number;
    readonly payloadBytes: number;
  };
  readonly run: {
    readonly views: readonly ActiveRecallView[];
    readonly trialsPerView: number;
    readonly includeNegative: boolean;
    readonly caseIds: readonly string[];
  };
  readonly aggregate: ReturnType<typeof aggregateTrials>;
  readonly trials: readonly I4ActiveRecallTrial[];
};

export async function runI4ActiveRecallEvaluation(input: {
  profileName?: string;
  suite: ActiveRecallSuiteName;
  views?: readonly ActiveRecallView[];
  trialsPerView?: number;
  includeNegative?: boolean;
  negativeOnly?: boolean;
  caseId?: string;
}): Promise<I4ActiveRecallReport> {
  const configuration = await resolveCliConfiguration({
    ...(input.profileName === undefined ? {} : { profileName: input.profileName }),
  });
  const config = { ...configuration.initialRunnerConfig, maxIterations: 8 };
  const views = input.views ?? allViews;
  const trialsPerView = input.trialsPerView ?? 1;
  if (!Number.isSafeInteger(trialsPerView) || trialsPerView < 1) {
    throw new Error("I4 evaluation trialsPerView must be a positive integer.");
  }
  if (views.length === 0 || new Set(views).size !== views.length) {
    throw new Error("I4 evaluation views must be a non-empty unique list.");
  }
  const availableCases = activeRecallCases(input.suite, {
    includeNegative: input.includeNegative === true || input.negativeOnly === true,
  }).filter((entry) => input.negativeOnly !== true || !entry.positive);
  const cases =
    input.caseId === undefined
      ? availableCases
      : availableCases.filter((entry) => entry.id === input.caseId);
  if (cases.length === 0) {
    throw new Error(
      `I4 evaluation selected no ${input.suite} cases${
        input.caseId === undefined ? "" : ` for ${JSON.stringify(input.caseId)}`
      }.`,
    );
  }

  const trials: I4ActiveRecallTrial[] = [];
  for (const entry of cases) {
    for (const view of views) {
      for (let trial = 1; trial <= trialsPerView; trial += 1) {
        console.error(`[i4] ${entry.id} view=${view} trial=${trial}/${trialsPerView}`);
        trials.push(
          await runTrial({
            entry,
            view,
            trial,
            provider: createModelClient(config),
            config,
            tooling: configuration.tooling,
          }),
        );
      }
    }
  }

  return Object.freeze({
    schemaVersion: "active-recall-report-v1",
    createdAt: new Date().toISOString(),
    suite: input.suite,
    manifestVersion: ACTIVE_RECALL_MANIFEST_VERSION,
    manifestHash: ACTIVE_RECALL_MANIFEST_HASH,
    graderVersion: ACTIVE_RECALL_GRADER_VERSION,
    recallContractSha256: sha256(renderRecallRetirementContract()),
    recallToolDefinitionSha256: sha256(stableJsonStringify(RECALL_TOOL_DEFINITION)),
    ...(config.profileName === undefined ? {} : { profile: config.profileName }),
    model: config.modelName,
    stream: config.stream,
    fixture: {
      ...I4_ACTIVE_RECALL_FIXTURE_V1,
    },
    run: {
      views: Object.freeze([...views]),
      trialsPerView,
      includeNegative: input.includeNegative === true,
      caseIds: Object.freeze(cases.map((entry) => entry.id)),
    },
    aggregate: aggregateTrials(trials),
    trials: Object.freeze(trials),
  });
}

async function runTrial(input: {
  entry: ActiveRecallCase;
  view: ActiveRecallView;
  trial: number;
  provider: ModelClient;
  config: RunnerConfig;
  tooling: PublicToolingConfig;
}): Promise<I4ActiveRecallTrial> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-i4-recall-"));
  const recorder = new ActiveRecallRecorder();
  const model = new FixtureThenProviderModel(input.provider);
  let session: RuntimeSession | undefined;

  try {
    await writeFixtureFiles(workspace, input.entry);
    const systemPrompt = buildSystemPrompt({
      workspaceRoot: workspace,
      runtimeInstructions: RUNTIME_INSTRUCTIONS(workspace),
      projectInstructions: { workspaceRoot: workspace },
    });
    session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId: input.config.sessionId },
        workspaceRoot: workspace,
        modelName: input.config.modelName,
        ...(input.config.profileName === undefined
          ? {}
          : { profileName: input.config.profileName }),
        maxIterations: input.config.maxIterations,
        includeReasoningContent: input.config.includeReasoningContent,
        contextProfile: input.config.contextProfile,
        contextBudget: input.config.contextBudget,
        systemPrompt,
        modelClient: model,
        presentationSinks: [recorder],
        persistence: false,
        toolingConfig: input.tooling,
      },
      {
        loadMcpConfig: async () => undefined,
        selectShadowPlanning: () => undefined,
        manualCompactionTrigger: () => ({
          kind: "benchmark_forced",
          targetTokens: 1,
        }),
        manualRetirementTrigger: () => ({
          kind: "benchmark_forced",
          targetTokens: 1,
        }),
      },
    );

    for (
      let turnNumber = 1;
      turnNumber <= I4_ACTIVE_RECALL_FIXTURE_V1.turnCount;
      turnNumber += 1
    ) {
      const userPrompt =
        turnNumber === 1
          ? input.entry.earlyPrompt
          : `Synthetic long-session filler turn ${turnNumber}. Read fixture-payload.txt and confirm completion.`;
      const result = await session.executeTurn({
        userMessage: { role: "user", content: userPrompt },
        signal: new AbortController().signal,
      });
      if (result.status !== "completed") {
        throw new Error(
          `I4 fixture turn ${turnNumber} for ${input.entry.id} ended with ${result.status}.`,
        );
      }
    }

    let swap: ContextCompactionResult | undefined;
    let retirement: ContextRetirementResult | undefined;
    if (input.view !== "full_history") {
      swap = await session.compactContext();
      if (swap.status !== "compacted") {
        throw new Error(
          `I4 ${input.view} fixture did not create a swap revision: ${swap.outcome}.`,
        );
      }
    }
    if (input.view === "recall_only_retirement") {
      retirement = await session.retireContext();
      if (retirement.status !== "retired" || retirement.retiredTurnCount < 1) {
        throw new Error(
          `I4 retirement fixture did not retire a complete turn: ${retirement.outcome}.`,
        );
      }
    }

    model.enableProvider({
      expectedHistoricalValue: input.entry.expectedHistoricalValue,
    });
    recorder.beginTerminalTurn();
    const result = await session.executeTurn({
      userMessage: { role: "user", content: input.entry.terminalPrompt },
      signal: new AbortController().signal,
    });
    if (result.status !== "completed") {
      throw new Error(
        `I4 terminal turn for ${input.entry.id} ended with ${result.status}.`,
      );
    }
    const task = gradeActiveRecallAnswer(result.finalText, input.entry.oracle);
    if (!task.passed) {
      console.error(
        `[i4] ${input.entry.id} view=${input.view} grade=${task.code} output=${JSON.stringify(result.finalText.slice(0, 500))}`,
      );
    }
    const trace = recorder.snapshot();
    const provider = model.providerSummary();
    const visibility = model.expectedHistoricalValueVisible;
    if (input.entry.positive && visibility === undefined) {
      throw new Error("I4 positive trial did not inspect historical value visibility.");
    }
    if (
      input.entry.positive &&
      input.view === "recall_only_retirement" &&
      visibility !== false
    ) {
      throw new Error(
        `I4 retired provider payload still contained the historical value for ${input.entry.id}.`,
      );
    }
    if (
      input.entry.positive &&
      input.view !== "recall_only_retirement" &&
      visibility !== true
    ) {
      throw new Error(
        `I4 ${input.view} provider payload lost the historical value for ${input.entry.id}.`,
      );
    }

    return Object.freeze({
      caseId: input.entry.id,
      scenario: input.entry.scenario,
      ...(input.entry.counterfactualGroup === undefined
        ? {}
        : { counterfactualGroup: input.entry.counterfactualGroup }),
      positive: input.entry.positive,
      view: input.view,
      trial: input.trial,
      task,
      recall: trace.recall,
      tools: trace.tools,
      provider,
      revision: {
        ...(swap === undefined
          ? {}
          : { swap: { status: swap.status, outcome: swap.outcome } }),
        ...(retirement === undefined
          ? {}
          : {
              retirement: {
                status: retirement.status,
                outcome: retirement.outcome,
                ...(retirement.status === "retired"
                  ? { retiredTurnCount: retirement.retiredTurnCount }
                  : {}),
              },
            }),
      },
      payload: {
        ...(visibility === undefined
          ? {}
          : { expectedHistoricalValueVisible: visibility }),
      },
    });
  } finally {
    if (session !== undefined) {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
    }
    await rm(workspace, { recursive: true });
  }
}

class FixtureThenProviderModel implements ModelClient {
  readonly messageProtocol;
  expectedHistoricalValueVisible?: boolean;
  private readonly inputs = new WeakMap<object, ModelRequestInput>();
  private providerEnabled = false;
  private expectedHistoricalValue?: string;
  private inspectedFirstProviderPayload = false;
  private fixtureToolCallNumber = 0;
  private readonly providerRequests: Array<{
    usage: ModelUsage;
    latencyMs: number;
    resolvedModel?: string;
  }> = [];

  constructor(private readonly provider: ModelClient) {
    this.messageProtocol = provider.messageProtocol;
  }

  prepare(input: ModelRequestInput): PreparedModelRequest {
    const prepared = this.provider.prepare(input);
    this.inputs.set(prepared, {
      messages: [...input.messages],
      tools: [...input.tools],
    });
    return prepared;
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const requestInput = this.inputs.get(prepared);
    if (requestInput === undefined) {
      throw new Error("I4 request was not prepared by its model wrapper.");
    }
    if (!this.providerEnabled) {
      return this.fixtureResponse(prepared, requestInput, options);
    }
    if (!this.inspectedFirstProviderPayload) {
      this.inspectedFirstProviderPayload = true;
      if (this.expectedHistoricalValue !== undefined) {
        this.expectedHistoricalValueVisible = JSON.stringify({
          messages: requestInput.messages,
          payload: prepared.payload,
        }).includes(this.expectedHistoricalValue);
      }
    }
    const startedAt = performance.now();
    const output = await this.provider.request(prepared, options);
    this.providerRequests.push({
      usage: Object.freeze({ ...output.usage }),
      latencyMs: elapsedMs(startedAt),
      ...(resolvedModel(output.rawResponse) === undefined
        ? {}
        : { resolvedModel: resolvedModel(output.rawResponse) }),
    });
    return output;
  }

  enableProvider(input: { expectedHistoricalValue?: string }): void {
    this.providerEnabled = true;
    this.expectedHistoricalValue = input.expectedHistoricalValue;
  }

  providerSummary(): I4ActiveRecallTrial["provider"] {
    return Object.freeze({
      requestCount: this.providerRequests.length,
      latencyMs: round(
        this.providerRequests.reduce((sum, entry) => sum + entry.latencyMs, 0),
      ),
      usage: sumUsage(this.providerRequests.map((entry) => entry.usage)),
      resolvedModels: Object.freeze([
        ...new Set(this.providerRequests.flatMap((entry) => entry.resolvedModel ?? [])),
      ]),
    });
  }

  private fixtureResponse(
    prepared: PreparedModelRequest,
    input: ModelRequestInput,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    const last = input.messages.at(-1);
    let message: AssistantMessage;
    if (last?.role === "user") {
      if (options.identity === undefined) {
        throw new Error("I4 fixture model request has no runtime identity.");
      }
      this.fixtureToolCallNumber += 1;
      const { iteration, runtimeSession } = options.identity;
      message = {
        role: "assistant",
        toolCalls: [
          {
            ...runtimeSession.createToolCall(iteration, 1),
            providerToolCallId: `i4-fixture-read-${this.fixtureToolCallNumber}`,
            name: "Read",
            args: { file_path: "fixture-payload.txt" },
          },
        ],
      };
    } else if (last?.role === "tool") {
      message = {
        role: "assistant",
        content: "Synthetic fixture turn complete.",
      };
    } else {
      throw new Error(
        `I4 fixture model received unsupported tail role ${last?.role ?? "missing"}.`,
      );
    }
    return modelOutput(prepared, message);
  }
}

class ActiveRecallRecorder implements EventSink {
  readonly name = "i4-active-recall";
  private terminal = false;
  private toolCallCount = 0;
  private nonRecallCallCount = 0;
  private recallCallCount = 0;
  private searchCount = 0;
  private getCount = 0;
  private successfulSearchCount = 0;
  private successfulGetCount = 0;
  private invalidCallCount = 0;
  private searchFoundTurnOne = false;
  private gotTurnOne = false;
  private readonly queries: string[] = [];
  private readonly searchHitTurnNumbers = new Set<number>();
  private readonly getTurnNumbers = new Set<number>();

  beginTerminalTurn(): void {
    if (this.terminal) {
      throw new Error("I4 recorder terminal turn was already started.");
    }
    this.terminal = true;
  }

  async append(event: AgentEvent): Promise<void> {
    if (!this.terminal) return;
    if (event.type === "tool.started") {
      this.toolCallCount += 1;
      if (event.data.call.name !== "Recall") {
        this.nonRecallCallCount += 1;
        return;
      }
      this.recallCallCount += 1;
      const mode = (event.data.call.args as { mode?: unknown }).mode;
      if (mode === "search") {
        this.searchCount += 1;
        const query = (event.data.call.args as { query?: unknown }).query;
        if (typeof query === "string") this.queries.push(query);
      } else if (mode === "get") this.getCount += 1;
      else this.invalidCallCount += 1;
      return;
    }
    if (
      event.type !== "tool.raw_result" ||
      event.data.call.name !== "Recall" ||
      event.data.raw.kind !== "recall"
    ) {
      return;
    }
    this.recordRecallResult(event.data.raw);
  }

  snapshot(): Pick<I4ActiveRecallTrial, "recall" | "tools"> {
    return Object.freeze({
      recall: Object.freeze({
        callCount: this.recallCallCount,
        searchCount: this.searchCount,
        getCount: this.getCount,
        successfulSearchCount: this.successfulSearchCount,
        successfulGetCount: this.successfulGetCount,
        searchFoundTurnOne: this.searchFoundTurnOne,
        gotTurnOne: this.gotTurnOne,
        invalidCallCount: this.invalidCallCount,
        queries: Object.freeze([...this.queries]),
        searchHitTurnNumbers: Object.freeze(
          [...this.searchHitTurnNumbers].sort((left, right) => left - right),
        ),
        getTurnNumbers: Object.freeze(
          [...this.getTurnNumbers].sort((left, right) => left - right),
        ),
      }),
      tools: Object.freeze({
        callCount: this.toolCallCount,
        nonRecallCallCount: this.nonRecallCallCount,
      }),
    });
  }

  private recordRecallResult(raw: RecallRawResult): void {
    if (!raw.ok) {
      this.invalidCallCount += 1;
      return;
    }
    if (raw.mode === "search") {
      this.successfulSearchCount += 1;
      if (raw.page.hits.some((hit) => hit.turnNumber === 1)) {
        this.searchFoundTurnOne = true;
      }
      for (const hit of raw.page.hits) {
        this.searchHitTurnNumbers.add(hit.turnNumber);
      }
      return;
    }
    this.successfulGetCount += 1;
    this.getTurnNumbers.add(raw.page.turnNumber);
    if (raw.page.turnNumber === 1) this.gotTurnOne = true;
  }
}

function aggregateTrials(trials: readonly I4ActiveRecallTrial[]) {
  const positives = trials.filter((entry) => entry.positive);
  const negatives = trials.filter((entry) => !entry.positive);
  const recallOnly = positives.filter(
    (entry) => entry.view === "recall_only_retirement",
  );
  const fullHistory = positives.filter((entry) => entry.view === "full_history");
  const swapOnly = positives.filter((entry) => entry.view === "swap_only");
  const usage = sumUsage(trials.map((entry) => entry.provider.usage));
  const totalLatencyMs = round(
    trials.reduce((sum, entry) => sum + entry.provider.latencyMs, 0),
  );
  return Object.freeze({
    trialCount: trials.length,
    positiveTrialCount: positives.length,
    negativeTrialCount: negatives.length,
    taskSuccessRate: rate(positives, (entry) => entry.task.passed),
    fullHistoryTaskSuccessRate: rate(fullHistory, (entry) => entry.task.passed),
    swapOnlyTaskSuccessRate: rate(swapOnly, (entry) => entry.task.passed),
    recallOnlyTaskSuccessRate: rate(recallOnly, (entry) => entry.task.passed),
    recallOnlyActiveRecallRate: rate(recallOnly, (entry) => entry.recall.callCount > 0),
    recallOnlySearchGetSuccessRate: rate(
      recallOnly,
      (entry) =>
        entry.recall.successfulSearchCount > 0 && entry.recall.successfulGetCount > 0,
    ),
    recallOnlyCorrectSourceRate: rate(recallOnly, (entry) => entry.recall.gotTurnOne),
    unnecessaryRecallRate: rate(negatives, (entry) => entry.recall.callCount > 0),
    invalidRecallCallCount: trials.reduce(
      (sum, entry) => sum + entry.recall.invalidCallCount,
      0,
    ),
    providerRequestCount: trials.reduce(
      (sum, entry) => sum + entry.provider.requestCount,
      0,
    ),
    providerLatencyMs: totalLatencyMs,
    providerUsage: usage,
  });
}

async function writeFixtureFiles(
  workspace: string,
  entry: ActiveRecallCase,
): Promise<void> {
  const line = "synthetic long-session payload with no task facts\n";
  const payload = line.repeat(
    Math.ceil(I4_ACTIVE_RECALL_FIXTURE_V1.payloadBytes / line.length),
  );
  await writeFile(
    path.join(workspace, "fixture-payload.txt"),
    payload.slice(0, I4_ACTIVE_RECALL_FIXTURE_V1.payloadBytes),
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(entry.currentFiles ?? {})) {
    const absolutePath = path.join(workspace, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
}

function modelOutput(
  prepared: PreparedModelRequest,
  message: AssistantMessage,
): ModelRequestOutput {
  const promptTokens = estimatePromptSegments(prepared.promptSegments).totalTokens;
  const completionTokens = Math.max(
    1,
    estimatePromptSegments(prepared.assistantReplaySegments(message)).totalTokens,
  );
  return {
    message,
    finishReason: "stop",
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}

function sumUsage(usages: readonly ModelUsage[]): ModelUsage {
  const sum = (select: (usage: ModelUsage) => number | undefined) => {
    const values = usages.flatMap((usage) => select(usage) ?? []);
    return values.length === 0
      ? undefined
      : values.reduce((total, value) => total + value, 0);
  };
  return Object.freeze({
    promptTokens: sum((usage) => usage.promptTokens) ?? 0,
    completionTokens: sum((usage) => usage.completionTokens) ?? 0,
    totalTokens: sum((usage) => usage.totalTokens) ?? 0,
    ...(sum((usage) => usage.promptCacheHitTokens) === undefined
      ? {}
      : {
          promptCacheHitTokens: sum((usage) => usage.promptCacheHitTokens),
          promptCacheMissTokens: sum((usage) => usage.promptCacheMissTokens),
        }),
    ...(sum((usage) => usage.reasoningTokens) === undefined
      ? {}
      : { reasoningTokens: sum((usage) => usage.reasoningTokens) }),
  });
}

function rate<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): number | undefined {
  if (values.length === 0) return undefined;
  return round(values.filter(predicate).length / values.length);
}

function resolvedModel(rawResponse: unknown): string | undefined {
  if (
    typeof rawResponse !== "object" ||
    rawResponse === null ||
    Array.isArray(rawResponse)
  ) {
    return undefined;
  }
  const model = (rawResponse as Record<string, unknown>).model;
  return typeof model === "string" && model.trim() !== "" ? model : undefined;
}

function elapsedMs(startedAt: number): number {
  return round(performance.now() - startedAt);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

type CliOptions = {
  profileName?: string;
  suite: ActiveRecallSuiteName;
  views: readonly ActiveRecallView[];
  trialsPerView: number;
  includeNegative: boolean;
  negativeOnly: boolean;
  caseId?: string;
  outputPath?: string;
};

function parseCli(argv: readonly string[]): CliOptions {
  let profileName: string | undefined;
  let suite: ActiveRecallSuiteName = "calibration";
  let views: readonly ActiveRecallView[] = allViews;
  let trialsPerView = 1;
  let includeNegative = false;
  let negativeOnly = false;
  let caseId: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--include-negative") {
      includeNegative = true;
      continue;
    }
    if (argument === "--negative-only") {
      includeNegative = true;
      negativeOnly = true;
      continue;
    }
    if (value === undefined) {
      throw new Error(`I4 evaluation option ${argument} requires a value.`);
    }
    index += 1;
    if (argument === "--profile") profileName = value;
    else if (argument === "--suite") {
      if (value !== "calibration" && value !== "holdout") {
        throw new Error(`Unknown I4 evaluation suite ${JSON.stringify(value)}.`);
      }
      suite = value;
    } else if (argument === "--views") {
      const parsed = value.split(",");
      if (parsed.some((entry) => !isActiveRecallView(entry))) {
        throw new Error(`Invalid I4 evaluation views ${JSON.stringify(value)}.`);
      }
      views = parsed as ActiveRecallView[];
    } else if (argument === "--trials") {
      trialsPerView = Number(value);
    } else if (argument === "--case") caseId = value;
    else if (argument === "--output") outputPath = path.resolve(value);
    else throw new Error(`Unknown I4 evaluation option ${argument}.`);
  }
  return {
    ...(profileName === undefined ? {} : { profileName }),
    suite,
    views,
    trialsPerView,
    includeNegative,
    negativeOnly,
    ...(caseId === undefined ? {} : { caseId }),
    ...(outputPath === undefined ? {} : { outputPath }),
  };
}

function isActiveRecallView(value: string): value is ActiveRecallView {
  return allViews.includes(value as ActiveRecallView);
}

async function writeReport(outputPath: string, report: I4ActiveRecallReport) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

if (import.meta.main) {
  const options = parseCli(Bun.argv.slice(2));
  const report = await runI4ActiveRecallEvaluation(options);
  if (options.outputPath !== undefined) {
    await writeReport(options.outputPath, report);
    console.log(
      JSON.stringify(
        { outputPath: options.outputPath, aggregate: report.aggregate },
        null,
        2,
      ),
    );
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}
