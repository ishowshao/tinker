import type { AgentEvent, AgentEventType } from "./types";

export type EventSinkDiagnostic = {
  sinkName: string;
  failedEventType: AgentEventType;
  error: string;
};

export type EventSinkAppendResult = {
  diagnostics: EventSinkDiagnostic[];
};

export interface EventSink {
  readonly name?: string;
  append(event: AgentEvent): Promise<void | EventSinkAppendResult>;
}
