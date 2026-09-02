import { describe, expect, test } from "bun:test";
import { ContextMeter } from "../agent/context-meter";
import { runAgent } from "../agent/loop";
import type { RuntimeSessionContext } from "../agent/runtime-session";
import { InMemorySessionLedger } from "../agent/session-ledger";
import type { IterationIdentity, ToolCall, TurnIdentity } from "../agent/types";
import {
  canonicalToolResultContentHash,
  textToolResultContent,
  toolResultDisplayText,
} from "../agent/tool-result-content";
import { ContextRevisionCompiler } from "../context/context-revision-compiler";
import { swapOnlyPolicyV1 } from "../context/context-policy";
import {
  assertPlanBaseCurrent,
  SwapPlanStaleError,
  SwapPlanner,
  SwapPlanningDiagnosticError,
} from "../context/swap-planner";
import { ContextSwapRenderer } from "../context/context-swap-renderer";
import {
  contentHash,
  CURRENT_TOOL_OBSERVATION_FORMAT,
  rawResultHash,
  type CanonicalMessageRecord,
  type ToolResultRecord,
} from "../context/protocol-frame";
import { runtimeIdFactory } from "../ids/runtime-id";
import { imageAssetIdForBytes } from "../image/image-types";
import type { AgentEventInput } from "../events/types";
import type {
  ModelClient,
  ModelRequestInput,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import { OpenAIResponsesModelClient } from "../model/openai-responses-model-client";
import { ObservationBuilder } from "../observation/observation-builder";
import { ToolRegistry, ToolRuntime } from "../tools/registry";
import type { ToolRawResult } from "../tools/types";
import { TEST_CONTEXT_BUDGET, testModelOutput } from "./test-runtime";

describe("ContextSwapRenderer", () => {
  test("renders deterministic golden placeholders for every v1 raw kind", () => {
    const cases: readonly RendererCase[] = [
      {
        name: "Read",
        raw: {
          kind: "read",
          ok: true,
          filePath: 'src/"quoted".ts',
          startLine: 2,
          endLine: 8,
          sha256: "a".repeat(64),
          sizeBytes: 12_000,
          content: "DO_NOT_COPY",
        },
        metadata: {
          filePath: 'src/"quoted".ts',
          startLine: 2,
          endLine: 8,
          sha256: "a".repeat(64),
          sizeBytes: 12_000,
        },
        current:
          "Use Read to inspect the current file state before relying on historical content.",
      },
      {
        name: "Glob",
        raw: {
          kind: "glob",
          ok: true,
          pattern: "src/**/*.ts",
          searchPath: ".",
          matches: ["DO_NOT_COPY"],
          matchCount: 12,
        },
        metadata: { pattern: "src/**/*.ts", searchPath: ".", matchCount: 12 },
        current: "Use Glob to inspect the current workspace matches.",
      },
      {
        name: "Grep",
        raw: {
          kind: "grep",
          ok: true,
          pattern: "needle",
          searchPath: "src",
          mode: "content",
          filenames: ["DO_NOT_COPY"],
          numFiles: 2,
          content: "DO_NOT_COPY",
          numMatches: 4,
          truncated: true,
        },
        metadata: {
          pattern: "needle",
          searchPath: "src",
          mode: "content",
          numMatches: 4,
          truncated: true,
        },
        current: "Use Grep to inspect current workspace matches.",
      },
      {
        name: "Bash",
        raw: {
          kind: "bash",
          ok: true,
          command: "git status --short",
          taskId: "task-1",
          sessionId: runtimeIdFactory.createSessionId(),
          status: "completed",
          exitCode: 0,
          cwd: "/workspace",
          outputFilePath: ".tinker/bash/task-1.log",
          outputBytes: 500,
          outputLines: 10,
          preview: "DO_NOT_COPY",
          truncated: false,
          tty: false,
        },
        metadata: {
          status: "completed",
          exitCode: 0,
          outputFilePath: ".tinker/bash/task-1.log",
          outputBytes: 500,
          command: "git status --short",
        },
        current:
          "Inspect current state before deciding whether a historical command should be rerun.",
      },
      {
        name: "TaskOutput",
        raw: {
          kind: "task_output",
          ok: true,
          taskId: "task-2",
          status: "completed",
          outputFilePath: ".tinker/bash/task-2.log",
          outputBytes: 700,
          preview: "DO_NOT_COPY",
        },
        metadata: {
          taskId: "task-2",
          status: "completed",
          outputFilePath: ".tinker/bash/task-2.log",
          outputBytes: 700,
        },
        current:
          "Use TaskOutput to inspect the task's current recorded output and status.",
      },
      {
        name: "WebSearch",
        raw: {
          kind: "web_search",
          ok: true,
          query: "current docs",
          requestId: "request-1",
          resultCount: 3,
          results: [{ title: "DO_NOT_COPY", url: "https://secret.invalid" }],
        },
        metadata: {
          query: "current docs",
          resultCount: 3,
          requestId: "request-1",
        },
        current: "Use WebSearch when current search results are required.",
      },
      {
        name: "WebFetch",
        raw: {
          kind: "web_fetch",
          ok: true,
          url: "https://example.com/a",
          finalUrl: "https://example.com/b",
          title: "Example",
          httpStatusCode: 200,
          content: "DO_NOT_COPY",
          highlights: ["DO_NOT_COPY"],
        },
        metadata: {
          url: "https://example.com/a",
          finalUrl: "https://example.com/b",
          title: "Example",
          httpStatusCode: 200,
        },
        current: "Use WebFetch when the current page content is required.",
      },
      {
        name: "mcp__server__tool",
        raw: {
          kind: "mcp",
          ok: true,
          toolName: "mcp__server__tool",
          serverName: "server",
          serverToolName: "tool",
          isError: false,
          contentBlockCount: 2,
          text: "DO_NOT_COPY",
        },
        metadata: {
          serverName: "server",
          serverToolName: "tool",
          isError: false,
          contentBlockCount: 2,
        },
        current:
          "Call the MCP tool again only when current external state is required.",
      },
    ];

    for (const rendererCase of cases) {
      const { message, result } = rendererFixture(rendererCase.name, rendererCase.raw);
      const override = new ContextSwapRenderer().render({ message, result });
      expect(override.renderedContent).toBe(
        [
          "[Tinker historical tool observation swapped]",
          `source=ctx://message/${message.messageId}`,
          `contentSha256=${message.contentSha256}`,
          `tool=${stableJsonStringify(rendererCase.name)}`,
          `metadata=${stableJsonStringify(rendererCase.metadata)}`,
          "historical=Use RecallGet with source to recover the original observation.",
          `current=${rendererCase.current}`,
        ].join("\n"),
      );
      expect(override.renderedContent).not.toContain("DO_NOT_COPY");
      expect(override.renderedBytes).toBeLessThan(override.originalBytes);
      expect(override.renderedContentSha256).toBe(
        contentHash(override.renderedContent),
      );
    }
  });

  test("JSON-escapes and UTF-8 truncates external metadata within one KiB", () => {
    const longUrl = `https://example.com/${'"😀'.repeat(400)}`;
    const raw: ToolRawResult = {
      kind: "web_fetch",
      ok: true,
      url: longUrl,
      finalUrl: longUrl,
      title: longUrl,
      httpStatusCode: 200,
      content: "private-body",
    };
    const { message, result } = rendererFixture("WebFetch", raw);
    const rendered = new ContextSwapRenderer().render({ message, result });
    const metadataLine = rendered.renderedContent
      .split("\n")
      .find((line) => line.startsWith("metadata="));
    if (metadataLine === undefined) {
      throw new Error("Expected rendered metadata line.");
    }
    const metadataJson = metadataLine.slice("metadata=".length);
    const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    expect(Buffer.byteLength(metadataJson, "utf8")).toBeLessThanOrEqual(1_024);
    expect(metadata.url).toMatchObject({
      byteLength: Buffer.byteLength(longUrl, "utf8"),
      sha256: sha256(longUrl),
    });
    const prefix = (metadata.url as { prefix: string }).prefix;
    expect(Buffer.byteLength(prefix, "utf8")).toBeLessThanOrEqual(256);
    expect(prefix).not.toContain("�");
    expect(rendered.renderedContent).not.toContain("private-body");
  });
});

describe("SwapPlanner", () => {
  test("filters, ranks, estimates, and hashes deterministic plans without requesting", () => {
    const fixture = planningFixture();
    const built = fixture.ledger.buildCommittedModelRequest([]);
    const model = new PreparingOnlyModel();
    const activePrepared = model.prepare(built.request);
    model.prepareCount = 0;
    const meter = new ContextMeter(TEST_CONTEXT_BUDGET);
    const activeUsage = meter.measure(activePrepared);
    const planner = new SwapPlanner(model);
    const targetTokens = Math.max(0, activeUsage.usedInputTokens - 1);
    const input = {
      active: built.compiled,
      revision: built.revision,
      surface: built.surface,
      activeOverrides: built.activeOverrides,
      canonical: built.canonical,
      activePrepared,
      activeUsage,
      tools: [],
      policy: swapOnlyPolicyV1,
      trigger: "benchmark_forced" as const,
      forcedTargetTokens: targetTokens,
    };

    const first = planner.plan(input);
    const second = planner.plan(input);
    expect(first.outcome).toBe("target_reached");
    expect(first.eligibleCandidateCount).toBe(11);
    expect(first.excludedByReason).toMatchObject({
      observation_too_small: 1,
      recall_tool: 1,
      raw_kind_not_allowlisted: 1,
      running_task: 1,
      synthetic_completion: 1,
    });
    expect(first.plan?.addedOverrides).toHaveLength(1);
    expect(first.selectedByRawKind).toEqual({ grep: 1 });
    expect(first.plan?.rawTokensAfter).toBeLessThan(first.rawTokensBefore);
    expect(first.plan?.guardedTokensAfter).toBeLessThan(first.guardedTokensBefore);
    expect(first.plan?.planHash).toBe(second.plan?.planHash);
    expect(first.plan?.addedOverrides.map((entry) => entry.messageId)).toEqual(
      second.plan?.addedOverrides.map((entry) => entry.messageId),
    );
    expect(model.requestCount).toBe(0);
    expect(model.prepareCount).toBeGreaterThan(0);
    expect(meter.measure(activePrepared)).toEqual(activeUsage);

    const plan = first.plan;
    if (plan === undefined) {
      throw new Error("Expected a shadow plan.");
    }
    expect(() =>
      assertPlanBaseCurrent(plan, {
        active: built.compiled,
        revision: built.revision,
        activeOverrides: built.activeOverrides,
        activePrepared,
      }),
    ).not.toThrow();
    const stalePrepared = model.prepare({
      messages: [...built.request.messages, { role: "user", content: "tail" }],
      tools: [],
    });
    expect(() =>
      assertPlanBaseCurrent(plan, {
        active: built.compiled,
        revision: built.revision,
        activeOverrides: built.activeOverrides,
        activePrepared: stalePrepared,
      }),
    ).toThrow(SwapPlanStaleError);
    expect(() =>
      assertPlanBaseCurrent(plan, {
        active: {
          ...built.compiled,
          revisionId: runtimeIdFactory.createContextRevisionId(),
        },
        revision: built.revision,
        activeOverrides: built.activeOverrides,
        activePrepared,
      }),
    ).toThrow(SwapPlanStaleError);
    expect(() =>
      assertPlanBaseCurrent(plan, {
        active: {
          ...built.compiled,
          canonicalThroughOrdinal: built.compiled.canonicalThroughOrdinal + 1,
        },
        revision: built.revision,
        activeOverrides: built.activeOverrides,
        activePrepared,
      }),
    ).toThrow(SwapPlanStaleError);
    expect(() =>
      assertPlanBaseCurrent(plan, {
        active: built.compiled,
        revision: built.revision,
        activeOverrides: built.activeOverrides,
        activePrepared: {
          ...activePrepared,
          requestConfigHash: "changed-request-config",
        },
      }),
    ).toThrow(SwapPlanStaleError);
    expect(() =>
      assertPlanBaseCurrent(plan, {
        active: built.compiled,
        revision: built.revision,
        activeOverrides: built.activeOverrides,
        activePrepared: {
          ...activePrepared,
          toolSchemaHash: "changed-tool-schema",
        },
      }),
    ).toThrow(SwapPlanStaleError);

    const projected = new ContextRevisionCompiler().compileProspective({
      active: built.compiled,
      canonical: built.canonical,
      activeOverrides: built.activeOverrides,
      addedOverrides: plan.addedOverrides,
      activeSurface: built.surface,
    });
    expect(projected.entries.map((entry) => entry.frameId)).toEqual(
      built.compiled.entries.map((entry) => entry.frameId),
    );
    expect(projected.entries.map((entry) => entry.message.role)).toEqual(
      built.compiled.entries.map((entry) => entry.message.role),
    );
  });

  test("returns the all-candidate floor when the target cannot be reached", () => {
    const fixture = planningFixture();
    const built = fixture.ledger.buildCommittedModelRequest([]);
    const model = new PreparingOnlyModel();
    const activePrepared = model.prepare(built.request);
    const activeUsage = new ContextMeter(TEST_CONTEXT_BUDGET).measure(activePrepared);
    const result = new SwapPlanner(model).plan({
      active: built.compiled,
      revision: built.revision,
      surface: built.surface,
      activeOverrides: built.activeOverrides,
      canonical: built.canonical,
      activePrepared,
      activeUsage,
      tools: [],
      policy: swapOnlyPolicyV1,
      trigger: "benchmark_forced",
      forcedTargetTokens: 0,
    });
    expect(result.outcome).toBe("insufficient_candidates");
    expect(result.plan?.addedOverrides).toHaveLength(result.eligibleCandidateCount);
    expect(result.plan?.guardedTokensAfter).toBeGreaterThan(0);
    expect(result.plan?.guardedTokensAfter).toBeLessThan(result.guardedTokensBefore);
  });

  test("projects exactly the model-selected eligible IDs and rejects a stale selection", () => {
    const fixture = planningFixture();
    const built = fixture.ledger.buildCommittedModelRequest([]);
    const model = new PreparingOnlyModel();
    const activePrepared = model.prepare(built.request);
    const activeUsage = new ContextMeter(TEST_CONTEXT_BUDGET).measure(activePrepared);
    const planner = new SwapPlanner(model);
    const scan = planner.scanCandidates(
      built.canonical,
      built.activeOverrides,
      swapOnlyPolicyV1,
      built.revision.keepFromOrdinal,
      undefined,
    );
    const selected = scan.eligible.at(-1);
    const activeMessage = built.canonical.messages.at(-1);
    if (
      selected === undefined ||
      activeMessage === undefined ||
      activeMessage.role === "system"
    ) {
      throw new Error("Expected an eligible candidate and an active turn boundary.");
    }
    const baseInput = {
      active: built.compiled,
      revision: built.revision,
      surface: built.surface,
      activeOverrides: built.activeOverrides,
      canonical: built.canonical,
      activePrepared,
      activeUsage,
      tools: [],
      policy: swapOnlyPolicyV1,
      trigger: "model_directed" as const,
      activeTurn: {
        turnId: activeMessage.turnId,
        consumedThroughOrdinal: built.canonical.messages.length,
      },
    };

    const result = planner.plan({
      ...baseInput,
      selectedMessageIds: [selected.message.messageId],
    });
    expect(result.plan?.addedOverrides.map((entry) => entry.messageId)).toEqual([
      selected.message.messageId,
    ]);
    expect(result.plan?.guardedTokensAfter).toBeLessThan(result.guardedTokensBefore);

    const stale = [...scan.excludedByMessageId].find(
      ([, reason]) => reason === "observation_too_small",
    );
    if (stale === undefined) {
      throw new Error("Expected an ineligible observation fixture.");
    }
    let error: unknown;
    try {
      planner.plan({ ...baseInput, selectedMessageIds: [stale[0]] });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SwapPlanningDiagnosticError);
    expect(error).toMatchObject({
      stage: "candidate",
      code: "selected_candidate_observation_too_small",
    });
  });

  test("swaps only observations already consumed inside the active turn", () => {
    const sessionId = runtimeIdFactory.createSessionId();
    const ledger = new InMemorySessionLedger({
      sessionId,
      systemPrompt: "system",
      idFactory: runtimeIdFactory,
    });
    const turn = nextTurn(sessionId, 1);
    const pending = ledger.beginTurn({
      turn,
      userMessage: { role: "user", content: "active task" },
    });
    const appendObservation = (iterationNumber: number, marker: string) => {
      const iteration: IterationIdentity = {
        ...turn,
        iterationId: runtimeIdFactory.createIterationId(),
        iterationNumber,
      };
      const call: ToolCall = {
        ...iteration,
        toolCallId: runtimeIdFactory.createToolCallId(),
        toolCallNumber: 1,
        providerToolCallId: `active-${iterationNumber}`,
        name: "Read",
        args: {},
      };
      pending.agent.appendAssistant({
        iteration,
        message: { role: "assistant", toolCalls: [call] },
        provider: "test",
        model: "test-model",
      });
      return pending.agent.commitToolCompletions([
        {
          call,
          kind: "returned",
          raw: readRaw(marker),
          observation: textToolResultContent(marker.repeat(12_000)),
        },
      ])[0];
    };
    const consumed = appendObservation(1, "a");
    const unseen = appendObservation(2, "b");
    const built = pending.agent.buildModelRequest([]);
    const model = new PreparingOnlyModel();
    const activePrepared = model.prepare(built.request);
    const activeUsage = new ContextMeter(TEST_CONTEXT_BUDGET).measure(activePrepared);
    const result = new SwapPlanner(model).plan({
      active: built.compiled,
      revision: built.revision,
      surface: built.surface,
      activeOverrides: built.activeOverrides,
      canonical: built.canonical,
      activePrepared,
      activeUsage,
      tools: [],
      policy: swapOnlyPolicyV1,
      trigger: "benchmark_forced",
      forcedTargetTokens: activeUsage.usedInputTokens - 1,
      activeTurn: {
        turnId: turn.turnId,
        consumedThroughOrdinal: consumed.ordinal,
      },
    });

    expect(result.eligibleCandidateCount).toBe(1);
    expect(result.excludedByReason).toMatchObject({ active_turn_unconsumed: 1 });
    expect(result.plan?.addedOverrides.map((entry) => entry.ordinal)).toEqual([
      consumed.ordinal,
    ]);
    expect(result.plan?.addedOverrides.map((entry) => entry.ordinal)).not.toContain(
      unseen.ordinal,
    );
  });

  test("uses a media-removing placeholder and protects an unconsumed ViewImage", () => {
    const fixture = activeViewImageFixture();
    const built = fixture.pending.agent.buildModelRequest([]);
    const model = new PreparingImageModel();
    const activePrepared = model.prepare(built.request);
    const activeUsage = new ContextMeter(TEST_CONTEXT_BUDGET).measure(activePrepared);
    expect(activePrepared.mediaOccurrenceCount).toBe(1);

    const protectedResult = new SwapPlanner(model).plan({
      active: built.compiled,
      revision: built.revision,
      surface: built.surface,
      activeOverrides: built.activeOverrides,
      canonical: built.canonical,
      activePrepared,
      activeUsage,
      tools: [],
      policy: swapOnlyPolicyV1,
      trigger: "benchmark_forced",
      forcedTargetTokens: activeUsage.usedInputTokens - 1,
      activeTurn: {
        turnId: fixture.turn.turnId,
        consumedThroughOrdinal: fixture.toolMessage.ordinal - 1,
      },
    });
    expect(protectedResult.eligibleCandidateCount).toBe(0);
    expect(protectedResult.excludedByReason).toMatchObject({
      active_turn_unconsumed: 1,
    });

    const consumedResult = new SwapPlanner(model).plan({
      active: built.compiled,
      revision: built.revision,
      surface: built.surface,
      activeOverrides: built.activeOverrides,
      canonical: built.canonical,
      activePrepared,
      activeUsage,
      tools: [],
      policy: swapOnlyPolicyV1,
      trigger: "benchmark_forced",
      forcedTargetTokens: activeUsage.usedInputTokens - 1,
      activeTurn: {
        turnId: fixture.turn.turnId,
        consumedThroughOrdinal: fixture.toolMessage.ordinal,
      },
    });
    const override = consumedResult.plan?.addedOverrides[0];
    expect(override).toMatchObject({
      messageId: fixture.toolMessage.messageId,
      rendererFormat: "swap-tool-image-v1",
    });
    expect(override?.renderedContent).toBe(
      `[Tool image omitted from compacted context: ViewImage fixture.png, image/png, 2048x1024, asset=${fixture.asset.assetId.slice(0, 12)}…. Use ViewImage again if the current image is required.]`,
    );
    expect(consumedResult.plan?.guardedTokensAfter).toBeLessThan(
      consumedResult.guardedTokensBefore,
    );

    if (override === undefined) {
      throw new Error("Expected a ViewImage swap override.");
    }
    const compiled = new ContextRevisionCompiler().compileProspective({
      active: built.compiled,
      canonical: built.canonical,
      activeOverrides: built.activeOverrides,
      addedOverrides: [override],
      activeSurface: built.surface,
    });
    const swappedPrepared = model.prepare({
      messages: compiled.entries.map((entry) => entry.message),
      tools: [],
    });
    expect(swappedPrepared.mediaOccurrenceCount).toBe(0);
    expect(
      built.canonical.messages.find(
        (message) => message.messageId === fixture.toolMessage.messageId,
      ),
    ).toMatchObject({
      content: [{ type: "text" }, { type: "image", asset: fixture.asset }],
    });
  });
});

describe("runtime shadow isolation", () => {
  test("requests the original active payload after a successful shadow plan", async () => {
    const fixture = planningFixture();
    const turn = nextTurn(fixture.sessionId, 17);
    const pending = fixture.ledger.beginTurn({
      turn,
      userMessage: { role: "user", content: "active request" },
    });
    const expected = pending.agent.buildModelRequest([]).request;
    const model = new RuntimeShadowModel(false);
    const events: AgentEventInput[] = [];
    const result = await runAgent({
      ledger: pending.agent,
      maxIterations: 1,
      model,
      contextMeter: new ContextMeter(TEST_CONTEXT_BUDGET),
      shadowPlanning: {
        planner: new SwapPlanner(model),
        select: ({ preflight }) => ({
          trigger: "benchmark_forced",
          forcedTargetTokens: Math.max(0, preflight.usedInputTokens - 1),
        }),
      },
      tools: new ToolRegistry(),
      toolRuntime: new ToolRuntime(new ToolRegistry()),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: runtimeFor(turn, events),
      turn,
      signal: new AbortController().signal,
    });
    pending.finish(result);

    expect(result.status).toBe("completed");
    expect(model.requestCount).toBe(1);
    expect(model.requestedInputs[0]).toEqual(expected);
    expect(
      model.requestedInputs[0]?.messages.some(
        (message) =>
          message.role === "tool" &&
          toolResultDisplayText(message.content).startsWith(
            "[Tinker historical tool observation swapped]",
          ),
      ),
    ).toBe(false);
    expect(events.map((event) => event.type)).toContain("context.shadow.planned");
    const planned = events.find((event) => event.type === "context.shadow.planned");
    const serializedEvent = stableJsonStringify(planned);
    for (const forbidden of [
      "active request",
      "eligible-read",
      "needle",
      "https://example.com",
      "long task",
      "ctx://message/",
      "[Tinker historical tool observation swapped]",
    ]) {
      expect(serializedEvent).not.toContain(forbidden);
    }
  });

  test("records a bounded shadow failure and still requests the active payload", async () => {
    const fixture = planningFixture();
    const turn = nextTurn(fixture.sessionId, 17);
    const pending = fixture.ledger.beginTurn({
      turn,
      userMessage: { role: "user", content: "active after diagnostic failure" },
    });
    const expected = pending.agent.buildModelRequest([]).request;
    const model = new RuntimeShadowModel(true);
    const events: AgentEventInput[] = [];
    const result = await runAgent({
      ledger: pending.agent,
      maxIterations: 1,
      model,
      contextMeter: new ContextMeter(TEST_CONTEXT_BUDGET),
      shadowPlanning: {
        planner: new SwapPlanner(model),
        select: ({ preflight }) => ({
          trigger: "benchmark_forced",
          forcedTargetTokens: Math.max(0, preflight.usedInputTokens - 1),
        }),
      },
      tools: new ToolRegistry(),
      toolRuntime: new ToolRuntime(new ToolRegistry()),
      observationBuilder: new ObservationBuilder(),
      runtimeSession: runtimeFor(turn, events),
      turn,
      signal: new AbortController().signal,
    });
    pending.finish(result);

    expect(result.status).toBe("completed");
    expect(model.requestCount).toBe(1);
    expect(model.requestedInputs[0]).toEqual(expected);
    const failure = events.find((event) => event.type === "context.shadow.failed");
    expect(failure?.data).toEqual({
      policyVersion: "swap-only-v1",
      stage: "prepare",
      errorCode: "prospective_prepare_failed",
      error: "Prospective request preparation failed.",
    });
    expect(stableJsonStringify(failure)).not.toContain("active after diagnostic");
  });
});

class PreparingOnlyModel implements ModelClient {
  readonly inputModalities = Object.freeze(["text"] as const);
  readonly toolResultModalities = Object.freeze(["text"] as const);
  readonly messageProtocol = Object.freeze({
    adapter: "openai-chat" as const,
    serializationVersion: "openai-chat-v1",
  });
  prepareCount = 0;
  requestCount = 0;
  private readonly serializer = new OpenAIChatModelClient({
    apiKey: "test-no-network",
    baseURL: "https://example.invalid/v1",
    model: "test-model",
    contextBudget: TEST_CONTEXT_BUDGET,
  });

  prepare(input: ModelRequestInput): PreparedModelRequest {
    this.prepareCount += 1;
    return this.serializer.prepare(input);
  }

  async request(): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    throw new Error("Shadow planner must never request the provider.");
  }
}

