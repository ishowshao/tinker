import type { AgentEvent } from "../events/types";

export type TimelineItem = {
  id: string;
  ref?: string;
  text: string;
  label?: string;
  status: "running" | "ok" | "failed" | "info" | "text";
};

export type TuiState = {
  status: "idle" | "running" | "done" | "failed";
  runId?: string;
  modelName?: string;
  workspaceRoot?: string;
  timeline: TimelineItem[];
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
          },
        ],
      };
    case "tool.raw_result":
      return {
        ...state,
        timeline: updateLastTimelineItem(state, toolCallRef(event.call.id), (item) => ({
          ...item,
          text: toolRawResultSummary(event.call.name, event.call.args, event.raw),
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
    case "run.finished":
      return {
        ...state,
        status: "done",
        finalText: finalText(event.result),
        timeline: appendFinalTimelineItem(state, event.result),
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
  if (input.name === "Glob") {
    return `Glob ${toolPattern(input.args) ?? ""}`.trim();
  }

  const filePath = toolPath(input.args);
  return `${input.name}${filePath === undefined ? "" : ` ${filePath}`}`;
}

function toolRawResultSummary(name: string, args: unknown, raw: unknown): string {
  const base = toolCallSummary({ name, args });
  const rawRecord = asRecord(raw);

  if (rawRecord.ok !== true) {
    const error = stringProperty(rawRecord, "error");
    return error === undefined ? base : `${base} -> ${error}`;
  }

  if (name === "Glob") {
    const matchCount = numberProperty(rawRecord, "matchCount");
    if (matchCount !== undefined) {
      return `${base} -> ${matchCount} match${matchCount === 1 ? "" : "es"}`;
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

  if (name === "Write") {
    const bytesWritten = numberProperty(rawRecord, "bytesWritten");
    if (bytesWritten !== undefined) {
      return `${base} -> ${bytesWritten} bytes`;
    }
  }

  return base;
}

function toolPattern(args: unknown): string | undefined {
  const argsRecord = asRecord(args);
  return stringProperty(argsRecord, "pattern");
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
    "ok" in result &&
    result.ok === true &&
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
