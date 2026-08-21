import { ContextBuilder } from "../agent/context-builder";
import type { ContextUsageSnapshot } from "../agent/context-meter";
import type { TurnId } from "../ids/runtime-id";
import type { ModelClient, PreparedModelRequest } from "../model/model-client";
import {
  promptPrefixFingerprint,
  type PromptPrefixFingerprint,
} from "../model/prompt-prefix-hash";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import {
  estimatePromptSegments,
  guardedContextTokens,
  type RawContextBreakdown,
} from "../model/token-estimator";
import type { ToolDefinition } from "../tools/types";
import { activeOverrideManifestHash } from "./compiled-context-hash";
import { CompiledContextError } from "./compiled-context-validator";
import type { SwapOnlyPolicyV1 } from "./context-policy";
import { ContextProtocolError } from "./context-protocol-validator";
import type {
  BuiltContextRequest,
  CompiledRevisionContext,
  StoredContextRevisionV8,
  SwapOverride,
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

export type SwapPlanningTrigger = "manual" | "runtime_pressure" | "benchmark_forced";

export type SwapPlanningOutcome =
  | "below_trigger"
  | "below_target"
  | "no_eligible_candidates"
  | "target_reached"
  | "insufficient_candidates";

export type SwapRevisionPlan = {
  readonly version: 1;
  readonly policyVersion: "swap-only-v1";
  readonly baseRevisionId: CompiledRevisionContext["revisionId"];
  readonly baseRevisionNumber: number;
  readonly baseKeepFromOrdinal: number;
  readonly baseCanonicalThroughOrdinal: number;
  readonly baseActiveOverrideManifestSha256: string;
  readonly basePrefixHash: string;
  readonly requestConfigHash: string;
  readonly toolSchemaHash: string;
  readonly addedOverrides: readonly SwapOverride[];
  readonly nextActiveOverrideManifestSha256: string;
  readonly targetTokens: number;
  readonly rawTokensBefore: number;
  readonly rawTokensAfter: number;
  readonly guardedTokensBefore: number;
  readonly guardedTokensAfter: number;
  readonly projectedPrefixHash: string;
  readonly planHash: string;
};

export type SwapPlanningInput = {
  readonly active: CompiledRevisionContext;
  readonly revision: StoredContextRevisionV8;
  readonly surface: BuiltContextRequest["surface"];
  readonly activeOverrides: readonly SwapOverride[];
  readonly canonical: ProtocolContextView;
  readonly activePrepared: PreparedModelRequest;
  readonly activeUsage: ContextUsageSnapshot;
  readonly tools: readonly ToolDefinition[];
  readonly policy: SwapOnlyPolicyV1;
  readonly trigger: SwapPlanningTrigger;
  readonly activeTurn?: {
    readonly turnId: TurnId;
    readonly consumedThroughOrdinal: number;
  };
  readonly forcedTargetTokens?: number;
};

export type SwapPlanningResult = {
  readonly outcome: SwapPlanningOutcome;
  readonly canonicalMessageCount: number;
  readonly eligibleCandidateCount: number;
  readonly excludedByReason: Readonly<Record<string, number>>;
  readonly selectedByRawKind: Readonly<Record<string, number>>;
  readonly originalObservationBytes: number;
  readonly projectedObservationBytes: number;
  readonly rawTokensBefore: number;
  readonly guardedTokensBefore: number;
  readonly targetTokens: number;
  readonly plan?: SwapRevisionPlan;
};

export class SwapPlanningDiagnosticError extends Error {
  constructor(
    readonly stage: "candidate" | "render" | "prepare" | "validate",
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SwapPlanningDiagnosticError";
  }
}

export class SwapPlanStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapPlanStaleError";
  }
}

type ModelPreparer = Pick<ModelClient, "prepare">;

