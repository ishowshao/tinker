import { ContextBuilder } from "../agent/context-builder";
import type { ContextUsageSnapshot } from "../agent/context-meter";
import type { TurnId } from "../ids/runtime-id";
import type { ModelClient, PreparedModelRequest } from "../model/model-client";
import {
  promptPrefixFingerprint,
  type PromptPrefixFingerprint,
} from "../model/prompt-prefix-hash";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import { estimatePromptSegments } from "../model/token-estimator";
import type { ToolDefinition } from "../tools/types";
import { CompiledContextError } from "./compiled-context-validator";
import { ContextProtocolError } from "./context-protocol-validator";
import type {
  CompiledRevisionContext,
  ProspectiveSwapOverride,
} from "./context-revision";
import {
  ContextRevisionCompiler,
  ContextRevisionError,
} from "./context-revision-compiler";
import {
  ContextSwapRenderer,
  isSwappableRawResult,
  SwapRenderUnsupportedError,
  type SwappableRawKind,
} from "./context-swap-renderer";
import type {
  CanonicalMessageRecord,
  ProtocolContextView,
  ToolResultRecord,
} from "./protocol-frame";

export const shadowSwapPolicyV1 = Object.freeze({
  version: "shadow-swap-v1",
  minimumObservationBytes: 8 * 1_024,
  protectedRecentTurnCount: 8,
  targetInputRatio: 0.6,
} as const);

export type ShadowSwapPolicyV1 = typeof shadowSwapPolicyV1;
export type ShadowPlanningTrigger = "runtime_pressure" | "benchmark_forced";
export type ShadowPlanningOutcome =
  | "below_trigger"
  | "no_eligible_candidates"
  | "target_reached"
  | "insufficient_candidates";

export type ShadowRevisionPlan = {
  readonly version: 1;
  readonly policyVersion: "shadow-swap-v1";
  readonly planHash: string;
  readonly baseRevisionId: CompiledRevisionContext["revisionId"];
  readonly baseCanonicalThroughOrdinal: number;
  readonly basePrefixHash: string;
  readonly requestConfigHash: string;
  readonly toolSchemaHash: string;
  readonly selected: readonly ProspectiveSwapOverride[];
  readonly targetTokens: number;
  readonly rawTokensBefore: number;
  readonly rawTokensAfter: number;
  readonly guardedTokensBefore: number;
  readonly guardedTokensAfter: number;
  readonly projectedPrefixHash: string;
};

export type ShadowPlanningInput = {
  readonly active: CompiledRevisionContext;
  readonly canonical: ProtocolContextView;
  readonly activePrepared: PreparedModelRequest;
  readonly activeUsage: ContextUsageSnapshot;
  readonly tools: readonly ToolDefinition[];
  readonly policy: ShadowSwapPolicyV1;
  readonly trigger: ShadowPlanningTrigger;
  readonly forcedTargetTokens?: number;
};

export type ShadowPlanningResult = {
  readonly outcome: ShadowPlanningOutcome;
  readonly canonicalMessageCount: number;
  readonly eligibleCandidateCount: number;
  readonly excludedByReason: Readonly<Record<string, number>>;
  readonly selectedByRawKind: Readonly<Record<string, number>>;
  readonly originalObservationBytes: number;
  readonly projectedObservationBytes: number;
  readonly rawTokensBefore: number;
  readonly guardedTokensBefore: number;
  readonly targetTokens: number;
  readonly plan?: ShadowRevisionPlan;
};

export class ShadowPlanningDiagnosticError extends Error {
  constructor(
    readonly stage: "candidate" | "render" | "prepare" | "validate",
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ShadowPlanningDiagnosticError";
  }
}

export class ShadowPlanStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShadowPlanStaleError";
  }
}

type ModelPreparer = Pick<ModelClient, "prepare">;

type EligibleCandidate = {
  readonly override: ProspectiveSwapOverride;
  readonly rawKind: SwappableRawKind;
};

type CandidateScan = {
  readonly eligible: readonly EligibleCandidate[];
  readonly excludedByReason: Readonly<Record<string, number>>;
};

type Projection = {
  readonly count: number;
  readonly prepared: PreparedModelRequest;
  readonly rawTokens: number;
  readonly guardedTokens: number;
};