class PreparingImageModel implements ModelClient {
  readonly inputModalities = Object.freeze(["text", "image"] as const);
  readonly toolResultModalities = Object.freeze(["text", "image"] as const);
  readonly messageProtocol = Object.freeze({
    adapter: "openai-responses" as const,
    serializationVersion: "openai-responses-v2",
  });
  private readonly serializer = new OpenAIResponsesModelClient({
    apiKey: "test-no-network",
    baseURL: "https://example.invalid/v1",
    model: "test-model",
    contextBudget: TEST_CONTEXT_BUDGET,
    inputModalities: ["text", "image"],
    toolResultModalities: ["text", "image"],
  });

  prepare(input: ModelRequestInput): PreparedModelRequest {
    return this.serializer.prepare(input);
  }

  async request(): Promise<ModelRequestOutput> {
    throw new Error("ViewImage planning fixture must never request the provider.");
  }
}

class RuntimeShadowModel implements ModelClient {
  readonly inputModalities = Object.freeze(["text"] as const);
  readonly toolResultModalities = Object.freeze(["text"] as const);
  readonly messageProtocol = Object.freeze({
    adapter: "openai-chat" as const,
    serializationVersion: "openai-chat-v1",
  });
  requestCount = 0;
  readonly requestedInputs: ModelRequestInput[] = [];
  private readonly inputs = new WeakMap<object, ModelRequestInput>();
  private readonly serializer = new OpenAIChatModelClient({
    apiKey: "test-no-network",
    baseURL: "https://example.invalid/v1",
    model: "test-model",
    contextBudget: TEST_CONTEXT_BUDGET,
  });

