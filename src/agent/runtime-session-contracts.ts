import type { PublicToolingConfig } from "../cli/public-config-contract";
import type { selectContextAutomation } from "../context/context-automation-policy";
import type {
  ContextCompactionResult,
  ContextCompactionTrigger,
  ContextRetirementResult,
  ContextRetirementTrigger,
} from "../context/context-manager";
import type { BuiltContextRequest } from "../context/context-revision";
import type { ContextSurfaceComponent } from "../context/context-surface";
import type { ToolCompletionInput } from "../context/protocol-frame";
import type { EventSink } from "../events/event-sink";
import type { AgentEventInput, AgentEventType } from "../events/types";
import type { RuntimeIdFactory, SessionId, TurnId } from "../ids/runtime-id";
import type { ImportedImageAsset } from "../image/image-asset-store";
import type { ImageAssetRef, UserMessage } from "../image/image-types";
import type { ProjectInstructionManifest } from "../instructions/project-instructions";
import type { loadMcpConfig } from "../mcp/mcp-config";
import type { createMcpManager, McpInventorySnapshot } from "../mcp/mcp-manager";
import type { ModelClient } from "../model/model-client";
import type {
  ModelContextBudget,
  ModelContextProfile,
} from "../model/model-context-profile";
import type { ReasoningEffortSnapshot } from "../model/reasoning-effort";
import type { ObservationBuilder } from "../observation/observation-builder";
import type {
  CompletedTurnSnapshot,
  SessionRecoveryResult,
  SessionStore,
} from "../session/session-store";
import type { SkillCatalogSnapshot } from "../skills/skill-loader";
import type { createDefaultTooling } from "../tools/registry";
import type { TurnUndoResult } from "../tools/turn-undo-manager";
import type {
  AskUserRequest,
  ContextMaintenanceHandle,
  ToolExecutor,
} from "../tools/types";
import type { Refiner } from "../tools/web-fetch/refiner";
import type {
  AssistantTextDeltaSink,
  AssistantTextDeltaUpdate,
} from "./assistant-text-delta";
import type { RunAgentInput } from "./loop";
import type {
  AgentTurnLedger,
  CommittedToolCompletion,
  SessionLedger,
} from "./session-ledger";
import type {
  IterationIdentity,
  RunAgentResult,
  ToolCallIdentity,
  TurnIdentity,
} from "./types";

export type ExecuteTurnInput = {
  userMessage: UserMessage;
  signal: AbortSignal;
};

export type AcceptedTurn = {
  readonly turnId: TurnIdentity["turnId"];
  readonly userMessage: UserMessage;
  readonly completion: Promise<RunAgentResult>;
};

export type PromptSchedulerSnapshot = {
  readonly state: "idle" | "running";
  readonly activeTurnId?: TurnIdentity["turnId"];
  readonly pendingCount: number;
};

export type QueueFollowUpResult = {
  readonly kind: "queued";
  readonly pendingCount: number;
  readonly activeTurnId?: TurnIdentity["turnId"];
};

export type SessionDisposeReason =
  | { type: "oneshot_complete" }
  | { type: "tui_exit" }
  | { type: "session_switch" }
  | { type: "runner_failed"; error: string }
  | { type: "initialization_failed"; error: string };

