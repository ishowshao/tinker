import { encodeFailure } from "../remote/failures";
import type { ClientModelCatalog } from "../client/model-catalog";
import {
  isSessionOperation,
  type SessionOperationResult,
} from "../remote/session-operations";
import { TuiProjectionStore } from "../tui/tui-projection-store";
import { ResumeProjectionReader } from "../session/resume-projection";
import type { RemoteTuiSnapshot } from "../remote/tui-protocol";
import { randomUUID } from "node:crypto";
import type { RuntimeSession } from "./runtime-session";
import type {
  AssistantTextDeltaSink,
  AssistantTextDeltaUpdate,
} from "./assistant-text-delta";
import type { AgentEvent } from "../events/types";
import type { EventSink } from "../events/event-sink";
import {
  RemoteHistoryReader,
  type RemoteHistoryPage,
} from "../session/remote-history-reader";
import { parseSessionId } from "../ids/runtime-id";
import {
  RemoteError,
  type RemoteActivity,
  type RemoteOperationInput,
  type OperationReceipt,
  type RemoteView,
} from "../remote/protocol";
import { type ManagedSessionRecord, RemoteServiceStore } from "../remote/service-store";
import { RemoteSyncHub } from "../remote/sync-hub";

export type HostedRuntimeFactory = ((input: {
  record: ManagedSessionRecord;
  sink: EventSink & AssistantTextDeltaSink;
}) => Promise<{
  runtime: RuntimeSession;
  databasePath: string;
  modelName: string;
  profileName?: string;
  modelCatalog?: ClientModelCatalog;
}>) & {
  profiles?: (workspaceId: string) => Promise<ClientModelCatalog | undefined>;
  persistDefaultProfile?: (workspaceId: string, profileName: string) => Promise<void>;
};

export class HostedSession implements EventSink, AssistantTextDeltaSink {
  readonly name = "remote-view";
  readonly hub: RemoteSyncHub;
  private runtime?: RuntimeSession;
  private maintenance?: Promise<unknown>;
  private modelCatalog?: ClientModelCatalog;
  private interactionSource?: object;
  private reader?: RemoteHistoryReader;
  private projection?: TuiProjectionStore;
  private opening?: Promise<void>;
  private readonly queue: OperationReceipt[] = [];
  private active?: {
    receipt: OperationReceipt;
    controller: AbortController;
    completion?: Promise<void>;
  };
  private activity: Omit<RemoteActivity, "session" | "operations"> = {
    status: "idle",
    tools: [],
  };
  private lastOrdinal = 0;
  private streamTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private connections = 0;
  private unsubscribers: (() => void)[] = [];
  private controlTail: Promise<void> = Promise.resolve();

  constructor(
    private record: ManagedSessionRecord,
    private readonly store: RemoteServiceStore,
    epoch: string,
    private readonly factory: HostedRuntimeFactory,
  ) {
    this.hub = new RemoteSyncHub(epoch, () => this.view());
  }

