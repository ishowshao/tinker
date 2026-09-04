import type { AgentEventInput } from "../events/types";
import { type AskUserRequest, type AskUserResponse } from "../tools/types";
import {
  type AskUserResolution,
  type AskUserSnapshot,
  type BashGuardSnapshot,
  type BashGuardSource,
  type CreateRuntimeSessionInput,
} from "./runtime-session-contracts";
import { cancellationError } from "./turn-cancellation";
import type { ToolCallIdentity } from "./types";

export class RuntimeInteractions {
  private bashGuardMode: "guard" | "yolo";
  private bashGuardSource: BashGuardSource;
  private bashGuardSnapshot: BashGuardSnapshot;
  private readonly bashGuardListeners = new Set<() => void>();
  private askUserSnapshot: AskUserSnapshot = Object.freeze({});
  private readonly askUserListeners = new Set<() => void>();
  private pendingAskUser?: {
    readonly request: AskUserRequest;
    readonly startedAt: number;
    readonly call: ToolCallIdentity;
    readonly resolve: (response: AskUserResponse) => void;
    readonly reject: (error: unknown) => void;
    readonly removeAbortListener: () => void;
  };

  private pendingBashConfirmation?: {
    readonly command: string;
    readonly reason: string;
    readonly startedAt: number;
    readonly call: ToolCallIdentity;
    readonly resolve: (decision: "allow" | "deny") => void;
    readonly reject: (error: unknown) => void;
    readonly removeAbortListener: () => void;
  };

  constructor(
    private readonly bashGuardConfig: CreateRuntimeSessionInput["bashGuard"],
    private readonly append: (event: AgentEventInput) => Promise<void>,
  ) {
    this.bashGuardMode = bashGuardConfig?.mode ?? "guard";
    this.bashGuardSource = bashGuardConfig?.source ?? "default";
    this.bashGuardSnapshot = Object.freeze({
      mode: this.bashGuardMode,
      source: this.bashGuardSource,
    });
  }

  bashGuard(): BashGuardSnapshot {
    return this.bashGuardSnapshot;
  }

  private refreshBashGuardSnapshot(): void {
    this.bashGuardSnapshot = Object.freeze({
      mode: this.bashGuardMode,
      source: this.bashGuardSource,
      ...(this.pendingBashConfirmation === undefined
        ? {}
        : {
            pending: Object.freeze({
              command: this.pendingBashConfirmation.command,
              reason: this.pendingBashConfirmation.reason,
            }),
          }),
    });
  }

  subscribeBashGuard(listener: () => void): () => void {
    this.bashGuardListeners.add(listener);
    return () => this.bashGuardListeners.delete(listener);
  }

  setYoloMode(enabled: boolean): void {
    this.bashGuardMode = enabled ? "yolo" : "guard";
    this.bashGuardSource = "session";
    this.refreshBashGuardSnapshot();
    this.notifyBashGuardListeners();
  }

  async resolveBashConfirmation(decision: "allow" | "deny"): Promise<void> {
    const pending = this.pendingBashConfirmation;
    if (pending === undefined) {
      throw new Error("No Bash confirmation is pending.");
    }
    this.pendingBashConfirmation = undefined;
    this.refreshBashGuardSnapshot();
    pending.removeAbortListener();
    await this.append({
      type: "tool.confirmation.resolved",
      ...pending.call,
      data: {
        command: pending.command,
        reason: pending.reason,
        decision,
        durationMs: Date.now() - pending.startedAt,
      },
    });
    pending.resolve(decision);
    this.notifyBashGuardListeners();
  }

