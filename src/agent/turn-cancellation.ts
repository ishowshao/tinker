export class TurnCancelledError extends Error {
  constructor(message = "Turn cancelled by the user.", options?: ErrorOptions) {
    super(message, options);
    this.name = "TurnCancelledError";
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

  if (signal.reason instanceof TurnCancelledError) {
    return signal.reason;
  }

  return new TurnCancelledError("Turn cancelled by the user.", {
    cause: cause ?? signal.reason,
  });
}
