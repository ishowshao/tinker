import { sha256, stableJsonStringify } from "../src/model/model-request-preflight";

export const ACTIVE_RECALL_MANIFEST_VERSION = "active-recall-manifest-v1";
export const ACTIVE_RECALL_GRADER_VERSION = "active-recall-deterministic-grader-v1";

export type ActiveRecallSuiteName = "calibration" | "holdout";

export type ActiveRecallView = "full_history" | "swap_only" | "recall_only_retirement";

export type ActiveRecallScenario =
  | "explicit_reference"
  | "implicit_dependency"
  | "lexical_rewrite"
  | "prior_failure"
  | "historical_current"
  | "negative_self_contained"
  | "negative_current_file"
  | "negative_prompt_fact";

export type ActiveRecallOracle =
  | {
      readonly kind: "json_string";
      readonly key: string;
      readonly value: string;
    }
  | {
      readonly kind: "json_record";
      readonly value: Readonly<Record<string, string | number>>;
    };

export type ActiveRecallCase = {
  readonly id: string;
  readonly suite: ActiveRecallSuiteName;
  readonly scenario: ActiveRecallScenario;
  readonly counterfactualGroup?: string;
  readonly positive: boolean;
  readonly earlyPrompt: string;
  readonly terminalPrompt: string;
  readonly oracle: ActiveRecallOracle;
  readonly currentFiles?: Readonly<Record<string, string>>;
  readonly expectedHistoricalValue?: string;
};

export type ActiveRecallGrade = {
  readonly passed: boolean;
  readonly code: "passed" | "not_json_object" | "wrong_keys" | "wrong_value";
};

const positiveCases = Object.freeze([
  ...counterfactualPair({
    suite: "calibration",
    group: "cal-explicit-atlas-channel",
    scenario: "explicit_reference",
    subject: "Project Atlas Gate",
    factLabel: "deployment channel",
    values: ["cobalt-17", "cobalt-29"],
    terminalPrompt:
      'Earlier in this session we set the deployment channel for Project Atlas Gate. Recover it from session history if necessary. Return only one JSON object with exactly one string field named "answer".',
  }),
  ...counterfactualPair({
    suite: "calibration",
    group: "cal-implicit-ember-serialization",
    scenario: "implicit_dependency",
    subject: "artifact ember-export",
    factLabel: "binding release serialization",
    values: ["JSONL", "YAML"],
    terminalPrompt:
      'Prepare the release-plan decision for artifact ember-export using the serialization requirement established in this session. Return only one JSON object with exactly one string field named "answer", whose value is that serialization format.',
  }),
  ...counterfactualPair({
    suite: "calibration",
    group: "cal-rewrite-profile-store",
    scenario: "lexical_rewrite",
    subject: "profile-store persistence",
    factLabel: "crash-safe save sequence",
    values: ["temp-write->fsync->rename", "journal-write->fsync->replace"],
    terminalPrompt:
      'What power-loss-safe save sequence did we establish for profile-store persistence? Return only one JSON object with exactly one string field named "answer". Preserve the operation order and arrow separators from the established rule.',
  }),
  ...counterfactualPair({
    suite: "calibration",
    group: "cal-failure-beta-command",
    scenario: "prior_failure",
    subject: "flaky suite beta in CI",
    factLabel: "approved rerun command after the no-TTY failure",
    values: [
      "bun test src/__tests__/beta.test.ts",
      "bun test src/__tests__/beta-retry.test.ts",
    ],
    terminalPrompt:
      'We are about to rerun flaky suite beta in CI. Use the exact approved command from this session, not the earlier no-TTY approach. Return only one JSON object with exactly one string field named "answer".',
  }),
  ...historicalCurrentPair({
    suite: "calibration",
    group: "cal-version-settings",
    path: "config/settings.toml",
    historicalValues: ["schema-v4-coral", "schema-v5-indigo"],
    currentValue: "schema-v7-amber",
    terminalPrompt:
      'Compare the historical and current schema labels for config/settings.toml. Read the current file and recover the historical label from this session when necessary. Return only one JSON object with exactly the two string fields "historical" and "current".',
  }),
  ...counterfactualPair({
    suite: "holdout",
    group: "hold-explicit-lighthouse-rollback",
    scenario: "explicit_reference",
    subject: "Lighthouse rollout",
    factLabel: "rollback group",
    values: ["harbor-22", "harbor-31"],
    terminalPrompt:
      'Earlier in this session we chose the rollback group for the Lighthouse rollout. Recover that choice from session history if necessary. Return only one JSON object with exactly one string field named "answer".',
  }),
  ...counterfactualPair({
    suite: "holdout",
    group: "hold-implicit-quartz-checksum",
    scenario: "implicit_dependency",
    subject: "artifact quartz-index",
    factLabel: "required release checksum",
    values: ["BLAKE3", "SHA-256"],
    terminalPrompt:
      'Prepare the release-plan decision for artifact quartz-index using the checksum requirement established in this session. Return only one JSON object with exactly one string field named "answer", whose value is that checksum algorithm.',
  }),
  ...counterfactualPair({
    suite: "holdout",
    group: "hold-rewrite-token-cache",
    scenario: "lexical_rewrite",
    subject: "token-cache eviction",
    factLabel: "reader-safe cleanup sequence",
    values: [
      "mark-stale->drain-readers->delete",
      "freeze-entry->drain-readers->unlink",
    ],
    terminalPrompt:
      'What concurrency-safe cleanup sequence did we establish for token-cache eviction? Return only one JSON object with exactly one string field named "answer". Preserve the operation order and arrow separators from the established rule.',
  }),
  ...counterfactualPair({
    suite: "holdout",
    group: "hold-failure-gamma-command",
    scenario: "prior_failure",
    subject: "integration suite gamma on the build host",
    factLabel: "approved rerun command after the interactive-mode failure",
    values: [
      "bun test src/__tests__/gamma.test.ts",
      "bun test src/__tests__/gamma-retry.test.ts",
    ],
    terminalPrompt:
      'We are about to rerun integration suite gamma on the build host. Use the exact approved command from this session, not the failed interactive approach. Return only one JSON object with exactly one string field named "answer".',
  }),
  ...historicalCurrentPair({
    suite: "holdout",
    group: "hold-version-worker",
    path: "services/worker.ini",
    historicalValues: ["workers-v3-saffron", "workers-v5-umber"],
    currentValue: "workers-v8-cerulean",
    terminalPrompt:
      'Compare the historical and current worker labels for services/worker.ini. Read the current file and recover the historical label from this session when necessary. Return only one JSON object with exactly the two string fields "historical" and "current".',
  }),
]);

