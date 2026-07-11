import {
  bashCommandFromArgs,
  bashResultDetail,
  type BashDisplayDetail,
} from "../events/bash-result-detail";
import type { AgentEvent } from "../events/types";
import type { ModelRequestOutput } from "../model/model-client";
import type { ShellTaskSnapshot } from "../tools/bash-task";
import { countPatchChanges } from "../tools/file-diff";
import type { DiffHunk, ToolRawResult } from "../tools/types";

export type TimelineItem = {
  id: string;
  ref?: string;
  text: string;
  label?: string;
  status: "running" | "ok" | "failed" | "cancelled" | "info" | "text";
  diff?: DiffHunk[];
  diffTruncated?: boolean;
  bash?: BashDisplayDetail;
};

export type TuiState = {
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  sessionId?: string;
  modelName?: string;
  workspaceRoot?: string;
  turnStartedAt?: number;
  workedForMs?: number;
  timeline: TimelineItem[];
  backgroundTasks: ShellTaskSnapshot[];
  finalText?: string;
  error?: string;
};

export function createInitialTuiState(input: {
  sessionId: string;
  modelName: string;
  workspaceRoot: string;
}): TuiState {
  return {
    status: "idle",
    sessionId: input.sessionId,
    modelName: input.modelName,
    workspaceRoot: input.workspaceRoot,
    timeline: [],
    backgroundTasks: [],
  };
}

export function applyAgentEvent(state: TuiState, event: AgentEvent): TuiState {
  switch (event.type) {
    case "session.started":
      return {
        ...state,
        sessionId: event.sessionId,
      };
    case "turn.started":
      return {
        ...state,
        status: "running",
        turnStartedAt: parseEventTimestamp(event.timestamp),
        workedForMs: undefined,
        timeline: [
          ...state.timeline,
          {
            id: timelineId(state, `${event.turnId}-started`),
            label: "prompt",
            text: event.data.userPrompt,
            status: "text",
          },
        ],
      };
    case "model.request.started":
      return {
        ...state,
        status: "running",
        timeline: [
          ...state.timeline,
          {
            id: timelineId(state, `model-${event.iterationId}-started`),
            ref: modelRequestRef(event.iterationId),
            text: `model iteration ${event.iterationNumber}`,
            status: "running",
          },
        ],
      };
    case "model.request.finished":
      return {
        ...state,
        timeline: updateLastTimelineItem(
          state,
          modelRequestRef(event.iterationId),
          (item) => ({
            ...item,
            text: `model iteration ${event.iterationNumber}${modelRequestSummary(event.data.output)}`,
            status: "ok",
          }),
        ),
      };
    case "assistant.progress":
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            id: timelineId(state, `assistant-${event.iterationId}-progress`),
            label: "assistant",
            text: event.data.content,
            status: "text",
          },
        ],
      };
    case "tool.started":
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            id: timelineId(state, `${event.toolCallId}-started`),
            ref: toolCallRef(event.data.call.toolCallId),
            text: toolCallSummary(event.data.call),
            status: "running",
            ...toolStartedBashDetail(event.data.call),
          },
        ],
      };
    case "tool.raw_result":
      return {
        ...state,
        timeline: updateLastTimelineItem(
          state,
          toolCallRef(event.data.call.toolCallId),
          (item) => ({
            ...item,
            text: toolRawResultSummary(
              event.data.call.name,
              event.data.call.args,
              event.data.raw,
            ),
            ...toolRawResultDiff(event.data.raw),
            ...toolRawResultBashDetail(event.data.raw),
          }),
        ),
      };
    case "tool.finished":
      return {
        ...state,
        timeline: updateLastTimelineItem(
          state,
          toolCallRef(event.data.call.toolCallId),
          (item) => ({
            ...item,
            status: event.data.ok ? "ok" : "failed",
          }),
        ),
      };
    case "bash.task.backgrounded":
    case "bash.task.stopping":
    case "bash.task.finished":
      return {
        ...state,
        backgroundTasks: upsertBackgroundTask(state.backgroundTasks, event.data.task),
      };
    case "mcp.server.connected":
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            id: timelineId(state, `mcp-${event.data.serverName}-connected`),
            label: "mcp",
            text: `mcp ${event.data.serverName} connected -> ${event.data.toolCount} tool${event.data.toolCount === 1 ? "" : "s"}`,
            status: "info",
          },
        ],
      };
    case "mcp.server.failed":
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            id: timelineId(state, `mcp-${event.data.serverName}-failed`),
            label: "mcp",
            text: `mcp ${event.data.serverName} failed -> ${event.data.error}`,
            status: "failed",
          },
        ],
      };
    case "diagnostic.sink_failed":
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            id: timelineId(state, `sink-${event.eventSequence}-${event.data.sinkName}`),
            label: "diagnostic",
            text: `event sink ${event.data.sinkName} disabled after ${event.data.failedEventType} failed -> ${event.data.error}`,
            status: "failed",
          },
        ],
      };
    case "turn.finished":
      return {
        ...state,
        status: "done",
        workedForMs: turnDurationMs(state.turnStartedAt, event.timestamp),
        finalText: event.data.finalText,
        timeline: appendFinalTimelineItem(state, event.data.finalText),
      };
    case "turn.cancelled":
      return {
        ...state,
        status: "cancelled",
        timeline: applyTurnCancellation(state, event),
      };
    case "turn.failed":
      return {
        ...state,
        status: "failed",
        error: event.data.error,
        timeline: [
          ...state.timeline,
          {
            id: timelineId(state, `${event.turnId}-failed`),
            label: "error",
            text: event.data.error,
            status: "failed",
          },
        ],
      };
    default:
      return state;
  }
}

