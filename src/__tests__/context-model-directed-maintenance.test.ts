import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeSession } from "../agent/runtime-session";
import { toolResultDisplayText } from "../agent/tool-result-content";
import type { AgentMessage, AssistantMessage } from "../agent/types";
import { parseMessageId, runtimeIdFactory, type MessageId } from "../ids/runtime-id";
import type {
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { deriveModelContextBudget } from "../model/model-context-profile";
import { SessionStore } from "../session/session-store";
import {
  collectingEventSink,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

const CONTEXT_PROFILE = {
  contextWindowTokens: 160 * 1_024,
  maxSupportedOutputTokens: 64 * 1_024,
} as const;
const CONTEXT_BUDGET = deriveModelContextBudget(CONTEXT_PROFILE);
const ORIGINAL_MARKER = "model-directed-original-observation";

describe("model-directed context maintenance", () => {
  test("lists an open-tail candidate, leases one iteration, swaps after frame close, and survives resume", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-model-directed-context-"),
    );
    const sessionId = runtimeIdFactory.createSessionId();
    const largeContent = `${ORIGINAL_MARKER}\n${"x".repeat(235 * 1_024)}`;
    await writeFile(path.join(workspace, "large.txt"), largeContent, "utf8");
    const sink = collectingEventSink();
    const model = new ModelDirectedContextModel();
    let session = await createRuntimeSession(
      runtimeInput(workspace, sessionId, model, "new", sink),
      { loadMcpConfig: async () => undefined },
    );

    try {
      const result = await session.executeTurn({
        userMessage: {
          role: "user",
          content: "exercise model-directed context maintenance",
        },
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({
        status: "completed",
        finalText: "model-directed context verified",
      });
      expect(model.statusPressure).toBe("high");
      expect(model.candidateLabel).toBe("Read: large.txt");
      expect(model.candidateSavingsBytes).toBeGreaterThan(8 * 1_024);
      expect(model.source).toMatch(/^ctx:\/\/message\//);
      expect(model.recalledOriginal).toBe(true);

      const candidateFinished = requireEventSequence(
        sink.events.find(
          (event) =>
            event.type === "tool.finished" &&
            event.data.call.name === "ContextSwapCandidates",
        ),
        "ContextSwapCandidates tool.finished",
      );
      const swapFinished = requireEventSequence(
        sink.events.find(
          (event) =>
            event.type === "tool.finished" && event.data.call.name === "ContextSwap",
        ),
        "ContextSwap tool.finished",
      );
      const directedStarted = requireEventSequence(
        sink.events.find(
          (event) =>
            event.type === "context.revision.started" &&
            event.data.strategy === "swap" &&
            event.data.reason === "model_directed",
        ),
        "model-directed context.revision.started",
      );
      const directedFinished = sink.events.find(
        (event) =>
          event.type === "context.revision.finished" &&
          event.data.strategy === "swap" &&
          event.data.reason === "model_directed",
      );
      expect(directedFinished?.data).toMatchObject({
        strategy: "swap",
        reason: "model_directed",
        addedOverrideCount: 1,
        activeOverrideCount: 1,
      });
      const fourthRequest = requireEventSequence(
        sink.events.find(
          (event) =>
            event.type === "model.request.started" && event.iterationNumber === 4,
        ),
        "fourth model request",
      );

      expect(
        sink.events.filter(
          (event) =>
            event.eventSequence > candidateFinished &&
            event.eventSequence < swapFinished &&
            event.type === "context.revision.started" &&
            event.data.reason === "runtime_pressure",
        ),
      ).toHaveLength(0);
      expect(swapFinished).toBeLessThan(directedStarted);
      expect(directedStarted).toBeLessThan(fourthRequest);

      await session.dispose({ type: "tui_exit" });

      const store = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId,
      });
      try {
        const rawResults = store
          .loadContextSnapshot()
          .canonical.toolResults.flatMap((entry) =>
            entry.completion.kind === "returned" &&
            entry.completion.raw.kind === "context_maintenance"
              ? [entry.completion.raw]
              : [],
          );
        expect(rawResults.map((raw) => raw.operation)).toEqual([
          "status",
          "candidates",
          "swap",
        ]);
        expect(rawResults[0]).toMatchObject({
          ok: true,
          operation: "status",
          pressure: "high",
        });
        expect(rawResults[1]).toMatchObject({
          ok: true,
          operation: "candidates",
          total: 1,
          candidates: [
            {
              candidateId: model.candidateId,
              label: "Read: large.txt",
            },
          ],
        });
        expect(rawResults[2]).toEqual({
          kind: "context_maintenance",
          ok: true,
          operation: "swap",
          scheduled: [
            {
              candidateId: parseMessageId(
                requireString(model.candidateId, "candidate ID"),
              ),
              savingsBytes: requireNumber(
                model.candidateSavingsBytes,
                "candidate savings",
              ),
            },
          ],
          rejected: [],
          note: "Swap executes when this iteration's tool frames close.",
        });
      } finally {
        await store.abandon();
      }

      const resumedModel = new ResumedRecallModel(
        requireString(model.source, "source"),
      );
      session = await createRuntimeSession(
        runtimeInput(workspace, sessionId, resumedModel, "resume", sink),
        { loadMcpConfig: async () => undefined },
      );
      const resumed = await session.executeTurn({
        userMessage: { role: "user", content: "verify resumed context" },
        signal: new AbortController().signal,
      });
      expect(resumed).toMatchObject({
        status: "completed",
        finalText: "resumed context verified",
      });
      expect(resumedModel.sawPersistedContextTools).toBe(true);
      expect(resumedModel.recalledOriginal).toBe(true);
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("commits a pending model selection when automatic maintenance is disabled", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-model-directed-unprofiled-"),
    );
    const sessionId = runtimeIdFactory.createSessionId();
    await Promise.all([
      writeFile(
        path.join(workspace, "eligible-a.txt"),
        `normal-pressure-marker-a\n${"a".repeat(12 * 1_024)}`,
        "utf8",
      ),
      writeFile(
        path.join(workspace, "eligible-b.txt"),
        `normal-pressure-marker-b\n${"b".repeat(12 * 1_024)}`,
        "utf8",
      ),
    ]);
    const sink = collectingEventSink();
    const model = new UnprofiledContextModel();
    const session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId },
        workspaceRoot: workspace,
        modelName: "test-model",
        maxIterations: 4,
        includeReasoningContent: false,
        contextProfile: CONTEXT_PROFILE,
        contextBudget: CONTEXT_BUDGET,
        systemPrompt: "system",
        modelClient: model,
        presentationSinks: [sink],
        persistence: false,
      },
      { loadMcpConfig: async () => undefined },
    );
    try {
      expect(
        await session.executeTurn({
          userMessage: { role: "user", content: "swap without automation" },
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ status: "completed", finalText: "unprofiled swap verified" });
      expect(model.listingPressure).toBe("normal");
      expect(model.sawPlaceholder).toBe(true);
      const directed = sink.events.filter(
        (event) =>
          event.type === "context.revision.finished" &&
          event.data.strategy === "swap" &&
          event.data.reason === "model_directed",
      );
      expect(directed).toHaveLength(1);
      expect(directed[0]?.data).toMatchObject({ addedOverrideCount: 2 });
      expect(
        sink.events.filter(
          (event) =>
            event.type === "context.revision.started" &&
            event.data.reason === "runtime_pressure",
        ),
      ).toHaveLength(0);
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });
});

class ModelDirectedContextModel extends TestModelClient {
  requestCount = 0;
  candidateId?: MessageId;
  candidateLabel?: string;
  candidateSavingsBytes?: number;
  source?: string;
  statusPressure?: string;
  recalledOriginal = false;
  readonly requests: AgentMessage[][] = [];

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    const input = testModelRequestInput(prepared);
    this.requests.push([...input.messages]);
    const toolNames = input.tools.map((tool) => tool.name);
    for (const name of ["ContextStatus", "ContextSwapCandidates", "ContextSwap"]) {
      expect(toolNames).toContain(name);
    }

    switch (this.requestCount) {
      case 1:
        return toolOutput(prepared, options, [
          { name: "Read", args: { file_path: "large.txt" } },
        ]);
      case 2: {
        const read = requireToolMessage(input.messages, "Read");
        expect(toolResultDisplayText(read.content)).toContain(ORIGINAL_MARKER);
        return toolOutput(prepared, options, [
          { name: "ContextStatus", args: {} },
          { name: "ContextSwapCandidates", args: {} },
        ]);
      }
      case 3: {
        const status = parseToolJson(input.messages, "ContextStatus");
        const listing = parseToolJson(input.messages, "ContextSwapCandidates");
        this.statusPressure = requireString(status.pressure, "status pressure");
        expect(this.statusPressure).toBe("high");
        const candidates = listing.candidates;
        if (!Array.isArray(candidates) || candidates.length !== 1) {
          throw new Error("Expected exactly one model-directed swap candidate.");
        }
        const candidate = candidates[0] as Record<string, unknown>;
        this.candidateId = parseMessageId(
          requireString(candidate.candidateId, "candidate ID"),
        );
        this.candidateLabel = requireString(candidate.label, "candidate label");
        this.candidateSavingsBytes = requireNumber(
          candidate.savingsBytes,
          "candidate savings",
        );
        expect(
          toolResultDisplayText(requireToolMessage(input.messages, "Read").content),
        ).not.toContain("[Tinker historical tool observation swapped]");
        return toolOutput(prepared, options, [
          {
            name: "ContextSwap",
            args: { candidate_ids: [this.candidateId] },
          },
        ]);
      }
      case 4: {
        const read = requireToolMessage(input.messages, "Read");
        const placeholder = toolResultDisplayText(read.content);
        expect(placeholder).toContain("[Tinker historical tool observation swapped]");
        expect(placeholder).not.toContain(ORIGINAL_MARKER);
        this.source = placeholder.match(/ctx:\/\/message\/[0-9a-f-]+/u)?.[0];
        const scheduled = parseToolJson(input.messages, "ContextSwap");
        expect(scheduled).toMatchObject({
          ok: true,
          scheduled: [{ candidateId: this.candidateId }],
          rejected: [],
        });
        return toolOutput(prepared, options, [
          {
            name: "RecallGet",
            args: { source: requireString(this.source, "swap source") },
          },
        ]);
      }
      case 5: {
        const recalled = toolResultDisplayText(
          requireToolMessage(input.messages, "RecallGet").content,
        );
        this.recalledOriginal = recalled.includes(ORIGINAL_MARKER);
        expect(this.recalledOriginal).toBe(true);
        return testModelOutput(prepared, {
          role: "assistant",
          content: "model-directed context verified",
        });
      }
      default:
        throw new Error("Unexpected model-directed fixture iteration.");
    }
  }
}

