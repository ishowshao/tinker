import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRemoteTuiClient } from "../client/remote-workspace-client";
import { RemoteClient } from "../remote/client";
import { RemoteTasks } from "../client/remote-tasks";
import { parseOperation } from "../remote/protocol";
import { RemoteInteractionModel } from "./helpers/remote-interaction-model";
import { remoteTuiFixture } from "./helpers/remote-tui-test-support";
import { until } from "./helpers/remote-test-support";

for (const mode of ["question", "confirmation"] as const) {
  test(`service ${mode}: two clients share pending identity and reject stale responses to identical interactions`, async () => {
    const model = new RemoteInteractionModel(mode);
    const f = await remoteTuiFixture(model);
    const a = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
    let b = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
    try {
      await Bun.write(`${f.workspace}/guarded-target`, "keep until explicitly allowed");
      const accepted = await a.client.getBinding().admitTurn!(
        { role: "user", content: "interact" },
        new AbortController().signal,
      );
      const pending = () =>
        mode === "question"
          ? b.client.getBinding().askUser()
          : b.client.getBinding().bashGuard();
      const first = await until(() => pending().interactionId);
      expect(f.service.session(f.sessionId).view().status).toBe("waiting_input");
      await b.close({ type: "client_exit" });
      await f.disconnect();
      expect(f.service.session(f.sessionId).view().interaction?.id).toBe(first);
      f.reconnect();
      b = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
      expect(pending().interactionId).toBe(first);
      const binding = b.client.getBinding();
      if (mode === "question")
        await binding.resolveAskUser({ outcome: "selected", selectedIndex: 1 }, first);
      else await binding.resolveBashConfirmation("deny", first);
      const second = await until(() => {
        const id = pending().interactionId;
        return id && id !== first ? id : undefined;
      });
      expect(model.requests).toHaveLength(2);
      expect(await Bun.file(`${f.workspace}/guarded-target`).exists()).toBe(true);
      const stale =
        mode === "question"
          ? a.client
              .getBinding()
              .resolveAskUser({ outcome: "selected", selectedIndex: 0 }, first)
          : a.client.getBinding().resolveBashConfirmation("allow", first);
      expect(await stale.catch((error: unknown) => error)).toBeInstanceOf(Error);
      expect(f.service.session(f.sessionId).view().interaction?.id).toBe(second);
      if (mode === "question")
        await binding.resolveAskUser({ outcome: "dismissed" }, second);
      else await binding.resolveBashConfirmation("allow", second);
      expect((await accepted.completion).status).toBe("completed");
      await until(() => !pending().pending);
      expect(model.requests).toHaveLength(3);
      if (mode === "question") {
        expect(model.requests[1].input).toContain("Second choice");
        expect(model.requests[2].input).toContain("did not select an option");
      } else
        expect(await Bun.file(`${f.workspace}/guarded-target`).text()).toBe("allowed");
    } finally {
      await a.close({ type: "client_exit" });
      await b.close({ type: "client_exit" });
      await f.cleanup();
    }
  }, 15000);
}

test("provider retry keeps its turn/iteration, survives detach and rejects expired decisions", async () => {
  const model = new RemoteInteractionModel("retry");
  const f = await remoteTuiFixture(model);
  let client = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  try {
    const receipt = await f.prompt("retry");
    const first = await until(
      () => client.client.getBinding().providerRetry!().pending,
    );
    expect(model.requests).toHaveLength(2);
    expect(f.service.session(f.sessionId).view().interaction).toMatchObject({
      kind: "question",
      id: first.requestId,
    });
    expect(client.client.getBinding().askUser().pending).toBeUndefined();
    await client.close({ type: "client_exit" });
    client = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
    expect(client.client.getBinding().providerRetry!().pending?.requestId).toBe(
      first.requestId,
    );
    await client.client.getBinding().resolveProviderRetry!(first.requestId, "retry");
    const next = await until(() => {
      const p = client.client.getBinding().providerRetry!().pending;
      return p && p.requestId !== first.requestId ? p : undefined;
    });
    expect(model.requests).toHaveLength(4);
    const stale = await client.client.getBinding().resolveProviderRetry!(
      first.requestId,
      "stop",
    ).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(Error);
    expect(f.service.session(f.sessionId).view().interaction?.id).toBe(next.requestId);
    // A legacy client can also choose Retry using the existing question protocol.
    const legacy = await f.submit({
      kind: "answer",
      sessionId: f.sessionId,
      interactionId: next.requestId,
      selectedIndex: 0,
    });
    await f.terminal(legacy);
    expect((await f.terminal(receipt)).status).toBe("completed");
    expect(new Set(model.requests.map((r) => r.iterationId)).size).toBe(1);
    expect(
      f.service
        .session(f.sessionId)
        .history()
        .messages.filter((m) => m.role === "user"),
    ).toHaveLength(1);
  } finally {
    await client.close({ type: "client_exit" });
    await f.cleanup();
  }
}, 15000);

