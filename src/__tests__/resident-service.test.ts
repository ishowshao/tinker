import { TestModelClient, testModelOutput } from "./test-runtime";
import type {
  PreparedModelRequest,
  ModelRequestOptions,
  ModelRequestOutput,
} from "../model/model-client";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseSessionId } from "../ids/runtime-id";
import { SessionStore, resolveSessionDatabasePath } from "../session/session-store";
import { RemoteService } from "../remote/service";
import { RemoteServiceStore } from "../remote/service-store";
import {
  DEFAULT_RESIDENT_POLICY,
  parseResidentPolicy,
} from "../remote/resident-policy";
import { remoteFixture, RemoteTestModel, until } from "./helpers/remote-test-support";

const policy = {
  ...DEFAULT_RESIDENT_POLICY,
  maxLoadedSessions: 2,
  maxConcurrentTurns: 1,
  maxPendingTurns: 2,
  idleTimeoutMs: 10,
  shutdownGraceMs: 40,
};

test("resident policy rejects unknown, unbounded and contradictory resource settings", () => {
  expect(parseResidentPolicy(undefined)).toEqual(DEFAULT_RESIDENT_POLICY);
  for (const value of [
    { idleTimeoutMs: 0 },
    { maxLoadedSessions: 0 },
    { maxConcurrentTurns: 17 },
    { maxPendingTurns: 1 },
    { maxLoadedSessions: 1.5 },
    { unknown: 1 },
  ])
    expect(() => parseResidentPolicy(value)).toThrow();
});

test("idle reclaim closes the runtime, preserves its lease and session override, and reloads canonical history on demand", async () => {
  const model = new RemoteTestModel();
  model.release();
  const f = await remoteFixture(model, undefined, undefined, policy);
  try {
    const session = f.service.session(f.sessionId);
    const task = await f.prompt();
    await f.terminal(task);
    await until(() => !session.pendingCount);
    await session.exclusive(async (runtime) => {
      runtime.setYoloMode(true);
    });
    const database = await resolveSessionDatabasePath(
      f.workspace,
      parseSessionId(f.sessionId),
      f.root,
    );
    const lock = path.join(path.dirname(database), "active.lock");
    const lease = await readFile(lock, "utf8");
    const release = session.attach();
    await f.service.sweepIdle(Date.now() + 1000);
    expect(session.initialized).toBe(true);
    release();
    await f.service.sweepIdle(Date.now() + 1000);
    expect(session.initialized).toBe(false);
    expect(f.service.residentStatus().loadedSessions).toBe(0);
    expect(await readFile(lock, "utf8")).toBe(lease);
    expect(
      String(
        await SessionStore.openExisting({
          workspaceRoot: f.workspace,
          homeRoot: f.root,
          sessionId: parseSessionId(f.sessionId),
        }).catch((error: unknown) => error),
      ),
    ).toContain("active in pid");
    await Promise.all([session.open(), session.open()]);
    expect(f.factoryCalls()).toBe(2);
    expect(session.view().history.messages.at(-1)?.text).toBe("Complete answer 1");
    expect(session.tuiSnapshot().bashGuard.mode).toBe("yolo");
    expect(await readFile(lock, "utf8")).toBe(lease);
    expect(model.requests).toBe(1);
    const before = f.factoryCalls();
    await Promise.all([session.suspend(), session.open()]);
    expect(session.initialized).toBe(true);
    expect(f.factoryCalls()).toBe(before + 1);
  } finally {
    await f.cleanup();
  }
});

test("service restart recovers ownership without eager runtimes or replay", async () => {
  const model = new RemoteTestModel();
  model.release();
  const f = await remoteFixture(model, undefined, undefined, policy);
  let restarted: RemoteService | undefined;
  try {
    await f.terminal(await f.prompt());
    await f.service.close();
    const before = f.factoryCalls();
    const store = await RemoteServiceStore.open(path.join(f.root, "service"));
    restarted = new RemoteService(store, f.workspaces, f.factory, f.root, policy);
    await restarted.initialize();
    expect(f.factoryCalls()).toBe(before);
    expect(restarted.residentStatus().loadedSessions).toBe(0);
    expect(
      String(
        await SessionStore.openExisting({
          workspaceRoot: f.workspace,
          homeRoot: f.root,
          sessionId: parseSessionId(f.sessionId),
        }).catch((error: unknown) => error),
      ),
    ).toContain("active in pid");
    await restarted.session(f.sessionId).open();
    expect(model.requests).toBe(1);
    expect(restarted.session(f.sessionId).view().history.messages.at(-1)?.text).toBe(
      "Complete answer 1",
    );
  } finally {
    await restarted?.close();
    await f.cleanup();
  }
});

