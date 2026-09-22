import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createUuidV7 } from "../ids/uuid-v7";
import { parseSessionId } from "../ids/runtime-id";
import { SessionStore } from "../session/session-store";
import { SessionCatalog } from "../session/session-catalog";
import { RemoteService } from "../remote/service";
import { RemoteServiceStore, type ManagedSessionRecord } from "../remote/service-store";
import { RemoteClient } from "../remote/client";
import { createRemoteTuiClient } from "../client/remote-workspace-client";
import { remoteFixture, RemoteTestModel } from "./helpers/remote-test-support";
import { remoteTuiFixture } from "./helpers/remote-tui-test-support";

async function localSession(
  f: Awaited<ReturnType<typeof remoteFixture>>,
  history = true,
) {
  const record: ManagedSessionRecord = {
    id: createUuidV7(),
    workspaceId: "test",
    workspacePath: f.workspace,
    title: "Old local session",
    modelName: "test-model",
    owner: "service",
    status: "idle",
    initialized: false,
    updatedAt: new Date().toISOString(),
  };
  const opened = await f.factory({
    record,
    sink: { append: async () => {}, updateAssistantTextDelta: () => {} },
  });
  if (history)
    await opened.runtime.executeTurn({
      userMessage: { role: "user", content: "LOCAL_CANONICAL_HISTORY" },
      signal: new AbortController().signal,
    });
  await opened.runtime.dispose({ type: "tui_exit" });
  return { record, ...opened };
}

test("adoption acquires one canonical runtime for concurrent full clients without replaying old history", async () => {
  const model = new RemoteTestModel();
  model.release();
  const f = await remoteTuiFixture(model);
  const connections: Awaited<ReturnType<typeof createRemoteTuiClient>>[] = [];
  try {
    const local = await localSession(f);
    const before = f.factoryCalls();
    const clients = await Promise.all(
      Array.from({ length: 3 }, () =>
        createRemoteTuiClient(f.clientConfig, "test", local.record.id),
      ),
    );
    connections.push(...clients);
    expect(f.factoryCalls() - before).toBe(1);
    expect(model.requests).toBe(1);
    expect(new Set(clients.map((c) => c.client.getBinding().sessionId)).size).toBe(1);
    expect(
      JSON.stringify(clients[0].client.getBinding().projectionStore.getLogSnapshot()),
    ).toContain("LOCAL_CANONICAL_HISTORY");
    expect(
      f.service
        .session(local.record.id)
        .history()
        .messages.filter((m) => m.role === "user"),
    ).toHaveLength(1);
    const id = randomUUID();
    const request = {
      kind: "adopt" as const,
      workspaceId: "test",
      sessionId: local.record.id,
      requestId: id,
    };
    const first = await f.service.submit(request, "phone");
    expect(await f.service.submit(request, "phone")).toEqual(first);
    expect(first.status).toBe("completed");
    const blocked = await SessionStore.openExisting({
      workspaceRoot: f.workspace,
      homeRoot: f.root,
      sessionId: parseSessionId(local.record.id),
    }).catch((e: unknown) => e);
    expect(String(blocked)).toContain("active in pid");
    for (const client of connections) await client.close({ type: "client_exit" });
    connections.length = 0;
    expect(f.service.session(local.record.id).initialized).toBe(true);
    expect(
      (
        await new SessionCatalog({
          workspaceRoot: f.workspace,
          homeRoot: f.root,
        }).get(parseSessionId(local.record.id))
      ).turnCount,
    ).toBe(1);
  } finally {
    for (const c of connections) await c.close({ type: "client_exit" });
    await f.cleanup();
  }
}, 15000);

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`adoption refuses an actual local owner, then resumes after ${signal} without replay`, async () => {
    const model = new RemoteTestModel();
    model.release();
    const f = await remoteTuiFixture(model);
    let owner: ReturnType<typeof Bun.spawn> | undefined;
    let client: Awaited<ReturnType<typeof createRemoteTuiClient>> | undefined;
    try {
      const local = await localSession(f);
      owner = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "fixtures/local-session-owner.ts"),
          f.workspace,
          f.root,
          local.record.id,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const reader = (owner.stdout as ReadableStream<Uint8Array>).getReader();
      const ready = await reader.read();
      if (ready.done) {
        const error = await new Response(
          owner.stderr as ReadableStream<Uint8Array>,
        ).text();
        throw new Error(`Local session owner exited (${await owner.exited}): ${error}`);
      }
      expect(new TextDecoder().decode(ready.value)).toContain("LEASE_READY");
      reader.releaseLock();
      expect(
        String(
          await createRemoteTuiClient(f.clientConfig, "test", local.record.id).catch(
            (e: unknown) => e,
          ),
        ),
      ).toContain("Exit the local session");
      expect(f.store.session(local.record.id)).toBeUndefined();
      const blocked = await f.service
        .submit(
          {
            kind: "adopt",
            workspaceId: "test",
            sessionId: local.record.id,
            requestId: randomUUID(),
          },
          "phone",
        )
        .catch((e: unknown) => e);
      expect(String(blocked)).toContain("Exit its local TUI");
      expect(owner.exitCode).toBeNull();
      owner.kill(signal);
      await owner.exited;
      client = await createRemoteTuiClient(f.clientConfig, "test", local.record.id);
      expect(client.client.getBinding().sessionId).toBe(
        parseSessionId(local.record.id),
      );
      expect(model.requests).toBe(1);
      expect(
        JSON.stringify(client.client.getBinding().projectionStore.getLogSnapshot()),
      ).toContain("LOCAL_CANONICAL_HISTORY");
    } finally {
      if (owner?.exitCode === null) owner.kill("SIGKILL");
      await owner?.exited;
      await client?.close({ type: "client_exit" });
      await f.cleanup();
    }
  }, 15000);
}

