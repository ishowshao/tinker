import { decodeFailure } from "../remote/failures";
import type {
  SessionOperation,
  SessionOperationResult,
} from "../remote/session-operations";
import { TurnCancelledError } from "../agent/turn-cancellation";
import { randomUUID } from "node:crypto";
import { ClientHttpError, type RemoteClient } from "../remote/client";
import {
  isTerminal,
  type OperationReceipt,
  type RemoteOperationInput,
} from "../remote/protocol";
import type { RemoteTuiSnapshot } from "../remote/tui-protocol";
import type {
  AcceptedTurn,
  QueueFollowUpResult,
} from "../agent/runtime-session-contracts";
import type { RunAgentResult, UserMessage } from "../agent/types";
import type { TurnId } from "../ids/runtime-id";
import { validateUserMessage } from "../image/image-types";

/** Commands retain their UUID across uncertain HTTP responses. Detach only stops observation. */
export class RemoteTasks {
  constructor(
    private readonly transport: RemoteClient,
    private readonly sessionId: string,
    private readonly snapshot: () => RemoteTuiSnapshot,
    private readonly lifetime: AbortSignal,
    private readonly reportError: (message: string) => void,
  ) {}

  async admitTurn(
    userMessage: UserMessage,
    signal: AbortSignal,
  ): Promise<AcceptedTurn> {
    validateUserMessage(userMessage);
    signal.throwIfAborted();
    const requestId = randomUUID();
    const stop = () => {
      if (
        signal.reason instanceof TurnCancelledError &&
        signal.reason.source === "session_dispose"
      )
        return;
      if (!this.lifetime.aborted)
        void this.stop(requestId).catch((error: unknown) => {
          if (!this.lifetime.aborted)
            this.reportError(`Stop failed: ${message(error)}`);
        });
    };
    // Wait for acceptance before sending stop; a lost response is retried with the same ID.
    let receipt = await this.submit({
      kind: "prompt",
      requestId,
      sessionId: this.sessionId,
      prompt: userMessage.content,
      ...(userMessage.attachments ? { attachments: userMessage.attachments } : {}),
    });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      while (!receipt.turnId && !isTerminal(receipt.status)) {
        await pause(100, this.lifetime);
        receipt = await this.read(requestId);
      }
      if (!receipt.turnId && receipt.failure) throw decodeFailure(receipt.failure);
      if (!receipt.turnId)
        throw new Error(
          receipt.error ?? `Task ${receipt.status} before turn admission.`,
        );
      const completion = this.complete(receipt).finally(() =>
        signal.removeEventListener("abort", stop),
      );
      return { turnId: receipt.turnId as TurnId, userMessage, completion };
    } catch (error) {
      signal.removeEventListener("abort", stop);
      throw error;
    }
  }

  async queueFollowUp(userMessage: UserMessage): Promise<QueueFollowUpResult> {
    plainText(userMessage);
    const targetRequestId = this.snapshot().activity.activeRequestId;
    if (!targetRequestId) throw new Error("No execution is running in this session.");
    const receipt = await this.settled(
      await this.submit({
        kind: "follow_up",
        requestId: randomUUID(),
        sessionId: this.sessionId,
        targetRequestId,
        prompt: userMessage.content,
      }),
    );
    if (receipt.status !== "completed" || !receipt.followUp)
      throw new Error(receipt.error ?? `Follow-up ${receipt.status}.`);
    return receipt.followUp;
  }

  async deleteSession(targetSessionId: string): Promise<void> {
    const receipt = await this.settled(
      await this.submit({
        kind: "delete_session",
        sessionId: this.sessionId,
        targetSessionId,
        requestId: randomUUID(),
      }),
    );
    if (receipt.status !== "completed")
      throw new Error(receipt.error ?? `Session deletion ${receipt.status}.`);
  }

  async operate(
    input: Omit<SessionOperation, "sessionId"> & Record<string, unknown>,
  ): Promise<SessionOperationResult> {
    const receipt = await this.settled(
      await this.submit({
        ...input,
        sessionId: this.sessionId,
        requestId: randomUUID(),
      } as RemoteOperationInput),
    );
    if (receipt.failure) throw decodeFailure(receipt.failure);
    if (receipt.status !== "completed" || !receipt.sessionResult)
      throw new Error(receipt.error ?? `Session operation ${receipt.status}.`);
    return receipt.sessionResult;
  }

  async respond(
    input:
      | { kind: "answer"; interactionId: string; selectedIndex: number | null }
      | { kind: "confirm"; interactionId: string; decision: "allow" | "deny" }
      | { kind: "provider_retry"; interactionId: string; decision: "retry" | "stop" },
  ): Promise<void> {
    const receipt = await this.settled(
      await this.submit({
        ...input,
        requestId: randomUUID(),
        sessionId: this.sessionId,
      }),
    );
    if (receipt.status !== "completed")
      throw new Error(receipt.error ?? `Interaction ${receipt.status}.`);
  }

  async stopTurn(): Promise<void> {
    const target = this.snapshot().activity.activeRequestId;
    if (!target) throw new Error("No execution is running in this session.");
    await this.stop(target);
  }
  private async stop(targetRequestId: string): Promise<void> {
    const receipt = await this.settled(
      await this.submit({
        kind: "stop",
        requestId: randomUUID(),
        sessionId: this.sessionId,
        targetRequestId,
      }),
    );
    if (receipt.status !== "completed")
      throw new Error(receipt.error ?? `Stop ${receipt.status}.`);
    await this.settled(await this.read(targetRequestId));
  }
  private async complete(initial: OperationReceipt): Promise<RunAgentResult> {
    const receipt = await this.settled(initial);
    if (receipt.result) return receipt.result;
    throw new Error(
      receipt.error ?? `Task ${receipt.status}; its execution result is unavailable.`,
    );
  }
  private async settled(initial: OperationReceipt): Promise<OperationReceipt> {
    let receipt = initial;
    while (!isTerminal(receipt.status)) {
      await pause(100, this.lifetime);
      receipt = await this.read(receipt.requestId);
    }
    return receipt;
  }
  private submit(input: RemoteOperationInput): Promise<OperationReceipt> {
    return this.retry(() =>
      this.transport.request("/v1/operations", input, this.lifetime),
    );
  }
  private read(id: string): Promise<OperationReceipt> {
    return this.retry(() =>
      this.transport.request(`/v1/operations/${id}`, undefined, this.lifetime),
    );
  }
  private async retry<T>(request: () => Promise<T>): Promise<T> {
    for (;;) {
      this.lifetime.throwIfAborted();
      try {
        return await request();
      } catch (error) {
        this.lifetime.throwIfAborted();
        if (
          error instanceof ClientHttpError &&
          error.status < 500 &&
          error.status !== 429
        )
          throw error;
        this.reportError(`Waiting for service: ${message(error)}`);
        await pause(500, this.lifetime);
      }
    }
  }
}
function plainText(userMessage: UserMessage): void {
  validateUserMessage(userMessage);
  if (userMessage.attachments !== undefined)
    throw new Error("Service TUI image input is not enabled yet.");
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("Client closed."),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
