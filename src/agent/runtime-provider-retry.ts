import type { AgentEventInput, ModelRequestFailedData } from "../events/types";
import type { IterationIdentity } from "./types";
import { cancellationError } from "./turn-cancellation";

export type ProviderRetryDecision = "retry" | "stop";
export type ProviderRetryRequest = {
  readonly requestId: string;
  readonly failure: ModelRequestFailedData;
};
export type ProviderRetrySnapshot = { readonly pending?: ProviderRetryRequest };
export const EMPTY_PROVIDER_RETRY: ProviderRetrySnapshot = Object.freeze({});

type PendingRetry = {
  request: ProviderRetryRequest;
  iteration: IterationIdentity;
  startedAt: number;
  signal: AbortSignal;
  resolve: (decision: ProviderRetryDecision) => void;
  reject: (error: unknown) => void;
  removeAbortListener: () => void;
};

/** Process-local interaction; the original turn and model request remain open. */
export class RuntimeProviderRetry {
  private snapshot: ProviderRetrySnapshot = EMPTY_PROVIDER_RETRY;
  private pending?: PendingRetry;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly append: (event: AgentEventInput) => Promise<void>) {}

  read(): ProviderRetrySnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(
    iteration: IterationIdentity,
    failure: ModelRequestFailedData,
    signal: AbortSignal,
  ): Promise<ProviderRetryDecision> {
    if (this.pending !== undefined) throw new Error("Provider retry already pending.");
    if (signal.aborted) throw cancellationError(signal);
    await this.append({ type: "model.retry.requested", ...iteration, data: failure });
    return new Promise((resolve, reject) => {
      const request = Object.freeze({
        requestId: `${iteration.iterationId}:${failure.attemptNumber}`,
        failure: Object.freeze({ ...failure }),
      });
      const pending: PendingRetry = {
        request,
        iteration,
        startedAt: Date.now(),
        signal,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      };
      const onAbort = () => {
        // settle rejects the waiting loop too; do not leave a detached rejection.
        void this.settle(pending, "cancelled").catch(() => undefined);
      };
      this.pending = pending;
      this.snapshot = Object.freeze({ pending: request });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      else this.notify();
    });
  }

  async resolve(requestId: string, decision: ProviderRetryDecision): Promise<void> {
    const pending = this.pending;
    if (pending === undefined || pending.request.requestId !== requestId) {
      throw new Error("Provider retry question is no longer pending.");
    }
    if (decision !== "retry" && decision !== "stop") {
      throw new Error("Invalid provider retry decision.");
    }
    await this.settle(pending, decision);
  }

  private async settle(
    pending: PendingRetry,
    decision: ProviderRetryDecision | "cancelled",
  ): Promise<void> {
    if (this.pending !== pending) return;
    this.pending = undefined;
    this.snapshot = EMPTY_PROVIDER_RETRY;
    pending.removeAbortListener();
    this.notify();
    try {
      await this.append({
        type: "model.retry.resolved",
        ...pending.iteration,
        data: {
          attemptNumber: pending.request.failure.attemptNumber,
          decision,
          durationMs: Date.now() - pending.startedAt,
        },
      });
      if (decision === "cancelled") pending.reject(cancellationError(pending.signal));
      else pending.resolve(decision);
    } catch (error) {
      pending.reject(error);
      throw error;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
