import {
  ACTIVE_RECALL_GRADER_VERSION,
  ACTIVE_RECALL_MANIFEST_HASH,
  ACTIVE_RECALL_MANIFEST_VERSION,
  activeRecallCases,
  type ActiveRecallCase,
  type ActiveRecallView,
} from "./i4-active-recall-manifest";
import { sha256, stableJsonStringify } from "../src/model/model-request-preflight";
import { renderRecallRetirementContract } from "../src/context/recall-retirement-contract";
import { RECALL_TOOL_DEFINITION } from "../src/tools/recall";
import {
  I4_ACTIVE_RECALL_FIXTURE_V1,
  I4ActiveRecallReport,
  I4ActiveRecallTrial,
} from "./bench-i4-active-recall";

const QUALIFIED_PROFILE = "deepseek-v4-flash";
const POSITIVE_VIEWS = Object.freeze([
  "full_history",
  "swap_only",
  "recall_only_retirement",
] as const);
const NEGATIVE_VIEWS = Object.freeze(["recall_only_retirement"] as const);

export const ACTIVE_RECALL_QUALIFICATION_POLICY_V1 = Object.freeze({
  version: "active-recall-qualification-policy-v1",
  holdoutTrialsPerView: 3,
  minimumFullHistoryTaskSuccessRate: 0.95,
  minimumSwapOnlyTaskSuccessRate: 0.95,
  minimumRecallOnlyTaskSuccessRate: 0.9,
  minimumRecallOnlyActiveRecallRate: 0.9,
  minimumRecallOnlySearchGetSuccessRate: 0.3,
  minimumCounterfactualGroupTaskSuccessRate: 2 / 3,
  maximumInvalidRecallCallsPerRecallOnlyTrial: 0.2,
  maximumNegativeUnnecessaryRecallRate: 1 / 3,
  maximumRecallOnlyTokenRatioToFullHistory: 3,
  maximumRecallOnlyLatencyRatioToFullHistory: 3,
  requireCacheAccounting: true,
  requireSingleResolvedModel: true,
} as const);

export const ACTIVE_RECALL_QUALIFICATION_POLICY_SHA256 = sha256(
  stableJsonStringify(ACTIVE_RECALL_QUALIFICATION_POLICY_V1),
);

export type ActiveRecallQualificationGate = {
  readonly name: string;
  readonly passed: boolean;
  readonly actual: number | string | readonly string[];
  readonly requirement: string;
};

export type ActiveRecallQualificationResult = {
  readonly policyVersion: typeof ACTIVE_RECALL_QUALIFICATION_POLICY_V1.version;
  readonly passed: boolean;
  readonly resolvedModels: readonly string[];
  readonly gates: readonly ActiveRecallQualificationGate[];
  readonly metrics: {
    readonly fullHistoryTaskSuccessRate: number;
    readonly swapOnlyTaskSuccessRate: number;
    readonly recallOnlyTaskSuccessRate: number;
    readonly recallOnlyActiveRecallRate: number;
    readonly recallOnlySearchGetSuccessRate: number;
    readonly minimumCounterfactualGroupTaskSuccessRate: number;
    readonly invalidRecallCallsPerRecallOnlyTrial: number;
    readonly negativeUnnecessaryRecallRate: number;
    readonly recallOnlyTokenRatioToFullHistory: number;
    readonly recallOnlyLatencyRatioToFullHistory: number;
  };
};

