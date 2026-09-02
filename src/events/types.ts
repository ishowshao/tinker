import type {
  IterationIdentity,
  ToolCall,
  ToolCallIdentity,
  TurnCancellation,
  TurnIdentity,
} from "../agent/types";
import type { UserPromptProjection } from "../agent/user-prompt-projection";
import type {
  IterationId,
  ProtocolFrameId,
  SessionId,
  ToolCallId,
  TurnId,
} from "../ids/runtime-id";
import type {
  ModelRequestOutput,
  ProviderResponseDiagnostics,
  ProviderResponseErrorCode,
} from "../model/model-client";
import type {
  ModelContextBudget,
  ModelContextProfile,
} from "../model/model-context-profile";
import type { ContextUsageSnapshot } from "../agent/context-meter";
import type { ShellTaskSnapshot } from "../tools/bash-task";
import type { ToolObservation } from "../observation/observation-builder";
import type { ToolRawResult } from "../tools/types";
import type {
  ProjectInstructionFileName,
  ProjectInstructionManifest,
} from "../instructions/project-instructions";
import type { ContextSurfaceComponent } from "../context/context-surface";

export type SessionStartedData = {
  workspaceRoot: string;
  model: string;
  profileName?: string;
  maxIterations: number;
  includeReasoningContent: boolean;
  contextProfile: ModelContextProfile;
  contextBudget: ModelContextBudget;
  projectInstructions: {
    instruction?: ProjectInstructionManifest;
  };
};

export type ContextUsageUpdatedData = {
  phase: "initial" | "preflight" | "measured" | "revision";
  snapshot: ContextUsageSnapshot;
};

export type ContextRevisionStartedData =
  | {
      strategy: "swap";
      reason: "manual" | "runtime_pressure" | "model_directed";
      policyVersion: "swap-only-v1";
      rendererFormat: "swap-observation-v1";
      qualificationId?: string;
    }
  | {
      strategy: "surface_refresh";
      reason: "resume";
      baseRevisionNumber: number;
      changed: readonly ContextSurfaceComponent[];
    }
  | {
      strategy: "retire_prefix";
      reason: "manual" | "runtime_pressure";
      policyVersion: "recall-first-retirement-v1";
      baseRevisionNumber: number;
      qualificationId?: string;
    }
  | {
      strategy: "skills_update";
      reason: "activation" | "resume";
      baseRevisionNumber: number;
      names: readonly string[];
    };

export type ContextRevisionFinishedData =
  | {
      strategy: "swap";
      reason: "manual" | "runtime_pressure" | "model_directed";
      policyVersion: "swap-only-v1";
      outcome:
        | "below_trigger"
        | "below_target"
        | "no_eligible_candidates"
        | "target_reached"
        | "insufficient_candidates";
      baseRevisionNumber: number;
      revisionNumber?: number;
      addedOverrideCount: number;
      activeOverrideCount: number;
      originalObservationBytes: number;
      projectedObservationBytes: number;
      rawTokensBefore: number;
      rawTokensAfter?: number;
      guardedTokensBefore: number;
      guardedTokensAfter?: number;
      targetTokens: number;
      planHash?: string;
      durationMs: number;
      qualificationId?: string;
    }
  | {
      strategy: "surface_refresh";
      reason: "resume";
      baseRevisionNumber: number;
      revisionNumber: number;
      changed: readonly ContextSurfaceComponent[];
      toolCountBefore: number;
      toolCountAfter: number;
      measuredAnchorCleared: true;
      durationMs: number;
    }
  | {
      strategy: "retire_prefix";
      reason: "manual" | "runtime_pressure";
      policyVersion: "recall-first-retirement-v1";
      outcome:
        | "below_target"
        | "no_complete_prefix"
        | "target_reached"
        | "retirement_floor";
      baseRevisionNumber: number;
      revisionNumber?: number;
      previousKeepFromOrdinal: number;
      keepFromOrdinal: number;
      retiredTurnCount: number;
      retiredFrameCount: number;
      retiredMessageCount: number;
      activeOverrideCount: number;
      rawTokensBefore?: number;
      rawTokensAfter?: number;
      guardedTokensBefore: number;
      guardedTokensAfter?: number;
      targetTokens: number;
      planHash?: string;
      planningDurationMs: number;
      validationDurationMs?: number;
      transactionDurationMs?: number;
      activationDurationMs?: number;
      durationMs: number;
      qualificationId?: string;
    }
  | {
      strategy: "skills_update";
      reason: "activation" | "resume";
      baseRevisionNumber: number;
      revisionNumber: number;
      activated: readonly string[];
      refreshed: readonly string[];
      deactivated: readonly string[];
      unavailable: readonly string[];
      addedOverrideCount: number;
      measuredAnchorCleared: true;
      durationMs: number;
    };

