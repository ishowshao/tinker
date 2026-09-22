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
  constructor(
    readonly store: RemoteServiceStore,
    workspaces: readonly RemoteWorkspaceConfig[],
    private readonly factory: HostedRuntimeFactory,
    readonly homeRoot?: string,
  ) {
    this.workspaceEntries = mergeWorkspaces(workspaces, store.workspaces());
  }

  /** Local Unix-socket entry only; never exposed through the paired-device HTTP API. */
  async registerLocalWorkspace(directory: string): Promise<RemoteWorkspaceConfig> {
    if (!path.isAbsolute(directory) || directory.length > 4096)
      throw new Error("Local workspace requires an absolute directory path.");
    const canonical = await realpath(directory);
    if (!(await stat(canonical)).isDirectory())
      throw new Error("Workspace must be a directory.");
    if (this.stopping) throw new Error("Service is stopping.");
    const existing = findContainingWorkspace(this.workspaces, canonical);
    if (existing) return existing;
    const record = localWorkspaceRecord(canonical);
    // No await between checking identity, the durable insert and publishing the list.
    this.store.registerWorkspace(record);
    this.workspaceEntries.push(record);
    return record;
  }

  async initialize(): Promise<void> {
    // Reacquire every managed canonical lease; no prompt is resubmitted on boot.
    for (const record of this.store.sessions()) {
      if (!record.initialized) continue;
      try {
        await this.session(record.id).open();
      } catch {
        /* A failed workspace/session remains visible with its error. */
      }
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
    const hosted = new HostedSession(record, this.store, this.epoch, this.factory);
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
            status: record.initialized ? "idle" : "interrupted",
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
    // Serializes acceptance, catalog lookup and deletion; never model execution.
    const result = this.submitting.then(() => this.accept(input, device));
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
    if (input.kind === "adopt") return this.adopt(input, device);
    if (input.kind === "create") {
      const workspace = this.workspace(input.workspaceId);
      const id = createUuidV7();
      if (this.store.sessions().length >= 128)
        throw new RemoteError(
          409,
          "SESSION_LIMIT",
          "The service has reached its 128 managed session limit.",
        );
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
    if (this.store.sessions().length >= 128)
      throw new RemoteError(
        409,
        "SESSION_LIMIT",
        "The service has reached its 128 managed session limit.",
      );
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
    const hosted = new HostedSession(record, this.store, this.epoch, this.factory);
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
    if (this.store.sessions().length >= 128)
      throw new Error("Managed session limit reached.");
    if (kind === "switch_model") {
      if (this.session(input.sessionId).hasTurns)
        throw new Error("Cannot switch models after the session has turns.");
      const catalog = await this.factory.profiles?.(source.workspaceId);
      if (!catalog?.profiles.some((p) => p.name === input.profileName))
        throw new Error("Unknown model profile.");
    }
    const id = createUuidV7();
    if (kind === "fork") await runtime.cloneSession(parseSessionId(id));
    if (this.stopping) throw new Error("Service is stopping.");
    this.store.saveSession({
      ...source,
      id,
      initialized: kind === "fork",
      status: "accepted",
      profileName: kind === "switch_model" ? input.profileName : source.profileName,
      updatedAt: new Date().toISOString(),
      title: kind === "fork" ? source.title : "New session",
    });
    await this.session(id).open();
    return { kind, value: id };
  }

  async close(): Promise<void> {
    this.stopping = true;
    await this.submitting;
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
