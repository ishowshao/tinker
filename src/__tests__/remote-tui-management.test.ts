import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRemoteTuiClient } from "../client/remote-workspace-client";
import { RemoteClient } from "../remote/client";
import type { OperationReceipt } from "../remote/protocol";
import { parseSessionId } from "../ids/runtime-id";
import { createUuidV7 } from "../ids/uuid-v7";
import { memoryDirectory } from "../memory/memory-files";
import { SessionCatalog } from "../session/session-catalog";
import { resolveSessionDatabasePath } from "../session/session-store";
import { CapabilityModel } from "./helpers/remote-capability-model";
import {
  remoteTuiFixture,
  RemoteExecutionModel,
} from "./helpers/remote-tui-test-support";
import { until } from "./helpers/remote-test-support";

test("service memory browser reads global server notes and records without executing a turn", async () => {
  const model = new CapabilityModel();
  const f = await remoteTuiFixture(model);
  const client = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  try {
    const notes = path.join(memoryDirectory(f.root), "notes");
    const records = path.join(memoryDirectory(f.root), "records");
    await mkdir(notes, { recursive: true });
    await mkdir(records, { recursive: true });
    await Bun.write(
      path.join(notes, "note.md"),
      "# SERVER_NOTE\n\nWorkspace: /other-workspace\nCreated: 2026-09-22\n\nSERVER_DETAIL",
    );
    await Bun.write(
      path.join(records, "record.md"),
      "# SERVER_RECORD\n\nStarted: 2026-09-21\n\nRECORD_DETAIL",
    );
    const memories = await client.client.listStoredMemories();
    expect(memories).toHaveLength(2);
    expect(memories[0]).toMatchObject({
      text: "SERVER_NOTE",
      summary: "SERVER_DETAIL",
      sourceWorkspace: "/other-workspace",
    });
    expect(memories[1]).toMatchObject({
      text: "SERVER_RECORD",
      sourceSessionId: "record",
    });
    expect(model.inputs).toHaveLength(0);
  } finally {
    await client.close({ type: "client_exit" });
    await f.cleanup();
  }
});

