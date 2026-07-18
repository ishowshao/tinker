import type { AgentMessage } from "../agent/types";
import type {
  ContextRevisionId,
  ContextSurfaceId,
  MessageId,
  ProtocolFrameId,
  SessionId,
} from "../ids/runtime-id";
import type { ModelRequestInput } from "../model/model-client";
import type { MessageSource } from "./context-source";
import type { ContextSurfaceChanges, StoredContextSurfaceV8 } from "./context-surface";
import type { ProtocolContextView } from "./protocol-frame";

export type StoredInitialContextRevisionV8 = {
  readonly revisionId: ContextRevisionId;
  readonly sessionId: SessionId;
  readonly revisionNumber: 1;
  readonly parentRevisionId: null;
  readonly kind: "initial_full";
  readonly surfaceId: ContextSurfaceId;
  readonly surfaceSha256: string;
  readonly keepFromOrdinal: 1;
  readonly sourceThroughOrdinal: 1;
  readonly addedOverrideCount: 0;
  readonly activeOverrideCount: 0;
  readonly activeOverrideManifestSha256: string;
  readonly canonicalSequenceSha256: string;
  readonly renderedMessageSha256: string;
  readonly createdAt: string;
};

export type StoredSwapContextRevisionV8 = {
  readonly revisionId: ContextRevisionId;
  readonly sessionId: SessionId;
  readonly revisionNumber: number;
  readonly parentRevisionId: ContextRevisionId;
  readonly kind: "swap_only";
  readonly surfaceId: ContextSurfaceId;
  readonly surfaceSha256: string;
  readonly keepFromOrdinal: number;
  readonly sourceThroughOrdinal: number;
  readonly addedOverrideCount: number;
  readonly activeOverrideCount: number;
  readonly activeOverrideManifestSha256: string;
  readonly canonicalSequenceSha256: string;
  readonly renderedMessageSha256: string;
  readonly policyVersion: "swap-only-v1";
  readonly rendererFormat: "swap-observation-v1";
  readonly planSha256: string;
  readonly createdAt: string;
};

export type StoredSurfaceRefreshContextRevisionV8 = {
  readonly revisionId: ContextRevisionId;
  readonly sessionId: SessionId;
  readonly revisionNumber: number;
  readonly parentRevisionId: ContextRevisionId;
  readonly kind: "surface_refresh";
  readonly surfaceId: ContextSurfaceId;
  readonly surfaceSha256: string;
  readonly keepFromOrdinal: number;
  readonly sourceThroughOrdinal: number;
  readonly addedOverrideCount: 0;
  readonly activeOverrideCount: number;
  readonly activeOverrideManifestSha256: string;
  readonly canonicalSequenceSha256: string;
  readonly renderedMessageSha256: string;
  readonly changeManifestSha256: string;
  readonly createdAt: string;
};

export type StoredPrefixRetirementContextRevisionV8 = {
  readonly revisionId: ContextRevisionId;
  readonly sessionId: SessionId;
  readonly revisionNumber: number;
  readonly parentRevisionId: ContextRevisionId;
  readonly kind: "prefix_retirement";
  readonly surfaceId: ContextSurfaceId;
  readonly surfaceSha256: string;
  readonly keepFromOrdinal: number;
  readonly sourceThroughOrdinal: number;
  readonly addedOverrideCount: 0;
  readonly activeOverrideCount: number;
  readonly activeOverrideManifestSha256: string;
  readonly canonicalSequenceSha256: string;
  readonly renderedMessageSha256: string;
  readonly policyVersion: "recall-first-retirement-v1";
  readonly planSha256: string;
  readonly retiredThroughOrdinal: number;
  readonly retiredTurnCount: number;
  readonly retiredFrameCount: number;
  readonly retiredMessageCount: number;
  readonly createdAt: string;
};

export type StoredSkillsUpdateContextRevisionV8 = {
  readonly revisionId: ContextRevisionId;
  readonly sessionId: SessionId;
  readonly revisionNumber: number;
  readonly parentRevisionId: ContextRevisionId;
  readonly kind: "skills_update";
  readonly surfaceId: ContextSurfaceId;
  readonly surfaceSha256: string;
  readonly keepFromOrdinal: number;
  readonly sourceThroughOrdinal: number;
  readonly addedOverrideCount: number;
  readonly activeOverrideCount: number;
  readonly activeOverrideManifestSha256: string;
  readonly canonicalSequenceSha256: string;
  readonly renderedMessageSha256: string;
  readonly policyVersion: "agent-skills-v1";
  readonly rendererFormat: "skill-activation-receipt-v1";
  readonly changeManifestSha256: string;
  readonly activationManifestSha256: string;
  readonly createdAt: string;
};

export type StoredContextRevisionV8 =
  | StoredInitialContextRevisionV8
  | StoredSwapContextRevisionV8
  | StoredSurfaceRefreshContextRevisionV8
  | StoredPrefixRetirementContextRevisionV8
  | StoredSkillsUpdateContextRevisionV8;

export type SwapOverride = {
  readonly frameId: ProtocolFrameId;
  readonly messageId: MessageId;
  readonly ordinal: number;
  readonly source: MessageSource;
  readonly originalContentSha256: string;
  readonly renderedContent: string;
  readonly renderedContentSha256: string;
  readonly originalBytes: number;
  readonly renderedBytes: number;
  readonly byteSavings: number;
  readonly rendererFormat?: "swap-observation-v1" | "skill-activation-receipt-v1";
};

export type StoredContextOverrideV8 = SwapOverride & {
  readonly introducedRevisionId: ContextRevisionId;
  readonly rendererFormat: "swap-observation-v1" | "skill-activation-receipt-v1";
  readonly createdAt: string;
};

export type StoredContextSnapshotV8 = {
  readonly meta: {
    readonly sessionId: SessionId;
    readonly activeRevisionId: ContextRevisionId;
  };
  readonly revision: StoredContextRevisionV8;
  readonly surface: StoredContextSurfaceV8;
  readonly activeOverrides: readonly StoredContextOverrideV8[];
  readonly canonical: ProtocolContextView;
};

export type CompiledContextEntry = {
  readonly frameId: ProtocolFrameId;
  readonly messageId: MessageId;
  readonly ordinal: number;
  readonly representation: "canonical" | "surface" | "swapped";
  readonly sourceContentSha256: string;
  readonly message: AgentMessage;
};

export type CompiledContextManifest = {
  readonly canonicalFrameCount: number;
  readonly canonicalMessageCount: number;
  readonly activeFrameCount: number;
  readonly activeMessageCount: number;
  readonly keepFromOrdinal: number;
  readonly canonicalSequenceHash: string;
  readonly renderedMessageHash: string;
  readonly surfaceSha256: string;
};

export type CompiledRevisionContext = {
  readonly sessionId: SessionId;
  readonly revisionId: ContextRevisionId;
  readonly canonicalThroughOrdinal: number;
  readonly entries: readonly CompiledContextEntry[];
  readonly manifest: CompiledContextManifest;
};

export type BuiltContextRequest = {
  readonly canonical: ProtocolContextView;
  readonly revision: StoredContextRevisionV8;
  readonly surface: StoredContextSurfaceV8;
  readonly activeOverrides: readonly SwapOverride[];
  readonly compiled: CompiledRevisionContext;
  readonly request: ModelRequestInput;
  readonly candidateUserPromptIncluded: boolean;
};

export type SurfaceRefreshPlan = {
  readonly surface: StoredContextSurfaceV8;
  readonly changes: ContextSurfaceChanges;
};
