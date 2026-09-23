import {
  DEFAULT_RESIDENT_POLICY,
  TurnSlots,
  type ResidentPolicy,
} from "./resident-policy";
import {
  isSessionOperation,
  type SessionOperation,
  type SessionOperationResult,
} from "./session-operations";
import type { RuntimeSession } from "../agent/runtime-session";
import type { ClientSessionSummary } from "../client/session-client";
import { randomUUID } from "node:crypto";
import { createUuidV7 } from "../ids/uuid-v7";
import { parseSessionId } from "../ids/runtime-id";
import { SessionCatalog } from "../session/session-catalog";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  findContainingWorkspace,
  localWorkspaceRecord,
  mergeWorkspaces,
} from "./workspace-resolution";
import {
  HostedSession,
  type HostedRuntimeFactory,
} from "../agent/runtime-hosted-session";
import type { RemoteWorkspaceConfig } from "./config";
import { RemoteServiceStore, type ManagedSessionRecord } from "./service-store";
import {
  RemoteError,
  type RemoteOperationInput,
  type OperationReceipt,
  type RemoteSessionInfo,
} from "./protocol";

export class RemoteService {
  private readonly workspaceEntries: RemoteWorkspaceConfig[];
  get workspaces(): readonly RemoteWorkspaceConfig[] {
    return this.workspaceEntries;
  }
  readonly epoch = randomUUID();
  private readonly hosted = new Map<string, HostedSession>();
  private submitting: Promise<void> = Promise.resolve();
  private stopping = false;
  private draining = false;
  private admissions = 0;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly loaded = new Set<string>();
  private loadTail: Promise<void> = Promise.resolve();
  private readonly slots: TurnSlots;
  constructor(
    readonly store: RemoteServiceStore,
    workspaces: readonly RemoteWorkspaceConfig[],
    private readonly factory: HostedRuntimeFactory,
    readonly homeRoot?: string,
    readonly policy: ResidentPolicy = { ...DEFAULT_RESIDENT_POLICY },
  ) {
    this.slots = new TurnSlots(policy.maxConcurrentTurns);
    this.workspaceEntries = mergeWorkspaces(workspaces, store.workspaces());
  }

  /** Local Unix-socket entry only; never exposed through the paired-device HTTP API. */
  async registerLocalWorkspace(directory: string): Promise<RemoteWorkspaceConfig> {
    if (!path.isAbsolute(directory) || directory.length > 4096)
      throw new Error("Local workspace requires an absolute directory path.");
    const canonical = await realpath(directory);
    if (!(await stat(canonical)).isDirectory())
      throw new Error("Workspace must be a directory.");
    if (this.stopping || this.draining)
      throw new Error("Service is stopping or draining.");
    const existing = findContainingWorkspace(this.workspaces, canonical);
    if (existing) return existing;
    const record = localWorkspaceRecord(canonical);
    // No await between checking identity, the durable insert and publishing the list.
    this.store.registerWorkspace(record);
    this.workspaceEntries.push(record);
    return record;
  }

