import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { RemoteServiceStore } from "../remote/service-store";
import { RemoteService } from "../remote/service";
import { SessionStore } from "../session/session-store";
import { parseSessionId } from "../ids/runtime-id";
import { RemoteTestModel, remoteFixture, until } from "./helpers/remote-test-support";
import type { RemoteFrame } from "../remote/protocol";

describe("remote service lifecycle and canonical history", () => {
  test("disconnecting every subscriber preserves execution and partial text; offline completion is canonical", async () => {
    const model = new RemoteTestModel();
    const f = await remoteFixture(model);
    try {
      const hosted = f.service.session(f.sessionId);
      const frames: RemoteFrame[] = [];
      const unsubscribe = hosted.hub.subscribe(undefined, (frame) =>
        frames.push(frame),
      );
      const op = await f.prompt();
      await until(() => model.requests === 1);
      expect(hosted.view().streaming?.text).toBe("Provisional text");
      expect(
        hosted.view().history.messages.filter((m) => m.role === "assistant"),
      ).toHaveLength(0);
      unsubscribe();
      expect(model.aborted).toBe(false);
      const snapshot = hosted.hub.snapshot();
      expect(snapshot.type).toBe("snapshot");
      if (snapshot.type === "snapshot")
        expect(snapshot.view.activeRequestId).toBe(op.requestId);
      model.release();
      expect((await f.terminal(op)).status).toBe("completed");
      const view = hosted.view();
      expect(view.streaming).toBeUndefined();
      expect(view.history.messages.map((m) => m.text)).toEqual([
        "hello",
        "Complete answer 1",
      ]);
      expect(view.history.messages[1].turnStatus).toBe("completed");
      expect(f.factoryCalls()).toBe(1);
      expect(model.aborted).toBe(false);
      expect(frames[0].type).toBe("snapshot");
    } finally {
      await f.cleanup();
    }
  });

  test("lost-response retries, concurrent submissions and stale stops never run a request twice", async () => {
    const model = new RemoteTestModel();
    const f = await remoteFixture(model);
    try {
      const requestId = randomUUID();
      const replies = await Promise.all(
        Array.from({ length: 8 }, () => f.prompt("once", requestId)),
      );
      expect(new Set(replies.map((reply) => reply.requestId)).size).toBe(1);
      await until(() => model.requests === 1);
      const followUp = await f.prompt("next");
      expect(f.store.get(followUp.requestId).status).toBe("accepted");
      expect(f.prompt("different", requestId)).rejects.toThrow("already used");
      model.release();
      await f.terminal(followUp);
      await f.submit({
        kind: "stop",
        sessionId: f.sessionId,
        targetRequestId: requestId,
      });
      expect(model.requests).toBe(2);
      expect(
        f.service
          .session(f.sessionId)
          .view()
          .history.messages.filter((m) => m.role === "user")
          .map((m) => m.text),
      ).toEqual(["once", "next"]);
    } finally {
      await f.cleanup();
    }
  });

  test.each([
    "question",
    "confirmation",
  ] as const)("%s remains pending without clients, answers are idempotent and stale replies fail", async (mode) => {
    const model = new RemoteTestModel(mode);
    const f = await remoteFixture(model);
    try {
      const op = await f.prompt();
      model.release();
      const interaction = await until(
        () => f.service.session(f.sessionId).view().interaction,
      );
      expect(f.store.get(op.requestId).status).toBe("waiting_input");
      expect(model.requests).toBe(1);
      expect(model.aborted).toBe(false);
      const input =
        mode === "question"
          ? {
              requestId: randomUUID(),
              kind: "answer" as const,
              sessionId: f.sessionId,
              interactionId: interaction.id,
              selectedIndex: 0,
            }
          : {
              requestId: randomUUID(),
              kind: "confirm" as const,
              sessionId: f.sessionId,
              interactionId: interaction.id,
              decision: "deny" as const,
            };
      const reply = await f.service.submit(input, "phone");
      expect((await f.service.submit(input, "phone")).requestId).toBe(reply.requestId);
      expect((await f.terminal(op)).status).toBe("completed");
      expect(
        f.service.submit({ ...input, requestId: randomUUID() }, "phone"),
      ).rejects.toThrow("no longer pending");
      const messages = f.service.session(f.sessionId).view().history.messages;
      expect(messages.some((m) => m.role === "tool")).toBe(true);
      expect(model.requests).toBe(2);
    } finally {
      await f.cleanup();
    }
  });

  test("explicit stop cancels only its active request and leaves a queued follow-up executable", async () => {
    const model = new RemoteTestModel();
    const f = await remoteFixture(model);
    try {
      const first = await f.prompt();
      await until(() => model.requests === 1);
      const next = await f.prompt("follow-up");
      const stop = await f.submit({
        kind: "stop",
        sessionId: f.sessionId,
        targetRequestId: first.requestId,
      });
      expect((await f.terminal(stop)).status).toBe("completed");
      expect((await f.terminal(first)).status).toBe("cancelled");
      model.release();
      expect((await f.terminal(next)).status).toBe("completed");
      expect(model.requests).toBe(2);
    } finally {
      await f.cleanup();
    }
  });

  test("one service state lease and canonical session lease exclude second execution owners", async () => {
    const f = await remoteFixture(new RemoteTestModel());
    try {
      expect(RemoteServiceStore.open(`${f.root}/service`)).rejects.toThrow(
        "active in pid",
      );
      expect(
        SessionStore.openExisting({
          workspaceRoot: f.workspace,
          homeRoot: f.root,
          sessionId: parseSessionId(f.sessionId),
        }),
      ).rejects.toThrow("active in pid");
      await Promise.all(
        Array.from({ length: 8 }, () => f.service.session(f.sessionId).open()),
      );
      expect(f.factoryCalls()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  test("reopening receipts never replays ambiguous accepted work, and preserves completed canonical results", async () => {
    const model = new RemoteTestModel();
    const f = await remoteFixture(model);
    let reopened: RemoteService | undefined;
    try {
      model.release();
      const done = await f.prompt("done");
      await f.terminal(done);
      const ambiguous = {
        requestId: randomUUID(),
        kind: "prompt" as const,
        sessionId: f.sessionId,
        prompt: "not dispatched",
      };
      f.store.accept(ambiguous, "phone", f.sessionId);
      await f.service.close();
      const store = await RemoteServiceStore.open(`${f.root}/service`);
      reopened = new RemoteService(store, f.workspaces, f.factory, f.root);
      await reopened.initialize();
      expect((await reopened.submit(ambiguous, "phone")).status).toBe("interrupted");
      expect(store.get(done.requestId).status).toBe("completed");
      expect(model.requests).toBe(1);
      expect(reopened.session(f.sessionId).view().history.messages.at(-1)?.text).toBe(
        "Complete answer 1",
      );
    } finally {
      if (reopened) {
        await reopened.close();
        const { rm } = await import("node:fs/promises");
        await rm(f.root, { recursive: true, force: true });
      } else await f.cleanup();
    }
  });
});
