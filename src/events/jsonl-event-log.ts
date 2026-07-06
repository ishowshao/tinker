import path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import type { EventSink } from "./event-sink";
import type { AgentEvent } from "./types";

export class JsonlEventLog implements EventSink {
  constructor(private readonly filePath: string) {}

  async append(event: AgentEvent): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}