export class ShadowSwapPlanner {
  constructor(
    private readonly model: ModelPreparer,
    private readonly compiler = new ContextRevisionCompiler(),
    private readonly requestBuilder = new ContextBuilder(),
    private readonly renderer = new ContextSwapRenderer(),
  ) {}

  plan(input: ShadowPlanningInput): ShadowPlanningResult {
    validatePlanningInput(input);
    const activeFingerprint = promptPrefixFingerprint(input.activePrepared);
    assertActiveFingerprint(input, activeFingerprint);
    const rawTokensBefore = estimatePromptSegments(
      input.activePrepared.promptSegments,
    ).totalTokens;
    const guardedTokensBefore = guardTokens(
      rawTokensBefore,
      input.activeUsage.correctionFactor,
    );
    const targetTokens = planningTarget(input);

    if (
      (input.trigger === "runtime_pressure" &&
        input.activeUsage.pressure === "normal") ||
      guardedTokensBefore <= targetTokens
    ) {
      return emptyResult(
        input,
        "below_trigger",
        rawTokensBefore,
        guardedTokensBefore,
        targetTokens,
      );
    }

    const scan = this.scanCandidates(input.canonical, input.policy);
    if (scan.eligible.length === 0) {
      return {
        ...emptyResult(
          input,
          "no_eligible_candidates",
          rawTokensBefore,
          guardedTokensBefore,
          targetTokens,
        ),
        excludedByReason: scan.excludedByReason,
      };
    }

    const projectionCache = new Map<number, Projection>();
    const project = (count: number): Projection => {
      const existing = projectionCache.get(count);
      if (existing !== undefined) {
        return existing;
      }
      const selected = scan.eligible.slice(0, count).map((entry) => entry.override);
      let prepared: PreparedModelRequest;
      try {
        const compiled = this.compiler.compileProspective({
          active: input.active,
          canonical: input.canonical,
          overrides: selected,
        });
        const built = this.requestBuilder.build({
          canonical: input.canonical,
          compiled,
          tools: input.tools,
        });
        prepared = this.model.prepare(built.request);
      } catch (error) {
        if (isCanonicalPlanningError(error)) {
          throw error;
        }
        throw new ShadowPlanningDiagnosticError(
          "prepare",
          "prospective_prepare_failed",
          "Prospective request preparation failed.",
          { cause: error },
        );
      }
      assertProspectiveConfiguration(input.activePrepared, prepared);
      const rawTokens = estimatePromptSegments(prepared.promptSegments).totalTokens;
      const projection = Object.freeze({
        count,
        prepared,
        rawTokens,
        guardedTokens: guardTokens(rawTokens, input.activeUsage.correctionFactor),
      });
      projectionCache.set(count, projection);
      return projection;
    };

    let previousCount = 0;
    let count = 1;
    let reached: Projection | undefined;
    let last: Projection | undefined;
    while (true) {
      last = project(count);
      if (last.guardedTokens <= targetTokens) {
        reached = last;
        break;
      }
      if (count === scan.eligible.length) {
        break;
      }
      previousCount = count;
      count = Math.min(scan.eligible.length, count * 2);
    }

    if (last === undefined) {
      throw new ShadowPlanningDiagnosticError(
        "validate",
        "missing_projection",
        "Shadow planning produced no prospective projection.",
      );
    }

    let outcome: Extract<
      ShadowPlanningOutcome,
      "target_reached" | "insufficient_candidates"
    >;
    let finalProjection: Projection;
    if (reached === undefined) {
      outcome = "insufficient_candidates";
      finalProjection = last;
    } else {
      outcome = "target_reached";
      let low = previousCount + 1;
      let high = reached.count;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (project(middle).guardedTokens <= targetTokens) {
          high = middle;
        } else {
          low = middle + 1;
        }
      }
      finalProjection = project(low);
    }

    if (
      finalProjection.rawTokens >= rawTokensBefore ||
      finalProjection.guardedTokens >= guardedTokensBefore
    ) {
      throw new ShadowPlanningDiagnosticError(
        "validate",
        "no_token_reduction",
        "Prospective request did not strictly reduce raw and guarded tokens.",
      );
    }

