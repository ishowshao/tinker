import path from "node:path";
import { realpath } from "node:fs/promises";
import { Database } from "bun:sqlite";
import type { ToolCall } from "../agent/types";
import type { SessionId } from "../ids/runtime-id";
import {
  createModelContextProfile,
  deriveModelContextBudget,
  type ModelContextBudget,
  type ModelContextProfile,
} from "../model/model-context-profile";
import {
  completedModelRequestText,
  toolCallStartedProjection,
  toolRawResultProjection,
  type TimelineItem,
  type TuiProjectionState,
  type TuiTurnProjection,
} from "../tui/event-store";
import {
  defaultTuiProjectionPolicy,
  type TuiProjectionPolicy,
  validateTuiProjectionPolicy,
} from "../tui/tui-projection-policy";
import { SessionError } from "./session-errors";
import { verifySessionSchema } from "./session-schema";
import { decodeStoredToolCalls, decodeStoredToolRawResult } from "./session-store";
import {
  MAX_TIMELINE_PROMPT_CODE_POINTS,
  projectUserMessage,
  truncateUserPromptProjection,
  type UserPromptProjection,
} from "../agent/user-prompt-projection";
import {
  parseImageAssetId,
  parseImageAttachmentId,
  validateUserMessage,
  type UserImageAttachment,
  type UserMessage,
} from "../image/image-types";
import { userMessageHash } from "../context/protocol-frame";

export class ResumeProjectionReader {
  static async read(input: {
    workspaceRoot: string;
    sessionId: SessionId;
    modelName: string;
    policy?: TuiProjectionPolicy;
  }): Promise<TuiProjectionState> {
    const policy = validateTuiProjectionPolicy(
      input.policy ?? defaultTuiProjectionPolicy,
    );
    const workspaceRoot = await realpath(input.workspaceRoot);
    const databasePath = path.join(
      workspaceRoot,
      ".tinker",
      "sessions",
      input.sessionId,
      "session.sqlite",
    );
    const database = new Database(databasePath, {
      readonly: true,
      strict: true,
      safeIntegers: true,
    });
    try {
      verifySessionSchema(database, input.sessionId);
      const meta = database.query("SELECT * FROM session_meta").get() as Record<
        string,
        unknown
      > | null;
      if (
        meta === null ||
        meta.session_id !== input.sessionId ||
        meta.workspace_root !== workspaceRoot ||
        meta.model_name !== input.modelName
      ) {
        throw new SessionError(
          "SESSION_INTEGRITY_FAILED",
          "read_resume_projection",
          "Projection metadata does not match the requested session.",
          { sessionId: input.sessionId },
        );
      }
      const totalTurns = count(
        database.query("SELECT COUNT(*) AS count FROM turns").get(),
      );
      const turns = database
        .query(`SELECT * FROM turns ORDER BY turn_number DESC LIMIT ?`)
        .all(policy.recentTurnLimit)
        .reverse() as Array<Record<string, unknown>>;
      const recentTurns = turns.map((turn) => projectTurn(database, turn, policy));
      const last = recentTurns.at(-1);
      const terminal = terminalProjection(last);
      const context = decodeContextCompatibility(meta.session_compatibility_json);
      return {
        status: terminal.status,
        sessionId: input.sessionId,
        modelName: input.modelName,
        workspaceRoot,
        contextProfile: context.profile,
        contextBudget: context.budget,
        ...(last?.workedForMs === undefined ? {} : { workedForMs: last.workedForMs }),
        recentTurns,
        notices: [],
        backgroundTasks: [],
        omittedTurnCount: Math.max(0, totalTurns - recentTurns.length),
        ...(terminal.finalText === undefined ? {} : { finalText: terminal.finalText }),
        ...(terminal.error === undefined ? {} : { error: terminal.error }),
      };
    } finally {
      database.close();
    }
  }
}

