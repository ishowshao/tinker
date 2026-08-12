import type { InputTokenEstimate, InputTokenEstimator } from "./input-token-estimator";
import type { MaterializedModelRequest } from "./model-client";
import { IMAGE_INPUT_POLICY } from "../image/image-input-policy";

export class MoonshotInputTokenEstimator implements InputTokenEstimator {
  readonly kind = "moonshot-estimate-token-count-v1";
  readonly compatibility: InputTokenEstimator["compatibility"];
  private readonly endpoint: string;

  constructor(
    private readonly options: {
      apiKey: string;
      baseURL: string;
      model: string;
      timeoutMs: number;
      fetch?: typeof fetch;
      payloadMapper?: (payload: unknown) => unknown;
    },
  ) {
    const base = new URL(
      options.baseURL.endsWith("/") ? options.baseURL : `${options.baseURL}/`,
    );
    base.username = "";
    base.password = "";
    base.search = "";
    base.hash = "";
    const endpoint = new URL("tokenizers/estimate-token-count", base);
    this.endpoint = endpoint.toString();
    this.compatibility = Object.freeze({
      kind: "moonshot-estimate-token-count-v1",
      coverageVersion: "full-request-v1",
      model: options.model,
      endpoint: this.endpoint,
      timeoutMs: options.timeoutMs,
      maxRetries: 0,
    });
  }

  async estimate(
    request: MaterializedModelRequest,
    options: { signal: AbortSignal },
  ): Promise<InputTokenEstimate> {
    const chatPayload = requireRecord(
      this.options.payloadMapper?.(request.payload) ?? request.payload,
      "materialized chat payload",
    );
    if (!Array.isArray(chatPayload.messages)) {
      throw new Error("Materialized request has no token estimator messages.");
    }
    const payload = {
      model: this.options.model,
      messages: chatPayload.messages,
      ...(Array.isArray(chatPayload.tools) ? { tools: chatPayload.tools } : {}),
    };
    const body = JSON.stringify(payload);
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (bodyBytes > IMAGE_INPUT_POLICY.maxRequestBodyBytes) {
      throw new Error(
        `Token estimate request is ${bodyBytes} bytes; maximum is ${IMAGE_INPUT_POLICY.maxRequestBodyBytes}.`,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Token estimate timed out.")),
      this.options.timeoutMs,
    );
    const onAbort = () => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", onAbort, { once: true });
    try {
      options.signal.throwIfAborted();
      const response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Token estimate endpoint returned HTTP ${response.status}.`);
      }
      const decoded: unknown = await response.json();
      const root = requireRecord(decoded, "token estimate response");
      if (root.error !== undefined && root.error !== null) {
        throw new Error("Token estimate endpoint returned an error response.");
      }
      const data = requireRecord(root.data, "token estimate response data");
      const inputTokens = data.total_tokens;
      if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0) {
        throw new Error("Token estimate response total_tokens is invalid.");
      }
      return Object.freeze({
        inputTokens: inputTokens as number,
        source: "provider_estimated",
        coverage: "full_request",
      });
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}
