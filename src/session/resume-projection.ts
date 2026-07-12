import path from "node:path";
import { realpath } from "node:fs/promises";
import { Database } from "bun:sqlite";
import type { SessionId } from "../ids/runtime-id";
import {
  assertMatchingContextBudget,
  createModelContextProfile,
  type ModelContextBudget,
  type ModelContextProfile,
} from "../model/model-context-profile";
import type {
  TimelineItem,
  TuiProjectionState,
  TuiTurnProjection,
} from "../tui/event-store";
import {
  defaultTuiProjectionPolicy,
  type TuiProjectionPolicy,
  validateTuiProjectionPolicy,
} from "../tui/tui-projection-policy";
import { SessionError } from "./session-errors";
import { verifySessionSchema } from "./session-schema";

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
      const context = decodeContextContract(meta.runtime_contract_json);
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

function decodeContextContract(value: unknown): {
  profile: ModelContextProfile;
  budget: ModelContextBudget;
} {
  if (typeof value !== "string") {
    throw new Error("Session runtime contract is missing.");
  }
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Session runtime contract must be an object.");
  }
  const record = parsed as Record<string, unknown>;
  const profileRecord = objectValue(record.contextProfile, "contextProfile");
  const budgetRecord = objectValue(record.contextBudget, "contextBudget");
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
  const budget: ModelContextBudget = {
    contextWindowTokens: positiveInteger(
      budgetRecord.contextWindowTokens,
      "budget.contextWindowTokens",
    ),
    maxSupportedOutputTokens: positiveInteger(
      budgetRecord.maxSupportedOutputTokens,
      "budget.maxSupportedOutputTokens",
    ),
    requestMaxOutputTokens: positiveInteger(
      budgetRecord.requestMaxOutputTokens,
      "requestMaxOutputTokens",
    ),
    inputBudgetTokens: positiveInteger(
      budgetRecord.inputBudgetTokens,
      "inputBudgetTokens",
    ),
    triggerRatio: 0.8,
    triggerTokens: positiveInteger(budgetRecord.triggerTokens, "triggerTokens"),
  };
  if (budgetRecord.triggerRatio !== 0.8) {
    throw new Error("Session context triggerRatio must be 0.8.");
  }
  assertMatchingContextBudget(profile, budget);
  return { profile, budget };
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
  const allItems: TimelineItem[] = [];
  for (const message of messages) {
    const role = requireString(message.role, "message role");
    const ordinal = safeNumber(message.ordinal, "ordinal");
    const messageId = requireString(message.message_id, "message_id");
    const content = typeof message.content === "string" ? message.content : "";
    if (role === "user") {
      allItems.push({
        id: `resume-${messageId}`,
        label: "prompt",
        text: boundedText(content),
        status: "text",
      });
    } else if (role === "assistant" && content.trim() !== "") {
      allItems.push({
        id: `resume-${messageId}`,
        label: "assistant",
        text: boundedText(content),
        status: "text",
      });
    } else if (role === "tool") {
      const origin = requireString(message.origin, "tool origin");
      allItems.push({
        id: `resume-${messageId}`,
        label: requireString(message.name, "tool name"),
        text: boundedText(content),
        status:
          origin === "runtime" && content.toLowerCase().includes("failed")
            ? "failed"
            : origin === "runtime"
              ? "cancelled"
              : "ok",
        ref: `ordinal-${ordinal}`,
      });
    }
  }

  if (status === "failed" || status === "interrupted") {
    const detail = terminalDetail(row.terminal_detail_json, status);
    allItems.push({
      id: `resume-${turnId}-terminal`,
      label: status === "interrupted" ? "interrupted" : "error",
      text: detail,
      status: "failed",
    });
  } else if (status === "cancelled") {
    allItems.push({
      id: `resume-${turnId}-terminal`,
      label: "cancelled",
      text: "Turn was cancelled.",
      status: "cancelled",
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

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value as number;
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
