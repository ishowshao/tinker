import { Database } from "bun:sqlite";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRuntimeSession,
  type CreateRuntimeSessionInput,
  type RuntimeSession,
  type RuntimeSessionFactoryDependencies,
} from "../src/agent/runtime-session";
import type {
  AgentTurnLedger,
  PendingLedgerTurn,
  SessionLedger,
} from "../src/agent/session-ledger";
import type { AssistantMessage, ToolCall } from "../src/agent/types";
import type { EventSink } from "../src/events/event-sink";
import type { AgentEvent } from "../src/events/types";
import { runtimeIdFactory, type SessionId } from "../src/ids/runtime-id";
import type {
  ModelClient,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../src/model/model-client";
import {
  deriveModelContextBudget,
  type ModelContextProfile,
} from "../src/model/model-context-profile";
import { OpenAIChatModelClient } from "../src/model/openai-chat-model-client";
import { estimatePromptSegments } from "../src/model/token-estimator";
import type { ProtocolContextView } from "../src/context/protocol-frame";
import { SqliteSessionLedger } from "../src/session/sqlite-session-ledger";
import { createDefaultTooling } from "../src/tools/registry";
import type { ToolDefinition } from "../src/tools/types";
import { visibleTimelineItems } from "../src/tui/event-store";
import { defaultTuiProjectionPolicy } from "../src/tui/tui-projection-policy";
import { TuiProjectionStore } from "../src/tui/tui-projection-store";

const benchmarkModelName = "g0-benchmark-model";
const benchmarkProfileName = "g0-benchmark";
const benchmarkSystemPrompt =
  "You are running the deterministic Tinker G0 long-session benchmark.";
const benchmarkDataFile = "benchmark-data.txt";
const historicalMarker = "historical-marker-turn-0001";

const benchmarkContextProfile: ModelContextProfile = {
  contextWindowTokens: 1_024 * 1_024,
  maxSupportedOutputTokens: 128 * 1_024,
};
const benchmarkContextBudget = deriveModelContextBudget(benchmarkContextProfile);

export type LongSessionBenchmarkResult = {
  workloadTurnCount: number;
  totalStoredTurnCount: number;
  completedWorkloadTurns: number;
  cancelledTurnVerified: boolean;
  resumeVerified: boolean;
  recallVerified: boolean;
  database: {
    schemaVersion: number;
    turnCount: number;
    messageCount: number;
    frameCount: number;
    toolResultCount: number;
    contentBytesByRole: Record<string, { count: number; bytes: number }>;
    toolObservationBytes: Distribution;
    measuredContextTokens?: number;
  };
  projection: {
    policy: typeof defaultTuiProjectionPolicy;
    recentTurnCount: number;
    omittedTurnCount: number;
    noticeCount: number;
    backgroundTaskCount: number;
    visibleItemCount: number;
    maxVisibleItemCount: number;
  };
  requests: {
    buildCount: number;
    maxMessageCount: number;
    lastMessageCount: number;
    promptSegmentCount: number;
  };
  events: {
    processed: number;
    counts: Record<string, number>;
  };
  timingMs: {
    total: number;
    turns: Distribution;
    requestBuild: Distribution;
    modelPrepare: Distribution;
    projectionAppend: Distribution;
    visibleProjection: Distribution;
    resume: number;
  };
  memoryBytes: {
    before: MemorySnapshot;
    after: MemorySnapshot;
    delta: MemorySnapshot;
  };
  storageBytes: {
    finalSessionDirectory: number;
  };
  samples: LongSessionSample[];
};

export async function runLongSessionBenchmark(
  workloadTurnCount = 50,
): Promise<LongSessionBenchmarkResult> {
  requirePositiveInteger(workloadTurnCount, "workload turn count");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-g0-long-session-"));
  const sessionId = runtimeIdFactory.createSessionId();
  const sessionDirectory = path.join(workspace, ".tinker", "sessions", sessionId);
  const databasePath = path.join(sessionDirectory, "session.sqlite");
  const ledgerMetrics = new LedgerMetrics();
  const model = new BenchmarkModelClient();
  const projection = new BenchmarkProjectionSink({
    sessionId,
    workspaceRoot: workspace,
  });
  const turnDurations: number[] = [];
  const samples: LongSessionSample[] = [];
  let session: RuntimeSession | undefined;
  let completedWorkloadTurns = 0;

  try {
    await writeBenchmarkData(workspace);
    Bun.gc(true);
    const memoryBefore = memorySnapshot();
    const benchmarkStartedAt = performance.now();
    session = await createBenchmarkSession({
      mode: "new",
      workspace,
      sessionId,
      model,
      projection,
      ledgerMetrics,
    });

    const resumeAfterTurn = Math.max(1, Math.floor(workloadTurnCount / 2));
    const sampleEvery = Math.max(1, Math.floor(workloadTurnCount / 5));
    let resumeMs = 0;

    for (let turnNumber = 1; turnNumber <= workloadTurnCount; turnNumber += 1) {
      const startedAt = performance.now();
      const result = await session.executeTurn({
        userPrompt: workloadPrompt(turnNumber),
        signal: new AbortController().signal,
      });
      turnDurations.push(performance.now() - startedAt);
      if (result.status !== "completed") {
        throw new Error(
          `Long-session workload turn ${turnNumber} ended with ${result.status}.`,
        );
      }
      completedWorkloadTurns += 1;

      if (turnNumber % sampleEvery === 0 || turnNumber === workloadTurnCount) {
        samples.push(
          await benchmarkSample({
            turn: turnNumber,
            sessionDirectory,
            ledgerMetrics,
            projection,
          }),
        );
      }

      if (turnNumber === resumeAfterTurn) {
        await session.dispose({ type: "tui_exit" });
        session = undefined;
        const resumeStartedAt = performance.now();
        session = await createBenchmarkSession({
          mode: "resume",
          workspace,
          sessionId,
          model,
          projection,
          ledgerMetrics,
        });
        resumeMs = performance.now() - resumeStartedAt;
        if (!session.resumed || session.recovery.syntheticCompletionCount !== 0) {
          throw new Error("Long-session benchmark did not resume cleanly.");
        }
      }
    }

    const cancellationController = new AbortController();
    const cancellationStartedAt = performance.now();
    const cancellation = session.executeTurn({
      userPrompt: "benchmark cancellation turn",
      signal: cancellationController.signal,
    });
    await model.waitForCancellationRequest();
    cancellationController.abort(new Error("G0 benchmark requested cancellation."));
    const cancelledResult = await cancellation;
    turnDurations.push(performance.now() - cancellationStartedAt);
    if (cancelledResult.status !== "cancelled") {
      throw new Error("Long-session benchmark cancellation turn was not cancelled.");
    }

    const recallStartedAt = performance.now();
    const recallResult = await session.executeTurn({
      userPrompt: "benchmark Recall search and get turn",
      signal: new AbortController().signal,
    });
    turnDurations.push(performance.now() - recallStartedAt);
    if (
      recallResult.status !== "completed" ||
      !recallResult.finalText.includes(historicalMarker)
    ) {
      throw new Error("Long-session benchmark Recall did not recover its marker.");
    }

    await session.dispose({ type: "tui_exit" });
    session = undefined;
    Bun.gc(true);
    const memoryAfter = memorySnapshot();
    const database = readDatabaseSummary(databasePath);
    const finalSnapshot = projection.store.getSnapshot();
    assertBoundedProjection(finalSnapshot);

    return {
      workloadTurnCount,
      totalStoredTurnCount: workloadTurnCount + 2,
      completedWorkloadTurns,
      cancelledTurnVerified: true,
      resumeVerified: true,
      recallVerified: true,
      database,
      projection: {
        policy: defaultTuiProjectionPolicy,
        recentTurnCount: finalSnapshot.recentTurns.length,
        omittedTurnCount: finalSnapshot.omittedTurnCount,
        noticeCount: finalSnapshot.notices.length,
        backgroundTaskCount: finalSnapshot.backgroundTasks.length,
        visibleItemCount: visibleTimelineItems(finalSnapshot).length,
        maxVisibleItemCount: projection.maxVisibleItemCount,
      },
      requests: {
        buildCount: ledgerMetrics.buildDurations.length,
        maxMessageCount: ledgerMetrics.maxMessageCount,
        lastMessageCount: ledgerMetrics.lastMessageCount,
        promptSegmentCount: model.maxPromptSegmentCount,
      },
      events: {
        processed: projection.processedEventCount,
        counts: Object.fromEntries(
          [...projection.eventCounts.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      },
      timingMs: {
        total: round(performance.now() - benchmarkStartedAt),
        turns: distribution(turnDurations),
        requestBuild: distribution(ledgerMetrics.buildDurations),
        modelPrepare: distribution(model.prepareDurations),
        projectionAppend: distribution(projection.appendDurations),
        visibleProjection: distribution(projection.visibleDurations),
        resume: round(resumeMs),
      },
      memoryBytes: {
        before: memoryBefore,
        after: memoryAfter,
        delta: {
          rss: memoryAfter.rss - memoryBefore.rss,
          heapUsed: memoryAfter.heapUsed - memoryBefore.heapUsed,
        },
      },
      storageBytes: {
        finalSessionDirectory: await directorySize(sessionDirectory),
      },
      samples,
    };
  } finally {
    if (session !== undefined) {
      await session
        .dispose({
          type: "runner_failed",
          error: "G0 long-session benchmark cleanup",
        })
        .catch(() => undefined);
    }
    await rm(workspace, { recursive: true });
  }
}

class BenchmarkModelClient implements ModelClient {
  readonly prepareDurations: number[] = [];
  maxPromptSegmentCount = 0;
  private readonly inputs = new WeakMap<object, ModelRequestInput>();
  private readonly serializer = new OpenAIChatModelClient({
    apiKey: "g0-benchmark-no-network",
    baseURL: "https://benchmark.invalid/v1",
    contextBudget: benchmarkContextBudget,
    includeReasoningContent: false,
    model: benchmarkModelName,
    providerName: "g0-openai-compatible",
  });
  private cancellationRequestResolve!: () => void;
  private readonly cancellationRequest = new Promise<void>((resolve) => {
    this.cancellationRequestResolve = resolve;
  });

  prepare(input: ModelRequestInput): PreparedModelRequest {
    const startedAt = performance.now();
    const prepared = this.serializer.prepare(input);
    this.prepareDurations.push(performance.now() - startedAt);
    this.maxPromptSegmentCount = Math.max(
      this.maxPromptSegmentCount,
      prepared.promptSegments.length,
    );
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
    const input = this.inputs.get(prepared);
    if (input === undefined) {
      throw new Error("Benchmark model request was not prepared by this client.");
    }
    const userPrompt = lastUserPrompt(input.messages);
    if (userPrompt === "benchmark cancellation turn") {
      this.cancellationRequestResolve();
      return waitForAbort(options.signal);
    }
    if (userPrompt === "benchmark Recall search and get turn") {
      return this.recallResponse(input, prepared, options);
    }
    return this.workloadResponse(input, prepared, options, userPrompt);
  }

  waitForCancellationRequest(): Promise<void> {
    return this.cancellationRequest;
  }

  private workloadResponse(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
    userPrompt: string,
  ): ModelRequestOutput {
    const match = /benchmark workload turn (\d+)/.exec(userPrompt);
    if (match === null) {
      throw new Error(`Unexpected benchmark user prompt: ${userPrompt}`);
    }
    const turnNumber = Number(match[1]);
    const toolMessages = messagesAfterLastUser(input.messages).filter(
      (
        message,
      ): message is Extract<ModelRequestInput["messages"][number], { role: "tool" }> =>
        message.role === "tool",
    );
    if (toolMessages.length === 0) {
      return outputWithUsage(
        prepared,
        {
          role: "assistant",
          content: `Inspecting deterministic fixture for turn ${turnNumber}.`,
          toolCalls: [benchmarkToolCall(turnNumber, options)],
        },
        "tool_calls",
      );
    }
    return outputWithUsage(
      prepared,
      {
        role: "assistant",
        content: `Completed benchmark workload turn ${turnNumber}.`,
      },
      "stop",
    );
  }

  private recallResponse(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    const recallMessages = messagesAfterLastUser(input.messages).filter(
      (
        message,
      ): message is Extract<ModelRequestInput["messages"][number], { role: "tool" }> =>
        message.role === "tool" && message.name === "Recall",
    );
    const latest = recallMessages.at(-1);
    if (latest === undefined) {
      return outputWithUsage(
        prepared,
        {
          role: "assistant",
          toolCalls: [
            benchmarkCall(options, "Recall", "recall-search", {
              mode: "search",
              query: historicalMarker,
              limit: 5,
              offset: 0,
            }),
          ],
        },
        "tool_calls",
      );
    }
    if (latest.content.startsWith("Recall searched historical session data.")) {
      const source = latest.content.match(
        /^source=(ctx:\/\/message\/[0-9a-f-]+)$/m,
      )?.[1];
      if (source === undefined) {
        throw new Error("Benchmark Recall search returned no stable source.");
      }
      return outputWithUsage(
        prepared,
        {
          role: "assistant",
          toolCalls: [
            benchmarkCall(options, "Recall", "recall-get", {
              mode: "get",
              source,
              byte_offset: 0,
              byte_limit: 12_000,
            }),
          ],
        },
        "tool_calls",
      );
    }
    if (!latest.content.includes(historicalMarker)) {
      throw new Error("Benchmark Recall get returned the wrong historical content.");
    }
    return outputWithUsage(
      prepared,
      {
        role: "assistant",
        content: `Recall recovered ${historicalMarker}.`,
      },
      "stop",
    );
  }
}

class LedgerMetrics {
  readonly buildDurations: number[] = [];
  maxMessageCount = 0;
  lastMessageCount = 0;

  record<T extends ModelRequestInput>(startedAt: number, request: T): T {
    this.buildDurations.push(performance.now() - startedAt);
    this.lastMessageCount = request.messages.length;
    this.maxMessageCount = Math.max(this.maxMessageCount, request.messages.length);
    return request;
  }
}

class TimedSessionLedger implements SessionLedger {
  constructor(
    private readonly inner: SessionLedger,
    private readonly metrics: LedgerMetrics,
  ) {}

  beginTurn(input: Parameters<SessionLedger["beginTurn"]>[0]): PendingLedgerTurn {
    return new TimedPendingLedgerTurn(this.inner.beginTurn(input), this.metrics);
  }

  buildCommittedModelRequest(tools: readonly ToolDefinition[]): ModelRequestInput {
    const startedAt = performance.now();
    return this.metrics.record(startedAt, this.inner.buildCommittedModelRequest(tools));
  }

  buildCandidateModelRequest(
    userPrompt: string,
    tools: readonly ToolDefinition[],
  ): ModelRequestInput {
    const startedAt = performance.now();
    return this.metrics.record(
      startedAt,
      this.inner.buildCandidateModelRequest(userPrompt, tools),
    );
  }

  committedMessageCount(): number {
    return this.inner.committedMessageCount();
  }

  snapshot(options?: {
    fullIntegrity?: boolean;
    allowOpenTail?: boolean;
    allowFaulted?: boolean;
  }): ProtocolContextView {
    return this.inner.snapshot(options);
  }

  fault(error: unknown): void {
    this.inner.fault(error);
  }
}

class TimedPendingLedgerTurn implements PendingLedgerTurn {
  readonly agent: AgentTurnLedger;

  constructor(
    private readonly inner: PendingLedgerTurn,
    metrics: LedgerMetrics,
  ) {
    this.agent = {
      appendAssistant: (input) => inner.agent.appendAssistant(input),
      assertCanExecuteTool: (call) => inner.agent.assertCanExecuteTool(call),
      commitToolCompletions: (completions) =>
        inner.agent.commitToolCompletions(completions),
      buildModelRequest: (tools) => {
        const startedAt = performance.now();
        return metrics.record(startedAt, inner.agent.buildModelRequest(tools));
      },
    };
  }

  projectedMessageCount(): number {
    return this.inner.projectedMessageCount();
  }

  finish(result: Parameters<PendingLedgerTurn["finish"]>[0]): void {
    this.inner.finish(result);
  }

  fault(error: unknown): void {
    this.inner.fault(error);
  }
}

class BenchmarkProjectionSink implements EventSink {
  readonly name = "g0-benchmark-projection";
  readonly store: TuiProjectionStore;
  readonly eventCounts = new Map<string, number>();
  readonly appendDurations: number[] = [];
  readonly visibleDurations: number[] = [];
  processedEventCount = 0;
  maxVisibleItemCount = 0;

  constructor(input: { sessionId: SessionId; workspaceRoot: string }) {
    this.store = new TuiProjectionStore({
      sessionId: input.sessionId,
      modelName: benchmarkModelName,
      workspaceRoot: input.workspaceRoot,
    });
  }

  async append(event: AgentEvent): Promise<void> {
    const appendStartedAt = performance.now();
    await this.store.append(event);
    this.appendDurations.push(performance.now() - appendStartedAt);
    this.processedEventCount += 1;
    this.eventCounts.set(event.type, (this.eventCounts.get(event.type) ?? 0) + 1);

    const visibleStartedAt = performance.now();
    const visible = visibleTimelineItems(this.store.getSnapshot());
    this.visibleDurations.push(performance.now() - visibleStartedAt);
    this.maxVisibleItemCount = Math.max(this.maxVisibleItemCount, visible.length);
  }
}

async function createBenchmarkSession(input: {
  mode: "new" | "resume";
  workspace: string;
  sessionId: SessionId;
  model: BenchmarkModelClient;
  projection: BenchmarkProjectionSink;
  ledgerMetrics: LedgerMetrics;
}): Promise<RuntimeSession> {
  const common = {
    workspaceRoot: input.workspace,
    modelName: benchmarkModelName,
    profileName: benchmarkProfileName,
    maxIterations: 8,
    includeReasoningContent: false,
    contextProfile: benchmarkContextProfile,
    contextBudget: benchmarkContextBudget,
    modelClient: input.model,
    presentationSinks: [input.projection],
  };
  const sessionInput: CreateRuntimeSessionInput =
    input.mode === "new"
      ? {
          ...common,
          selection: { mode: "new", sessionId: input.sessionId },
          systemPrompt: benchmarkSystemPrompt,
        }
      : {
          ...common,
          selection: { mode: "resume", sessionId: input.sessionId },
        };
  const dependencies: Partial<RuntimeSessionFactoryDependencies> = {
    loadMcpConfig: async () => undefined,
    createTooling: (options) => createDefaultTooling({ ...options, exaApiKey: "" }),
    createLedger: (store, idFactory) =>
      new TimedSessionLedger(
        new SqliteSessionLedger(store, idFactory),
        input.ledgerMetrics,
      ),
  };
  return createRuntimeSession(sessionInput, dependencies);
}

function benchmarkToolCall(turnNumber: number, options: ModelRequestOptions): ToolCall {
  const toolIndex = (turnNumber - 1) % 3;
  if (toolIndex === 0) {
    return benchmarkCall(options, "Read", `read-${turnNumber}`, {
      file_path: benchmarkDataFile,
      offset: 1,
      limit: 80,
    });
  }
  if (toolIndex === 1) {
    return benchmarkCall(options, "Grep", `grep-${turnNumber}`, {
      pattern: "benchmark-shared-marker",
      path: benchmarkDataFile,
      output_mode: "content",
      head_limit: 40,
    });
  }
  return benchmarkCall(options, "Bash", `bash-${turnNumber}`, {
    command: `sed -n '1,80p' ${benchmarkDataFile}`,
    description: "Read deterministic benchmark data",
    timeout: 5_000,
  });
}

function benchmarkCall(
  options: ModelRequestOptions,
  name: string,
  providerSuffix: string,
  args: unknown,
): ToolCall {
  const identity = options.identity;
  if (identity === undefined) {
    throw new Error("Benchmark tool call requires runtime identity.");
  }
  return {
    ...identity.runtimeSession.createToolCall(identity.iteration, 1),
    providerToolCallId: `g0-${providerSuffix}`,
    name,
    args,
  };
}

function outputWithUsage(
  prepared: PreparedModelRequest,
  message: AssistantMessage,
  finishReason: string,
): ModelRequestOutput {
  const promptTokens = estimatePromptSegments(prepared.promptSegments).totalTokens;
  const completionTokens = Math.max(
    1,
    estimatePromptSegments(prepared.assistantReplaySegments(message)).totalTokens,
  );
  return {
    message,
    finishReason,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Benchmark model request aborted."),
      );
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function lastUserPrompt(messages: ModelRequestInput["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.content;
    }
  }
  throw new Error("Benchmark model request has no user message.");
}

function messagesAfterLastUser(
  messages: ModelRequestInput["messages"],
): ModelRequestInput["messages"] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return messages.slice(index + 1);
    }
  }
  throw new Error("Benchmark model request has no user message.");
}

