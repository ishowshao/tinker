import { InMemorySessionConversation } from "../src/agent/session-conversation";
import type { ToolCall } from "../src/agent/types";
import type { AgentEvent } from "../src/events/types";
import type {
  IterationId,
  SessionId,
  ToolCallId,
  TurnId,
} from "../src/ids/runtime-id";
import { visibleTimelineItems } from "../src/tui/event-store";
import { defaultTuiProjectionPolicy } from "../src/tui/tui-projection-policy";
import { TuiProjectionStore } from "../src/tui/tui-projection-store";

const turnCount = parseTurnCount(Bun.argv[2]);
const iterationCount = 3;
const sessionId = "long-session-benchmark" as SessionId;
const conversation = new InMemorySessionConversation("benchmark system prompt");
const projection = new TuiProjectionStore({
  sessionId,
  modelName: "benchmark-model",
  workspaceRoot: process.cwd(),
});
const rawPayload = "raw-payload-".repeat(10_000);
let eventSequence = 0;
let processedEventCount = 0;
let materializedRequestCount = 0;
let maxMaterializedMessageCount = 0;
let maxVisibleItemCount = 0;
let reducerMs = 0;
let visibleProjectionMs = 0;
const samples: BenchmarkSample[] = [];

Bun.gc(true);
const before = memorySnapshot();
const benchmarkStartedAt = performance.now();

for (let turnNumber = 1; turnNumber <= turnCount; turnNumber += 1) {
  const turn = turnIdentity(turnNumber);
  const pending = conversation.beginTurn(`benchmark prompt ${turnNumber}`);
  await appendProjectionEvent({
    type: "turn.started",
    ...turn,
    eventSequence: nextEventSequence(),
    timestamp: eventTimestamp(eventSequence),
    data: { userPrompt: `benchmark prompt ${turnNumber}` },
  });

  let lastIteration = iterationIdentity(turnNumber, 1);
  for (
    let iterationNumber = 1;
    iterationNumber <= iterationCount;
    iterationNumber += 1
  ) {
    const iteration = iterationIdentity(turnNumber, iterationNumber);
    const call = toolCall(turnNumber, iterationNumber);
    lastIteration = iteration;

    const request = pending.agent.buildModelRequest([]);
    materializedRequestCount += 1;
    maxMaterializedMessageCount = Math.max(
      maxMaterializedMessageCount,
      request.messages.length,
    );
    await appendProjectionEvent(modelStarted(iteration));

    const assistantMessage = {
      role: "assistant" as const,
      content: `benchmark progress ${turnNumber}.${iterationNumber}`,
      toolCalls: [call],
    };
    pending.agent.appendAssistant(assistantMessage);
    await appendProjectionEvent({
      type: "model.request.finished",
      ...iteration,
      eventSequence: nextEventSequence(),
      timestamp: eventTimestamp(eventSequence),
      data: {
        output: {
          message: assistantMessage,
          rawResponse: { body: `${rawPayload}${turnNumber}.${iterationNumber}` },
        },
      },
    });
    await appendProjectionEvent({
      type: "assistant.progress",
      ...iteration,
      eventSequence: nextEventSequence(),
      timestamp: eventTimestamp(eventSequence),
      data: { content: assistantMessage.content },
    });
    await appendProjectionEvent({
      type: "tool.started",
      ...call,
      eventSequence: nextEventSequence(),
      timestamp: eventTimestamp(eventSequence),
      data: { call },
    });
    await appendProjectionEvent({
      type: "tool.raw_result",
      ...call,
      eventSequence: nextEventSequence(),
      timestamp: eventTimestamp(eventSequence),
      data: {
        call,
        raw: {
          kind: "mcp",
          ok: true,
          toolName: "mcp__benchmark__large_result",
          serverName: "benchmark",
          serverToolName: "large_result",
          text: `${rawPayload}${iterationNumber}.${turnNumber}`,
          contentBlockCount: 1,
        },
      },
    });
    await appendProjectionEvent({
      type: "tool.finished",
      ...call,
      eventSequence: nextEventSequence(),
      timestamp: eventTimestamp(eventSequence),
      data: { call, ok: true },
    });

    const observation = `benchmark observation ${turnNumber}.${iterationNumber}`;
    pending.agent.appendTool({
      role: "tool",
      toolCallId: call.toolCallId,
      providerToolCallId: call.providerToolCallId,
      name: call.name,
      content: observation,
    });
    await appendProjectionEvent({
      type: "tool.observation",
      ...call,
      eventSequence: nextEventSequence(),
      timestamp: eventTimestamp(eventSequence),
      data: { call, observation: { content: `${observation}\n${rawPayload}` } },
    });
  }

  const finalText = `benchmark answer ${turnNumber}`;
  pending.agent.appendAssistant({ role: "assistant", content: finalText });
  const messageCount = pending.projectedMessageCount();
  await appendProjectionEvent({
    type: "turn.finished",
    ...turn,
    eventSequence: nextEventSequence(),
    timestamp: eventTimestamp(eventSequence),
    data: {
      status: "completed",
      finalText,
      lastIteration,
      messageCount,
    },
  });
  pending.commit();

  if (turnNumber % 10 === 0 || turnNumber === turnCount) {
    samples.push({
      turn: turnNumber,
      committedMessageCount: conversation.committedMessageCount(),
      visibleItemCount: visibleTimelineItems(projection.getSnapshot()).length,
      recentTurnCount: projection.getSnapshot().recentTurns.length,
      ...memorySnapshot(),
    });
  }
}

