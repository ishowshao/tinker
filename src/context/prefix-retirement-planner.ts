import type { ContextUsageSnapshot } from "../agent/context-meter";
import { ContextBuilder } from "../agent/context-builder";
import type { TurnId } from "../ids/runtime-id";
import type { ModelClient, PreparedModelRequest } from "../model/model-client";
import {
  promptPrefixFingerprint,
  type PromptPrefixFingerprint,
} from "../model/prompt-prefix-hash";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import { estimatePromptSegments } from "../model/token-estimator";
import type { ToolDefinition } from "../tools/types";
import {
  activeOverrideManifestHash,
  canonicalSequenceHash,
  renderedMessageHash,
} from "./compiled-context-hash";
import type { RecallFirstRetirementPolicyV1 } from "./context-policy";
import type {
  CompiledRevisionContext,
  StoredContextRevisionV7,
  SwapOverride,
} from "./context-revision";
import type { StoredContextSurfaceV7 } from "./context-surface";
import {
  ContextRevisionCompiler,
  ContextRevisionError,
} from "./context-revision-compiler";
import { CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION } from "./recall-retirement-contract";
import type { ProtocolContextView } from "./protocol-frame";

export type ClosedTurnBoundary = {
  readonly turnId: TurnId;
  readonly turnNumber: number;
  readonly status: "completed" | "failed" | "cancelled" | "interrupted";
  readonly firstOrdinal: number;
  readonly lastOrdinal: number;
  readonly frameCount: number;
  readonly messageCount: number;
};

export type PrefixRetirementPlanningTrigger = "manual" | "benchmark_forced";

export type PrefixRetirementPlan = {
  readonly policyVersion: "recall-first-retirement-v1";
  readonly trigger: PrefixRetirementPlanningTrigger;
  readonly baseRevisionId: CompiledRevisionContext["revisionId"];
  readonly baseRevisionNumber: number;
  readonly baseKeepFromOrdinal: number;
  readonly baseCanonicalThroughOrdinal: number;
  readonly baseSurfaceSha256: string;
  readonly baseActiveOverrideManifestSha256: string;
  readonly basePreparedPrefixHash: string;
  readonly requestConfigHash: string;
  readonly toolSchemaHash: string;
  readonly nextKeepFromOrdinal: number;
  readonly retiredThroughOrdinal: number;
  readonly retiredTurnCount: number;
  readonly retiredFrameCount: number;
  readonly retiredMessageCount: number;
  readonly nextActiveOverrideCount: number;
  readonly nextActiveOverrideManifestSha256: string;
  readonly canonicalSequenceSha256: string;
  readonly renderedMessageSha256: string;
  readonly rawTokensBefore: number;
  readonly rawTokensAfter: number;
  readonly guardedTokensBefore: number;
  readonly guardedTokensAfter: number;
  readonly targetTokens: number;
  readonly projectedPrefixHash: string;
  readonly planHash: string;
};

export type PrefixRetirementPlanningInput = {
  readonly active: CompiledRevisionContext;
  readonly revision: StoredContextRevisionV7;
  readonly surface: StoredContextSurfaceV7;
  readonly activeOverrides: readonly SwapOverride[];
  readonly canonical: ProtocolContextView;
  readonly closedTurns: readonly ClosedTurnBoundary[];
  readonly activePrepared: PreparedModelRequest;
  readonly activeUsage: ContextUsageSnapshot;
  readonly tools: readonly ToolDefinition[];
  readonly policy: RecallFirstRetirementPolicyV1;
  readonly trigger: PrefixRetirementPlanningTrigger;
  readonly forcedTargetTokens?: number;
};

export type PrefixRetirementPlanningResult =
  | {
      readonly outcome: "below_target" | "no_complete_prefix";
      readonly rawTokensBefore: number;
      readonly guardedTokensBefore: number;
      readonly targetTokens: number;
    }
  | {
      readonly outcome: "target_reached" | "retirement_floor";
      readonly rawTokensBefore: number;
      readonly guardedTokensBefore: number;
      readonly targetTokens: number;
      readonly plan: PrefixRetirementPlan;
    };

export class PrefixRetirementPlanningError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PrefixRetirementPlanningError";
  }
}

export class PrefixRetirementPlanStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrefixRetirementPlanStaleError";
  }
}

type ModelPreparer = Pick<ModelClient, "prepare">;

type Projection = {
  readonly candidateIndex: number;
  readonly boundary: ClosedTurnBoundary;
  readonly activeOverrides: readonly SwapOverride[];
  readonly compiled: CompiledRevisionContext;
  readonly prepared: PreparedModelRequest;
  readonly rawTokens: number;
  readonly guardedTokens: number;
};

