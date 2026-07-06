import type { EventSink } from "./event-sink";
import type { AgentEvent } from "./types";

export type TuiEventListener = (event: AgentEvent) => void;

export class TuiEventStream implements EventSink {
  private readonly listeners = new Set<TuiEventListener>();
  readonly events: AgentEvent[] = [];

  subscribe(listener: TuiEventListener): () => void {
    this.listeners.add(listener);

    for (const event of this.events) {
      listener(event);
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  async append(event: AgentEvent): Promise<void> {
    this.events.push(event);

    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