export type ContextRevisionFailedData =
  | {
      strategy: "swap";
      reason: "manual" | "runtime_pressure" | "model_directed";
      stage: "snapshot" | "plan" | "validate" | "commit" | "activate";
      errorCode: string;
      error: string;
      qualificationId?: string;
    }
  | {
      strategy: "surface_refresh";
      reason: "resume";
      stage: "prepare" | "commit" | "activate";
      errorCode: string;
      error: string;
      committed: boolean;
    }
  | {
      strategy: "retire_prefix";
      reason: "manual" | "runtime_pressure";
      stage: "snapshot" | "plan" | "validate" | "commit" | "activate";
      errorCode: string;
      error: string;
      committed: boolean;
      qualificationId?: string;
    }
  | {
      strategy: "skills_update";
      reason: "activation" | "resume";
      stage: "prepare" | "commit" | "activate";
      errorCode: string;
      error: string;
      committed: boolean;
    };

export type SkillsCatalogLoadedData = {
  availableCount: number;
  projectCount: number;
  userCount: number;
  activeNames: readonly string[];
  shadowedNames: readonly string[];
};

export type SkillsUpdatedData = {
  reason: "activation" | "resume";
  activated: readonly string[];
  refreshed: readonly string[];
  deactivated: readonly string[];
  unavailable: readonly string[];
  revisionNumber?: number;
};

export type ContextShadowPlannedData = {
  policyVersion: "swap-only-v1";
  trigger: "runtime_pressure" | "benchmark_forced";
  outcome:
    | "below_trigger"
    | "below_target"
    | "no_eligible_candidates"
    | "target_reached"
    | "insufficient_candidates";
  canonicalMessageCount: number;
  eligibleCandidateCount: number;
  selectedCandidateCount: number;
  excludedByReason: Record<string, number>;
  selectedByRawKind: Record<string, number>;
  originalObservationBytes: number;
  projectedObservationBytes: number;
  rawTokensBefore: number;
  rawTokensAfter?: number;
  guardedTokensBefore: number;
  guardedTokensAfter?: number;
  targetTokens: number;
  planHash?: string;
  durationMs: number;
};

export type ContextShadowFailedData = {
  policyVersion: "swap-only-v1";
  stage: "candidate" | "render" | "prepare" | "validate";
  errorCode: string;
  error: string;
};

export type SessionFinishedData = {
  reason:
    | "oneshot_complete"
    | "tui_exit"
    | "session_switch"
    | "runner_failed"
    | "initialization_failed";
  error?: string;
};

export type SessionResumedData = {
  openCount: number;
  recoveredTurnId?: TurnId;
  recoveredFrameId?: ProtocolFrameId;
  syntheticCompletionCount: number;
  recallIndexRebuilt: boolean;
  contextProfile: ModelContextProfile;
  contextBudget: ModelContextBudget;
  projectInstructionFile?: ProjectInstructionFileName;
  contextRefresh?: {
    previousRevisionNumber: number;
    revisionNumber: number;
    changed: readonly ContextSurfaceComponent[];
    toolCountBefore: number;
    toolCountAfter: number;
  };
};

export type InterruptedFrameRecoveredData = {
  turnId: TurnId;
  frameId: ProtocolFrameId;
  syntheticCompletionCount: number;
};

export type TurnFinishedData = {
  status: "completed";
  finalText: string;
  lastIteration: IterationIdentity;
  messageCount: number;
};

export type ModelRequestAttemptData = {
  attemptNumber: number;
  maxAttempts: number;
};

export type ModelRequestFailureCode = ProviderResponseErrorCode;

export type ModelRequestFailedData = ModelRequestAttemptData & {
  code: ModelRequestFailureCode;
  retryDisposition: "scheduled" | "not_retryable" | "exhausted";
  retryDelayMs?: number;
  provider: string;
  model: string;
  error: string;
  diagnostics?: ProviderResponseDiagnostics;
};