  constructor(private readonly failProspective: boolean) {}

  prepare(input: ModelRequestInput): PreparedModelRequest {
    if (
      this.failProspective &&
      input.messages.some(
        (message) =>
          message.role === "tool" &&
          toolResultDisplayText(message.content).startsWith(
            "[Tinker historical tool observation swapped]",
          ),
      )
    ) {
      throw new Error("secret prospective serializer detail");
    }
    const prepared = this.serializer.prepare(input);
    this.inputs.set(prepared, {
      messages: [...input.messages],
      tools: [...input.tools],
    });
    return prepared;
  }

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    const input = this.inputs.get(prepared);
    if (input === undefined) {
      throw new Error("Runtime shadow model received an unknown request.");
    }
    this.requestCount += 1;
    this.requestedInputs.push(input);
    return testModelOutput(prepared, { role: "assistant", content: "done" });
  }
}

function rendererFixture(name: string, raw: ToolRawResult) {
  const sessionId = runtimeIdFactory.createSessionId();
  const frameId = runtimeIdFactory.createProtocolFrameId();
  const messageId = runtimeIdFactory.createMessageId();
  const toolCallId = runtimeIdFactory.createToolCallId();
  const observation = `secret-observation-${raw.kind}-${"x".repeat(12_000)}`;
  const content = textToolResultContent(observation);
  const message: Extract<CanonicalMessageRecord, { role: "tool" }> = {
    messageId,
    sessionId,
    frameId,
    ordinal: 3,
    contentSha256: canonicalToolResultContentHash(content),
    createdAt: "2026-07-16T00:00:00.000Z",
    role: "tool",
    turnId: runtimeIdFactory.createTurnId(),
    iterationId: runtimeIdFactory.createIterationId(),
    toolCallId,
    providerToolCallId: "provider-call",
    name,
    content,
    displayText: observation,
    origin: "tool",
  };
  const result: ToolResultRecord = {
    sessionId,
    frameId,
    toolCallId,
    toolMessageId: messageId,
    completion: {
      kind: "returned",
      raw,
      rawSha256: rawResultHash(raw),
      observationFormat: CURRENT_TOOL_OBSERVATION_FORMAT,
    },
    observationSha256: message.contentSha256,
    createdAt: message.createdAt,
  };
  return { message, result };
}

