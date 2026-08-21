import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import { toolResultText } from "../agent/tool-result-content";
import type { CompiledContextEntry, SwapOverride } from "./context-revision";
import {
  contentHash,
  materializeAgentMessages,
  type ProtocolContextView,
} from "./protocol-frame";

export function canonicalSequenceHash(
  canonical: ProtocolContextView,
  throughOrdinal = canonical.messages.length,
): string {
  return sha256(
    stableJsonStringify({
      sessionId: canonical.sessionId,
      frames: canonical.frames
        .filter((frame) => frame.firstOrdinal <= throughOrdinal)
        .map((frame) => ({
          frameId: frame.frameId,
          kind: frame.kind,
          state: frame.state,
          firstOrdinal: frame.firstOrdinal,
          lastOrdinal: frame.lastOrdinal,
        })),
      messages: canonical.messages
        .filter((message) => message.ordinal <= throughOrdinal)
        .map((message) => ({
          frameId: message.frameId,
          messageId: message.messageId,
          ordinal: message.ordinal,
          role: message.role,
          contentSha256: message.contentSha256,
        })),
    }),
  );
}

export function renderedMessageHash(
  entries: readonly CompiledContextEntry[],
  throughOrdinal = Number.POSITIVE_INFINITY,
): string {
  return sha256(
    stableJsonStringify(
      entries
        .filter((entry) => entry.ordinal <= throughOrdinal)
        .map((entry) => ({
          frameId: entry.frameId,
          messageId: entry.messageId,
          ordinal: entry.ordinal,
          representation: entry.representation,
          sourceContentSha256: entry.sourceContentSha256,
          rendered: renderedMessageDescriptor(entry),
        })),
    ),
  );
}

export function canonicalRenderedMessageHash(
  canonical: ProtocolContextView,
  throughOrdinal = canonical.messages.length,
): string {
  const messages = materializeAgentMessages(canonical.messages);
  const entries = canonical.messages.map((record, index) => {
    const message = messages[index];
    if (message === undefined) {
      throw new Error(`Missing materialized message at index ${index}.`);
    }
    return {
      frameId: record.frameId,
      messageId: record.messageId,
      ordinal: record.ordinal,
      representation: "canonical" as const,
      sourceContentSha256: record.contentSha256,
      message,
    };
  });
  return renderedMessageHash(entries, throughOrdinal);
}

export function activeOverrideManifestHash(overrides: readonly SwapOverride[]): string {
  return sha256(
    stableJsonStringify(
      [...overrides]
        .sort(
          (left, right) =>
            left.ordinal - right.ordinal ||
            left.messageId.localeCompare(right.messageId),
        )
        .map((override) => ({
          messageId: override.messageId,
          frameId: override.frameId,
          ordinal: override.ordinal,
          originalContentSha256: override.originalContentSha256,
          renderedContentSha256: override.renderedContentSha256,
          rendererFormat: override.rendererFormat ?? "swap-observation-v1",
        })),
    ),
  );
}

function renderedMessageDescriptor(entry: CompiledContextEntry): unknown {
  const message = entry.message;
  switch (message.role) {
    case "system":
    case "user":
      return {
        role: message.role,
        contentSha256:
          entry.representation === "canonical"
            ? entry.sourceContentSha256
            : contentHash(message.content),
      };
    case "assistant":
      return {
        role: message.role,
        contentSha256: entry.sourceContentSha256,
        reasoningContentSha256:
          message.reasoningContent === undefined
            ? undefined
            : contentHash(message.reasoningContent ?? null),
        toolCallsSha256:
          message.toolCalls === undefined
            ? undefined
            : sha256(stableJsonStringify(message.toolCalls)),
      };
    case "tool":
      return {
        role: message.role,
        toolCallId: message.toolCallId,
        providerToolCallId: message.providerToolCallId,
        name: message.name,
        contentSha256:
          entry.representation === "canonical"
            ? entry.sourceContentSha256
            : contentHash(toolResultText(message.content)),
      };
  }
}
