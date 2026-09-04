import type { AgentEventInput } from "../events/types";
import { validateUserMessage, type UserMessage } from "../image/image-types";
import {
  type AcceptedTurn,
  type ExecuteTurnInput,
  type PromptSchedulerSnapshot,
  type QueueFollowUpResult,
  type RuntimeSessionState,
} from "./runtime-session-contracts";
import { type AgentTurnLedger } from "./session-ledger";
import type { RunAgentResult, TurnIdentity } from "./types";
import { projectUserMessage } from "./user-prompt-projection";

type QueuedPrompt = {
  readonly userMessage: UserMessage;
};
const MAX_QUEUED_PROMPTS = 8;
const MAX_QUEUED_PROMPT_TEXT_BYTES = 64 * 1024;
/** Owns queued prompts and their execution chain; admission stays in the runtime. */
export class RuntimePromptScheduler {
  private executionChainRunning = false;
  private readonly queuedPrompts: QueuedPrompt[] = [];
  private promptSchedulerSnapshot: PromptSchedulerSnapshot = Object.freeze({
    state: "idle",
    pendingCount: 0,
  });
  private readonly promptSchedulerListeners = new Set<() => void>();
  constructor(
    private readonly getState: () => RuntimeSessionState,
    private readonly getActiveTurn: () => { turn: TurnIdentity } | undefined,
    private readonly admitSingleTurn: (
      input: ExecuteTurnInput,
    ) => Promise<AcceptedTurn>,
    private readonly append: (event: AgentEventInput) => Promise<void>,
  ) {}

  get isRunning(): boolean {
    return this.executionChainRunning;
  }

  get pendingCount(): number {
    return this.queuedPrompts.length;
  }

  clear(): void {
    this.queuedPrompts.splice(0);
    this.executionChainRunning = false;
    this.notifyPromptScheduler();
  }

  promptScheduler(): PromptSchedulerSnapshot {
    return this.promptSchedulerSnapshot;
  }

  subscribePromptScheduler(listener: () => void): () => void {
    this.promptSchedulerListeners.add(listener);
    return () => this.promptSchedulerListeners.delete(listener);
  }

  queueFollowUp(userMessage: UserMessage): QueueFollowUpResult {
    if (!this.executionChainRunning) {
      throw new Error("Cannot queue a follow-up while no execution chain is running.");
    }
    validateUserMessage(userMessage);
    if (userMessage.attachments !== undefined) {
      throw new Error("Active-turn follow-ups do not support image attachments.");
    }
    if (this.queuedPrompts.length >= MAX_QUEUED_PROMPTS) {
      throw new Error(`At most ${MAX_QUEUED_PROMPTS} follow-ups may be queued.`);
    }
    const queuedBytes = this.queuedPrompts.reduce(
      (total, entry) => total + Buffer.byteLength(entry.userMessage.content, "utf8"),
      0,
    );
    const nextBytes = Buffer.byteLength(userMessage.content, "utf8");
    if (queuedBytes + nextBytes > MAX_QUEUED_PROMPT_TEXT_BYTES) {
      throw new Error("Queued follow-ups exceed the 64 KiB text limit.");
    }
    this.queuedPrompts.push({
      userMessage: Object.freeze({ ...userMessage }),
    });
    this.notifyPromptScheduler();
    const activeTurn = this.getActiveTurn();
    return Object.freeze({
      kind: "queued",
      pendingCount: this.queuedPrompts.length,
      ...(activeTurn === undefined ? {} : { activeTurnId: activeTurn.turn.turnId }),
    });
  }

  async admitTurn(input: ExecuteTurnInput): Promise<AcceptedTurn> {
    if (this.executionChainRunning) {
      throw new Error(
        `Cannot execute a turn while RuntimeSession is ${this.getState()}; a prompt chain is already executing.`,
      );
    }
    this.executionChainRunning = true;
    this.notifyPromptScheduler();
    try {
      const accepted = await this.admitSingleTurn(input);
      const completion = this.continueExecutionChain(accepted.completion, input.signal);
      return Object.freeze({ ...accepted, completion });
    } catch (error) {
      this.executionChainRunning = false;
      this.notifyPromptScheduler();
      throw error;
    }
  }

  private async continueExecutionChain(
    initialCompletion: Promise<RunAgentResult>,
    signal: AbortSignal,
  ): Promise<RunAgentResult> {
    let completion = initialCompletion;
    let finalResult: RunAgentResult;
    try {
      for (;;) {
        finalResult = await completion;
        if (finalResult.status !== "completed" || this.queuedPrompts.length === 0) {
          return finalResult;
        }
        const next = this.queuedPrompts[0];
        if (next === undefined) {
          return finalResult;
        }
        const accepted = await this.admitSingleTurn({
          userMessage: next.userMessage,
          signal,
        });
        this.queuedPrompts.shift();
        this.notifyPromptScheduler();
        completion = accepted.completion;
      }
    } finally {
      this.queuedPrompts.splice(0);
      this.executionChainRunning = false;
      this.notifyPromptScheduler();
    }
  }

  notifyPromptScheduler(): void {
    const activeTurn = this.getActiveTurn();
    this.promptSchedulerSnapshot = Object.freeze({
      state: this.executionChainRunning ? "running" : "idle",
      ...(activeTurn === undefined ? {} : { activeTurnId: activeTurn.turn.turnId }),
      pendingCount: this.queuedPrompts.length,
    });
    for (const listener of this.promptSchedulerListeners) listener();
  }

  async applyQueuedSteering(input: {
    turn: TurnIdentity;
    ledger: AgentTurnLedger;
  }): Promise<number> {
    const activeTurn = this.getActiveTurn();
    if (activeTurn?.turn.turnId !== input.turn.turnId) {
      throw new Error("Cannot apply steering outside the active turn.");
    }
    if (this.queuedPrompts.length === 0) return 0;
    const drained = this.queuedPrompts.splice(0);
    const records = input.ledger.appendSteeringUserMessages(
      drained.map((entry) => entry.userMessage),
    );
    this.notifyPromptScheduler();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const queued = drained[index];
      if (record === undefined || queued === undefined) {
        throw new Error("Steering ledger result did not match the drained queue.");
      }
      await this.append({
        type: "turn.steering.applied",
        ...input.turn,
        data: {
          userPrompt: projectUserMessage(queued.userMessage),
          ordinal: record.ordinal,
        },
      });
    }
    return records.length;
  }
}