export type RuntimeSession = {
  readonly sessionId: SessionId;
  readonly resumed: boolean;
  readonly recovery: SessionRecoveryResult;
  skills(): RuntimeSkillsSnapshot;
  mcp(): McpInventorySnapshot;
  supportsImageInput(): boolean;
  reasoningEffort(): ReasoningEffortSnapshot | undefined;
  setReasoningEffort(effort: string): ReasoningEffortSnapshot;
  resetReasoningEffort(): ReasoningEffortSnapshot;
  importImage(
    sourcePath: string,
    signal: AbortSignal,
    prospectiveMessageImageCount: number,
  ): Promise<ImportedImageAsset>;
  verifyImageAssets(
    assets: readonly ImageAssetRef[],
    signal: AbortSignal,
  ): Promise<void>;
  admitTurn(input: ExecuteTurnInput): Promise<AcceptedTurn>;
  executeTurn(input: ExecuteTurnInput): Promise<RunAgentResult>;
  promptScheduler(): PromptSchedulerSnapshot;
  subscribePromptScheduler(listener: () => void): () => void;
  queueFollowUp(userMessage: UserMessage): QueueFollowUpResult;
  compactContext(): Promise<ContextCompactionResult>;
  retireContext(): Promise<ContextRetirementResult>;
  undoLatestFileMutationTurn(): Promise<TurnUndoResult>;
  cloneSession(targetSessionId: SessionId): Promise<void>;
  canSwitchSession(): boolean;
  bashGuard(): BashGuardSnapshot;
  subscribeBashGuard(listener: () => void): () => void;
  setYoloMode(enabled: boolean): void;
  resolveBashConfirmation(decision: "allow" | "deny"): Promise<void>;
  askUser(): AskUserSnapshot;
  subscribeAskUser(listener: () => void): () => void;
  resolveAskUser(response: AskUserResolution): Promise<void>;
  dispose(reason: SessionDisposeReason): Promise<void>;
};

export type AskUserSnapshot = {
  readonly pending?: AskUserRequest;
};

export type AskUserResolution =
  | { readonly outcome: "selected"; readonly selectedIndex: number }
  | { readonly outcome: "dismissed" };

export type BashGuardSource = "default" | "environment" | "cli" | "session";

export type BashGuardSnapshot = {
  readonly mode: "guard" | "yolo";
  readonly source: BashGuardSource;
  readonly pending?: {
    readonly command: string;
    readonly reason: string;
  };
};

export type RuntimeSkillsSnapshot = {
  readonly skills: readonly {
    readonly name: string;
    readonly description: string;
    readonly scope: "project" | "user";
    readonly active: boolean;
  }[];
  readonly shadowedNames: readonly string[];
};

export type RuntimeSessionContext = {
  readonly sessionId: SessionId;
  readonly contextMaintenance: ContextMaintenanceHandle;
  createIteration(turn: TurnIdentity, iterationNumber: number): IterationIdentity;
  createToolCall(
    iteration: IterationIdentity,
    toolCallNumber: number,
  ): ToolCallIdentity;
  finishIterationForContinuation(iteration: IterationIdentity): void;
  append(input: AgentEventInput): Promise<void>;
  updateAssistantTextDelta?(update: AssistantTextDeltaUpdate): void;
  onToolCompletionsCommitted?(input: {
    completions: readonly ToolCompletionInput[];
    committed: readonly CommittedToolCompletion[];
  }): void;
  prepareModelDispatch?(input: {
    iteration: IterationIdentity;
    built: BuiltContextRequest;
  }): void;
  maintainContextAfterIteration?(input: {
    turn: TurnIdentity;
    consumedThroughOrdinal: number;
    ledger: AgentTurnLedger;
  }): Promise<void>;
  applyQueuedSteering?(input: {
    turn: TurnIdentity;
    ledger: AgentTurnLedger;
  }): Promise<number>;
};

export type ContextSurfaceRefreshSummary = {
  readonly previousRevisionNumber: number;
  readonly revisionNumber: number;
  readonly changed: readonly ContextSurfaceComponent[];
  readonly toolCountBefore: number;
  readonly toolCountAfter: number;
};

export type SkillsUpdateSummary = {
  readonly previousRevisionNumber: number;
  readonly revisionNumber: number;
  readonly activated: readonly string[];
  readonly refreshed: readonly string[];
  readonly deactivated: readonly string[];
  readonly unavailable: readonly string[];
  readonly addedOverrideCount: number;
};

export type CompletedTurnHookInput = {
  readonly workspaceRoot: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly snapshot: CompletedTurnSnapshot;
};

