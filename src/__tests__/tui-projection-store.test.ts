import { describe, expect, test } from "bun:test";
import type { ToolCall } from "../agent/types";
import type { AgentEvent } from "../events/types";
import type { IterationId, SessionId, ToolCallId, TurnId } from "../ids/runtime-id";
import type { ShellTaskSnapshot, ShellTaskStatus } from "../tools/bash-task";
import { visibleTimelineItems } from "../tui/event-store";
import type { TuiProjectionPolicy } from "../tui/tui-projection-policy";
import {
  isAssistantStreamSectionItem,
  TuiProjectionStore,
} from "../tui/tui-projection-store";
import { TEST_CONTEXT_BUDGET, TEST_CONTEXT_PROFILE } from "./test-runtime";
import type { ContextUsageSnapshot } from "../agent/context-meter";

const sessionId = "projection-session" as SessionId;
const smallPolicy: TuiProjectionPolicy = {
  recentTurnLimit: 3,
  itemLimitPerTurn: 3,
  sessionNoticeLimit: 2,
  completedTaskLimit: 1,
};

describe("TuiProjectionStore", () => {
  test("keeps running items live and atomically commits their final form once", async () => {
    const store = createStore();
    const turn = turnIdentity(1);
    const iteration = iterationIdentity(1, 1);
    const call = toolCall(1, 1, 1, "Bash", {
      command: "printf 'done\\n'",
    });

    await store.append(turnStarted(1, turn, "run it"));
    expect(store.getLogSnapshot()).toMatchObject({
      committed: [{ label: "prompt", text: "run it", status: "text" }],
      live: [],
    });

    await store.append(modelStarted(2, iteration));
    const runningModel = store.getLogSnapshot();
    expect(
      runningModel.committed.map((item) => ("label" in item ? item.label : undefined)),
    ).toEqual(["prompt"]);
    expect(runningModel.live).toMatchObject([
      { text: "model iteration 1", status: "running" },
    ]);

    await store.append(modelFinished(3, iteration));
    expect(
      store
        .getLogSnapshot()
        .committed.map((item) => ("text" in item ? item.text : undefined)),
    ).toEqual(["run it", "model iteration 1 -> assistant response"]);
    expect(store.getLogSnapshot().live).toEqual([]);

    await store.append({
      type: "tool.started",
      ...call,
      eventSequence: 4,
      timestamp: timestamp(4),
      data: { call },
    });
    await store.append({
      type: "tool.raw_result",
      ...call,
      eventSequence: 5,
      timestamp: timestamp(5),
      data: {
        call,
        raw: {
          kind: "bash",
          ok: true,
          status: "completed",
          taskId: "task-1",
          sessionId,
          command: "printf 'done\\n'",
          cwd: "/tmp",
          exitCode: 0,
          signal: undefined,
          preview: "done\n",
          truncated: false,
          outputFilePath: "/tmp/task-1.log",
          outputBytes: 5,
          outputLines: 1,
        },
      },
    });
    expect(store.getLogSnapshot().live).toMatchObject([
      {
        status: "running",
        bash: { outputPreview: ["done", ""] },
      },
    ]);
    expect(
      store
        .getLogSnapshot()
        .committed.some((item) => item.id === `tool-${call.toolCallId}`),
    ).toBe(false);

    await store.append({
      type: "tool.finished",
      ...call,
      eventSequence: 6,
      timestamp: timestamp(6),
      data: {
        call,
        ok: true,
      },
    });
    const settled = store.getLogSnapshot();
    expect(settled.live).toEqual([]);
    expect(settled.committed.at(-1)).toMatchObject({
      id: `tool-${call.toolCallId}`,
      status: "ok",
      bash: { outputPreview: ["done", ""] },
    });
    expect(
      settled.committed.filter((item) => item.id === `tool-${call.toolCallId}`),
    ).toHaveLength(1);
  });

  test("hydrates visible history once, including its existing omission marker", async () => {
    const source = createStore(smallPolicy);
    let sequence = 0;
    for (let turnNumber = 1; turnNumber <= 5; turnNumber += 1) {
      const turn = turnIdentity(turnNumber);
      const iteration = iterationIdentity(turnNumber, 1);
      sequence += 1;
      await source.append(turnStarted(sequence, turn, `prompt ${turnNumber}`));
      sequence += 1;
      await source.append(
        turnFinished(sequence, turn, iteration, `answer ${turnNumber}`),
      );
    }
    const snapshot = source.getSnapshot();
    const resumed = createStore(smallPolicy);

    resumed.hydrate(snapshot);
    expect(resumed.getLogSnapshot().committed).toEqual(visibleTimelineItems(snapshot));
    expect(
      resumed
        .getLogSnapshot()
        .committed.filter((item) => item.id === "projection-omitted-turns"),
    ).toHaveLength(1);

    await resumed.append({
      type: "context.usage.updated",
      sessionId,
      eventSequence: sequence + 1,
      timestamp: timestamp(sequence + 1),
      data: { phase: "initial", snapshot: contextUsage(100) },
    });
    expect(
      resumed
        .getLogSnapshot()
        .committed.filter((item) => item.id === "projection-omitted-turns"),
    ).toHaveLength(1);
    expect(resumed.getLogSnapshot().live).toEqual([]);
  });

  test("keeps a stable snapshot and lets late subscribers read current state", async () => {
    const store = createStore();
    const initial = store.getSnapshot();
    expect(store.getSnapshot()).toBe(initial);

    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    await store.append(sessionStarted(1));

    expect(store.getSnapshot()).not.toBe(initial);
    expect(store.getSnapshot().modelName).toBe("event-model");
    expect(notifications).toBe(1);
    unsubscribe();

    let lateSnapshot = store.getSnapshot();
    const unsubscribeLate = store.subscribe(() => {
      lateSnapshot = store.getSnapshot();
    });
    expect(lateSnapshot.modelName).toBe("event-model");
    expect(lateSnapshot.workspaceRoot).toBe("/event/workspace");
    unsubscribeLate();
  });

  test("projects summaries without retaining provider or tool raw payloads", async () => {
    const store = createStore();
    const turn = turnIdentity(1);
    const iteration = iterationIdentity(1, 1);
    const call = toolCall(1, 1, 1, "WebFetch", {
      url: "https://example.com",
    });
    const providerSecret = "provider-secret-".repeat(1_000);
    const toolSecret = "tool-secret-".repeat(1_000);
    const observationSecret = "observation-secret-".repeat(1_000);

    await store.append(turnStarted(1, turn, "fetch the page"));
    await store.append({
      type: "model.request.started",
      ...iteration,
      eventSequence: 2,
      timestamp: timestamp(2),
      data: { attemptNumber: 1, maxAttempts: 2 },
    });
    await store.append({
      type: "model.request.finished",
      ...iteration,
      eventSequence: 3,
      timestamp: timestamp(3),
      data: {
        attemptNumber: 1,
        maxAttempts: 2,
        output: {
          message: { role: "assistant", toolCalls: [call] },
          usage: testUsage(),
          rawResponse: { body: providerSecret },
        },
      },
    });
    await store.append({
      type: "tool.started",
      ...call,
      eventSequence: 4,
      timestamp: timestamp(4),
      data: { call },
    });
    await store.append({
      type: "tool.raw_result",
      ...call,
      eventSequence: 5,
      timestamp: timestamp(5),
      data: {
        call,
        raw: {
          kind: "web_fetch",
          ok: true,
          url: "https://example.com",
          route: "local",
          content: toolSecret,
        },
      },
    });
    await store.append({
      type: "tool.observation",
      ...call,
      eventSequence: 6,
      timestamp: timestamp(6),
      data: {
        call,
        observation: { content: observationSecret },
      },
    });

    const serialized = JSON.stringify(store.getSnapshot());
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("tool-secret");
    expect(serialized).not.toContain("observation-secret");
    expect(serialized).not.toContain("rawResponse");
    expect(visibleTimelineItems(store.getSnapshot()).at(-1)?.text).toBe(
      "WebFetch https://example.com -> ok (local)",
    );
  });

  test("bounds turn items while preserving the prompt and current running item", async () => {
    const store = createStore({ ...smallPolicy, itemLimitPerTurn: 2 });
    const turn = turnIdentity(1);
    const first = iterationIdentity(1, 1);
    const second = iterationIdentity(1, 2);

    await store.append(turnStarted(1, turn, "prompt"));
    await store.append(modelStarted(2, first));
    await store.append(modelFinished(3, first));
    await store.append({
      type: "assistant.progress",
      ...first,
      eventSequence: 4,
      timestamp: timestamp(4),
      data: { content: "progress" },
    });
    await store.append(modelStarted(5, second));

    const active = store.getSnapshot().activeTurn;
    expect(active?.items).toHaveLength(2);
    expect(active?.items[0]?.label).toBe("prompt");
    expect(active?.items[1]?.status).toBe("running");
    expect(active?.omittedItemCount).toBe(2);

    await store.append(modelFinished(6, second));
    await store.append(turnFinished(7, turn, second, "done"));
    const finished = store.getSnapshot().recentTurns[0];
    expect(finished?.items).toHaveLength(2);
    expect(finished?.items[0]?.label).toBe("prompt");
    expect(finished?.items[1]?.text).toBe("done");
    expect(
      visibleTimelineItems(store.getSnapshot()).some((item) =>
        item.text.includes("full diagnostics remain on disk"),
      ),
    ).toBe(true);
  });

  test("keeps projection size flat across one thousand completed turns", async () => {
    const store = createStore(smallPolicy);
    let sequence = 0;

    for (let turnNumber = 1; turnNumber <= 1_000; turnNumber += 1) {
      const turn = turnIdentity(turnNumber);
      const iteration = iterationIdentity(turnNumber, 1);
      sequence += 1;
      await store.append(turnStarted(sequence, turn, `prompt ${turnNumber}`));
      sequence += 1;
      await store.append(
        turnFinished(sequence, turn, iteration, `answer ${turnNumber}`),
      );
    }

    for (let notice = 1; notice <= 5; notice += 1) {
      sequence += 1;
      await store.append({
        type: "mcp.server.connected",
        sessionId,
        eventSequence: sequence,
        timestamp: timestamp(sequence),
        data: { serverName: `server-${notice}`, toolCount: notice },
      });
    }

    const snapshot = store.getSnapshot();
    expect(snapshot.activeTurn).toBeUndefined();
    expect(snapshot.recentTurns).toHaveLength(smallPolicy.recentTurnLimit);
    expect(snapshot.omittedTurnCount).toBe(997);
    expect(snapshot.notices).toHaveLength(smallPolicy.sessionNoticeLimit);
    expect(
      snapshot.recentTurns.every(
        (turn) => turn.items.length <= smallPolicy.itemLimitPerTurn,
      ),
    ).toBe(true);
    expect(visibleTimelineItems(snapshot).length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(snapshot)).not.toContain('"events"');
  });

  test("keeps only the latest context snapshot across one thousand updates", async () => {
    const store = createStore();
    await store.append(sessionStarted(1));
    for (let index = 1; index <= 1_000; index += 1) {
      await store.append({
        type: "context.usage.updated",
        sessionId,
        eventSequence: index + 1,
        timestamp: timestamp(index + 1),
        data: {
          phase: "initial",
          snapshot: contextUsage(index),
        },
      });
    }

    const snapshot = store.getSnapshot();
    expect(snapshot.contextUsage?.usedInputTokens).toBe(1_000);
    expect(snapshot.recentTurns).toEqual([]);
    expect(snapshot.notices).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain('"contextUsageHistory"');
  });

  test("retains all active tasks and only the newest terminal task", async () => {
    const store = createStore(smallPolicy);
    const tasks = [
      taskSnapshot("active-1", "running", 1),
      taskSnapshot("active-2", "stopping", 2),
      taskSnapshot("done-1", "completed", 3),
      taskSnapshot("done-2", "failed", 4),
    ];

    for (const [index, task] of tasks.entries()) {
      await store.append(taskEvent(index + 1, task));
    }

    const retained = store.getSnapshot().backgroundTasks;
    expect(retained.map((task) => task.taskId)).toEqual([
      "done-2",
      "active-2",
      "active-1",
    ]);
    expect(
      retained.filter(
        (task) => task.status === "running" || task.status === "stopping",
      ),
    ).toHaveLength(2);
    expect(
      retained.filter(
        (task) => task.status !== "running" && task.status !== "stopping",
      ),
    ).toHaveLength(1);
  });

  test("shows unavailable Agent Skills as a session notice", async () => {
    const store = createStore();
    await store.append({
      type: "skills.updated",
      sessionId,
      eventSequence: 1,
      timestamp: timestamp(1),
      data: {
        reason: "resume",
        activated: [],
        refreshed: [],
        deactivated: [],
        unavailable: ["removed-skill"],
        revisionNumber: 2,
      },
    });

    expect(store.getSnapshot().notices).toMatchObject([
      {
        label: "skills",
        text: "skills updated -> unavailable removed-skill",
        status: "info",
      },
    ]);
  });

  test("buffers unsealed deltas without notifying and commits only at the next heading", async () => {
    const store = createStore();
    const turn = turnIdentity(1);
    const iteration = iterationIdentity(1, 1);
    await store.append(turnStarted(1, turn, "stream it"));
    await store.append(modelStarted(2, iteration));
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.updateAssistantTextDelta({
      ...iteration,
      attemptNumber: 1,
      content: "## First\nbody\n\n## Sec",
    });
    expect(notifications).toBe(0);
    expect(store.getLogSnapshot().committed).toHaveLength(1);

    store.updateAssistantTextDelta({
      ...iteration,
      attemptNumber: 1,
      content: "ond\n",
    });
    expect(notifications).toBe(1);
    const sections = store
      .getLogSnapshot()
      .committed.filter(isAssistantStreamSectionItem);
    expect(sections).toEqual([
      {
        kind: "assistant-stream-section",
        id: `assistant-stream-${iteration.iterationId}-1-1`,
        iterationId: iteration.iterationId,
        attemptNumber: 1,
        sectionNumber: 1,
        markdown: "## First\nbody\n\n",
        showAssistantLabel: true,
      },
    ]);
    unsubscribe();
  });

  test("flushes the successful tail and physically adopts canonical assistant items", async () => {
    const store = createStore();
    const turn = turnIdentity(1);
    const iteration = iterationIdentity(1, 1);
    const content = "## First\nbody\n\n## Second\ntail";
    await store.append(turnStarted(1, turn, "stream it"));
    await store.append(modelStarted(2, iteration));
    store.updateAssistantTextDelta({
      ...iteration,
      attemptNumber: 1,
      content,
    });

    await store.append(modelFinished(3, iteration, content));
    await store.append(turnFinished(4, turn, iteration, content));

    const committed = store.getLogSnapshot().committed;
    const sections = committed.filter(isAssistantStreamSectionItem);
    expect(sections.map((section) => section.markdown)).toEqual([
      "## First\nbody\n\n",
      "## Second\ntail",
    ]);
    expect(sections.map((section) => section.showAssistantLabel)).toEqual([
      true,
      false,
    ]);
    expect(
      committed.filter(
        (item) => !isAssistantStreamSectionItem(item) && item.label === "assistant",
      ),
    ).toEqual([]);
    expect(
      committed.some(
        (item) =>
          !isAssistantStreamSectionItem(item) &&
          item.text === "model iteration 1 -> assistant response",
      ),
    ).toBe(false);
    expect(store.getSnapshot().recentTurns[0]?.items).toMatchObject([
      { label: "prompt" },
      { status: "ok" },
      { label: "assistant", text: content },
    ]);

    const resumed = createStore();
    resumed.hydrate(store.getSnapshot());
    expect(
      resumed
        .getLogSnapshot()
        .committed.some((item) => isAssistantStreamSectionItem(item)),
    ).toBe(false);
    expect(
      resumed
        .getLogSnapshot()
        .committed.filter(
          (item) =>
            !isAssistantStreamSectionItem(item) &&
            item.label === "assistant" &&
            item.text === content,
        ),
    ).toHaveLength(1);
  });

  test("adopts formal assistant progress after streamed tool-call text", async () => {
    const store = createStore();
    const turn = turnIdentity(1);
    const iteration = iterationIdentity(1, 1);
    const content = "## Plan\nbody\n\n## Action\ntail";
    await store.append(turnStarted(1, turn, "stream progress"));
    await store.append(modelStarted(2, iteration));
    store.updateAssistantTextDelta({ ...iteration, attemptNumber: 1, content });
    await store.append(modelFinished(3, iteration, content));
    await store.append({
      type: "assistant.progress",
      ...iteration,
      eventSequence: 4,
      timestamp: timestamp(4),
      data: { content },
    });

    expect(
      store
        .getLogSnapshot()
        .committed.filter(
          (item) => !isAssistantStreamSectionItem(item) && item.label === "assistant",
        ),
    ).toEqual([]);
    expect(store.getSnapshot().activeTurn?.items.at(-1)).toMatchObject({
      label: "assistant",
      text: content,
    });
  });

  test("keeps the complete canonical Markdown path when nothing was sealed", async () => {
    const store = createStore();
    const turn = turnIdentity(1);
    const iteration = iterationIdentity(1, 1);
    const content = "## Only\nbody";
    await store.append(turnStarted(1, turn, "short response"));
    await store.append(modelStarted(2, iteration));
    store.updateAssistantTextDelta({ ...iteration, attemptNumber: 1, content });
    await store.append(modelFinished(3, iteration, content));
    await store.append(turnFinished(4, turn, iteration, content));

    expect(
      store
        .getLogSnapshot()
        .committed.map((item) =>
          isAssistantStreamSectionItem(item) ? item.kind : item.text,
        ),
    ).toEqual(["short response", "model iteration 1 -> assistant response", content]);
  });

  test("preserves sealed retry output, drops its tail, and labels the new attempt", async () => {
    const store = createStore();
    const turn = turnIdentity(1);
    const iteration = iterationIdentity(1, 1);
    await store.append(turnStarted(1, turn, "retry"));
    await store.append(modelStarted(2, iteration));
    store.updateAssistantTextDelta({
      ...iteration,
      attemptNumber: 1,
      content: "## Old one\nsealed\n\n## Old tail\ndiscard me",
    });
    await store.append({
      type: "model.request.failed",
      ...iteration,
      eventSequence: 3,
      timestamp: timestamp(3),
      data: {
        attemptNumber: 1,
        maxAttempts: 2,
        code: "provider_unavailable",
        retryDisposition: "scheduled",
        provider: "test",
        model: "test-model",
        error: "retry",
      },
    });
    await store.append(modelStarted(4, iteration, 2));
    store.updateAssistantTextDelta({
      ...iteration,
      attemptNumber: 1,
      content: "## stale\nignored\n\n## stale two\n",
    });
    const replacement = "## New one\nsealed\n\n## New tail\nkept";
    store.updateAssistantTextDelta({
      ...iteration,
      attemptNumber: 2,
      content: replacement,
    });
    await store.append(modelFinished(5, iteration, replacement, 2));

    const committed = store.getLogSnapshot().committed;
    const sections = committed.filter(isAssistantStreamSectionItem);
    expect(sections.map((section) => section.markdown)).toEqual([
      "## Old one\nsealed\n\n",
      "## New one\nsealed\n\n",
      "## New tail\nkept",
    ]);
    expect(sections.map((section) => section.showAssistantLabel)).toEqual([
      true,
      true,
      false,
    ]);
    expect(JSON.stringify(committed)).not.toContain("discard me");
    expect(JSON.stringify(committed)).not.toContain("stale");
    expect(
      committed.some(
        (item) =>
          !isAssistantStreamSectionItem(item) &&
          item.text === "assistant response interrupted · retrying",
      ),
    ).toBe(true);
  });

  test("keeps sealed output but never flushes the open tail on cancellation", async () => {
    const store = createStore();
    const turn = turnIdentity(1);
    const iteration = iterationIdentity(1, 1);
    await store.append(turnStarted(1, turn, "cancel"));
    await store.append(modelStarted(2, iteration));
    store.updateAssistantTextDelta({
      ...iteration,
      attemptNumber: 1,
      content: "## Kept\nsealed\n\n## Open tail\nnever print",
    });
    await store.append({
      type: "turn.cancelled",
      ...iteration,
      eventSequence: 3,
      timestamp: timestamp(3),
      data: {
        cancellation: {
          source: "user",
          phase: "model_request",
          iterationId: iteration.iterationId,
          iterationNumber: iteration.iterationNumber,
        },
      },
    });

    const serialized = JSON.stringify(store.getLogSnapshot().committed);
    expect(serialized).toContain("## Kept\\nsealed");
    expect(serialized).not.toContain("never print");
    expect(serialized).toContain("cancelled");
  });
});

