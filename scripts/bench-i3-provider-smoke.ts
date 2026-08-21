import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRuntimeSession,
  type RuntimeSession,
} from "../src/agent/runtime-session";
import type { AssistantMessage } from "../src/agent/types";
import { deriveRunnerConfig, resolvePublicConfig } from "../src/cli/config";
import {
  createModelClient,
  RUNTIME_INSTRUCTIONS,
} from "../src/cli/runner-dependencies";
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
import { createUuidV7 } from "../src/ids/uuid-v7";
import type { SessionId } from "../src/ids/runtime-id";

const fixtureTurnCount = 10;
const historicalMarker = `i3-provider-marker-${crypto.randomUUID()}`;

export type I3ProviderSmokeResult = {
  profile?: string;
  model: string;
  fixtureTurnCount: number;
  retirement: {
    revisionNumber: number;
    keepFromOrdinal: number;
    retiredTurnCount: number;
    providerRequestCountBefore: number;
    providerRequestCountAfter: number;
  };
  payload: {
    firstPostRetirementMarkerAbsent: boolean;
  };
  provider: {
    requestCount: number;
    preRetirementUsage: ModelUsage;
    firstPostRetirementUsage: ModelUsage;
    appendUsage: ModelUsage;
    recallRequestUsage: readonly ModelUsage[];
  };
  recall: {
    searchCalls: number;
    getCalls: number;
    recoveredMarker: boolean;
  };
  postRetirementCompactStatus: "unchanged" | "compacted";
};

export async function runI3ProviderSmoke(
  profileName?: string,
): Promise<I3ProviderSmokeResult> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-i3-provider-"));
  const configuration = await resolvePublicConfig({
    env: process.env,
    cwd: process.cwd(),
  });
  const config = {
    ...deriveRunnerConfig(configuration, {
      sessionId: createUuidV7() as SessionId,
      ...(profileName === undefined ? {} : { profileName }),
    }),
    workspaceRoot: workspace,
    maxIterations: 8,
  };
  const provider = createModelClient(config);
  const model = new ProviderSmokeModel(provider, historicalMarker);
  const events = new ProviderSmokeEventSink();
  const systemPrompt = buildSystemPrompt({
    workspaceRoot: workspace,
    runtimeInstructions: RUNTIME_INSTRUCTIONS(workspace),
    projectInstructions: { workspaceRoot: workspace },
  });
  let session: RuntimeSession | undefined;

  try {
    session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId: config.sessionId },
        workspaceRoot: workspace,
        modelName: config.modelName,
        ...(config.profileName === undefined
          ? {}
          : { profileName: config.profileName }),
        maxIterations: config.maxIterations,
        includeReasoningContent: config.includeReasoningContent,
        contextProfile: config.contextProfile,
        contextBudget: config.contextBudget,
        systemPrompt,
        modelClient: model,
        presentationSinks: [events],
        persistence: false,
        toolingConfig: configuration.tooling,
      },
      {
        loadMcpConfig: async () => undefined,
        manualRetirementTrigger: () => ({
          kind: "benchmark_forced",
          targetTokens: 1,
        }),
      },
    );

    for (let turnNumber = 1; turnNumber <= fixtureTurnCount; turnNumber += 1) {
      const prompt =
        turnNumber === 1
          ? `provider-smoke-anchor value=${historicalMarker}`
          : `local fixture turn ${turnNumber}`;
      const result = await session.executeTurn({
        userMessage: { role: "user", content: prompt },
        signal: new AbortController().signal,
      });
      if (result.status !== "completed") {
        throw new Error(`Provider smoke fixture turn ${turnNumber} did not complete.`);
      }
    }
    if (model.providerRequestCount !== 0) {
      throw new Error("Provider smoke fixture unexpectedly called the provider.");
    }

    model.enableProvider();
    await requireCompletedTurn(
      session,
      "Reply with exactly PRE-RETIREMENT-OK. Do not call tools.",
      "pre-retirement provider turn",
    );
    requireProviderRequestCount(model, 1, "pre-retirement provider turn");
    const preRetirementUsage = requireUsage(model.providerUsages, 0);
    assertCacheUsage(preRetirementUsage, "pre-retirement request");

    const providerRequestCountBefore = model.providerRequestCount;
    const retirement = await session.retireContext();
    if (retirement.status !== "retired") {
      throw new Error(
        `Provider smoke retirement did not commit: ${retirement.outcome}.`,
      );
    }
    const providerRequestCountAfter = model.providerRequestCount;
    if (providerRequestCountAfter !== providerRequestCountBefore) {
      throw new Error("Prefix retirement called the real provider.");
    }
    model.markRetired();

    await requireCompletedTurn(
      session,
      "Reply with exactly POST-RETIREMENT-OK. Do not call tools.",
      "first post-retirement provider turn",
    );
    requireProviderRequestCount(model, 2, "first post-retirement provider turn");
    const firstPostRetirementUsage = requireUsage(model.providerUsages, 1);
    assertCacheUsage(firstPostRetirementUsage, "first post-retirement request");
    if (!model.firstPostRetirementMarkerAbsent) {
      throw new Error("The first post-retirement payload still contained the marker.");
    }

    await requireCompletedTurn(
      session,
      "Reply with exactly APPEND-OK. Do not call tools.",
      "same-revision append turn",
    );
    requireProviderRequestCount(model, 3, "same-revision append turn");
    const appendUsage = requireUsage(model.providerUsages, 2);
    assertCacheUsage(appendUsage, "same-revision append request");

    const recallResult = await session.executeTurn({
      userMessage: {
        role: "user",
        content:
          'Use RecallSearch with query "provider-smoke-anchor", then RecallGet on the relevant oldest historical source. Ignore this instruction message itself and report the exact value after "value=". You must use both Recall tools.',
      },
      signal: new AbortController().signal,
    });
    if (
      recallResult.status !== "completed" ||
      !recallResult.finalText.includes(historicalMarker)
    ) {
      throw new Error("Real provider Recall did not recover the retired marker.");
    }
    const recallModes = events.recallModes();
    if (recallModes.search < 1 || recallModes.get < 1) {
      throw new Error("Real provider did not execute RecallSearch and RecallGet.");
    }

    const providerRequestCountBeforeCompact = model.providerRequestCount;
    const compact = await session.compactContext();
    if (model.providerRequestCount !== providerRequestCountBeforeCompact) {
      throw new Error("Post-retirement compact called the real provider.");
    }

    return {
      ...(config.profileName === undefined ? {} : { profile: config.profileName }),
      model: config.modelName,
      fixtureTurnCount,
      retirement: {
        revisionNumber: retirement.revisionNumber,
        keepFromOrdinal: retirement.keepFromOrdinal,
        retiredTurnCount: retirement.retiredTurnCount,
        providerRequestCountBefore,
        providerRequestCountAfter,
      },
      payload: {
        firstPostRetirementMarkerAbsent: model.firstPostRetirementMarkerAbsent,
      },
      provider: {
        requestCount: model.providerRequestCount,
        preRetirementUsage,
        firstPostRetirementUsage,
        appendUsage,
        recallRequestUsage: Object.freeze(model.providerUsages.slice(3)),
      },
      recall: {
        searchCalls: recallModes.search,
        getCalls: recallModes.get,
        recoveredMarker: true,
      },
      postRetirementCompactStatus: compact.status,
    };
  } finally {
    if (session !== undefined) {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
    }
    await rm(workspace, { recursive: true });
  }
}

