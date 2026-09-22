/** Client-side contract. Reads use local snapshots; mutations are asynchronous.
 * View is supplied by the presentation adapter, not by the execution owner.
 * This is an in-process client API, not the public network serialization format.
 */
import type {
  ContextCompactionResult,
  ContextRetirementResult,
} from "../context/context-manager";
import type {
  AcceptedTurn,
  AskUserSnapshot,
  AskUserResolution,
  BashGuardSnapshot,
  RuntimeSkillsSnapshot,
} from "../agent/runtime-session";
import type { RunAgentResult, UserMessage } from "../agent/types";
import type { TurnUndoResult } from "../tools/turn-undo-manager";
import type { ImageAssetRef } from "../image/image-types";
import type { ImportedImageAsset } from "../image/image-asset-store";
import type { SessionId } from "../ids/runtime-id";
import type { ModelProfile } from "../cli/model-profiles";
import type { McpInventorySnapshot } from "../mcp/mcp-manager";
import type { ReasoningEffortSnapshot } from "../model/reasoning-effort";
import type { SessionSummary } from "../session/session-catalog";
import type {
  PromptSchedulerSnapshot,
  QueueFollowUpResult,
} from "../agent/runtime-session-contracts";
import type {
  ProviderRetrySnapshot,
  ProviderRetryDecision,
} from "../agent/runtime-provider-retry";

export type SessionClient<View> = {
  sessionId: SessionId;
  modelName: string;
  workspaceRoot: string;
  profileName?: string;
  projectionStore: View;
  readLastResponse(): Promise<string | undefined>;
  skills(): RuntimeSkillsSnapshot;
  mcp(): McpInventorySnapshot;
  reasoningEffort?: () => ReasoningEffortSnapshot | undefined;
  setReasoningEffort?: (effort: string) => Promise<ReasoningEffortSnapshot>;
  resetReasoningEffort?: () => Promise<ReasoningEffortSnapshot>;
  supportsImageInput?: () => boolean;
  importImage?: (
    sourcePath: string,
    signal: AbortSignal,
    prospectiveMessageImageCount: number,
  ) => Promise<ImportedImageAsset>;
  verifyImageAssets?: (
    assets: readonly ImageAssetRef[],
    signal: AbortSignal,
  ) => Promise<void>;
  admitTurn?: (userMessage: UserMessage, signal: AbortSignal) => Promise<AcceptedTurn>;
  executeTurn(userMessage: UserMessage, signal: AbortSignal): Promise<RunAgentResult>;
  promptScheduler?: () => PromptSchedulerSnapshot;
  subscribePromptScheduler?: (listener: () => void) => () => void;
  queueFollowUp?: (message: UserMessage) => Promise<QueueFollowUpResult>;
  bashGuard(): BashGuardSnapshot;
  subscribeBashGuard(listener: () => void): () => void;
  setYoloMode(enabled: boolean): Promise<void>;
  resolveBashConfirmation(decision: "allow" | "deny"): Promise<void>;
  providerRetry?: () => ProviderRetrySnapshot;
  subscribeProviderRetry?: (listener: () => void) => () => void;
  resolveProviderRetry?: (
    requestId: string,
    decision: ProviderRetryDecision,
  ) => Promise<void>;
  askUser(): AskUserSnapshot;
  subscribeAskUser(listener: () => void): () => void;
  resolveAskUser(response: AskUserResolution): Promise<void>;
};

export type WorkspaceClient<View> = {
  getBinding: () => SessionClient<View>;
  subscribe: (listener: () => void) => () => void;
  listSessions: () => Promise<readonly SessionSummary[]>;
  compact: () => Promise<ContextCompactionResult>;
  retire: () => Promise<ContextRetirementResult>;
  undo: () => Promise<TurnUndoResult>;
  fork: (beforeCommit?: () => void) => Promise<SessionId>;
  clear: (beforeCommit?: () => void) => Promise<void>;
  resume: (sessionId: SessionId, beforeCommit?: () => void) => Promise<void>;
  delete: (sessionId: SessionId) => Promise<void>;
  switchModel: (profile: ModelProfile, beforeCommit?: () => void) => Promise<void>;
};

/** Closing a connection is distinct from an explicit task cancellation. */
export type ClientCloseReason =
  | { type: "client_exit" }
  | { type: "client_failed"; error: string };

export type ClientConnection<View> = {
  client: WorkspaceClient<View>;
  close(reason: ClientCloseReason): Promise<void>;
};
