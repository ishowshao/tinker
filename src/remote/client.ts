import { readFile, chmod, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WebSocketOptions } from "bun";
import type {
  RemoteHistoryPage,
  RemoteMessage,
} from "../session/remote-history-reader";
import {
  requireObject,
  requireText,
  type RemoteOperationInput,
  type RemoteView,
  type RemoteFrame,
  type OperationReceipt,
  type RemoteSessionInfo,
} from "./protocol";

export type RemoteClientConfig = {
  url: string;
  token: string;
  ca?: string;
  statePath: string;
};
export async function loadRemoteClientConfig(
  filename: string,
): Promise<RemoteClientConfig> {
  const raw = requireObject(JSON.parse(await readFile(filename, "utf8")));
  const url = new URL(requireText(raw.url, "url", 4096));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Pairing URL must be an HTTPS origin.");
  const token = requireText(raw.token, "token", 128);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token))
    throw new Error("Pairing token is invalid.");
  const ca =
    raw.caFile === undefined
      ? undefined
      : await readFile(
          path.resolve(path.dirname(filename), requireText(raw.caFile, "caFile", 4096)),
          "utf8",
        );
  return { url: url.origin, token, ca, statePath: `${filename}.state.json` };
}

type ClientState = {
  sessionId?: string;
  workspaceId?: string;
  outbox: RemoteOperationInput[];
  failures: { requestId: string; message: string }[];
};
export type ClientSnapshot = {
  connection: "connecting" | "online" | "offline" | "closed";
  view?: RemoteView;
  pending: number;
  error?: string;
};

export function mergeRemoteMessages(
  before: readonly RemoteMessage[],
  after: readonly RemoteMessage[],
): RemoteMessage[] {
  const all = new Map(before.map((message) => [message.id, message]));
  for (const message of after) all.set(message.id, message);
  return [...all.values()].sort((a, b) => a.ordinal - b.ordinal);
}

export function applyRemoteFrame(
  current: RemoteFrame | undefined,
  frame: RemoteFrame,
): RemoteFrame {
  if (frame.version !== 1) throw new Error("Unsupported remote protocol version.");
  if (frame.type === "snapshot") return frame;
  if (!current || current.type !== "snapshot" || frame.epoch !== current.epoch)
    throw new Error("A full snapshot is required.");
  if (frame.sequence <= current.sequence) return current;
  if (frame.sequence !== current.sequence + 1)
    throw new Error("Missing event; a full snapshot is required.");
  return {
    version: 1,
    type: "snapshot",
    epoch: frame.epoch,
    sequence: frame.sequence,
    view: {
      ...frame.change.activity,
      history: {
        ...current.view.history,
        messages: mergeRemoteMessages(
          current.view.history.messages,
          frame.change.messages,
        ),
      },
    },
  };
}

