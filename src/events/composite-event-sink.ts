import type { EventSink } from "./event-sink";
import type { AgentEvent } from "./types";

export class CompositeEventSink implements EventSink {
  constructor(private readonly sinks: EventSink[]) {}

  async append(event: AgentEvent): Promise<void> {
    for (const sink of this.sinks) {
      await sink.append(event);
    }
  }
}