function decodeContextCompatibility(value: unknown): {
  profile: ModelContextProfile;
  budget: ModelContextBudget;
} {
  if (typeof value !== "string") {
    throw new Error("Session compatibility contract is missing.");
  }
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Session compatibility contract must be an object.");
  }
  const record = parsed as Record<string, unknown>;
  const profileRecord = objectValue(record.contextProfile, "contextProfile");
  const profile = createModelContextProfile({
    contextWindowTokens: positiveInteger(
      profileRecord.contextWindowTokens,
      "contextWindowTokens",
    ),
    maxSupportedOutputTokens: positiveInteger(
      profileRecord.maxSupportedOutputTokens,
      "maxSupportedOutputTokens",
    ),
  });
  return { profile, budget: deriveModelContextBudget(profile) };
}

function projectTurn(
  database: Database,
  row: Record<string, unknown>,
  policy: TuiProjectionPolicy,
): TuiTurnProjection {
  const turnId = requireString(row.turn_id, "turn_id");
  const turnNumber = safeNumber(row.turn_number, "turn_number");
  const status = enumValue(
    row.status,
    ["completed", "failed", "cancelled", "interrupted"] as const,
    "turn status",
  );
  const startedAt = timestamp(row.started_at, "started_at");
  const finishedAt = timestamp(row.finished_at, "finished_at");
  const messages = database
    .query("SELECT * FROM messages WHERE turn_id = ? ORDER BY ordinal")
    .all(turnId) as Array<Record<string, unknown>>;
  const promptRows = messages.filter((message) => message.role === "user");
  if (promptRows.length !== 1) {
    throw new Error(
      `Turn ${turnId} must contain exactly one user message; found ${promptRows.length}.`,
    );
  }
  const prompt = promptRows[0];
  if (prompt === undefined) {
    throw new Error(`Turn ${turnId} user message disappeared.`);
  }
  const userPrompt = truncateUserPromptProjection(
    readUserPromptProjection(database, prompt),
    MAX_TIMELINE_PROMPT_CODE_POINTS,
  );
  const allItems: TimelineItem[] = [
    {
      id: `resume-${requireString(prompt.message_id, "message_id")}`,
      label: "prompt",
      text: userPrompt.text,
      userPrompt,
      status: "text",
    },
  ];
  const assistantsByIteration = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    const role = requireString(message.role, "message role");
    if (role !== "assistant") {
      continue;
    }
    const iterationId = requireString(message.iteration_id, "iteration_id");
    if (assistantsByIteration.has(iterationId)) {
      throw new Error(`Iteration ${iterationId} has multiple assistant messages.`);
    }
    assistantsByIteration.set(iterationId, message);
  }

  const toolResultsByCall = new Map<string, Record<string, unknown>>();
  const resultRows = database
    .query(
      `SELECT tool_results.*,
              messages.tool_call_id AS message_tool_call_id,
              messages.iteration_id AS message_iteration_id,
              messages.name AS message_tool_name
       FROM tool_results
       JOIN messages ON messages.message_id = tool_results.tool_message_id
       WHERE messages.turn_id = ?`,
    )
    .all(turnId) as Array<Record<string, unknown>>;
  for (const result of resultRows) {
    const toolCallId = requireString(result.tool_call_id, "tool result call ID");
    if (
      requireString(result.message_tool_call_id, "tool message call ID") !== toolCallId
    ) {
      throw new Error(`Tool result ${toolCallId} does not match its tool message.`);
    }
    if (toolResultsByCall.has(toolCallId)) {
      throw new Error(`Tool call ${toolCallId} has multiple stored results.`);
    }
    toolResultsByCall.set(toolCallId, result);
  }

  const iterations = database
    .query("SELECT * FROM iterations WHERE turn_id = ? ORDER BY iteration_number")
    .all(turnId) as Array<Record<string, unknown>>;
  for (const iteration of iterations) {
    allItems.push(
      ...projectIteration(
        iteration,
        turnId,
        turnNumber,
        assistantsByIteration,
        toolResultsByCall,
      ),
    );
  }
  if (assistantsByIteration.size > 0) {
    throw new Error(
      `Turn ${turnId} has assistant messages without matching iterations.`,
    );
  }
  if (toolResultsByCall.size > 0) {
    throw new Error(`Turn ${turnId} has tool results without matching calls.`);
  }

  if (status === "failed" || status === "interrupted") {
    const detail = terminalDetail(row.terminal_detail_json, status);
    allItems.push({
      id: `resume-${turnId}-terminal`,
      label: status === "interrupted" ? "interrupted" : "error",
      text: detail,
      status: "failed",
    });
  }

  const limited = limitItems(allItems, policy.itemLimitPerTurn);
  return {
    turnId,
    turnNumber,
    status,
    startedAt,
    workedForMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    items: limited.items,
    omittedItemCount: limited.omitted,
  };
}