test("service deletes detached sessions and preserves idempotent receipts after ownership removal", async () => {
  const f = await remoteTuiFixture(new CapabilityModel());
  const client = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  const wire = new RemoteClient(f.clientConfig, false);
  try {
    await client.client.clear();
    await until(() => f.service.session(f.sessionId).connectedClients === 0);
    const input = {
      kind: "delete_session",
      sessionId: client.client.getBinding().sessionId,
      targetSessionId: f.sessionId,
      requestId: randomUUID(),
    };
    const receipt = await wire.request<OperationReceipt>("/v1/operations", input);
    expect(receipt.status).toBe("completed");
    expect(await wire.request<OperationReceipt>("/v1/operations", input)).toEqual(
      receipt,
    );
    expect(f.store.session(f.sessionId)).toBeUndefined();
    expect(
      (await client.client.listSessions()).some((s) => s.sessionId === f.sessionId),
    ).toBe(false);
    expect(
      new SessionCatalog({ workspaceRoot: f.workspace, homeRoot: f.root }).get(
        parseSessionId(f.sessionId),
      ),
    ).rejects.toThrow();
    expect(client.client.delete(client.client.getBinding().sessionId)).rejects.toThrow(
      "current",
    );
    expect(
      wire.request("/v1/operations", {
        ...input,
        targetSessionId: input.sessionId,
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("current");
    expect(client.client.delete(parseSessionId(createUuidV7()))).rejects.toThrow();
    const foreign = {
      ...f.store.session(input.sessionId)!,
      id: createUuidV7(),
      workspaceId: "another",
    };
    f.store.saveSession(foreign);
    expect(client.client.delete(parseSessionId(foreign.id))).rejects.toThrow(
      "another workspace",
    );
    f.store.releaseSession(foreign.id);
  } finally {
    await wire.close();
    await client.close({ type: "client_exit" });
    await f.cleanup();
  }
});

test("deletion refuses connected or executing sessions, and succeeds only after detach and completion", async () => {
  const model = new RemoteExecutionModel(false);
  const f = await remoteTuiFixture(model);
  const observer = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  const owner = await createRemoteTuiClient(f.clientConfig, "test");
  try {
    await until(() => f.service.session(f.sessionId).connectedClients > 0);
    expect(owner.client.delete(parseSessionId(f.sessionId))).rejects.toThrow(
      "connected",
    );
    const receipt = await f.prompt("run detached");
    await until(() => model.calls.length === 1);
    await observer.close({ type: "client_exit" });
    await until(() => f.service.session(f.sessionId).connectedClients === 0);
    expect(owner.client.delete(parseSessionId(f.sessionId))).rejects.toThrow("active");
    expect(model.aborted).toBe(false);
    model.calls[0].release();
    await f.terminal(receipt);
    await owner.client.delete(parseSessionId(f.sessionId));
    expect(f.store.session(f.sessionId)).toBeUndefined();
  } finally {
    await observer.close({ type: "client_exit" });
    await owner.close({ type: "client_exit" });
    await f.cleanup();
  }
});

test("a refused disk deletion retains the canonical session and service ownership and does not remove unknown files", async () => {
  const f = await remoteTuiFixture(new CapabilityModel());
  const owner = await createRemoteTuiClient(f.clientConfig, "test");
  const database = await resolveSessionDatabasePath(
    f.workspace,
    parseSessionId(f.sessionId),
    f.root,
  );
  const unknown = path.join(path.dirname(database), "user-file.txt");
  try {
    await Bun.write(unknown, "keep");
    expect(owner.client.delete(parseSessionId(f.sessionId))).rejects.toThrow(
      "unknown files",
    );
    expect(await Bun.file(unknown).text()).toBe("keep");
    expect(await Bun.file(database).exists()).toBe(true);
    expect(f.store.session(f.sessionId)).toBeDefined();
    const summary = await new SessionCatalog({
      workspaceRoot: f.workspace,
      homeRoot: f.root,
    }).get(parseSessionId(f.sessionId));
    expect(summary.status).toBe("active");
  } finally {
    await owner.close({ type: "client_exit" });
    await f.cleanup();
  }
});

test("service restart retains completed deletion receipts and never replays an ambiguous deletion", async () => {
  const { remoteFixture } = await import("./helpers/remote-test-support");
  const { RemoteServiceStore } = await import("../remote/service-store");
  const { RemoteService } = await import("../remote/service");
  const { rm } = await import("node:fs/promises");
  const f = await remoteFixture(new CapabilityModel());
  let reopened: InstanceType<typeof RemoteService> | undefined;
  try {
    const source = await f.terminal(
      await f.submit({ kind: "create", workspaceId: "test" }),
    );
    const deletion = {
      kind: "delete_session" as const,
      requestId: randomUUID(),
      sessionId: source.sessionId,
      targetSessionId: f.sessionId,
    };
    expect((await f.service.submit(deletion, "phone")).status).toBe("completed");
    const survivor = await f.terminal(
      await f.submit({ kind: "create", workspaceId: "test" }),
    );
    const ambiguous = {
      ...deletion,
      requestId: randomUUID(),
      targetSessionId: survivor.sessionId,
    };
    f.store.accept(ambiguous, "phone", survivor.sessionId);
    await f.service.close();
    const store = await RemoteServiceStore.open(path.join(f.root, "service"));
    reopened = new RemoteService(store, f.workspaces, f.factory, f.root);
    await reopened.initialize();
    expect((await reopened.submit(deletion, "phone")).status).toBe("completed");
    expect((await reopened.submit(ambiguous, "phone")).status).toBe("interrupted");
    expect(store.session(f.sessionId)).toBeUndefined();
    expect(store.session(survivor.sessionId)).toBeDefined();
    expect(reopened.session(survivor.sessionId).initialized).toBe(true);
  } finally {
    if (reopened) {
      await reopened.close();
      await rm(f.root, { recursive: true, force: true });
    } else await f.cleanup();
  }
});

test("service workspace metadata and concurrent prompt history survive reconnect without local reads", async () => {
  const f = await remoteTuiFixture(new CapabilityModel());
  const a = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  const b = await createRemoteTuiClient(f.clientConfig, "test");
  let reconnected: Awaited<ReturnType<typeof createRemoteTuiClient>> | undefined;
  try {
    const git = Bun.spawn(
      ["git", "init", "--initial-branch=service-branch", f.workspace],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await git.exited).toBe(0);
    await Bun.write(
      path.join(f.workspace, ".tinker.json"),
      JSON.stringify({
        version: 1,
        slashCommands: [
          {
            name: "server-command",
            description: "Server command",
            prompt: "SERVER_PROJECT_PROMPT",
          },
        ],
      }),
    );
    expect(await a.client.readGitBranch()).toBe("service-branch");
    expect((await a.client.projectCommands())[0].prompt).toBe("SERVER_PROJECT_PROMPT");
    const histories = await Promise.all([
      a.client.loadHistory(),
      b.client.loadHistory(),
    ]);
    await Promise.all([
      histories[0].append("FIRST_SERVER_PROMPT"),
      histories[1].append("SECOND_SERVER_PROMPT"),
    ]);
    await a.close({ type: "client_exit" });
    reconnected = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
    const restored = await reconnected.client.loadHistory();
    expect(restored.entries).toHaveLength(2);
    expect(restored.entries).toContain("FIRST_SERVER_PROMPT");
    expect(restored.entries).toContain("SECOND_SERVER_PROMPT");
    const wire = new RemoteClient(f.clientConfig, false);
    try {
      expect(
        wire.request(`/v1/sessions/${f.sessionId}/prompt-history`, {
          prompt: { bad: true },
        }),
      ).rejects.toThrow();
    } finally {
      await wire.close();
    }
  } finally {
    await reconnected?.close({ type: "client_exit" });
    await a.close({ type: "client_exit" });
    await b.close({ type: "client_exit" });
    await f.cleanup();
  }
});

test("closing an offline client releases a pending deletion instead of waiting for reconnect", async () => {
  const f = await remoteTuiFixture(new CapabilityModel());
  const owner = await createRemoteTuiClient(f.clientConfig, "test");
  try {
    await f.disconnect();
    const deletion = owner.client
      .delete(parseSessionId(f.sessionId))
      .catch((error: unknown) => error);
    await owner.close({ type: "client_exit" });
    expect(await deletion).toBeInstanceOf(Error);
    expect(f.store.session(f.sessionId)).toBeDefined();
  } finally {
    await owner.close({ type: "client_exit" });
    await f.cleanup();
  }
}, 5000);
