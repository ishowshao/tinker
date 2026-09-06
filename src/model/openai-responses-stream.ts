import {
  ProviderResponseError,
  type ProviderResponseDiagnostics,
} from "./model-client";
import { sanitizedProviderError } from "./openai-model-utils";

export class OpenAIResponsesStreamAccumulator {
  private eventCount = 0;
  private terminalResponse: unknown;

  constructor(
    private readonly options: {
      provider: string;
      model: string;
    },
  ) {}

  push(event: unknown): string | undefined {
    const path = `events[${this.eventCount}]`;
    const record = requireRecord(event, path, this.options);
    const type = requireString(record.type, `${path}.type`, this.options);
    this.eventCount += 1;

    if (type === "error") {
      const message = requireString(record.message, `${path}.message`, this.options);
      const code =
        record.code === null
          ? null
          : requireString(record.code, `${path}.code`, this.options);
      throw sanitizedProviderError(
        Object.assign(new Error(message), { code }),
        this.options.provider,
        this.options.model,
      );
    }

    if (type === "response.output_text.delta") {
      return requireString(record.delta, `${path}.delta`, this.options);
    }

    if (
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.failed"
    ) {
      if (this.terminalResponse !== undefined) {
        throw streamError(
          this.options,
          path,
          "contains more than one terminal response event",
        );
      }
      this.terminalResponse = record.response;
    }
    return undefined;
  }

  finish(): unknown {
    if (this.eventCount === 0) {
      throw streamError(this.options, "events", "must not be empty");
    }
    if (this.terminalResponse === undefined) {
      throw streamError(
        this.options,
        "events",
        "ended without a terminal response event",
      );
    }
    return this.terminalResponse;
  }
}

function requireRecord(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw streamError(options, path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): string {
  if (typeof value !== "string") {
    throw streamError(options, path, "must be a string");
  }
  return value;
}

function streamError(
  options: { provider: string; model: string },
  path: string,
  detail: string,
): ProviderResponseError {
  const diagnostics: ProviderResponseDiagnostics = {
    provider: options.provider,
    model: options.model,
    path,
  };
  return new ProviderResponseError(
    "invalid_provider_stream",
    `Invalid provider stream (provider=${options.provider}, model=${options.model}): ${path} ${detail}.`,
    diagnostics,
  );
}
