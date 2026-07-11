export type TuiProjectionPolicy = Readonly<{
  recentTurnLimit: number;
  itemLimitPerTurn: number;
  sessionNoticeLimit: number;
  completedTaskLimit: number;
}>;

export const defaultTuiProjectionPolicy: TuiProjectionPolicy = Object.freeze({
  recentTurnLimit: 8,
  itemLimitPerTurn: 40,
  sessionNoticeLimit: 12,
  completedTaskLimit: 12,
});

export function validateTuiProjectionPolicy(
  policy: TuiProjectionPolicy,
): TuiProjectionPolicy {
  requireNonNegativeInteger(policy.recentTurnLimit, "recentTurnLimit");
  requireMinimumInteger(policy.itemLimitPerTurn, 2, "itemLimitPerTurn");
  requireNonNegativeInteger(policy.sessionNoticeLimit, "sessionNoticeLimit");
  requireNonNegativeInteger(policy.completedTaskLimit, "completedTaskLimit");
  return policy;
}

function requireMinimumInteger(value: number, minimum: number, name: string): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`TUI projection ${name} must be at least ${minimum}.`);
  }
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`TUI projection ${name} must be a non-negative integer.`);
  }
}
