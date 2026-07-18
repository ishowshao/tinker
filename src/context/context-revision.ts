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
import type { ContextSurfaceChanges, StoredContextSurfaceV7 } from "./context-surface";
import type { ProtocolContextView } from "./protocol-frame";

export type StoredInitialContextRevisionV7 = {
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

export type StoredSwapContextRevisionV7 = {
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

export type StoredSurfaceRefreshContextRevisionV7 = {
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

export type StoredPrefixRetirementContextRevisionV7 = {
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

export type StoredContextRevisionV7 =
  | StoredInitialContextRevisionV7
  | StoredSwapContextRevisionV7
  | StoredSurfaceRefreshContextRevisionV7
  | StoredPrefixRetirementContextRevisionV7;

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
};

export type StoredSwapOverrideV7 = SwapOverride & {
  readonly introducedRevisionId: ContextRevisionId;
  readonly rendererFormat: "swap-observation-v1";
  readonly createdAt: string;
};

export type StoredContextSnapshotV7 = {
  readonly meta: {
    readonly sessionId: SessionId;
    readonly activeRevisionId: ContextRevisionId;
  };
  readonly revision: StoredContextRevisionV7;
  readonly surface: StoredContextSurfaceV7;
  readonly activeOverrides: readonly StoredSwapOverrideV7[];
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
  readonly revision: StoredContextRevisionV7;
  readonly surface: StoredContextSurfaceV7;
  readonly activeOverrides: readonly SwapOverride[];
  readonly compiled: CompiledRevisionContext;
  readonly request: ModelRequestInput;
  readonly candidateUserPromptIncluded: boolean;
};

export type SurfaceRefreshPlan = {
  readonly surface: StoredContextSurfaceV7;
  readonly changes: ContextSurfaceChanges;
};
