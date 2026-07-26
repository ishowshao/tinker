import {
  bashCommandFromArgs,
  bashResultDetail,
  type BashDisplayDetail,
} from "../events/bash-result-detail";
import type { AgentEvent } from "../events/types";
import type { ContextUsageSnapshot } from "../agent/context-meter";
import type {
  ModelContextBudget,
  ModelContextProfile,
} from "../model/model-context-profile";
import type { ShellTaskSnapshot, ShellTaskStatus } from "../tools/bash-task";
import { countPatchChanges } from "../tools/file-diff";
import type { DiffHunk, ToolRawResult } from "../tools/types";
import {
  defaultTuiProjectionPolicy,
  type TuiProjectionPolicy,
  validateTuiProjectionPolicy,
} from "./tui-projection-policy";
import {
  MAX_TIMELINE_PROMPT_CODE_POINTS,
  truncateUserPromptProjection,
  type UserPromptProjection,
} from "../agent/user-prompt-projection";

export type TimelineItem = {
  id: string;
  ref?: string;
  text: string;
  label?: string;
  status: "running" | "ok" | "failed" | "cancelled" | "info" | "text";
  diff?: DiffHunk[];
  diffTruncated?: boolean;
  bash?: BashDisplayDetail;
  userPrompt?: UserPromptProjection;
};

export type TuiTurnProjection = {
  turnId: string;
  turnNumber: number;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  workedForMs?: number;
  items: TimelineItem[];
  omittedItemCount: number;
};

export type TuiProjectionState = {
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  sessionId: string;
  modelName: string;
  workspaceRoot: string;
  workedForMs?: number;
  contextProfile?: ModelContextProfile;
  contextBudget?: ModelContextBudget;
  contextUsage?: ContextUsageSnapshot;
  activeTurn?: TuiTurnProjection;
  recentTurns: TuiTurnProjection[];
  notices: TimelineItem[];
  backgroundTasks: ShellTaskSnapshot[];
  omittedTurnCount: number;
  finalText?: string;
  error?: string;
};

export type TuiState = TuiProjectionState;

export function createInitialTuiState(input: {
  sessionId: string;
  modelName: string;
  workspaceRoot: string;
}): TuiProjectionState {
  return {
    status: "idle",
    sessionId: input.sessionId,
    modelName: input.modelName,
    workspaceRoot: input.workspaceRoot,
    recentTurns: [],
    notices: [],
    backgroundTasks: [],
    omittedTurnCount: 0,
  };
}

export const createInitialTuiProjectionState = createInitialTuiState;

