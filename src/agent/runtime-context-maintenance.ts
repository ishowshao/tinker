import { type ContextAutomationPolicy } from "../context/context-automation-policy";
import {
  ContextManager,
  ContextManagerError,
  type ContextCompactionResult,
  type ContextRetirementResult,
} from "../context/context-manager";
import type { AgentEventInput } from "../events/types";
import { type MessageId, type SessionId } from "../ids/runtime-id";
import { type UserMessage } from "../image/image-types";
import type { ContextPressure } from "../model/model-request-preflight";
import { SessionStore } from "../session/session-store";
import {
  ToolExecutionFatalError,
  type ContextStatusRawResult,
  type ContextSwapCandidatesRawResult,
  type ContextSwapRawResult,
} from "../tools/types";
import { type ContextUsageSnapshot } from "./context-meter";
import { contextPressureNoticeText } from "./context-pressure-notice";
import {
  boundedContextErrorCode,
  contextRetirementFinishedData,
  contextRevisionFinishedData,
} from "./runtime-context-events";
import {
  RuntimeEventAppendError,
  type RuntimeSessionFactoryDependencies,
  type RuntimeSessionState,
} from "./runtime-session-contracts";
import { type AgentTurnLedger } from "./session-ledger";
import type { ToolCall, TurnIdentity } from "./types";

type ContextMaintenanceLifecycle = {
  getState(): RuntimeSessionState;
  setState(state: "ready" | "executing" | "compacting" | "maintaining_context"): void;
  hasActiveTurn(): boolean;
  fault(error: unknown): void;
};
type ActiveContextTool = {
  turn: TurnIdentity;
  ledger: AgentTurnLedger;
  consumedThroughOrdinal: number;
};
type MaintenanceTriggers = Pick<
  RuntimeSessionFactoryDependencies,
  | "manualCompactionTrigger"
  | "manualRetirementTrigger"
  | "automaticCompactionTrigger"
  | "automaticRetirementTrigger"
>;
/** Owns maintenance scheduling; the runtime retains lifecycle state and event ordering. */
export class RuntimeContextMaintenance {
  private pendingAutomaticContextMaintenance = false;
  private pendingModelDirectedSwap?: Set<MessageId>;
  private modelDirectedSwapLease = false;
  private pressureNoticeSentThisTurn = false;
  constructor(
    private readonly sessionId: SessionId,
    private readonly store: Pick<
      SessionStore,
      "assertContextRevisionIdle" | "loadContextSnapshot"
    >,
    private readonly requireContextManager: () => ContextManager,
    private readonly requireContextAutomation: () => ContextAutomationPolicy,
    private readonly requireActiveContextTool: (
      call: ToolCall,
      expectedName: "ContextStatus" | "ContextSwapCandidates" | "ContextSwap",
    ) => ActiveContextTool,
    private readonly append: (event: AgentEventInput) => Promise<void>,
    private readonly lifecycle: ContextMaintenanceLifecycle,
    private readonly dependencies: MaintenanceTriggers,
  ) {}

  scheduleAutomaticMaintenance(): void {
    this.pendingAutomaticContextMaintenance = true;
  }

  finishTurn(): void {
    this.pendingAutomaticContextMaintenance = false;
    this.pendingModelDirectedSwap = undefined;
    this.modelDirectedSwapLease = false;
    this.pressureNoticeSentThisTurn = false;
  }

  async contextStatus(call: ToolCall): Promise<ContextStatusRawResult> {
    const active = this.requireActiveContextTool(call, "ContextStatus");
    try {
      const usage = this.requireContextManager().measureActive(
        active.turn.turnId,
        active.ledger,
      );
      return Object.freeze({
        ok: true,
        operation: "status",
        usedInputTokens: usage.usedInputTokens,
        inputBudgetTokens: usage.inputBudgetTokens,
        pressure: toolContextPressure(usage.pressure),
        triggerTokens: usage.triggerTokens,
        source: usage.source,
      });
    } catch (error) {
      return {
        ok: false,
        operation: "status",
        error: this.contextToolFailure("status", error),
      };
    }
  }

