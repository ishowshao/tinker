import net from "node:net";
import process from "node:process";
import { PLUGIN_HELLO_TIMEOUT_MS, PROTOCOL_VERSION_V2 } from "./constants";
import { encodeJsonFrame, JsonFrameDecoder } from "./frame-codec";
import { loadNativeHostConfig, type NativeHostConfigV1 } from "./install-host";
import {
  type BridgeHelloV2,
  type PluginHelloV2,
  parseBridgeHelloAckV2,
  parseBridgePingV2,
  parseBridgePongV2,
  parseBridgeRequestV2,
  parseBridgeResponseV2,
  parsePluginHelloV2,
} from "./protocol-v2";
import { type RuntimeRegistryV1, scanRuntimeRegistries } from "./runtime-registry";

export async function runNativeHost(chromeArgs: string[]): Promise<void> {
  const config = await loadNativeHostConfig();
  const chromeOrigin = chromeArgs[0];
  if (chromeOrigin !== config.extensionOrigin) {
    throw new Error(
      `Native Host caller origin does not match ${config.extensionOrigin}.`,
    );
  }

  const host = new NativeHostBridge(config);
  await host.run();
}

class NativeHostBridge {
  private readonly pluginDecoder = new JsonFrameDecoder();
  private readonly config: NativeHostConfigV1;
  private pluginHello: PluginHelloV2 | undefined;
  private socket: net.Socket | undefined;
  private socketDecoder: JsonFrameDecoder | undefined;
  private selectedRuntime: RuntimeRegistryV1 | undefined;
  private bridgeReady = false;
  private bridgeHandshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private discoveryRunning = false;
  private rediscoveryRequested = false;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveDone: (() => void) | undefined;
  private rejectDone: ((error: Error) => void) | undefined;

  constructor(config: NativeHostConfigV1) {
    this.config = config;
  }

  run(): Promise<void> {
    const done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    process.stdin.on("data", this.onPluginData);
    process.stdin.once("end", this.onPluginEnd);
    process.stdin.once("error", this.onPluginError);
    process.stdin.resume();
    this.helloTimer = setTimeout(() => {
      this.fail(new Error("Plugin did not send plugin_hello within 5 seconds."));
    }, PLUGIN_HELLO_TIMEOUT_MS);
    this.helloTimer.unref();
    log("native_host_started");
    return done;
  }

  private readonly onPluginData = (chunk: Buffer): void => {
    try {
      for (const rawMessage of this.pluginDecoder.push(chunk)) {
        this.handlePluginMessage(rawMessage);
      }
    } catch (error) {
      this.fail(asError(error));
    }
  };

  private readonly onPluginEnd = (): void => {
    try {
      this.pluginDecoder.end();
      this.close();
    } catch (error) {
      this.fail(asError(error));
    }
  };

  private readonly onPluginError = (error: Error): void => {
    this.fail(error);
  };

  private handlePluginMessage(rawMessage: unknown): void {
    if (this.pluginHello === undefined) {
      this.pluginHello = parsePluginHelloV2(rawMessage);
      clearTimeout(this.helloTimer);
      this.helloTimer = undefined;
      log("plugin_hello_received", {
        pluginVersion: this.pluginHello.pluginVersion,
      });
      void this.discoverRuntime();
      return;
    }
    if (!this.bridgeReady || this.socket === undefined) {
      throw new Error("Plugin sent a message before bridge handshake completed.");
    }
    if (
      typeof rawMessage === "object" &&
      rawMessage !== null &&
      "kind" in rawMessage &&
      rawMessage.kind === "pong"
    ) {
      const pong = parseBridgePongV2(rawMessage);
      this.requireSelectedRuntime(pong.runtimeId);
      this.writeSocket(pong);
      return;
    }

    const response = parseBridgeResponseV2(rawMessage);
    this.requireSelectedRuntime(response.runtimeId);
    this.writeSocket(response);
  }