export function reduceTuiProjection(
  state: TuiProjectionState,
  event: AgentEvent,
  policy: TuiProjectionPolicy = defaultTuiProjectionPolicy,
): TuiProjectionState {
  validateTuiProjectionPolicy(policy);

  switch (event.type) {
    case "session.started":
      return {
        ...state,
        sessionId: event.sessionId,
        modelName: event.data.model,
        workspaceRoot: event.data.workspaceRoot,
        contextProfile: event.data.contextProfile,
        contextBudget: event.data.contextBudget,
      };
    case "session.resumed":
      return {
        ...state,
        contextProfile: event.data.contextProfile,
        contextBudget: event.data.contextBudget,
      };
    case "session.interrupted_frame_recovered":
      return state;
    case "context.usage.updated":
      return { ...state, contextUsage: event.data.snapshot };
    case "turn.started": {
      if (state.activeTurn !== undefined) {
        throw new Error(
          `Cannot project turn ${event.turnId} while turn ${state.activeTurn.turnId} is active.`,
        );
      }
      const turnId = requireEventString(event.turnId, "turn.started turnId");
      const turnNumber = requireEventNumber(
        event.turnNumber,
        "turn.started turnNumber",
      );
      parseEventTimestamp(event.timestamp);
      const userPrompt = truncateUserPromptProjection(
        event.data.userPrompt,
        MAX_TIMELINE_PROMPT_CODE_POINTS,
      );
      return {
        ...state,
        status: "running",
        workedForMs: undefined,
        finalText: undefined,
        error: undefined,
        activeTurn: {
          turnId,
          turnNumber,
          status: "running",
          startedAt: event.timestamp,
          items: [
            {
              id: `turn-${turnId}-prompt-${event.eventSequence}`,
              label: "prompt",
              text: userPrompt.text,
              userPrompt,
              status: "text",
            },
          ],
          omittedItemCount: 0,
        },
      };
    }
    case "model.request.started":
      return updateActiveTurn(state, event, policy, (turn) =>
        event.data.attemptNumber === 1
          ? appendTurnItem(turn, {
              id: `model-${event.iterationId}`,
              ref: modelRequestRef(event.iterationId),
              text: `model iteration ${event.iterationNumber}`,
              status: "running",
            })
          : updateTurnItem(turn, modelRequestRef(event.iterationId), (item) => ({
              ...item,
              text: `model iteration ${event.iterationNumber} · retrying`,
              status: "running",
            })),
      );
    case "model.request.failed":
      return state;
    case "model.request.finished":
      return updateActiveTurn(state, event, policy, (turn) =>
        updateTurnItem(turn, modelRequestRef(event.iterationId), (item) => ({
          ...item,
          text: completedModelRequestText(
            requireEventNumber(
              event.iterationNumber,
              "model.request.finished iterationNumber",
            ),
            event.data.output.message.toolCalls?.length ?? 0,
          ),
          status: "ok",
        })),
      );
    case "assistant.progress":
      return updateActiveTurn(state, event, policy, (turn) =>
        appendTurnItem(turn, {
          id: `assistant-${event.iterationId}-${event.eventSequence}`,
          label: "assistant",
          text: event.data.content,
          status: "text",
        }),
      );
    case "tool.started":
      return updateActiveTurn(state, event, policy, (turn) =>
        appendTurnItem(turn, {
          id: `tool-${event.toolCallId}`,
          ref: toolCallRef(event.data.call.toolCallId),
          status: "running",
          ...toolCallStartedProjection(event.data.call),
        }),
      );
    case "tool.raw_result":
      return updateActiveTurn(state, event, policy, (turn) =>
        updateTurnItem(turn, toolCallRef(event.data.call.toolCallId), (item) => ({
          ...item,
          ...toolRawResultProjection(event.data.call, event.data.raw),
        })),
      );
    case "tool.finished":
      return updateActiveTurn(state, event, policy, (turn) =>
        updateTurnItem(turn, toolCallRef(event.data.call.toolCallId), (item) => ({
          ...item,
          status: event.data.ok ? "ok" : "failed",
        })),
      );
    case "bash.task.backgrounded":
    case "bash.task.stopping":
    case "bash.task.finished":
      return {
        ...state,
        backgroundTasks: upsertBackgroundTask(
          state.backgroundTasks,
          event.data.task,
          policy.completedTaskLimit,
        ),
      };
    case "mcp.server.connected":
      return appendNotice(
        state,
        {
          id: `notice-mcp-${event.eventSequence}`,
          label: "mcp",
          text: `mcp ${event.data.serverName} connected -> ${event.data.toolCount} tool${event.data.toolCount === 1 ? "" : "s"}`,
          status: "info",
        },
        policy.sessionNoticeLimit,
      );
    case "mcp.server.failed":
      return appendNotice(
        state,
        {
          id: `notice-mcp-${event.eventSequence}`,
          label: "mcp",
          text: `mcp ${event.data.serverName} failed -> ${boundedToolError(event.data.error)}`,
          status: "failed",
        },
        policy.sessionNoticeLimit,
      );
    case "skills.catalog.loaded":
      return event.data.shadowedNames.length === 0
        ? state
        : appendNotice(
            state,
            {
              id: `notice-skills-catalog-${event.eventSequence}`,
              label: "skills",
              text: `project skills shadowed user skills -> ${event.data.shadowedNames.join(", ")}`,
              status: "info",
            },
            policy.sessionNoticeLimit,
          );
    case "skills.updated": {
      const changes = [
        event.data.activated.length === 0
          ? undefined
          : `activated ${event.data.activated.join(", ")}`,
        event.data.refreshed.length === 0
          ? undefined
          : `refreshed ${event.data.refreshed.join(", ")}`,
        event.data.deactivated.length === 0
          ? undefined
          : `deactivated ${event.data.deactivated.join(", ")}`,
        event.data.unavailable.length === 0
          ? undefined
          : `unavailable ${event.data.unavailable.join(", ")}`,
      ].filter((entry): entry is string => entry !== undefined);
      return changes.length === 0
        ? state
        : appendNotice(
            state,
            {
              id: `notice-skills-updated-${event.eventSequence}`,
              label: "skills",
              text: `skills updated -> ${changes.join("; ")}`,
              status: "info",
            },
            policy.sessionNoticeLimit,
          );
    }
    case "diagnostic.sink_failed":
      return appendNotice(
        state,
        {
          id: `notice-sink-${event.eventSequence}`,
          label: "diagnostic",
          text: `event sink ${event.data.sinkName} disabled after ${event.data.failedEventType} failed -> ${boundedToolError(event.data.error)}`,
          status: "failed",
        },
        policy.sessionNoticeLimit,
      );
    case "turn.finished": {
      const active = requireActiveTurn(state, event);
      const withFinal =
        event.data.finalText.trim() === ""
          ? active
          : appendTurnItem(active, {
              id: `turn-${active.turnId}-final-${event.eventSequence}`,
              label: "assistant",
              text: event.data.finalText,
              status: "text",
            });
      return finishActiveTurn(
        state,
        event,
        limitTurnItems(withFinal, policy.itemLimitPerTurn),
        "completed",
        policy,
        {
          status: "done",
          finalText: event.data.finalText,
          error: undefined,
        },
      );
    }
    case "turn.cancelled": {
      const active = requireActiveTurn(state, event);
      const cancelled = applyTurnCancellation(active, event);
      return finishActiveTurn(
        state,
        event,
        limitTurnItems(cancelled, policy.itemLimitPerTurn),
        "cancelled",
        policy,
        {
          status: "cancelled",
          finalText: undefined,
          error: undefined,
        },
      );
    }
    case "turn.failed": {
      const active = requireActiveTurn(state, event);
      const failed = appendTurnItem(markRunningItemsFailed(active), {
        id: `turn-${active.turnId}-failed-${event.eventSequence}`,
        label: "error",
        text: event.data.error,
        status: "failed",
      });
      return finishActiveTurn(
        state,
        event,
        limitTurnItems(failed, policy.itemLimitPerTurn),
        "failed",
        policy,
        {
          status: "failed",
          finalText: undefined,
          error: event.data.error,
        },
      );
    }
    case "session.finished":
    case "agent.iteration.started":
    case "agent.iteration.finished":
    case "context.shadow.planned":
    case "context.shadow.failed":
    case "context.revision.started":
    case "context.revision.failed":
    case "tool.observation":
      return state;
    case "context.revision.finished":
      return event.data.strategy === "surface_refresh"
        ? appendNotice(
            state,
            {
              id: `notice-context-refresh-${event.eventSequence}`,
              label: "context",
              text: `runtime context refreshed on resume -> ${event.data.changed.map(formatSurfaceComponent).join(", ")}`,
              status: "info",
            },
            policy.sessionNoticeLimit,
          )
        : state;
    default:
      return assertNever(event);
  }
}

