export const swapOnlyPolicyV1 = Object.freeze({
  version: "swap-only-v1",
  minimumObservationBytes: 8 * 1_024,
  protectedRecentTurnCount: 8,
  targetInputRatio: 0.6,
} as const);

export type SwapOnlyPolicyV1 = typeof swapOnlyPolicyV1;

export const recallFirstRetirementPolicyV1 = Object.freeze({
  version: "recall-first-retirement-v1",
  protectedRecentTurnCount: 8,
  targetInputRatio: 0.6,
} as const);

export type RecallFirstRetirementPolicyV1 = typeof recallFirstRetirementPolicyV1;