type EligibleCandidate = {
  readonly override: SwapOverride;
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

export class SwapPlanner {
  constructor(
    private readonly model: ModelPreparer,
    private readonly compiler = new ContextRevisionCompiler(),
    private readonly requestBuilder = new ContextBuilder(),
    private readonly renderer = new ContextSwapRenderer(),
  ) {}

  plan(input: SwapPlanningInput): SwapPlanningResult {
    validatePlanningInput(input);
    const activeFingerprint = promptPrefixFingerprint(input.activePrepared);
    assertActiveFingerprint(input, activeFingerprint);
    const activeBreakdown = estimatePromptSegments(input.activePrepared.promptSegments);
    const rawTokensBefore = activeBreakdown.totalTokens;
    const guardedTokensBefore = guardTokens(
      activeBreakdown,
      input.activeUsage.correctionFactor,
    );
    const targetTokens = planningTarget(input);

    if (
      input.trigger === "runtime_pressure" &&
      input.activeUsage.pressure === "normal"
    ) {
      return emptyResult(
        input,
        "below_trigger",
        rawTokensBefore,
        guardedTokensBefore,
        targetTokens,
      );
    }
    if (guardedTokensBefore <= targetTokens) {
      return emptyResult(
        input,
        input.trigger === "runtime_pressure" ? "below_trigger" : "below_target",
        rawTokensBefore,
        guardedTokensBefore,
        targetTokens,
      );
    }

    const scan = this.scanCandidates(
      input.canonical,
      input.activeOverrides,
      input.policy,
      input.revision.keepFromOrdinal,
      input.activeTurn,
    );
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
      const addedOverrides = scan.eligible
        .slice(0, count)
        .map((entry) => entry.override);
      let prepared: PreparedModelRequest;
      try {
        const compiled = this.compiler.compileProspective({
          active: input.active,
          canonical: input.canonical,
          activeOverrides: input.activeOverrides,
          addedOverrides,
          activeSurface: input.surface,
        });
        const built = this.requestBuilder.build({
          canonical: input.canonical,
          revision: input.revision,
          surface: input.surface,
          activeOverrides: [...input.activeOverrides, ...addedOverrides],
          compiled,
          tools: input.tools,
        });
        prepared = this.model.prepare(built.request);
      } catch (error) {
        if (isCanonicalPlanningError(error)) {
          throw error;
        }
        throw new SwapPlanningDiagnosticError(
          "prepare",
          "prospective_prepare_failed",
          "Prospective request preparation failed.",
          { cause: error },
        );
      }
      assertProspectiveConfiguration(input.activePrepared, prepared);
      const breakdown = estimatePromptSegments(prepared.promptSegments);
      const rawTokens = breakdown.totalTokens;
      const projection = Object.freeze({
        count,
        prepared,
        rawTokens,
        guardedTokens: guardTokens(breakdown, input.activeUsage.correctionFactor),
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
      throw new SwapPlanningDiagnosticError(
        "validate",
        "missing_projection",
        "Swap planning produced no prospective projection.",
      );
    }

    let outcome: Extract<
      SwapPlanningOutcome,
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
      throw new SwapPlanningDiagnosticError(
        "validate",
        "no_token_reduction",
        "Prospective request did not strictly reduce raw and guarded tokens.",
      );
    }

    const selectedCandidates = scan.eligible.slice(0, finalProjection.count);
    const addedOverrides = Object.freeze(
      selectedCandidates.map((candidate) => candidate.override),
    );
    const projectedFingerprint = promptPrefixFingerprint(finalProjection.prepared);
    const plan = createPlan({
      input,
      activeFingerprint,
      projectedFingerprint,
      addedOverrides,
      targetTokens,
      rawTokensBefore,
      rawTokensAfter: finalProjection.rawTokens,
      guardedTokensBefore,
      guardedTokensAfter: finalProjection.guardedTokens,
    });
    assertPlanBaseCurrent(plan, {
      active: input.active,
      revision: input.revision,
      activeOverrides: input.activeOverrides,
      activePrepared: input.activePrepared,
    });

    return Object.freeze({
      outcome,
      canonicalMessageCount: input.canonical.messages.length,
      eligibleCandidateCount: scan.eligible.length,
      excludedByReason: scan.excludedByReason,
      selectedByRawKind: countRawKinds(selectedCandidates),
      originalObservationBytes: addedOverrides.reduce(
        (total, override) => total + override.originalBytes,
        0,
      ),
      projectedObservationBytes: addedOverrides.reduce(
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
    activeOverrides: readonly SwapOverride[],
    policy: SwapOnlyPolicyV1,
    keepFromOrdinal: number,
    activeTurn: SwapPlanningInput["activeTurn"],
  ): CandidateScan {
    const alreadySwapped = new Set(
      activeOverrides.map((override) => override.messageId),
    );
    const closedFrames = new Set(
      canonical.frames
        .filter((frame) => frame.state === "closed")
        .map((frame) => frame.frameId),
    );
    const resultsByMessage = new Map(
      canonical.toolResults.map((result) => [result.toolMessageId, result] as const),
    );
    const eligible: EligibleCandidate[] = [];
    const exclusions = new Map<string, number>();

    for (const message of canonical.messages) {
      if (message.role !== "tool") {
        continue;
      }
      if (message.ordinal < keepFromOrdinal) {
        increment(exclusions, "retired_prefix");
        continue;
      }
      if (alreadySwapped.has(message.messageId)) {
        increment(exclusions, "already_swapped");
        continue;
      }
      const reason = basicExclusionReason({
        message,
        result: resultsByMessage.get(message.messageId),
        closedFrames,
        activeTurn,
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
          throw new SwapPlanningDiagnosticError(
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
  plan: SwapRevisionPlan,
  current: {
    readonly active: CompiledRevisionContext;
    readonly revision: StoredContextRevisionV8;
    readonly activeOverrides: readonly SwapOverride[];
    readonly activePrepared: PreparedModelRequest;
  },
): void {
  const fingerprint = promptPrefixFingerprint(current.activePrepared);
  if (
    plan.baseRevisionId !== current.active.revisionId ||
    plan.baseRevisionId !== current.revision.revisionId ||
    plan.baseRevisionNumber !== current.revision.revisionNumber ||
    plan.baseKeepFromOrdinal !== current.revision.keepFromOrdinal ||
    plan.baseCanonicalThroughOrdinal !== current.active.canonicalThroughOrdinal ||
    plan.baseActiveOverrideManifestSha256 !==
      activeOverrideManifestHash(current.activeOverrides) ||
    plan.basePrefixHash !== fingerprint.prefixHash ||
    plan.requestConfigHash !== fingerprint.requestConfigHash ||
    plan.toolSchemaHash !== fingerprint.toolSchemaHash
  ) {
    throw new SwapPlanStaleError(
      "Swap revision plan base no longer matches the active request.",
    );
  }
}

function validatePlanningInput(input: SwapPlanningInput): void {
  if (input.policy.version !== "swap-only-v1") {
    throw new SwapPlanningDiagnosticError(
      "validate",
      "unsupported_policy",
      "Swap planning policy version is unsupported.",
    );
  }
  if (
    input.active.sessionId !== input.canonical.sessionId ||
    input.revision.sessionId !== input.canonical.sessionId ||
    input.revision.revisionId !== input.active.revisionId ||
    input.revision.keepFromOrdinal !== input.active.manifest.keepFromOrdinal ||
    input.active.canonicalThroughOrdinal !== input.canonical.messages.length ||
    input.revision.activeOverrideManifestSha256 !==
      activeOverrideManifestHash(input.activeOverrides)
  ) {
    throw new ContextRevisionError(
      "Active revision does not match canonical planning input.",
    );
  }
  if (
    input.activeOverrides.some(
      (override) => override.ordinal < input.revision.keepFromOrdinal,
    )
  ) {
    throw new ContextRevisionError(
      "Active swap planning input contains a retired override.",
    );
  }
  if (input.activeTurn !== undefined) {
    const activeMessages = input.canonical.messages.filter(
      (message) =>
        message.role !== "system" && message.turnId === input.activeTurn?.turnId,
    );
    if (
      activeMessages.length === 0 ||
      !Number.isSafeInteger(input.activeTurn.consumedThroughOrdinal) ||
      input.activeTurn.consumedThroughOrdinal < 1 ||
      input.activeTurn.consumedThroughOrdinal > input.canonical.messages.length
    ) {
      throw new ContextRevisionError("Active-turn swap boundary is invalid.");
    }
  }
  if (
    input.forcedTargetTokens !== undefined &&
    (!Number.isSafeInteger(input.forcedTargetTokens) || input.forcedTargetTokens < 0)
  ) {
    throw new SwapPlanningDiagnosticError(
      "validate",
      "invalid_target",
      "Forced swap target must be a non-negative safe integer.",
    );
  }
}

function assertActiveFingerprint(
  input: SwapPlanningInput,
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

function planningTarget(input: SwapPlanningInput): number {
  if (input.trigger === "benchmark_forced") {
    if (input.forcedTargetTokens === undefined) {
      throw new SwapPlanningDiagnosticError(
        "validate",
        "missing_forced_target",
        "Forced swap planning requires an explicit target.",
      );
    }
    return input.forcedTargetTokens;
  }
  if (input.forcedTargetTokens !== undefined) {
    throw new SwapPlanningDiagnosticError(
      "validate",
      "unexpected_forced_target",
      "Only benchmark-forced planning accepts an explicit target.",
    );
  }
  return Math.floor(
    input.activeUsage.inputBudgetTokens * input.policy.targetInputRatio,
  );
}

function emptyResult(
  input: SwapPlanningInput,
  outcome: Extract<
    SwapPlanningOutcome,
    "below_trigger" | "below_target" | "no_eligible_candidates"
  >,
  rawTokensBefore: number,
  guardedTokensBefore: number,
  targetTokens: number,
): SwapPlanningResult {
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
  activeTurn: SwapPlanningInput["activeTurn"];
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
  if (
    input.message.name === "Recall" ||
    input.message.name === "RecallSearch" ||
    input.message.name === "RecallGet"
  ) {
    return "recall_tool";
  }
  if (
    input.activeTurn !== undefined &&
    input.message.turnId === input.activeTurn.turnId &&
    input.message.ordinal > input.activeTurn.consumedThroughOrdinal
  ) {
    return "active_turn_unconsumed";
  }
  const raw = input.result.completion.raw;
  if (!isSwappableRawResult(raw)) {
    return "raw_kind_not_allowlisted";
  }
  if (
    raw.kind !== "view_image" &&
    Buffer.byteLength(input.message.displayText, "utf8") < input.minimumObservationBytes
  ) {
    return "observation_too_small";
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
    throw new SwapPlanningDiagnosticError(
      "validate",
      "prospective_configuration_changed",
      "Prospective request preparation changed its fixed configuration.",
    );
  }
}

function createPlan(input: {
  input: SwapPlanningInput;
  activeFingerprint: PromptPrefixFingerprint;
  projectedFingerprint: PromptPrefixFingerprint;
  addedOverrides: readonly SwapOverride[];
  targetTokens: number;
  rawTokensBefore: number;
  rawTokensAfter: number;
  guardedTokensBefore: number;
  guardedTokensAfter: number;
}): SwapRevisionPlan {
  const planningInput = input.input;
  const nextActiveOverrideManifestSha256 = activeOverrideManifestHash([
    ...planningInput.activeOverrides,
    ...input.addedOverrides,
  ]);
  const planIdentity = {
    version: 1,
    policyVersion: "swap-only-v1",
    baseRevisionId: planningInput.active.revisionId,
    baseRevisionNumber: planningInput.revision.revisionNumber,
    baseKeepFromOrdinal: planningInput.revision.keepFromOrdinal,
    baseCanonicalThroughOrdinal: planningInput.active.canonicalThroughOrdinal,
    baseActiveOverrideManifestSha256:
      planningInput.revision.activeOverrideManifestSha256,
    basePrefixHash: input.activeFingerprint.prefixHash,
    requestConfigHash: input.activeFingerprint.requestConfigHash,
    toolSchemaHash: input.activeFingerprint.toolSchemaHash,
    addedOverrides: input.addedOverrides.map((override) => ({
      messageId: override.messageId,
      originalContentSha256: override.originalContentSha256,
      renderedContentSha256: override.renderedContentSha256,
    })),
    nextActiveOverrideManifestSha256,
    targetTokens: input.targetTokens,
    projectedPrefixHash: input.projectedFingerprint.prefixHash,
  } as const;
  return Object.freeze({
    ...planIdentity,
    planHash: sha256(stableJsonStringify(planIdentity)),
    addedOverrides: input.addedOverrides,
    rawTokensBefore: input.rawTokensBefore,
    rawTokensAfter: input.rawTokensAfter,
    guardedTokensBefore: input.guardedTokensBefore,
    guardedTokensAfter: input.guardedTokensAfter,
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

function guardTokens(breakdown: RawContextBreakdown, correctionFactor: number): number {
  return guardedContextTokens(breakdown, correctionFactor);
}

function isCanonicalPlanningError(error: unknown): boolean {
  return (
    error instanceof ContextProtocolError ||
    error instanceof ContextRevisionError ||
    error instanceof CompiledContextError
  );
}
