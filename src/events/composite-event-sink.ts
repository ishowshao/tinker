import type { EventSink } from "./event-sink";
import type { AgentEvent } from "./types";

export class CompositeEventSink implements EventSink {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly sinks: EventSink[]) {}

  append(event: AgentEvent): Promise<void> {
    const write = this.tail.then(() => this.appendToSinks(event));
    this.tail = write.catch(() => undefined);
    return write;
  }

  private async appendToSinks(event: AgentEvent): Promise<void> {
    for (const sink of this.sinks) {
      await sink.append(event);
    }
  }
}
