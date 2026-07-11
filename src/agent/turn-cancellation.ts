import type { TurnCancellationSource } from "./types";

export class TurnCancelledError extends Error {
  readonly source: TurnCancellationSource;

  constructor(
    source: TurnCancellationSource,
    message = source === "user"
      ? "Turn cancelled by the user."
      : "Turn cancelled because the session is disposing.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TurnCancelledError";
    this.source = source;
  }
}

export function throwIfTurnCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancellationError(signal);
  }
}

export function cancellationError(
  signal: AbortSignal,
  cause?: unknown,
): TurnCancelledError {
  if (!signal.aborted) {
    throw new Error("Cannot create a turn cancellation error before abort.");
  }

  if (!(signal.reason instanceof TurnCancelledError)) {
    throw new Error("Aborted turn signal must carry a TurnCancelledError reason.", {
      cause: cause ?? signal.reason,
    });
  }

  return signal.reason;
}

export function turnCancellationSource(signal: AbortSignal): TurnCancellationSource {
  return cancellationError(signal).source;
}