    const selectedCandidates = scan.eligible.slice(0, finalProjection.count);
    const selected = Object.freeze(
      selectedCandidates.map((candidate) => candidate.override),
    );
    const projectedFingerprint = promptPrefixFingerprint(finalProjection.prepared);
    const plan = createPlan({
      input,
      activeFingerprint,
      projectedFingerprint,
      selected,
      targetTokens,
      rawTokensBefore,
      rawTokensAfter: finalProjection.rawTokens,
      guardedTokensBefore,
      guardedTokensAfter: finalProjection.guardedTokens,
    });
    assertPlanBaseCurrent(plan, {
      active: input.active,
      activePrepared: input.activePrepared,
    });

    return Object.freeze({
      outcome,
      canonicalMessageCount: input.canonical.messages.length,
      eligibleCandidateCount: scan.eligible.length,
      excludedByReason: scan.excludedByReason,
      selectedByRawKind: countRawKinds(selectedCandidates),
      originalObservationBytes: selected.reduce(
        (total, override) => total + override.originalBytes,
        0,
      ),
      projectedObservationBytes: selected.reduce(
        (total, override) => total + override.renderedBytes,
        0,
      ),
      rawTokensBefore,
      guardedTokensBefore,
      targetTokens,
      plan,
    });
  }

  private scanCandidates(
    canonical: ProtocolContextView,
    policy: ShadowSwapPolicyV1,
  ): CandidateScan {
    const closedFrames = new Set(
      canonical.frames
        .filter((frame) => frame.state === "closed")
        .map((frame) => frame.frameId),
    );
    const resultsByMessage = new Map(
      canonical.toolResults.map((result) => [result.toolMessageId, result] as const),
    );
    const protectedTurns = protectedRecentTurns(
      canonical,
      policy.protectedRecentTurnCount,
    );
    const eligible: EligibleCandidate[] = [];
    const exclusions = new Map<string, number>();

    for (const message of canonical.messages) {
      if (message.role !== "tool") {
        continue;
      }
      const reason = basicExclusionReason({
        message,
        result: resultsByMessage.get(message.messageId),
        closedFrames,
        protectedTurns,
        minimumObservationBytes: policy.minimumObservationBytes,
      });
      if (reason !== undefined) {
        increment(exclusions, reason);
        continue;
      }
      const result = resultsByMessage.get(message.messageId);
      if (result === undefined || result.completion.kind !== "returned") {
        throw new ContextRevisionError(
          "Eligible tool message is missing its canonical returned result.",
        );
      }
      if (!isSwappableRawResult(result.completion.raw)) {
        throw new ContextRevisionError(
          "Eligible tool message has an unexpected raw result kind.",
        );
      }
      try {
        eligible.push(
          Object.freeze({
            override: this.renderer.render({ message, result }),
            rawKind: result.completion.raw.kind,
          }),
        );
      } catch (error) {
        if (!(error instanceof SwapRenderUnsupportedError)) {
          throw new ShadowPlanningDiagnosticError(
            "render",
            "renderer_failed",
            "Swap placeholder rendering failed.",
            { cause: error },
          );
        }
        if (error.code === "source_hash_mismatch") {
          throw new ContextRevisionError(error.message);
        }
        increment(exclusions, error.code);
      }
    }

    eligible.sort(compareCandidates);
    return Object.freeze({
      eligible: Object.freeze(eligible),
      excludedByReason: frozenCountRecord(exclusions),
    });
  }
}

export function assertPlanBaseCurrent(
  plan: ShadowRevisionPlan,
  current: {
    readonly active: CompiledRevisionContext;
    readonly activePrepared: PreparedModelRequest;
  },
): void {
  const fingerprint = promptPrefixFingerprint(current.activePrepared);
  if (
    plan.baseRevisionId !== current.active.revisionId ||
    plan.baseCanonicalThroughOrdinal !== current.active.canonicalThroughOrdinal ||
    plan.basePrefixHash !== fingerprint.prefixHash ||
    plan.requestConfigHash !== fingerprint.requestConfigHash ||
    plan.toolSchemaHash !== fingerprint.toolSchemaHash
  ) {
    throw new ShadowPlanStaleError(
      "Shadow revision plan base no longer matches the active request.",
    );
  }
}

