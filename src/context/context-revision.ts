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

export type StoredInitialContextRevisionV4 = {
  readonly revisionId: ContextRevisionId;
  readonly sessionId: SessionId;
  readonly revisionNumber: 1;
  readonly kind: "initial_full";
  readonly keepFromOrdinal: 1;
  readonly createdAt: string;
};

export type StoredContextSnapshotV4 = {
  readonly meta: {
    readonly sessionId: SessionId;
    readonly activeRevisionId: ContextRevisionId;
  };
  readonly revision: StoredInitialContextRevisionV4;
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
  readonly compiled: CompiledRevisionContext;
  readonly request: ModelRequestInput;
  readonly candidateUserPromptIncluded: boolean;
};

export type ProspectiveSwapOverride = {
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