function formatSurfaceComponent(component: string): string {
  return component.replaceAll("_", " ");
}

export const applyAgentEvent = reduceTuiProjection;

export function visibleTimelineItems(state: TuiProjectionState): TimelineItem[] {
  const items = [...state.notices];

  if (state.omittedTurnCount > 0) {
    items.push({
      id: "projection-omitted-turns",
      label: "live view",
      text: `${state.omittedTurnCount} earlier turn${state.omittedTurnCount === 1 ? "" : "s"} omitted; full diagnostics remain on disk`,
      status: "info",
    });
  }

  for (const turn of [
    ...state.recentTurns,
    ...(state.activeTurn === undefined ? [] : [state.activeTurn]),
  ]) {
    items.push(...visibleTurnItems(turn));
  }

  return items;
}

function visibleTurnItems(turn: TuiTurnProjection): TimelineItem[] {
  if (turn.omittedItemCount === 0) {
    return turn.items;
  }

  const marker: TimelineItem = {
    id: `turn-${turn.turnId}-omitted-items`,
    label: "live view",
    text: `${turn.omittedItemCount} earlier timeline item${turn.omittedItemCount === 1 ? "" : "s"} omitted; full diagnostics remain on disk`,
    status: "info",
  };
  const promptIndex = turn.items.findIndex((item) => item.label === "prompt");
  if (promptIndex < 0) {
    return [marker, ...turn.items];
  }

  return [
    ...turn.items.slice(0, promptIndex + 1),
    marker,
    ...turn.items.slice(promptIndex + 1),
  ];
}