export function evaluateActiveRecallQualification(
  positive: I4ActiveRecallReport,
  negative: I4ActiveRecallReport,
): ActiveRecallQualificationResult {
  assertComparableReports(positive, negative);
  const fullHistory = positive.trials.filter((trial) => trial.view === "full_history");
  const swapOnly = positive.trials.filter((trial) => trial.view === "swap_only");
  const recallOnly = positive.trials.filter(
    (trial) => trial.view === "recall_only_retirement",
  );
  const negativeRecallOnly = negative.trials.filter(
    (trial) => trial.view === "recall_only_retirement",
  );
  requireFormalShape(
    positive,
    negative,
    fullHistory,
    swapOnly,
    recallOnly,
    negativeRecallOnly,
  );

  const fullHistoryTaskSuccessRate = successRate(fullHistory);
  const swapOnlyTaskSuccessRate = successRate(swapOnly);
  const recallOnlyTaskSuccessRate = successRate(recallOnly);
  const recallOnlyActiveRecallRate = rate(
    recallOnly,
    (trial) => trial.recall.callCount > 0,
  );
  const recallOnlySearchGetSuccessRate = rate(
    recallOnly,
    (trial) =>
      trial.recall.successfulSearchCount > 0 && trial.recall.successfulGetCount > 0,
  );
  const minimumCounterfactualGroupTaskSuccessRate = Math.min(
    ...counterfactualGroupRates(recallOnly),
  );
  const invalidRecallCallsPerRecallOnlyTrial =
    recallOnly.reduce((sum, trial) => sum + trial.recall.invalidCallCount, 0) /
    recallOnly.length;
  const negativeUnnecessaryRecallRate = rate(
    negativeRecallOnly,
    (trial) => trial.recall.callCount > 0,
  );
  const recallOnlyTokenRatioToFullHistory =
    average(recallOnly, (trial) => trial.provider.usage.totalTokens) /
    average(fullHistory, (trial) => trial.provider.usage.totalTokens);
  const recallOnlyLatencyRatioToFullHistory =
    average(recallOnly, (trial) => trial.provider.latencyMs) /
    average(fullHistory, (trial) => trial.provider.latencyMs);
  const resolvedModels = Object.freeze(
    [
      ...new Set(
        [...positive.trials, ...negative.trials].flatMap(
          (trial) => trial.provider.resolvedModels,
        ),
      ),
    ].sort(),
  );
  const cacheAccountingComplete = [...positive.trials, ...negative.trials].every(
    (trial) =>
      trial.provider.usage.promptCacheHitTokens !== undefined &&
      trial.provider.usage.promptCacheMissTokens !== undefined,
  );
  const policy = ACTIVE_RECALL_QUALIFICATION_POLICY_V1;
  const gates: ActiveRecallQualificationGate[] = [
    minimumGate(
      "full_history_task_success",
      fullHistoryTaskSuccessRate,
      policy.minimumFullHistoryTaskSuccessRate,
    ),
    minimumGate(
      "swap_only_task_success",
      swapOnlyTaskSuccessRate,
      policy.minimumSwapOnlyTaskSuccessRate,
    ),
    minimumGate(
      "recall_only_task_success",
      recallOnlyTaskSuccessRate,
      policy.minimumRecallOnlyTaskSuccessRate,
    ),
    minimumGate(
      "recall_only_active_recall",
      recallOnlyActiveRecallRate,
      policy.minimumRecallOnlyActiveRecallRate,
    ),
    minimumGate(
      "recall_only_search_get_success",
      recallOnlySearchGetSuccessRate,
      policy.minimumRecallOnlySearchGetSuccessRate,
    ),
    minimumGate(
      "counterfactual_group_task_success",
      minimumCounterfactualGroupTaskSuccessRate,
      policy.minimumCounterfactualGroupTaskSuccessRate,
    ),
    maximumGate(
      "invalid_recall_calls_per_recall_only_trial",
      invalidRecallCallsPerRecallOnlyTrial,
      policy.maximumInvalidRecallCallsPerRecallOnlyTrial,
    ),
    maximumGate(
      "negative_unnecessary_recall",
      negativeUnnecessaryRecallRate,
      policy.maximumNegativeUnnecessaryRecallRate,
    ),
    maximumGate(
      "recall_only_token_ratio",
      recallOnlyTokenRatioToFullHistory,
      policy.maximumRecallOnlyTokenRatioToFullHistory,
    ),
    maximumGate(
      "recall_only_latency_ratio",
      recallOnlyLatencyRatioToFullHistory,
      policy.maximumRecallOnlyLatencyRatioToFullHistory,
    ),
    {
      name: "cache_accounting",
      passed: cacheAccountingComplete,
      actual: cacheAccountingComplete ? "complete" : "missing",
      requirement: "all provider trials report cache hit and miss tokens",
    },
    {
      name: "resolved_model_identity",
      passed: resolvedModels.length === 1,
      actual: resolvedModels,
      requirement: "exactly one resolved model across all provider requests",
    },
  ];
  return Object.freeze({
    policyVersion: policy.version,
    passed: gates.every((gate) => gate.passed),
    resolvedModels,
    gates: Object.freeze(gates),
    metrics: Object.freeze({
      fullHistoryTaskSuccessRate: round(fullHistoryTaskSuccessRate),
      swapOnlyTaskSuccessRate: round(swapOnlyTaskSuccessRate),
      recallOnlyTaskSuccessRate: round(recallOnlyTaskSuccessRate),
      recallOnlyActiveRecallRate: round(recallOnlyActiveRecallRate),
      recallOnlySearchGetSuccessRate: round(recallOnlySearchGetSuccessRate),
      minimumCounterfactualGroupTaskSuccessRate: round(
        minimumCounterfactualGroupTaskSuccessRate,
      ),
      invalidRecallCallsPerRecallOnlyTrial: round(invalidRecallCallsPerRecallOnlyTrial),
      negativeUnnecessaryRecallRate: round(negativeUnnecessaryRecallRate),
      recallOnlyTokenRatioToFullHistory: round(recallOnlyTokenRatioToFullHistory),
      recallOnlyLatencyRatioToFullHistory: round(recallOnlyLatencyRatioToFullHistory),
    }),
  });
}

