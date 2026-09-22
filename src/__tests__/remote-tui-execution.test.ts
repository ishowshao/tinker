import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRemoteTuiClient } from "../client/remote-workspace-client";
import { RemoteClient } from "../remote/client";
import { RemoteTasks } from "../client/remote-tasks";
import { parseOperation } from "../remote/protocol";
import {
  RemoteExecutionModel,
  remoteTuiFixture,
} from "./helpers/remote-tui-test-support";
import { until } from "./helpers/remote-test-support";

test("full service TUI shares streaming, tool state and steering; only explicit stop cancels", async () => {
  const model = new RemoteExecutionModel();
  const f = await remoteTuiFixture(model);
  const first = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  const second = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  try {
    const binding = first.client.getBinding();
    const observer = second.client.getBinding();
    const accepted = await binding.admitTurn!(
      { role: "user", content: "REMOTE_START" },
      new AbortController().signal,
    );
    const completion = accepted.completion.catch((error: unknown) => error);
    await until(() => observer.promptScheduler!().state === "running");
    await until(() =>
      JSON.stringify(observer.projectionStore.getLogSnapshot()).includes(
        "REMOTE_STREAM_1",
      ),
    );
    expect(JSON.stringify(observer.projectionStore.getLogSnapshot())).not.toContain(
      "REMOTE_DONE_1",
    );
    expect(observer.projectionStore.getSnapshot().activeTurn?.turnId).toBe(
      accepted.turnId,
    );
    const queued = await observer.queueFollowUp!({
      role: "user",
      content: "REMOTE_STEERING",
    });
    expect(queued.pendingCount).toBe(1);
    await until(() => binding.promptScheduler!().pendingCount === 1);
    model.calls[0].release();
    await until(() =>
      observer.projectionStore
        .getLogSnapshot()
        .live.some(
          (item) => item.text.includes("sleep 1") && item.status === "running",
        ),
    );
    await until(() => model.calls.length === 2);
    expect(model.calls[1].input).toContain("REMOTE_STEERING");
    await until(() => observer.promptScheduler!().pendingCount === 0);
    await until(() =>
      JSON.stringify(observer.projectionStore.getLogSnapshot()).includes(
        "REMOTE_TOOL_DONE",
      ),
    );
    const before = observer.projectionStore
      .getLogSnapshot()
      .committed.map((item) => item.id);
    await f.disconnect();
    expect(model.aborted).toBe(false);
    f.reconnect();
    await until(
      () => observer.projectionStore.getServiceStatus?.().connection === "online",
    );
    expect(
      observer.projectionStore.getLogSnapshot().committed.map((item) => item.id),
    ).toEqual(before);
    await first.close({ type: "client_exit" });
    await completion;
    expect(model.aborted).toBe(false);
    // The observing terminal can cancel a turn submitted by a disconnected terminal.
    await observer.stopTurn!();
    await until(() => observer.promptScheduler!().state === "idle");
    expect(model.aborted).toBe(true);
    expect(f.service.session(f.sessionId).view().status).toBe("cancelled");
    expect(f.factoryCalls()).toBe(1);
    expect(
      f.service
        .session(f.sessionId)
        .history()
        .messages.some((m) => m.text.includes("REMOTE_STEERING")),
    ).toBe(true);
    expect(observer.queueFollowUp!({ role: "user", content: "stale" })).rejects.toThrow(
      "No execution",
    );
  } finally {
    await first.close({ type: "client_exit" });
    await second.close({ type: "client_exit" });
    await f.cleanup();
  }
}, 20000);

