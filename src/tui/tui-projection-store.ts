import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import type {
  AssistantTextDeltaSink,
  AssistantTextDeltaUpdate,
} from "../agent/assistant-text-delta";
import {
  createInitialTuiProjectionState,
  firstRunningIndex,
  reduceTuiProjection,
  timelineStreamItems,
  visibleTimelineItems,
  type TimelineItem,
  type TuiProjectionState,
} from "./event-store";
import {
  defaultTuiProjectionPolicy,
  type TuiProjectionPolicy,
  validateTuiProjectionPolicy,
} from "./tui-projection-policy";
import { MarkdownSectionFramer } from "./assistant-markdown-section-framer";

export type TuiProjectionStoreInput = {
  sessionId: string;
  modelName: string;
  workspaceRoot: string;
  policy?: TuiProjectionPolicy;
  initialSnapshot?: TuiProjectionState;
};

export type AssistantStreamSectionItem = Readonly<{
  kind: "assistant-stream-section";
  id: string;
  iterationId: string;
  attemptNumber: number;
  sectionNumber: number;
  markdown: string;
  showAssistantLabel: boolean;
}>;

export type TuiCommittedItem = TimelineItem | AssistantStreamSectionItem;

export function isAssistantStreamSectionItem(
  item: TuiCommittedItem,
): item is AssistantStreamSectionItem {
  return "kind" in item && item.kind === "assistant-stream-section";
}

export type TuiTimelineLog = Readonly<{
  committed: readonly TuiCommittedItem[];
  live: readonly TimelineItem[];
}>;

type AssistantStreamAttempt = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnNumber: number;
  readonly iterationId: string;
  readonly iterationNumber: number;
  readonly attemptNumber: number;
  readonly framer: MarkdownSectionFramer;
  sectionCount: number;
};

export class TuiProjectionStore implements EventSink, AssistantTextDeltaSink {
  readonly name = "tui-projection-store";
  private readonly listeners = new Set<() => void>();
  private readonly policy: TuiProjectionPolicy;
  private readonly printed = new Set<string>();
  private readonly physicallyAdoptedIterations = new Map<string, string>();
  private snapshot: TuiProjectionState;
  private log: TuiTimelineLog = { committed: [], live: [] };
  private assistantStreamAttempt?: AssistantStreamAttempt;

  constructor(input: TuiProjectionStoreInput) {
    this.policy = validateTuiProjectionPolicy(
      input.policy ?? defaultTuiProjectionPolicy,
    );
    this.snapshot =
      input.initialSnapshot === undefined
        ? createInitialTuiProjectionState(input)
        : validateInitialSnapshot(input, input.initialSnapshot, this.policy);
    if (input.initialSnapshot !== undefined) {
      this.refreshLog(visibleTimelineItems(this.snapshot));
    }
  }

  readonly getSnapshot = (): TuiProjectionState => this.snapshot;

  readonly getLogSnapshot = (): TuiTimelineLog => this.log;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async append(event: AgentEvent): Promise<void> {
    const next = reduceTuiProjection(this.snapshot, event, this.policy);
    const snapshotChanged = next !== this.snapshot;
    this.snapshot = next;
    const presentationChanged = this.applyAssistantStreamEvent(event);
    if (!snapshotChanged && !presentationChanged) {
      return;
    }

    if (snapshotChanged) {
      this.refreshLog();
    }
    this.notifyListeners();
  }

  updateAssistantTextDelta(update: AssistantTextDeltaUpdate): void {
    const attempt = this.assistantStreamAttempt;
    if (
      attempt === undefined ||
      update.content === "" ||
      !sameAssistantStreamAttempt(attempt, update)
    ) {
      return;
    }

    const frames = attempt.framer.push(update.content);
    if (frames.length === 0) {
      return;
    }
    const committed = [...this.log.committed];
    for (const frame of frames) {
      attempt.sectionCount += 1;
      committed.push(this.sectionItem(attempt, frame.markdown));
    }
    this.log = { committed, live: this.log.live };
    this.notifyListeners();
  }