const negativeCases = Object.freeze([
  ...negativeSuiteCases("calibration", "cal"),
  ...negativeSuiteCases("holdout", "hold"),
]);

export const ACTIVE_RECALL_CASES: readonly ActiveRecallCase[] = Object.freeze([
  ...positiveCases,
  ...negativeCases,
]);

export const ACTIVE_RECALL_MANIFEST_HASH = sha256(
  stableJsonStringify({
    version: ACTIVE_RECALL_MANIFEST_VERSION,
    cases: ACTIVE_RECALL_CASES,
  }),
);

export function activeRecallCases(
  suite: ActiveRecallSuiteName,
  options: { includeNegative?: boolean } = {},
): readonly ActiveRecallCase[] {
  return ACTIVE_RECALL_CASES.filter(
    (entry) =>
      entry.suite === suite && (options.includeNegative === true || entry.positive),
  );
}

export function gradeActiveRecallAnswer(
  text: string,
  oracle: ActiveRecallOracle,
): ActiveRecallGrade {
  const candidates = jsonObjectCandidates(text);
  if (candidates.length !== 1) {
    return { passed: false, code: "not_json_object" };
  }
  const parsed = candidates[0];
  if (!isRecord(parsed)) {
    return { passed: false, code: "not_json_object" };
  }

  const expected =
    oracle.kind === "json_string" ? { [oracle.key]: oracle.value } : oracle.value;
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(parsed).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    return { passed: false, code: "wrong_keys" };
  }
  if (expectedKeys.some((key) => parsed[key] !== expected[key])) {
    return { passed: false, code: "wrong_value" };
  }
  return { passed: true, code: "passed" };
}