function createStore(policy?: TuiProjectionPolicy): TuiProjectionStore {
  return new TuiProjectionStore({
    sessionId,
    modelName: "initial-model",
    workspaceRoot: "/initial/workspace",
    policy,
  });
}

function sessionStarted(eventSequence: number): AgentEvent {
  return {
    type: "session.started",
    sessionId,
    eventSequence,
    timestamp: timestamp(eventSequence),
    data: {
      workspaceRoot: "/event/workspace",
      model: "event-model",
      maxIterations: 10,
      includeReasoningContent: false,
      contextProfile: TEST_CONTEXT_PROFILE,
      contextBudget: TEST_CONTEXT_BUDGET,
      projectInstructions: {},
    },
  };
}

function turnIdentity(turnNumber: number) {
  return {
    sessionId,
    turnId: `turn-${turnNumber}` as TurnId,
    turnNumber,
  };
}

function iterationIdentity(turnNumber: number, iterationNumber: number) {
  return {
    ...turnIdentity(turnNumber),
    iterationId: `turn-${turnNumber}-iteration-${iterationNumber}` as IterationId,
    iterationNumber,
  };
}

function toolCall(
  turnNumber: number,
  iterationNumber: number,
  toolCallNumber: number,
  name: string,
  args: unknown,
): ToolCall {
  return {
    ...iterationIdentity(turnNumber, iterationNumber),
    toolCallId:
      `turn-${turnNumber}-iteration-${iterationNumber}-tool-${toolCallNumber}` as ToolCallId,
    toolCallNumber,
    providerToolCallId: `provider-${toolCallNumber}`,
    name,
    args,
  };
}

