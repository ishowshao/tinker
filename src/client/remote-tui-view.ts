import { visibleTimelineItems, type TuiProjectionState } from "../tui/event-store";
import type { TuiTimelineLog } from "../tui/tui-projection-store";
import type { RemoteTuiSnapshot } from "../remote/tui-protocol";

/** Retains printed history across refreshes; connection state stays in the live area. */
export class RemoteTuiView {
  private readonly listeners = new Set<() => void>();
  private readonly printed = new Set<string>();
  private state: TuiProjectionState;
  private log: TuiTimelineLog = { committed: [], live: [] };
  private connection = "connecting";
  private error?: string;
  private activity = "idle";

  constructor(snapshot: RemoteTuiSnapshot) {
    this.state = snapshot.history;
    this.update(snapshot);
  }
  readonly getSnapshot = () => this.state;
  readonly getLogSnapshot = () => this.log;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(snapshot: RemoteTuiSnapshot): void {
    this.error = undefined;
    this.activity = snapshot.activity.status;
    this.state = {
      ...snapshot.history,
      ...(snapshot.activity.activeRequestId ? { status: "running" as const } : {}),
    };
    const added = visibleTimelineItems(snapshot.history).filter(
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
      live: [
        {
          id: "service-connection",
          status: this.error ? "failed" : "info",
          text: `Service: ${this.connection} · ${this.activity}${this.error ? ` · ${this.error}` : ""}`,
        },
      ],
    };
    for (const listener of this.listeners) listener();
  }
}
