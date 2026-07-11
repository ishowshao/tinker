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
    this.snapshot = createInitialTuiProjectionState(input);
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
}