function counterfactualPair(input: {
  suite: ActiveRecallSuiteName;
  group: string;
  scenario: Extract<
    ActiveRecallScenario,
    "explicit_reference" | "implicit_dependency" | "lexical_rewrite" | "prior_failure"
  >;
  subject: string;
  factLabel: string;
  values: readonly [string, string];
  terminalPrompt: string;
}): readonly ActiveRecallCase[] {
  return input.values.map((value, index) =>
    Object.freeze({
      id: `${input.group}-${index === 0 ? "a" : "b"}`,
      suite: input.suite,
      scenario: input.scenario,
      counterfactualGroup: input.group,
      positive: true,
      earlyPrompt: `${input.subject}: ${input.factLabel} is ${JSON.stringify(value)}. This is a binding session decision.`,
      terminalPrompt: input.terminalPrompt,
      oracle: Object.freeze({
        kind: "json_string" as const,
        key: "answer",
        value,
      }),
      expectedHistoricalValue: value,
    }),
  );
}

function historicalCurrentPair(input: {
  suite: ActiveRecallSuiteName;
  group: string;
  path: string;
  historicalValues: readonly [string, string];
  currentValue: string;
  terminalPrompt: string;
}): readonly ActiveRecallCase[] {
  return input.historicalValues.map((historical, index) =>
    Object.freeze({
      id: `${input.group}-${index === 0 ? "a" : "b"}`,
      suite: input.suite,
      scenario: "historical_current" as const,
      counterfactualGroup: input.group,
      positive: true,
      earlyPrompt: `Before migration, ${input.path} used the historical label ${JSON.stringify(historical)}. Treat this as the immutable historical version, not the current file state.`,
      terminalPrompt: input.terminalPrompt,
      oracle: Object.freeze({
        kind: "json_record" as const,
        value: Object.freeze({ historical, current: input.currentValue }),
      }),
      currentFiles: Object.freeze({
        [input.path]: `label=${input.currentValue}\n`,
      }),
      expectedHistoricalValue: historical,
    }),
  );
}

function negativeSuiteCases(
  suite: ActiveRecallSuiteName,
  prefix: string,
): readonly ActiveRecallCase[] {
  return [
    Object.freeze({
      id: `${prefix}-negative-self-contained`,
      suite,
      scenario: "negative_self_contained" as const,
      positive: false,
      earlyPrompt:
        "Fixture history for the negative control. No fact from this message is needed by the terminal task.",
      terminalPrompt:
        'Compute 19 + 23. Return only one JSON object with exactly one numeric field named "answer".',
      oracle: Object.freeze({
        kind: "json_record" as const,
        value: Object.freeze({ answer: 42 }),
      }),
    }),
    Object.freeze({
      id: `${prefix}-negative-current-file`,
      suite,
      scenario: "negative_current_file" as const,
      positive: false,
      earlyPrompt:
        "Fixture history for the current-file negative control. The terminal task must use the current workspace file.",
      terminalPrompt:
        'Read current/status.txt and return its current value. Return only one JSON object with exactly one string field named "answer".',
      oracle: Object.freeze({
        kind: "json_string" as const,
        key: "answer",
        value: `${prefix}-current-green`,
      }),
      currentFiles: Object.freeze({
        "current/status.txt": `${prefix}-current-green\n`,
      }),
    }),
    Object.freeze({
      id: `${prefix}-negative-prompt-fact`,
      suite,
      scenario: "negative_prompt_fact" as const,
      positive: false,
      earlyPrompt:
        "Fixture history for the prompt-fact negative control. The terminal task includes everything needed.",
      terminalPrompt: `The one-time verification token is ${prefix}-prompt-violet. Return only one JSON object with exactly one string field named "answer" containing that token.`,
      oracle: Object.freeze({
        kind: "json_string" as const,
        key: "answer",
        value: `${prefix}-prompt-violet`,
      }),
    }),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObjectCandidates(text: string): readonly unknown[] {
  const trimmed = text.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? [parsed] : [];
  } catch {
    // The v1 oracle is deliberately flat, so bounded object extraction remains
    // deterministic while accepting a Markdown fence or short explanatory text.
  }
  return [...trimmed.matchAll(/\{[^{}]*\}/gu)].flatMap((match) => {
    try {
      const parsed: unknown = JSON.parse(match[0]);
      return isRecord(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}