export class PrefixRetirementPlanner {
  private readonly compiler = new ContextRevisionCompiler();
  private readonly requestBuilder = new ContextBuilder();

  constructor(private readonly model: ModelPreparer) {}

  plan(input: PrefixRetirementPlanningInput): PrefixRetirementPlanningResult {
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
    if (guardedTokensBefore <= targetTokens) {
      return Object.freeze({
        outcome: "below_target",
        rawTokensBefore,
        guardedTokensBefore,
        targetTokens,
      });
    }

    const activeTurns = input.closedTurns.filter(
      (turn) => turn.firstOrdinal >= input.revision.keepFromOrdinal,
    );
    const candidateCount = activeTurns.length - input.policy.protectedRecentTurnCount;
    if (candidateCount < 1) {
      return Object.freeze({
        outcome: "no_complete_prefix",
        rawTokensBefore,
        guardedTokensBefore,
        targetTokens,
      });
    }
    const candidates = activeTurns.slice(1, candidateCount + 1);
    const projections = new Map<number, Projection>();
    const project = (candidateIndex: number): Projection => {
      const cached = projections.get(candidateIndex);
      if (cached !== undefined) return cached;
      const boundary = requireItem(candidates, candidateIndex, "retirement boundary");
      const activeOverrides = Object.freeze(
        input.activeOverrides.filter(
          (override) => override.ordinal >= boundary.firstOrdinal,
        ),
      );
      let compiled: CompiledRevisionContext;
      let prepared: PreparedModelRequest;
      try {
        compiled = this.compiler.compileProspective({
          active: input.active,
          canonical: input.canonical,
          activeOverrides: input.activeOverrides,
          addedOverrides: [],
          activeSurface: input.surface,
          keepFromOrdinal: boundary.firstOrdinal,
        });
        const built = this.requestBuilder.build({
          canonical: input.canonical,
          revision: input.revision,
          surface: input.surface,
          activeOverrides,
          compiled,
          tools: input.tools,
        });
        prepared = this.model.prepare(built.request);
      } catch (error) {
        if (error instanceof ContextRevisionError) throw error;
        throw new PrefixRetirementPlanningError(
          "prospective_prepare_failed",
          "Prefix retirement request preparation failed.",
          { cause: error },
        );
      }
      assertProspectiveConfiguration(input.activePrepared, prepared);
      const rawTokens = estimatePromptSegments(prepared.promptSegments).totalTokens;
      const projection = Object.freeze({
        candidateIndex,
        boundary,
        activeOverrides,
        compiled,
        prepared,
        rawTokens,
        guardedTokens: guardTokens(rawTokens, input.activeUsage.correctionFactor),
      });
      projections.set(candidateIndex, projection);
      return projection;
    };

    const maximum = project(candidates.length - 1);
    let outcome: "target_reached" | "retirement_floor";
    let selected: Projection;
    if (maximum.guardedTokens > targetTokens) {
      outcome = "retirement_floor";
      selected = maximum;
    } else {
      outcome = "target_reached";
      let low = 0;
      let high = candidates.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (project(middle).guardedTokens <= targetTokens) high = middle;
        else low = middle + 1;
      }
      selected = project(low);
    }

    assertStrictReduction(selected, rawTokensBefore, guardedTokensBefore);
    const previous =
      selected.candidateIndex === 0 ? undefined : project(selected.candidateIndex - 1);
    const next =
      selected.candidateIndex + 1 >= candidates.length
        ? undefined
        : project(selected.candidateIndex + 1);
    assertNeighborMonotonicity(previous, selected, next);
    if (
      outcome === "target_reached" &&
      previous !== undefined &&
      previous.guardedTokens <= targetTokens
    ) {
      throw new PrefixRetirementPlanningError(
        "non_minimal_boundary",
        "Prefix retirement did not select the minimal target boundary.",
      );
    }

    const retiredTurns = activeTurns.filter(
      (turn) => turn.lastOrdinal < selected.boundary.firstOrdinal,
    );
    const projectedFingerprint = promptPrefixFingerprint(selected.prepared);
    const plan = createPlan({
      input,
      activeFingerprint,
      projectedFingerprint,
      projection: selected,
      retiredTurns,
      targetTokens,
      rawTokensBefore,
      guardedTokensBefore,
    });
    assertRetirementPlanBaseCurrent(plan, input);
    return Object.freeze({
      outcome,
      rawTokensBefore,
      guardedTokensBefore,
      targetTokens,
      plan,
    });
  }
}