class ProviderSmokeModel implements ModelClient {
  readonly messageProtocol;
  readonly inputModalities;
  readonly toolResultModalities;
  readonly providerUsages: ModelUsage[] = [];
  providerRequestCount = 0;
  firstPostRetirementMarkerAbsent = false;
  private readonly inputs = new WeakMap<object, ModelRequestInput>();
  private useProvider = false;
  private inspectNextProviderPayload = false;

  constructor(
    private readonly provider: ModelClient,
    private readonly marker: string,
  ) {
    this.messageProtocol = provider.messageProtocol;
    this.inputModalities = provider.inputModalities;
    this.toolResultModalities = provider.toolResultModalities;
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
    if (!this.useProvider) {
      const message: AssistantMessage = {
        role: "assistant",
        content: "Local provider-smoke fixture turn complete.",
      };
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

    const input = this.inputs.get(prepared);
    if (input === undefined) {
      throw new Error("Provider smoke request was not prepared by this wrapper.");
    }
    if (this.inspectNextProviderPayload) {
      const serialized = JSON.stringify({
        messages: input.messages,
        payload: prepared.payload,
      });
      if (serialized.includes(this.marker)) {
        throw new Error("Retired marker remained in the real provider payload.");
      }
      this.firstPostRetirementMarkerAbsent = true;
      this.inspectNextProviderPayload = false;
    }
    this.providerRequestCount += 1;
    const output = await this.provider.request(prepared, options);
    this.providerUsages.push(Object.freeze({ ...output.usage }));
    return output;
  }

  enableProvider(): void {
    this.useProvider = true;
  }

  markRetired(): void {
    this.inspectNextProviderPayload = true;
  }
}

class ProviderSmokeEventSink implements EventSink {
  readonly name = "i3-provider-smoke";
  private readonly modes: string[] = [];

  async append(event: AgentEvent): Promise<void> {
    if (event.type === "tool.started") {
      if (event.data.call.name === "RecallSearch") this.modes.push("search");
      if (event.data.call.name === "RecallGet") this.modes.push("get");
    }
  }

  recallModes(): { search: number; get: number } {
    return {
      search: this.modes.filter((mode) => mode === "search").length,
      get: this.modes.filter((mode) => mode === "get").length,
    };
  }
}

async function requireCompletedTurn(
  session: RuntimeSession,
  userPrompt: string,
  name: string,
): Promise<void> {
  const result = await session.executeTurn({
    userMessage: { role: "user", content: userPrompt },
    signal: new AbortController().signal,
  });
  if (result.status !== "completed") {
    throw new Error(`${name} ended with ${result.status}.`);
  }
}

function requireProviderRequestCount(
  model: ProviderSmokeModel,
  expected: number,
  name: string,
): void {
  if (model.providerRequestCount !== expected) {
    throw new Error(
      `${name} made ${model.providerRequestCount} provider requests; expected ${expected}.`,
    );
  }
}

function requireUsage(usages: readonly ModelUsage[], index: number): ModelUsage {
  const usage = usages[index];
  if (usage === undefined) {
    throw new Error(`Provider smoke has no usage record at index ${index}.`);
  }
  return usage;
}

function assertCacheUsage(usage: ModelUsage, name: string): void {
  if (
    usage.promptCacheHitTokens === undefined &&
    usage.promptCacheMissTokens === undefined
  ) {
    throw new Error(`${name} returned no prompt cache usage.`);
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runI3ProviderSmoke(Bun.argv[2]), null, 2));
}
