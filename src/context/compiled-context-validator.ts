import type { AgentMessage } from "../agent/types";
import { stableJsonStringify } from "../model/model-request-preflight";
import { formatMessageSource } from "./context-source";
import type { CompiledRevisionContext, SwapOverride } from "./context-revision";
import {
  contentHash,
  type CanonicalMessageRecord,
  type ProtocolContextView,
} from "./protocol-frame";
import { canonicalSequenceHash, renderedMessageHash } from "./compiled-context-hash";

export class CompiledContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompiledContextError";
  }
}

export class CompiledContextValidator {
  validateActive(
    compiled: CompiledRevisionContext,
    canonical: ProtocolContextView,
    overrides: readonly SwapOverride[],
  ): void {
    const byMessageId = overrideMap(overrides, "Active");
    this.validate(compiled, canonical, byMessageId);
  }

  validateProspective(
    compiled: CompiledRevisionContext,
    canonical: ProtocolContextView,
    overrides: readonly SwapOverride[],
  ): void {
    const byMessageId = overrideMap(overrides, "Prospective");
    this.validate(compiled, canonical, byMessageId);
  }

  private validate(
    compiled: CompiledRevisionContext,
    canonical: ProtocolContextView,
    overrides: ReadonlyMap<string, SwapOverride>,
  ): void {
    if (compiled.sessionId !== canonical.sessionId) {
      fail("Compiled context belongs to another session.");
    }
    if (compiled.entries.length !== canonical.messages.length) {
      fail("Compiled context changed the canonical message count.");
    }
    if (
      compiled.canonicalThroughOrdinal !== canonical.messages.length ||
      compiled.manifest.frameCount !== canonical.frames.length ||
      compiled.manifest.messageCount !== compiled.entries.length
    ) {
      fail("Compiled context manifest counts do not match canonical history.");
    }

    const seenFrames = new Set<string>();
    const seenMessages = new Set<string>();
    const seenOrdinals = new Set<number>();
    const consumedOverrides = new Set<string>();

    for (let index = 0; index < compiled.entries.length; index += 1) {
      const entry = requireItem(compiled.entries, index, "compiled entry");
      const record = requireItem(canonical.messages, index, "canonical message");
      if (
        entry.frameId !== record.frameId ||
        entry.messageId !== record.messageId ||
        entry.ordinal !== record.ordinal ||
        entry.sourceContentSha256 !== record.contentSha256
      ) {
        fail(`Compiled entry at ordinal ${record.ordinal} changed canonical identity.`);
      }
      if (seenMessages.has(entry.messageId) || seenOrdinals.has(entry.ordinal)) {
        fail(`Compiled entry identity is duplicated at ordinal ${entry.ordinal}.`);
      }
      seenFrames.add(entry.frameId);
      seenMessages.add(entry.messageId);
      seenOrdinals.add(entry.ordinal);

      const override = overrides.get(entry.messageId);
      if (override === undefined) {
        if (entry.representation !== "canonical") {
          fail(`Unapproved swapped entry at ordinal ${entry.ordinal}.`);
        }
        assertSameMessage(entry.message, record);
        continue;
      }

      consumedOverrides.add(entry.messageId);
      validateOverrideIdentity(override, record);
      if (record.role !== "tool" || entry.message.role !== "tool") {
        fail(`Only tool messages may be swapped at ordinal ${entry.ordinal}.`);
      }
      if (
        entry.representation !== "swapped" ||
        entry.message.toolCallId !== record.toolCallId ||
        entry.message.providerToolCallId !== record.providerToolCallId ||
        entry.message.name !== record.name ||
        entry.message.content !== override.renderedContent
      ) {
        fail(
          `Swapped tool entry changed protocol identity at ordinal ${entry.ordinal}.`,
        );
      }
    }

    if (seenFrames.size !== canonical.frames.length) {
      fail("Compiled entries do not preserve every protocol frame.");
    }
    if (consumedOverrides.size !== overrides.size) {
      fail("A prospective override does not reference canonical history.");
    }
    if (
      compiled.manifest.canonicalSequenceHash !== canonicalSequenceHash(canonical) ||
      compiled.manifest.renderedMessageHash !== renderedMessageHash(compiled.entries)
    ) {
      fail("Compiled context manifest hash does not match its entries.");
    }
  }
}

function validateOverrideIdentity(
  override: SwapOverride,
  record: CanonicalMessageRecord,
): void {
  if (
    override.frameId !== record.frameId ||
    override.messageId !== record.messageId ||
    override.ordinal !== record.ordinal ||
    override.originalContentSha256 !== record.contentSha256
  ) {
    fail(`Swap override changed canonical identity at ordinal ${record.ordinal}.`);
  }
  const originalBytes = Buffer.byteLength(
    record.role === "assistant" ? (record.content ?? "") : record.content,
    "utf8",
  );
  const renderedBytes = Buffer.byteLength(override.renderedContent, "utf8");
  if (
    override.source !== formatMessageSource(record.messageId) ||
    override.renderedContentSha256 !== contentHash(override.renderedContent) ||
    override.originalBytes !== originalBytes ||
    override.renderedBytes !== renderedBytes ||
    override.byteSavings !== originalBytes - renderedBytes ||
    override.byteSavings <= 0
  ) {
    fail(`Swap override metadata is invalid at ordinal ${record.ordinal}.`);
  }
}

function overrideMap(
  overrides: readonly SwapOverride[],
  label: string,
): ReadonlyMap<string, SwapOverride> {
  const byMessageId = new Map(
    overrides.map((override) => [override.messageId, override] as const),
  );
  if (byMessageId.size !== overrides.length) {
    fail(`${label} compiled context contains duplicate overrides.`);
  }
  return byMessageId;
}

function assertSameMessage(actual: AgentMessage, record: CanonicalMessageRecord): void {
  if (actual.role !== record.role) {
    fail(`Canonical entry changed message role at ordinal ${record.ordinal}.`);
  }
  switch (record.role) {
    case "system":
    case "user":
      if (actual.role !== record.role || actual.content !== record.content) {
        fail(`Canonical entry changed message content at ordinal ${record.ordinal}.`);
      }
      return;
    case "assistant":
      if (
        actual.role !== "assistant" ||
        actual.content !== record.content ||
        actual.reasoningContent !== record.reasoningContent ||
        stableJsonStringify(actual.toolCalls ?? null) !==
          stableJsonStringify(record.toolCalls ?? null)
      ) {
        fail(`Canonical entry changed assistant data at ordinal ${record.ordinal}.`);
      }
      return;
    case "tool":
      if (
        actual.role !== "tool" ||
        actual.toolCallId !== record.toolCallId ||
        actual.providerToolCallId !== record.providerToolCallId ||
        actual.name !== record.name ||
        actual.content !== record.content
      ) {
        fail(`Canonical entry changed tool data at ordinal ${record.ordinal}.`);
      }
  }
}

function requireItem<T>(items: readonly T[], index: number, name: string): T {
  const item = items[index];
  if (item === undefined) {
    fail(`Missing ${name} at index ${index}.`);
  }
  return item;
}

function fail(message: string): never {
  throw new CompiledContextError(message);
}