test("uncertain prompt and follow-up responses retry their UUID without duplicate execution", async () => {
  const model = new RemoteExecutionModel(false);
  const f = await remoteTuiFixture(model);
  const transport = new RemoteClient(f.clientConfig, false);
  const original = transport.request.bind(transport);
  const lost = new Set<string>();
  const ids: string[] = [];
  transport.request = async <T>(
    route: string,
    input?: unknown,
    signal?: AbortSignal,
  ): Promise<T> => {
    const result = await original<T>(route, input, signal);
    if (route === "/v1/operations") {
      const operation = parseOperation(input);
      ids.push(operation.requestId);
      if (!lost.has(operation.requestId)) {
        lost.add(operation.requestId);
        throw new Error("Simulated lost HTTP response after durable acceptance");
      }
    }
    return result;
  };
  const lifetime = new AbortController();
  const tasks = new RemoteTasks(
    transport,
    f.sessionId,
    () => f.service.session(f.sessionId).tuiSnapshot(),
    lifetime.signal,
    () => {},
  );
  try {
    const accepted = await tasks.admitTurn(
      { role: "user", content: "ONCE" },
      new AbortController().signal,
    );
    expect(model.calls).toHaveLength(1);
    const follow = await tasks.queueFollowUp({ role: "user", content: "FOLLOW_ONCE" });
    expect(follow.pendingCount).toBe(1);
    expect(
      f.service.session(f.sessionId).tuiSnapshot().promptScheduler.pendingCount,
    ).toBe(1);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
    model.calls[0].release();
    await until(() => model.calls.length === 2);
    model.calls[1].release();
    const result = await accepted.completion;
    expect(result.status).toBe("completed");
    expect(
      f.service
        .session(f.sessionId)
        .view()
        .operations.every((op) => op.result === undefined),
    ).toBe(true);
    expect(
      f.service
        .session(f.sessionId)
        .history()
        .messages.filter((m) => m.role === "user"),
    ).toHaveLength(2);
    const logs = f.service.session(f.sessionId).tuiSnapshot().timeline.committed;
    expect(
      logs.filter((item) => JSON.stringify(item).includes("REMOTE_DONE_2")),
    ).toHaveLength(1);
    const stale = {
      kind: "follow_up" as const,
      requestId: randomUUID(),
      sessionId: f.sessionId,
      targetRequestId: ids[0],
      prompt: "too late",
    };
    expect(f.service.submit(stale, "terminal")).rejects.toThrow("no longer running");
    expect(() => parseOperation({ ...stale, targetRequestId: "bad" })).toThrow(
      "targetRequestId",
    );
  } finally {
    lifetime.abort();
    await transport.close();
    await f.cleanup();
  }
}, 15000);

test("detaching during admission never sends stop; an explicit abort stops a waiting interaction", async () => {
  const { TurnCancelledError } = await import("../agent/turn-cancellation");
  const { RemoteTestModel } = await import("./helpers/remote-test-support");
  const model = new RemoteTestModel("question");
  const f = await remoteTuiFixture(model);
  const transport = new RemoteClient(f.clientConfig, false);
  const lifetime = new AbortController();
  const tasks = new RemoteTasks(
    transport,
    f.sessionId,
    () => f.service.session(f.sessionId).tuiSnapshot(),
    lifetime.signal,
    () => {},
  );
  const original = transport.request.bind(transport);
  const admission = new AbortController();
  transport.request = async <T>(
    route: string,
    input?: unknown,
    signal?: AbortSignal,
  ): Promise<T> => {
    const result = await original<T>(route, input, signal);
    if (route === "/v1/operations" && parseOperation(input).kind === "prompt")
      admission.abort(new TurnCancelledError("session_dispose"));
    return result;
  };
  try {
    const accepted = await tasks.admitTurn(
      { role: "user", content: "ASK" },
      admission.signal,
    );
    model.release();
    await until(() => f.service.session(f.sessionId).view().status === "waiting_input");
    expect(model.aborted).toBe(false);
    expect(f.store.operations(f.sessionId).some((op) => op.kind === "stop")).toBe(
      false,
    );
    await tasks.stopTurn();
    expect((await accepted.completion).status).toBe("cancelled");
    expect(
      tasks.admitTurn(
        { role: "user", content: "invalid", attachments: [] },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  } finally {
    lifetime.abort();
    await transport.close();
    await f.cleanup();
  }
}, 15000);

test("explicit task abort cancels the execution chain and clears queued follow-ups", async () => {
  const { TurnCancelledError } = await import("../agent/turn-cancellation");
  const model = new RemoteExecutionModel(false);
  const f = await remoteTuiFixture(model);
  const client = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  try {
    const binding = client.client.getBinding();
    const signal = new AbortController();
    const accepted = await binding.admitTurn!(
      { role: "user", content: "CANCEL_ME" },
      signal.signal,
    );
    await until(() => binding.promptScheduler!().state === "running");
    await binding.queueFollowUp!({ role: "user", content: "NEVER_RUN" });
    signal.abort(new TurnCancelledError("user"));
    expect((await accepted.completion).status).toBe("cancelled");
    await until(() => binding.promptScheduler!().state === "idle");
    expect(binding.promptScheduler!().pendingCount).toBe(0);
    expect(model.calls).toHaveLength(1);
    expect(model.aborted).toBe(true);
  } finally {
    await client.close({ type: "client_exit" });
    await f.cleanup();
  }
}, 10000);