test("adoption loses a lease race without persisting false ownership and can be retried", async () => {
  const model = new RemoteTestModel();
  model.release();
  let localOwner: SessionStore | undefined;
  let raceId: string | undefined;
  const f = await remoteFixture(model, undefined, async (record) => {
    if (record.id !== raceId || !record.initialized) return;
    expect(f.store.session(record.id)).toBeUndefined();
    raceId = undefined;
    localOwner = await SessionStore.openExisting({
      workspaceRoot: f.workspace,
      homeRoot: f.root,
      sessionId: parseSessionId(record.id),
    });
  });
  try {
    const local = await localSession(f);
    raceId = local.record.id;
    const input = {
      kind: "adopt" as const,
      workspaceId: "test",
      sessionId: local.record.id,
      requestId: randomUUID(),
    };
    const failed = await f.service.submit(input, "phone");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("active in pid");
    expect(f.store.session(local.record.id)).toBeUndefined();
    expect(await f.service.submit(input, "phone")).toEqual(failed);
    await localOwner!.abandon();
    localOwner = undefined;
    const retry = await f.service.submit(
      { ...input, requestId: randomUUID() },
      "phone",
    );
    expect(retry.status).toBe("completed");
    expect(model.requests).toBe(1);
  } finally {
    await localOwner?.abandon();
    await f.cleanup();
  }
}, 10000);

test("explicit empty-session adoption and restarted service retain the original session identity", async () => {
  const model = new RemoteTestModel();
  model.release();
  const f = await remoteTuiFixture(model);
  let client: Awaited<ReturnType<typeof createRemoteTuiClient>> | undefined;
  let reopened: RemoteService | undefined;
  try {
    const local = await localSession(f, false);
    expect(
      (await f.service.listTuiSessions("test")).some(
        (s) => s.sessionId === local.record.id,
      ),
    ).toBe(false);
    client = await createRemoteTuiClient(f.clientConfig, "test", local.record.id);
    expect(client.client.getBinding().sessionId).toBe(parseSessionId(local.record.id));
    const http = new RemoteClient(f.clientConfig, false);
    try {
      expect(
        String(
          await http
            .request(`/v1/workspaces/test/tui-sessions/${createUuidV7()}`)
            .catch((e: unknown) => e),
        ),
      ).toContain("does not belong");
    } finally {
      await http.close();
    }
    await client.close({ type: "client_exit" });
    client = undefined;
    await f.disconnect();
    await f.service.close();
    const store = await RemoteServiceStore.open(path.join(f.root, "service"));
    reopened = new RemoteService(store, f.workspaces, f.factory, f.root);
    await reopened.initialize();
    expect(reopened.session(local.record.id).initialized).toBe(false);
    await reopened.session(local.record.id).open();
    expect(reopened.session(local.record.id).initialized).toBe(true);
    expect(reopened.session(local.record.id).history().messages).toHaveLength(0);
    expect(model.requests).toBe(0);
    await reopened.close();
    reopened = undefined;
  } finally {
    await client?.close({ type: "client_exit" });
    await reopened?.close();
    await f.cleanup();
  }
}, 15000);