function assertComparableReports(
  positive: I4ActiveRecallReport,
  negative: I4ActiveRecallReport,
): void {
  if (positive.suite !== "holdout" || negative.suite !== "holdout") {
    throw new Error("I4 qualification requires holdout reports.");
  }
  const fields = [
    "manifestVersion",
    "manifestHash",
    "graderVersion",
    "recallContractSha256",
    "recallToolDefinitionSha256",
    "profile",
    "model",
    "stream",
  ] as const;
  for (const field of fields) {
    if (positive[field] !== negative[field]) {
      throw new Error(`I4 holdout reports disagree on ${field}.`);
    }
  }
  if (positive.graderVersion !== ACTIVE_RECALL_GRADER_VERSION) {
    throw new Error("I4 holdout report uses an unknown grader version.");
  }
  if (
    positive.manifestVersion !== ACTIVE_RECALL_MANIFEST_VERSION ||
    positive.manifestHash !== ACTIVE_RECALL_MANIFEST_HASH
  ) {
    throw new Error("I4 holdout report does not match the frozen manifest.");
  }
  if (
    positive.profile !== QUALIFIED_PROFILE ||
    positive.model !== QUALIFIED_PROFILE ||
    positive.stream !== true
  ) {
    throw new Error("I4 holdout report does not use the qualified streaming profile.");
  }
  if (
    positive.recallContractSha256 !== sha256(renderRecallRetirementContract()) ||
    positive.recallToolDefinitionSha256 !==
      sha256(stableJsonStringify(RECALL_TOOL_DEFINITION))
  ) {
    throw new Error("I4 holdout report does not match the current Recall surface.");
  }
  if (
    positive.fixture.version !== I4_ACTIVE_RECALL_FIXTURE_V1.version ||
    positive.fixture.turnCount !== I4_ACTIVE_RECALL_FIXTURE_V1.turnCount ||
    positive.fixture.payloadBytes !== I4_ACTIVE_RECALL_FIXTURE_V1.payloadBytes ||
    negative.fixture.version !== I4_ACTIVE_RECALL_FIXTURE_V1.version ||
    negative.fixture.turnCount !== I4_ACTIVE_RECALL_FIXTURE_V1.turnCount ||
    negative.fixture.payloadBytes !== I4_ACTIVE_RECALL_FIXTURE_V1.payloadBytes
  ) {
    throw new Error(
      "I4 holdout report does not match the frozen long-session fixture.",
    );
  }
}

