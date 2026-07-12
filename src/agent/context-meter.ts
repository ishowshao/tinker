import type { ModelContextBudget } from "../model/model-context-profile";
import type {
  ModelRequestOutput,
  ModelUsage,
  PreparedModelRequest,
  PreparedPromptSegment,
} from "../model/model-client";
import {
  assertContextBudget,
  contextPressure,
  sha256,
  type ContextPressure,
  type ContextUsageSource,
} from "../model/model-request-preflight";
import {
  estimatePromptSegments,
  RollingTokenCalibration,
  type RawContextBreakdown,
} from "../model/token-estimator";

export type MeasuredContextAnchor = {
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly segmentCount: number;
  readonly prefixHash: string;
  readonly requestConfigHash: string;
  readonly toolSchemaHash: string;
};

export type ContextUsageSnapshot = {
  usedInputTokens: number;
  source: ContextUsageSource;
  pressure: ContextPressure;
  inputBudgetTokens: number;
  triggerTokens: number;
  triggerRatio: number;
  requestMaxOutputTokens: number;
  lastProviderUsage?: ModelUsage;
  rawFullEstimate?: RawContextBreakdown;
  rawDeltaTokens?: number;
  guardedDeltaTokens?: number;
  correctionFactor: number;
  calibrationSampleCount: number;
  prefixHash: string;
  requestConfigHash: string;
  toolSchemaHash: string;
};

export type ContextInvalidationReason =
  | "request_config_changed"
  | "tool_schema_changed"
  | "context_rebuilt"
  | "runtime_reset";

type PreparedMeasurement = {
  rawFullEstimate: RawContextBreakdown;
  snapshot: ContextUsageSnapshot;
};

export class ContextMeter {
  private readonly calibration = new RollingTokenCalibration();
  private readonly measurements = new WeakMap<object, PreparedMeasurement>();
  private anchor?: MeasuredContextAnchor;
  private lastProviderUsage?: ModelUsage;
  private calibrationIdentity?: string;

  constructor(
    private readonly budget: ModelContextBudget,
    private readonly options: {
      enableAnchor?: boolean;
      onMeasuredAnchor?: (anchor: MeasuredContextAnchor) => void;
    } = {},
  ) {}

  restoreExactMeasuredAnchor(
    prepared: PreparedModelRequest,
    anchor: MeasuredContextAnchor,
  ): boolean {
    this.requireMatchingOutputLimit(prepared);
    this.refreshCalibrationIdentity(prepared);
    assertMeasuredContextAnchor(anchor);

    const prefixHashes = promptPrefixHashes(
      prepared.requestConfigHash,
      prepared.promptSegments,
    );
    if (
      anchor.requestConfigHash !== prepared.requestConfigHash ||
      anchor.toolSchemaHash !== prepared.toolSchemaHash ||
      anchor.segmentCount !== prepared.promptSegments.length ||
      anchor.prefixHash !== lastPrefixHash(prefixHashes)
    ) {
      this.anchor = undefined;
      this.lastProviderUsage = undefined;
      return false;
    }

    this.anchor = Object.freeze({ ...anchor });
    this.lastProviderUsage = {
      promptTokens: anchor.promptTokens,
      completionTokens: anchor.completionTokens,
      totalTokens: anchor.totalTokens,
    };
    return true;
  }

  measure(prepared: PreparedModelRequest): ContextUsageSnapshot {
    this.requireMatchingOutputLimit(prepared);
    this.refreshCalibrationIdentity(prepared);

    const rawFullEstimate = estimatePromptSegments(prepared.promptSegments);
    const correctionFactor = this.calibration.correctionFactor();
    const prefixHashes = promptPrefixHashes(
      prepared.requestConfigHash,
      prepared.promptSegments,
    );
    const prefixHash = lastPrefixHash(prefixHashes);
    const anchor = this.usableAnchor(prepared, prefixHashes);

    let source: ContextUsageSource;
    let usedInputTokens: number;
    let rawDeltaTokens: number | undefined;
    let guardedDeltaTokens: number | undefined;
    if (anchor === undefined) {
      source = "estimated_full";
      usedInputTokens = Math.ceil(rawFullEstimate.totalTokens * correctionFactor);
    } else {
      source = "measured_plus_estimated_delta";
      rawDeltaTokens = estimatePromptSegments(
        prepared.promptSegments.slice(anchor.segmentCount),
      ).totalTokens;
      guardedDeltaTokens = Math.ceil(rawDeltaTokens * correctionFactor);
      usedInputTokens = anchor.totalTokens + guardedDeltaTokens;
    }

    const snapshot: ContextUsageSnapshot = {
      usedInputTokens,
      source,
      pressure: contextPressure(usedInputTokens, this.budget),
      inputBudgetTokens: this.budget.inputBudgetTokens,
      triggerTokens: this.budget.triggerTokens,
      triggerRatio: this.budget.triggerRatio,
      requestMaxOutputTokens: this.budget.requestMaxOutputTokens,
      ...(this.lastProviderUsage === undefined
        ? {}
        : { lastProviderUsage: { ...this.lastProviderUsage } }),
      rawFullEstimate,
      ...(rawDeltaTokens === undefined ? {} : { rawDeltaTokens }),
      ...(guardedDeltaTokens === undefined ? {} : { guardedDeltaTokens }),
      correctionFactor,
      calibrationSampleCount: this.calibration.sampleCount(),
      prefixHash,
      requestConfigHash: prepared.requestConfigHash,
      toolSchemaHash: prepared.toolSchemaHash,
    };
    this.measurements.set(prepared, { rawFullEstimate, snapshot });
    return snapshot;
  }

