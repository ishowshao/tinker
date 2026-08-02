import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import {
  PLUGIN_HELLO_TIMEOUT_MS,
  PROTOCOL_VERSION_V2,
  RPC_HEARTBEAT_INTERVAL_MS,
  RPC_HEARTBEAT_TIMEOUT_MS,
} from "./constants";
import { ChromeBridgeError } from "./errors";
import { encodeJsonFrame, JsonFrameDecoder } from "./frame-codec";
import {
  type BridgeHelloAckV2,
  type BridgeMethodV2,
  type BridgePingV2,
  type BridgeRequestV2,
  isReadOnlyBridgeMethodV2,
  parseBridgeHelloV2,
  parseBridgePongV2,
  parseBridgeRequestV2,
  parseBridgeResponseV2,
  parseBridgeResultV2,
} from "./protocol-v2";
import {
  defaultRuntimeRoot,
  ensureRuntimeDirectories,
  publishRuntimeRegistry,
  removeRuntimeRegistry,
  runtimeDirectories,
  type RuntimeDirectories,
  type RuntimeRegistryV1,
  runtimeSocketPath,
  scanRuntimeRegistries,
} from "./runtime-registry";

type PendingRequest = {
  method: BridgeMethodV2;
  resolve(value: unknown): void;
  reject(error: ChromeBridgeError): void;
  timer: ReturnType<typeof setTimeout>;
};

export type ChromeBridgeServerOptions = {
  cwd?: string;
  runtimeRoot?: string;
  log?: (event: string, details?: Record<string, unknown>) => void;
};

export class ChromeBridgeServer {
  readonly runtimeId: string;
  readonly registry: RuntimeRegistryV1;

  private readonly directories: RuntimeDirectories;
  private readonly server: net.Server;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly log: NonNullable<ChromeBridgeServerOptions["log"]>;
  private socket: net.Socket | undefined;
  private decoder: JsonFrameDecoder | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private lastReceivedAt = 0;
  private ready = false;
  private closing = false;

  private constructor(options: {
    runtimeId: string;
    registry: RuntimeRegistryV1;
    directories: RuntimeDirectories;
    server: net.Server;
    log: NonNullable<ChromeBridgeServerOptions["log"]>;
  }) {
    this.runtimeId = options.runtimeId;
    this.registry = options.registry;
    this.directories = options.directories;
    this.server = options.server;
    this.log = options.log;
  }

  static async start(
    options: ChromeBridgeServerOptions = {},
  ): Promise<ChromeBridgeServer> {
    const runtimeId = randomUUID();
    const directories = runtimeDirectories(options.runtimeRoot ?? defaultRuntimeRoot());
    await ensureRuntimeDirectories(directories);
    await scanRuntimeRegistries({
      root: directories.root,
      cleanupStale: true,
    });

    const socketPath = runtimeSocketPath(runtimeId, directories);
    await unlink(socketPath).catch(ignoreMissing);
    const registry: RuntimeRegistryV1 = {
      schemaVersion: 1,
      protocolVersion: 2,
      runtimeId,
      pid: process.pid,
      socketPath,
      authToken: randomBytes(32).toString("base64url"),
      cwd: path.resolve(options.cwd ?? process.cwd()),
      startedAt: new Date().toISOString(),
    };
    const server = net.createServer();
    const log = options.log ?? defaultLog;
    const bridge = new ChromeBridgeServer({
      runtimeId,
      registry,
      directories,
      server,
      log,
    });
    server.on("connection", (socket) => bridge.acceptConnection(socket));
    server.on("error", (error) => {
      log("socket_server_error", { message: error.message });
    });

    try {
      await listen(server, socketPath);
      await chmod(socketPath, 0o600);
      await publishRuntimeRegistry(registry, directories);
    } catch (error) {
      await closeServer(server).catch(() => undefined);
      await unlink(socketPath).catch(() => undefined);
      throw error;
    }

    log("runtime_published", {
      runtimeId,
      pid: process.pid,
      cwd: registry.cwd,
    });
    return bridge;
  }

  isReady(): boolean {
    return this.ready;
  }

