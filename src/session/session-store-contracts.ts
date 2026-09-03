import type {
  ContextRevisionId,
  IterationId,
  MessageId,
  ProtocolFrameId,
  RuntimeIdFactory,
  SessionId,
  ToolCallId,
  TurnId,
} from "../ids/runtime-id";
import type { MeasuredContextAnchor } from "../agent/context-meter";
import type { ModelContextProfile } from "../model/model-context-profile";
import type { ModelMessageProtocol } from "../model/model-client";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import type { ProjectInstructionManifest } from "../instructions/project-instructions";
import type { SkillScope } from "../skills/skill-loader";
import type {
  ContextSurfaceChanges,
  StoredContextSurfaceV8,
} from "../context/context-surface";
import type { SwapOverride } from "../context/context-revision";
import { SWAP_OBSERVATION_FORMAT } from "../context/context-swap-renderer";

export type SessionMediaCompatibility = {
  readonly policyVersion: string;
  readonly policySha256: string;
  readonly inputModalities: readonly ("text" | "image")[];
  readonly toolResultModalities: readonly ("text" | "image")[];
};

export type CompletedTurnMessageSnapshot =
  | {
      readonly ordinal: number;
      readonly role: "user";
      readonly content: string;
    }
  | {
      readonly ordinal: number;
      readonly role: "assistant";
      readonly content: string | null;
      readonly reasoningContent?: string | null;
    }
  | {
      readonly ordinal: number;
      readonly role: "tool";
      readonly name: string;
      readonly content: string;
    };

export type CompletedTurnSnapshot = {
  readonly messages: readonly CompletedTurnMessageSnapshot[];
};

export type SessionCompatibilityContract = {
  modelName: string;
  profileName?: string;
  includeReasoningContent: boolean;
  contextProfile: ModelContextProfile;
  messageProtocol: ModelMessageProtocol;
  media: SessionMediaCompatibility;
};

export type StoredSessionMetaV10 = {
  schemaVersion: 10;
  schemaFingerprint: string;
  initializationState: "creating" | "ready";
  sessionId: SessionId;
  workspaceRoot: string;
  modelName: string;
  systemPromptSha256: string;
  projectInstruction?: ProjectInstructionManifest;
  sessionCompatibilityJson: string | null;
  sessionCompatibilitySha256: string | null;
  activeRevisionId: ContextRevisionId | null;
  nextTurnNumber: number;
  nextEventSequence: number;
  openCount: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  lastClosedAt: string | null;
  lastCloseReason:
    | "oneshot_complete"
    | "tui_exit"
    | "session_switch"
    | "runner_failed"
    | "initialization_failed"
    | null;
};

export type SessionCloseReason = NonNullable<StoredSessionMetaV10["lastCloseReason"]>;

export type SessionRecoveryResult = {
  recoveredTurnId?: TurnId;
  recoveredFrameId?: ProtocolFrameId;
  syntheticCompletionCount: number;
  recallIndexRebuilt: boolean;
};

export type StoredMeasuredContextState = {
  revisionId: ContextRevisionId;
  anchor: MeasuredContextAnchor;
};

export type CommitSwapRevisionInput = {
  revisionId: ContextRevisionId;
  expectedBaseRevisionId: ContextRevisionId;
  expectedBaseRevisionNumber: number;
  expectedCanonicalThroughOrdinal: number;
  expectedBaseActiveOverrideManifestSha256: string;
  policyVersion: "swap-only-v1";
  rendererFormat: typeof SWAP_OBSERVATION_FORMAT;
  planHash: string;
  addedOverrides: readonly SwapOverride[];
  nextActiveOverrideManifestSha256: string;
  canonicalSequenceSha256: string;
  renderedMessageSha256: string;
  activeTurnId?: TurnId;
};

export type CommitSwapRevisionFaultStage =
  | "before_revision_insert"
  | "after_revision_insert"
  | "after_first_override_insert"
  | "after_overrides_insert"
  | "after_measurement_delete"
  | "after_active_update";

export type CommitSwapRevisionOptions = {
  faultInjector?: (stage: CommitSwapRevisionFaultStage) => void;
};

export type CommitSurfaceRefreshInput = {
  revisionId: ContextRevisionId;
  expectedBaseRevisionId: ContextRevisionId;
  expectedBaseRevisionNumber: number;
  expectedCanonicalThroughOrdinal: number;
  expectedBaseActiveOverrideManifestSha256: string;
  surface: StoredContextSurfaceV8;
  changes: ContextSurfaceChanges;
  changeManifestSha256: string;
  canonicalSequenceSha256: string;
  renderedMessageSha256: string;
};

export type CommitSurfaceRefreshFaultStage =
  | "before_surface_insert"
  | "after_surface_insert"
  | "after_revision_insert"
  | "after_measurement_delete"
  | "after_active_update";

