import { expect, test } from "bun:test";
import path from "node:path";
import { createRemoteTuiClient } from "../client/remote-workspace-client";
import type { RemoteView } from "../remote/protocol";
import {
  RemoteExecutionModel,
  remoteTuiFixture,
} from "./helpers/remote-tui-test-support";
import { processFixture, eventually } from "./helpers/remote-recovery-support";
import { until } from "./helpers/remote-test-support";

test("recovery: transport outage preserves execution and reconnects to the same canonical completed history", async () => {
  const model = new RemoteExecutionModel(false);
  const f = await remoteTuiFixture(model);
  const client = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  let fresh: Awaited<ReturnType<typeof createRemoteTuiClient>> | undefined;
  try {
    const binding = client.client.getBinding();
    const admitted = await binding.admitTurn!(
      { role: "user", content: "OFFLINE_FINISH" },
      new AbortController().signal,
    );
    const done = admitted.completion;
    await until(() => model.calls.length === 1);
    await f.disconnect();
    await until(
      () => binding.projectionStore.getServiceStatus?.().connection === "offline",
    );
    model.calls[0].release();
    await until(() => f.service.session(f.sessionId).view().status === "completed");
    expect(model.aborted).toBe(false);
    f.reconnect();
    expect((await done).status).toBe("completed");
    fresh = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
    await until(
      () => binding.projectionStore.getServiceStatus?.().connection === "online",
    );
    await until(() =>
      JSON.stringify(binding.projectionStore.getLogSnapshot().committed).includes(
        "REMOTE_DONE_1",
      ),
    );
    const restored = binding.projectionStore.getLogSnapshot().committed;
    expect(restored).toEqual(
      fresh.client.getBinding().projectionStore.getLogSnapshot().committed,
    );
    expect(new Set(restored.map((entry) => entry.id)).size).toBe(restored.length);
    expect(
      f.service
        .session(f.sessionId)
        .history()
        .messages.filter((m) => m.role === "user"),
    ).toHaveLength(1);
    expect(model.calls).toHaveLength(1);
  } finally {
    await client.close({ type: "client_exit" });
    await fresh?.close({ type: "client_exit" });
    await f.cleanup();
  }
}, 20000);

test("recovery: SIGKILL of the submitting client leaves accepted work alive and canonical on reconnect", async () => {
  const f = await processFixture();
  let client: Awaited<ReturnType<typeof createRemoteTuiClient>> | undefined;
  try {
    await Bun.write(
      path.join(f.root, "client.json"),
      JSON.stringify({ ...f.config, sessionId: f.sessionId }),
    );
    const child = f.spawn("client");
    await eventually(async () => {
      if (child.exitCode !== null)
        throw new Error(await new Response(child.stderr).text());
      return Bun.file(path.join(f.root, "client-ready")).exists();
    });
    await eventually(() => Bun.file(path.join(f.root, "effect-ready")).exists());
    child.kill("SIGKILL");
    await child.exited;
    await Bun.write(path.join(f.root, "release"), "release");
    client = await createRemoteTuiClient(f.config, "test", f.sessionId);
    const binding = client.client.getBinding();
    await until(
      () => binding.projectionStore.getServiceStatus?.().activity === "completed",
    );
    const view = (
      await f.transport.request<{ view: RemoteView }>(
        `/v1/sessions/${f.sessionId}/snapshot`,
      )
    ).view;
    expect(view.history.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(view.history.messages.at(-1)?.text).toBe("EFFECT_DONE");
    expect(
      JSON.stringify(binding.projectionStore.getLogSnapshot().committed),
    ).toContain("EFFECT_DONE");
    expect(await Bun.file(path.join(f.root, "workspace/effect.txt")).text()).toBe(
      "effect\n",
    );
  } finally {
    await client?.close({ type: "client_exit" });
    await f.cleanup();
  }
}, 20000);

test("recovery: SIGKILL and restart interrupts running and queued receipts without replaying a completed side effect", async () => {
  const f = await processFixture();
  let client: Awaited<ReturnType<typeof createRemoteTuiClient>> | undefined;
  try {
    const baseline = await f.submit(f.operation("BASELINE"));
    await f.terminal(baseline.requestId);
    client = await createRemoteTuiClient(f.config, "test", f.sessionId);
    const runningInput = f.operation("EFFECT");
    const running = await f.submit(runningInput);
    await eventually(() => Bun.file(path.join(f.root, "effect-ready")).exists());
    const queuedInput = f.operation("NEVER_DISPATCH");
    const queued = await f.submit(queuedInput);
    expect((await f.receipt(running.requestId)).status).toBe("running");
    expect((await f.receipt(queued.requestId)).status).toBe("accepted");
    const requests = await Bun.file(path.join(f.root, "requests")).text();
    f.server.child.kill("SIGKILL");
    await f.server.child.exited;
    const restarted = await f.start(f.server.port);
    expect(restarted.epoch).not.toBe(f.server.epoch);
    expect((await f.receipt(baseline.requestId)).status).toBe("completed");
    expect((await f.receipt(running.requestId)).status).toBe("interrupted");
    expect((await f.receipt(queued.requestId)).status).toBe("interrupted");
    expect((await f.submit(runningInput)).status).toBe("interrupted");
    expect((await f.submit(queuedInput)).status).toBe("interrupted");
    const binding = client.client.getBinding();
    await until(
      () =>
        binding.projectionStore.getServiceStatus?.().connection === "online" &&
        binding.projectionStore.getServiceStatus?.().activity === "interrupted",
    );
    const view = (
      await f.transport.request<{ view: RemoteView }>(
        `/v1/sessions/${f.sessionId}/snapshot`,
      )
    ).view;
    expect(view.status).toBe("interrupted");
    const fresh = await createRemoteTuiClient(f.config, "test", f.sessionId);
    try {
      const restored = binding.projectionStore.getLogSnapshot().committed;
      expect(restored).toEqual(
        fresh.client.getBinding().projectionStore.getLogSnapshot().committed,
      );
      expect(new Set(restored.map((entry) => entry.id)).size).toBe(restored.length);
    } finally {
      await fresh.close({ type: "client_exit" });
    }
    expect(view.history.messages.some((m) => m.text === "BASELINE_DONE")).toBe(true);
    expect(view.history.messages.some((m) => m.text.includes("NEVER_DISPATCH"))).toBe(
      false,
    );
    expect(JSON.stringify(binding.projectionStore.getLogSnapshot())).not.toContain(
      "PROVISIONAL_RECOVERY_TEXT",
    );
    expect(await Bun.file(path.join(f.root, "requests")).text()).toBe(requests);
    expect(await Bun.file(path.join(f.root, "workspace/effect.txt")).text()).toBe(
      "effect\n",
    );
  } finally {
    await client?.close({ type: "client_exit" });
    await f.cleanup();
  }
}, 25000);
