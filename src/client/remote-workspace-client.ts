import { randomUUID } from "node:crypto";
import { parseSessionId, type SessionId } from "../ids/runtime-id";
import { RemoteClient, type RemoteClientConfig } from "../remote/client";
import type { OperationReceipt } from "../remote/protocol";
import type { RemoteTuiSnapshot } from "../remote/tui-protocol";
import type { TuiSessionView } from "../tui/tui-session-controller";
import type {
  ClientConnection,
  ClientSessionSummary,
  SessionClient,
  WorkspaceClient,
} from "./session-client";
import { RemoteTuiView } from "./remote-tui-view";

const unsupported = async (): Promise<never> => {
  throw new Error(
    "This service TUI batch supports session creation, connection, history and status only.",
  );
};
const EMPTY_INTERACTION = Object.freeze({});
const noSubscription = () => () => {};

class RemoteTuiSession {
  readonly view: RemoteTuiView;
  readonly binding: SessionClient<TuiSessionView>;
  private snapshot: RemoteTuiSnapshot;
  private readonly abort = new AbortController();
  private unsubscribe?: () => void;
  private refreshing = false;
  private dirty = false;
  private lastKey = "";
  private retryTimer?: ReturnType<typeof setTimeout>;

  private constructor(
    private readonly transport: RemoteClient,
    snapshot: RemoteTuiSnapshot,
  ) {
    this.snapshot = snapshot;
    this.view = new RemoteTuiView(snapshot);
    this.binding = {
      sessionId: parseSessionId(snapshot.history.sessionId),
      workspaceRoot: snapshot.history.workspaceRoot,
      modelName: snapshot.history.modelName,
      projectionStore: this.view,
      readLastResponse: unsupported,
      skills: () => this.snapshot.skills,
      mcp: () => this.snapshot.mcp,
      bashGuard: () => this.snapshot.bashGuard,
      subscribeBashGuard: this.view.subscribe,
      askUser: () => EMPTY_INTERACTION,
      subscribeAskUser: noSubscription,
      setYoloMode: unsupported,
      resolveAskUser: unsupported,
      resolveBashConfirmation: unsupported,
      admitTurn: unsupported,
      executeTurn: unsupported,
    };
  }

  static async open(
    config: RemoteClientConfig,
    workspaceId: string,
    sessionId: string,
  ): Promise<RemoteTuiSession> {
    const transport = new RemoteClient(config, false);
    try {
      const snapshot = await transport.request<RemoteTuiSnapshot>(
        `/v1/sessions/${sessionId}/tui-snapshot`,
      );
      validate(snapshot, workspaceId, sessionId);
      const session = new RemoteTuiSession(transport, snapshot);
      session.unsubscribe = transport.subscribe(() => session.changed());
      await transport.select(sessionId, workspaceId);
      return session;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }
  private changed(): void {
    if (this.abort.signal.aborted) return;
    const state = this.transport.getSnapshot();
    this.view.setConnection(state.connection, state.error);
    const key = JSON.stringify([
      state.connection,
      state.view?.status,
      state.view?.activeRequestId,
      state.view?.history.messages.map((m) => [m.id, m.turnStatus]),
    ]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (state.connection !== "online") return;
    this.dirty = true;
    void this.refresh();
  }
  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      while (this.dirty && !this.abort.signal.aborted) {
        this.dirty = false;
        const next = await this.transport.request<RemoteTuiSnapshot>(
          `/v1/sessions/${this.binding.sessionId}/tui-snapshot`,
          undefined,
          this.abort.signal,
        );
        if (this.abort.signal.aborted) return;
        validate(
          next,
          this.snapshot.activity.session.workspaceId,
          this.binding.sessionId,
        );
        this.snapshot = next;
        this.view.update(next);
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.view.setConnection(
          this.transport.getSnapshot().connection,
          errorMessage(error),
        );
        this.retryTimer ??= setTimeout(() => {
          this.retryTimer = undefined;
          if (this.abort.signal.aborted) return;
          this.dirty = true;
          void this.refresh();
        }, 1000);
      }
    } finally {
      this.refreshing = false;
    }
  }
  async close(): Promise<void> {
    this.abort.abort();
    this.unsubscribe?.();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.transport.close();
  }
}

