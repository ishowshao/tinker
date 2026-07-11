import { describe, expect, test } from "bun:test";
import type { ToolCall } from "../agent/types";
import type { AgentEvent } from "../events/types";
import type { IterationId, SessionId, ToolCallId, TurnId } from "../ids/runtime-id";
import type { ShellTaskSnapshot, ShellTaskStatus } from "../tools/bash-task";
import { visibleTimelineItems } from "../tui/event-store";
import type { TuiProjectionPolicy } from "../tui/tui-projection-policy";
import { TuiProjectionStore } from "../tui/tui-projection-store";

const sessionId = "projection-session" as SessionId;
const smallPolicy: TuiProjectionPolicy = {
  recentTurnLimit: 3,
  itemLimitPerTurn: 3,
  sessionNoticeLimit: 2,
  completedTaskLimit: 1,
};

describe("TuiProjectionStore", () => {
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
      data: {},
    });
    await store.append({
      type: "model.request.finished",
      ...iteration,
      eventSequence: 3,
      timestamp: timestamp(3),
      data: {
        output: {
          message: { role: "assistant", toolCalls: [call] },
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
    data: { userPrompt },
  };
}

function modelStarted(
  eventSequence: number,
  iteration: ReturnType<typeof iterationIdentity>,
): AgentEvent {
  return {
    type: "model.request.started",
    ...iteration,
    eventSequence,
    timestamp: timestamp(eventSequence),
    data: {},
  };
}

function modelFinished(
  eventSequence: number,
  iteration: ReturnType<typeof iterationIdentity>,
): AgentEvent {
  return {
    type: "model.request.finished",
    ...iteration,
    eventSequence,
    timestamp: timestamp(eventSequence),
    data: {
      output: { message: { role: "assistant", content: "response" } },
    },
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
