export const CHROME_BRIDGE_ERROR_CODES = [
  "PLUGIN_NOT_CONNECTED",
  "MULTIPLE_RUNTIMES_UNSUPPORTED",
  "PROTOCOL_VERSION_MISMATCH",
  "BRIDGE_AUTH_FAILED",
  "BRIDGE_DISCONNECTED",
  "REQUEST_TIMEOUT",
  "INVALID_URL",
  "TAB_CREATE_FAILED",
  "NAVIGATION_TIMEOUT",
  "OPEN_PAGE_OUTCOME_UNKNOWN",
  "PAGE_NOT_FOUND",
  "TAB_CLOSED",
  "PAGE_ACCESS_DENIED",
  "PAGE_NOT_READY",
  "SUMMARY_EMPTY",
  "INVALID_PLUGIN_RESPONSE",
  "INTERNAL_ERROR",
] as const;

export const CHROME_BRIDGE_ERROR_CODES_V2 = [
  ...CHROME_BRIDGE_ERROR_CODES,
  "INVALID_ARGUMENT",
  "SNAPSHOT_FAILED",
  "SNAPSHOT_REQUIRED",
  "ELEMENT_NOT_FOUND",
  "ELEMENT_STALE",
  "INTERACTION_FAILED",
  "INVALID_KEY",
  "WAIT_TIMEOUT",
  "DIALOG_NOT_FOUND",
  "FILE_NOT_FOUND",
  "FILE_ACCESS_DENIED",
  "CONSOLE_MESSAGE_NOT_FOUND",
  "NETWORK_REQUEST_NOT_FOUND",
] as const;

export type ChromeBridgeErrorCode = (typeof CHROME_BRIDGE_ERROR_CODES)[number];
export type ChromeBridgeErrorCodeV2 = (typeof CHROME_BRIDGE_ERROR_CODES_V2)[number];
export type ChromeBridgeOutcome = "not_started" | "unknown" | "performed";
export type ChromeBridgeErrorDetails = Record<string, string | number | boolean>;

export class ChromeBridgeError extends Error {
  readonly code: ChromeBridgeErrorCodeV2;
  readonly retryable: boolean;
  readonly outcome: ChromeBridgeOutcome;
  readonly details?: ChromeBridgeErrorDetails;

  constructor(options: {
    code: ChromeBridgeErrorCodeV2;
    message: string;
    retryable: boolean;
    outcome: ChromeBridgeOutcome;
    details?: ChromeBridgeErrorDetails;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ChromeBridgeError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.outcome = options.outcome;
    this.details = options.details;
  }
}

export function internalBridgeError(error: unknown): ChromeBridgeError {
  if (error instanceof ChromeBridgeError) {
    return error;
  }

  return new ChromeBridgeError({
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    outcome: "not_started",
    cause: error,
  });
}

export function isChromeBridgeErrorCode(
  value: unknown,
): value is ChromeBridgeErrorCode {
  return (
    typeof value === "string" &&
    (CHROME_BRIDGE_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function isChromeBridgeErrorCodeV2(
  value: unknown,
): value is ChromeBridgeErrorCodeV2 {
  return (
    typeof value === "string" &&
    (CHROME_BRIDGE_ERROR_CODES_V2 as readonly string[]).includes(value)
  );
}