  async request(
    method: BridgeMethodV2,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Bridge request timeout must be a positive integer.");
    }
    const scan = await scanRuntimeRegistries({ root: this.directories.root });
    if (scan.live.length > 1) {
      throw new ChromeBridgeError({
        code: "MULTIPLE_RUNTIMES_UNSUPPORTED",
        message: `Found ${scan.live.length} active Tinker Chrome runtimes.`,
        retryable: false,
        outcome: "not_started",
        details: { runtimeCount: scan.live.length },
      });
    }
    if (!this.ready || this.socket === undefined) {
      throw new ChromeBridgeError({
        code: "PLUGIN_NOT_CONNECTED",
        message: "The Tinker Chrome extension is not connected.",
        retryable: true,
        outcome: "not_started",
      });
    }

    const requestId = randomUUID();
    const deadlineUnixMs = Date.now() + timeoutMs;
    const request: BridgeRequestV2 = parseBridgeRequestV2({
      kind: "request",
      protocolVersion: PROTOCOL_VERSION_V2,
      runtimeId: this.runtimeId,
      requestId,
      method,
      deadlineUnixMs,
      params,
    });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new ChromeBridgeError({
            code: "REQUEST_TIMEOUT",
            message: `Chrome bridge request ${method} timed out.`,
            retryable: isReadOnlyBridgeMethodV2(method),
            outcome: "unknown",
          }),
        );
      }, timeoutMs + 1_000);
      timer.unref();
      this.pending.set(requestId, {
        method,
        resolve,
        reject,
        timer,
      });
      this.write(request).catch((error) => {
        const pending = this.pending.get(requestId);
        if (pending === undefined) {
          return;
        }
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(disconnectedError(method, error));
        this.disconnectSocket();
      });
      this.log("rpc_started", { method, requestId });
    });
  }

  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.disconnectSocket();
    await closeServer(this.server);
    await removeRuntimeRegistry(this.registry, this.directories);
    this.log("runtime_removed", { runtimeId: this.runtimeId });
  }

  private acceptConnection(socket: net.Socket): void {
    if (this.closing || this.socket !== undefined) {
      socket.destroy();
      this.log("native_host_rejected", { reason: "connection_already_active" });
      return;
    }

    this.socket = socket;
    this.decoder = new JsonFrameDecoder();
    this.ready = false;
    this.lastReceivedAt = Date.now();
    socket.on("data", (chunk) => this.receive(Buffer.from(chunk)));
    socket.on("error", (error) => {
      this.log("native_host_socket_error", { message: error.message });
    });
    socket.on("close", () => this.handleSocketClose(socket));
    this.handshakeTimer = setTimeout(() => {
      this.log("native_host_handshake_failed", { reason: "timeout" });
      socket.destroy();
    }, PLUGIN_HELLO_TIMEOUT_MS);
    this.handshakeTimer.unref();
  }

  private receive(chunk: Buffer): void {
    if (this.decoder === undefined || this.socket === undefined) {
      return;
    }

    try {
      for (const rawMessage of this.decoder.push(chunk)) {
        this.lastReceivedAt = Date.now();
        if (!this.ready) {
          this.acceptHello(rawMessage);
          continue;
        }
        this.acceptReadyMessage(rawMessage);
      }
    } catch (error) {
      this.log("native_host_protocol_error", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.socket.destroy();
    }
  }

  private acceptHello(rawMessage: unknown): void {
    const hello = parseBridgeHelloV2(rawMessage);
    if (hello.runtimeId !== this.runtimeId) {
      throw new ChromeBridgeError({
        code: "BRIDGE_AUTH_FAILED",
        message: "Native Host selected the wrong runtime.",
        retryable: false,
        outcome: "not_started",
      });
    }
    if (!tokensEqual(hello.authToken, this.registry.authToken)) {
      throw new ChromeBridgeError({
        code: "BRIDGE_AUTH_FAILED",
        message: "Native Host authentication failed.",
        retryable: false,
        outcome: "not_started",
      });
    }
    if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(hello.extensionOrigin)) {
      throw new ChromeBridgeError({
        code: "BRIDGE_AUTH_FAILED",
        message: "Native Host supplied an invalid extension origin.",
        retryable: false,
        outcome: "not_started",
      });
    }

    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    this.ready = true;
    const ack: BridgeHelloAckV2 = {
      kind: "hello_ack",
      protocolVersion: PROTOCOL_VERSION_V2,
      runtimeId: this.runtimeId,
    };
    void this.write(ack).catch((error) => {
      this.log("native_host_ack_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.disconnectSocket();
    });
    this.startHeartbeat();
    this.log("native_host_connected", {
      runtimeId: this.runtimeId,
      pluginVersion: hello.pluginVersion,
    });
  }

  private acceptReadyMessage(rawMessage: unknown): void {
    if (
      typeof rawMessage === "object" &&
      rawMessage !== null &&
      "kind" in rawMessage &&
      rawMessage.kind === "pong"
    ) {
      const pong = parseBridgePongV2(rawMessage);
      if (pong.runtimeId !== this.runtimeId) {
        throw new Error("Pong runtimeId does not match the active runtime.");
      }
      return;
    }

    const response = parseBridgeResponseV2(rawMessage);
    if (response.runtimeId !== this.runtimeId) {
      throw new Error("Response runtimeId does not match the active runtime.");
    }
    const pending = this.pending.get(response.requestId);
    if (pending === undefined) {
      this.log("rpc_response_ignored", {
        requestId: response.requestId,
        reason: "request_not_pending",
      });
      return;
    }
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(parseBridgeResultV2(pending.method, response.result));
      this.log("rpc_finished", {
        method: pending.method,
        requestId: response.requestId,
        ok: true,
      });
      return;
    }

    pending.reject(
      new ChromeBridgeError({
        code: response.error.code,
        message: response.error.message,
        retryable: response.error.retryable,
        outcome: response.error.outcome,
        details: response.error.details,
      }),
    );
    this.log("rpc_finished", {
      method: pending.method,
      requestId: response.requestId,
      ok: false,
      code: response.error.code,
    });
  }

  private startHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.ready) {
        return;
      }
      if (Date.now() - this.lastReceivedAt > RPC_HEARTBEAT_TIMEOUT_MS) {
        this.log("native_host_disconnected", { reason: "heartbeat_timeout" });
        this.disconnectSocket();
        return;
      }
      const ping: BridgePingV2 = {
        kind: "ping",
        protocolVersion: PROTOCOL_VERSION_V2,
        runtimeId: this.runtimeId,
        sentAtUnixMs: Date.now(),
      };
      void this.write(ping).catch(() => this.disconnectSocket());
    }, RPC_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private async write(message: unknown): Promise<void> {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) {
      throw new Error("Native Host socket is not connected.");
    }
    const frame = encodeJsonFrame(message);
    await new Promise<void>((resolve, reject) => {
      socket.write(frame, (error) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  private handleSocketClose(socket: net.Socket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.decoder = undefined;
    this.ready = false;
    clearTimeout(this.handshakeTimer);
    clearInterval(this.heartbeatTimer);
    this.handshakeTimer = undefined;
    this.heartbeatTimer = undefined;
    this.failPendingRequests();
    if (!this.closing) {
      this.log("native_host_disconnected", { reason: "socket_closed" });
    }
  }

  private disconnectSocket(): void {
    const socket = this.socket;
    if (socket !== undefined) {
      socket.destroy();
      this.handleSocketClose(socket);
    }
  }

  private failPendingRequests(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(disconnectedError(pending.method));
    }
    this.pending.clear();
  }
}

function disconnectedError(method: BridgeMethodV2, cause?: unknown): ChromeBridgeError {
  return new ChromeBridgeError({
    code: method === "page.open" ? "OPEN_PAGE_OUTCOME_UNKNOWN" : "BRIDGE_DISCONNECTED",
    message: "The Chrome bridge disconnected before the response arrived.",
    retryable: isReadOnlyBridgeMethodV2(method),
    outcome: "unknown",
    cause,
  });
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
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

function defaultLog(event: string, details?: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ component: "tinker-chrome-mcp", event, ...details })}\n`,
  );
}

function ignoreMissing(error: unknown): void {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    error.code !== "ENOENT"
  ) {
    throw error;
  }
}
