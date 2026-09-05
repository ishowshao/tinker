import { expect, test } from "bun:test";
import { RemoteSyncHub } from "../remote/sync-hub";
import { applyRemoteFrame } from "../remote/client";
import { authenticateDevice } from "../remote/config";
import { parseOperation, type RemoteFrame, type RemoteView } from "../remote/protocol";
import { createHash, randomBytes, randomUUID } from "node:crypto";

function emptyView(): RemoteView {
  return {
    session: {
      id: "session",
      workspaceId: "workspace",
      title: "Title",
      modelName: "test",
      owner: "service",
      status: "idle",
      updatedAt: "now",
    },
    status: "idle",
    tools: [],
    operations: [],
    history: { messages: [], hasMore: false },
  };
}
test("snapshot subscription has no gap, duplicate events are ignored and invalid cursors resnapshot", () => {
  const view = emptyView();
  const hub = new RemoteSyncHub("epoch", () => structuredClone(view), 2);
  const frames: RemoteFrame[] = [];
  hub.subscribe(undefined, (frame) => {
    frames.push(frame);
  });
  for (let i = 0; i < 3; i++)
    hub.publish({ activity: { ...view, status: "running" }, messages: [] });
  const replay: RemoteFrame[] = [];
  hub.subscribe({ epoch: "epoch", sequence: 2 }, (frame) => replay.push(frame));
  expect(replay.map((frame) => frame.sequence)).toEqual([3]);
  const expired: RemoteFrame[] = [];
  hub.subscribe({ epoch: "epoch", sequence: 0 }, (frame) => expired.push(frame));
  expect(expired[0].type).toBe("snapshot");
  const otherBoot: RemoteFrame[] = [];
  hub.subscribe({ epoch: "old", sequence: 3 }, (frame) => otherBoot.push(frame));
  expect(otherBoot[0].type).toBe("snapshot");
  const base = { ...hub.snapshot(), sequence: 2 };
  const applied = applyRemoteFrame(base, replay[0]);
  expect(applied.sequence).toBe(3);
  expect(applyRemoteFrame(applied, replay[0])).toBe(applied);
  expect(() => applyRemoteFrame({ ...base, sequence: 1 }, replay[0])).toThrow(
    "Missing event",
  );
  hub.close();
});
test("throwing or removed subscribers cannot affect publication", async () => {
  const view = emptyView();
  const hub = new RemoteSyncHub("epoch", () => view);
  const frames: RemoteFrame[] = [];
  hub.subscribe(undefined, () => {
    throw new Error("broken socket");
  });
  const detach = hub.subscribe(undefined, (frame) => frames.push(frame));
  hub.publish({ activity: view, messages: [] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(frames.map((frame) => frame.type)).toEqual(["snapshot", "event"]);
  detach();
  hub.publish({ activity: view, messages: [] });
  expect(hub.snapshot().sequence).toBe(2);
  hub.close();
});
test("device authentication and mutation parsing fail closed", () => {
  const token = randomBytes(32).toString("base64url");
  const devices = [
    {
      id: "phone",
      name: "Phone",
      tokenSha256: createHash("sha256").update(token).digest("hex"),
    },
  ];
  expect(authenticateDevice(`Bearer ${token}`, devices)).toBe("phone");
  expect(authenticateDevice(`Bearer ${token}x`, devices)).toBeUndefined();
  expect(authenticateDevice(null, devices)).toBeUndefined();
  expect(() =>
    parseOperation({
      requestId: randomUUID(),
      kind: "prompt",
      sessionId: "../../escape",
      prompt: "hello",
    }),
  ).toThrow("sessionId");
  expect(() =>
    parseOperation({
      requestId: randomUUID(),
      kind: "create",
      workspaceId: "test",
      extra: true,
    }),
  ).toThrow("Unexpected");
});
