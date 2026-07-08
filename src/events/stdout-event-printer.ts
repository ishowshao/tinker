import type { ToolCall } from "../agent/types";
import type { EventSink } from "./event-sink";
import type { AgentEvent } from "./types";

export type WritableLike = {
  write(chunk: string): unknown;
};

export class StdoutEventPrinter implements EventSink {
  constructor(
    private readonly stdout: WritableLike,
    private readonly stderr: WritableLike,
  ) {}

  async append(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "run.started":
        this.stdout.write(`run.started runId=${event.runId}\n`);
        break;
      case "model.step.started":
        this.stdout.write(`model.step.started step=${event.step}\n`);
        break;
      case "model.step.finished":
        this.stdout.write(`model.step.finished step=${event.step}\n`);
        break;
      case "assistant.progress":
        this.stdout.write(`assistant.progress step=${event.step}\n${event.content}\n`);
        break;
      case "tool.started":
        this.stdout.write(formatToolLine("tool.started", event.call));
        break;
      case "tool.finished":
        this.stdout.write(
          `${formatToolLine("tool.finished", event.call).trimEnd()} ok=${event.ok}\n`,
        );
        break;
      case "mcp.server.connected":
        this.stdout.write(
          `mcp.server.connected name=${event.serverName} tools=${event.toolCount}\n`,
        );
        break;
      case "mcp.server.failed":
        this.stderr.write(
          `mcp.server.failed name=${event.serverName} error=${event.error}\n`,
        );
        break;
      case "run.finished":
        this.stdout.write(`run.finished ok=${resultOk(event.result)}\n`);
        break;
      case "run.failed":
        this.stderr.write(`run.failed error=${event.error}\n`);
        break;
      default:
        break;
    }
  }
}

function formatToolLine(prefix: string, call: ToolCall): string {
  if (call.name === "Bash") {
    const description = bashDescription(call);
    return `${prefix} name=${call.name}${description === undefined ? "" : ` desc=${description}`}\n`;
  }

  if (call.name === "Grep" || call.name === "Glob") {
    const pattern = toolPattern(call);
    return `${prefix} name=${call.name}${pattern === undefined ? "" : ` pattern=${pattern}`}\n`;
  }

  const filePath = toolFilePath(call);
  return `${prefix} name=${call.name}${filePath === undefined ? "" : ` path=${filePath}`}\n`;
}

function bashDescription(call: ToolCall): string | undefined {
  if (
    typeof call.args === "object" &&
    call.args !== null &&
    !Array.isArray(call.args)
  ) {
    if ("description" in call.args && typeof call.args.description === "string") {
      return call.args.description;
    }

    if ("command" in call.args && typeof call.args.command === "string") {
      return call.args.command;
    }
  }

  return undefined;
}

function toolPattern(call: ToolCall): string | undefined {
  if (
    typeof call.args === "object" &&
    call.args !== null &&
    !Array.isArray(call.args) &&
    "pattern" in call.args &&
    typeof call.args.pattern === "string"
  ) {
    return call.args.pattern;
  }

  return undefined;
}

function toolFilePath(call: ToolCall): string | undefined {
  if (
    typeof call.args === "object" &&
    call.args !== null &&
    !Array.isArray(call.args) &&
    "file_path" in call.args &&
    typeof call.args.file_path === "string"
  ) {
    return call.args.file_path;
  }

  return undefined;
}

function resultOk(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    result.ok === true
  );
}