function validatePlanningInput(input: ShadowPlanningInput): void {
  if (input.policy.version !== "shadow-swap-v1") {
    throw new ShadowPlanningDiagnosticError(
      "validate",
      "unsupported_policy",
      "Shadow planning policy version is unsupported.",
    );
  }
  if (
    input.active.sessionId !== input.canonical.sessionId ||
    input.active.canonicalThroughOrdinal !== input.canonical.messages.length
  ) {
    throw new ContextRevisionError(
      "Active compiled context does not match canonical planning input.",
    );
  }
  if (
    input.forcedTargetTokens !== undefined &&
    (!Number.isSafeInteger(input.forcedTargetTokens) || input.forcedTargetTokens < 0)
  ) {
    throw new ShadowPlanningDiagnosticError(
      "validate",
      "invalid_target",
      "Forced shadow target must be a non-negative safe integer.",
    );
  }
}

function assertActiveFingerprint(
  input: ShadowPlanningInput,
  fingerprint: PromptPrefixFingerprint,
): void {
  if (
    input.activeUsage.prefixHash !== fingerprint.prefixHash ||
    input.activeUsage.requestConfigHash !== fingerprint.requestConfigHash ||
    input.activeUsage.toolSchemaHash !== fingerprint.toolSchemaHash
  ) {
    throw new ContextRevisionError(
      "Active usage fingerprint does not match the prepared request.",
    );
  }
}

function planningTarget(input: ShadowPlanningInput): number {
  if (input.trigger === "benchmark_forced") {
    if (input.forcedTargetTokens === undefined) {
      throw new ShadowPlanningDiagnosticError(
        "validate",
        "missing_forced_target",
        "Forced shadow planning requires an explicit target.",
      );
    }
    return input.forcedTargetTokens;
  }
  if (input.forcedTargetTokens !== undefined) {
    throw new ShadowPlanningDiagnosticError(
      "validate",
      "unexpected_forced_target",
      "Runtime pressure planning cannot override the policy target.",
    );
  }
  return Math.floor(
    input.activeUsage.inputBudgetTokens * input.policy.targetInputRatio,
  );
}

function emptyResult(
  input: ShadowPlanningInput,
  outcome: Extract<ShadowPlanningOutcome, "below_trigger" | "no_eligible_candidates">,
  rawTokensBefore: number,
  guardedTokensBefore: number,
  targetTokens: number,
): ShadowPlanningResult {
  return Object.freeze({
    outcome,
    canonicalMessageCount: input.canonical.messages.length,
    eligibleCandidateCount: 0,
    excludedByReason: Object.freeze({}),
    selectedByRawKind: Object.freeze({}),
    originalObservationBytes: 0,
    projectedObservationBytes: 0,
    rawTokensBefore,
    guardedTokensBefore,
    targetTokens,
  });
}

function basicExclusionReason(input: {
  message: Extract<CanonicalMessageRecord, { role: "tool" }>;
  result: ToolResultRecord | undefined;
  closedFrames: ReadonlySet<string>;
  protectedTurns: ReadonlySet<TurnId>;
  minimumObservationBytes: number;
}): string | undefined {
  if (!input.closedFrames.has(input.message.frameId)) {
    return "frame_not_closed";
  }
  if (input.result === undefined) {
    throw new ContextRevisionError(
      "Canonical tool message is missing its tool result.",
    );
  }
  if (input.result.completion.kind !== "returned") {
    return "synthetic_completion";
  }
  if (input.message.name === "Recall") {
    return "recall_tool";
  }
  if (input.protectedTurns.has(input.message.turnId)) {
    return "protected_recent_turn";
  }
  if (
    Buffer.byteLength(input.message.content, "utf8") < input.minimumObservationBytes
  ) {
    return "observation_too_small";
  }
  const raw = input.result.completion.raw;
  if (!isSwappableRawResult(raw)) {
    return "raw_kind_not_allowlisted";
  }
  if (
    (raw.kind === "bash" && raw.status === "running") ||
    (raw.kind === "task_output" &&
      (raw.status === "running" || raw.status === "stopping"))
  ) {
    return "running_task";
  }
  if (
    input.message.contentSha256 !== input.result.observationSha256 ||
    input.result.toolMessageId !== input.message.messageId
  ) {
    throw new ContextRevisionError(
      "Canonical tool result source or observation hash does not match.",
    );
  }
  return undefined;
}

