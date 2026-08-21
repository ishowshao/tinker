import type { AgentMessage } from "../agent/types";
import { toolResultDisplayText, toolResultText } from "../agent/tool-result-content";
import { stableJsonStringify } from "../model/model-request-preflight";
import { formatMessageSource } from "./context-source";
import type { CompiledRevisionContext, SwapOverride } from "./context-revision";
import type { StoredContextSurfaceV8 } from "./context-surface";
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
    surface: StoredContextSurfaceV8,
  ): void {
    const byMessageId = overrideMap(overrides, "Active");
    this.validate(compiled, canonical, byMessageId, surface);
  }

  validateProspective(
    compiled: CompiledRevisionContext,
    canonical: ProtocolContextView,
    overrides: readonly SwapOverride[],
    surface: StoredContextSurfaceV8,
  ): void {
    const byMessageId = overrideMap(overrides, "Prospective");
    this.validate(compiled, canonical, byMessageId, surface);
  }

  private validate(
    compiled: CompiledRevisionContext,
    canonical: ProtocolContextView,
    overrides: ReadonlyMap<string, SwapOverride>,
    surface: StoredContextSurfaceV8,
  ): void {
    if (compiled.sessionId !== canonical.sessionId) {
      fail("Compiled context belongs to another session.");
    }
    const keepFromOrdinal = compiled.manifest.keepFromOrdinal;
    if (
      !Number.isSafeInteger(keepFromOrdinal) ||
      keepFromOrdinal < 1 ||
      keepFromOrdinal > canonical.messages.length
    ) {
      fail("Compiled context keep boundary is invalid.");
    }
    const activeRecords =
      keepFromOrdinal === 1
        ? canonical.messages
        : [
            requireItem(canonical.messages, 0, "canonical system message"),
            ...canonical.messages.slice(keepFromOrdinal - 1),
          ];
    const activeFrames =
      keepFromOrdinal === 1
        ? canonical.frames
        : [
            requireItem(canonical.frames, 0, "canonical system frame"),
            ...canonical.frames.filter(
              (frame) => frame.firstOrdinal >= keepFromOrdinal,
            ),
          ];
    if (keepFromOrdinal > 1) {
      const boundaryMessage = canonical.messages[keepFromOrdinal - 1];
      const boundaryFrame = canonical.frames.find(
        (frame) => frame.firstOrdinal === keepFromOrdinal,
      );
      if (
        boundaryMessage?.ordinal !== keepFromOrdinal ||
        boundaryMessage.role !== "user" ||
        boundaryFrame?.kind !== "user" ||
        boundaryFrame.state !== "closed" ||
        boundaryFrame.lastOrdinal !== keepFromOrdinal
      ) {
        fail("Compiled context keep boundary does not start a closed user frame.");
      }
    }
    if (compiled.entries.length !== activeRecords.length) {
      fail("Compiled context does not match the active message projection.");
    }
    if (
      compiled.canonicalThroughOrdinal !== canonical.messages.length ||
      compiled.manifest.canonicalFrameCount !== canonical.frames.length ||
      compiled.manifest.canonicalMessageCount !== canonical.messages.length ||
      compiled.manifest.activeFrameCount !== activeFrames.length ||
      compiled.manifest.activeMessageCount !== compiled.entries.length
    ) {
      fail("Compiled context manifest counts do not match canonical history.");
    }
    if (overrides.size > 0) {
      for (const override of overrides.values()) {
        if (override.ordinal < keepFromOrdinal) {
          fail("Compiled context contains an override before its keep boundary.");
        }
      }
    }

    const seenFrames = new Set<string>();
    const seenMessages = new Set<string>();
    const seenOrdinals = new Set<number>();
    const consumedOverrides = new Set<string>();

    for (let index = 0; index < compiled.entries.length; index += 1) {
      const entry = requireItem(compiled.entries, index, "compiled entry");
      const record = requireItem(activeRecords, index, "active canonical message");
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
        if (entry.representation === "canonical") {
          assertSameMessage(entry.message, record);
          continue;
        }
        if (
          entry.representation !== "surface" ||
          record.ordinal !== 1 ||
          record.role !== "system" ||
          entry.message.role !== "system" ||
          entry.message.content !== surface.systemPrompt
        ) {
          fail(`Unapproved surface entry at ordinal ${entry.ordinal}.`);
        }
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
        toolResultText(entry.message.content) !== override.renderedContent
      ) {
        fail(
          `Swapped tool entry changed protocol identity at ordinal ${entry.ordinal}.`,
        );
      }
    }

    if (
      seenFrames.size !== activeFrames.length ||
      activeFrames.some((frame) => !seenFrames.has(frame.frameId))
    ) {
      fail("Compiled entries do not preserve every active protocol frame.");
    }
    if (consumedOverrides.size !== overrides.size) {
      fail("A prospective override does not reference canonical history.");
    }
    if (
      compiled.manifest.canonicalSequenceHash !== canonicalSequenceHash(canonical) ||
      compiled.manifest.renderedMessageHash !== renderedMessageHash(compiled.entries) ||
      compiled.manifest.surfaceSha256 !== surface.surfaceSha256
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
    record.role === "assistant"
      ? (record.content ?? "")
      : record.role === "tool"
        ? record.displayText
        : record.content,
    "utf8",
  );
  const renderedBytes = Buffer.byteLength(override.renderedContent, "utf8");
  const rendererFormat = override.rendererFormat ?? "swap-observation-v1";
  if (
    override.source !== formatMessageSource(record.messageId) ||
    override.renderedContentSha256 !== contentHash(override.renderedContent) ||
    override.originalBytes !== originalBytes ||
    override.renderedBytes !== renderedBytes ||
    override.byteSavings !== originalBytes - renderedBytes ||
    ((rendererFormat === "swap-observation-v1" ||
      rendererFormat === "skill-activation-receipt-v1") &&
      override.byteSavings <= 0) ||
    (rendererFormat !== "swap-observation-v1" &&
      rendererFormat !== "swap-tool-image-v1" &&
      rendererFormat !== "skill-activation-receipt-v1")
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
      if (actual.role !== record.role || actual.content !== record.content) {
        fail(`Canonical entry changed message content at ordinal ${record.ordinal}.`);
      }
      return;
    case "user":
      if (
        actual.role !== "user" ||
        actual.content !== record.content ||
        stableJsonStringify(actual.attachments ?? null) !==
          stableJsonStringify(record.attachments ?? null)
      ) {
        fail(`Canonical entry changed user data at ordinal ${record.ordinal}.`);
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
        stableJsonStringify(actual.content) !== stableJsonStringify(record.content) ||
        toolResultDisplayText(actual.content) !== record.displayText
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
