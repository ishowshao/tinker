import type { ToolCall } from "../agent/types";
import type { ToolObservation } from "../observation/observation-builder";
import type { EventSink } from "./event-sink";
import type { AgentEvent, TurnFinishedData } from "./types";
import { appendPrivateFile } from "./append-private-file";

export class ObservationTextLog implements EventSink {
  readonly name = "observation-text-log";

  constructor(private readonly filePath: string) {}

  async append(event: AgentEvent): Promise<void> {
    const text = renderObservationLogEvent(event);
    if (text === undefined) {
      return;
    }

    await appendPrivateFile(this.filePath, text);
  }
}

export function renderObservationLogEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "session.started":
      return renderSessionStarted(event);
    case "session.resumed":
      return [
        "---",
        "",
        `Resumed: ${event.timestamp}`,
        `Open count: ${event.data.openCount}`,
        `Recovered synthetic completions: ${event.data.syntheticCompletionCount}`,
        `Recall index rebuilt: ${event.data.recallIndexRebuilt}`,
        "",
      ].join("\n");
    case "turn.started":
      return renderTurnStarted(event);
    case "assistant.progress":
      return renderAssistantProgress(event);
    case "tool.observation":
      return renderToolObservation(event);
    case "turn.finished":
      return renderTurnFinished(event.data);
    case "turn.cancelled":
      return renderTurnCancelled(event);
    case "turn.failed":
      return renderTurnFailed(event.data.error);
    default:
      return undefined;
  }
}

function renderSessionStarted(
  event: Extract<AgentEvent, { type: "session.started" }>,
): string {
  return [
    `# Tinker Session ${event.sessionId}`,
    "",
    `Started: ${event.timestamp}`,
    `Workspace: ${event.data.workspaceRoot}`,
    `Model: ${event.data.model}`,
    `Max iterations: ${event.data.maxIterations}`,
    "",
    "---",
    "",
  ].join("\n");
}

function renderTurnStarted(
  event: Extract<AgentEvent, { type: "turn.started" }>,
): string {
  return [
    `## Turn ${event.turnNumber ?? ""} - Prompt`,
    "",
    event.data.userPrompt,
    "",
    "---",
    "",
  ].join("\n");
}

function renderAssistantProgress(
  event: Extract<AgentEvent, { type: "assistant.progress" }>,
): string {
  return [
    `## Iteration ${event.iterationId} - Assistant`,
    "",
    event.data.content,
    "",
    "---",
    "",
  ].join("\n");
}

function renderToolObservation(
  event: Extract<AgentEvent, { type: "tool.observation" }>,
): string {
  return [
    `## Iteration ${event.iterationId} - ${event.data.call.name}`,
    "",
    toolCallSummary(event.data.call),
    "",
    observationContent(event.data.observation),
    "",
    "---",
    "",
  ].join("\n");
}

function renderTurnFinished(data: TurnFinishedData): string {
  return [
    "## Final",
    "",
    data.finalText.trim() === "" ? "(no final response)" : data.finalText,
    "",
  ].join("\n");
}

function renderTurnFailed(error: string): string {
  return ["## Failed", "", error, ""].join("\n");
}

function renderTurnCancelled(
  event: Extract<AgentEvent, { type: "turn.cancelled" }>,
): string {
  return [
    "## Cancelled",
    "",
    `Cancelled: ${event.timestamp}`,
    `Phase: ${event.data.cancellation.phase}`,
    `Iteration: ${event.data.cancellation.iterationNumber}`,
    event.data.cancellation.toolName === undefined
      ? undefined
      : `Tool: ${event.data.cancellation.toolName}`,
    event.data.cancellation.toolCallId === undefined
      ? undefined
      : `Call ID: ${event.data.cancellation.toolCallId}`,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function toolCallSummary(call: ToolCall): string {
  const args = asRecord(call.args);

  if (call.name === "Bash") {
    const description = stringProperty(args, "description");
    const command = stringProperty(args, "command");
    return [
      `Call ID: ${call.toolCallId}`,
      description === undefined ? undefined : `Description: ${description}`,
      command === undefined ? undefined : `Command: ${command}`,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  if (call.name === "TaskOutput" || call.name === "TaskStop") {
    const taskId = stringProperty(args, "task_id");
    return [
      `Call ID: ${call.toolCallId}`,
      taskId === undefined ? undefined : `Task ID: ${taskId}`,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  const filePath = stringProperty(args, "file_path");
  const pattern = stringProperty(args, "pattern");
  return [
    `Call ID: ${call.toolCallId}`,
    filePath === undefined ? undefined : `Path: ${filePath}`,
    pattern === undefined ? undefined : `Pattern: ${pattern}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function observationContent(observation: ToolObservation): string {
  return observation.content;
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