function activeViewImageFixture() {
  const sessionId = runtimeIdFactory.createSessionId();
  const ledger = new InMemorySessionLedger({
    sessionId,
    systemPrompt: "system",
    idFactory: runtimeIdFactory,
  });
  const turn = nextTurn(sessionId, 1);
  const iteration: IterationIdentity = {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 1,
  };
  const call: ToolCall = {
    ...iteration,
    toolCallId: runtimeIdFactory.createToolCallId(),
    toolCallNumber: 1,
    providerToolCallId: "provider-view-image",
    name: "ViewImage",
    args: { file_path: "fixture.png" },
  };
  const asset = Object.freeze({
    assetId: imageAssetIdForBytes(Buffer.from("view-image-context-fixture")),
    mimeType: "image/png" as const,
    byteLength: 1_024,
    width: 2_048,
    height: 1_024,
  });
  const raw = Object.freeze({
    kind: "view_image" as const,
    ok: true,
    filePath: "fixture.png",
    originalName: "fixture.png",
    asset,
  });
  const observation = new ObservationBuilder().build({ call, raw });
  const pending = ledger.beginTurn({
    turn,
    userMessage: { role: "user", content: "inspect fixture" },
  });
  pending.agent.appendAssistant({
    iteration,
    message: { role: "assistant", toolCalls: [call] },
    provider: "test",
    model: "test-model",
  });
  const completion = pending.agent.commitToolCompletions([
    { call, kind: "returned", raw, observation: observation.content },
  ])[0];
  if (completion === undefined) {
    throw new Error("Expected a committed ViewImage completion.");
  }
  const toolMessage = ledger
    .snapshot({ allowOpenTail: false })
    .messages.find((message) => message.messageId === completion.toolMessageId);
  if (toolMessage?.role !== "tool") {
    throw new Error("Expected a canonical ViewImage tool message.");
  }
  return { pending, turn, toolMessage, asset };
}

