import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ChromeBridgeServer } from "../src/bridge-server";
import { PLUGIN_CAPABILITIES_V2 } from "../src/constants";
import { ChromeBridgeError } from "../src/errors";
import { encodeJsonFrame, JsonFrameDecoder } from "../src/frame-codec";
import type { BridgeRequestV2 } from "../src/protocol-v2";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true });
  }
});

test("Tinker Chrome bridge authenticates and completes an RPC", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tinker-chrome-bridge-"));
  roots.push(root);
  const bridge = await ChromeBridgeServer.start({
    runtimeRoot: root,
    log: () => undefined,
  });
  const peer = await FramedPeer.connect(bridge.registry.socketPath);

  peer.send({
    kind: "hello",
    protocolVersion: 2,
    runtimeId: bridge.runtimeId,
    authToken: bridge.registry.authToken,
    extensionOrigin: "chrome-extension://bakgbafndlkajmiifhlndicifmhdchpn/",
    pluginVersion: "0.1.0",
    capabilities: [...PLUGIN_CAPABILITIES_V2],
  });
  expect(await peer.next()).toEqual({
    kind: "hello_ack",
    protocolVersion: 2,
    runtimeId: bridge.runtimeId,
  });
  expect(bridge.isReady()).toBe(true);

  const pageId = crypto.randomUUID();
  const pending = bridge.request(
    "page.open",
    { pageId, url: "https://example.com/" },
    2_000,
  );
  const request = (await peer.next()) as BridgeRequestV2;
  expect(request.method).toBe("page.open");
  peer.send({
    kind: "response",
    protocolVersion: 2,
    runtimeId: bridge.runtimeId,
    requestId: request.requestId,
    ok: true,
    result: {
      schemaVersion: 2,
      pageId,
      url: "https://example.com/",
      title: "Example Domain",
      loadState: "complete",
    },
  });
  expect(await pending).toEqual({
    schemaVersion: 2,
    pageId,
    url: "https://example.com/",
    title: "Example Domain",
    loadState: "complete",
  });

  peer.close();
  await bridge.close();
});

test("Tinker Chrome bridge reports an unknown non-retryable action outcome on disconnect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tinker-chrome-bridge-"));
  roots.push(root);
  const bridge = await ChromeBridgeServer.start({
    runtimeRoot: root,
    log: () => undefined,
  });
  const peer = await FramedPeer.connect(bridge.registry.socketPath);
  peer.send({
    kind: "hello",
    protocolVersion: 2,
    runtimeId: bridge.runtimeId,
    authToken: bridge.registry.authToken,
    extensionOrigin: "chrome-extension://bakgbafndlkajmiifhlndicifmhdchpn/",
    pluginVersion: "0.2.0",
    capabilities: [...PLUGIN_CAPABILITIES_V2],
  });
  await peer.next();

  const pending = bridge.request(
    "page.click",
    { pageId: crypto.randomUUID(), uid: "1_1", doubleClick: false },
    2_000,
  );
  await peer.next();
  peer.close();
  const error = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ChromeBridgeError);
  expect(error).toMatchObject({
    code: "BRIDGE_DISCONNECTED",
    retryable: false,
    outcome: "unknown",
  });
  await bridge.close();
});

class FramedPeer {
  private readonly decoder = new JsonFrameDecoder();
  private readonly messages: unknown[] = [];
  private readonly waiters: Array<(value: unknown) => void> = [];

  private constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk) => {
      for (const message of this.decoder.push(Buffer.from(chunk))) {
        const waiter = this.waiters.shift();
        if (waiter === undefined) {
          this.messages.push(message);
        } else {
          waiter(message);
        }
      }
    });
  }

  static async connect(socketPath: string): Promise<FramedPeer> {
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new FramedPeer(socket);
  }

  send(message: unknown): void {
    this.socket.write(encodeJsonFrame(message));
  }

  next(): Promise<unknown> {
    const queued = this.messages.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return Promise.race([
      new Promise<unknown>((resolve) => this.waiters.push(resolve)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for frame.")), 2_000),
      ),
    ]);
  }

  close(): void {
    this.socket.destroy();
  }
}