  async initialize(): Promise<void> {
    // Recover canonical state and retain lightweight ownership without constructing runtimes.
    for (const record of this.store.sessions()) {
      if (!record.initialized) continue;
      try {
        await this.session(record.id).prepareDormant(this.homeRoot);
      } catch {
        /* A failed workspace/session remains visible with its error. */
      }
    }
    this.sweepTimer = setInterval(
      () => {
        void this.sweepIdle().catch(() => undefined);
      },
      Math.min(this.policy.idleTimeoutMs, 30000),
    );
    this.sweepTimer.unref();
  }
  async sweepIdle(now = Date.now()): Promise<void> {
    for (const session of this.hosted.values())
      if (session.reclaimable && now - session.lastUsed >= this.policy.idleTimeoutMs)
        await session.suspend();
  }
  private makeSession(record: ManagedSessionRecord): HostedSession {
    return new HostedSession(record, this.store, this.epoch, this.factory, {
      load: () => this.reserveRuntime(record.id),
      unload: () => {
        this.loaded.delete(record.id);
      },
      acquireTurn: (signal) => this.slots.acquire(signal),
    });
  }
  private reserveRuntime(id: string): Promise<void> {
    const reservation = this.loadTail.then(async () => {
      if (this.loaded.has(id)) return;
      if (this.stopping)
        throw new RemoteError(503, "SERVICE_STOPPING", "Service is stopping.");
      if (this.loaded.size >= this.policy.maxLoadedSessions) {
        const candidate = [...this.hosted.values()]
          .filter((session) => session.reclaimable)
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (candidate) await candidate.suspend();
      }
      if (this.loaded.size >= this.policy.maxLoadedSessions)
        throw new RemoteError(
          429,
          "RUNTIME_LIMIT",
          "All runtime slots are active or connected. Disconnect an idle client or wait for running work.",
        );
      this.loaded.add(id);
    });
    this.loadTail = reservation.catch(() => undefined);
    return reservation;
  }
  private get busy(): boolean {
    return (
      this.admissions > 0 || [...this.hosted.values()].some((session) => session.busy)
    );
  }
  residentStatus() {
    return {
      phase: this.stopping ? "stopping" : this.draining ? "draining" : "ready",
      busy: this.busy,
      loadedSessions: this.loaded.size,
      managedSessions: this.store.sessions().length,
      runningTurns: this.slots.running,
      waitingTurns: this.slots.queued,
      pendingTurns: [...this.hosted.values()].reduce(
        (sum, session) => sum + session.pendingCount,
        0,
      ),
      policy: this.policy,
    };
  }
  async drain(force = false, idleOnly = false): Promise<void> {
    if (this.draining || this.stopping)
      throw new RemoteError(
        409,
        "SERVICE_DRAINING",
        "Service shutdown is already in progress.",
      );
    // Check and close admission without yielding: a status probe alone can race a new turn.
    if (idleOnly && this.busy)
      throw new RemoteError(
        409,
        "SERVICE_BUSY",
        "Service is busy; update postponed. Wait for work to finish, then retry tinker update.",
      );
    this.draining = true;
    const deadline = Date.now() + this.policy.shutdownGraceMs;
    while (
      this.admissions > 0 ||
      [...this.hosted.values()].some((session) => session.busy)
    ) {
      if (Date.now() >= deadline) {
        if (force) return;
        this.draining = false;
        throw new RemoteError(
          409,
          "SERVICE_BUSY",
          "Work is still active; shutdown was cancelled. Retry after completion or use --force to interrupt.",
        );
      }
      await Bun.sleep(25);
    }
  }
  workspace(id: string): RemoteWorkspaceConfig {
    const workspace = this.workspaces.find((workspace) => workspace.id === id);
    if (!workspace)
      throw new RemoteError(
        404,
        "WORKSPACE_NOT_FOUND",
        "This workspace is not configured on the Mac.",
      );
    return workspace;
  }
  session(id: string): HostedSession {
    const existing = this.hosted.get(id);
    if (existing) return existing;
    const record = this.store.session(id);
    if (!record)
      throw new RemoteError(
        404,
        "SESSION_NOT_MANAGED",
        "Attach this local session before connecting to it.",
      );
    const workspace = this.workspace(record.workspaceId);
    if (record.workspacePath !== workspace.path)
      throw new RemoteError(
        409,
        "WORKSPACE_CHANGED",
        "The managed session belongs to a different workspace path.",
      );
    const hosted = this.makeSession(record);
    this.hosted.set(id, hosted);
    return hosted;
  }
  async listSessions(workspaceId: string): Promise<RemoteSessionInfo[]> {
    const workspace = this.workspace(workspaceId);
    const local = await new SessionCatalog({
      workspaceRoot: workspace.path,
      homeRoot: this.homeRoot,
    }).listAll();
    const managed = this.store
      .sessions()
      .filter((record) => record.workspaceId === workspaceId);
    return [
      ...managed.map((record) => {
        const view = this.hosted.get(record.id)?.view();
        return (
          view?.session ?? {
            id: record.id,
            workspaceId,
            title: record.title,
            modelName: record.modelName,
            owner: "service" as const,
            status: record.initialized ? record.status : "interrupted",
            updatedAt: record.updatedAt,
          }
        );
      }),
      ...local
        .filter((summary) => !managed.some((record) => record.id === summary.sessionId))
        .map((summary) => ({
          id: summary.sessionId,
          workspaceId,
          title: summary.firstUserPromptPreview ?? "Empty session",
          modelName: summary.modelName,
          owner: "local" as const,
          status: summary.status,
          updatedAt: summary.updatedAt,
        })),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listTuiSessions(workspaceId: string): Promise<ClientSessionSummary[]> {
    const workspace = this.workspace(workspaceId);
    const catalog = new SessionCatalog({
      workspaceRoot: workspace.path,
      homeRoot: this.homeRoot,
    });
    const summaries = [...(await catalog.listAll())];
    // The local picker omits empty sessions; service-owned empty sessions remain connectable.
    for (const record of this.store.sessions()) {
      if (
        record.workspaceId === workspaceId &&
        record.initialized &&
        !summaries.some((s) => s.sessionId === record.id)
      ) {
        summaries.push(await catalog.get(parseSessionId(record.id)));
      }
    }
    return summaries.map((summary) => {
      const managed = this.store.session(summary.sessionId);
      return {
        ...summary,
        ...(managed?.workspaceId === workspaceId ? { canConnect: true } : {}),
      };
    });
  }

  async getTuiSession(workspaceId: string, id: string): Promise<ClientSessionSummary> {
    const workspace = this.workspace(workspaceId);
    const summary = await new SessionCatalog({
      workspaceRoot: workspace.path,
      homeRoot: this.homeRoot,
    })
      .get(parseSessionId(id))
      .catch(() => {
        throw new RemoteError(
          404,
          "SESSION_NOT_FOUND",
          "Session does not belong to this workspace.",
        );
      });
    const managed = this.store.session(id);
    return {
      ...summary,
      ...(managed?.workspaceId === workspaceId &&
      managed.workspacePath === workspace.path
        ? { canConnect: true }
        : {}),
    };
  }

  submit(input: RemoteOperationInput, device: string): Promise<OperationReceipt> {
    const controls = ["answer", "confirm", "provider_retry", "stop"].includes(
      input.kind,
    );
    const admissionLimit =
      this.policy.maxPendingTurns +
      this.policy.maxLoadedSessions +
      (controls ? 32 : 16);
    if (this.admissions >= admissionLimit)
      return Promise.reject(
        new RemoteError(
          429,
          "ADMISSION_LIMIT",
          "Too many concurrent service operations; retry after current admissions finish.",
        ),
      );
    this.admissions++;
    // Serializes acceptance, catalog lookup and deletion; never model execution.
    const result = this.submitting
      .then(() => this.accept(input, device))
      .finally(() => {
        this.admissions--;
      });
    this.submitting = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async accept(
    input: RemoteOperationInput,
    device: string,
  ): Promise<OperationReceipt> {
    const existing = this.store.existing(input, device);
    if (existing) return existing;
    if (this.stopping)
      throw new RemoteError(503, "SERVICE_STOPPING", "The local service is stopping.");
    if (
      this.draining &&
      !["answer", "confirm", "provider_retry", "stop"].includes(input.kind)
    )
      throw new RemoteError(
        503,
        "SERVICE_DRAINING",
        "Service is draining; wait before submitting new work.",
      );
    if (
      input.kind === "prompt" &&
      this.residentStatus().pendingTurns >= this.policy.maxPendingTurns
    )
      throw new RemoteError(
        429,
        "SERVICE_QUEUE_FULL",
        "The service pending-turn limit has been reached.",
      );
    if (input.kind === "adopt") return this.adopt(input, device);
    if (input.kind === "create") {
      const workspace = this.workspace(input.workspaceId);
      const id = createUuidV7();
      await this.reserveRuntime(id);
      const record: ManagedSessionRecord = {
        id,
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        title: input.title ?? "New session",
        modelName: "",
        owner: "service",
        status: "accepted",
        updatedAt: new Date().toISOString(),
        initialized: false,
        profileName: input.profileName,
      };
      const receipt = this.store.accept(input, device, id, record);
      const hosted = this.session(id);
      void hosted.open().then(
        () => {
          this.store.update({ ...receipt, status: "completed" });
          hosted.receiptChanged();
        },
        (error: unknown) => {
          this.store.update({
            ...receipt,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
      return receipt;
    }
    if (input.kind === "delete_session") return this.deleteSession(input, device);
    const session = this.session(input.sessionId);
    // Attach/initialization must be complete before a new mutation can be accepted.
    await session.open();
    session.validate(input);
    const receipt = this.store.accept(input, device, input.sessionId);
    if (isSessionOperation(input))
      session.runMaintenance(receipt, (runtime) => this.maintain(input, runtime));
    else if (input.kind === "prompt") session.enqueue(receipt);
    else session.control(input, receipt);
    return receipt;
  }

  private async adopt(
    input: Extract<RemoteOperationInput, { kind: "adopt" }>,
    device: string,
  ): Promise<OperationReceipt> {
    const workspace = this.workspace(input.workspaceId);
    const id = input.sessionId;
    const managed = this.store.session(id);
    if (managed) {
      if (
        managed.workspaceId !== workspace.id ||
        managed.workspacePath !== workspace.path
      )
        throw new RemoteError(
          409,
          "WORKSPACE_MISMATCH",
          "Session belongs to another workspace.",
        );
      await this.session(id).open();
      const receipt = this.store.accept(input, device, id);
      const completed = this.store.update({ ...receipt, status: "completed" });
      this.session(id).receiptChanged();
      return completed;
    }

    const summary = await new SessionCatalog({
      workspaceRoot: workspace.path,
      homeRoot: this.homeRoot,
    })
      .get(parseSessionId(id))
      .catch(() => {
        throw new RemoteError(
          404,
          "SESSION_NOT_FOUND",
          "Session is not in this workspace.",
        );
      });
    if (summary.status !== "resumable" && summary.status !== "interrupted")
      throw new RemoteError(
        409,
        "SESSION_UNAVAILABLE",
        "Exit its local TUI before attaching this session; it must be resumable.",
      );
    const record: ManagedSessionRecord = {
      id,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      title: summary.firstUserPromptPreview ?? "Empty session",
      modelName: summary.modelName,
      profileName: summary.profileName,
      owner: "service",
      status: "accepted",
      updatedAt: new Date().toISOString(),
      initialized: true,
    };
    // A receipt records intent, not ownership. HostedSession publishes the managed
    // record only after the runtime has acquired the canonical session lease.
    const receipt = this.store.accept(input, device, id);
    const hosted = this.makeSession(record);
    this.hosted.set(id, hosted);
    try {
      await hosted.open();
      const completed = this.store.update({ ...receipt, status: "completed" });
      hosted.receiptChanged();
      return completed;
    } catch (error) {
      await hosted.close().catch(() => undefined);
      this.hosted.delete(id);
      this.store.releaseSession(id);
      const failed = {
        ...receipt,
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      };
      return this.store.update(failed);
    }
  }

  private async deleteSession(
    input: Extract<RemoteOperationInput, { kind: "delete_session" }>,
    device: string,
  ): Promise<OperationReceipt> {
    const source = this.store.session(input.sessionId);
    if (!source)
      throw new RemoteError(
        404,
        "SESSION_NOT_MANAGED",
        "Current session is not managed by this service.",
      );
    if (input.targetSessionId === input.sessionId)
      throw new RemoteError(
        409,
        "SESSION_CURRENT",
        "Cannot delete the current session.",
      );
    const workspace = this.workspace(source.workspaceId);
    const record = this.store.session(input.targetSessionId);
    if (record && record.workspaceId !== workspace.id)
      throw new RemoteError(
        403,
        "WORKSPACE_MISMATCH",
        "Session belongs to another workspace.",
      );
    const catalog = new SessionCatalog({
      workspaceRoot: workspace.path,
      homeRoot: this.homeRoot,
    });
    // Resolve through the workspace catalog even for unmanaged local sessions.
    try {
      await catalog.get(parseSessionId(input.targetSessionId));
    } catch (error) {
      throw new RemoteError(
        404,
        "SESSION_NOT_FOUND",
        error instanceof Error ? error.message : "Session is not in this workspace.",
      );
    }
    const target = record ? this.session(record.id) : undefined;
    if (target) {
      try {
        await target.open();
      } catch (error) {
        throw new RemoteError(
          409,
          "SESSION_UNAVAILABLE",
          error instanceof Error ? error.message : "Session is unavailable.",
        );
      }
      target.beginDelete();
    }
    let receipt = this.store.accept(input, device, input.targetSessionId);
    receipt = this.store.update({ ...receipt, status: "running" });
    try {
      if (target) {
        await target.close();
        this.hosted.delete(input.targetSessionId);
        // Release ownership before removing canonical files. A crash can leave a local
        // session, but never a managed record that reopens an already deleted database.
        this.store.releaseSession(input.targetSessionId);
      }
      await catalog.delete(
        parseSessionId(input.targetSessionId),
        parseSessionId(input.sessionId),
      );
      return this.store.update({ ...receipt, status: "completed" });
    } catch (error) {
      if (record && !this.store.session(record.id)) {
        try {
          await catalog.get(parseSessionId(record.id));
          this.store.saveSession(record);
          await this.session(record.id).open();
        } catch {
          /* A removed catalog entry must never be resurrected. */
        }
      }
      return this.store.update({
        ...receipt,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async maintain(
    input: SessionOperation,
    runtime: RuntimeSession,
  ): Promise<SessionOperationResult> {
    const kind = input.kind;
    if (kind === "compact") return { kind, value: await runtime.compactContext() };
    if (kind === "retire") return { kind, value: await runtime.retireContext() };
    if (kind === "undo")
      return { kind, value: await runtime.undoLatestFileMutationTurn() };
    if (kind === "reasoning")
      return {
        kind,
        value:
          input.effort === null
            ? runtime.resetReasoningEffort()
            : runtime.setReasoningEffort(input.effort),
      };
    if (kind === "yolo") {
      runtime.setYoloMode(input.enabled);
      return { kind, value: null };
    }
    const source = this.store.session(input.sessionId)!;
    if (kind === "default_profile") {
      if (!this.factory.persistDefaultProfile)
        throw new Error("Model profiles are not configured.");
      await this.factory.persistDefaultProfile(source.workspaceId, input.profileName);
      const catalog = await this.factory.profiles?.(source.workspaceId);
      for (const record of this.store.sessions()) {
        if (record.workspaceId === source.workspaceId)
          this.hosted.get(record.id)?.updateModelCatalog(catalog);
      }
      return { kind, value: null };
    }
    if (this.stopping) throw new Error("Service is stopping.");

    if (kind === "switch_model") {
      if (this.session(input.sessionId).hasTurns)
        throw new Error("Cannot switch models after the session has turns.");
      const catalog = await this.factory.profiles?.(source.workspaceId);
      if (!catalog?.profiles.some((p) => p.name === input.profileName))
        throw new Error("Unknown model profile.");
    }
    const id = createUuidV7();
    await this.reserveRuntime(id);
    try {
      if (kind === "fork") await runtime.cloneSession(parseSessionId(id));
      if (this.stopping) throw new Error("Service is stopping.");
      this.store.saveSession({
        ...source,
        id,
        initialized: kind === "fork",
        status: "accepted",
        profileName: kind === "switch_model" ? input.profileName : source.profileName,
        residentState: kind === "switch_model" ? undefined : source.residentState,
        updatedAt: new Date().toISOString(),
        title: kind === "fork" ? source.title : "New session",
      });
      await this.session(id).open();
      return { kind, value: id };
    } catch (error) {
      this.loaded.delete(id);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.submitting;
    await this.loadTail;
    const results = await Promise.allSettled(
      [...this.hosted.values()].map((session) => session.close()),
    );
    await this.store.close();
    const errors = results.filter((result) => result.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason as unknown),
        "Remote service shutdown failed.",
      );
  }
}
