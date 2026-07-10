import {
  bashCommandFromArgs,
  bashResultDetail,
  type BashDisplayDetail,
} from "../events/bash-result-detail";
import type { AgentEvent } from "../events/types";
import type { ShellTaskSnapshot } from "../tools/bash-task";
import { countPatchChanges, parseDiffHunks } from "../tools/file-diff";
import type { DiffHunk } from "../tools/types";

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
  runId?: string;
  modelName?: string;
  workspaceRoot?: string;
  timeline: TimelineItem[];
  backgroundTasks: ShellTaskSnapshot[];
  finalText?: string;
  error?: string;
};

export function createInitialTuiState(input: {
  runId: string;
  modelName: string;
  workspaceRoot: string;
}): TuiState {
  return {
    status: "idle",
    runId: input.runId,
    modelName: input.modelName,
    workspaceRoot: input.workspaceRoot,
    timeline: [],
    backgroundTasks: [],
  };
}

export function applyAgentEvent(state: TuiState, event: AgentEvent): TuiState {
  switch (event.type) {
    case "run.started":
      return {
        ...state,
        status: "running",
        runId: event.runId,
        timeline: [
          ...state.timeline,
          {
            id: timelineId(state, "run-started"),
            label: "prompt",
            text: runPrompt(event.input),
            status: "text",
          },
        ],
      };
    case "model.step.started":
      return {
        ...state,
        status: "running",
        timeline: [
          ...state.timeline,
          {
            id: timelineId(state, `model-${event.step}-started`),
            ref: modelStepRef(event.step),
            text: `model step ${event.step}`,
            status: "running",
          },
        ],
      };
    case "model.step.finished":
      return {
        ...state,
        timeline: updateLastTimelineItem(state, modelStepRef(event.step), (item) => ({
          ...item,
          text: `model step ${event.step}${modelStepSummary(event.output)}`,
          status: "ok",
        })),
      };
    case "assistant.progress":
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            id: timelineId(state, `assistant-${event.step}-progress`),
            label: "assistant",
            text: event.content,
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
            id: timelineId(state, `${event.call.id}-started`),
            ref: toolCallRef(event.call.id),
            text: toolCallSummary(event.call),
            status: "running",
            ...toolStartedBashDetail(event.call),
          },
        ],
      };
    case "tool.raw_result":
      return {
        ...state,
        timeline: updateLastTimelineItem(state, toolCallRef(event.call.id), (item) => ({
          ...item,
          text: toolRawResultSummary(event.call.name, event.call.args, event.raw),
          ...toolRawResultDiff(event.raw),
          ...toolRawResultBashDetail(event.call.name, event.raw),
        })),
      };
    case "tool.finished":
      return {
        ...state,
        timeline: updateLastTimelineItem(state, toolCallRef(event.call.id), (item) => ({
          ...item,
          status: event.ok ? "ok" : "failed",
        })),
      };
    case "bash.task.backgrounded":
    case "bash.task.stopping":
    case "bash.task.finished":
      return {
        ...state,
        backgroundTasks: upsertBackgroundTask(state.backgroundTasks, event.task),
      };
    case "mcp.server.connected":
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            id: timelineId(state, `mcp-${event.serverName}-connected`),
            label: "mcp",
            text: `mcp ${event.serverName} connected -> ${event.toolCount} tool${event.toolCount === 1 ? "" : "s"}`,
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
            id: timelineId(state, `mcp-${event.serverName}-failed`),
            label: "mcp",
            text: `mcp ${event.serverName} failed -> ${event.error}`,
            status: "failed",
          },
        ],
      };
    case "run.finished":
      return {
        ...state,
        status: "done",
        finalText: finalText(event.result),
        timeline: appendFinalTimelineItem(state, event.result),
      };
    case "run.cancelled":
      return {
        ...state,
        status: "cancelled",
        timeline: applyRunCancellation(state, event),
      };
    case "run.failed":
      return {
        ...state,
        status: "failed",
        error: event.error,
        timeline: [
          ...state.timeline,
          {
            id: timelineId(state, "run-failed"),
            label: "error",
            text: event.error,
            status: "failed",
          },
        ],
      };
    default:
      return state;
  }
}

