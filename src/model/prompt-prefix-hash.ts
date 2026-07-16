import type { PreparedModelRequest, PreparedPromptSegment } from "./model-client";
import { sha256 } from "./model-request-preflight";

export type PromptPrefixFingerprint = {
  readonly requestConfigHash: string;
  readonly toolSchemaHash: string;
  readonly segmentCount: number;
  readonly prefixHash: string;
};

export function promptPrefixHashes(
  requestConfigHash: string,
  segments: readonly PreparedPromptSegment[],
): readonly string[] {
  const hashes = [sha256(`request-config:${requestConfigHash}`)];
  for (const segment of segments) {
    const previous = hashes.at(-1);
    if (previous === undefined) {
      throw new Error("Prompt prefix hash chain has no seed.");
    }
    hashes.push(
      sha256(`${previous}\u0000${segment.kind}\u0000${segment.normalizedText}`),
    );
  }
  return Object.freeze(hashes);
}

export function lastPromptPrefixHash(hashes: readonly string[]): string {
  const value = hashes.at(-1);
  if (value === undefined) {
    throw new Error("Prompt prefix hash chain is empty.");
  }
  return value;
}

export function promptPrefixFingerprint(
  prepared: PreparedModelRequest,
): PromptPrefixFingerprint {
  return Object.freeze({
    requestConfigHash: prepared.requestConfigHash,
    toolSchemaHash: prepared.toolSchemaHash,
    segmentCount: prepared.promptSegments.length,
    prefixHash: lastPromptPrefixHash(
      promptPrefixHashes(prepared.requestConfigHash, prepared.promptSegments),
    ),
  });
}