  private async discoverRuntime(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.discoveryRunning) {
      this.rediscoveryRequested = true;
      return;
    }
    this.discoveryRunning = true;
    this.rediscoveryRequested = false;
    try {
      while (!this.closed && this.socket === undefined) {
        const scan = await scanRuntimeRegistries({
          root: this.config.runtimeRoot,
          cleanupStale: true,
        });
        for (const invalid of scan.invalidEntries) {
          log("runtime_registry_ignored", {
            path: invalid.path,
            message: invalid.error,
          });
        }
        if (scan.live.length === 1) {
          try {
            await this.connectRuntime(scan.live[0]);
            return;
          } catch (error) {
            log("runtime_connect_failed", { message: asError(error).message });
          }
        } else if (scan.live.length > 1) {
          log("runtime_selection_blocked", { runtimeCount: scan.live.length });
        }
        await sleep(1_000);
      }
    } catch (error) {
      this.fail(asError(error));
    } finally {
      this.discoveryRunning = false;
      if (this.rediscoveryRequested && !this.closed && this.socket === undefined) {
        void this.discoverRuntime();
      }
    }
  }

  private async connectRuntime(registry: RuntimeRegistryV1): Promise<void> {
    if (this.pluginHello === undefined || this.socket !== undefined) {
      throw new Error("Native Host cannot connect the runtime in its current state.");
    }
    const socket = net.createConnection(registry.socketPath);
    this.socket = socket;
    this.socketDecoder = new JsonFrameDecoder();
    this.selectedRuntime = registry;
    this.bridgeReady = false;
    socket.on("data", this.onSocketData);
    socket.on("error", (error) => {
      log("runtime_socket_error", { message: error.message });
    });
    socket.on("close", () => this.onSocketClose(socket));

    try {
      await waitForUnixSocketConnection(socket, registry.socketPath, 1_000);
    } catch (error) {
      this.clearRuntimeSocket(socket);
      socket.destroy();
      throw error;
    }
    if (this.closed || this.socket !== socket || socket.destroyed) {
      this.clearRuntimeSocket(socket);
      socket.destroy();
      throw new Error(`Runtime socket ${registry.socketPath} closed while connecting.`);
    }

    const hello: BridgeHelloV2 = {
      kind: "hello",
      protocolVersion: PROTOCOL_VERSION_V2,
      runtimeId: registry.runtimeId,
      authToken: registry.authToken,
      extensionOrigin: this.config.extensionOrigin,
      pluginVersion: this.pluginHello.pluginVersion,
      capabilities: this.pluginHello.capabilities,
    };
    this.writeSocket(hello);
    this.bridgeHandshakeTimer = setTimeout(() => {
      if (this.socket === socket && !this.bridgeReady) {
        log("runtime_handshake_failed", {
          runtimeId: registry.runtimeId,
          reason: "timeout",
        });
        socket.destroy();
      }
    }, PLUGIN_HELLO_TIMEOUT_MS);
    this.bridgeHandshakeTimer.unref();
    log("runtime_socket_connected", { runtimeId: registry.runtimeId });
  }

  private readonly onSocketData = (chunk: Buffer): void => {
    try {
      const decoder = this.socketDecoder;
      if (decoder === undefined) {
        throw new Error("Runtime socket decoder is unavailable.");
      }
      for (const rawMessage of decoder.push(chunk)) {
        this.handleRuntimeMessage(rawMessage);
      }
    } catch (error) {
      this.fail(asError(error));
    }
  };

  private handleRuntimeMessage(rawMessage: unknown): void {
    if (!this.bridgeReady) {
      const ack = parseBridgeHelloAckV2(rawMessage);
      this.requireSelectedRuntime(ack.runtimeId);
      clearTimeout(this.bridgeHandshakeTimer);
      this.bridgeHandshakeTimer = undefined;
      this.bridgeReady = true;
      void this.writePlugin(ack);
      log("bridge_ready", { runtimeId: ack.runtimeId });
      return;
    }
    if (
      typeof rawMessage === "object" &&
      rawMessage !== null &&
      "kind" in rawMessage &&
      rawMessage.kind === "ping"
    ) {
      const ping = parseBridgePingV2(rawMessage);
      this.requireSelectedRuntime(ping.runtimeId);
      void this.writePlugin(ping);
      return;
    }

    const request = parseBridgeRequestV2(rawMessage);
    this.requireSelectedRuntime(request.runtimeId);
    void this.writePlugin(request);
  }

  private onSocketClose(socket: net.Socket): void {
    if (this.socket !== socket) {
      return;
    }
    const runtimeId = this.selectedRuntime?.runtimeId;
    const wasReady = this.bridgeReady;
    this.clearRuntimeSocket(socket);
    log("runtime_socket_disconnected", { runtimeId });
    if (wasReady) {
      this.close();
      return;
    }
    void this.discoverRuntime();
  }

  private clearRuntimeSocket(socket: net.Socket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.socketDecoder = undefined;
    this.selectedRuntime = undefined;
    this.bridgeReady = false;
    clearTimeout(this.bridgeHandshakeTimer);
    this.bridgeHandshakeTimer = undefined;
  }

  private writeSocket(message: unknown): void {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) {
      throw new Error("Runtime socket is not connected.");
    }
    socket.write(encodeJsonFrame(message), (error) => {
      if (error !== null && error !== undefined) {
        if (this.socket === socket && !this.bridgeReady) {
          log("runtime_handshake_failed", {
            runtimeId: this.selectedRuntime?.runtimeId,
            reason: "write_failed",
          });
          socket.destroy();
        } else {
          this.fail(error);
        }
      }
    });
  }

  private async writePlugin(message: unknown): Promise<void> {
    const frame = encodeJsonFrame(message);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(frame, (error) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    }).catch((error) => this.fail(asError(error)));
  }

  private requireSelectedRuntime(runtimeId: string): void {
    if (runtimeId !== this.selectedRuntime?.runtimeId) {
      throw new Error("Message runtimeId does not match the selected runtime.");
    }
  }

  private close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this.helloTimer);
    clearTimeout(this.bridgeHandshakeTimer);
    this.socket?.destroy();
    this.socket = undefined;
    process.stdin.off("data", this.onPluginData);
    process.stdin.off("end", this.onPluginEnd);
    process.stdin.off("error", this.onPluginError);
    process.stdin.pause();
    log("native_host_stopped");
    this.resolveDone?.();
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    log("native_host_failed", { message: error.message });
    this.closed = true;
    clearTimeout(this.helloTimer);
    clearTimeout(this.bridgeHandshakeTimer);
    this.socket?.destroy();
    this.socket = undefined;
    process.stdin.off("data", this.onPluginData);
    process.stdin.off("end", this.onPluginEnd);
    process.stdin.off("error", this.onPluginError);
    process.stdin.pause();
    this.rejectDone?.(error);
  }
}

function waitForUnixSocketConnection(
  socket: net.Socket,
  socketPath: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out connecting to runtime socket ${socketPath}.`));
    }, timeoutMs);
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Runtime socket ${socketPath} closed while connecting.`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function log(event: string, details?: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ component: "tinker-chrome-native-host", event, ...details })}\n`,
  );
}
