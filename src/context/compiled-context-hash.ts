import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import type { CompiledContextEntry } from "./context-revision";
import { contentHash, type ProtocolContextView } from "./protocol-frame";

export function canonicalSequenceHash(canonical: ProtocolContextView): string {
  return sha256(
    stableJsonStringify({
      sessionId: canonical.sessionId,
      frames: canonical.frames.map((frame) => ({
        frameId: frame.frameId,
        kind: frame.kind,
        state: frame.state,
        firstOrdinal: frame.firstOrdinal,
        lastOrdinal: frame.lastOrdinal,
      })),
      messages: canonical.messages.map((message) => ({
        frameId: message.frameId,
        messageId: message.messageId,
        ordinal: message.ordinal,
        role: message.role,
        contentSha256: message.contentSha256,
      })),
    }),
  );
}

export function renderedMessageHash(entries: readonly CompiledContextEntry[]): string {
  return sha256(
    stableJsonStringify(
      entries.map((entry) => ({
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
            : contentHash(message.content),
      };
  }
}
