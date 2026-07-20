import type { PreparedPromptSegment } from "./model-client";

export const INITIAL_CORRECTION_FACTOR = 1.25;
export const MIN_CORRECTION_FACTOR = 1.1;
export const OBSERVED_RATIO_PADDING = 1.05;
export const CALIBRATION_WINDOW_SIZE = 8;

export type RawContextBreakdown = {
  kernelTokens: number;
  userTokens: number;
  assistantTokens: number;
  toolTokens: number;
  toolSchemaTokens: number;
  protocolTokens: number;
  totalTokens: number;
};

type BreakdownKey = Exclude<keyof RawContextBreakdown, "totalTokens">;

const breakdownKeys: BreakdownKey[] = [
  "kernelTokens",
  "userTokens",
  "assistantTokens",
  "toolTokens",
  "toolSchemaTokens",
  "protocolTokens",
];

export function estimatePromptSegments(
  segments: readonly PreparedPromptSegment[],
): RawContextBreakdown {
  const exact: Record<BreakdownKey, number> = {
    kernelTokens: 0,
    userTokens: 0,
    assistantTokens: 0,
    toolTokens: 0,
    toolSchemaTokens: 0,
    protocolTokens: segments.length * 8,
  };

  for (const segment of segments) {
    exact[breakdownKey(segment.kind)] += estimateText(segment.normalizedText);
    exact[breakdownKey(segment.kind)] += (segment.media ?? []).reduce(
      (total, media) => total + media.planningTokens,
      0,
    );
  }

  const totalTokens = Math.ceil(
    breakdownKeys.reduce((total, key) => total + exact[key], 0),
  );
  const rounded = Object.fromEntries(
    breakdownKeys.map((key) => [key, Math.floor(exact[key])]),
  ) as Record<BreakdownKey, number>;
  let remaining =
    totalTokens - breakdownKeys.reduce((total, key) => total + rounded[key], 0);
  const byFraction = [...breakdownKeys].sort((left, right) => {
    const fractionDifference =
      exact[right] - Math.floor(exact[right]) - (exact[left] - Math.floor(exact[left]));
    return fractionDifference === 0
      ? breakdownKeys.indexOf(left) - breakdownKeys.indexOf(right)
      : fractionDifference;
  });
  for (const key of byFraction) {
    if (remaining === 0) {
      break;
    }
    rounded[key] += 1;
    remaining -= 1;
  }

  return { ...rounded, totalTokens };
}

export class RollingTokenCalibration {
  private readonly samples: number[] = [];

  correctionFactor(): number {
    if (this.samples.length === 0) {
      return INITIAL_CORRECTION_FACTOR;
    }
    return Math.max(
      MIN_CORRECTION_FACTOR,
      Math.max(...this.samples) * OBSERVED_RATIO_PADDING,
    );
  }

  sampleCount(): number {
    return this.samples.length;
  }

  record(promptTokens: number, rawEstimatedTokens: number): void {
    if (!Number.isSafeInteger(promptTokens) || promptTokens < 0) {
      throw new Error(
        `Calibration promptTokens must be a non-negative safe integer; received ${promptTokens}.`,
      );
    }
    if (!Number.isSafeInteger(rawEstimatedTokens) || rawEstimatedTokens <= 0) {
      throw new Error(
        `Calibration rawEstimatedTokens must be a positive safe integer; received ${rawEstimatedTokens}.`,
      );
    }

    this.samples.push(promptTokens / rawEstimatedTokens);
    if (this.samples.length > CALIBRATION_WINDOW_SIZE) {
      this.samples.shift();
    }
  }

  clear(): void {
    this.samples.length = 0;
  }
}

function estimateText(value: string): number {
  let asciiCount = 0;
  let hanCount = 0;
  let otherUtf8Bytes = 0;

  for (const codePoint of value) {
    const scalar = codePoint.codePointAt(0);
    if (scalar === undefined) {
      throw new Error("Unable to read a Unicode code point during token estimation.");
    }
    if (scalar <= 0x7f) {
      asciiCount += 1;
    } else if (/\p{Script=Han}/u.test(codePoint)) {
      hanCount += 1;
    } else {
      otherUtf8Bytes += Buffer.byteLength(codePoint, "utf8");
    }
  }

  return asciiCount * 0.3 + hanCount * 0.6 + otherUtf8Bytes * 0.5;
}

function breakdownKey(kind: PreparedPromptSegment["kind"]): BreakdownKey {
  switch (kind) {
    case "kernel":
      return "kernelTokens";
    case "user":
      return "userTokens";
    case "assistant":
      return "assistantTokens";
    case "tool":
      return "toolTokens";
    case "tool_schema":
      return "toolSchemaTokens";
    case "protocol":
      return "protocolTokens";
  }
}
