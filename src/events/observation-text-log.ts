import path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import type { ToolCall } from "../agent/types";
import type { EventSink } from "./event-sink";
import type { AgentEvent } from "./types";

export class ObservationTextLog implements EventSink {
  constructor(private readonly filePath: string) {}

  async append(event: AgentEvent): Promise<void> {
    const text = renderObservationLogBlock(event);
    if (text === undefined) {
      return;
    }

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, text, "utf8");
  }
}

function renderObservationLogBlock(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "run.started":
      return renderRunStarted(event);
    case "assistant.progress":
      return renderAssistantProgress(event);
    case "tool.observation":
      return renderToolObservation(event);
    case "run.finished":
      return renderRunFinished(event.result);
    case "run.failed":
      return renderRunFailed(event.error);
    default:
      return undefined;
  }
}

function renderRunStarted(event: Extract<AgentEvent, { type: "run.started" }>): string {
  const input = asRecord(event.input);
  const prompt = stringProperty(input, "userPrompt");
  const workspaceRoot = stringProperty(input, "workspaceRoot");
  const model = stringProperty(input, "model");
  const maxSteps = numberProperty(input, "maxSteps");

  return [
    `# Tinker Run ${event.runId}`,
    "",
    `Started: ${event.createdAt}`,
    workspaceRoot === undefined ? undefined : `Workspace: ${workspaceRoot}`,
    model === undefined ? undefined : `Model: ${model}`,
    maxSteps === undefined ? undefined : `Max steps: ${maxSteps}`,
    "",
    "## Prompt",
    "",
    prompt ?? "(prompt unavailable)",
    "",
    "---",
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderAssistantProgress(
  event: Extract<AgentEvent, { type: "assistant.progress" }>,
): string {
  return [
    "## Step " + event.step + " - Assistant",
    "",
    event.content,
    "",
    "---",
    "",
  ].join("\n");
}

function renderToolObservation(
  event: Extract<AgentEvent, { type: "tool.observation" }>,
): string {
  return [
    `## Step ${event.step} - ${event.call.name}`,
    "",
    toolCallSummary(event.call),
    "",
    observationContent(event.observation),
    "",
    "---",
    "",
  ].join("\n");
}

function renderRunFinished(result: unknown): string {
  const final = finalText(result);

  return [
    "## Final",
    "",
    final === undefined || final.trim() === "" ? "(no final response)" : final,
    "",
  ].join("\n");
}

function renderRunFailed(error: string): string {
  return ["## Failed", "", error, ""].join("\n");
}

function toolCallSummary(call: ToolCall): string {
  const args = asRecord(call.args);

  if (call.name === "Bash") {
    const description = stringProperty(args, "description");
    const command = stringProperty(args, "command");
    return [
      `Call ID: ${call.id}`,
      description === undefined ? undefined : `Description: ${description}`,
      command === undefined ? undefined : `Command: ${command}`,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  if (call.name === "TaskOutput" || call.name === "TaskStop") {
    const taskId = stringProperty(args, "task_id");
    return [
      `Call ID: ${call.id}`,
      taskId === undefined ? undefined : `Task ID: ${taskId}`,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  const filePath = stringProperty(args, "file_path");
  const pattern = stringProperty(args, "pattern");
  return [
    `Call ID: ${call.id}`,
    filePath === undefined ? undefined : `Path: ${filePath}`,
    pattern === undefined ? undefined : `Pattern: ${pattern}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function observationContent(observation: unknown): string {
  const record = asRecord(observation);
  const content = stringProperty(record, "content");
  if (content !== undefined) {
    return content;
  }

  return JSON.stringify(observation, undefined, 2);
}

function finalText(result: unknown): string | undefined {
  const record = asRecord(result);
  return record.ok === true ? stringProperty(record, "finalText") : undefined;
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

function numberProperty(
  record: Record<string, unknown>,
  property: string,
): number | undefined {
  return typeof record[property] === "number" ? record[property] : undefined;
}
