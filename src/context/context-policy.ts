export const swapOnlyPolicyV1 = Object.freeze({
  version: "swap-only-v1",
  minimumObservationBytes: 2 * 1_024,
  targetInputRatio: 0.3,
} as const);

export type SwapOnlyPolicyV1 = typeof swapOnlyPolicyV1;

export const recallFirstRetirementPolicyV1 = Object.freeze({
  version: "recall-first-retirement-v1",
  targetInputRatio: 0.3,
} as const);

export type RecallFirstRetirementPolicyV1 = typeof recallFirstRetirementPolicyV1;
