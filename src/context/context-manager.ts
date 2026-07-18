import { ContextBuilder } from "../agent/context-builder";
import type { ContextMeter, ContextUsageSnapshot } from "../agent/context-meter";
import type { SessionLedger } from "../agent/session-ledger";
import type { RuntimeIdFactory } from "../ids/runtime-id";
import {
  CommittedPrefixAuditError,
  type CommittedPrefixAuditor,
} from "../model/committed-prefix-auditor";
import type { ModelClient } from "../model/model-client";
import { promptPrefixFingerprint } from "../model/prompt-prefix-hash";
import { estimatePromptSegments } from "../model/token-estimator";
import { SessionError } from "../session/session-errors";
import type { SessionStore } from "../session/session-store";
import type { ToolDefinition } from "../tools/types";
import { canonicalSequenceHash, renderedMessageHash } from "./compiled-context-hash";
import { CompiledContextError } from "./compiled-context-validator";
import { recallFirstRetirementPolicyV1, swapOnlyPolicyV1 } from "./context-policy";
import { ContextProtocolError } from "./context-protocol-validator";
import {
  ContextRevisionCompiler,
  ContextRevisionError,
} from "./context-revision-compiler";
import {
  assertPlanBaseCurrent,
  SwapPlanner,
  SwapPlanningDiagnosticError,
  SwapPlanStaleError,
} from "./swap-planner";
import {
  assertRetirementPlanBaseCurrent,
  PrefixRetirementPlanner,
  PrefixRetirementPlanningError,
  PrefixRetirementPlanStaleError,
  type PrefixRetirementPlan,
} from "./prefix-retirement-planner";

export type ContextCompactionTrigger =
  | { kind: "manual" }
  | { kind: "runtime_pressure" }
  | { kind: "benchmark_forced"; targetTokens: number };

export type ContextRetirementTrigger =
  | { kind: "manual" }
  | { kind: "benchmark_forced"; targetTokens: number };

export type ContextCompactionResult =
  | {
      status: "unchanged";
      outcome: "below_target" | "no_eligible_candidates";
      revisionId: ReturnType<RuntimeIdFactory["createContextRevisionId"]>;
      revisionNumber: number;
      activeOverrideCount: number;
      rawTokensBefore: number;
      guardedTokensBefore: number;
      targetTokens: number;
      planningDurationMs: number;
      durationMs: number;
    }
  | {
      status: "compacted";
      outcome: "target_reached" | "insufficient_candidates";
      previousRevisionId: ReturnType<RuntimeIdFactory["createContextRevisionId"]>;
      revisionId: ReturnType<RuntimeIdFactory["createContextRevisionId"]>;
      previousRevisionNumber: number;
      revisionNumber: number;
      addedOverrideCount: number;
      activeOverrideCount: number;
      originalObservationBytes: number;
      projectedObservationBytes: number;
      rawTokensBefore: number;
      rawTokensAfter: number;
      guardedTokensBefore: number;
      guardedTokensAfter: number;
      targetTokens: number;
      planHash: string;
      planningDurationMs: number;
      validationDurationMs: number;
      transactionDurationMs: number;
      activationDurationMs: number;
      durationMs: number;
    };

export type ContextRetirementResult =
  | {
      status: "unchanged";
      outcome: "below_target" | "no_complete_prefix";
      revisionId: ReturnType<RuntimeIdFactory["createContextRevisionId"]>;
      revisionNumber: number;
      keepFromOrdinal: number;
      activeOverrideCount: number;
      guardedTokensBefore: number;
      targetTokens: number;
      planningDurationMs: number;
      durationMs: number;
    }
  | {
      status: "retired";
      outcome: "target_reached" | "retirement_floor";
      previousRevisionId: ReturnType<RuntimeIdFactory["createContextRevisionId"]>;
      revisionId: ReturnType<RuntimeIdFactory["createContextRevisionId"]>;
      previousRevisionNumber: number;
      revisionNumber: number;
      previousKeepFromOrdinal: number;
      keepFromOrdinal: number;
      retiredTurnCount: number;
      retiredFrameCount: number;
      retiredMessageCount: number;
      activeOverrideCount: number;
      rawTokensBefore: number;
      rawTokensAfter: number;
      guardedTokensBefore: number;
      guardedTokensAfter: number;
      targetTokens: number;
      planHash: string;
      planningDurationMs: number;
      validationDurationMs: number;
      transactionDurationMs: number;
      activationDurationMs: number;
      durationMs: number;
    };