function protectedRecentTurns(
  canonical: ProtocolContextView,
  count: number,
): ReadonlySet<TurnId> {
  const turns = new Set<TurnId>();
  for (let index = canonical.messages.length - 1; index >= 0; index -= 1) {
    const message = canonical.messages[index];
    if (message === undefined || message.role === "system") {
      continue;
    }
    turns.add(message.turnId);
    if (turns.size === count) {
      break;
    }
  }
  return turns;
}

function compareCandidates(left: EligibleCandidate, right: EligibleCandidate): number {
  return (
    right.override.byteSavings - left.override.byteSavings ||
    right.override.originalBytes - left.override.originalBytes ||
    left.override.ordinal - right.override.ordinal ||
    left.override.messageId.localeCompare(right.override.messageId)
  );
}

function assertProspectiveConfiguration(
  active: PreparedModelRequest,
  prospective: PreparedModelRequest,
): void {
  if (
    prospective.provider !== active.provider ||
    prospective.model !== active.model ||
    prospective.requestConfigHash !== active.requestConfigHash ||
    prospective.toolSchemaHash !== active.toolSchemaHash ||
    prospective.requestMaxOutputTokens !== active.requestMaxOutputTokens
  ) {
    throw new ShadowPlanningDiagnosticError(
      "validate",
      "prospective_configuration_changed",
      "Prospective request preparation changed its fixed configuration.",
    );
  }
}

function createPlan(input: {
  input: ShadowPlanningInput;
  activeFingerprint: PromptPrefixFingerprint;
  projectedFingerprint: PromptPrefixFingerprint;
  selected: readonly ProspectiveSwapOverride[];
  targetTokens: number;
  rawTokensBefore: number;
  rawTokensAfter: number;
  guardedTokensBefore: number;
  guardedTokensAfter: number;
}): ShadowRevisionPlan {
  const planningInput = input.input;
  const activeFingerprint = input.activeFingerprint;
  const projectedFingerprint = input.projectedFingerprint;
  const selected = input.selected;
  const targetTokens = input.targetTokens;
  const planIdentity = {
    version: 1,
    policyVersion: "shadow-swap-v1",
    baseRevisionId: planningInput.active.revisionId,
    baseCanonicalThroughOrdinal: planningInput.active.canonicalThroughOrdinal,
    basePrefixHash: activeFingerprint.prefixHash,
    requestConfigHash: activeFingerprint.requestConfigHash,
    toolSchemaHash: activeFingerprint.toolSchemaHash,
    selected: selected.map((override) => ({
      messageId: override.messageId,
      originalContentSha256: override.originalContentSha256,
      renderedContentSha256: override.renderedContentSha256,
    })),
    targetTokens,
  } as const;
  return Object.freeze({
    version: 1,
    policyVersion: "shadow-swap-v1",
    planHash: sha256(stableJsonStringify(planIdentity)),
    baseRevisionId: planningInput.active.revisionId,
    baseCanonicalThroughOrdinal: planningInput.active.canonicalThroughOrdinal,
    basePrefixHash: activeFingerprint.prefixHash,
    requestConfigHash: activeFingerprint.requestConfigHash,
    toolSchemaHash: activeFingerprint.toolSchemaHash,
    selected,
    targetTokens,
    rawTokensBefore: input.rawTokensBefore,
    rawTokensAfter: input.rawTokensAfter,
    guardedTokensBefore: input.guardedTokensBefore,
    guardedTokensAfter: input.guardedTokensAfter,
    projectedPrefixHash: projectedFingerprint.prefixHash,
  });
}

function countRawKinds(
  candidates: readonly EligibleCandidate[],
): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    increment(counts, candidate.rawKind);
  }
  return frozenCountRecord(counts);
}

function frozenCountRecord(
  counts: ReadonlyMap<string, number>,
): Readonly<Record<string, number>> {
  return Object.freeze(
    Object.fromEntries(
      [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function guardTokens(rawTokens: number, correctionFactor: number): number {
  return Math.ceil(rawTokens * correctionFactor);
}

function isCanonicalPlanningError(error: unknown): boolean {
  return (
    error instanceof ContextProtocolError ||
    error instanceof ContextRevisionError ||
    error instanceof CompiledContextError
  );
}