function updateActiveTurn(
  state: TuiProjectionState,
  event: AgentEvent,
  policy: TuiProjectionPolicy,
  update: (turn: TuiTurnProjection) => TuiTurnProjection,
): TuiProjectionState {
  const active = requireActiveTurn(state, event);
  return {
    ...state,
    status: "running",
    activeTurn: limitTurnItems(update(active), policy.itemLimitPerTurn),
  };
}

function requireActiveTurn(
  state: TuiProjectionState,
  event: AgentEvent,
): TuiTurnProjection {
  const active = state.activeTurn;
  if (active === undefined) {
    throw new Error(`Cannot project ${event.type} without an active turn.`);
  }
  if (event.turnId !== active.turnId) {
    throw new Error(
      `Event ${event.type} belongs to turn ${event.turnId}, expected ${active.turnId}.`,
    );
  }
  return active;
}

function appendTurnItem(
  turn: TuiTurnProjection,
  item: TimelineItem,
): TuiTurnProjection {
  return { ...turn, items: [...turn.items, item] };
}

function markRunningItemsFailed(turn: TuiTurnProjection): TuiTurnProjection {
  return {
    ...turn,
    items: turn.items.map((item) =>
      item.status === "running" ? { ...item, status: "failed" } : item,
    ),
  };
}

function updateTurnItem(
  turn: TuiTurnProjection,
  ref: string,
  update: (item: TimelineItem) => TimelineItem,
): TuiTurnProjection {
  const index = findLastItemIndex(turn.items, ref);
  if (index < 0) {
    throw new Error(`Cannot update missing TUI timeline item ${ref}.`);
  }

  const items = [...turn.items];
  const item = items[index];
  if (item === undefined) {
    throw new Error(`TUI timeline item ${ref} disappeared during update.`);
  }
  items[index] = update(item);
  return { ...turn, items };
}

function findLastItemIndex(items: TimelineItem[], ref: string): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.ref === ref) {
      return index;
    }
  }
  return -1;
}

function limitTurnItems(turn: TuiTurnProjection, limit: number): TuiTurnProjection {
  if (turn.items.length <= limit) {
    return turn;
  }

  const retained = new Set<number>();
  const promptIndex = turn.items.findIndex((item) => item.label === "prompt");
  if (promptIndex >= 0) {
    retained.add(promptIndex);
  }

  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    if (retained.size >= limit) {
      break;
    }
    if (turn.items[index]?.status === "running") {
      retained.add(index);
    }
  }

  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    if (retained.size >= limit) {
      break;
    }
    retained.add(index);
  }

  const items = turn.items.filter((_item, index) => retained.has(index));
  return {
    ...turn,
    items,
    omittedItemCount: turn.omittedItemCount + turn.items.length - items.length,
  };
}