  async contextSwapCandidates(
    call: ToolCall,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<ContextSwapCandidatesRawResult> {
    const active = this.requireActiveContextTool(call, "ContextSwapCandidates");
    try {
      const result = this.requireContextManager().listActiveSwapCandidates({
        turnId: active.turn.turnId,
        consumedThroughOrdinal: active.consumedThroughOrdinal,
        activeLedger: active.ledger,
        limit: page.limit,
        offset: page.offset,
      });
      if (result.total > 0 && result.usage.pressure !== "normal") {
        this.modelDirectedSwapLease = true;
      }
      return Object.freeze({
        ok: true,
        operation: "candidates",
        total: result.total,
        candidates: result.candidates,
      });
    } catch (error) {
      return {
        ok: false,
        operation: "candidates",
        error: this.contextToolFailure("candidate listing", error),
      };
    }
  }

  async contextSwap(
    call: ToolCall,
    selection: { readonly candidateIds: readonly MessageId[] },
  ): Promise<ContextSwapRawResult> {
    const active = this.requireActiveContextTool(call, "ContextSwap");
    try {
      const result = this.requireContextManager().validateActiveSwapSelection({
        turnId: active.turn.turnId,
        consumedThroughOrdinal: active.consumedThroughOrdinal,
        activeLedger: active.ledger,
        messageIds: selection.candidateIds,
      });
      if (result.scheduled.length === 0) {
        return Object.freeze({
          ok: false,
          operation: "swap",
          scheduled: Object.freeze([]),
          rejected: result.rejected,
        });
      }
      const pending = (this.pendingModelDirectedSwap ??= new Set<MessageId>());
      for (const candidate of result.scheduled) pending.add(candidate.candidateId);
      this.modelDirectedSwapLease = false;
      return Object.freeze({
        ok: true,
        operation: "swap",
        scheduled: result.scheduled,
        rejected: result.rejected,
        note: "Swap executes when this iteration's tool frames close.",
      });
    } catch (error) {
      return {
        ok: false,
        operation: "swap",
        scheduled: [],
        rejected: [],
        error: this.contextToolFailure("swap scheduling", error),
      };
    }
  }

  private contextToolFailure(operation: string, error: unknown): string {
    if (error instanceof ContextManagerError && !error.fatal) {
      return `Context ${operation} failed (${boundedContextErrorCode(error.code)}).`;
    }
    throw new ToolExecutionFatalError(
      `Context ${operation} required canonical session state that could not be read safely.`,
      { cause: error },
    );
  }

  async performCompactContext(): Promise<ContextCompactionResult> {
    if (this.lifecycle.getState() !== "ready") {
      throw new Error(
        `Cannot compact context while RuntimeSession is ${this.lifecycle.getState()}.`,
      );
    }
    if (this.lifecycle.hasActiveTurn()) {
      throw new Error("Cannot compact context while a turn is active.");
    }
    this.store.assertContextRevisionIdle();
    this.lifecycle.setState("compacting");
    let started = false;
    try {
      await this.append({
        type: "context.revision.started",
        sessionId: this.sessionId,
        data: {
          strategy: "swap",
          reason: "manual",
          policyVersion: "swap-only-v1",
          rendererFormat: "swap-observation-v1",
        },
      });
      started = true;
      const result = await this.requireContextManager().compact(
        this.dependencies.manualCompactionTrigger(),
      );
      await this.append({
        type: "context.revision.finished",
        sessionId: this.sessionId,
        data: contextRevisionFinishedData(result),
      });
      if (this.lifecycle.getState() === "compacting") {
        this.lifecycle.setState("ready");
      }
      return result;
    } catch (error) {
      if (started && !(error instanceof RuntimeEventAppendError)) {
        const failure =
          error instanceof ContextManagerError
            ? error
            : new ContextManagerError(
                "activate",
                error instanceof Error ? error.name : "CONTEXT_COMPACTION_FAILED",
                true,
                false,
                "Context compaction failed.",
                { cause: error },
              );
        await this.append({
          type: "context.revision.failed",
          sessionId: this.sessionId,
          data: {
            strategy: "swap",
            reason: "manual",
            stage: failure.stage,
            errorCode: boundedContextErrorCode(failure.code),
            error: `Context compaction failed at ${failure.stage}.`,
          },
        }).catch(() => undefined);
      }
      if (!(error instanceof ContextManagerError) || error.fatal) {
        this.lifecycle.fault(error);
      } else if (this.lifecycle.getState() === "compacting") {
        this.lifecycle.setState("ready");
      }
      throw error;
    }
  }

  async performRetireContext(): Promise<ContextRetirementResult> {
    if (this.lifecycle.getState() !== "ready") {
      throw new Error(
        `Cannot retire context prefix while RuntimeSession is ${this.lifecycle.getState()}.`,
      );
    }
    if (this.lifecycle.hasActiveTurn()) {
      throw new Error("Cannot retire context prefix while a turn is active.");
    }
    this.store.assertContextRevisionIdle();
    const baseRevisionNumber = this.store.loadContextSnapshot().revision.revisionNumber;
    this.lifecycle.setState("compacting");
    let started = false;
    try {
      await this.append({
        type: "context.revision.started",
        sessionId: this.sessionId,
        data: {
          strategy: "retire_prefix",
          reason: "manual",
          policyVersion: "recall-first-retirement-v1",
          baseRevisionNumber,
        },
      });
      started = true;
      const result = await this.requireContextManager().retirePrefix(
        this.dependencies.manualRetirementTrigger(),
      );
      await this.append({
        type: "context.revision.finished",
        sessionId: this.sessionId,
        data: contextRetirementFinishedData(result),
      });
      if (this.lifecycle.getState() === "compacting") {
        this.lifecycle.setState("ready");
      }
      return result;
    } catch (error) {
      if (started && !(error instanceof RuntimeEventAppendError)) {
        const failure =
          error instanceof ContextManagerError
            ? error
            : new ContextManagerError(
                "activate",
                error instanceof Error ? error.name : "CONTEXT_RETIREMENT_FAILED",
                true,
                false,
                "Context prefix retirement failed.",
                { cause: error },
              );
        await this.append({
          type: "context.revision.failed",
          sessionId: this.sessionId,
          data: {
            strategy: "retire_prefix",
            reason: "manual",
            stage: failure.stage,
            errorCode: boundedContextErrorCode(failure.code),
            error: `Context prefix retirement failed at ${failure.stage}.`,
            committed: failure.committed,
          },
        }).catch(() => undefined);
      }
      if (!(error instanceof ContextManagerError) || error.fatal) {
        this.lifecycle.fault(error);
      } else if (this.lifecycle.getState() === "compacting") {
        this.lifecycle.setState("ready");
      }
      throw error;
    }
  }

  async evaluateClosedTurnContextPressure(): Promise<void> {
    const automation = this.requireContextAutomation();
    if (!automation.automaticSwap) return;

    const snapshot = this.requireContextManager().measureCurrent();
    await this.append({
      type: "context.usage.updated",
      sessionId: this.sessionId,
      data: { phase: "turn_close", snapshot },
    });
    if (snapshot.pressure !== "normal") {
      this.pendingAutomaticContextMaintenance = true;
    }
  }

  async performAutomaticContextMaintenance(): Promise<void> {
    if (!this.pendingAutomaticContextMaintenance) return;
    this.pendingAutomaticContextMaintenance = false;
    const automation = this.requireContextAutomation();
    if (!automation.automaticSwap) return;
    if (this.lifecycle.getState() !== "executing") {
      throw new Error(
        `Cannot run automatic context maintenance while RuntimeSession is ${this.lifecycle.getState()}.`,
      );
    }
    this.store.assertContextRevisionIdle();
    const automationPolicyId = automation.policyId;
    this.lifecycle.setState("maintaining_context");
    try {
      const swap = await this.performAutomaticCompaction(automationPolicyId);
      if (swap === undefined) return;
      if (automation.automaticPrefixRetirement && automaticSwapNeedsRetirement(swap)) {
        await this.performAutomaticRetirement(automationPolicyId);
      }
    } finally {
      if (this.lifecycle.getState() === "maintaining_context") {
        this.lifecycle.setState("executing");
      }
    }
  }

  async performActiveTurnContextMaintenance(input: {
    turn: TurnIdentity;
    consumedThroughOrdinal: number;
    ledger: AgentTurnLedger;
  }): Promise<void> {
    if (this.lifecycle.getState() !== "executing") {
      throw new Error(
        `Cannot maintain active-turn context while RuntimeSession is ${this.lifecycle.getState()}.`,
      );
    }
    const pendingModelDirectedSwap = this.pendingModelDirectedSwap;
    this.pendingModelDirectedSwap = undefined;

    const automation = this.requireContextAutomation();
    const manager = this.requireContextManager();
    this.pendingAutomaticContextMaintenance = false;

    let suppressAutomaticSwap = this.modelDirectedSwapLease;
    this.modelDirectedSwapLease = false;

    if (pendingModelDirectedSwap !== undefined) {
      suppressAutomaticSwap = false;
      this.lifecycle.setState("maintaining_context");
      try {
        await this.performModelDirectedCompaction({
          turn: input.turn,
          consumedThroughOrdinal: input.consumedThroughOrdinal,
          ledger: input.ledger,
          messageIds: Object.freeze([...pendingModelDirectedSwap]),
        });
      } finally {
        if (this.lifecycle.getState() === "maintaining_context") {
          this.lifecycle.setState("executing");
        }
      }
    }

    let measured: ContextUsageSnapshot | undefined;
    if (
      pendingModelDirectedSwap === undefined &&
      (suppressAutomaticSwap ||
        !this.pressureNoticeSentThisTurn ||
        automation.automaticSwap)
    ) {
      measured = manager.measureCurrent(input.turn.turnId, input.ledger);
      if (!this.pressureNoticeSentThisTurn && measured.pressure !== "normal") {
        await this.injectContextPressureNotice({
          turn: input.turn,
          ledger: input.ledger,
          usage: measured,
          automaticSwapEnabled: automation.automaticSwap,
        });
        this.pressureNoticeSentThisTurn = true;
        suppressAutomaticSwap = true;
      }
      if (measured.pressure === "blocked") {
        // Emergency override: a lease or notice must never hold automatic
        // compaction past the budget line; the next preflight would fail the
        // turn before the model could act.
        suppressAutomaticSwap = false;
      }
    }

    if (suppressAutomaticSwap || !automation.automaticSwap) {
      return;
    }

    this.lifecycle.setState("maintaining_context");
    try {
      const usage = measured ?? manager.measureCurrent(input.turn.turnId, input.ledger);
      if (usage.pressure === "normal") return;

      const automationPolicyId = automation.policyId;
      const compactionTrigger = {
        kind: "runtime_pressure",
        activeTurn: {
          turnId: input.turn.turnId,
          consumedThroughOrdinal: input.consumedThroughOrdinal,
        },
      } as const;
      await this.append({
        type: "context.revision.started",
        sessionId: this.sessionId,
        data: {
          strategy: "swap",
          reason: "runtime_pressure",
          policyVersion: "swap-only-v1",
          rendererFormat: "swap-observation-v1",
          automationPolicyId,
        },
      });
      let swap: ContextCompactionResult;
      try {
        swap = await manager.compact(compactionTrigger, input.ledger);
        await this.append({
          type: "context.revision.finished",
          sessionId: this.sessionId,
          data: contextRevisionFinishedData(
            swap,
            "runtime_pressure",
            automationPolicyId,
          ),
        });
      } catch (error) {
        const failure = automaticContextFailure(error, "compaction");
        await this.append({
          type: "context.revision.failed",
          sessionId: this.sessionId,
          data: {
            strategy: "swap",
            reason: "runtime_pressure",
            stage: failure.stage,
            errorCode: boundedContextErrorCode(failure.code),
            error: `Automatic context compaction failed at ${failure.stage}.`,
            automationPolicyId,
          },
        }).catch(() => undefined);
        if (failure.fatal) throw error;
        return;
      }

      if (
        !automation.automaticPrefixRetirement ||
        !automaticSwapNeedsRetirement(swap)
      ) {
        return;
      }

      await this.append({
        type: "context.revision.started",
        sessionId: this.sessionId,
        data: {
          strategy: "retire_prefix",
          reason: "runtime_pressure",
          policyVersion: "recall-first-retirement-v1",
          baseRevisionNumber: this.store.loadContextSnapshot().revision.revisionNumber,
          automationPolicyId,
        },
      });
      try {
        const retirement = await manager.retirePrefix(
          {
            kind: "runtime_pressure",
            activeTurnId: input.turn.turnId,
          },
          input.ledger,
        );
        await this.append({
          type: "context.revision.finished",
          sessionId: this.sessionId,
          data: contextRetirementFinishedData(
            retirement,
            "runtime_pressure",
            automationPolicyId,
          ),
        });
      } catch (error) {
        const failure = automaticContextFailure(error, "retirement");
        await this.append({
          type: "context.revision.failed",
          sessionId: this.sessionId,
          data: {
            strategy: "retire_prefix",
            reason: "runtime_pressure",
            stage: failure.stage,
            errorCode: boundedContextErrorCode(failure.code),
            error: `Automatic context retirement failed at ${failure.stage}.`,
            committed: failure.committed,
            automationPolicyId,
          },
        }).catch(() => undefined);
        if (failure.fatal) throw error;
      }
    } finally {
      if (this.lifecycle.getState() === "maintaining_context") {
        this.lifecycle.setState("executing");
      }
    }
  }

  private async injectContextPressureNotice(input: {
    turn: TurnIdentity;
    ledger: AgentTurnLedger;
    usage: ContextUsageSnapshot;
    automaticSwapEnabled: boolean;
  }): Promise<void> {
    const userMessage: UserMessage = Object.freeze({
      role: "user",
      content: contextPressureNoticeText({
        usage: input.usage,
        toolPressure: toolContextPressure(input.usage.pressure) as "high" | "critical",
        automaticSwapEnabled: input.automaticSwapEnabled,
      }),
    });
    const records = input.ledger.appendSteeringUserMessages([userMessage]);
    const record = records[0];
    if (records.length !== 1 || record === undefined) {
      throw new Error("Pressure notice steering did not append exactly one message.");
    }
    await this.append({
      type: "context.pressure_notice.sent",
      ...input.turn,
      data: {
        usedInputTokens: input.usage.usedInputTokens,
        inputBudgetTokens: input.usage.inputBudgetTokens,
        triggerTokens: input.usage.triggerTokens,
        pressure: input.usage.pressure === "blocked" ? "blocked" : "triggered",
        automaticSwapEnabled: input.automaticSwapEnabled,
        ordinal: record.ordinal,
      },
    });
  }

  private async performModelDirectedCompaction(input: {
    turn: TurnIdentity;
    consumedThroughOrdinal: number;
    ledger: AgentTurnLedger;
    messageIds: readonly MessageId[];
  }): Promise<void> {
    await this.append({
      type: "context.revision.started",
      sessionId: this.sessionId,
      data: {
        strategy: "swap",
        reason: "model_directed",
        policyVersion: "swap-only-v1",
        rendererFormat: "swap-observation-v1",
      },
    });
    try {
      const result = await this.requireContextManager().compact(
        {
          kind: "model_directed",
          messageIds: input.messageIds,
          activeTurn: {
            turnId: input.turn.turnId,
            consumedThroughOrdinal: input.consumedThroughOrdinal,
          },
        },
        input.ledger,
      );
      await this.append({
        type: "context.revision.finished",
        sessionId: this.sessionId,
        data: contextRevisionFinishedData(result, "model_directed"),
      });
    } catch (error) {
      const failure = automaticContextFailure(error, "compaction");
      await this.append({
        type: "context.revision.failed",
        sessionId: this.sessionId,
        data: {
          strategy: "swap",
          reason: "model_directed",
          stage: failure.stage,
          errorCode: boundedContextErrorCode(failure.code),
          error: `Model-directed context compaction failed at ${failure.stage}.`,
        },
      }).catch(() => undefined);
      if (failure.fatal) throw error;
    }
  }

  private async performAutomaticCompaction(
    automationPolicyId: string,
  ): Promise<ContextCompactionResult | undefined> {
    let started = false;
    try {
      await this.append({
        type: "context.revision.started",
        sessionId: this.sessionId,
        data: {
          strategy: "swap",
          reason: "runtime_pressure",
          policyVersion: "swap-only-v1",
          rendererFormat: "swap-observation-v1",
          automationPolicyId,
        },
      });
      started = true;
      const result = await this.requireContextManager().compact(
        this.dependencies.automaticCompactionTrigger(),
      );
      await this.append({
        type: "context.revision.finished",
        sessionId: this.sessionId,
        data: contextRevisionFinishedData(
          result,
          "runtime_pressure",
          automationPolicyId,
        ),
      });
      return result;
    } catch (error) {
      if (started && !(error instanceof RuntimeEventAppendError)) {
        const failure = automaticContextFailure(error, "compaction");
        await this.append({
          type: "context.revision.failed",
          sessionId: this.sessionId,
          data: {
            strategy: "swap",
            reason: "runtime_pressure",
            stage: failure.stage,
            errorCode: boundedContextErrorCode(failure.code),
            error: `Automatic context compaction failed at ${failure.stage}.`,
            automationPolicyId,
          },
        }).catch(() => undefined);
      }
      if (error instanceof ContextManagerError && !error.fatal) {
        return undefined;
      }
      throw error;
    }
  }

  private async performAutomaticRetirement(
    automationPolicyId: string,
  ): Promise<ContextRetirementResult | undefined> {
    const baseRevisionNumber = this.store.loadContextSnapshot().revision.revisionNumber;
    let started = false;
    try {
      await this.append({
        type: "context.revision.started",
        sessionId: this.sessionId,
        data: {
          strategy: "retire_prefix",
          reason: "runtime_pressure",
          policyVersion: "recall-first-retirement-v1",
          baseRevisionNumber,
          automationPolicyId,
        },
      });
      started = true;
      const result = await this.requireContextManager().retirePrefix(
        this.dependencies.automaticRetirementTrigger(),
      );
      await this.append({
        type: "context.revision.finished",
        sessionId: this.sessionId,
        data: contextRetirementFinishedData(
          result,
          "runtime_pressure",
          automationPolicyId,
        ),
      });
      return result;
    } catch (error) {
      if (started && !(error instanceof RuntimeEventAppendError)) {
        const failure = automaticContextFailure(error, "retirement");
        await this.append({
          type: "context.revision.failed",
          sessionId: this.sessionId,
          data: {
            strategy: "retire_prefix",
            reason: "runtime_pressure",
            stage: failure.stage,
            errorCode: boundedContextErrorCode(failure.code),
            error: `Automatic context retirement failed at ${failure.stage}.`,
            committed: failure.committed,
            automationPolicyId,
          },
        }).catch(() => undefined);
      }
      if (error instanceof ContextManagerError && !error.fatal) {
        return undefined;
      }
      throw error;
    }
  }
}
function automaticSwapNeedsRetirement(result: ContextCompactionResult): boolean {
  return (
    result.outcome === "no_eligible_candidates" ||
    result.outcome === "insufficient_candidates"
  );
}

function automaticContextFailure(
  error: unknown,
  strategy: "compaction" | "retirement",
): ContextManagerError {
  return error instanceof ContextManagerError
    ? error
    : new ContextManagerError(
        "activate",
        error instanceof Error
          ? error.name
          : `AUTOMATIC_CONTEXT_${strategy.toUpperCase()}_FAILED`,
        true,
        false,
        `Automatic context ${strategy} failed.`,
        { cause: error },
      );
}

function toolContextPressure(
  pressure: ContextPressure,
): "normal" | "high" | "critical" {
  return pressure === "triggered"
    ? "high"
    : pressure === "blocked"
      ? "critical"
      : "normal";
}