  hydrate(snapshot: TuiProjectionState): void {
    if (
      this.snapshot.activeTurn !== undefined ||
      this.snapshot.recentTurns.length !== 0 ||
      this.snapshot.notices.length !== 0
    ) {
      throw new Error("TUI projection can only be hydrated before live events.");
    }
    this.snapshot = validateInitialSnapshot(
      {
        sessionId: this.snapshot.sessionId,
        modelName: this.snapshot.modelName,
        workspaceRoot: this.snapshot.workspaceRoot,
      },
      snapshot,
      this.policy,
    );
    this.refreshLog(visibleTimelineItems(this.snapshot));
    this.notifyListeners();
  }

  private applyAssistantStreamEvent(event: AgentEvent): boolean {
    switch (event.type) {
      case "model.request.started":
        this.assistantStreamAttempt = assistantStreamAttempt(event);
        return false;
      case "model.request.failed":
        return this.failAssistantStreamAttempt(event);
      case "model.request.finished":
        return this.finishAssistantStreamAttempt(event);
      case "assistant.progress":
        if (
          event.iterationId !== undefined &&
          this.physicallyAdoptedIterations.has(event.iterationId)
        ) {
          this.printed.add(`assistant-${event.iterationId}-${event.eventSequence}`);
        }
        return false;
      case "turn.finished": {
        const adopted = this.physicallyAdoptedIterations.has(
          event.data.lastIteration.iterationId,
        );
        if (adopted) {
          this.printed.add(`turn-${event.turnId}-final-${event.eventSequence}`);
        }
        this.clearAdoptedTurn(event.turnId);
        this.assistantStreamAttempt = undefined;
        return false;
      }
      case "turn.failed":
      case "turn.cancelled":
        this.clearAdoptedTurn(event.turnId);
        this.assistantStreamAttempt = undefined;
        return false;
      case "session.finished":
        this.physicallyAdoptedIterations.clear();
        this.assistantStreamAttempt = undefined;
        return false;
      default:
        return false;
    }
  }

  private failAssistantStreamAttempt(
    event: Extract<AgentEvent, { type: "model.request.failed" }>,
  ): boolean {
    const attempt = this.assistantStreamAttempt;
    if (attempt === undefined || !sameAssistantStreamEvent(attempt, event)) {
      return false;
    }
    this.assistantStreamAttempt = undefined;
    if (event.data.retryDisposition !== "scheduled" || attempt.sectionCount === 0) {
      return false;
    }
    this.appendCommitted({
      id: `assistant-stream-retry-${attempt.iterationId}-${attempt.attemptNumber}`,
      text: "assistant response interrupted · retrying",
      status: "info",
    });
    return true;
  }

  private finishAssistantStreamAttempt(
    event: Extract<AgentEvent, { type: "model.request.finished" }>,
  ): boolean {
    const attempt = this.assistantStreamAttempt;
    if (attempt === undefined || !sameAssistantStreamEvent(attempt, event)) {
      return false;
    }
    this.assistantStreamAttempt = undefined;
    const result = attempt.framer.finish();
    if (
      attempt.sectionCount === 0 ||
      result.content !== (event.data.output.message.content ?? "")
    ) {
      return false;
    }

    this.printed.add(`model-${attempt.iterationId}`);
    this.physicallyAdoptedIterations.set(attempt.iterationId, attempt.turnId);
    if (result.tail === "") {
      return false;
    }
    attempt.sectionCount += 1;
    this.appendCommitted(this.sectionItem(attempt, result.tail));
    return true;
  }

  private sectionItem(
    attempt: AssistantStreamAttempt,
    markdown: string,
  ): AssistantStreamSectionItem {
    return Object.freeze({
      kind: "assistant-stream-section",
      id: `assistant-stream-${attempt.iterationId}-${attempt.attemptNumber}-${attempt.sectionCount}`,
      iterationId: attempt.iterationId,
      attemptNumber: attempt.attemptNumber,
      sectionNumber: attempt.sectionCount,
      markdown,
      showAssistantLabel: attempt.sectionCount === 1,
    });
  }

  private appendCommitted(item: TuiCommittedItem): void {
    this.log = {
      committed: [...this.log.committed, item],
      live: this.log.live,
    };
  }