class ResumedRecallModel extends TestModelClient {
  requestCount = 0;
  sawPersistedContextTools = false;
  recalledOriginal = false;

  constructor(private readonly source: string) {
    super();
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    const input = testModelRequestInput(prepared);
    if (this.requestCount === 1) {
      const historicalTools = input.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.name);
      this.sawPersistedContextTools = [
        "ContextStatus",
        "ContextSwapCandidates",
        "ContextSwap",
      ].every((name) => historicalTools.includes(name));
      expect(this.sawPersistedContextTools).toBe(true);
      expect(
        toolResultDisplayText(requireToolMessage(input.messages, "Read").content),
      ).toContain("[Tinker historical tool observation swapped]");
      return toolOutput(prepared, options, [
        { name: "RecallGet", args: { source: this.source } },
      ]);
    }
    const recalled = toolResultDisplayText(
      requireToolMessage(input.messages, "RecallGet", true).content,
    );
    this.recalledOriginal = recalled.includes(ORIGINAL_MARKER);
    expect(this.recalledOriginal).toBe(true);
    return testModelOutput(prepared, {
      role: "assistant",
      content: "resumed context verified",
    });
  }
}

class UnprofiledContextModel extends TestModelClient {
  requestCount = 0;
  listingPressure?: string;
  sawPlaceholder = false;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    const input = testModelRequestInput(prepared);
    if (this.requestCount === 1) {
      return toolOutput(prepared, options, [
        { name: "Read", args: { file_path: "eligible-a.txt" } },
        { name: "Read", args: { file_path: "eligible-b.txt" } },
      ]);
    }
    if (this.requestCount === 2) {
      return toolOutput(prepared, options, [
        { name: "ContextStatus", args: {} },
        { name: "ContextSwapCandidates", args: {} },
      ]);
    }
    if (this.requestCount === 3) {
      const status = parseToolJson(input.messages, "ContextStatus");
      this.listingPressure = requireString(status.pressure, "listing pressure");
      const listing = parseToolJson(input.messages, "ContextSwapCandidates");
      const candidates = listing.candidates;
      if (!Array.isArray(candidates) || candidates.length !== 2) {
        throw new Error("Expected two unprofiled context candidates.");
      }
      return toolOutput(
        prepared,
        options,
        candidates.map((value) => {
          const candidate = value as Record<string, unknown>;
          return {
            name: "ContextSwap",
            args: {
              candidate_ids: [requireString(candidate.candidateId, "candidate ID")],
            },
          };
        }),
      );
    }
    const reads = input.messages.filter(
      (message): message is Extract<AgentMessage, { role: "tool" }> =>
        message.role === "tool" && message.name === "Read",
    );
    this.sawPlaceholder =
      reads.length === 2 &&
      reads.every((read) =>
        toolResultDisplayText(read.content).includes(
          "[Tinker historical tool observation swapped]",
        ),
      );
    expect(this.sawPlaceholder).toBe(true);
    return testModelOutput(prepared, {
      role: "assistant",
      content: "unprofiled swap verified",
    });
  }
}