function turnStarted(
  eventSequence: number,
  turn: ReturnType<typeof turnIdentity>,
  userPrompt: string,
): AgentEvent {
  return {
    type: "turn.started",
    ...turn,
    eventSequence,
    timestamp: timestamp(eventSequence),
    data: {
      userPrompt: {
        version: 1,
        text: userPrompt,
        images: [],
        omittedImageCount: 0,
      },
    },
  };
}

function modelStarted(
  eventSequence: number,
  iteration: ReturnType<typeof iterationIdentity>,
  attemptNumber = 1,
): AgentEvent {
  return {
    type: "model.request.started",
    ...iteration,
    eventSequence,
    timestamp: timestamp(eventSequence),
    data: { attemptNumber, maxAttempts: 2 },
  };
}

function modelFinished(
  eventSequence: number,
  iteration: ReturnType<typeof iterationIdentity>,
  content = "response",
  attemptNumber = 1,
): AgentEvent {
  return {
    type: "model.request.finished",
    ...iteration,
    eventSequence,
    timestamp: timestamp(eventSequence),
    data: {
      attemptNumber,
      maxAttempts: 2,
      output: {
        message: { role: "assistant", content },
        usage: testUsage(),
      },
    },
  };
}

function testUsage() {
  return { promptTokens: 10, completionTokens: 2, totalTokens: 12 };
}