  private clearAdoptedTurn(turnId: string | undefined): void {
    if (turnId === undefined) {
      return;
    }
    for (const [iterationId, adoptedTurnId] of this.physicallyAdoptedIterations) {
      if (adoptedTurnId === turnId) {
        this.physicallyAdoptedIterations.delete(iterationId);
      }
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private refreshLog(stream = timelineStreamItems(this.snapshot)): void {
    const settledEnd = firstRunningIndex(stream);
    const pending = stream
      .slice(0, settledEnd)
      .filter((item) => !this.printed.has(item.id));
    for (const item of pending) {
      this.printed.add(item.id);
    }
    this.log = {
      committed:
        pending.length === 0 ? this.log.committed : [...this.log.committed, ...pending],
      live: stream.slice(settledEnd),
    };
  }
}

function assistantStreamAttempt(
  event: Extract<AgentEvent, { type: "model.request.started" }>,
): AssistantStreamAttempt | undefined {
  if (
    event.turnId === undefined ||
    event.turnNumber === undefined ||
    event.iterationId === undefined ||
    event.iterationNumber === undefined
  ) {
    return undefined;
  }
  return {
    sessionId: event.sessionId,
    turnId: event.turnId,
    turnNumber: event.turnNumber,
    iterationId: event.iterationId,
    iterationNumber: event.iterationNumber,
    attemptNumber: event.data.attemptNumber,
    framer: new MarkdownSectionFramer(),
    sectionCount: 0,
  };
}

function sameAssistantStreamAttempt(
  attempt: AssistantStreamAttempt,
  update: AssistantTextDeltaUpdate,
): boolean {
  return (
    attempt.sessionId === update.sessionId &&
    attempt.turnId === update.turnId &&
    attempt.turnNumber === update.turnNumber &&
    attempt.iterationId === update.iterationId &&
    attempt.iterationNumber === update.iterationNumber &&
    attempt.attemptNumber === update.attemptNumber
  );
}

function sameAssistantStreamEvent(
  attempt: AssistantStreamAttempt,
  event: Extract<
    AgentEvent,
    { type: "model.request.failed" | "model.request.finished" }
  >,
): boolean {
  return (
    attempt.sessionId === event.sessionId &&
    attempt.turnId === event.turnId &&
    attempt.turnNumber === event.turnNumber &&
    attempt.iterationId === event.iterationId &&
    attempt.iterationNumber === event.iterationNumber &&
    attempt.attemptNumber === event.data.attemptNumber
  );
}

function validateInitialSnapshot(
  input: Pick<TuiProjectionStoreInput, "sessionId" | "modelName" | "workspaceRoot">,
  snapshot: TuiProjectionState,
  policy: TuiProjectionPolicy,
): TuiProjectionState {
  if (
    snapshot.sessionId !== input.sessionId ||
    snapshot.modelName !== input.modelName ||
    snapshot.workspaceRoot !== input.workspaceRoot
  ) {
    throw new Error("Hydrated TUI projection identity does not match its store.");
  }
  if (
    snapshot.activeTurn !== undefined ||
    snapshot.status === "running" ||
    snapshot.backgroundTasks.length !== 0
  ) {
    throw new Error("Hydrated TUI projection must be terminal and have no tasks.");
  }
  if (
    snapshot.recentTurns.length > policy.recentTurnLimit ||
    snapshot.notices.length > policy.sessionNoticeLimit ||
    snapshot.recentTurns.some(
      (turn) =>
        turn.status === "running" || turn.items.length > policy.itemLimitPerTurn,
    )
  ) {
    throw new Error("Hydrated TUI projection exceeds its bounded policy.");
  }
  return Object.freeze({
    ...snapshot,
    recentTurns: Object.freeze(
      snapshot.recentTurns.map((turn) =>
        Object.freeze({ ...turn, items: Object.freeze([...turn.items]) }),
      ),
    ) as unknown as TuiProjectionState["recentTurns"],
    notices: Object.freeze([
      ...snapshot.notices,
    ]) as unknown as TuiProjectionState["notices"],
    backgroundTasks: [],
  });
}
