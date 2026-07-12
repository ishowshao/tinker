import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import {
  createInitialTuiProjectionState,
  reduceTuiProjection,
  type TuiProjectionState,
} from "./event-store";
import {
  defaultTuiProjectionPolicy,
  type TuiProjectionPolicy,
  validateTuiProjectionPolicy,
} from "./tui-projection-policy";

export type TuiProjectionStoreInput = {
  sessionId: string;
  modelName: string;
  workspaceRoot: string;
  policy?: TuiProjectionPolicy;
  initialSnapshot?: TuiProjectionState;
};

export class TuiProjectionStore implements EventSink {
  readonly name = "tui-projection-store";
  private readonly listeners = new Set<() => void>();
  private readonly policy: TuiProjectionPolicy;
  private snapshot: TuiProjectionState;

  constructor(input: TuiProjectionStoreInput) {
    this.policy = validateTuiProjectionPolicy(
      input.policy ?? defaultTuiProjectionPolicy,
    );
    this.snapshot =
      input.initialSnapshot === undefined
        ? createInitialTuiProjectionState(input)
        : validateInitialSnapshot(input, input.initialSnapshot, this.policy);
  }

  readonly getSnapshot = (): TuiProjectionState => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async append(event: AgentEvent): Promise<void> {
    const next = reduceTuiProjection(this.snapshot, event, this.policy);
    if (next === this.snapshot) {
      return;
    }

    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
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
    for (const listener of this.listeners) {
      listener();
    }
  }
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