function readUserPromptProjection(
  database: Database,
  prompt: Record<string, unknown>,
): UserPromptProjection {
  const messageId = requireString(prompt.message_id, "message_id");
  const text = requireString(prompt.content, "user content");
  const chars = [...text];
  const rows = database
    .query(
      `SELECT mia.attachment_id, mia.position, mia.label, mia.range_start,
              mia.range_end, mia.original_name, ia.asset_id, ia.mime_type,
              ia.byte_length, ia.width, ia.height
       FROM message_image_attachments mia
       JOIN image_assets ia ON ia.asset_id = mia.asset_id
       WHERE mia.message_id = ? ORDER BY mia.position`,
    )
    .all(messageId) as Array<Record<string, unknown>>;
  const attachments = rows.map((row, position): UserImageAttachment => {
    if (safeNumber(row.position, "image position") !== position) {
      throw new Error(`Image positions for message ${messageId} are not continuous.`);
    }
    const start = safeNumber(row.range_start, "image range_start");
    const end = safeNumber(row.range_end, "image range_end");
    const label = requireString(row.label, "image label");
    if (
      start < 0 ||
      end <= start ||
      end > chars.length ||
      chars.slice(start, end).join("") !== label
    ) {
      throw new Error(`Image range for message ${messageId} is invalid.`);
    }
    return Object.freeze({
      attachmentId: parseImageAttachmentId(
        requireString(row.attachment_id, "image attachment_id"),
      ),
      assetId: parseImageAssetId(requireString(row.asset_id, "image asset_id")),
      label,
      range: Object.freeze({ start, end }),
      mimeType: enumValue(
        row.mime_type,
        ["image/png", "image/jpeg", "image/webp"] as const,
        "image mime_type",
      ),
      byteLength: positiveInteger(row.byte_length, "image byte_length"),
      width: positiveInteger(row.width, "image width"),
      height: positiveInteger(row.height, "image height"),
      originalName: requireString(row.original_name, "image original_name"),
    });
  });
  const message: UserMessage = Object.freeze({
    role: "user",
    content: text,
    ...(attachments.length === 0 ? {} : { attachments: Object.freeze(attachments) }),
  });
  validateUserMessage(message);
  if (
    userMessageHash(message) !==
    requireString(prompt.content_sha256, "user content_sha256")
  ) {
    throw new Error(`User message ${messageId} failed its integrity check.`);
  }
  return projectUserMessage(message);
}

