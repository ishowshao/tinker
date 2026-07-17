import type { AgentMessage } from "../agent/types";
import type {
  ContextRevisionId,
  MessageId,
  ProtocolFrameId,
  SessionId,
} from "../ids/runtime-id";
import type { ModelRequestInput } from "../model/model-client";
import type { MessageSource } from "./context-source";
import type { ProtocolContextView } from "./protocol-frame";

export type StoredInitialContextRevisionV5 = {
  readonly revisionId: ContextRevisionId;
  readonly sessionId: SessionId;
  readonly revisionNumber: 1;
  readonly parentRevisionId: null;
  readonly kind: "initial_full";
  readonly keepFromOrdinal: 1;
  readonly sourceThroughOrdinal: 1;
  readonly addedOverrideCount: 0;
  readonly totalOverrideCount: 0;
  readonly overrideManifestSha256: string;
  readonly canonicalSequenceSha256: string;
  readonly renderedMessageSha256: string;
  readonly createdAt: string;
};

export type StoredSwapContextRevisionV5 = {
  readonly revisionId: ContextRevisionId;
  readonly sessionId: SessionId;
  readonly revisionNumber: number;
  readonly parentRevisionId: ContextRevisionId;
  readonly kind: "swap_only";
  readonly keepFromOrdinal: 1;
  readonly sourceThroughOrdinal: number;
  readonly addedOverrideCount: number;
  readonly totalOverrideCount: number;
  readonly overrideManifestSha256: string;
  readonly canonicalSequenceSha256: string;
  readonly renderedMessageSha256: string;
  readonly policyVersion: "swap-only-v1";
  readonly rendererFormat: "swap-observation-v1";
  readonly planSha256: string;
  readonly createdAt: string;
};

export type StoredContextRevisionV5 =
  | StoredInitialContextRevisionV5
  | StoredSwapContextRevisionV5;

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

export type StoredSwapOverrideV5 = SwapOverride & {
  readonly introducedRevisionId: ContextRevisionId;
  readonly rendererFormat: "swap-observation-v1";
  readonly createdAt: string;
};

export type StoredContextSnapshotV5 = {
  readonly meta: {
    readonly sessionId: SessionId;
    readonly activeRevisionId: ContextRevisionId;
  };
  readonly revision: StoredContextRevisionV5;
  readonly activeOverrides: readonly StoredSwapOverrideV5[];
  readonly canonical: ProtocolContextView;
};

export type CompiledContextEntry = {
  readonly frameId: ProtocolFrameId;
  readonly messageId: MessageId;
  readonly ordinal: number;
  readonly representation: "canonical" | "swapped";
  readonly sourceContentSha256: string;
  readonly message: AgentMessage;
};

export type CompiledContextManifest = {
  readonly frameCount: number;
  readonly messageCount: number;
  readonly canonicalSequenceHash: string;
  readonly renderedMessageHash: string;
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
  readonly revision: StoredContextRevisionV5;
  readonly activeOverrides: readonly SwapOverride[];
  readonly compiled: CompiledRevisionContext;
  readonly request: ModelRequestInput;
  readonly candidateUserPromptIncluded: boolean;
};
