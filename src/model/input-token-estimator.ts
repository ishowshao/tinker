import type { MaterializedModelRequest } from "./model-client";

export type InputTokenEstimate = {
  readonly inputTokens: number;
  readonly source: "provider_estimated";
  readonly coverage: "messages" | "full_request";
};

export type InputTokenEstimatorCompatibility = {
  readonly kind: "moonshot-estimate-token-count-v1";
  readonly coverageVersion: "full-request-v1";
  readonly model: string;
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly maxRetries: 0;
};

export interface InputTokenEstimator {
  readonly kind: string;
  readonly compatibility: InputTokenEstimatorCompatibility;
  estimate(
    request: MaterializedModelRequest,
    options: { signal: AbortSignal },
  ): Promise<InputTokenEstimate>;
}
