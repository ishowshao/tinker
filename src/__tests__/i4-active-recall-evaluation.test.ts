import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { I4_ACTIVE_RECALL_QUALIFICATION } from "../context/context-automation-policy";
import { sha256 } from "../model/model-request-preflight";
import {
  ACTIVE_RECALL_CASES,
  ACTIVE_RECALL_MANIFEST_HASH,
  activeRecallCases,
  gradeActiveRecallAnswer,
} from "../../scripts/i4-active-recall-manifest";
import type {
  I4ActiveRecallReport,
  I4ActiveRecallTrial,
} from "../../scripts/bench-i4-active-recall";
import { evaluateActiveRecallQualification } from "../../scripts/i4-active-recall-policy";

describe("I4 active Recall evaluation manifest", () => {
  test("covers five positive scenarios with counterfactual pairs in each suite", () => {
    for (const suite of ["calibration", "holdout"] as const) {
      const cases = activeRecallCases(suite);
      expect(cases).toHaveLength(10);
      expect(new Set(cases.map((entry) => entry.scenario))).toEqual(
        new Set([
          "explicit_reference",
          "implicit_dependency",
          "lexical_rewrite",
          "prior_failure",
          "historical_current",
        ]),
      );
      const groups = new Map<string, (typeof cases)[number][]>();
      for (const entry of cases) {
        const group = entry.counterfactualGroup ?? "missing";
        groups.set(group, [...(groups.get(group) ?? []), entry]);
      }
      expect(groups.size).toBe(5);
      for (const group of groups.values()) expect(group).toHaveLength(2);
    }
  });

  test("adds three negative controls per suite only when requested", () => {
    for (const suite of ["calibration", "holdout"] as const) {
      expect(activeRecallCases(suite)).toHaveLength(10);
      const withNegative = activeRecallCases(suite, { includeNegative: true });
      expect(withNegative).toHaveLength(13);
      expect(withNegative.filter((entry) => !entry.positive)).toHaveLength(3);
    }
  });

  test("has unique case ids and a stable sha256 manifest identity", () => {
    expect(new Set(ACTIVE_RECALL_CASES.map((entry) => entry.id)).size).toBe(
      ACTIVE_RECALL_CASES.length,
    );
    expect(ACTIVE_RECALL_MANIFEST_HASH).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("I4 active Recall deterministic grader", () => {
  test("accepts exactly matching JSON without depending on another model", () => {
    expect(
      gradeActiveRecallAnswer('{"answer":"cobalt-17"}', {
        kind: "json_string",
        key: "answer",
        value: "cobalt-17",
      }),
    ).toEqual({ passed: true, code: "passed" });
    expect(
      gradeActiveRecallAnswer(
        'Recovered value:\n```json\n{"answer":"cobalt-17"}\n```',
        {
          kind: "json_string",
          key: "answer",
          value: "cobalt-17",
        },
      ),
    ).toEqual({ passed: true, code: "passed" });
    expect(
      gradeActiveRecallAnswer('{"current":"v7","historical":"v4"}', {
        kind: "json_record",
        value: { historical: "v4", current: "v7" },
      }),
    ).toEqual({ passed: true, code: "passed" });
  });

  test("distinguishes malformed, extra-key, and wrong-value failures", () => {
    const oracle = {
      kind: "json_string" as const,
      key: "answer",
      value: "expected",
    };
    expect(gradeActiveRecallAnswer("answer=expected", oracle).code).toBe(
      "not_json_object",
    );
    expect(
      gradeActiveRecallAnswer('{"answer":"expected","note":"extra"}', oracle).code,
    ).toBe("wrong_keys");
    expect(gradeActiveRecallAnswer('{"answer":"other"}', oracle).code).toBe(
      "wrong_value",
    );
    expect(
      gradeActiveRecallAnswer('{"answer":"expected"}\n{"answer":"expected"}', oracle)
        .code,
    ).toBe("not_json_object");
  });
});

describe("I4 active Recall qualification policy", () => {
  test("passes the frozen holdout shape and rejects a quality regression", () => {
    const positive = qualificationReport(true);
    const negative = qualificationReport(false);
    expect(evaluateActiveRecallQualification(positive, negative).passed).toBe(true);

    let degradedCount = 0;
    const degradedTrials = positive.trials.map((trial) => {
      if (trial.view !== "recall_only_retirement" || degradedCount >= 4) {
        return trial;
      }
      degradedCount += 1;
      return {
        ...trial,
        task: { passed: false, code: "wrong_value" as const },
      };
    });
    const degraded = { ...positive, trials: degradedTrials };
    const result = evaluateActiveRecallQualification(degraded, negative);
    expect(result.passed).toBe(false);
    expect(
      result.gates.find((gate) => gate.name === "recall_only_task_success")?.passed,
    ).toBe(false);

    const wrongMatrix = {
      ...positive,
      trials: positive.trials.map((trial, index) =>
        index === 0 ? { ...trial, caseId: "hold-unlisted-case" } : trial,
      ),
    };
    expect(() => evaluateActiveRecallQualification(wrongMatrix, negative)).toThrow(
      "trial matrix is invalid",
    );
  });

  test("keeps the compiled floor gate bound to the checked-in holdout reports", () => {
    const positive = readFixture(
      "docs/context-revision-i4-holdout-deepseek-v4-flash.json",
    );
    const negative = readFixture(
      "docs/context-revision-i4-holdout-negative-deepseek-v4-flash.json",
    );
    const qualification = JSON.parse(
      readFixture("docs/context-revision-i4-qualification-deepseek-v4-flash.json"),
    ) as Record<string, unknown>;
    expect(sha256(positive)).toBe(I4_ACTIVE_RECALL_QUALIFICATION.positiveReportSha256);
    expect(sha256(negative)).toBe(I4_ACTIVE_RECALL_QUALIFICATION.negativeReportSha256);
    expect(qualification.passed).toBe(true);
    expect(qualification.policySha256).toBe(
      I4_ACTIVE_RECALL_QUALIFICATION.policySha256,
    );
    expect(qualification.manifestSha256).toBe(
      I4_ACTIVE_RECALL_QUALIFICATION.manifestSha256,
    );
  });
});

function qualificationReport(positive: boolean): I4ActiveRecallReport {
  const cases = activeRecallCases("holdout", { includeNegative: true }).filter(
    (entry) => entry.positive === positive,
  );
  const views = positive
    ? (["full_history", "swap_only", "recall_only_retirement"] as const)
    : (["recall_only_retirement"] as const);
  const trials: I4ActiveRecallTrial[] = [];
  for (const entry of cases) {
    for (const view of views) {
      for (let trial = 1; trial <= 3; trial += 1) {
        const recalls = positive && view === "recall_only_retirement";
        trials.push({
          caseId: entry.id,
          scenario: entry.scenario,
          ...(entry.counterfactualGroup === undefined
            ? {}
            : { counterfactualGroup: entry.counterfactualGroup }),
          positive,
          view,
          trial,
          task: { passed: true, code: "passed" },
          recall: {
            callCount: recalls ? 2 : 0,
            searchCount: recalls ? 1 : 0,
            getCount: recalls ? 1 : 0,
            successfulSearchCount: recalls ? 1 : 0,
            successfulGetCount: recalls ? 1 : 0,
            searchFoundTurnOne: recalls,
            gotTurnOne: recalls,
            invalidCallCount: 0,
            queries: recalls ? ["anchor"] : [],
            searchHitTurnNumbers: recalls ? [1] : [],
            getTurnNumbers: recalls ? [1] : [],
          },
          tools: {
            callCount: recalls ? 2 : 0,
            nonRecallCallCount: 0,
          },
          provider: {
            requestCount: recalls ? 3 : 1,
            latencyMs: recalls ? 200 : 100,
            usage: {
              promptTokens: recalls ? 180 : 90,
              completionTokens: 10,
              totalTokens: recalls ? 190 : 100,
              promptCacheHitTokens: 50,
              promptCacheMissTokens: recalls ? 130 : 40,
            },
            resolvedModels: ["deepseek-v4-flash"],
          },
          revision: {},
          payload: {},
        });
      }
    }
  }
  return {
    schemaVersion: "active-recall-report-v1",
    createdAt: "2026-07-18T00:00:00.000Z",
    suite: "holdout",
    manifestVersion: "active-recall-manifest-v1",
    manifestHash: ACTIVE_RECALL_MANIFEST_HASH,
    graderVersion: "active-recall-deterministic-grader-v1",
    recallContractSha256: I4_ACTIVE_RECALL_QUALIFICATION.recallContractSha256,
    recallToolDefinitionSha256:
      I4_ACTIVE_RECALL_QUALIFICATION.recallToolDefinitionSha256,
    profile: "deepseek-v4-flash",
    model: "deepseek-v4-flash",
    stream: true,
    fixture: {
      version: "active-recall-long-session-fixture-v1",
      turnCount: 10,
      payloadBytes: 12 * 1_024,
    },
    run: {
      views,
      trialsPerView: 3,
      includeNegative: !positive,
      caseIds: cases.map((entry) => entry.id),
    },
    aggregate: aggregateForTest(trials),
    trials,
  };
}

function aggregateForTest(trials: readonly I4ActiveRecallTrial[]) {
  const positives = trials.filter((trial) => trial.positive);
  const negatives = trials.filter((trial) => !trial.positive);
  return {
    trialCount: trials.length,
    positiveTrialCount: positives.length,
    negativeTrialCount: negatives.length,
    taskSuccessRate: positives.length === 0 ? undefined : 1,
    fullHistoryTaskSuccessRate: positives.length === 0 ? undefined : 1,
    swapOnlyTaskSuccessRate: positives.length === 0 ? undefined : 1,
    recallOnlyTaskSuccessRate: positives.length === 0 ? undefined : 1,
    recallOnlyActiveRecallRate: positives.length === 0 ? undefined : 1,
    recallOnlySearchGetSuccessRate: positives.length === 0 ? undefined : 1,
    recallOnlyCorrectSourceRate: positives.length === 0 ? undefined : 1,
    unnecessaryRecallRate: negatives.length === 0 ? undefined : 0,
    invalidRecallCallCount: 0,
    providerRequestCount: trials.length,
    providerLatencyMs: trials.length * 100,
    providerUsage: {
      promptTokens: trials.length * 90,
      completionTokens: trials.length * 10,
      totalTokens: trials.length * 100,
      promptCacheHitTokens: trials.length * 50,
      promptCacheMissTokens: trials.length * 40,
    },
  };
}

function readFixture(relativePath: string): string {
  return readFileSync(path.resolve(import.meta.dir, "../..", relativePath), "utf8");
}