Bun.gc(true);
const after = memorySnapshot();
const snapshot = projection.getSnapshot();

console.log(
  JSON.stringify(
    {
      note: "F1 intentionally keeps canonical conversation in memory; only the turn delta and TUI projection are bounded.",
      turnCount,
      iterationCount,
      committedMessageCount: conversation.committedMessageCount(),
      materializedRequestCount,
      maxMaterializedMessageCount,
      processedEventCount,
      projection: {
        policy: defaultTuiProjectionPolicy,
        recentTurnCount: snapshot.recentTurns.length,
        omittedTurnCount: snapshot.omittedTurnCount,
        noticeCount: snapshot.notices.length,
        backgroundTaskCount: snapshot.backgroundTasks.length,
        visibleItemCount: visibleTimelineItems(snapshot).length,
        maxVisibleItemCount,
      },
      timingMs: {
        total: round(performance.now() - benchmarkStartedAt),
        reducer: round(reducerMs),
        visibleProjection: round(visibleProjectionMs),
      },
      memoryBytes: { before, after },
      samples,
    },
    null,
    2,
  ),
);

async function appendProjectionEvent(event: AgentEvent): Promise<void> {
  const reducerStartedAt = performance.now();
  await projection.append(event);
  reducerMs += performance.now() - reducerStartedAt;
  processedEventCount += 1;

  const projectionStartedAt = performance.now();
  const visibleItems = visibleTimelineItems(projection.getSnapshot());
  visibleProjectionMs += performance.now() - projectionStartedAt;
  maxVisibleItemCount = Math.max(maxVisibleItemCount, visibleItems.length);
}

function modelStarted(
  iteration: ReturnType<typeof iterationIdentity>,
): AgentEvent {
  return {
    type: "model.request.started",
    ...iteration,
    eventSequence: nextEventSequence(),
    timestamp: eventTimestamp(eventSequence),
    data: {},
  };
}

function turnIdentity(turnNumber: number) {
  return {
    sessionId,
    turnId: `benchmark-turn-${turnNumber}` as TurnId,
    turnNumber,
  };
}

function iterationIdentity(turnNumber: number, iterationNumber: number) {
  return {
    ...turnIdentity(turnNumber),
    iterationId:
      `benchmark-turn-${turnNumber}-iteration-${iterationNumber}` as IterationId,
    iterationNumber,
  };
}

function toolCall(turnNumber: number, iterationNumber: number): ToolCall {
  return {
    ...iterationIdentity(turnNumber, iterationNumber),
    toolCallId:
      `benchmark-turn-${turnNumber}-iteration-${iterationNumber}-tool-1` as ToolCallId,
    toolCallNumber: 1,
    providerToolCallId: `benchmark-provider-${turnNumber}-${iterationNumber}`,
    name: "mcp__benchmark__large_result",
    args: { turnNumber, iterationNumber },
  };
}

function nextEventSequence(): number {
  eventSequence += 1;
  return eventSequence;
}

function eventTimestamp(sequence: number): string {
  return new Date(Date.UTC(2026, 6, 11, 0, 0, sequence)).toISOString();
}

function parseTurnCount(value: string | undefined): number {
  const parsed = value === undefined ? 100 : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Benchmark turn count must be a positive integer.");
  }
  return parsed;
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return { rss: memory.rss, heapUsed: memory.heapUsed };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

type BenchmarkSample = {
  turn: number;
  committedMessageCount: number;
  visibleItemCount: number;
  recentTurnCount: number;
  rss: number;
  heapUsed: number;
};