function applyRunCancellation(
  state: TuiState,
  event: Extract<AgentEvent, { type: "run.cancelled" }>,
): TimelineItem[] {
  if (event.cancellation.phase === "model_request") {
    return updateLastTimelineItem(
      state,
      modelStepRef(event.cancellation.step),
      (item) => ({
        ...item,
        text: `${item.text} -> cancelled`,
        status: "cancelled",
      }),
    );
  }

  if (
    event.cancellation.phase === "tool_execution" &&
    event.cancellation.toolCallId !== undefined
  ) {
    return updateLastTimelineItem(
      state,
      toolCallRef(event.cancellation.toolCallId),
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
      id: timelineId(state, "run-cancelled"),
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

function appendFinalTimelineItem(state: TuiState, result: unknown): TimelineItem[] {
  const text = finalText(result);
  if (text === undefined || text.trim() === "") {
    return state.timeline;
  }

  return [
    ...state.timeline,
    {
      id: timelineId(state, "final"),
      label: "assistant",
      text,
      status: "text",
    },
  ];
}

function timelineId(state: TuiState, suffix: string): string {
  return `${state.timeline.length}-${suffix}`;
}

function modelStepRef(step: number): string {
  return `model-step-${step}`;
}

function toolCallRef(callId: string): string {
  return `tool-call-${callId}`;
}

function modelStepSummary(output: unknown): string {
  const outputRecord = asRecord(output);
  const message = asRecord(outputRecord.message);
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];

  if (toolCalls.length > 0) {
    return ` -> ${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}`;
  }

  return " -> assistant response";
}

function runPrompt(input: unknown): string {
  if (
    typeof input === "object" &&
    input !== null &&
    "userPrompt" in input &&
    typeof input.userPrompt === "string"
  ) {
    return input.userPrompt;
  }

  return "run started";
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

function toolRawResultSummary(name: string, args: unknown, raw: unknown): string {
  const base = toolCallSummary({ name, args });
  const rawRecord = asRecord(raw);

  if (rawRecord.ok !== true) {
    const error = stringProperty(rawRecord, "error");
    if (error !== undefined) {
      return `${base} -> ${error}`;
    }

    const exitCode =
      name === "Bash" ? numberProperty(rawRecord, "exitCode") : undefined;
    return exitCode === undefined ? base : `${base} -> exit ${exitCode}`;
  }

  if (name === "Glob") {
    const matchCount = numberProperty(rawRecord, "matchCount");
    if (matchCount !== undefined) {
      return `${base} -> ${matchCount} match${matchCount === 1 ? "" : "es"}`;
    }
  }

  if (name === "Grep") {
    const mode = stringProperty(rawRecord, "mode");

    if (mode === "content") {
      const numLines = numberProperty(rawRecord, "numLines");
      if (numLines !== undefined) {
        return `${base} -> ${numLines} line${numLines === 1 ? "" : "s"}`;
      }
    } else if (mode === "count") {
      const numMatches = numberProperty(rawRecord, "numMatches");
      const numFiles = numberProperty(rawRecord, "numFiles");
      if (numMatches !== undefined && numFiles !== undefined) {
        return `${base} -> ${numMatches} match${numMatches === 1 ? "" : "es"} across ${numFiles} file${numFiles === 1 ? "" : "s"}`;
      }
    } else {
      const numFiles = numberProperty(rawRecord, "numFiles");
      if (numFiles !== undefined) {
        return `${base} -> ${numFiles} file${numFiles === 1 ? "" : "s"}`;
      }
    }
  }

  if (name === "Read") {
    const startLine = numberProperty(rawRecord, "startLine");
    const endLine = numberProperty(rawRecord, "endLine");
    const totalLines = numberProperty(rawRecord, "totalLines");

    if (startLine !== undefined && endLine !== undefined && totalLines !== undefined) {
      return `${base} -> lines ${startLine}-${endLine} of ${totalLines}`;
    }
  }

  if (name === "Write" || name === "Edit") {
    const patch = diffHunksProperty(rawRecord);
    if (patch !== undefined) {
      const changes = countPatchChanges(patch);
      const created = rawRecord.created === true ? " (new file)" : "";
      return `${base} -> +${changes.additions} -${changes.deletions}${created}`;
    }

    const bytesWritten = numberProperty(rawRecord, "bytesWritten");
    if (bytesWritten !== undefined) {
      return `${base} -> ${bytesWritten} bytes`;
    }
  }

  if (name === "WebSearch") {
    const resultCount = numberProperty(rawRecord, "resultCount");
    if (resultCount !== undefined) {
      return `${base} -> ${resultCount} result${resultCount === 1 ? "" : "s"}`;
    }
  }

  if (name === "WebFetch") {
    if (stringProperty(rawRecord, "redirectUrl") !== undefined) {
      return `${base} -> redirected`;
    }

    const route = stringProperty(rawRecord, "route");
    if (route !== undefined) {
      return `${base} -> ok (${route}${rawRecord.refined === true ? ", refined" : ""})`;
    }
  }

  if (name === "TaskList") {
    const tasks = Array.isArray(rawRecord.tasks) ? rawRecord.tasks : [];
    const runningCount = numberProperty(rawRecord, "runningCount") ?? 0;
    return `${base} -> ${tasks.length} task${tasks.length === 1 ? "" : "s"}, ${runningCount} running`;
  }

  if (name === "TaskOutput") {
    const status = stringProperty(rawRecord, "status");
    const outputLines = numberProperty(rawRecord, "outputLines");
    if (status !== undefined && outputLines !== undefined) {
      return `${base} -> ${status}, ${outputLines} line${outputLines === 1 ? "" : "s"}`;
    }
  }

  if (name === "TaskStop") {
    const status = stringProperty(rawRecord, "status");
    const task = asRecord(rawRecord.task);
    const signal = stringProperty(task, "signal");
    if (status !== undefined) {
      return `${base} -> ${status}${signal === undefined ? "" : ` (${signal})`}`;
    }
  }

  if (name === "Bash") {
    const status = stringProperty(rawRecord, "status");
    const outputFilePath = stringProperty(rawRecord, "outputFilePath");
    const exitCode = numberProperty(rawRecord, "exitCode");

    if (status === "running") {
      return outputFilePath === undefined
        ? `${base} -> running`
        : `${base} -> running ${outputFilePath}`;
    }

    if (exitCode !== undefined) {
      return `${base} -> exit ${exitCode}`;
    }
  }

  return base;
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

function toolRawResultBashDetail(
  name: string,
  raw: unknown,
): Pick<TimelineItem, "bash"> {
  if (name !== "Bash" && name !== "TaskOutput") {
    return {};
  }

  const detail = bashResultDetail(raw);
  return detail === undefined ? {} : { bash: detail };
}

function upsertBackgroundTask(
  tasks: ShellTaskSnapshot[],
  task: ShellTaskSnapshot,
): ShellTaskSnapshot[] {
  const next = tasks.filter((candidate) => candidate.taskId !== task.taskId);
  next.push(task);
  return next.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function toolRawResultDiff(raw: unknown): Pick<TimelineItem, "diff" | "diffTruncated"> {
  const rawRecord = asRecord(raw);
  const hunks = diffHunksProperty(rawRecord);

  if (hunks === undefined || hunks.length === 0) {
    return {};
  }

  return {
    diff: hunks,
    diffTruncated: rawRecord.patchTruncated === true,
  };
}

function diffHunksProperty(record: Record<string, unknown>): DiffHunk[] | undefined {
  return parseDiffHunks(record.patch);
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

function numberProperty(
  record: Record<string, unknown>,
  property: string,
): number | undefined {
  return typeof record[property] === "number" ? record[property] : undefined;
}

function stringProperty(
  record: Record<string, unknown>,
  property: string,
): string | undefined {
  return typeof record[property] === "string" ? record[property] : undefined;
}

function finalText(result: unknown): string | undefined {
  if (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    result.status === "completed" &&
    "finalText" in result &&
    typeof result.finalText === "string"
  ) {
    return result.finalText;
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
