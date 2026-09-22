import { RemoteError } from "./protocol";

export type ResidentPolicy = {
  maxLoadedSessions: number;
  maxConcurrentTurns: number;
  maxPendingTurns: number;
  idleTimeoutMs: number;
  shutdownGraceMs: number;
};
export const DEFAULT_RESIDENT_POLICY: Readonly<ResidentPolicy> = Object.freeze({
  maxLoadedSessions: 16,
  maxConcurrentTurns: 4,
  maxPendingTurns: 32,
  idleTimeoutMs: 5 * 60 * 1000,
  shutdownGraceMs: 30 * 1000,
});
export function parseResidentPolicy(value: unknown): ResidentPolicy {
  if (value === undefined) return { ...DEFAULT_RESIDENT_POLICY };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("resident must be an object.");
  const entries = value as Record<string, unknown>;
  for (const key of Object.keys(entries))
    if (!(key in DEFAULT_RESIDENT_POLICY))
      throw new Error(`Unknown resident setting: ${key}`);
  const result = { ...DEFAULT_RESIDENT_POLICY };
  for (const key of Object.keys(result) as (keyof ResidentPolicy)[]) {
    const candidate = entries[key] ?? result[key];
    const maximum = key.endsWith("Ms") ? 86400000 : 4096;
    if (
      typeof candidate !== "number" ||
      !Number.isInteger(candidate) ||
      candidate < 1 ||
      candidate > maximum
    )
      throw new Error(
        `Invalid resident.${key}; expected an integer from 1 to ${maximum}.`,
      );
    result[key] = candidate;
  }
  if (
    result.maxConcurrentTurns > result.maxLoadedSessions ||
    result.maxPendingTurns < result.maxConcurrentTurns
  )
    throw new Error(
      "resident requires maxConcurrentTurns <= maxLoadedSessions and maxPendingTurns >= maxConcurrentTurns.",
    );
  return result;
}

/** FIFO execution slots. Queued cancellation never enters the runtime. */
export class TurnSlots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly maximum: number) {}
  get running() {
    return this.active;
  }
  get queued() {
    return this.waiting.length;
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(start);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(
          new RemoteError(409, "TURN_CANCELLED", "Queued execution was cancelled."),
        );
      };
      const start = () => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          abort();
          return;
        }
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.waiting.shift()?.();
        });
      };
      if (signal.aborted) {
        abort();
        return;
      }
      if (this.active < this.maximum) start();
      else {
        this.waiting.push(start);
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  }
}