function workloadPrompt(turnNumber: number): string {
  const suffix = turnNumber.toString().padStart(4, "0");
  return `benchmark workload turn ${turnNumber}; historical-marker-turn-${suffix}`;
}

async function writeBenchmarkData(workspace: string): Promise<void> {
  const lines = Array.from({ length: 240 }, (_, index) => {
    const lineNumber = (index + 1).toString().padStart(4, "0");
    return `benchmark-shared-marker line-${lineNumber} ${"x".repeat(140)}`;
  });
  await writeFile(path.join(workspace, benchmarkDataFile), `${lines.join("\n")}\n`);
}

async function benchmarkSample(input: {
  turn: number;
  sessionDirectory: string;
  ledgerMetrics: LedgerMetrics;
  projection: BenchmarkProjectionSink;
}): Promise<LongSessionSample> {
  const snapshot = input.projection.store.getSnapshot();
  return {
    turn: input.turn,
    lastRequestMessageCount: input.ledgerMetrics.lastMessageCount,
    recentTurnCount: snapshot.recentTurns.length,
    visibleItemCount: visibleTimelineItems(snapshot).length,
    usedInputTokens: snapshot.contextUsage?.usedInputTokens,
    sessionStorageBytes: await directorySize(input.sessionDirectory),
    ...memorySnapshot(),
  };
}