export function assertRetirementPlanBaseCurrent(
  plan: PrefixRetirementPlan,
  current: Pick<
    PrefixRetirementPlanningInput,
    | "active"
    | "revision"
    | "surface"
    | "activeOverrides"
    | "canonical"
    | "activePrepared"
  >,
): void {
  const fingerprint = promptPrefixFingerprint(current.activePrepared);
  if (
    plan.baseRevisionId !== current.active.revisionId ||
    plan.baseRevisionId !== current.revision.revisionId ||
    plan.baseRevisionNumber !== current.revision.revisionNumber ||
    plan.baseKeepFromOrdinal !== current.revision.keepFromOrdinal ||
    plan.baseCanonicalThroughOrdinal !== current.canonical.messages.length ||
    plan.baseSurfaceSha256 !== current.surface.surfaceSha256 ||
    plan.baseActiveOverrideManifestSha256 !==
      activeOverrideManifestHash(current.activeOverrides) ||
    plan.basePreparedPrefixHash !== fingerprint.prefixHash ||
    plan.requestConfigHash !== fingerprint.requestConfigHash ||
    plan.toolSchemaHash !== fingerprint.toolSchemaHash
  ) {
    throw new PrefixRetirementPlanStaleError(
      "Prefix retirement plan base no longer matches the active request.",
    );
  }
}

function validatePlanningInput(input: PrefixRetirementPlanningInput): void {
  if (input.policy.version !== "recall-first-retirement-v1") {
    fail("unsupported_policy", "Prefix retirement policy is unsupported.");
  }
  if (input.trigger !== "manual" && input.trigger !== "benchmark_forced") {
    fail("unsupported_trigger", "Prefix retirement trigger is unsupported.");
  }
  if (
    input.active.sessionId !== input.canonical.sessionId ||
    input.revision.sessionId !== input.canonical.sessionId ||
    input.revision.revisionId !== input.active.revisionId ||
    input.revision.keepFromOrdinal !== input.active.manifest.keepFromOrdinal ||
    input.active.canonicalThroughOrdinal !== input.canonical.messages.length ||
    input.revision.activeOverrideManifestSha256 !==
      activeOverrideManifestHash(input.activeOverrides) ||
    input.revision.activeOverrideCount !== input.activeOverrides.length
  ) {
    throw new ContextRevisionError(
      "Active revision does not match prefix retirement input.",
    );
  }
  if (
    input.surface.recallContractVersion !== CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION
  ) {
    fail("recall_contract_mismatch", "Active Recall contract is not current.");
  }
  if (
    input.tools.filter((tool) => tool.name === "Recall").length !== 1 ||
    stableJsonStringify(input.tools) !==
      stableJsonStringify(input.surface.toolDefinitions) ||
    input.activePrepared.toolSchemaHash !== input.surface.toolSchemaSha256
  ) {
    fail(
      "recall_tool_mismatch",
      "Active tool surface does not contain the required Recall definition.",
    );
  }
  if (
    input.activeOverrides.some(
      (override) => override.ordinal < input.revision.keepFromOrdinal,
    )
  ) {
    throw new ContextRevisionError(
      "Prefix retirement input contains an inactive override.",
    );
  }
  validateClosedTurns(input.closedTurns, input.canonical);
}

function validateClosedTurns(
  turns: readonly ClosedTurnBoundary[],
  canonical: ProtocolContextView,
): void {
  let expectedOrdinal = 2;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = requireItem(turns, index, "closed turn");
    const messages = canonical.messages.filter(
      (message) => message.role !== "system" && message.turnId === turn.turnId,
    );
    const frames = canonical.frames.filter((frame) => frame.turnId === turn.turnId);
    if (
      turn.turnNumber !== index + 1 ||
      turn.firstOrdinal !== expectedOrdinal ||
      turn.firstOrdinal > turn.lastOrdinal ||
      messages.length !== turn.messageCount ||
      frames.length !== turn.frameCount ||
      messages[0]?.role !== "user" ||
      messages[0]?.ordinal !== turn.firstOrdinal ||
      messages.at(-1)?.ordinal !== turn.lastOrdinal ||
      frames.some((frame) => frame.state !== "closed")
    ) {
      throw new ContextRevisionError("Closed turn boundaries are inconsistent.");
    }
    expectedOrdinal = turn.lastOrdinal + 1;
  }
  if (expectedOrdinal !== canonical.messages.length + 1) {
    throw new ContextRevisionError(
      "Closed turn boundaries do not cover canonical history.",
    );
  }
}

