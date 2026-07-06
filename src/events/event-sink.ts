import type { AgentEvent } from "./types";

export interface EventSink {
  append(event: AgentEvent): Promise<void>;
}
