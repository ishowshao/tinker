import type { ContextUsageSnapshot } from "../agent/context-meter";

export function formatContextUsageLine(
  usage: Pick<
    ContextUsageSnapshot,
    "usedInputTokens" | "inputBudgetTokens" | "pressure"
  >,
): string {
  const percent = Math.round((usage.usedInputTokens / usage.inputBudgetTokens) * 100);
  return `context ${formatTokenCount(usage.usedInputTokens)} / ${formatTokenCount(usage.inputBudgetTokens)} (${percent}% used${usage.pressure === "blocked" ? ", blocked" : ""})`;
}

export function formatTokenCount(tokens: number): string {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error(`Invalid token count: ${tokens}`);
  }
  const unit = tokens >= 1_024 * 1_024 ? 1_024 * 1_024 : 1_024;
  if (tokens < unit) {
    return String(tokens);
  }
  const value = tokens / unit;
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${formatted}${unit === 1_024 ? "K" : "M"}`;
}