function runtimeInput(
  workspaceRoot: string,
  sessionId: ReturnType<typeof runtimeIdFactory.createSessionId>,
  modelClient: TestModelClient,
  mode: "new" | "resume",
  sink: ReturnType<typeof collectingEventSink>,
) {
  const common = {
    workspaceRoot,
    modelName: "test-model",
    profileName: "deepseek-v4-flash",
    maxIterations: mode === "new" ? 5 : 2,
    includeReasoningContent: false,
    contextProfile: CONTEXT_PROFILE,
    contextBudget: CONTEXT_BUDGET,
    systemPrompt: "system",
    modelClient,
    presentationSinks: [sink],
    persistence: false as const,
  };
  return mode === "new"
    ? { ...common, selection: { mode, sessionId } }
    : { ...common, selection: { mode, sessionId } };
}

function toolOutput(
  prepared: PreparedModelRequest,
  options: ModelRequestOptions,
  calls: readonly { name: string; args: unknown }[],
): ModelRequestOutput {
  if (options.identity === undefined) {
    throw new Error("Context maintenance fixture has no runtime identity.");
  }
  const { iteration, runtimeSession } = options.identity;
  const message: AssistantMessage = {
    role: "assistant",
    toolCalls: calls.map((call, index) => ({
      ...runtimeSession.createToolCall(iteration, index + 1),
      providerToolCallId: `context-${iteration.iterationNumber}-${index + 1}`,
      ...call,
    })),
  };
  return testModelOutput(prepared, message, "tool_calls");
}

function requireToolMessage(
  messages: readonly AgentMessage[],
  name: string,
  latest = false,
): Extract<AgentMessage, { role: "tool" }> {
  const matches = messages.filter(
    (message): message is Extract<AgentMessage, { role: "tool" }> =>
      message.role === "tool" && message.name === name,
  );
  const result = latest ? matches.at(-1) : matches[0];
  if (result === undefined) throw new Error(`Missing ${name} tool message.`);
  return result;
}

function parseToolJson(
  messages: readonly AgentMessage[],
  name: string,
): Record<string, unknown> {
  return JSON.parse(
    toolResultDisplayText(requireToolMessage(messages, name, true).content),
  ) as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`Expected ${name}.`);
  }
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected ${name}.`);
  }
  return value;
}

function requireEventSequence(
  event: { readonly eventSequence: number } | undefined,
  name: string,
): number {
  if (event === undefined) throw new Error(`Missing ${name}.`);
  return event.eventSequence;
}