  assertAvailable(): void {
    if (this.stopping)
      throw new RemoteError(409, "SESSION_CLOSING", "Session is closing.");
  }
  get connectedClients(): number {
    return this.connections;
  }
  attach(): () => void {
    this.assertAvailable();
    this.connections += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.connections -= 1;
      }
    };
  }
  beginDelete(): void {
    this.assertIdle();
    if (this.connections > 0)
      throw new RemoteError(
        409,
        "SESSION_CONNECTED",
        "Cannot delete a session while a client is connected. Disconnect it first.",
      );
    this.stopping = true;
  }
  open(): Promise<void> {
    this.assertAvailable();
    return (this.opening ??= this.initialize());
  }
  private async initialize(): Promise<void> {
    try {
      const opened = await this.factory({ record: this.record, sink: this });
      this.runtime = opened.runtime;
      this.modelCatalog = opened.modelCatalog;
      this.projection = new TuiProjectionStore({
        sessionId: this.record.id,
        workspaceRoot: this.record.workspacePath,
        modelName: opened.modelName,
        committedItemLimit: 512,
        initialSnapshot: ResumeProjectionReader.readDatabase({
          databasePath: opened.databasePath,
          workspaceRoot: this.record.workspacePath,
          sessionId: parseSessionId(this.record.id),
          modelName: opened.modelName,
          closedTurnsOnly: true,
        }),
      });
      this.reader = new RemoteHistoryReader(
        opened.databasePath,
        parseSessionId(this.record.id),
        this.record.workspacePath,
      );
      this.record = {
        ...this.record,
        initialized: true,
        modelName: opened.modelName,
        profileName: opened.profileName,
        status: "idle",
      };
      this.store.saveSession(this.record);
      const latest = this.reader.latestTurn();
      if (latest && latest.status !== "open") {
        this.activity.status = latest.status as RemoteActivity["status"];
        this.activity.error = latest.error;
      }
      // Canonical terminal status wins over a crash between turn commit and receipt update.
      for (const receipt of this.store.operations(this.record.id)) {
        const status = receipt.turnId
          ? this.reader.turnStatus(receipt.turnId)
          : undefined;
        // A terminal turn cannot prove that an extended execution chain finished.
        // Without its final result, a crash may have lost unconsumed follow-ups.
        if (receipt.hasFollowUps && !receipt.result && receipt.status === "interrupted")
          continue;
        if (receipt.kind === "prompt" && status && status !== "open") {
          this.store.update({
            ...receipt,
            status: status as OperationReceipt["status"],
            error: status === "interrupted" ? receipt.error : undefined,
          });
        }
      }
      const last = this.store
        .operations(this.record.id)
        .filter((op) => op.kind === "prompt")
        .at(-1);
      if (last?.status === "interrupted") {
        this.activity.status = "interrupted";
        this.activity.error = last.error;
      }
      this.unsubscribers = [
        this.runtime.subscribePromptScheduler(() => this.publish()),
        this.runtime.subscribeProviderRetry(() => this.updateInteraction()),
        this.runtime.subscribeAskUser(() => this.updateInteraction()),
        this.runtime.subscribeBashGuard(() => this.updateInteraction()),
      ];
      this.publish();
    } catch (error) {
      this.activity.status = "failed";
      this.activity.error = errorMessage(error);
      if (this.runtime)
        await this.runtime
          .dispose({ type: "runner_failed", error: errorMessage(error) })
          .catch(() => undefined);
      this.publish();
      throw error;
    }
  }

  view(): RemoteView {
    return { ...this.readActivity(), history: this.history() };
  }
  tuiSnapshot(): RemoteTuiSnapshot {
    if (!this.projection || !this.runtime) throw new Error("Session is not ready.");
    const frame = this.hub.snapshot();
    return {
      version: 1,
      cursor: { epoch: frame.epoch, sequence: frame.sequence },
      activity: this.readActivity(),
      history: this.projection.getSnapshot(),
      timeline: this.projection.getLogSnapshot(),
      promptScheduler: this.runtime.promptScheduler(),
      profileName: this.record.profileName,
      modelCatalog: this.modelCatalog,
      reasoningEffort: this.runtime.reasoningEffort(),
      supportsImageInput: this.runtime.supportsImageInput(),
      bashGuard: {
        ...this.runtime.bashGuard(),
        ...(this.runtime.bashGuard().pending
          ? { interactionId: this.activity.interaction?.id }
          : {}),
      },
      askUser: {
        ...this.runtime.askUser(),
        ...(this.runtime.askUser().pending
          ? { interactionId: this.activity.interaction?.id }
          : {}),
      },
      providerRetry:
        this.runtime.providerRetry().pending && this.activity.interaction
          ? {
              pending: {
                ...this.runtime.providerRetry().pending!,
                requestId: this.activity.interaction.id,
              },
            }
          : {},
      skills: this.runtime.skills(),
      mcp: this.runtime.mcp(),
    };
  }
  history(before?: number, limit?: number): RemoteHistoryPage {
    return this.reader?.page(before, limit) ?? { messages: [], hasMore: false };
  }
  private readActivity(): RemoteActivity {
    const { id, workspaceId, title, modelName, owner, updatedAt } = this.record;
    const session = { id, workspaceId, title, modelName, owner, updatedAt };
    return structuredClone({
      ...this.activity,
      session: { ...session, status: this.activity.status },
      // Final results are fetched by operation ID, not repeated in every live frame.
      operations: this.store.operations(this.record.id, false),
    });
  }

  updateModelCatalog(catalog: ClientModelCatalog | undefined): void {
    this.modelCatalog = catalog;
    this.publish();
  }

  assertIdle(): void {
    if (
      this.stopping ||
      this.maintenance ||
      this.active ||
      this.queue.length ||
      !this.runtime?.canSwitchSession()
    )
      throw new RemoteError(
        409,
        "SESSION_BUSY",
        "A turn, context operation or background task is active.",
      );
  }
  get id() {
    return parseSessionId(this.record.id);
  }
  get hasTurns(): boolean {
    return this.reader?.latestTurn() !== undefined;
  }
  exclusive<T>(operation: (runtime: RuntimeSession) => Promise<T>): Promise<T> {
    this.assertIdle();
    const pending = Promise.resolve()
      .then(() => operation(this.runtime!))
      .finally(() => {
        if (this.maintenance === pending) this.maintenance = undefined;
        this.publish();
      });
    this.maintenance = pending;
    return pending;
  }
  runMaintenance(
    receipt: OperationReceipt,
    operation: (runtime: RuntimeSession) => Promise<SessionOperationResult>,
  ): void {
    const running = this.updateReceipt(receipt, { status: "running" });
    void this.exclusive(operation).then(
      (sessionResult) => {
        this.updateReceipt(running, { status: "completed", sessionResult });
        this.publish();
      },
      (error: unknown) => {
        this.updateReceipt(running, {
          status: "failed",
          error: errorMessage(error),
          failure: encodeFailure(error),
        });
        this.publish();
      },
    );
  }

  validate(input: RemoteOperationInput): void {
    if (isSessionOperation(input)) this.assertIdle();
    if (input.kind === "prompt" && this.maintenance)
      throw new RemoteError(
        409,
        "SESSION_BUSY",
        "A session maintenance operation is active.",
      );
    if (this.stopping)
      throw new RemoteError(503, "SERVICE_STOPPING", "The local service is stopping.");
    if (input.kind === "prompt" && this.queue.length >= 8)
      throw new RemoteError(
        409,
        "QUEUE_FULL",
        "This session already has eight queued requests.",
      );
    if (
      input.kind === "answer" ||
      input.kind === "confirm" ||
      input.kind === "provider_retry"
    ) {
      const pending = this.activity.interaction;
      if (
        !pending ||
        pending.id !== input.interactionId ||
        pending.kind !== (input.kind === "confirm" ? "confirmation" : "question") ||
        (input.kind === "provider_retry" && !this.runtime?.providerRetry().pending)
      )
        throw new RemoteError(
          409,
          "STALE_INTERACTION",
          "This question or confirmation is no longer pending.",
        );
      if (
        input.kind === "answer" &&
        input.selectedIndex !== null &&
        pending.kind === "question" &&
        !pending.options[input.selectedIndex]
      )
        throw new RemoteError(400, "INVALID_ANSWER", "Answer index is out of range.");
    }
    if (
      input.kind === "follow_up" &&
      (this.active?.receipt.requestId !== input.targetRequestId ||
        this.runtime?.promptScheduler().state !== "running")
    )
      throw new RemoteError(
        409,
        "STALE_TURN",
        "The targeted execution is no longer running.",
      );
    if (input.kind === "stop") {
      const target = this.store.get(input.targetRequestId);
      if (target.sessionId !== this.record.id || target.kind !== "prompt")
        throw new RemoteError(
          409,
          "INVALID_STOP_TARGET",
          "Stop must target a prompt in this session.",
        );
    }
  }

  enqueue(receipt: OperationReceipt): void {
    this.queue.push(receipt);
    if (!this.active) this.activity.status = "accepted";
    if (this.record.title === "New session" && receipt.prompt) {
      this.record = {
        ...this.record,
        title: receipt.prompt.replace(/\s+/g, " ").slice(0, 100),
      };
      this.store.saveSession(this.record);
    }
    this.publish();
    this.pump();
  }
  private pump(): void {
    if (this.active || this.stopping) return;
    const receipt = this.queue.shift();
    if (!receipt) return;
    const active = {
      receipt,
      controller: new AbortController(),
      completion: undefined as Promise<void> | undefined,
    };
    this.active = active;
    active.completion = this.execute(active);
  }
  private async execute(active: NonNullable<HostedSession["active"]>): Promise<void> {
    try {
      await this.open();
      if (active.controller.signal.aborted) {
        this.updateReceipt(active.receipt, { status: "cancelled" });
        return;
      }
      this.activity = {
        status: "running",
        activeRequestId: active.receipt.requestId,
        tools: [],
      };
      this.updateReceipt(active.receipt, { status: "running" });
      this.publish();
      const accepted = await this.runtime!.admitTurn({
        userMessage: {
          role: "user",
          content: active.receipt.prompt!,
          ...(active.receipt.attachments
            ? { attachments: active.receipt.attachments }
            : {}),
        },
        signal: active.controller.signal,
      });
      active.receipt = this.updateReceipt(active.receipt, {
        status: "running",
        turnId: accepted.turnId,
      });
      this.activity.activeTurnId = accepted.turnId;
      this.publish();
      const result = await accepted.completion;
      this.updateReceipt(active.receipt, {
        status: result.status,
        result,
        ...(result.status === "failed" ? { error: result.error } : {}),
      });
      this.activity.status = result.status;
      if (result.status === "failed") this.activity.error = result.error;
    } catch (error) {
      const status = active.controller.signal.aborted ? "cancelled" : "failed";
      this.updateReceipt(active.receipt, {
        status,
        error: errorMessage(error),
        failure: encodeFailure(error),
      });
      this.activity.status = status;
      this.activity.error = errorMessage(error);
    } finally {
      this.activity.streaming = undefined;
      this.activity.interaction = undefined;
      this.activity.activeRequestId = undefined;
      this.activity.activeTurnId = undefined;
      for (const tool of this.activity.tools) {
        if (tool.status === "running")
          tool.status = this.activity.status === "cancelled" ? "cancelled" : "failed";
      }
      this.active = undefined;
      this.publish(true);
      this.pump();
    }
  }

  control(input: RemoteOperationInput, receipt: OperationReceipt): void {
    // Separate from prompt execution: answering a wait cannot wait for that turn.
    this.controlTail = this.controlTail.then(async () => {
      try {
        await this.open();
        this.validate(input);
        if (input.kind === "stop") {
          if (this.active?.receipt.requestId === input.targetRequestId)
            this.active.controller.abort();
          const index = this.queue.findIndex(
            (op) => op.requestId === input.targetRequestId,
          );
          if (index !== -1)
            this.updateReceipt(this.queue.splice(index, 1)[0], {
              status: "cancelled",
            });
        } else if (input.kind === "follow_up") {
          const followUp = this.runtime!.queueFollowUp({
            role: "user",
            content: input.prompt,
          });
          this.updateReceipt(this.active!.receipt, { hasFollowUps: true });
          this.updateReceipt(receipt, { status: "completed", followUp });
          this.publish();
          return;
        } else if (
          input.kind === "provider_retry" ||
          (input.kind === "answer" && this.runtime!.providerRetry().pending)
        ) {
          const retry = this.runtime!.providerRetry().pending!;
          await this.runtime!.resolveProviderRetry(
            retry.requestId,
            input.kind === "provider_retry"
              ? input.decision
              : input.selectedIndex === 0
                ? "retry"
                : "stop",
          );
        } else if (input.kind === "answer") {
          await this.runtime!.resolveAskUser(
            input.selectedIndex === null
              ? { outcome: "dismissed" }
              : { outcome: "selected", selectedIndex: input.selectedIndex },
          );
        } else if (input.kind === "confirm") {
          await this.runtime!.resolveBashConfirmation(input.decision);
        }
        this.updateReceipt(receipt, { status: "completed" });
      } catch (error) {
        this.updateReceipt(receipt, {
          status: "failed",
          error: errorMessage(error),
        });
      }
      this.publish();
    });
  }

  private updateReceipt(
    receipt: OperationReceipt,
    patch: Partial<OperationReceipt>,
  ): OperationReceipt {
    const next = this.store.update({
      ...this.store.get(receipt.requestId),
      ...patch,
    });
    this.record = { ...this.record, updatedAt: next.updatedAt };
    this.store.saveSession(this.record);
    if (this.active?.receipt.requestId === receipt.requestId)
      this.active.receipt = next;
    return next;
  }

  private updateInteraction(): void {
    const question = this.runtime?.askUser().pending;
    const confirmation = this.runtime?.bashGuard().pending;
    const retry = this.runtime?.providerRetry().pending;
    const source = question ?? confirmation ?? retry;
    if (source) {
      if (source !== this.interactionSource) {
        this.interactionSource = source;
        this.activity.interaction = question
          ? { id: randomUUID(), kind: "question", ...question }
          : confirmation
            ? { id: randomUUID(), kind: "confirmation", ...confirmation }
            : {
                id: randomUUID(),
                kind: "question",
                question: `Provider request failed. Automatic retries exhausted. ${retry!.failure.error.slice(0, 500)}`,
                options: [
                  { description: "Retry again" },
                  { description: "End this turn" },
                ],
              };
      }
      this.activity.status = "waiting_input";
    } else {
      this.interactionSource = undefined;
      this.activity.interaction = undefined;
      if (this.active) this.activity.status = "running";
    }
    if (this.active)
      this.updateReceipt(this.active.receipt, {
        status: this.activity.status as OperationReceipt["status"],
      });
    this.publish();
  }

  async append(event: AgentEvent): Promise<void> {
    if (!this.reader) return;
    await this.projection?.append(event);
    switch (event.type) {
      case "turn.started":
        this.activity.activeTurnId = event.turnId;
        if (this.active)
          this.updateReceipt(this.active.receipt, { turnId: event.turnId });
        break;
      case "model.request.started":
        this.activity.streaming = undefined;
        break;
      case "model.request.finished":
        this.activity.streaming = undefined;
        break;
      case "tool.started":
        this.activity.tools.push({
          id: event.data.call.toolCallId,
          name: event.data.call.name,
          arguments: JSON.stringify(event.data.call.args),
          status: "running",
        });
        this.activity.tools = this.activity.tools.slice(-100);
        break;
      case "tool.finished": {
        const tool = this.activity.tools.find((tool) => tool.id === event.toolCallId);
        if (tool) tool.status = event.data.ok ? "completed" : "failed";
        break;
      }
      case "tool.observation": {
        const tool = this.activity.tools.find((tool) => tool.id === event.toolCallId);
        if (tool) tool.detail = event.data.observation.displayText;
        break;
      }
      case "turn.finished":
      case "turn.failed":
      case "turn.cancelled":
      case "agent.iteration.finished":
      case "turn.steering.applied":
        break;
      default:
        break;
    }
    this.publish();
  }
  updateAssistantTextDelta(update: AssistantTextDeltaUpdate): void {
    this.projection?.updateAssistantTextDelta(update);
    const previous = this.activity.streaming;
    this.activity.streaming = {
      iterationId: update.iterationId,
      attempt: update.attemptNumber,
      text:
        previous?.iterationId === update.iterationId &&
        previous.attempt === update.attemptNumber
          ? previous.text + update.content
          : update.content,
    };
    if (!this.streamTimer)
      this.streamTimer = setTimeout(() => {
        this.streamTimer = undefined;
        this.publish();
      }, 50);
  }
  private publish(refreshTurn = false): void {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = undefined;
    }
    const messages = this.reader?.after(this.lastOrdinal) ?? [];
    if (messages.length) this.lastOrdinal = messages.at(-1)!.ordinal;
    if (refreshTurn) {
      const latest = this.reader?.latestTurn();
      messages.push(
        ...(this.reader?.page().messages.filter((m) => m.turnId === latest?.id) ?? []),
      );
    }
    this.hub.publish({ activity: this.readActivity(), messages });
  }

  async close(): Promise<void> {
    this.stopping = true;
    for (const receipt of this.queue.splice(0))
      this.updateReceipt(receipt, {
        status: "interrupted",
        error: "The service was stopped before this queued request began.",
      });
    if (this.opening) await this.opening.catch(() => undefined);
    if (this.runtime)
      await this.runtime.dispose({
        type: "runner_failed",
        error: "Remote service shutdown.",
      });
    await this.maintenance?.catch(() => undefined);
    await this.active?.completion;
    await this.controlTail;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.hub.close();
    this.reader?.close();
  }
  get pendingCount(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }
  receiptChanged(): void {
    this.publish();
  }
  get initialized(): boolean {
    return this.runtime !== undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