for (const decision of ["stop", "cancel"] as const) {
  test(`provider retry ${decision} settles the waiting execution`, async () => {
    const f = await remoteTuiFixture(new RemoteInteractionModel("retry"));
    const client = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
    try {
      const binding = client.client.getBinding();
      const accepted = await binding.admitTurn!(
        { role: "user", content: "wait" },
        new AbortController().signal,
      );
      const pending = await until(() => binding.providerRetry!().pending);
      if (decision === "stop")
        await binding.resolveProviderRetry!(pending.requestId, "stop");
      else await binding.stopTurn!();
      expect((await accepted.completion).status).toBe(
        decision === "stop" ? "failed" : "cancelled",
      );
      await until(() => !binding.providerRetry!().pending);
    } finally {
      await client.close({ type: "client_exit" });
      await f.cleanup();
    }
  }, 15000);
}

test("interaction response loss retries the same receipt without answering the next question", async () => {
  const model = new RemoteInteractionModel("question");
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
  let lost = false;
  const ids: string[] = [];
  transport.request = async <T>(
    route: string,
    input?: unknown,
    signal?: AbortSignal,
  ): Promise<T> => {
    const result = await original<T>(route, input, signal);
    if (route === "/v1/operations") {
      ids.push(parseOperation(input).requestId);
      if (!lost) {
        lost = true;
        throw new Error("Lost accepted answer response");
      }
    }
    return result;
  };
  try {
    const receipt = await f.prompt();
    const first = await until(() => f.service.session(f.sessionId).view().interaction);
    await tasks.respond({ kind: "answer", interactionId: first.id, selectedIndex: 0 });
    const next = await until(() => {
      const p = f.service.session(f.sessionId).view().interaction;
      return p && p.id !== first.id ? p : undefined;
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(model.requests).toHaveLength(2);
    await tasks.respond({
      kind: "answer",
      interactionId: next.id,
      selectedIndex: null,
    });
    expect((await f.terminal(receipt)).status).toBe("completed");
    expect(() =>
      parseOperation({
        kind: "provider_retry",
        requestId: randomUUID(),
        sessionId: f.sessionId,
        interactionId: next.id,
        decision: "allow",
      }),
    ).toThrow("retry or stop");
  } finally {
    lifetime.abort();
    await transport.close();
    await f.cleanup();
  }
}, 15000);

test("only one of two simultaneous clients can answer the same interaction", async () => {
  const model = new RemoteInteractionModel("question", 1);
  const f = await remoteTuiFixture(model);
  const first = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  const second = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  try {
    const task = await f.prompt();
    const id = await until(() => first.client.getBinding().askUser().interactionId);
    const outcomes = await Promise.allSettled([
      first.client
        .getBinding()
        .resolveAskUser({ outcome: "selected", selectedIndex: 0 }, id),
      second.client
        .getBinding()
        .resolveAskUser({ outcome: "selected", selectedIndex: 1 }, id),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await f.terminal(task)).status).toBe("completed");
    expect(model.requests).toHaveLength(2);
  } finally {
    await first.close({ type: "client_exit" });
    await second.close({ type: "client_exit" });
    await f.cleanup();
  }
}, 10000);
