import { RemotePromptHistory } from "./remote-prompt-history";
import type { LoadedPromptHistoryRecord } from "../tui/prompt-history";
import type { ProjectSlashCommand } from "../tui/project-slash-commands";
import type { ViewFile } from "../tui/view-file";
import { RemoteImages } from "./remote-images";
import type { ClientModelProfile } from "./model-catalog";
import type {
  SessionOperation,
  SessionOperationResult,
} from "../remote/session-operations";
import { RemoteTasks } from "./remote-tasks";
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

class RemoteTuiSession {
  readonly view: RemoteTuiView;
  readonly binding: SessionClient<TuiSessionView>;
  readonly tasks: RemoteTasks;
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
    const tasks = (this.tasks = new RemoteTasks(
      transport,
      snapshot.activity.session.id,
      () => this.snapshot,
      this.abort.signal,
      (error) => this.view.setConnection(transport.getSnapshot().connection, error),
    ));
    const images = new RemoteImages(
      transport,
      snapshot.activity.session.id,
      this.abort.signal,
    );
    this.binding = {
      sessionId: parseSessionId(snapshot.history.sessionId),
      workspaceRoot: snapshot.history.workspaceRoot,
      modelName: snapshot.history.modelName,
      profileName: snapshot.profileName,
      modelProfiles: () =>
        this.snapshot.modelCatalog
          ? {
              defaultProfile: this.snapshot.modelCatalog.defaultProfile,
              profiles: new Map(
                this.snapshot.modelCatalog.profiles.map((p) => [p.name, p]),
              ),
            }
          : undefined,
      reasoningEffort: () => this.snapshot.reasoningEffort,
      setReasoningEffort: async (effort) => {
        const result = await tasks.operate({ kind: "reasoning", effort });
        await this.refreshNow();
        if (result.kind !== "reasoning") throw new Error("Invalid reasoning response.");
        return result.value;
      },
      resetReasoningEffort: async () => {
        const result = await tasks.operate({ kind: "reasoning", effort: null });
        await this.refreshNow();
        if (result.kind !== "reasoning") throw new Error("Invalid reasoning response.");
        return result.value;
      },
      supportsImageInput: () => this.snapshot.supportsImageInput,
      projectionStore: this.view,
      readLastResponse: async () =>
        (
          await transport.request<{ text?: string }>(
            `/v1/sessions/${snapshot.activity.session.id}/last-response`,
            undefined,
            this.abort.signal,
          )
        ).text,
      importImage: (sourcePath, signal, count) =>
        images.import(sourcePath, signal, count),
      verifyImageAssets: (assets, signal) => images.verify(assets, signal),
      skills: () => this.snapshot.skills,
      mcp: () => this.snapshot.mcp,
      bashGuard: () => this.snapshot.bashGuard,
      subscribeBashGuard: this.view.subscribe,
      askUser: () => this.snapshot.askUser,
      subscribeAskUser: this.view.subscribe,
      providerRetry: () => this.snapshot.providerRetry,
      subscribeProviderRetry: this.view.subscribe,
      resolveProviderRetry: (requestId, decision) =>
        tasks.respond({ kind: "provider_retry", interactionId: requestId, decision }),
      setYoloMode: async (enabled) => {
        await tasks.operate({ kind: "yolo", enabled });
        await this.refreshNow();
      },
      resolveAskUser: async (response, interactionId) => {
        if (!interactionId) throw new Error("Question identity is required.");
        await tasks.respond({
          kind: "answer",
          interactionId,
          selectedIndex:
            response.outcome === "selected" ? response.selectedIndex : null,
        });
      },
      resolveBashConfirmation: async (decision, interactionId) => {
        if (!interactionId) throw new Error("Confirmation identity is required.");
        await tasks.respond({ kind: "confirm", interactionId, decision });
      },
      admitTurn: (message, signal) => tasks.admitTurn(message, signal),
      executeTurn: async (message, signal) =>
        (await tasks.admitTurn(message, signal)).completion,
      queueFollowUp: (message) => tasks.queueFollowUp(message),
      stopTurn: () => tasks.stopTurn(),
      promptScheduler: () => this.snapshot.promptScheduler,
      subscribePromptScheduler: this.view.subscribe,
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
    const key = JSON.stringify([state.connection, state.cursor]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (state.connection !== "online") return;
    this.dirty = true;
    void this.refresh();
  }
  async refreshNow(): Promise<void> {
    while (this.refreshing && !this.abort.signal.aborted)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const next = await this.transport.request<RemoteTuiSnapshot>(
      `/v1/sessions/${this.binding.sessionId}/tui-snapshot`,
      undefined,
      this.abort.signal,
    );
    validate(next, this.snapshot.activity.session.workspaceId, this.binding.sessionId);
    if (
      next.cursor.epoch === this.snapshot.cursor.epoch &&
      next.cursor.sequence < this.snapshot.cursor.sequence
    )
      return;
    this.snapshot = next;
    this.view.update(next);
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
        if (
          next.cursor.epoch === this.snapshot.cursor.epoch &&
          next.cursor.sequence < this.snapshot.cursor.sequence
        )
          continue;
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
  private history?: RemotePromptHistory;
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
  async initialize(sessionId?: string, profileName?: string): Promise<void> {
    const workspaces = await this.transport.workspaces();
    if (!workspaces.workspaces.some((w) => w.id === this.workspaceId))
      throw new Error("Workspace is not configured on the service.");
    // Check the additive full-TUI endpoint before creating any session.
    await this.listSessions();
    if (sessionId) await this.resume(parseSessionId(sessionId));
    else
      await this.replace(async () =>
        this.operation({
          kind: "create",
          workspaceId: this.workspaceId,
          ...(profileName ? { profileName } : {}),
        }),
      );
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
      async () =>
        this.operation({
          kind: "create",
          workspaceId: this.workspaceId,
          ...(this.current?.binding.profileName
            ? { profileName: this.current.binding.profileName }
            : {}),
        }),
      beforeCommit,
    );
  }
  resume(sessionId: SessionId, beforeCommit?: () => void): Promise<void> {
    return this.replace(async () => {
      if (sessionId === this.current?.binding.sessionId)
        throw new Error(`Session ${sessionId} is already current.`);
      const { session } = await this.transport.request<{
        session: ClientSessionSummary;
      }>(
        `/v1/workspaces/${this.workspaceId}/tui-sessions/${sessionId}`,
        undefined,
        this.abort.signal,
      );
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
  private async maintain(
    input: Omit<SessionOperation, "sessionId"> & Record<string, unknown>,
  ): Promise<SessionOperationResult> {
    if (!this.current) throw new Error("Service session is not connected.");
    const current = this.current;
    const result = await current.tasks.operate(input);
    await current.refreshNow();
    return result;
  }
  async compact() {
    const result = await this.maintain({ kind: "compact" });
    if (result.kind !== "compact") throw new Error("Invalid compaction response.");
    return result.value;
  }
  async retire() {
    const result = await this.maintain({ kind: "retire" });
    if (result.kind !== "retire") throw new Error("Invalid retirement response.");
    return result.value;
  }
  async undo() {
    const result = await this.maintain({ kind: "undo" });
    if (result.kind !== "undo") throw new Error("Invalid undo response.");
    return result.value;
  }
  async fork(beforeCommit?: () => void): Promise<SessionId> {
    let id: string | undefined;
    await this.replace(async () => {
      const result = await this.maintain({ kind: "fork" });
      if (result.kind !== "fork") throw new Error("Invalid clone response.");
      id = result.value;
      return id;
    }, beforeCommit);
    return parseSessionId(id!);
  }
  switchModel(profile: ClientModelProfile, beforeCommit?: () => void): Promise<void> {
    return this.replace(async () => {
      const result = await this.maintain({
        kind: "switch_model",
        profileName: profile.name,
      });
      if (result.kind !== "switch_model")
        throw new Error("Invalid model switch response.");
      return result.value;
    }, beforeCommit);
  }
  persistDefaultProfile = async (profileName: string): Promise<void> => {
    await this.maintain({ kind: "default_profile", profileName });
  };
  readonly listFiles = (
    _root: string,
    signal: AbortSignal,
  ): Promise<readonly string[]> =>
    this.transport.request(
      `/v1/sessions/${this.getBinding().sessionId}/files`,
      undefined,
      AbortSignal.any([signal, this.abort.signal]),
    );
  readonly readFile = (_root: string, filePath: string): Promise<ViewFile> =>
    this.transport.request(
      `/v1/sessions/${this.getBinding().sessionId}/view-file?path=${encodeURIComponent(filePath)}`,
      undefined,
      this.abort.signal,
    );
  readonly readGitBranch = async (): Promise<string | undefined> =>
    (
      await this.transport.request<{ branch?: string }>(
        `/v1/sessions/${this.getBinding().sessionId}/git-branch`,
        undefined,
        this.abort.signal,
      )
    ).branch;
  readonly projectCommands = (): Promise<readonly ProjectSlashCommand[]> =>
    this.transport.request(
      `/v1/sessions/${this.getBinding().sessionId}/project-commands`,
      undefined,
      this.abort.signal,
    );
  async loadHistory(): Promise<RemotePromptHistory> {
    if (this.history) return this.history;
    const records = await this.transport.request<LoadedPromptHistoryRecord[]>(
      `/v1/sessions/${this.getBinding().sessionId}/prompt-history`,
      undefined,
      this.abort.signal,
    );
    this.history = new RemotePromptHistory(records, async (prompt) => {
      await this.transport.request(
        `/v1/sessions/${this.getBinding().sessionId}/prompt-history`,
        { prompt },
        this.abort.signal,
      );
    });
    return this.history;
  }
  readonly listStoredMemories = (): Promise<
    readonly import("../memory/contracts").StoredMemorySummary[]
  > =>
    this.transport.request(
      `/v1/sessions/${this.getBinding().sessionId}/memories`,
      undefined,
      this.abort.signal,
    );
  async delete(sessionId: SessionId): Promise<void> {
    if (sessionId === this.getBinding().sessionId)
      throw new Error("Cannot delete the current session.");
    if (this.pending) throw new Error("Another session operation is already running.");
    const pending = this.current!.tasks.deleteSession(sessionId).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    await pending;
  }
  async close(): Promise<void> {
    this.abort.abort();
    await this.current?.close();
    await this.pending?.catch(() => undefined);
    await this.history?.flush();
    await this.transport.close();
    this.listeners.clear();
  }
}

export async function createRemoteTuiClient(
  config: RemoteClientConfig,
  workspaceId: string,
  sessionId?: string,
  profileName?: string,
): Promise<ClientConnection<TuiSessionView> & { client: RemoteWorkspaceClient }> {
  const client = new RemoteWorkspaceClient(config, workspaceId);
  try {
    await client.initialize(sessionId, profileName);
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
    !snapshot.timeline ||
    !snapshot.promptScheduler ||
    !snapshot.askUser ||
    !snapshot.providerRetry
  )
    throw new Error("Update the service to enable full TUI interactions.");
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
