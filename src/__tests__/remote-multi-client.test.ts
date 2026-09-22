import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRemoteTuiClient } from "../client/remote-workspace-client";
import { RemoteClient } from "../remote/client";
import { RemoteInteractionModel } from "./helpers/remote-interaction-model";
import type { OperationReceipt } from "../remote/protocol";
import {
  RemoteExecutionModel,
  remoteTuiFixture,
} from "./helpers/remote-tui-test-support";
import { until } from "./helpers/remote-test-support";

test("simultaneous HTTPS retries share one receipt and runtime; stopping a separate session stays isolated", async () => {
  const model = new RemoteExecutionModel(false);
  const f = await remoteTuiFixture(model);
  const first = new RemoteClient(f.clientConfig, false);
  const second = new RemoteClient(f.clientConfig, false);
  const observer = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  const independent = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  try {
    const originalId = observer.client.getBinding().sessionId;
    const input = {
      kind: "prompt",
      sessionId: originalId,
      requestId: randomUUID(),
      prompt: "SHARED_REQUEST_ONCE",
    };
    const results = await Promise.all([
      first.request<OperationReceipt>("/v1/operations", input),
      second.request<OperationReceipt>("/v1/operations", input),
    ]);
    expect(results.map((receipt) => receipt.requestId)).toEqual([
      input.requestId,
      input.requestId,
    ]);
    await until(() => model.calls.length === 1);
    expect(
      f.store.operations(originalId).filter((operation) => operation.kind === "prompt"),
    ).toHaveLength(1);
    await independent.client.clear();
    const independentId = independent.client.getBinding().sessionId;
    expect(independentId).not.toBe(originalId);
    expect(observer.client.getBinding().sessionId).toBe(originalId);
    expect(model.aborted).toBe(false);
    const other = await independent.client.getBinding().admitTurn!(
      { role: "user", content: "INDEPENDENT_REQUEST" },
      new AbortController().signal,
    );
    await until(() => model.calls.length === 2);
    expect(model.calls[0].input).not.toContain("INDEPENDENT_REQUEST");
    expect(model.calls[1].input).not.toContain("SHARED_REQUEST_ONCE");
    expect(f.factoryCalls()).toBe(2);
    await independent.client.getBinding().stopTurn!();
    expect((await other.completion).status).toBe("cancelled");
    expect(f.store.get(input.requestId).status).toBe("running");
    await until(
      () => observer.client.getBinding().promptScheduler!().state === "running",
    );
    model.calls[0].release();
    expect((await f.terminal(results[0])).status).toBe("completed");
    const replay = await second.request<OperationReceipt>("/v1/operations", input);
    expect(replay.status).toBe("completed");
    expect(model.calls).toHaveLength(2);
    await until(() => observer.client.getBinding().promptScheduler!().state === "idle");
    expect(
      f.service
        .session(originalId)
        .history()
        .messages.filter((message) => message.role === "user")
        .map((message) => message.text),
    ).toEqual(["SHARED_REQUEST_ONCE"]);
    expect(
      f.service
        .session(independentId)
        .history()
        .messages.filter((message) => message.role === "user")
        .map((message) => message.text),
    ).toEqual(["INDEPENDENT_REQUEST"]);
  } finally {
    await first.close();
    await second.close();
    await observer.close({ type: "client_exit" });
    await independent.close({ type: "client_exit" });
    await f.cleanup();
  }
}, 15000);

test("racing clients cannot apply a losing answer to the next identical question", async () => {
  const model = new RemoteInteractionModel("question", 2);
  const f = await remoteTuiFixture(model);
  const first = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  const second = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  try {
    const task = await f.prompt("TWO_IDENTICAL_QUESTIONS");
    const bindingA = first.client.getBinding();
    const bindingB = second.client.getBinding();
    const initialId = await until(() => bindingA.askUser().interactionId);
    await until(() => bindingB.askUser().interactionId === initialId);
    const outcomes = await Promise.allSettled([
      bindingA.resolveAskUser({ outcome: "selected", selectedIndex: 0 }, initialId),
      bindingB.resolveAskUser({ outcome: "selected", selectedIndex: 1 }, initialId),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    const nextId = await until(() => {
      const id = bindingA.askUser().interactionId;
      return id && id !== initialId ? id : undefined;
    });
    await until(() => bindingB.askUser().interactionId === nextId);
    expect(model.requests).toHaveLength(2);
    expect(f.store.get(task.requestId).status).toBe("waiting_input");
    expect(f.service.session(f.sessionId).view().interaction?.id).toBe(nextId);
    await bindingB.resolveAskUser({ outcome: "dismissed" }, nextId);
    expect((await f.terminal(task)).status).toBe("completed");
    expect(model.requests).toHaveLength(3);
    expect(model.requests[2].input).toContain("did not select an option");
    await until(() => !bindingA.askUser().pending && !bindingB.askUser().pending);
  } finally {
    await first.close({ type: "client_exit" });
    await second.close({ type: "client_exit" });
    await f.cleanup();
  }
}, 15000);
