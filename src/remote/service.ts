import { randomUUID } from "node:crypto";
import { createUuidV7 } from "../ids/uuid-v7";
import { parseSessionId } from "../ids/runtime-id";
import { SessionCatalog } from "../session/session-catalog";
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
  readonly epoch = randomUUID();
  private readonly hosted = new Map<string, HostedSession>();
  private submitting: Promise<void> = Promise.resolve();
  private stopping = false;
  constructor(
    readonly store: RemoteServiceStore,
    readonly workspaces: readonly RemoteWorkspaceConfig[],
    private readonly factory: HostedRuntimeFactory,
    private readonly homeRoot?: string,
  ) {}

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

  submit(input: RemoteOperationInput, device: string): Promise<OperationReceipt> {
    // Serializes acceptance and any async catalog lookup, never task execution.
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
    if (input.kind === "create" || input.kind === "adopt") {
      const workspace = this.workspace(input.workspaceId);
      const id = input.kind === "create" ? createUuidV7() : input.sessionId;
      if (this.store.sessions().length >= 128)
        throw new RemoteError(
          409,
          "SESSION_LIMIT",
          "The service has reached its 128 managed session limit.",
        );
      let record: ManagedSessionRecord;
      if (input.kind === "adopt") {
        if (this.store.session(id))
          throw new RemoteError(
            409,
            "ALREADY_MANAGED",
            "This session is already owned by the service.",
          );
        const summary = await new SessionCatalog({
          workspaceRoot: workspace.path,
          homeRoot: this.homeRoot,
        }).get(parseSessionId(id));
        if (summary.status !== "resumable" && summary.status !== "interrupted")
          throw new RemoteError(
            409,
            "SESSION_UNAVAILABLE",
            "Exit its local TUI before attaching this session; it must be resumable.",
          );
        record = {
          id,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          title: summary.firstUserPromptPreview ?? "Empty session",
          modelName: summary.modelName,
          owner: "service",
          status: "accepted",
          updatedAt: new Date().toISOString(),
          initialized: true,
        };
      } else {
        record = {
          id,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          title: input.title ?? "New session",
          modelName: "",
          owner: "service",
          status: "accepted",
          updatedAt: new Date().toISOString(),
          initialized: false,
        };
      }
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
    const session = this.session(input.sessionId);
    // Attach/initialization must be complete before a new mutation can be accepted.
    await session.open();
    session.validate(input);
    const receipt = this.store.accept(input, device, input.sessionId);
    if (input.kind === "prompt") session.enqueue(receipt);
    else session.control(input, receipt);
    return receipt;
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