function projectIteration(
  row: Record<string, unknown>,
  turnId: string,
  turnNumber: number,
  assistantsByIteration: Map<string, Record<string, unknown>>,
  toolResultsByCall: Map<string, Record<string, unknown>>,
): TimelineItem[] {
  const iterationId = requireString(row.iteration_id, "iteration_id");
  const iterationNumber = safeNumber(row.iteration_number, "iteration_number");
  const outcome = enumValue(
    row.outcome,
    ["open", "continue", "completed", "failed", "cancelled", "interrupted"] as const,
    "iteration outcome",
  );
  const assistant = assistantsByIteration.get(iterationId);
  if (assistant === undefined) {
    return [projectUnansweredIteration(iterationId, iterationNumber, outcome)];
  }
  assistantsByIteration.delete(iterationId);

  const assistantMessageId = requireString(assistant.message_id, "message_id");
  const content = nullableText(assistant.content, "assistant content") ?? "";
  const toolCalls =
    assistant.tool_calls_json === null
      ? []
      : decodeStoredToolCalls(
          requireString(assistant.tool_calls_json, "tool_calls_json"),
        );
  const items: TimelineItem[] = [
    {
      id: `model-${iterationId}`,
      ref: `model-request-${iterationId}`,
      text: completedModelRequestText(iterationNumber, toolCalls.length),
      status: "ok",
    },
  ];

  if (toolCalls.length === 0) {
    if (content.trim() !== "") {
      items.push({
        id: `resume-final-${assistantMessageId}`,
        label: "assistant",
        text: boundedText(content),
        status: "text",
      });
    }
    return items;
  }

  if (content.trim() !== "") {
    items.push({
      id: `resume-progress-${assistantMessageId}`,
      label: "assistant",
      text: boundedText(content.trim()),
      status: "text",
    });
  }
  for (const call of toolCalls) {
    assertToolCallIdentity(call, turnId, turnNumber, iterationId, iterationNumber);
    const result = toolResultsByCall.get(call.toolCallId);
    if (result === undefined) {
      throw new Error(`Tool call ${call.toolCallId} is missing its stored result.`);
    }
    toolResultsByCall.delete(call.toolCallId);
    items.push(projectToolCall(call, result));
  }
  return items;
}

function projectUnansweredIteration(
  iterationId: string,
  iterationNumber: number,
  outcome: "open" | "continue" | "completed" | "failed" | "cancelled" | "interrupted",
): TimelineItem {
  const base = {
    id: `model-${iterationId}`,
    ref: `model-request-${iterationId}`,
  };
  if (outcome === "failed") {
    return {
      ...base,
      text: `model iteration ${iterationNumber} -> failed`,
      status: "failed",
    };
  }
  if (outcome === "cancelled") {
    return {
      ...base,
      text: `model iteration ${iterationNumber} -> cancelled`,
      status: "cancelled",
    };
  }
  if (outcome === "interrupted") {
    return {
      ...base,
      text: `model iteration ${iterationNumber} -> interrupted`,
      status: "cancelled",
    };
  }
  throw new Error(
    `Iteration ${iterationId} has outcome ${outcome} without an assistant message.`,
  );
}

function projectToolCall(
  call: ToolCall,
  result: Record<string, unknown>,
): TimelineItem {
  if (
    requireString(result.message_iteration_id, "tool message iteration ID") !==
    call.iterationId
  ) {
    throw new Error(`Tool result ${call.toolCallId} belongs to another iteration.`);
  }
  if (requireString(result.message_tool_name, "tool message name") !== call.name) {
    throw new Error(`Tool result ${call.toolCallId} has a mismatched tool name.`);
  }

  const base = {
    id: `tool-${call.toolCallId}`,
    ref: `tool-call-${call.toolCallId}`,
  };
  const completionKind = enumValue(
    result.completion_kind,
    ["returned", "synthetic"] as const,
    "tool completion kind",
  );
  if (completionKind === "returned") {
    const raw = decodeStoredToolRawResult(
      parseStoredJson(requireString(result.raw_json, "tool raw JSON"), "tool raw JSON"),
    );
    return {
      ...base,
      status: raw.ok ? "ok" : "failed",
      ...toolRawResultProjection(call, raw),
    };
  }

  const started = toolCallStartedProjection(call);
  const reason = enumValue(
    result.synthetic_reason,
    [
      "cancelled_active",
      "skipped_after_cancel",
      "failed_active",
      "skipped_after_failure",
      "interrupted_active",
      "skipped_after_interruption",
    ] as const,
    "synthetic tool result reason",
  );
  const detail = nullableText(result.synthetic_detail, "synthetic detail");
  switch (reason) {
    case "cancelled_active":
      return {
        ...base,
        ...started,
        text: `${started.text} -> cancelled`,
        status: "cancelled",
      };
    case "skipped_after_cancel":
      return {
        ...base,
        ...started,
        text: `${started.text} -> skipped after cancellation`,
        status: "cancelled",
      };
    case "failed_active":
      return {
        ...base,
        ...started,
        text: `${started.text} -> failed${detail === null ? "" : `: ${boundedText(detail)}`}`,
        status: "failed",
      };
    case "skipped_after_failure":
      return {
        ...base,
        ...started,
        text: `${started.text} -> skipped after earlier tool failure`,
        status: "cancelled",
      };
    case "interrupted_active":
      return {
        ...base,
        ...started,
        text: `${started.text} -> interrupted`,
        status: "cancelled",
      };
    case "skipped_after_interruption":
      return {
        ...base,
        ...started,
        text: `${started.text} -> skipped after interruption`,
        status: "cancelled",
      };
  }
}