function turnDurationMs(startedAt: number | undefined, finishedAt: string): number {
  if (startedAt === undefined) {
    throw new Error("turn.finished received before turn.started");
  }

  return Math.max(0, parseEventTimestamp(finishedAt) - startedAt);
}

function parseEventTimestamp(value: string): number {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid event timestamp: ${value}`);
  }

  return timestamp;
}

function applyTurnCancellation(
  state: TuiState,
  event: Extract<AgentEvent, { type: "turn.cancelled" }>,
): TimelineItem[] {
  if (event.data.cancellation.phase === "model_request") {
    return updateLastTimelineItem(
      state,
      modelRequestRef(event.data.cancellation.iterationId),
      (item) => ({
        ...item,
        text: `${item.text} -> cancelled`,
        status: "cancelled",
      }),
    );
  }

  if (
    event.data.cancellation.phase === "tool_execution" &&
    event.data.cancellation.toolCallId !== undefined
  ) {
    return updateLastTimelineItem(
      state,
      toolCallRef(event.data.cancellation.toolCallId),
      (item) => ({
        ...item,
        text: `${item.text} -> cancelled`,
        status: "cancelled",
      }),
    );
  }

  return [
    ...state.timeline,
    {
      id: timelineId(state, `${event.turnId}-cancelled`),
      text: "turn cancelled",
      status: "cancelled",
    },
  ];
}

function updateLastTimelineItem(
  state: TuiState,
  ref: string,
  update: (item: TimelineItem) => TimelineItem,
): TimelineItem[] {
  const timeline = [...state.timeline];

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.ref === ref) {
      timeline[index] = update(timeline[index]);
      return timeline;
    }
  }

  return timeline;
}

function appendFinalTimelineItem(state: TuiState, finalText: string): TimelineItem[] {
  if (finalText.trim() === "") {
    return state.timeline;
  }

  return [
    ...state.timeline,
    {
      id: timelineId(state, "final"),
      label: "assistant",
      text: finalText,
      status: "text",
    },
  ];
}

function timelineId(state: TuiState, suffix: string): string {
  return `${state.timeline.length}-${suffix}`;
}

function modelRequestRef(iterationId: string | undefined): string {
  return `model-request-${iterationId}`;
}

function toolCallRef(callId: string): string {
  return `tool-call-${callId}`;
}

function modelRequestSummary(output: ModelRequestOutput): string {
  const toolCalls = output.message.toolCalls ?? [];

  if (toolCalls.length > 0) {
    return ` -> ${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}`;
  }

  return " -> assistant response";
}

function toolCallSummary(input: { name: string; args: unknown }): string {
  if (input.name === "Bash") {
    return `Bash ${bashDescription(input.args) ?? ""}`.trim();
  }

  if (input.name === "Glob") {
    return `Glob ${toolPattern(input.args) ?? ""}`.trim();
  }

  if (input.name === "Grep") {
    return `Grep ${toolPattern(input.args) ?? ""}`.trim();
  }

  if (input.name === "WebSearch") {
    return `WebSearch ${toolQuery(input.args) ?? ""}`.trim();
  }

  if (input.name === "WebFetch") {
    return `WebFetch ${toolUrl(input.args) ?? ""}`.trim();
  }

  if (input.name === "TaskOutput" || input.name === "TaskStop") {
    return `${input.name} ${toolTaskId(input.args) ?? ""}`.trim();
  }

  if (input.name === "TaskList") {
    return "TaskList";
  }

  const filePath = toolPath(input.args);
  return `${input.name}${filePath === undefined ? "" : ` ${filePath}`}`;
}

function toolRawResultSummary(name: string, args: unknown, raw: ToolRawResult): string {
  const base = toolCallSummary({ name, args });

  if (!raw.ok && raw.error !== undefined) {
    return `${base} -> ${raw.error}`;
  }

  switch (raw.kind) {
    case "glob": {
      if (raw.ok && raw.matchCount !== undefined) {
        return `${base} -> ${raw.matchCount} match${raw.matchCount === 1 ? "" : "es"}`;
      }
      return base;
    }
    case "grep": {
      if (raw.mode === "content" && raw.numLines !== undefined) {
        return `${base} -> ${raw.numLines} line${raw.numLines === 1 ? "" : "s"}`;
      }
      if (
        raw.mode === "count" &&
        raw.numMatches !== undefined &&
        raw.numFiles !== undefined
      ) {
        return `${base} -> ${raw.numMatches} match${raw.numMatches === 1 ? "" : "es"} across ${raw.numFiles} file${raw.numFiles === 1 ? "" : "s"}`;
      }
      return `${base} -> ${raw.numFiles} file${raw.numFiles === 1 ? "" : "s"}`;
    }
    case "read":
      if (
        raw.startLine !== undefined &&
        raw.endLine !== undefined &&
        raw.totalLines !== undefined
      ) {
        return `${base} -> lines ${raw.startLine}-${raw.endLine} of ${raw.totalLines}`;
      }
      return base;
    case "write":
    case "edit": {
      const patch = raw.patch;
      if (patch !== undefined) {
        const changes = countPatchChanges(patch);
        const created = raw.created === true ? " (new file)" : "";
        return `${base} -> +${changes.additions} -${changes.deletions}${created}`;
      }
      return raw.bytesWritten === undefined
        ? base
        : `${base} -> ${raw.bytesWritten} bytes`;
    }
    case "web_search":
      return raw.resultCount === undefined
        ? base
        : `${base} -> ${raw.resultCount} result${raw.resultCount === 1 ? "" : "s"}`;
    case "web_fetch":
      if (raw.redirectUrl !== undefined) {
        return `${base} -> redirected`;
      }
      return raw.route === undefined
        ? base
        : `${base} -> ok (${raw.route}${raw.refined === true ? ", refined" : ""})`;
    case "task_list":
      return `${base} -> ${raw.tasks.length} task${raw.tasks.length === 1 ? "" : "s"}, ${raw.runningCount} running`;
    case "task_output":
      if (raw.status !== undefined && raw.outputLines !== undefined) {
        return `${base} -> ${raw.status}, ${raw.outputLines} line${raw.outputLines === 1 ? "" : "s"}`;
      }
      return base;
    case "task_stop": {
      if (raw.status === undefined) {
        return base;
      }
      const signal = raw.task?.signal;
      return `${base} -> ${raw.status}${signal === undefined ? "" : ` (${signal})`}`;
    }
    case "bash":
      if (raw.status === "running") {
        return raw.outputFilePath === undefined
          ? `${base} -> running`
          : `${base} -> running ${raw.outputFilePath}`;
      }
      return raw.exitCode === undefined ? base : `${base} -> exit ${raw.exitCode}`;
    case "mcp":
    case "generic":
      return base;
    default:
      return assertNever(raw);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled tool raw result: ${JSON.stringify(value)}`);
}

