export const swapOnlyPolicyV1 = Object.freeze({
  version: "swap-only-v1",
  minimumObservationBytes: 8 * 1_024,
  protectedRecentTurnCount: 8,
  targetInputRatio: 0.6,
} as const);

export type SwapOnlyPolicyV1 = typeof swapOnlyPolicyV1;