export class ContextManagerError extends Error {
  constructor(
    readonly stage: "snapshot" | "plan" | "validate" | "commit" | "activate",
    readonly code: string,
    readonly fatal: boolean,
    readonly committed: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ContextManagerError";
  }
}

type ModelPreparer = Pick<ModelClient, "prepare">;

export class ContextManager {
  private readonly planner: SwapPlanner;
  private readonly retirementPlanner: PrefixRetirementPlanner;
  private readonly compiler = new ContextRevisionCompiler();
  private readonly requestBuilder = new ContextBuilder();

  constructor(
    private readonly input: {
      store: SessionStore;
      ledger: SessionLedger;
      model: ModelPreparer;
      contextMeter: ContextMeter;
      committedPrefixAuditor: CommittedPrefixAuditor;
      idFactory: RuntimeIdFactory;
      tools: () => readonly ToolDefinition[];
      onUsageUpdated: (snapshot: ContextUsageSnapshot) => Promise<void>;
    },
  ) {
    this.planner = new SwapPlanner(input.model);
    this.retirementPlanner = new PrefixRetirementPlanner(input.model);
  }

  async compact(trigger: ContextCompactionTrigger): Promise<ContextCompactionResult> {
    const startedAt = performance.now();
    let built;
    let activePrepared;
    let activeUsage;
    const tools = this.input.tools();
    try {
      this.input.store.assertContextRevisionIdle();
      built = this.input.ledger.buildCommittedModelRequest(tools);
      activePrepared = this.input.model.prepare(built.request);
      activeUsage = this.input.contextMeter.measure(activePrepared);
    } catch (error) {
      throw managerError("snapshot", error);
    }

    let planning;
    try {
      planning = this.planner.plan({
        active: built.compiled,
        revision: built.revision,
        surface: built.surface,
        activeOverrides: built.activeOverrides,
        canonical: built.canonical,
        activePrepared,
        activeUsage,
        tools,
        policy: swapOnlyPolicyV1,
        trigger: trigger.kind,
        ...(trigger.kind === "benchmark_forced"
          ? { forcedTargetTokens: trigger.targetTokens }
          : {}),
      });
    } catch (error) {
      throw managerError("plan", error);
    }
    const planningDurationMs = elapsedMs(startedAt);

    if (
      planning.outcome === "below_target" ||
      planning.outcome === "no_eligible_candidates"
    ) {
      return Object.freeze({
        status: "unchanged",
        outcome: planning.outcome,
        revisionId: built.revision.revisionId,
        revisionNumber: built.revision.revisionNumber,
        activeOverrideCount: built.revision.activeOverrideCount,
        rawTokensBefore: planning.rawTokensBefore,
        guardedTokensBefore: planning.guardedTokensBefore,
        targetTokens: planning.targetTokens,
        planningDurationMs,
        durationMs: elapsedMs(startedAt),
      });
    }
    if (planning.outcome === "below_trigger") {
      throw new ContextManagerError(
        "plan",
        "manual_below_trigger",
        true,
        false,
        "Active compaction cannot finish with a shadow-only below-trigger outcome.",
      );
    }
    const plan = planning.plan;
    if (plan === undefined || plan.addedOverrides.length === 0) {
      throw new ContextManagerError(
        "validate",
        "missing_swap_plan",
        true,
        false,
        "Committable swap planning produced no revision plan.",
      );
    }

    const candidateOverrides = [...built.activeOverrides, ...plan.addedOverrides];
    const validationStartedAt = performance.now();
    let candidatePrepared;
    let candidateCompiled;
    try {
      candidateCompiled = this.compiler.compileProspective({
        active: built.compiled,
        canonical: built.canonical,
        activeOverrides: built.activeOverrides,
        addedOverrides: plan.addedOverrides,
        activeSurface: built.surface,
      });
      const candidate = this.requestBuilder.build({
        canonical: built.canonical,
        revision: built.revision,
        surface: built.surface,
        activeOverrides: candidateOverrides,
        compiled: candidateCompiled,
        tools,
      });
      candidatePrepared = this.input.model.prepare(candidate.request);
      assertCandidatePrepared(activePrepared, candidatePrepared, plan);

      const current = this.input.ledger.buildCommittedModelRequest(tools);
      const currentPrepared = this.input.model.prepare(current.request);
      assertPlanBaseCurrent(plan, {
        active: current.compiled,
        revision: current.revision,
        activeOverrides: current.activeOverrides,
        activePrepared: currentPrepared,
      });
      this.input.store.assertContextRevisionIdle();
    } catch (error) {
      throw managerError("validate", error);
    }
    const validationDurationMs = elapsedMs(validationStartedAt);

    const revisionId = this.input.idFactory.createContextRevisionId();
    const transactionStartedAt = performance.now();
    let revision;
    try {
      revision = this.input.store.commitSwapRevision({
        revisionId,
        expectedBaseRevisionId: plan.baseRevisionId,
        expectedBaseRevisionNumber: plan.baseRevisionNumber,
        expectedCanonicalThroughOrdinal: plan.baseCanonicalThroughOrdinal,
        expectedBaseActiveOverrideManifestSha256: plan.baseActiveOverrideManifestSha256,
        policyVersion: plan.policyVersion,
        rendererFormat: "swap-observation-v1",
        planHash: plan.planHash,
        addedOverrides: plan.addedOverrides,
        nextActiveOverrideManifestSha256: plan.nextActiveOverrideManifestSha256,
        canonicalSequenceSha256: canonicalSequenceHash(
          built.canonical,
          plan.baseCanonicalThroughOrdinal,
        ),
        renderedMessageSha256: renderedMessageHash(
          candidateCompiled.entries,
          plan.baseCanonicalThroughOrdinal,
        ),
      });
    } catch (error) {
      throw managerError("commit", error);
    }
    const transactionDurationMs = elapsedMs(transactionStartedAt);

    const activationStartedAt = performance.now();
    try {
      this.input.contextMeter.startRevision({
        reason: "context_rebuilt",
        requestConfigHash: candidatePrepared.requestConfigHash,
        toolSchemaHash: candidatePrepared.toolSchemaHash,
      });
      this.input.committedPrefixAuditor.audit(revisionId, candidatePrepared);
      const usage = this.input.contextMeter.measure(candidatePrepared);
      if (usage.source !== "estimated_full") {
        throw new Error(
          "First context measurement after revision activation was not a full estimate.",
        );
      }
      await this.input.onUsageUpdated(usage);
    } catch (error) {
      throw new ContextManagerError(
        "activate",
        errorCode(error),
        true,
        true,
        "Context revision committed but runtime activation failed.",
        { cause: error },
      );
    }
    const activationDurationMs = elapsedMs(activationStartedAt);

    return Object.freeze({
      status: "compacted",
      outcome: planning.outcome,
      previousRevisionId: built.revision.revisionId,
      revisionId,
      previousRevisionNumber: built.revision.revisionNumber,
      revisionNumber: revision.revisionNumber,
      addedOverrideCount: plan.addedOverrides.length,
      activeOverrideCount: revision.activeOverrideCount,
      originalObservationBytes: planning.originalObservationBytes,
      projectedObservationBytes: planning.projectedObservationBytes,
      rawTokensBefore: plan.rawTokensBefore,
      rawTokensAfter: plan.rawTokensAfter,
      guardedTokensBefore: plan.guardedTokensBefore,
      guardedTokensAfter: plan.guardedTokensAfter,
      targetTokens: plan.targetTokens,
      planHash: plan.planHash,
      planningDurationMs,
      validationDurationMs,
      transactionDurationMs,
      activationDurationMs,
      durationMs: elapsedMs(startedAt),
    });
  }

