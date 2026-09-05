import { describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import { renderRecallRetirementContract } from "../context/recall-retirement-contract";
import { qualifyI4ActiveRecall } from "../../scripts/qualify-i4-active-recall";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import { RECALL_TOOL_DEFINITIONS } from "../tools/recall";
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
import {
  evaluateActiveRecallQualification,
  ACTIVE_RECALL_QUALIFICATION_POLICY_SHA256,
} from "../../scripts/i4-active-recall-policy";

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

  test("has unique case ids and preserves the frozen manifest", () => {
    expect(new Set(ACTIVE_RECALL_CASES.map((entry) => entry.id)).size).toBe(
      ACTIVE_RECALL_CASES.length,
    );
    expect(ACTIVE_RECALL_MANIFEST_HASH).toBe(
      "093679e221e02b71ba5acf54693faa7a299d05dd25f6faabbeb84645d4db4d2d",
    );
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

  test("preserves the frozen qualification policy", () => {
    expect(ACTIVE_RECALL_QUALIFICATION_POLICY_SHA256).toBe(
      "77ca611594d4e9b7b5a597a3a33e35fcaaffae284dc2ac9953ce9a63cce1c009",
    );
  });

  test.each([
    "recallContractSha256",
    "recallToolDefinitionSha256",
  ] as const)("rejects reports with an outdated %s", (field) => {
    const staleSurface = { [field]: sha256("outdated Recall surface") };
    const positive = { ...qualificationReport(true), ...staleSurface };
    const negative = { ...qualificationReport(false), ...staleSurface };
    expect(() => evaluateActiveRecallQualification(positive, negative)).toThrow(
      "does not match the current Recall surface",
    );
  });

  test.each([
    true,
    false,
  ])("writes evaluation-only v2 reports when passed=%s", async (passed) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-evaluation-only-"));
    try {
      const positive = qualificationReport(true);
      const negative = qualificationReport(false);
      const report = passed
        ? positive
        : {
            ...positive,
            trials: positive.trials.map((trial) => ({
              ...trial,
              task: { passed: false, code: "wrong_value" as const },
            })),
          };
      const positiveReportPath = path.join(root, "positive.json");
      const negativeReportPath = path.join(root, "negative.json");
      const outputPath = path.join(root, "evaluation.json");
      await writeFile(positiveReportPath, JSON.stringify(report));
      await writeFile(negativeReportPath, JSON.stringify(negative));
      const result = await qualifyI4ActiveRecall({
        positiveReportPath,
        negativeReportPath,
        outputPath,
      });
      expect(result.schemaVersion).toBe("active-recall-qualification-v2");
      expect(result.passed).toBe(passed);
      expect(result).not.toHaveProperty("automaticSwapOnly");
      expect(result).not.toHaveProperty("automaticSwap");
      expect(result).not.toHaveProperty("automaticPrefixRetirement");
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    recallContractSha256: sha256(renderRecallRetirementContract()),
    // Synthetic trials exercise the policy against the current tool surface.
    recallToolDefinitionSha256: sha256(stableJsonStringify(RECALL_TOOL_DEFINITIONS)),
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