export type AgentEventDataMap = {
  "session.started": SessionStartedData;
  "session.resumed": SessionResumedData;
  "session.interrupted_frame_recovered": InterruptedFrameRecoveredData;
  "session.finished": SessionFinishedData;
  "turn.started": { userPrompt: UserPromptProjection };
  "turn.steering.applied": {
    userPrompt: UserPromptProjection;
    ordinal: number;
  };
  "turn.finished": TurnFinishedData;
  "turn.failed": { error: string };
  "turn.cancelled": { cancellation: TurnCancellation };
  "agent.iteration.started": { iterationNumber: number };
  "model.request.started": ModelRequestAttemptData;
  "model.request.failed": ModelRequestFailedData;
  "model.request.finished": ModelRequestAttemptData & {
    output: ModelRequestOutput;
  };
  "context.usage.updated": ContextUsageUpdatedData;
  "context.revision.started": ContextRevisionStartedData;
  "context.revision.finished": ContextRevisionFinishedData;
  "context.revision.failed": ContextRevisionFailedData;
  "context.shadow.planned": ContextShadowPlannedData;
  "context.shadow.failed": ContextShadowFailedData;
  "skills.catalog.loaded": SkillsCatalogLoadedData;
  "skills.updated": SkillsUpdatedData;
  "assistant.progress": { content: string };
  "tool.started": { call: ToolCall };
  "tool.raw_result": { call: ToolCall; raw: ToolRawResult };
  "tool.finished": { call: ToolCall; ok: boolean };
  "tool.observation": { call: ToolCall; observation: ToolObservation };
  "tool.confirmation.requested": {
    command: string;
    reason: string;
  };
  "tool.confirmation.resolved": {
    command: string;
    reason: string;
    decision: "allow" | "deny" | "cancelled";
    durationMs: number;
  };
  "agent.iteration.finished": {
    outcome: "continue" | "completed";
    toolCallCount: number;
  };
  "bash.task.backgrounded": { task: ShellTaskSnapshot };
  "bash.task.stopping": { task: ShellTaskSnapshot };
  "bash.task.finished": { task: ShellTaskSnapshot };
  "mcp.server.connected": { serverName: string; toolCount: number };
  "mcp.server.failed": { serverName: string; error: string };
  "diagnostic.sink_failed": {
    sinkName: string;
    failedEventType: AgentEventType;
    error: string;
  };
};

export type AgentEventType = keyof AgentEventDataMap;

type AgentEventEnvelope<TType extends AgentEventType> = {
  type: TType;
  sessionId: SessionId;
  turnId?: TurnId;
  iterationId?: IterationId;
  toolCallId?: ToolCallId;
  turnNumber?: number;
  iterationNumber?: number;
  toolCallNumber?: number;
  eventSequence: number;
  timestamp: string;
  data: AgentEventDataMap[TType];
};

export type AgentEvent = {
  [TType in AgentEventType]: AgentEventEnvelope<TType>;
}[AgentEventType];

type SessionEventInput<TType extends AgentEventType> = {
  type: TType;
  sessionId: SessionId;
  data: AgentEventDataMap[TType];
};

type TurnEventInput<TType extends AgentEventType> = TurnIdentity & {
  type: TType;
  data: AgentEventDataMap[TType];
};

type IterationEventInput<TType extends AgentEventType> = IterationIdentity & {
  type: TType;
  data: AgentEventDataMap[TType];
};

type ToolEventInput<TType extends AgentEventType> = ToolCallIdentity & {
  type: TType;
  data: AgentEventDataMap[TType];
};

export type AgentEventInput =
  | SessionEventInput<
      | "session.started"
      | "session.resumed"
      | "session.interrupted_frame_recovered"
      | "session.finished"
      | "context.usage.updated"
      | "context.revision.started"
      | "context.revision.finished"
      | "context.revision.failed"
      | "skills.catalog.loaded"
      | "skills.updated"
    >
  | SessionEventInput<"mcp.server.connected" | "mcp.server.failed">
  | SessionEventInput<"diagnostic.sink_failed">
  | TurnEventInput<"turn.started" | "turn.steering.applied" | "turn.finished">
  | (
      | TurnEventInput<"turn.failed" | "turn.cancelled">
      | IterationEventInput<"turn.failed" | "turn.cancelled">
    )
  | IterationEventInput<
      | "agent.iteration.started"
      | "model.request.started"
      | "model.request.failed"
      | "model.request.finished"
      | "context.usage.updated"
      | "context.shadow.planned"
      | "context.shadow.failed"
      | "assistant.progress"
      | "agent.iteration.finished"
    >
  | ToolEventInput<
      "tool.started" | "tool.raw_result" | "tool.finished" | "tool.observation"
    >
  | ToolEventInput<"tool.confirmation.requested" | "tool.confirmation.resolved">
  | ToolEventInput<
      "bash.task.backgrounded" | "bash.task.stopping" | "bash.task.finished"
    >;
