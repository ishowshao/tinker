import type { ContextUsageSnapshot } from "./context-meter";

export const CONTEXT_PRESSURE_NOTICE_PREFIX = "[tinker context notice]";

export function isContextPressureNotice(message: {
  readonly role: string;
  readonly content?: unknown;
}): boolean {
  return (
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(CONTEXT_PRESSURE_NOTICE_PREFIX)
  );
}

export function contextPressureNoticeText(input: {
  usage: ContextUsageSnapshot;
  toolPressure: "high" | "critical";
  automaticSwapEnabled: boolean;
}): string {
  const base =
    `${CONTEXT_PRESSURE_NOTICE_PREFIX} Input pressure is now "${input.toolPressure}" ` +
    `(${input.usage.usedInputTokens} of ${input.usage.inputBudgetTokens} input tokens; ` +
    `trigger at ${input.usage.triggerTokens}). ` +
    "Call ContextSwapCandidates to review evictable historical tool observations, " +
    "then ContextSwap to replace them with Recall-backed placeholders; " +
    "swapped content stays recoverable through RecallGet.";
  if (!input.automaticSwapEnabled) {
    return (
      `${base} Automatic compaction is disabled in this session, so pressure will ` +
      "keep growing unless you swap observations or the turn ends."
    );
  }
  return input.toolPressure === "critical"
    ? `${base} Automatic compaction is running immediately because pressure exceeded the input budget.`
    : `${base} Automatic compaction will resume next iteration if you do not act.`;
}
