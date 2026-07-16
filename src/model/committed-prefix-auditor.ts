import type { ContextRevisionId } from "../ids/runtime-id";
import type { PreparedModelRequest } from "./model-client";
import {
  lastPromptPrefixHash,
  promptPrefixHashes,
  type PromptPrefixFingerprint,
} from "./prompt-prefix-hash";

export type CommittedPrefixAnchor = PromptPrefixFingerprint & {
  readonly revisionId: ContextRevisionId;
};

export class CommittedPrefixAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommittedPrefixAuditError";
  }
}

export class CommittedPrefixAuditor {
  private anchor?: CommittedPrefixAnchor;

  audit(
    revisionId: ContextRevisionId,
    prepared: PreparedModelRequest,
  ): CommittedPrefixAnchor {
    const hashes = promptPrefixHashes(
      prepared.requestConfigHash,
      prepared.promptSegments,
    );
    const current = Object.freeze<PromptPrefixFingerprint>({
      requestConfigHash: prepared.requestConfigHash,
      toolSchemaHash: prepared.toolSchemaHash,
      segmentCount: prepared.promptSegments.length,
      prefixHash: lastPromptPrefixHash(hashes),
    });
    const previous = this.anchor;
    if (previous !== undefined && previous.revisionId === revisionId) {
      if (previous.requestConfigHash !== current.requestConfigHash) {
        throw new CommittedPrefixAuditError(
          "Committed request config changed within one context revision.",
        );
      }
      if (previous.toolSchemaHash !== current.toolSchemaHash) {
        throw new CommittedPrefixAuditError(
          "Committed tool schema changed within one context revision.",
        );
      }
      if (current.segmentCount < previous.segmentCount) {
        throw new CommittedPrefixAuditError(
          "Committed prompt segment count shrank within one context revision.",
        );
      }
      if (hashes[previous.segmentCount] !== previous.prefixHash) {
        throw new CommittedPrefixAuditError(
          "Committed prompt prefix changed within one context revision.",
        );
      }
    }
    const anchor = Object.freeze({ revisionId, ...current });
    this.anchor = anchor;
    return anchor;
  }

  current(): CommittedPrefixAnchor | undefined {
    return this.anchor;
  }
}
