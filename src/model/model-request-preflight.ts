import { createHash } from "node:crypto";
import type { ModelContextBudget } from "./model-context-profile";

export type ContextUsageSource =
  | "estimated_full"
  | "provider_measured"
  | "measured_plus_estimated_delta";

export type ContextPressure = "normal" | "triggered" | "blocked";

export class ContextBudgetExceededError extends Error {
  readonly projectedInputTokens: number;
  readonly inputBudgetTokens: number;
  readonly triggerTokens: number;
  readonly source: ContextUsageSource;

  constructor(
    input: {
      projectedInputTokens: number;
      source: ContextUsageSource;
    } & Pick<
      ModelContextBudget,
      | "contextWindowTokens"
      | "inputBudgetTokens"
      | "requestMaxOutputTokens"
      | "triggerTokens"
    >,
  ) {
    super(
      `Model request blocked before provider call: projected input ${formatTokenCount(input.projectedInputTokens)} exceeds Tinker input budget ${formatTokenCount(input.inputBudgetTokens)} (model window ${formatTokenCount(input.contextWindowTokens)}, reserved output ${formatTokenCount(input.requestMaxOutputTokens)}).`,
    );
    this.name = "ContextBudgetExceededError";
    this.projectedInputTokens = input.projectedInputTokens;
    this.inputBudgetTokens = input.inputBudgetTokens;
    this.triggerTokens = input.triggerTokens;
    this.source = input.source;
  }
}

export function contextPressure(
  usedInputTokens: number,
  budget: Pick<ModelContextBudget, "inputBudgetTokens" | "triggerTokens">,
): ContextPressure {
  if (usedInputTokens > budget.inputBudgetTokens) {
    return "blocked";
  }
  return usedInputTokens >= budget.triggerTokens ? "triggered" : "normal";
}

export function assertContextBudget(
  input: {
    usedInputTokens: number;
    source: ContextUsageSource;
  } & Pick<
    ModelContextBudget,
    | "contextWindowTokens"
    | "inputBudgetTokens"
    | "requestMaxOutputTokens"
    | "triggerTokens"
  >,
): void {
  if (input.usedInputTokens <= input.inputBudgetTokens) {
    return;
  }
  throw new ContextBudgetExceededError({
    projectedInputTokens: input.usedInputTokens,
    source: input.source,
    contextWindowTokens: input.contextWindowTokens,
    inputBudgetTokens: input.inputBudgetTokens,
    requestMaxOutputTokens: input.requestMaxOutputTokens,
    triggerTokens: input.triggerTokens,
  });
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot serialize a non-finite JSON number: ${value}.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalJsonValue(entry));
  }
  if (typeof value !== "object" || value === undefined) {
    throw new Error(`Cannot serialize non-JSON value of type ${typeof value}.`);
  }

  const record = value as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry !== undefined) {
      canonical[key] = canonicalJsonValue(entry);
    }
  }
  return canonical;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function formatTokenCount(tokens: number): string {
  const million = 1_024 * 1_024;
  if (tokens >= million && tokens % million === 0) {
    return `${tokens / million}M`;
  }
  if (tokens >= 1_024 && tokens % 1_024 === 0) {
    return `${tokens / 1_024}K`;
  }
  return tokens.toLocaleString("en-US");
}