function planningFixture() {
  const sessionId = runtimeIdFactory.createSessionId();
  const ledger = new InMemorySessionLedger({
    sessionId,
    systemPrompt: "system",
    idFactory: runtimeIdFactory,
    clock: () => "2026-07-16T00:00:00.000Z",
  });
  const specifications: readonly ToolTurnSpecification[] = [
    {
      name: "Read",
      raw: readRaw("small"),
      observation: "a".repeat(2_047),
    },
    {
      name: "RecallSearch",
      raw: {
        kind: "recall",
        ok: false,
        mode: "search",
        errorCode: "RECALL_SOURCE_NOT_FOUND",
        error: "not found",
      },
      observation: "b".repeat(9_000),
    },
    {
      name: "Write",
      raw: {
        kind: "write",
        ok: true,
        filePath: "changed.ts",
        bytesWritten: 9_000,
      },
      observation: "c".repeat(9_000),
    },
    {
      name: "Bash",
      raw: {
        kind: "bash",
        ok: true,
        command: "long task",
        taskId: "running-task",
        sessionId,
        status: "running",
        cwd: "/workspace",
        outputFilePath: ".tinker/bash/running.log",
        outputBytes: 9_000,
        outputLines: 1,
        preview: "running",
        truncated: false,
        tty: false,
      },
      observation: "d".repeat(9_000),
    },
    {
      name: "Read",
      raw: readRaw("eligible-read"),
      observation: "e".repeat(8_192),
    },
    {
      name: "Grep",
      raw: {
        kind: "grep",
        ok: true,
        pattern: "needle",
        searchPath: "src",
        mode: "content",
        filenames: ["a.ts"],
        numFiles: 1,
        numMatches: 100,
      },
      observation: "f".repeat(11_000),
    },
    {
      name: "WebFetch",
      raw: {
        kind: "web_fetch",
        ok: true,
        url: "https://example.com",
        finalUrl: "https://example.com/current",
        title: "Example",
        httpStatusCode: 200,
      },
      observation: "g".repeat(10_000),
    },
    { name: "Read", synthetic: true, observation: "ignored" },
    ...Array.from(
      { length: 8 },
      (_, index): ToolTurnSpecification => ({
        name: "Read",
        raw: readRaw(`protected-${index}`),
        observation: "p".repeat(9_000 + index),
      }),
    ),
  ];
  specifications.forEach((specification, index) =>
    appendToolTurn(ledger, sessionId, index + 1, specification),
  );
  return { ledger, sessionId };
}