export type CommitSurfaceRefreshOptions = {
  faultInjector?: (stage: CommitSurfaceRefreshFaultStage) => void;
};

export type CommitPrefixRetirementRevisionInput = {
  revisionId: ContextRevisionId;
  expectedBaseRevisionId: ContextRevisionId;
  expectedBaseRevisionNumber: number;
  expectedBaseKeepFromOrdinal: number;
  expectedCanonicalThroughOrdinal: number;
  expectedSurfaceSha256: string;
  expectedBaseActiveOverrideManifestSha256: string;
  policyVersion: "recall-first-retirement-v1";
  planHash: string;
  nextKeepFromOrdinal: number;
  retiredThroughOrdinal: number;
  retiredTurnCount: number;
  retiredFrameCount: number;
  retiredMessageCount: number;
  nextActiveOverrideCount: number;
  nextActiveOverrideManifestSha256: string;
  canonicalSequenceSha256: string;
  renderedMessageSha256: string;
  activeTurnId?: TurnId;
};

export type CommitPrefixRetirementRevisionFaultStage =
  | "before_revision_insert"
  | "after_revision_insert"
  | "after_override_readback"
  | "after_measurement_delete"
  | "after_active_update"
  | "after_snapshot_readback";

export type CommitPrefixRetirementRevisionOptions = {
  faultInjector?: (stage: CommitPrefixRetirementRevisionFaultStage) => void;
};

export type StoredSkillActivation = {
  readonly activationMessageId: MessageId;
  readonly toolCallId: ToolCallId;
  readonly sessionId: SessionId;
  readonly name: string;
  readonly scope: SkillScope;
  readonly skillFileSha256: string;
  readonly state: "pending" | "dispatched" | "promoted" | "rejected";
  readonly dispatchedIterationId?: IterationId;
  readonly settledRevisionId?: ContextRevisionId;
  readonly rejectionReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CommitSkillsUpdateInput = {
  revisionId: ContextRevisionId;
  expectedBaseRevisionId: ContextRevisionId;
  expectedBaseRevisionNumber: number;
  expectedCanonicalThroughOrdinal: number;
  expectedBaseActiveOverrideManifestSha256: string;
  surface: StoredContextSurfaceV8;
  changes: ContextSurfaceChanges;
  changeManifestSha256: string;
  activationManifestSha256: string;
  addedOverrides: readonly SwapOverride[];
  nextActiveOverrideManifestSha256: string;
  settlements: readonly {
    activationMessageId: MessageId;
    name: string;
    state: "promoted" | "rejected";
    rejectionReason?: string;
  }[];
  canonicalSequenceSha256: string;
  renderedMessageSha256: string;
};

export type CommitSkillsUpdateFaultStage =
  | "before_surface_insert"
  | "after_surface_insert"
  | "after_revision_insert"
  | "after_first_override_insert"
  | "after_overrides_insert"
  | "after_activations_update"
  | "after_measurement_delete"
  | "after_active_update";

export type CommitSkillsUpdateOptions = {
  faultInjector?: (stage: CommitSkillsUpdateFaultStage) => void;
};

export type CloneSessionFaultStage =
  | "after_staging_mkdir"
  | "after_snapshot"
  | "after_trigger_drop"
  | "after_identity_update"
  | "after_revision_hash_rewrite"
  | "after_trigger_reinstall"
  | "after_recall_validation"
  | "after_event_rewrite"
  | "after_observation_render"
  | "after_artifact_validation"
  | "before_publish_rename";

export type CloneSessionStoreInput = {
  targetSessionId: SessionId;
  faultInjector?: (stage: CloneSessionFaultStage) => void;
};

export function skillActivationManifestSha256(
  settlements: CommitSkillsUpdateInput["settlements"],
): string {
  return sha256(
    stableJsonStringify(
      [...settlements]
        .sort(
          (left, right) =>
            compareCanonicalText(left.name, right.name) ||
            compareCanonicalText(left.activationMessageId, right.activationMessageId),
        )
        .map((settlement) => ({
          activationMessageId: settlement.activationMessageId,
          name: settlement.name,
          state: settlement.state,
          ...(settlement.rejectionReason === undefined
            ? {}
            : { rejectionReason: settlement.rejectionReason }),
        })),
    ),
  );
}

export type CreateNewSessionStoreInput = {
  workspaceRoot: string;
  sessionId: SessionId;
  modelName: string;
  systemPrompt: string;
  projectInstruction?: ProjectInstructionManifest;
  idFactory: RuntimeIdFactory;
  clock?: () => string;
  homeRoot?: string;
};

export type OpenSessionStoreInput = {
  workspaceRoot: string;
  sessionId: SessionId;
  clock?: () => string;
  allowIncomplete?: boolean;
  homeRoot?: string;
};

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