  recordProviderUsage(
    prepared: PreparedModelRequest,
    output: ModelRequestOutput,
  ): ContextUsageSnapshot {
    const measurement = this.measurements.get(prepared);
    if (measurement === undefined) {
      throw new Error("Cannot record provider usage before measuring the request.");
    }

    this.calibration.record(
      output.usage.promptTokens,
      measurement.rawFullEstimate.totalTokens,
    );
    this.lastProviderUsage = { ...output.usage };
    const replaySegments = prepared.assistantReplaySegments(output.message);
    const anchoredSegments = [...prepared.promptSegments, ...replaySegments];
    const prefixHash = lastPrefixHash(
      promptPrefixHashes(prepared.requestConfigHash, anchoredSegments),
    );
    if (this.options.enableAnchor !== false) {
      const anchor = Object.freeze({
        totalTokens: output.usage.totalTokens,
        promptTokens: output.usage.promptTokens,
        completionTokens: output.usage.completionTokens,
        segmentCount: anchoredSegments.length,
        prefixHash,
        requestConfigHash: prepared.requestConfigHash,
        toolSchemaHash: prepared.toolSchemaHash,
      });
      this.anchor = anchor;
      this.options.onMeasuredAnchor?.(anchor);
    }

    const usedInputTokens = output.usage.totalTokens;
    return {
      usedInputTokens,
      source: "provider_measured",
      pressure: contextPressure(usedInputTokens, this.budget),
      inputBudgetTokens: this.budget.inputBudgetTokens,
      triggerTokens: this.budget.triggerTokens,
      triggerRatio: this.budget.triggerRatio,
      requestMaxOutputTokens: this.budget.requestMaxOutputTokens,
      lastProviderUsage: { ...output.usage },
      rawFullEstimate: measurement.rawFullEstimate,
      correctionFactor: this.calibration.correctionFactor(),
      calibrationSampleCount: this.calibration.sampleCount(),
      prefixHash,
      requestConfigHash: prepared.requestConfigHash,
      toolSchemaHash: prepared.toolSchemaHash,
    };
  }

  assertWithinBudget(snapshot: ContextUsageSnapshot): void {
    assertContextBudget({
      usedInputTokens: snapshot.usedInputTokens,
      source: snapshot.source,
      ...this.budget,
    });
  }

  invalidate(reason: ContextInvalidationReason): void {
    void reason;
    this.anchor = undefined;
    this.calibration.clear();
    this.calibrationIdentity = undefined;
  }

  private usableAnchor(
    prepared: PreparedModelRequest,
    prefixHashes: readonly string[],
  ): MeasuredContextAnchor | undefined {
    const anchor = this.anchor;
    if (anchor === undefined) {
      return undefined;
    }
    if (
      anchor.requestConfigHash !== prepared.requestConfigHash ||
      anchor.toolSchemaHash !== prepared.toolSchemaHash ||
      anchor.segmentCount > prepared.promptSegments.length ||
      prefixHashes[anchor.segmentCount] !== anchor.prefixHash
    ) {
      this.anchor = undefined;
      return undefined;
    }
    return anchor;
  }

  private requireMatchingOutputLimit(prepared: PreparedModelRequest): void {
    if (prepared.requestMaxOutputTokens !== this.budget.requestMaxOutputTokens) {
      throw new Error(
        `Prepared request output limit must equal the context budget: expected ${this.budget.requestMaxOutputTokens}, received ${prepared.requestMaxOutputTokens}.`,
      );
    }
  }

  private refreshCalibrationIdentity(prepared: PreparedModelRequest): void {
    const next = `${prepared.requestConfigHash}:${prepared.toolSchemaHash}`;
    if (this.calibrationIdentity !== undefined && this.calibrationIdentity !== next) {
      this.anchor = undefined;
      this.calibration.clear();
    }
    this.calibrationIdentity = next;
  }
}

function promptPrefixHashes(
  requestConfigHash: string,
  segments: readonly PreparedPromptSegment[],
): string[] {
  const hashes = [sha256(`request-config:${requestConfigHash}`)];
  for (const segment of segments) {
    const previous = hashes.at(-1);
    if (previous === undefined) {
      throw new Error("Prompt prefix hash chain has no seed.");
    }
    hashes.push(
      sha256(`${previous}\u0000${segment.kind}\u0000${segment.normalizedText}`),
    );
  }
  return hashes;
}

function lastPrefixHash(hashes: readonly string[]): string {
  const value = hashes.at(-1);
  if (value === undefined) {
    throw new Error("Prompt prefix hash chain is empty.");
  }
  return value;
}

function assertMeasuredContextAnchor(anchor: MeasuredContextAnchor): void {
  for (const [name, value] of [
    ["promptTokens", anchor.promptTokens],
    ["completionTokens", anchor.completionTokens],
    ["totalTokens", anchor.totalTokens],
    ["segmentCount", anchor.segmentCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `Measured context anchor ${name} must be a non-negative safe integer; received ${value}.`,
      );
    }
  }
  if (anchor.totalTokens !== anchor.promptTokens + anchor.completionTokens) {
    throw new Error(
      "Measured context anchor totalTokens must equal promptTokens + completionTokens.",
    );
  }
}