function nextTurn(
  sessionId: ReturnType<typeof runtimeIdFactory.createSessionId>,
  turnNumber: number,
): TurnIdentity {
  return {
    sessionId,
    turnId: runtimeIdFactory.createTurnId(),
    turnNumber,
  };
}

function runtimeFor(
  turn: TurnIdentity,
  events: AgentEventInput[],
): RuntimeSessionContext {
  return {
    sessionId: turn.sessionId,
    contextMaintenance: {
      async status() {
        throw new Error("Shadow test runtime has no context maintenance coordinator.");
      },
      async candidates() {
        throw new Error("Shadow test runtime has no context maintenance coordinator.");
      },
      async swap() {
        throw new Error("Shadow test runtime has no context maintenance coordinator.");
      },
    },
    createIteration(inputTurn, iterationNumber) {
      if (inputTurn.turnId !== turn.turnId || iterationNumber !== 1) {
        throw new Error("Unexpected runtime iteration identity.");
      }
      return {
        ...turn,
        iterationId: runtimeIdFactory.createIterationId(),
        iterationNumber,
      };
    },
    createToolCall() {
      throw new Error("Runtime shadow fixture does not create tool calls.");
    },
    finishIterationForContinuation() {
      throw new Error("Runtime shadow fixture does not continue iterations.");
    },
    async append(event) {
      events.push(event);
    },
  };
}