function contextUsage(usedInputTokens: number): ContextUsageSnapshot {
  return {
    usedInputTokens,
    source: "estimated_full",
    pressure: "normal",
    inputBudgetTokens: TEST_CONTEXT_BUDGET.inputBudgetTokens,
    triggerTokens: TEST_CONTEXT_BUDGET.triggerTokens,
    triggerRatio: TEST_CONTEXT_BUDGET.triggerRatio,
    requestMaxOutputTokens: TEST_CONTEXT_BUDGET.requestMaxOutputTokens,
    correctionFactor: 1.25,
    calibrationSampleCount: 0,
    prefixHash: "a".repeat(64),
    requestConfigHash: "b".repeat(64),
    toolSchemaHash: "c".repeat(64),
  };
}

function turnFinished(
  eventSequence: number,
  turn: ReturnType<typeof turnIdentity>,
  iteration: ReturnType<typeof iterationIdentity>,
  finalText: string,
): AgentEvent {
  return {
    type: "turn.finished",
    ...turn,
    eventSequence,
    timestamp: timestamp(eventSequence),
    data: {
      status: "completed",
      finalText,
      lastIteration: iteration,
      messageCount: 1,
    },
  };
}

function taskSnapshot(
  taskId: string,
  status: ShellTaskStatus,
  order: number,
): ShellTaskSnapshot {
  const origin = toolCall(order, 1, 1, "Bash", { command: `task ${taskId}` });
  return {
    taskId,
    origin,
    command: `task ${taskId}`,
    description: taskId,
    status,
    startedAt: timestamp(order),
    endedAt:
      status === "running" || status === "stopping"
        ? undefined
        : timestamp(order + 100),
    outputFilePath: `/tmp/${taskId}.log`,
    outputBytes: 0,
    outputLines: 0,
    cwd: "/tmp",
  };
}

function taskEvent(eventSequence: number, task: ShellTaskSnapshot): AgentEvent {
  const type =
    task.status === "running"
      ? "bash.task.backgrounded"
      : task.status === "stopping"
        ? "bash.task.stopping"
        : "bash.task.finished";
  return {
    type,
    ...task.origin,
    eventSequence,
    timestamp: timestamp(eventSequence),
    data: { task },
  };
}

function timestamp(sequence: number): string {
  return new Date(Date.UTC(2026, 6, 11, 0, 0, sequence)).toISOString();
}