  async retirePrefix(
    trigger: ContextRetirementTrigger,
  ): Promise<ContextRetirementResult> {
    const startedAt = performance.now();
    const tools = this.input.tools();
    let built;
    let activePrepared;
    let activeUsage;
    let closedTurns;
    try {
      this.input.store.assertContextRevisionIdle();
      built = this.input.ledger.buildCommittedModelRequest(tools);
      activePrepared = this.input.model.prepare(built.request);
      activeUsage = this.input.contextMeter.measure(activePrepared);
      closedTurns = this.input.store.loadClosedTurnBoundaries();
    } catch (error) {
      throw managerError("snapshot", error);
    }

    let planning;
    try {
      planning = this.retirementPlanner.plan({
        active: built.compiled,
        revision: built.revision,
        surface: built.surface,
        activeOverrides: built.activeOverrides,
        canonical: built.canonical,
        closedTurns,
        activePrepared,
        activeUsage,
        tools,
        policy: recallFirstRetirementPolicyV1,
        trigger: trigger.kind,
        ...(trigger.kind === "benchmark_forced"
          ? { forcedTargetTokens: trigger.targetTokens }
          : {}),
      });
    } catch (error) {
      throw managerError("plan", error);
    }
    const planningDurationMs = elapsedMs(startedAt);
    if (
      planning.outcome === "below_target" ||
      planning.outcome === "no_complete_prefix"
    ) {
      return Object.freeze({
        status: "unchanged",
        outcome: planning.outcome,
        revisionId: built.revision.revisionId,
        revisionNumber: built.revision.revisionNumber,
        keepFromOrdinal: built.revision.keepFromOrdinal,
        activeOverrideCount: built.revision.activeOverrideCount,
        guardedTokensBefore: planning.guardedTokensBefore,
        targetTokens: planning.targetTokens,
        planningDurationMs,
        durationMs: elapsedMs(startedAt),
      });
    }

    if (!("plan" in planning)) {
      throw new ContextManagerError(
        "validate",
        "missing_retirement_plan",
        true,
        false,
        "Committable prefix retirement produced no revision plan.",
      );
    }
    const plan = planning.plan;
    const validationStartedAt = performance.now();
    const nextActiveOverrides = built.activeOverrides.filter(
      (override) => override.ordinal >= plan.nextKeepFromOrdinal,
    );
    let candidateCompiled;
    let candidatePrepared;
    try {
      candidateCompiled = this.compiler.compileProspective({
        active: built.compiled,
        canonical: built.canonical,
        activeOverrides: built.activeOverrides,
        addedOverrides: [],
        activeSurface: built.surface,
        keepFromOrdinal: plan.nextKeepFromOrdinal,
      });
      const candidate = this.requestBuilder.build({
        canonical: built.canonical,
        revision: built.revision,
        surface: built.surface,
        activeOverrides: nextActiveOverrides,
        compiled: candidateCompiled,
        tools,
      });
      candidatePrepared = this.input.model.prepare(candidate.request);
      assertRetirementCandidatePrepared(activePrepared, candidatePrepared, plan);

      const current = this.input.ledger.buildCommittedModelRequest(tools);
      const currentPrepared = this.input.model.prepare(current.request);
      assertRetirementPlanBaseCurrent(plan, {
        active: current.compiled,
        revision: current.revision,
        surface: current.surface,
        activeOverrides: current.activeOverrides,
        canonical: current.canonical,
        activePrepared: currentPrepared,
      });
      this.input.store.assertContextRevisionIdle();
    } catch (error) {
      throw managerError("validate", error);
    }
    const validationDurationMs = elapsedMs(validationStartedAt);

    const revisionId = this.input.idFactory.createContextRevisionId();
    const transactionStartedAt = performance.now();
    let revision;
    try {
      revision = this.input.store.commitPrefixRetirementRevision({
        revisionId,
        expectedBaseRevisionId: plan.baseRevisionId,
        expectedBaseRevisionNumber: plan.baseRevisionNumber,
        expectedBaseKeepFromOrdinal: plan.baseKeepFromOrdinal,
        expectedCanonicalThroughOrdinal: plan.baseCanonicalThroughOrdinal,
        expectedSurfaceSha256: plan.baseSurfaceSha256,
        expectedBaseActiveOverrideManifestSha256: plan.baseActiveOverrideManifestSha256,
        policyVersion: plan.policyVersion,
        planHash: plan.planHash,
        nextKeepFromOrdinal: plan.nextKeepFromOrdinal,
        retiredThroughOrdinal: plan.retiredThroughOrdinal,
        retiredTurnCount: plan.retiredTurnCount,
        retiredFrameCount: plan.retiredFrameCount,
        retiredMessageCount: plan.retiredMessageCount,
        nextActiveOverrideCount: plan.nextActiveOverrideCount,
        nextActiveOverrideManifestSha256: plan.nextActiveOverrideManifestSha256,
        canonicalSequenceSha256: plan.canonicalSequenceSha256,
        renderedMessageSha256: plan.renderedMessageSha256,
      });
    } catch (error) {
      throw managerError("commit", error);
    }
    const transactionDurationMs = elapsedMs(transactionStartedAt);

    const activationStartedAt = performance.now();
    try {
      this.input.contextMeter.startRevision({
        reason: "context_rebuilt",
        requestConfigHash: candidatePrepared.requestConfigHash,
        toolSchemaHash: candidatePrepared.toolSchemaHash,
      });
      this.input.committedPrefixAuditor.audit(revisionId, candidatePrepared);
      const usage = this.input.contextMeter.measure(candidatePrepared);
      if (usage.source !== "estimated_full") {
        throw new Error(
          "First context measurement after prefix retirement was not a full estimate.",
        );
      }
      await this.input.onUsageUpdated(usage);
    } catch (error) {
      throw new ContextManagerError(
        "activate",
        errorCode(error),
        true,
        true,
        "Prefix retirement committed but runtime activation failed.",
        { cause: error },
      );
    }
    const activationDurationMs = elapsedMs(activationStartedAt);

    return Object.freeze({
      status: "retired",
      outcome: planning.outcome,
      previousRevisionId: built.revision.revisionId,
      revisionId,
      previousRevisionNumber: built.revision.revisionNumber,
      revisionNumber: revision.revisionNumber,
      previousKeepFromOrdinal: built.revision.keepFromOrdinal,
      keepFromOrdinal: revision.keepFromOrdinal,
      retiredTurnCount: plan.retiredTurnCount,
      retiredFrameCount: plan.retiredFrameCount,
      retiredMessageCount: plan.retiredMessageCount,
      activeOverrideCount: revision.activeOverrideCount,
      rawTokensBefore: plan.rawTokensBefore,
      rawTokensAfter: plan.rawTokensAfter,
      guardedTokensBefore: plan.guardedTokensBefore,
      guardedTokensAfter: plan.guardedTokensAfter,
      targetTokens: plan.targetTokens,
      planHash: plan.planHash,
      planningDurationMs,
      validationDurationMs,
      transactionDurationMs,
      activationDurationMs,
      durationMs: elapsedMs(startedAt),
    });
  }
}