function readDatabaseSummary(
  databasePath: string,
): LongSessionBenchmarkResult["database"] {
  const database = new Database(databasePath, {
    readonly: true,
    strict: true,
    safeIntegers: true,
  });
  try {
    const meta = database.query("SELECT schema_version FROM session_meta").get() as {
      schema_version: number | bigint;
    };
    const counts = database
      .query(
        `SELECT
          (SELECT COUNT(*) FROM turns) AS turn_count,
          (SELECT COUNT(*) FROM messages) AS message_count,
          (SELECT COUNT(*) FROM protocol_frames) AS frame_count,
          (SELECT COUNT(*) FROM tool_results) AS tool_result_count`,
      )
      .get() as Record<string, number | bigint>;
    const roleRows = database
      .query(
        `SELECT role, COUNT(*) AS count, COALESCE(SUM(length(content)), 0) AS bytes
         FROM messages GROUP BY role ORDER BY role`,
      )
      .all() as Array<{
      role: string;
      count: number | bigint;
      bytes: number | bigint;
    }>;
    const toolObservationLengths = database
      .query(
        `SELECT length(content) AS bytes FROM messages
         WHERE role = 'tool' AND content IS NOT NULL ORDER BY bytes`,
      )
      .all()
      .map((row) => numberFromDatabase((row as { bytes: number | bigint }).bytes));
    const measured = database
      .query("SELECT total_tokens FROM context_measurement_state")
      .get() as { total_tokens: number | bigint } | null;
    return {
      schemaVersion: numberFromDatabase(meta.schema_version),
      turnCount: numberFromDatabase(counts.turn_count),
      messageCount: numberFromDatabase(counts.message_count),
      frameCount: numberFromDatabase(counts.frame_count),
      toolResultCount: numberFromDatabase(counts.tool_result_count),
      contentBytesByRole: Object.fromEntries(
        roleRows.map((row) => [
          row.role,
          {
            count: numberFromDatabase(row.count),
            bytes: numberFromDatabase(row.bytes),
          },
        ]),
      ),
      toolObservationBytes: distribution(toolObservationLengths),
      ...(measured === null
        ? {}
        : { measuredContextTokens: numberFromDatabase(measured.total_tokens) }),
    };
  } finally {
    database.close();
  }
}

