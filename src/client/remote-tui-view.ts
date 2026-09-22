import { type TuiProjectionState } from "../tui/event-store";
import type { TuiTimelineLog } from "../tui/tui-projection-store";
import type { RemoteTuiSnapshot } from "../remote/tui-protocol";

/** Retains printed history across refreshes; service status is separate from the timeline. */
export class RemoteTuiView {
  private readonly listeners = new Set<() => void>();
  private readonly printed = new Set<string>();
  private state: TuiProjectionState;
  private log: TuiTimelineLog = { committed: [], live: [] };
  private connection = "connecting";
  private error?: string;
  private activity = "idle";
  private epoch?: string;
  private live: TuiTimelineLog["live"] = [];

  constructor(snapshot: RemoteTuiSnapshot) {
    this.state = snapshot.history;
    this.update(snapshot);
  }
  readonly getServiceStatus = () => ({
    connection: this.connection,
    activity: this.activity,
    error: this.error,
  });
  readonly getPresentationRevision = () => this.epoch;
  readonly getSnapshot = () => this.state;
  readonly getLogSnapshot = () => this.log;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(snapshot: RemoteTuiSnapshot): void {
    // Runtime-generated row IDs are not stable across a service restart. Replace
    // the old projection with canonical recovery and request a terminal redraw.
    if (this.epoch !== snapshot.cursor.epoch) {
      this.epoch = snapshot.cursor.epoch;
      this.printed.clear();
      this.log = { committed: [], live: [] };
    }
    this.error = undefined;
    this.activity = snapshot.activity.status;
    this.state = {
      ...snapshot.history,
      ...(snapshot.activity.activeRequestId ? { status: "running" as const } : {}),
    };
    this.live = snapshot.timeline.live;
    const added = snapshot.timeline.committed.filter(
      (item) => !this.printed.has(item.id),
    );
    for (const item of added) this.printed.add(item.id);
    this.log = { committed: [...this.log.committed, ...added], live: [] };
    this.refresh();
  }
  setConnection(connection: string, error?: string): void {
    this.connection = connection;
    this.error = error;
    this.refresh();
  }
  private refresh(): void {
    this.log = {
      ...this.log,
      live: this.live,
    };
    for (const listener of this.listeners) listener();
  }
}