function assertRetirementCandidatePrepared(
  active: ReturnType<ModelPreparer["prepare"]>,
  candidate: ReturnType<ModelPreparer["prepare"]>,
  plan: PrefixRetirementPlan,
): void {
  const rawTokens = estimatePromptSegments(candidate.promptSegments).totalTokens;
  const fingerprint = promptPrefixFingerprint(candidate);
  if (
    candidate.provider !== active.provider ||
    candidate.model !== active.model ||
    candidate.requestConfigHash !== active.requestConfigHash ||
    candidate.toolSchemaHash !== active.toolSchemaHash ||
    candidate.requestMaxOutputTokens !== active.requestMaxOutputTokens ||
    rawTokens !== plan.rawTokensAfter ||
    fingerprint.prefixHash !== plan.projectedPrefixHash ||
    plan.rawTokensAfter >= plan.rawTokensBefore ||
    plan.guardedTokensAfter >= plan.guardedTokensBefore
  ) {
    throw new Error(
      "Prepared candidate does not match its validated prefix retirement plan.",
    );
  }
}

function assertCandidatePrepared(
  active: ReturnType<ModelPreparer["prepare"]>,
  candidate: ReturnType<ModelPreparer["prepare"]>,
  plan: NonNullable<ReturnType<SwapPlanner["plan"]>["plan"]>,
): void {
  const rawTokens = estimatePromptSegments(candidate.promptSegments).totalTokens;
  const fingerprint = promptPrefixFingerprint(candidate);
  if (
    candidate.provider !== active.provider ||
    candidate.model !== active.model ||
    candidate.requestConfigHash !== active.requestConfigHash ||
    candidate.toolSchemaHash !== active.toolSchemaHash ||
    candidate.requestMaxOutputTokens !== active.requestMaxOutputTokens ||
    rawTokens !== plan.rawTokensAfter ||
    fingerprint.prefixHash !== plan.projectedPrefixHash ||
    plan.rawTokensAfter >= plan.rawTokensBefore ||
    plan.guardedTokensAfter >= plan.guardedTokensBefore
  ) {
    throw new Error("Prepared candidate does not match its validated swap plan.");
  }
}

function managerError(
  stage: ContextManagerError["stage"],
  error: unknown,
): ContextManagerError {
  if (error instanceof ContextManagerError) {
    return error;
  }
  const fatal = isFatalContextError(error) || stage === "commit";
  const diagnostic =
    error instanceof SwapPlanningDiagnosticError ||
    error instanceof PrefixRetirementPlanningError;
  return new ContextManagerError(
    stage,
    diagnostic ? error.code : errorCode(error),
    fatal,
    false,
    error instanceof Error ? error.message : `Context compaction failed at ${stage}.`,
    { cause: error },
  );
}

function isFatalContextError(error: unknown): boolean {
  return (
    error instanceof ContextProtocolError ||
    error instanceof ContextRevisionError ||
    error instanceof CompiledContextError ||
    error instanceof SwapPlanStaleError ||
    error instanceof PrefixRetirementPlanStaleError ||
    error instanceof CommittedPrefixAuditError ||
    error instanceof SessionError
  );
}

function errorCode(error: unknown): string {
  if (error instanceof SessionError) {
    return error.code;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "CONTEXT_COMPACTION_FAILED";
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