/** Optional terminal transport. Disk outbox IDs survive a lost HTTP response/restart. */
export class RemoteClient {
  private state: ClientState = { outbox: [], failures: [] };
  private frame?: RemoteFrame;
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private retryDelay = 500;
  private closed = false;
  private flushing = false;
  private diskTail: Promise<void> = Promise.resolve();
  private snapshot: ClientSnapshot = { connection: "connecting", pending: 0 };
  private readonly listeners = new Set<() => void>();
  constructor(readonly config: RemoteClientConfig) {}
  async initialize(): Promise<void> {
    try {
      this.state = JSON.parse(
        await readFile(this.config.statePath, "utf8"),
      ) as ClientState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.emit({ pending: this.state.outbox.length });
    if (this.state.sessionId) this.watch(this.state.sessionId);
    void this.flush();
  }
  getSnapshot = (): ClientSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get sessionId(): string | undefined {
    return this.state.sessionId;
  }
  get workspaceId(): string | undefined {
    return this.state.workspaceId;
  }
  workspaces(): Promise<{ workspaces: { id: string; name: string }[] }> {
    return this.request("/v1/workspaces");
  }
  sessions(workspaceId: string): Promise<{ sessions: RemoteSessionInfo[] }> {
    return this.request(`/v1/workspaces/${workspaceId}/sessions`);
  }
  operation(id: string): Promise<OperationReceipt> {
    return this.request(`/v1/operations/${id}`);
  }

  async select(sessionId: string, workspaceId: string): Promise<void> {
    this.state.sessionId = sessionId;
    this.state.workspaceId = workspaceId;
    await this.persist();
    this.frame = undefined;
    this.emit({ view: undefined });
    this.watch(sessionId);
  }
  async submit(
    input: Omit<RemoteOperationInput, "requestId"> & Record<string, unknown>,
  ): Promise<string> {
    const request = { ...input, requestId: randomUUID() } as RemoteOperationInput;
    this.state.outbox.push(request);
    await this.persist();
    this.emit({ pending: this.state.outbox.length });
    void this.flush();
    return request.requestId;
  }
  async loadOlderHistory(): Promise<void> {
    if (this.frame?.type !== "snapshot") return;
    const id = this.state.sessionId;
    const before = this.frame.view.history.beforeOrdinal;
    if (!id || !before) return;
    const page = await this.request<RemoteHistoryPage>(
      `/v1/sessions/${id}/history?before=${before}`,
    );
    if (id !== this.state.sessionId || this.frame?.type !== "snapshot") return;
    this.frame = {
      ...this.frame,
      view: {
        ...this.frame.view,
        history: {
          ...page,
          messages: mergeRemoteMessages(
            page.messages,
            this.frame.view.history.messages,
          ),
        },
      },
    };
    this.emit({ view: this.frame.view });
  }
  private async flush(): Promise<void> {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    try {
      while (this.state.outbox.length && !this.closed) {
        const input = this.state.outbox[0];
        try {
          const receipt = await this.request<OperationReceipt>("/v1/operations", input);
          this.state.outbox.shift();
          await this.persist();
          if (input.kind === "create" || input.kind === "adopt")
            await this.select(receipt.sessionId, input.workspaceId);
          this.emit({ pending: this.state.outbox.length, error: undefined });
        } catch (error) {
          this.emit({
            error: error instanceof Error ? error.message : String(error),
            connection: "offline",
          });
          if (
            error instanceof ClientHttpError &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 429
          ) {
            this.state.outbox.shift();
            this.state.failures.push({
              requestId: input.requestId,
              message: error.message,
            });
            this.state.failures = this.state.failures.slice(-20);
            await this.persist();
            this.emit({ pending: this.state.outbox.length });
          } else {
            this.reconnect();
            break;
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }
  private watch(id: string): void {
    this.socket?.close();
    if (this.closed) return;
    const url = new URL(`/v1/sessions/${id}/events`, this.config.url);
    url.protocol = "wss:";
    if (this.frame) {
      url.searchParams.set("epoch", this.frame.epoch);
      url.searchParams.set("after", String(this.frame.sequence));
    }
    this.emit({ connection: "connecting" });
    const BunWebSocket = WebSocket as unknown as {
      new (url: URL, options: WebSocketOptions): WebSocket;
    };
    const socket = new BunWebSocket(url, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      ...(this.config.ca
        ? { tls: { ca: this.config.ca, rejectUnauthorized: true } }
        : {}),
    });
    this.socket = socket;
    socket.onmessage = (event) => {
      if (socket !== this.socket || this.closed) return;
      try {
        this.frame = applyRemoteFrame(
          this.frame,
          JSON.parse(String(event.data)) as RemoteFrame,
        );
        this.retryDelay = 500;
        this.emit({
          connection: "online",
          view: this.frame.type === "snapshot" ? this.frame.view : undefined,
          error: undefined,
        });
        void this.flush();
      } catch {
        this.frame = undefined;
        socket.close();
      }
    };
    socket.onclose = () => {
      if (socket === this.socket && !this.closed) {
        this.emit({ connection: "offline" });
        this.reconnect();
      }
    };
    socket.onerror = () => {
      if (socket === this.socket && !this.closed) {
        this.emit({ connection: "offline" });
        socket.close();
        this.reconnect();
      }
    };
  }
  private reconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.state.sessionId) this.watch(this.state.sessionId);
      void this.flush();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 10000);
  }
  async request<T>(route: string, input?: unknown): Promise<T> {
    const response = await fetch(new URL(route, this.config.url), {
      method: input === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      ...(this.config.ca
        ? { tls: { ca: this.config.ca, rejectUnauthorized: true } }
        : {}),
      signal: AbortSignal.timeout(15000),
    });
    const result = (await response.json()) as T & { error?: { message: string } };
    if (!response.ok)
      throw new ClientHttpError(
        response.status,
        result.error?.message ?? `HTTP ${response.status}`,
      );
    return result;
  }
  private persist(): Promise<void> {
    const data = JSON.stringify(this.state);
    this.diskTail = this.diskTail.then(async () => {
      await mkdir(path.dirname(this.config.statePath), {
        recursive: true,
        mode: 0o700,
      });
      const temp = `${this.config.statePath}.${process.pid}.tmp`;
      await writeFile(temp, data, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, this.config.statePath);
    });
    return this.diskTail;
  }
  private emit(patch: Partial<ClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    await this.diskTail;
    this.emit({ connection: "closed" });
  }
}
class ClientHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