function assertToolCallIdentity(
  call: ToolCall,
  turnId: string,
  turnNumber: number,
  iterationId: string,
  iterationNumber: number,
): void {
  if (
    call.turnId !== turnId ||
    call.turnNumber !== turnNumber ||
    call.iterationId !== iterationId ||
    call.iterationNumber !== iterationNumber
  ) {
    throw new Error(`Tool call ${call.toolCallId} has mismatched stored identity.`);
  }
}

function limitItems(
  items: TimelineItem[],
  limit: number,
): { items: TimelineItem[]; omitted: number } {
  if (items.length <= limit) {
    return { items, omitted: 0 };
  }
  const prompt = items.find((item) => item.label === "prompt");
  if (limit === 1 && prompt !== undefined) {
    return { items: [prompt], omitted: items.length - 1 };
  }
  const tailLimit = prompt === undefined ? limit : limit - 1;
  const tail = items.slice(-tailLimit);
  const kept = prompt === undefined || tail.includes(prompt) ? tail : [prompt, ...tail];
  return { items: kept, omitted: items.length - kept.length };
}

function terminalProjection(last: TuiTurnProjection | undefined): {
  status: TuiProjectionState["status"];
  finalText?: string;
  error?: string;
} {
  if (last === undefined) {
    return { status: "idle" };
  }
  if (last.status === "completed") {
    const finalText = [...last.items]
      .reverse()
      .find((item) => item.label === "assistant")?.text;
    return { status: "done", ...(finalText === undefined ? {} : { finalText }) };
  }
  if (last.status === "cancelled") {
    return { status: "cancelled" };
  }
  const error = last.items.at(-1)?.text;
  return { status: "failed", ...(error === undefined ? {} : { error }) };
}

function terminalDetail(value: unknown, status: string): string {
  if (typeof value !== "string") {
    return status === "interrupted" ? "Turn was interrupted." : "Turn failed.";
  }
  try {
    const parsed = JSON.parse(value) as { error?: unknown };
    return typeof parsed.error === "string"
      ? boundedText(parsed.error)
      : status === "interrupted"
        ? "Turn was interrupted when the previous process stopped."
        : "Turn failed.";
  } catch {
    return status === "interrupted" ? "Turn was interrupted." : "Turn failed.";
  }
}

function count(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    throw new Error("Count query returned no row.");
  }
  return safeNumber((value as { count?: unknown }).count, "count");
}

function safeNumber(value: unknown, name: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${name} must be a safe non-negative integer.`);
  }
  return number;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be text or null.`);
  }
  return value;
}

function parseStoredJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${name} must be valid JSON.`, { cause: error });
  }
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, name: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

function timestamp(value: unknown, name: string): string {
  const result = requireString(value, name);
  if (Number.isNaN(Date.parse(result))) {
    throw new Error(`${name} must be a timestamp.`);
  }
  return result;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${name} has unsupported value ${JSON.stringify(value)}.`);
  }
  return value;
}

function boundedText(value: string): string {
  return value.length <= 4_000 ? value : `${value.slice(0, 4_000)}\n…`;
}