test("runtime capacity reclaims idle sessions but refuses to evict connected clients or create an accepted orphan", async () => {
  const f = await remoteFixture(new RemoteTestModel(), undefined, undefined, {
    ...policy,
    maxLoadedSessions: 1,
  });
  try {
    const first = f.service.session(f.sessionId);
    const release = first.attach();
    const create = {
      kind: "create" as const,
      requestId: randomUUID(),
      workspaceId: "test",
    };
    expect(
      String(await f.service.submit(create, "phone").catch((error: unknown) => error)),
    ).toContain("runtime slots");
    expect(f.store.sessions()).toHaveLength(1);
    release();
    const receipt = await f.service.submit(create, "phone");
    await f.service.session(receipt.sessionId).open();
    expect(first.initialized).toBe(false);
    expect(f.service.residentStatus().loadedSessions).toBe(1);
    expect(f.store.sessions()).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});

test("global execution slots queue fairly, reject overflow before acceptance and allow cancelling a waiter", async () => {
  const model = new RemoteTestModel();
  const f = await remoteFixture(model, undefined, undefined, policy);
  try {
    const other = await f.service.submit(
      { kind: "create", workspaceId: "test", requestId: randomUUID() },
      "phone",
    );
    await f.service.session(other.sessionId).open();
    const first = await f.prompt();
    await until(() => model.requests === 1);
    const waiting = await f.service.submit(
      {
        kind: "prompt",
        sessionId: other.sessionId,
        requestId: randomUUID(),
        prompt: "wait",
      },
      "phone",
    );
    await until(() => f.service.residentStatus().waitingTurns === 1);
    expect(model.requests).toBe(1);
    const overflow = {
      kind: "prompt" as const,
      sessionId: f.sessionId,
      requestId: randomUUID(),
      prompt: "overflow",
    };
    expect(
      String(
        await f.service.submit(overflow, "phone").catch((error: unknown) => error),
      ),
    ).toContain("pending-turn limit");
    expect(f.store.existing(overflow, "phone")).toBeUndefined();
    const stop = await f.service.submit(
      {
        kind: "stop",
        sessionId: other.sessionId,
        requestId: randomUUID(),
        targetRequestId: waiting.requestId,
      },
      "phone",
    );
    await f.terminal(stop);
    expect((await f.terminal(waiting)).status).toBe("cancelled");
    expect(model.requests).toBe(1);
    model.release();
    await f.terminal(first);
  } finally {
    await f.cleanup();
  }
});

test("drain rejects new work, restores admission after a non-forced timeout, and forced shutdown records interruption", async () => {
  const model = new RemoteTestModel();
  const f = await remoteFixture(model, undefined, undefined, policy);
  try {
    const task = await f.prompt();
    await until(() => model.requests === 1);
    const draining = f.service.drain().catch((error: unknown) => error);
    expect(
      String(await f.prompt("not accepted").catch((error: unknown) => error)),
    ).toContain("draining");
    expect(String(await draining)).toContain("shutdown was cancelled");
    expect(f.service.residentStatus().phase).toBe("ready");
    await f.service.drain(true);
    await f.service.close();
    const store = await RemoteServiceStore.open(path.join(f.root, "service"));
    try {
      expect(store.get(task.requestId).status).toBe("interrupted");
      expect(store.get(task.requestId).shutdownInterrupted).toBe(true);
    } finally {
      await store.close();
    }
    expect(model.aborted).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("background tools and pending interactions prevent idle reclaim after clients detach", async () => {
  class BackgroundModel extends TestModelClient {
    calls = 0;
    async request(
      prepared: PreparedModelRequest,
      options: ModelRequestOptions,
    ): Promise<ModelRequestOutput> {
      if (this.calls++ === 0) {
        const identity = options.identity!;
        return testModelOutput(prepared, {
          role: "assistant",
          content: "Starting background task",
          toolCalls: [
            {
              ...identity.runtimeSession.createToolCall(identity.iteration, 1),
              providerToolCallId: "background",
              name: "Bash",
              args: {
                // Keep startup asynchronous even on fast hosts to exercise the readiness handshake.
                command:
                  "sleep 0.2; echo $$ > background.pid; while :; do sleep 1; done",
                run_in_background: true,
              },
            },
          ],
        });
      }
      return testModelOutput(prepared, {
        role: "assistant",
        content: "Background task remains active",
      });
    }
  }
  const f = await remoteFixture(new BackgroundModel(), undefined, undefined, policy);
  let pid: number | undefined;
  try {
    await f.terminal(await f.prompt());
    // Turn completion acknowledges the background task, not execution of its first command.
    pid = await until(() => {
      try {
        const value = readFileSync(path.join(f.workspace, "background.pid"), "utf8");
        return /^[1-9]\d*\n$/.test(value) ? Number(value) : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    });
    await f.service.sweepIdle(Date.now() + 1000000);
    expect(f.service.session(f.sessionId).initialized).toBe(true);
    expect(f.service.session(f.sessionId).busy).toBe(true);
    expect(() => process.kill(pid!, 0)).not.toThrow();
  } finally {
    await f.cleanup();
  }
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });

  const model = new RemoteTestModel("question");
  model.release();
  const question = await remoteFixture(model, undefined, undefined, policy);
  try {
    await question.prompt();
    const interaction = await until(
      () => question.service.session(question.sessionId).view().interaction,
    );
    await question.service.sweepIdle(Date.now() + 1000000);
    expect(question.service.session(question.sessionId).view().interaction?.id).toBe(
      interaction.id,
    );
    expect(question.service.session(question.sessionId).initialized).toBe(true);
  } finally {
    await question.cleanup();
  }
});

test("cold startup reconciles a committed canonical turn even if its terminal receipt was lost", async () => {
  const model = new RemoteTestModel();
  model.release();
  const f = await remoteFixture(model, undefined, undefined, policy);
  let restarted: RemoteService | undefined;
  try {
    const completed = await f.terminal(await f.prompt());
    f.store.update({ ...completed, status: "running", result: undefined });
    await f.service.close();
    const store = await RemoteServiceStore.open(path.join(f.root, "service"));
    restarted = new RemoteService(store, f.workspaces, f.factory, f.root, policy);
    const calls = f.factoryCalls();
    await restarted.initialize();
    expect(f.factoryCalls()).toBe(calls);
    expect(store.get(completed.requestId).status).toBe("completed");
    expect(model.requests).toBe(1);
  } finally {
    await restarted?.close();
    await f.cleanup();
  }
});