function finishActiveTurn(
  state: TuiProjectionState,
  event: AgentEvent,
  turn: TuiTurnProjection,
  turnStatus: Exclude<TuiTurnProjection["status"], "running">,
  policy: TuiProjectionPolicy,
  terminalState: Pick<TuiProjectionState, "status" | "finalText" | "error">,
): TuiProjectionState {
  const workedForMs = turnDurationMs(turn.startedAt, event.timestamp);
  const finished = { ...turn, status: turnStatus, workedForMs };
  const allRecent = [...state.recentTurns, finished];
  const omittedNow = Math.max(0, allRecent.length - policy.recentTurnLimit);
  const recentTurns =
    policy.recentTurnLimit === 0 ? [] : allRecent.slice(-policy.recentTurnLimit);

  return {
    ...state,
    ...terminalState,
    activeTurn: undefined,
    recentTurns,
    omittedTurnCount: state.omittedTurnCount + omittedNow,
    workedForMs,
  };
}

function applyTurnCancellation(
  turn: TuiTurnProjection,
  event: Extract<AgentEvent, { type: "turn.cancelled" }>,
): TuiTurnProjection {
  if (event.data.cancellation.phase === "model_request") {
    return updateTurnItem(
      turn,
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
    return updateTurnItem(
      turn,
      toolCallRef(event.data.cancellation.toolCallId),
      (item) => ({
        ...item,
        text: `${item.text} -> cancelled`,
        status: "cancelled",
      }),
    );
  }

  return appendTurnItem(turn, {
    id: `turn-${turn.turnId}-cancelled-${event.eventSequence}`,
    text: "turn cancelled",
    status: "cancelled",
  });
}

function appendNotice(
  state: TuiProjectionState,
  notice: TimelineItem,
  limit: number,
): TuiProjectionState {
  const notices = [...state.notices, notice];
  return {
    ...state,
    notices: limit === 0 ? [] : notices.slice(-limit),
  };
}

function turnDurationMs(startedAt: string, finishedAt: string): number {
  return Math.max(0, parseEventTimestamp(finishedAt) - parseEventTimestamp(startedAt));
}

function parseEventTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid event timestamp: ${value}`);
  }
  return timestamp;
}

function requireEventString(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} must be present.`);
  }
  return value;
}

function requireEventNumber(value: number | undefined, name: string): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function modelRequestRef(iterationId: string | undefined): string {
  return `model-request-${requireEventString(iterationId, "model request iterationId")}`;
}

function toolCallRef(callId: string): string {
  return `tool-call-${callId}`;
}

export function completedModelRequestText(
  iterationNumber: number,
  toolCallCount: number,
): string {
  if (toolCallCount > 0) {
    return `model iteration ${iterationNumber} -> ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}`;
  }
  return `model iteration ${iterationNumber} -> assistant response`;
}

export function toolCallStartedProjection(input: {
  name: string;
  args: unknown;
}): Pick<TimelineItem, "text" | "bash"> {
  return {
    text: toolCallSummary(input),
    ...toolStartedBashDetail(input),
  };
}

