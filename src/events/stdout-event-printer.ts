import type { RunAgentResult, ToolCall } from "../agent/types";
import { countPatchChanges, parseDiffHunks } from "../tools/file-diff";
import type { ToolRawResult } from "../tools/types";
import { bashResultDetail } from "./bash-result-detail";
import type { EventSink } from "./event-sink";
import type { AgentEvent } from "./types";

export type WritableLike = {
  write(chunk: string): unknown;
};

export class StdoutEventPrinter implements EventSink {
  readonly name = "stdout-event-printer";

  constructor(
    private readonly stdout: WritableLike,
    private readonly stderr: WritableLike,
  ) {}

  async append(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "session.started":
        this.stdout.write(`session.started sessionId=${event.sessionId}\n`);
        break;
      case "turn.started":
        this.stdout.write(
          `turn.started turn=${event.turnNumber} turnId=${event.turnId}\n`,
        );
        break;
      case "agent.iteration.started":
        this.stdout.write(
          `agent.iteration.started iteration=${event.iterationNumber} iterationId=${event.iterationId}\n`,
        );
        break;
      case "model.request.started":
        this.stdout.write(`model.request.started iteration=${event.iterationNumber}\n`);
        break;
      case "model.request.finished":
        this.stdout.write(
          `model.request.finished iteration=${event.iterationNumber}\n`,
        );
        break;
      case "assistant.progress":
        this.stdout.write(
          `assistant.progress iteration=${event.iterationNumber}\n${event.data.content}\n`,
        );
        break;
      case "tool.started":
        this.stdout.write(formatToolLine("tool.started", event.data.call));
        break;
      case "tool.raw_result": {
        for (const line of formatToolRawResult(event.data.call, event.data.raw)) {
          this.stdout.write(line);
        }
        break;
      }
      case "tool.finished":
        this.stdout.write(
          `${formatToolLine("tool.finished", event.data.call).trimEnd()} ok=${event.data.ok}\n`,
        );
        break;
      case "mcp.server.connected":
        this.stdout.write(
          `mcp.server.connected name=${event.data.serverName} tools=${event.data.toolCount}\n`,
        );
        break;
      case "bash.task.backgrounded":
        this.stdout.write(
          `bash.task.backgrounded task=${event.data.task.taskId} status=${event.data.task.status}\n`,
        );
        break;
      case "bash.task.stopping":
        this.stdout.write(
          `bash.task.stopping task=${event.data.task.taskId} status=${event.data.task.status}\n`,
        );
        break;
      case "bash.task.finished":
        this.stdout.write(
          `bash.task.finished task=${event.data.task.taskId} status=${event.data.task.status}${
            event.data.task.exitCode === undefined
              ? ""
              : ` exit=${event.data.task.exitCode}`
          }${event.data.task.signal === undefined ? "" : ` signal=${event.data.task.signal}`}\n`,
        );
        break;
      case "mcp.server.failed":
        this.stderr.write(
          `mcp.server.failed name=${event.data.serverName} error=${event.data.error}\n`,
        );
        break;
      case "diagnostic.sink_failed":
        this.stderr.write(
          `diagnostic.sink_failed sink=${event.data.sinkName} event=${event.data.failedEventType} error=${event.data.error}\n`,
        );
        break;
      case "turn.finished":
        this.stdout.write(`turn.finished status=${resultStatus(event.data.result)}\n`);
        break;
      case "turn.cancelled":
        this.stdout.write(
          `turn.cancelled phase=${event.data.cancellation.phase} iteration=${event.data.cancellation.iterationNumber}${
            event.data.cancellation.toolName === undefined
              ? ""
              : ` tool=${event.data.cancellation.toolName}`
          }\n`,
        );
        break;
      case "turn.failed":
        this.stderr.write(`turn.failed error=${event.data.error}\n`);
        break;
      case "session.finished":
        this.stdout.write(`session.finished reason=${event.data.reason}\n`);
        break;
      default:
        break;
    }
  }
}

function formatToolRawResult(call: ToolCall, raw: ToolRawResult): string[] {
  switch (raw.kind) {
    case "write":
    case "edit":
      return optionalLine(formatDiff(call, raw));
    case "bash":
    case "task_output":
      return optionalLine(formatBashResult(call, raw));
    case "task_list":
    case "task_stop":
      return optionalLine(formatTaskResult(call, raw));
    case "read":
    case "glob":
    case "grep":
    case "web_search":
    case "web_fetch":
    case "mcp":
    case "generic":
      return [];
    default:
      return assertNever(raw);
  }
}

function optionalLine(line: string | undefined): string[] {
  return line === undefined ? [] : [line];
}

function assertNever(value: never): never {
  throw new Error(`Unhandled tool raw result: ${JSON.stringify(value)}`);
}

function formatDiff(call: ToolCall, raw: ToolRawResult): string | undefined {
  if (raw.kind !== "edit" && raw.kind !== "write") {
    return undefined;
  }
  if (!raw.ok) {
    return undefined;
  }

  const hunks = parseDiffHunks(raw.patch);
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

  if (raw.patchTruncated === true) {
    lines.push("(diff truncated)");
  }

  return `${lines.join("\n")}\n`;
}

function formatBashResult(_call: ToolCall, raw: ToolRawResult): string | undefined {
  if (raw.kind !== "bash" && raw.kind !== "task_output") {
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

function formatTaskResult(_call: ToolCall, raw: ToolRawResult): string | undefined {
  if (!raw.ok) {
    return undefined;
  }

  if (raw.kind === "task_list") {
    return `task.list total=${raw.tasks.length} running=${raw.runningCount}\n`;
  }

  if (raw.kind === "task_stop") {
    if (raw.status !== undefined) {
      const signal = raw.task?.signal;
      return `task.stop task=${raw.taskId} status=${raw.status}${signal === undefined ? "" : ` signal=${signal}`}\n`;
    }
  }

  return undefined;
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

  if (call.name === "TaskList") {
    return `${prefix} name=${call.name}\n`;
  }

  if (call.name === "TaskOutput" || call.name === "TaskStop") {
    const taskId = toolTaskId(call);
    return `${prefix} name=${call.name}${taskId === undefined ? "" : ` task=${taskId}`}\n`;
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

function toolTaskId(call: ToolCall): string | undefined {
  const args = asRecord(call.args);
  return stringProperty(args, "task_id");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringProperty(
  record: Record<string, unknown>,
  property: string,
): string | undefined {
  return typeof record[property] === "string" ? record[property] : undefined;
}

function resultStatus(result: RunAgentResult): string {
  return result.status;
}
