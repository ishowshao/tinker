import type { EventSink } from "./event-sink";
import type { AgentEvent } from "./types";
import { appendPrivateFile } from "./append-private-file";

export class JsonlEventLog implements EventSink {
  readonly name = "jsonl-event-log";

  constructor(private readonly filePath: string) {}

  async append(event: AgentEvent): Promise<void> {
    await appendPrivateFile(this.filePath, `${JSON.stringify(event)}\n`);
  }
}
