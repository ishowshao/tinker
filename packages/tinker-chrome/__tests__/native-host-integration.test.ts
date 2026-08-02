import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ChromeBridgeServer } from "../src/bridge-server";
import {
  EXTENSION_ORIGIN,
  NATIVE_HOST_NAME,
  PLUGIN_CAPABILITIES_V2,
} from "../src/constants";
import { encodeJsonFrame, JsonFrameDecoder } from "../src/frame-codec";
import type { BridgeRequestV2 } from "../src/protocol-v2";
import {
  ensureRuntimeDirectories,
  publishRuntimeRegistry,
  removeRuntimeRegistry,
  runtimeDirectories,
  runtimeSocketPath,
  type RuntimeRegistryV1,
} from "../src/runtime-registry";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await waitForExit(child);
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true });
  }
});

test("Native Host subprocess relays a complete plugin-to-MCP RPC", async () => {
  const { home, runtimeRoot } = await createHostEnvironment();

  const bridge = await ChromeBridgeServer.start({
    runtimeRoot,
    log: () => undefined,
  });
  const child = spawnNativeHost(home);
  const plugin = new NativeMessagingPeer(child);
  plugin.send({
    kind: "plugin_hello",
    protocolVersion: 2,
    pluginVersion: "test-plugin",
    capabilities: [...PLUGIN_CAPABILITIES_V2],
  });

  expect(await plugin.next()).toEqual({
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
  const request = (await plugin.next()) as BridgeRequestV2;
  expect(request.method).toBe("page.open");
  plugin.send({
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

  child.stdin.end();
  expect(await waitForExit(child)).toBe(0);
  children.splice(children.indexOf(child), 1);
  await bridge.close();
});

test("Native Host waits when Chrome starts before the MCP runtime", async () => {
  const { home, runtimeRoot } = await createHostEnvironment();
  const child = spawnNativeHost(home);
  const plugin = new NativeMessagingPeer(child);
  plugin.send(pluginHello());

  await Bun.sleep(100);
  const bridge = await ChromeBridgeServer.start({
    runtimeRoot,
    log: () => undefined,
  });
  expect(await plugin.next(8_000)).toEqual({
    kind: "hello_ack",
    protocolVersion: 2,
    runtimeId: bridge.runtimeId,
  });

  child.stdin.end();
  expect(await waitForExit(child)).toBe(0);
  children.splice(children.indexOf(child), 1);
  await bridge.close();
});

test("Native Host rediscovers after a selected runtime vanishes", async () => {
  const { home, runtimeRoot } = await createHostEnvironment();
  const directories = runtimeDirectories(runtimeRoot);
  await ensureRuntimeDirectories(directories);
  const runtimeId = randomUUID();
  const socketPath = runtimeSocketPath(runtimeId, directories);
  let acceptConnection: (() => void) | undefined;
  const accepted = new Promise<void>((resolve) => {
    acceptConnection = resolve;
  });
  const deadServer = net.createServer((socket) => {
    socket.destroy();
    acceptConnection?.();
  });
  await listen(deadServer, socketPath);
  await chmod(socketPath, 0o600);
  const deadRegistry: RuntimeRegistryV1 = {
    schemaVersion: 1,
    protocolVersion: 2,
    runtimeId,
    pid: process.pid,
    socketPath,
    authToken: randomBytes(32).toString("base64url"),
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };
  await publishRuntimeRegistry(deadRegistry, directories);

  const child = spawnNativeHost(home);
  const plugin = new NativeMessagingPeer(child);
  plugin.send(pluginHello());
  await accepted;
  await closeServer(deadServer);
  await removeRuntimeRegistry(deadRegistry, directories);

  const bridge = await ChromeBridgeServer.start({
    runtimeRoot,
    log: () => undefined,
  });
  expect(await plugin.next(8_000)).toEqual({
    kind: "hello_ack",
    protocolVersion: 2,
    runtimeId: bridge.runtimeId,
  });

  child.stdin.end();
  expect(await waitForExit(child)).toBe(0);
  children.splice(children.indexOf(child), 1);
  await bridge.close();
}, 10_000);

test("Native Host exits after a fatal plugin protocol error", async () => {
  const { home } = await createHostEnvironment();
  const child = spawnNativeHost(home);
  const plugin = new NativeMessagingPeer(child);
  plugin.send({ kind: "invalid" });

  expect(await waitForExitWithTimeout(child, 2_000)).toBe(1);
  children.splice(children.indexOf(child), 1);
});

class NativeMessagingPeer {
  private readonly decoder = new JsonFrameDecoder();
  private readonly messages: unknown[] = [];
  private readonly waiters: Array<(value: unknown) => void> = [];
  private readonly stderr: string[] = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk) => {
      for (const message of this.decoder.push(Buffer.from(chunk))) {
        const waiter = this.waiters.shift();
        if (waiter === undefined) {
          this.messages.push(message);
        } else {
          waiter(message);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
  }

  send(message: unknown): void {
    this.child.stdin.write(encodeJsonFrame(message));
  }

  next(timeoutMs = 3_000): Promise<unknown> {
    const queued = this.messages.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return Promise.race([
      new Promise<unknown>((resolve) => this.waiters.push(resolve)),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Timed out waiting for Native Host frame. ${this.stderr.join("")}`,
              ),
            ),
          timeoutMs,
        ),
      ),
    ]);
  }
}

async function createHostEnvironment(): Promise<{
  home: string;
  runtimeRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tinker-chrome-host-"));
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(home, "native-host-config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      nativeHostName: NATIVE_HOST_NAME,
      extensionOrigin: EXTENSION_ORIGIN,
      runtimeRoot,
    })}\n`,
    { mode: 0o600 },
  );
  return { home, runtimeRoot };
}

function spawnNativeHost(home: string): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dir, "../src/cli.ts"), "native-host", EXTENSION_ORIGIN],
    {
      env: { ...process.env, TINKER_CHROME_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.push(child);
  return child;
}

function pluginHello(): unknown {
  return {
    kind: "plugin_hello",
    protocolVersion: 2,
    pluginVersion: "test-plugin",
    capabilities: [...PLUGIN_CAPABILITIES_V2],
  };
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

function waitForExitWithTimeout(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<number | null> {
  return Promise.race([
    waitForExit(child),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Timed out waiting for process exit.")),
        timeoutMs,
      ),
    ),
  ]);
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}
