import type { ToolCall } from "../agent/types";
import { countPatchChanges, parseDiffHunks } from "../tools/file-diff";
import { bashResultDetail } from "./bash-result-detail";
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
      case "tool.raw_result": {
        const diff = formatDiff(event.call, event.raw);
        if (diff !== undefined) {
          this.stdout.write(diff);
        }

        const bash = formatBashResult(event.call, event.raw);
        if (bash !== undefined) {
          this.stdout.write(bash);
        }
        break;
      }
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

function formatDiff(call: ToolCall, raw: unknown): string | undefined {
  if (call.name !== "Edit" && call.name !== "Write") {
    return undefined;
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }

  const rawRecord = raw as Record<string, unknown>;
  if (rawRecord.ok !== true) {
    return undefined;
  }

  const hunks = parseDiffHunks(rawRecord.patch);
  if (hunks === undefined || hunks.length === 0) {
    return undefined;
  }

  const changes = countPatchChanges(hunks);
  const filePath = toolFilePath(call);
  const lines: string[] = [
    `tool.diff name=${call.name}${filePath === undefined ? "" : ` path=${filePath}`} +${changes.additions} -${changes.deletions}`,
  ];

  for (const hunk of hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    lines.push(...hunk.lines);
  }

  if (rawRecord.patchTruncated === true) {
    lines.push("(diff truncated)");
  }

  return `${lines.join("\n")}\n`;
}

function formatBashResult(call: ToolCall, raw: unknown): string | undefined {
  if (call.name !== "Bash") {
    return undefined;
  }

  const detail = bashResultDetail(raw);
  if (detail === undefined) {
    return undefined;
  }

  const lines = detail.command
    .split("\n")
    .map((line, index) => (index === 0 ? `$ ${line}` : `  ${line}`));
  lines.push(...(detail.outputPreview ?? []));

  const omitted = detail.omittedOutputLines ?? 0;
  if (omitted > 0) {
    const location =
      detail.outputFilePath === undefined
        ? ""
        : ` (full output: ${detail.outputFilePath})`;
    lines.push(`… +${omitted} line${omitted === 1 ? "" : "s"}${location}`);
  }

  return `${lines.join("\n")}\n`;
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

  if (call.name === "WebSearch") {
    const query = toolQuery(call);
    return `${prefix} name=${call.name}${query === undefined ? "" : ` query=${query}`}\n`;
  }

  if (call.name === "WebFetch") {
    const url = toolUrl(call);
    return `${prefix} name=${call.name}${url === undefined ? "" : ` url=${url}`}\n`;
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

function toolQuery(call: ToolCall): string | undefined {
  if (
    typeof call.args === "object" &&
    call.args !== null &&
    !Array.isArray(call.args) &&
    "query" in call.args &&
    typeof call.args.query === "string"
  ) {
    return call.args.query;
  }

  return undefined;
}

function toolUrl(call: ToolCall): string | undefined {
  if (
    typeof call.args === "object" &&
    call.args !== null &&
    !Array.isArray(call.args) &&
    "url" in call.args &&
    typeof call.args.url === "string"
  ) {
    return call.args.url;
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