export function toolRawResultProjection(
  input: { name: string; args: unknown },
  raw: ToolRawResult,
): Pick<TimelineItem, "text" | "bash" | "diff" | "diffTruncated"> {
  return {
    text: toolRawResultSummary(input.name, input.args, raw),
    ...toolRawResultDiff(raw),
    ...toolRawResultBashDetail(raw),
  };
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
  if (input.name === "WebSearch" || input.name === "MemorySearch") {
    return `${input.name} ${toolQuery(input.args) ?? ""}`.trim();
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
  if (input.name === "Skill") {
    return `Skill ${stringProperty(asRecord(input.args), "name") ?? ""}`.trim();
  }

  const filePath = toolPath(input.args);
  return `${input.name}${filePath === undefined ? "" : ` ${filePath}`}`;
}

function toolRawResultSummary(name: string, args: unknown, raw: ToolRawResult): string {
  const base = toolCallSummary({ name, args });
  if (!raw.ok && raw.error !== undefined) {
    return `${base} -> ${boundedToolError(raw.error)}`;
  }

  switch (raw.kind) {
    case "glob":
      return raw.ok && raw.matchCount !== undefined
        ? `${base} -> ${raw.matchCount} match${raw.matchCount === 1 ? "" : "es"}`
        : base;
    case "grep":
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
    case "recall":
      if (!raw.ok) {
        return base;
      }
      return raw.mode === "search"
        ? `${base} -> ${raw.page.hits.length} historical match${raw.page.hits.length === 1 ? "" : "es"}`
        : `${base} -> ${raw.page.returnedBytes} historical bytes`;
    case "memory_search":
      if (!raw.ok) {
        return base;
      }
      return `${base} -> ${raw.matches.length} derived memor${raw.matches.length === 1 ? "y" : "ies"}`;
    case "skill":
      if (!raw.ok) {
        return `${base} failed -> ${boundedToolError(raw.error)}`;
      }
      return `skill ${raw.name} ${raw.status.replaceAll("_", " ")}`;
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

function boundedToolError(error: string): string {
  const limit = 1_000;
  return error.length <= limit ? error : `${error.slice(0, limit)}…`;
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
    case "recall":
    case "memory_search":
    case "skill":
    case "mcp":
    case "generic":
      return {};
    default:
      return assertNever(raw);
  }
}

function toolRawResultDiff(
  raw: ToolRawResult,
): Pick<TimelineItem, "diff" | "diffTruncated"> {
  switch (raw.kind) {
    case "write":
    case "edit":
      return raw.patch === undefined || raw.patch.length === 0
        ? {}
        : {
            diff: raw.patch.map((hunk) => ({
              ...hunk,
              lines: [...hunk.lines],
            })),
            diffTruncated: raw.patchTruncated === true,
          };
    case "read":
    case "glob":
    case "grep":
    case "bash":
    case "task_list":
    case "task_output":
    case "task_stop":
    case "web_search":
    case "web_fetch":
    case "recall":
    case "memory_search":
    case "skill":
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
  completedTaskLimit: number,
): ShellTaskSnapshot[] {
  const snapshot = cloneTaskSnapshot(task);
  const updated = [
    ...tasks.filter((candidate) => candidate.taskId !== snapshot.taskId),
    snapshot,
  ];
  const active = updated.filter((candidate) => isActiveTask(candidate.status));
  const terminal = updated
    .filter((candidate) => !isActiveTask(candidate.status))
    .sort((left, right) =>
      (right.endedAt ?? right.startedAt).localeCompare(left.endedAt ?? left.startedAt),
    )
    .slice(0, completedTaskLimit);
  return [...active, ...terminal].sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  );
}

function cloneTaskSnapshot(task: ShellTaskSnapshot): ShellTaskSnapshot {
  return { ...task, origin: { ...task.origin } };
}

function isActiveTask(status: ShellTaskStatus): boolean {
  return status === "running" || status === "stopping";
}

function bashDescription(args: unknown): string | undefined {
  const argsRecord = asRecord(args);
  return (
    stringProperty(argsRecord, "description") ?? stringProperty(argsRecord, "command")
  );
}

function toolPattern(args: unknown): string | undefined {
  return stringProperty(asRecord(args), "pattern");
}

function toolQuery(args: unknown): string | undefined {
  return stringProperty(asRecord(args), "query");
}

function toolUrl(args: unknown): string | undefined {
  return stringProperty(asRecord(args), "url");
}

function toolPath(args: unknown): string | undefined {
  const record = asRecord(args);
  return stringProperty(record, "file_path");
}

function toolTaskId(args: unknown): string | undefined {
  return stringProperty(asRecord(args), "task_id");
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

function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
}