function assertActiveFingerprint(
  input: PrefixRetirementPlanningInput,
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

function planningTarget(input: PrefixRetirementPlanningInput): number {
  if (input.trigger === "benchmark_forced") {
    if (
      input.forcedTargetTokens === undefined ||
      !Number.isSafeInteger(input.forcedTargetTokens) ||
      input.forcedTargetTokens < 1
    ) {
      fail("invalid_target", "Forced retirement target must be positive.");
    }
    return input.forcedTargetTokens;
  }
  if (input.forcedTargetTokens !== undefined) {
    fail(
      "unexpected_forced_target",
      "Only benchmark-forced retirement accepts an explicit target.",
    );
  }
  return Math.floor(
    input.activeUsage.inputBudgetTokens * input.policy.targetInputRatio,
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
    fail(
      "prospective_configuration_changed",
      "Prefix retirement changed fixed request configuration.",
    );
  }
}

function assertStrictReduction(
  projection: Projection,
  rawTokensBefore: number,
  guardedTokensBefore: number,
): void {
  if (
    projection.rawTokens >= rawTokensBefore ||
    projection.guardedTokens >= guardedTokensBefore
  ) {
    fail(
      "no_token_reduction",
      "Prefix retirement did not strictly reduce raw and guarded tokens.",
    );
  }
}

function assertNeighborMonotonicity(
  previous: Projection | undefined,
  selected: Projection,
  next: Projection | undefined,
): void {
  if (
    (previous !== undefined &&
      (selected.rawTokens > previous.rawTokens ||
        selected.guardedTokens > previous.guardedTokens)) ||
    (next !== undefined &&
      (next.rawTokens > selected.rawTokens ||
        next.guardedTokens > selected.guardedTokens))
  ) {
    fail(
      "non_monotonic_projection",
      "Prefix retirement token projections are not monotonic.",
    );
  }
}

function createPlan(input: {
  input: PrefixRetirementPlanningInput;
  activeFingerprint: PromptPrefixFingerprint;
  projectedFingerprint: PromptPrefixFingerprint;
  projection: Projection;
  retiredTurns: readonly ClosedTurnBoundary[];
  targetTokens: number;
  rawTokensBefore: number;
  guardedTokensBefore: number;
}): PrefixRetirementPlan {
  const planning = input.input;
  const retiredTurnCount = input.retiredTurns.length;
  const retiredFrameCount = input.retiredTurns.reduce(
    (total, turn) => total + turn.frameCount,
    0,
  );
  const retiredMessageCount = input.retiredTurns.reduce(
    (total, turn) => total + turn.messageCount,
    0,
  );
  const identity = {
    policyVersion: "recall-first-retirement-v1" as const,
    trigger: planning.trigger,
    baseRevisionId: planning.revision.revisionId,
    baseRevisionNumber: planning.revision.revisionNumber,
    baseKeepFromOrdinal: planning.revision.keepFromOrdinal,
    baseCanonicalThroughOrdinal: planning.canonical.messages.length,
    baseSurfaceSha256: planning.surface.surfaceSha256,
    baseActiveOverrideManifestSha256: planning.revision.activeOverrideManifestSha256,
    basePreparedPrefixHash: input.activeFingerprint.prefixHash,
    requestConfigHash: input.activeFingerprint.requestConfigHash,
    toolSchemaHash: input.activeFingerprint.toolSchemaHash,
    nextKeepFromOrdinal: input.projection.boundary.firstOrdinal,
    retiredThroughOrdinal: input.projection.boundary.firstOrdinal - 1,
    retiredTurnCount,
    retiredFrameCount,
    retiredMessageCount,
    nextActiveOverrideCount: input.projection.activeOverrides.length,
    nextActiveOverrideManifestSha256: activeOverrideManifestHash(
      input.projection.activeOverrides,
    ),
    canonicalSequenceSha256: canonicalSequenceHash(planning.canonical),
    renderedMessageSha256: renderedMessageHash(input.projection.compiled.entries),
    rawTokensBefore: input.rawTokensBefore,
    rawTokensAfter: input.projection.rawTokens,
    guardedTokensBefore: input.guardedTokensBefore,
    guardedTokensAfter: input.projection.guardedTokens,
    targetTokens: input.targetTokens,
    projectedPrefixHash: input.projectedFingerprint.prefixHash,
  };
  return Object.freeze({
    ...identity,
    planHash: sha256(stableJsonStringify(identity)),
  });
}

function guardTokens(rawTokens: number, correctionFactor: number): number {
  return Math.ceil(rawTokens * correctionFactor);
}

function fail(code: string, message: string): never {
  throw new PrefixRetirementPlanningError(code, message);
}

function requireItem<T>(items: readonly T[], index: number, name: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new ContextRevisionError(`Missing ${name} at index ${index}.`);
  }
  return item;
}