function requireFormalShape(
  positive: I4ActiveRecallReport,
  negative: I4ActiveRecallReport,
  fullHistory: readonly I4ActiveRecallTrial[],
  swapOnly: readonly I4ActiveRecallTrial[],
  recallOnly: readonly I4ActiveRecallTrial[],
  negativeRecallOnly: readonly I4ActiveRecallTrial[],
): void {
  const trials = ACTIVE_RECALL_QUALIFICATION_POLICY_V1.holdoutTrialsPerView;
  if (positive.run.trialsPerView !== trials || negative.run.trialsPerView !== trials) {
    throw new Error(`I4 qualification requires exactly ${trials} trials per view.`);
  }
  const positiveCases = activeRecallCases("holdout");
  const negativeCases = activeRecallCases("holdout", { includeNegative: true }).filter(
    (entry) => !entry.positive,
  );
  if (
    positive.run.includeNegative ||
    !sameStrings(positive.run.views, POSITIVE_VIEWS) ||
    !sameStrings(
      positive.run.caseIds,
      positiveCases.map((entry) => entry.id),
    )
  ) {
    throw new Error("I4 positive holdout report does not contain the frozen shape.");
  }
  if (
    !negative.run.includeNegative ||
    !sameStrings(negative.run.views, NEGATIVE_VIEWS) ||
    !sameStrings(
      negative.run.caseIds,
      negativeCases.map((entry) => entry.id),
    )
  ) {
    throw new Error("I4 negative holdout report does not contain the frozen shape.");
  }
  assertTrialMatrix(positive.trials, positiveCases, POSITIVE_VIEWS, trials);
  assertTrialMatrix(negative.trials, negativeCases, NEGATIVE_VIEWS, trials);
  const expectedPerPositiveView = positiveCases.length * trials;
  if (
    fullHistory.length !== expectedPerPositiveView ||
    swapOnly.length !== expectedPerPositiveView ||
    recallOnly.length !== expectedPerPositiveView ||
    negativeRecallOnly.length !== negativeCases.length * trials
  ) {
    throw new Error("I4 holdout report trial counts do not match the frozen matrix.");
  }
}

function assertTrialMatrix(
  trials: readonly I4ActiveRecallTrial[],
  cases: readonly ActiveRecallCase[],
  views: readonly ActiveRecallView[],
  trialsPerView: number,
): void {
  const casesById = new Map(cases.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  for (const trial of trials) {
    const entry = casesById.get(trial.caseId);
    const key = `${trial.caseId}\u0000${trial.view}\u0000${trial.trial}`;
    if (
      entry === undefined ||
      !views.includes(trial.view) ||
      !Number.isSafeInteger(trial.trial) ||
      trial.trial < 1 ||
      trial.trial > trialsPerView ||
      trial.scenario !== entry.scenario ||
      trial.counterfactualGroup !== entry.counterfactualGroup ||
      trial.positive !== entry.positive ||
      trial.provider.requestCount < 1 ||
      trial.provider.resolvedModels.length !== 1 ||
      seen.has(key)
    ) {
      throw new Error(`I4 holdout trial matrix is invalid at ${trial.caseId}.`);
    }
    seen.add(key);
  }
  if (seen.size !== cases.length * views.length * trialsPerView) {
    throw new Error("I4 holdout trial matrix is incomplete.");
  }
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function counterfactualGroupRates(
  trials: readonly I4ActiveRecallTrial[],
): readonly number[] {
  const groups = new Map<string, I4ActiveRecallTrial[]>();
  for (const trial of trials) {
    if (trial.counterfactualGroup === undefined) {
      throw new Error(`I4 positive case ${trial.caseId} has no counterfactual group.`);
    }
    groups.set(trial.counterfactualGroup, [
      ...(groups.get(trial.counterfactualGroup) ?? []),
      trial,
    ]);
  }
  if (groups.size !== 5) {
    throw new Error("I4 holdout must contain five counterfactual groups.");
  }
  return [...groups.values()].map(successRate);
}

function successRate(trials: readonly I4ActiveRecallTrial[]): number {
  return rate(trials, (trial) => trial.task.passed);
}

function rate<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  if (values.length === 0) throw new Error("I4 qualification metric is empty.");
  return values.filter(predicate).length / values.length;
}

function average<T>(values: readonly T[], select: (value: T) => number): number {
  if (values.length === 0) throw new Error("I4 qualification metric is empty.");
  return values.reduce((sum, value) => sum + select(value), 0) / values.length;
}

function minimumGate(
  name: string,
  actual: number,
  minimum: number,
): ActiveRecallQualificationGate {
  return Object.freeze({
    name,
    passed: actual >= minimum,
    actual: round(actual),
    requirement: `>= ${round(minimum)}`,
  });
}

function maximumGate(
  name: string,
  actual: number,
  maximum: number,
): ActiveRecallQualificationGate {
  return Object.freeze({
    name,
    passed: actual <= maximum,
    actual: round(actual),
    requirement: `<= ${round(maximum)}`,
  });
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