/** No local runtime or local workspace reads. Each terminal owns only its subscriptions. */
export class RemoteWorkspaceClient implements WorkspaceClient<TuiSessionView> {
  private current?: RemoteTuiSession;
  private readonly listeners = new Set<() => void>();
  private readonly abort = new AbortController();
  private pending?: Promise<void>;
  private readonly transport: RemoteClient;
  constructor(
    private readonly config: RemoteClientConfig,
    private readonly workspaceId: string,
  ) {
    this.transport = new RemoteClient(config, false);
  }
  async initialize(sessionId?: string): Promise<void> {
    const workspaces = await this.transport.workspaces();
    if (!workspaces.workspaces.some((w) => w.id === this.workspaceId))
      throw new Error("Workspace is not configured on the service.");
    // Check the additive full-TUI endpoint before creating any session.
    await this.listSessions();
    if (sessionId) await this.resume(parseSessionId(sessionId));
    else await this.clear();
  }
  readonly getBinding = (): SessionClient<TuiSessionView> => {
    if (!this.current) throw new Error("Service session is not connected.");
    return this.current.binding;
  };
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async listSessions(): Promise<readonly ClientSessionSummary[]> {
    const result = await this.transport.request<{ sessions: ClientSessionSummary[] }>(
      `/v1/workspaces/${this.workspaceId}/tui-sessions`,
      undefined,
      this.abort.signal,
    );
    return result.sessions.map((session) =>
      session.sessionId === this.current?.binding.sessionId
        ? { ...session, status: "current", canConnect: false }
        : session,
    );
  }
  clear(beforeCommit?: () => void): Promise<void> {
    return this.replace(
      async () => this.operation({ kind: "create", workspaceId: this.workspaceId }),
      beforeCommit,
    );
  }
  resume(sessionId: SessionId, beforeCommit?: () => void): Promise<void> {
    return this.replace(async () => {
      if (sessionId === this.current?.binding.sessionId)
        throw new Error(`Session ${sessionId} is already current.`);
      const session = (await this.listSessions()).find(
        (entry) => entry.sessionId === sessionId,
      );
      if (!session) throw new Error("Session does not belong to this workspace.");
      if (session.canConnect) return sessionId;
      if (session.status !== "resumable" && session.status !== "interrupted")
        throw new Error("Exit the local session before connecting it to the service.");
      return this.operation({
        kind: "adopt",
        workspaceId: this.workspaceId,
        sessionId,
      });
    }, beforeCommit);
  }
  private async operation(input: Record<string, string>): Promise<string> {
    const request = { ...input, requestId: randomUUID() };
    let receipt = await this.transport.request<OperationReceipt>(
      "/v1/operations",
      request,
      this.abort.signal,
    );
    const deadline = Date.now() + 30000;
    while (receipt.status === "accepted" || receipt.status === "running") {
      if (Date.now() >= deadline)
        throw new Error(`Session operation is still pending: ${receipt.requestId}.`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      receipt = await this.transport.request<OperationReceipt>(
        `/v1/operations/${receipt.requestId}`,
        undefined,
        this.abort.signal,
      );
    }
    if (receipt.status !== "completed")
      throw new Error(receipt.error ?? `Session operation ${receipt.status}.`);
    return receipt.sessionId;
  }
  private replace(
    prepare: () => Promise<string>,
    beforeCommit?: () => void,
  ): Promise<void> {
    if (this.abort.signal.aborted)
      return Promise.reject(new Error("Client is closed."));
    if (this.pending)
      return Promise.reject(new Error("Another session operation is already running."));
    const pending = (async () => {
      const id = await prepare();
      const target = await RemoteTuiSession.open(this.config, this.workspaceId, id);
      if (this.abort.signal.aborted) {
        await target.close();
        return;
      }
      const previous = this.current;
      try {
        beforeCommit?.();
      } catch (error) {
        await target.close();
        throw error;
      }
      this.current = target;
      await previous?.close();
      for (const listener of this.listeners) listener();
    })().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }
  compact = unsupported;
  retire = unsupported;
  undo = unsupported;
  fork = unsupported;
  delete = unsupported;
  switchModel = unsupported;
  async close(): Promise<void> {
    this.abort.abort();
    await this.pending?.catch(() => undefined);
    await this.current?.close();
    await this.transport.close();
    this.listeners.clear();
  }
}

export async function createRemoteTuiClient(
  config: RemoteClientConfig,
  workspaceId: string,
  sessionId?: string,
): Promise<ClientConnection<TuiSessionView>> {
  const client = new RemoteWorkspaceClient(config, workspaceId);
  try {
    await client.initialize(sessionId);
    return { client, close: () => client.close() };
  } catch (error) {
    await client.close();
    throw error;
  }
}
function validate(
  snapshot: RemoteTuiSnapshot,
  workspaceId: string,
  sessionId: string,
): void {
  if (
    snapshot.version !== 1 ||
    snapshot.activity.session.workspaceId !== workspaceId ||
    snapshot.history.sessionId !== sessionId ||
    snapshot.activity.session.id !== sessionId
  )
    throw new Error("Service snapshot identity or version does not match.");
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
