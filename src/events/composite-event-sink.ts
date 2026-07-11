import type {
  EventSink,
  EventSinkAppendResult,
  EventSinkDiagnostic,
} from "./event-sink";
import type { AgentEvent } from "./types";

export class CompositeEventSink implements EventSink {
  private tail: Promise<void> = Promise.resolve();
  private readonly requiredSinks: EventSink[];
  private readonly auxiliarySinks: EventSink[];
  private readonly disabledAuxiliarySinks = new Set<EventSink>();

  constructor(input: {
    requiredSinks: EventSink[];
    auxiliarySinks: EventSink[];
  }) {
    this.requiredSinks = input.requiredSinks;
    this.auxiliarySinks = input.auxiliarySinks;
  }

  append(event: AgentEvent): Promise<void | EventSinkAppendResult> {
    const write = this.tail.then(() => this.appendToSinks(event));
    this.tail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private async appendToSinks(
    event: AgentEvent,
  ): Promise<void | EventSinkAppendResult> {
    const requiredErrors: Error[] = [];
    for (const sink of this.requiredSinks) {
      try {
        await sink.append(event);
      } catch (error) {
        requiredErrors.push(
          new Error(
            `Required event sink ${sinkName(sink)} failed while appending ${event.type}.`,
            { cause: error },
          ),
        );
      }
    }

    const diagnostics: EventSinkDiagnostic[] = [];
    for (const sink of this.auxiliarySinks) {
      if (this.disabledAuxiliarySinks.has(sink)) {
        continue;
      }
      try {
        await sink.append(event);
      } catch (error) {
        this.disabledAuxiliarySinks.add(sink);
        diagnostics.push({
          sinkName: sinkName(sink),
          failedEventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (requiredErrors.length === 1) {
      throw requiredErrors[0];
    }
    if (requiredErrors.length > 1) {
      throw new AggregateError(
        requiredErrors,
        `Multiple required event sinks failed while appending ${event.type}.`,
      );
    }
    if (diagnostics.length > 0) {
      return { diagnostics };
    }
  }
}

function sinkName(sink: EventSink): string {
  return sink.name ?? sink.constructor.name ?? "anonymous";
}