function assertBoundedProjection(
  snapshot: ReturnType<TuiProjectionStore["getSnapshot"]>,
): void {
  if (snapshot.recentTurns.length > defaultTuiProjectionPolicy.recentTurnLimit) {
    throw new Error("Long-session benchmark TUI retained too many recent turns.");
  }
  if (snapshot.notices.length > defaultTuiProjectionPolicy.sessionNoticeLimit) {
    throw new Error("Long-session benchmark TUI retained too many notices.");
  }
  if (
    snapshot.recentTurns.some(
      (turn) => turn.items.length > defaultTuiProjectionPolicy.itemLimitPerTurn,
    )
  ) {
    throw new Error("Long-session benchmark TUI retained too many turn items.");
  }
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(entryPath);
    } else if (entry.isFile()) {
      total += (await stat(entryPath)).size;
    }
  }
  return total;
}

function memorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();
  return { rss: memory.rss, heapUsed: memory.heapUsed };
}

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) {
    return { count: 0, total: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    total: round(total),
    mean: round(total / sorted.length),
    p50: round(sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0),
    p95: round(sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0),
    max: round(sorted.at(-1) ?? 0),
  };
}

function numberFromDatabase(value: number | bigint | undefined): number {
  if (value === undefined) {
    throw new Error("Benchmark database query returned no numeric value.");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Benchmark database value is invalid: ${String(value)}.`);
  }
  return number;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

type Distribution = {
  count: number;
  total: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
};

type MemorySnapshot = {
  rss: number;
  heapUsed: number;
};

type LongSessionSample = MemorySnapshot & {
  turn: number;
  lastRequestMessageCount: number;
  recentTurnCount: number;
  visibleItemCount: number;
  usedInputTokens?: number;
  sessionStorageBytes: number;
};

if (import.meta.main) {
  const workloadTurnCount = parsePositiveInteger(Bun.argv[2], 50);
  console.log(
    JSON.stringify(await runLongSessionBenchmark(workloadTurnCount), null, 2),
  );
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  requirePositiveInteger(parsed, "long-session benchmark turn count");
  return parsed;
}