function toolStartedBashDetail(call: {
  name: string;
  args: unknown;
}): Pick<TimelineItem, "bash"> {
  if (call.name !== "Bash") {
    return {};
  }

  const command = bashCommandFromArgs(call.args);
  return command === undefined ? {} : { bash: { command } };
}

function toolRawResultBashDetail(raw: ToolRawResult): Pick<TimelineItem, "bash"> {
  switch (raw.kind) {
    case "bash":
    case "task_output": {
      const detail = bashResultDetail(raw);
      return detail === undefined ? {} : { bash: detail };
    }
    case "read":
    case "write":
    case "edit":
    case "glob":
    case "grep":
    case "task_list":
    case "task_stop":
    case "web_search":
    case "web_fetch":
    case "mcp":
    case "generic":
      return {};
    default:
      return assertNever(raw);
  }
}

function upsertBackgroundTask(
  tasks: ShellTaskSnapshot[],
  task: ShellTaskSnapshot,
): ShellTaskSnapshot[] {
  const next = tasks.filter((candidate) => candidate.taskId !== task.taskId);
  next.push(task);
  return next.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function toolRawResultDiff(
  raw: ToolRawResult,
): Pick<TimelineItem, "diff" | "diffTruncated"> {
  switch (raw.kind) {
    case "write":
    case "edit":
      return raw.patch === undefined || raw.patch.length === 0
        ? {}
        : { diff: raw.patch, diffTruncated: raw.patchTruncated === true };
    case "read":
    case "glob":
    case "grep":
    case "bash":
    case "task_list":
    case "task_output":
    case "task_stop":
    case "web_search":
    case "web_fetch":
    case "mcp":
    case "generic":
      return {};
    default:
      return assertNever(raw);
  }
}

function bashDescription(args: unknown): string | undefined {
  const argsRecord = asRecord(args);
  return (
    stringProperty(argsRecord, "description") ?? stringProperty(argsRecord, "command")
  );
}

function toolPattern(args: unknown): string | undefined {
  const argsRecord = asRecord(args);
  return stringProperty(argsRecord, "pattern");
}

function toolQuery(args: unknown): string | undefined {
  const argsRecord = asRecord(args);
  return stringProperty(argsRecord, "query");
}

function toolUrl(args: unknown): string | undefined {
  const argsRecord = asRecord(args);
  return stringProperty(argsRecord, "url");
}

function toolPath(args: unknown): string | undefined {
  if (
    typeof args === "object" &&
    args !== null &&
    !Array.isArray(args) &&
    "file_path" in args &&
    typeof args.file_path === "string"
  ) {
    return args.file_path;
  }

  return undefined;
}

function toolTaskId(args: unknown): string | undefined {
  const record = asRecord(args);
  return stringProperty(record, "task_id");
}

function stringProperty(
  record: Record<string, unknown>,
  property: string,
): string | undefined {
  return typeof record[property] === "string" ? record[property] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