export type CompletedTurnHookFailure = {
  readonly workspaceRoot: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly reason: "completed_turn_snapshot_failed" | "completed_turn_enqueue_failed";
};

export type CompletedTurnHook = {
  enqueue(input: CompletedTurnHookInput): void;
  recordFailure(input: CompletedTurnHookFailure): void;
};

export type CommonRuntimeSessionInput = {
  workspaceRoot: string;
  homeRoot?: string;
  modelName: string;
  profileName?: string;
  maxIterations: number;
  includeReasoningContent: boolean;
  contextProfile: ModelContextProfile;
  contextBudget: ModelContextBudget;
  modelClient: ModelClient;
  systemPrompt: string;
  projectInstruction?: ProjectInstructionManifest;
  skillCatalog?: SkillCatalogSnapshot;
  presentationSinks?: EventSink[];
  assistantTextDeltaSink?: AssistantTextDeltaSink;
  persistence?:
    | false
    | {
        eventLogPath?: string;
        observationLogPath?: string;
      };
  webFetchRefiner?: Refiner;
  toolingConfig?: PublicToolingConfig;
  memorySearch?: ToolExecutor;
  memoryGet?: ToolExecutor;
  memoryCreate?: ToolExecutor;
  memoryUpdate?: ToolExecutor;
  memoryDelete?: ToolExecutor;
  completedTurnHook?: CompletedTurnHook;
  enableTurnUndo?: boolean;
  enableAskUser?: boolean;
  bashGuard?: {
    readonly mode: "guard" | "yolo";
    readonly source: Exclude<BashGuardSource, "session">;
    readonly surface: "tui" | "one-shot";
  };
};

export type CreateNewRuntimeSessionInput = CommonRuntimeSessionInput & {
  selection: { mode: "new"; sessionId: SessionId };
};

export type ResumeRuntimeSessionInput = CommonRuntimeSessionInput & {
  selection: { mode: "resume"; sessionId: SessionId };
};

export type CreateRuntimeSessionInput =
  | CreateNewRuntimeSessionInput
  | ResumeRuntimeSessionInput;

export type RuntimeSessionFactoryDependencies = {
  idFactory: RuntimeIdFactory;
  createTooling: typeof createDefaultTooling;
  loadMcpConfig: typeof loadMcpConfig;
  createMcpManager: typeof createMcpManager;
  createObservationBuilder: () => ObservationBuilder;
  openStore: (
    input: CreateRuntimeSessionInput,
    idFactory: RuntimeIdFactory,
  ) => Promise<SessionStore>;
  createLedger: (store: SessionStore, idFactory: RuntimeIdFactory) => SessionLedger;
  createEventSink: (
    input: CreateRuntimeSessionInput,
    sessionDirectory: string,
  ) => EventSink;
  selectShadowPlanning: NonNullable<RunAgentInput["shadowPlanning"]>["select"];
  onShadowPlanningResult?: NonNullable<RunAgentInput["shadowPlanning"]>["onResult"];
  selectContextAutomation: typeof selectContextAutomation;
  automaticCompactionTrigger: () => ContextCompactionTrigger;
  automaticRetirementTrigger: () => ContextRetirementTrigger;
  manualCompactionTrigger: () => ContextCompactionTrigger;
  manualRetirementTrigger: () => ContextRetirementTrigger;
};

export type RuntimeSessionState =
  | "initializing"
  | "admitting"
  | "ready"
  | "executing"
  | "compacting"
  | "maintaining_context"
  | "undoing"
  | "faulted"
  | "disposing"
  | "disposed";

export class RuntimeEventAppendError extends Error {
  readonly eventType: AgentEventType;

  constructor(eventType: AgentEventType, options?: ErrorOptions) {
    super(`Failed to append runtime event ${eventType}.`, options);
    this.name = "RuntimeEventAppendError";
    this.eventType = eventType;
  }
}
