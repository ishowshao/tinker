import {
  type ContextCompactionResult,
  type ContextRetirementResult,
} from "../context/context-manager";
import { type StoredContextSurfaceV8 } from "../context/context-surface";
import type { ContextRevisionFinishedData } from "../events/types";
import { type ModelClient } from "../model/model-client";

export function assertPreparedMatchesSurface(
  prepared: ReturnType<ModelClient["prepare"]>,
  surface: StoredContextSurfaceV8,
): void {
  if (
    prepared.requestConfigHash !== surface.requestConfigSha256 ||
    prepared.toolSchemaHash !== surface.toolSchemaSha256 ||
    prepared.requestMaxOutputTokens !== surface.requestMaxOutputTokens
  ) {
    throw new Error("Prepared model request does not match its context surface.");
  }
}

export function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export function boundedContextErrorCode(code: string): string {
  return /^[A-Za-z0-9_]+$/.test(code) && code.length <= 80
    ? code
    : "CONTEXT_COMPACTION_FAILED";
}
export function contextRevisionFinishedData(
  result: ContextCompactionResult,
  reason: "manual" | "runtime_pressure" | "model_directed" = "manual",
  automationPolicyId?: string,
): ContextRevisionFinishedData {
  if (result.status === "unchanged") {
    return {
      strategy: "swap",
      reason,
      policyVersion: "swap-only-v1",
      outcome: result.outcome,
      baseRevisionNumber: result.revisionNumber,
      addedOverrideCount: 0,
      activeOverrideCount: result.activeOverrideCount,
      originalObservationBytes: 0,
      projectedObservationBytes: 0,
      rawTokensBefore: result.rawTokensBefore,
      guardedTokensBefore: result.guardedTokensBefore,
      targetTokens: result.targetTokens,
      durationMs: result.durationMs,
      ...(automationPolicyId === undefined ? {} : { automationPolicyId }),
    };
  }
  return {
    strategy: "swap",
    reason,
    policyVersion: "swap-only-v1",
    outcome: result.outcome,
    baseRevisionNumber: result.previousRevisionNumber,
    revisionNumber: result.revisionNumber,
    addedOverrideCount: result.addedOverrideCount,
    activeOverrideCount: result.activeOverrideCount,
    originalObservationBytes: result.originalObservationBytes,
    projectedObservationBytes: result.projectedObservationBytes,
    rawTokensBefore: result.rawTokensBefore,
    rawTokensAfter: result.rawTokensAfter,
    guardedTokensBefore: result.guardedTokensBefore,
    guardedTokensAfter: result.guardedTokensAfter,
    targetTokens: result.targetTokens,
    planHash: result.planHash,
    durationMs: result.durationMs,
    ...(automationPolicyId === undefined ? {} : { automationPolicyId }),
  };
}

export function contextRetirementFinishedData(
  result: ContextRetirementResult,
  reason: "manual" | "runtime_pressure" = "manual",
  automationPolicyId?: string,
): ContextRevisionFinishedData {
  if (result.status === "unchanged") {
    return {
      strategy: "retire_prefix",
      reason,
      policyVersion: "recall-first-retirement-v1",
      outcome: result.outcome,
      baseRevisionNumber: result.revisionNumber,
      previousKeepFromOrdinal: result.keepFromOrdinal,
      keepFromOrdinal: result.keepFromOrdinal,
      retiredTurnCount: 0,
      retiredFrameCount: 0,
      retiredMessageCount: 0,
      activeOverrideCount: result.activeOverrideCount,
      guardedTokensBefore: result.guardedTokensBefore,
      targetTokens: result.targetTokens,
      planningDurationMs: result.planningDurationMs,
      durationMs: result.durationMs,
      ...(automationPolicyId === undefined ? {} : { automationPolicyId }),
    };
  }
  return {
    strategy: "retire_prefix",
    reason,
    policyVersion: "recall-first-retirement-v1",
    outcome: result.outcome,
    baseRevisionNumber: result.previousRevisionNumber,
    revisionNumber: result.revisionNumber,
    previousKeepFromOrdinal: result.previousKeepFromOrdinal,
    keepFromOrdinal: result.keepFromOrdinal,
    retiredTurnCount: result.retiredTurnCount,
    retiredFrameCount: result.retiredFrameCount,
    retiredMessageCount: result.retiredMessageCount,
    activeOverrideCount: result.activeOverrideCount,
    rawTokensBefore: result.rawTokensBefore,
    rawTokensAfter: result.rawTokensAfter,
    guardedTokensBefore: result.guardedTokensBefore,
    guardedTokensAfter: result.guardedTokensAfter,
    targetTokens: result.targetTokens,
    planHash: result.planHash,
    planningDurationMs: result.planningDurationMs,
    validationDurationMs: result.validationDurationMs,
    transactionDurationMs: result.transactionDurationMs,
    activationDurationMs: result.activationDurationMs,
    durationMs: result.durationMs,
    ...(automationPolicyId === undefined ? {} : { automationPolicyId }),
  };
}