function appendToolTurn(
  ledger: InMemorySessionLedger,
  sessionId: ReturnType<typeof runtimeIdFactory.createSessionId>,
  turnNumber: number,
  specification: ToolTurnSpecification,
): void {
  const turn: TurnIdentity = {
    sessionId,
    turnId: runtimeIdFactory.createTurnId(),
    turnNumber,
  };
  const iteration: IterationIdentity = {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 1,
  };
  const call: ToolCall = {
    ...iteration,
    toolCallId: runtimeIdFactory.createToolCallId(),
    toolCallNumber: 1,
    providerToolCallId: `provider-${turnNumber}`,
    name: specification.name,
    args: {},
  };
  const pending = ledger.beginTurn({
    turn,
    userMessage: { role: "user", content: `turn ${turnNumber}` },
  });
  pending.agent.appendAssistant({
    iteration,
    message: { role: "assistant", toolCalls: [call] },
    provider: "test",
    model: "test-model",
  });
  pending.agent.commitToolCompletions(
    specification.synthetic === true
      ? [{ call, kind: "synthetic", reason: "cancelled_active" }]
      : [
          {
            call,
            kind: "returned",
            raw: requireRaw(specification.raw),
            observation: textToolResultContent(specification.observation),
          },
        ],
  );
  const finalIteration: IterationIdentity = {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 2,
  };
  pending.agent.appendAssistant({
    iteration: finalIteration,
    message: { role: "assistant", content: `done ${turnNumber}` },
    provider: "test",
    model: "test-model",
  });
  pending.finish({
    status: "completed",
    finalText: `done ${turnNumber}`,
    lastIteration: finalIteration,
  });
}

function readRaw(filePath: string): Extract<ToolRawResult, { kind: "read" }> {
  return {
    kind: "read",
    ok: true,
    filePath,
    startLine: 1,
    endLine: 100,
    sha256: sha256(filePath),
    sizeBytes: 20_000,
  };
}

function requireRaw(raw: ToolRawResult | undefined): ToolRawResult {
  if (raw === undefined) {
    throw new Error("Tool turn fixture requires a raw result.");
  }
  return raw;
}

type RendererCase = {
  readonly name: string;
  readonly raw: ToolRawResult;
  readonly metadata: Record<string, unknown>;
  readonly current: string;
};

type ToolTurnSpecification = {
  readonly name: string;
  readonly raw?: ToolRawResult;
  readonly observation: string;
  readonly synthetic?: boolean;
};