  async confirmBashCommand(
    call: ToolCallIdentity,
    request: { command: string; reason: string },
    signal: AbortSignal,
  ): Promise<"allow" | "deny"> {
    const startedAt = Date.now();
    await this.append({
      type: "tool.confirmation.requested",
      ...call,
      data: request,
    });

    const surface = this.bashGuardConfig?.surface ?? "one-shot";
    if (this.bashGuardMode === "yolo" || surface === "one-shot") {
      const decision = this.bashGuardMode === "yolo" ? "allow" : "deny";
      await this.append({
        type: "tool.confirmation.resolved",
        ...call,
        data: {
          ...request,
          decision,
          durationMs: Date.now() - startedAt,
        },
      });
      return decision;
    }

    if (this.pendingBashConfirmation !== undefined) {
      throw new Error("Another Bash confirmation is already pending.");
    }

    return new Promise<"allow" | "deny">((resolve, reject) => {
      const onAbort = () => {
        const pending = this.pendingBashConfirmation;
        if (pending?.call.toolCallId !== call.toolCallId) {
          return;
        }
        this.pendingBashConfirmation = undefined;
        this.refreshBashGuardSnapshot();
        void this.append({
          type: "tool.confirmation.resolved",
          ...call,
          data: {
            ...request,
            decision: "cancelled",
            durationMs: Date.now() - startedAt,
          },
        }).finally(() => {
          reject(cancellationError(signal));
          this.notifyBashGuardListeners();
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingBashConfirmation = {
        ...request,
        startedAt,
        call,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      };
      this.refreshBashGuardSnapshot();
      this.notifyBashGuardListeners();
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private notifyBashGuardListeners(): void {
    for (const listener of this.bashGuardListeners) {
      listener();
    }
  }

  askUser(): AskUserSnapshot {
    return this.askUserSnapshot;
  }

  subscribeAskUser(listener: () => void): () => void {
    this.askUserListeners.add(listener);
    return () => this.askUserListeners.delete(listener);
  }

  async resolveAskUser(response: AskUserResolution): Promise<void> {
    const pending = this.pendingAskUser;
    if (pending === undefined) {
      throw new Error("No AskUser question is pending.");
    }
    let result: AskUserResponse;
    if (response.outcome === "selected") {
      if (!Number.isSafeInteger(response.selectedIndex)) {
        throw new Error("AskUser selectedIndex must be an integer.");
      }
      const option = pending.request.options[response.selectedIndex];
      if (option === undefined) {
        throw new Error("AskUser selectedIndex is out of range.");
      }
      result = { outcome: "selected", answer: option.description };
    } else {
      result = { outcome: "dismissed" };
    }
    this.pendingAskUser = undefined;
    this.askUserSnapshot = Object.freeze({});
    pending.removeAbortListener();
    await this.append({
      type: "tool.user_question.resolved",
      ...pending.call,
      data: {
        ...result,
        durationMs: Date.now() - pending.startedAt,
      },
    });
    pending.resolve(result);
    this.notifyAskUserListeners();
  }

  async requestUserAnswer(
    call: ToolCallIdentity,
    request: AskUserRequest,
    signal: AbortSignal,
  ): Promise<AskUserResponse> {
    if (this.pendingAskUser !== undefined) {
      throw new Error("Another AskUser question is already pending.");
    }
    if (this.pendingBashConfirmation !== undefined) {
      throw new Error("Cannot ask the user while a Bash confirmation is pending.");
    }
    if (signal.aborted) {
      throw cancellationError(signal);
    }
    const startedAt = Date.now();
    await this.append({
      type: "tool.user_question.requested",
      ...call,
      data: request,
    });
    return new Promise<AskUserResponse>((resolve, reject) => {
      const onAbort = () => {
        const pending = this.pendingAskUser;
        if (pending?.call.toolCallId !== call.toolCallId) {
          return;
        }
        this.pendingAskUser = undefined;
        this.askUserSnapshot = Object.freeze({});
        void this.append({
          type: "tool.user_question.resolved",
          ...call,
          data: {
            outcome: "cancelled",
            durationMs: Date.now() - startedAt,
          },
        }).finally(() => {
          reject(cancellationError(signal));
          this.notifyAskUserListeners();
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const immutableRequest = Object.freeze({
        question: request.question,
        options: Object.freeze(
          request.options.map((option) =>
            Object.freeze({ description: option.description }),
          ),
        ),
      });
      this.pendingAskUser = {
        request: immutableRequest,
        startedAt,
        call,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      };
      this.askUserSnapshot = Object.freeze({ pending: immutableRequest });
      this.notifyAskUserListeners();
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private notifyAskUserListeners(): void {
    for (const listener of this.askUserListeners) {
      listener();
    }
  }
}
