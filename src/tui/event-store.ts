import type { AgentEvent } from "../events/types";

export type TimelineItem = {
  id: string;
  text: string;
  status: "running" | "ok" | "failed" | "info";
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
            id: `run-${event.runId}`,
            text: `run started`,
            status: "info",
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
            id: `model-${event.step}-started`,
            text: `model step ${event.step} started`,
            status: "running",
          },
        ],
      };
    case "model.step.finished":
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            id: `model-${event.step}-finished`,
            text: `model step ${event.step} finished`,
            status: "ok",
          },
        ],
      };
    case "tool.started":
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            id: `${event.call.id}-started`,
            text: `${event.call.name} ${toolPath(event.call.args) ?? ""}`.trim(),
            status: "running",
          },
        ],
      };
    case "tool.finished":
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            id: `${event.call.id}-finished`,
            text: `${event.call.name} ${toolPath(event.call.args) ?? ""}`.trim(),
            status: event.ok ? "ok" : "failed",
          },
        ],
      };
    case "run.finished":
      return {
        ...state,
        status: "done",
        finalText: finalText(event.result),
      };
    case "run.failed":
      return {
        ...state,
        status: "failed",
        error: event.error,
      };
    default:
      return state;
  }
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
