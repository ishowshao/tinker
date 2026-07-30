import type { ContextUsageSnapshot } from "../agent/context-meter";
import type { ModelUsage } from "../model/model-client";

export function formatLatestProviderCacheRate(
  usage: ModelUsage | undefined,
): string | undefined {
  const hit = usage?.promptCacheHitTokens;
  const miss = usage?.promptCacheMissTokens;
  if (hit === undefined || miss === undefined || hit + miss === 0) {
    return undefined;
  }
  // Floor instead of round: an append turn is never a true 100% hit, and
  // rounding would display 99.5%+ as a misleading "cache 100%". A genuine
  // full hit (miss === 0, e.g. an identical resent request) still floors to
  // exactly 100. The min() guards against float rounding when miss > 0.
  const percent = Math.min(99, Math.floor((hit / (hit + miss)) * 100));
  return `cache ${miss === 0 ? 100 : percent}%`;
}

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
