import type { AgentMessage } from "../agent/types";
import { CompiledContextValidator } from "./compiled-context-validator";
import { canonicalSequenceHash, renderedMessageHash } from "./compiled-context-hash";
import { ContextProtocolValidator } from "./context-protocol-validator";
import type {
  CompiledContextEntry,
  CompiledRevisionContext,
  ProspectiveSwapOverride,
  StoredContextSnapshotV4,
} from "./context-revision";
import {
  immutableRecord,
  materializeAgentMessages,
  type ProtocolContextView,
} from "./protocol-frame";

export class ContextRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextRevisionError";
  }
}

export class ContextRevisionCompiler {
  constructor(
    private readonly protocolValidator = new ContextProtocolValidator(),
    private readonly compiledValidator = new CompiledContextValidator(),
  ) {}

  compileActive(snapshot: StoredContextSnapshotV4): CompiledRevisionContext {
    validateSnapshotIdentity(snapshot);
    this.protocolValidator.validate(snapshot.canonical);
    const compiled = compileEntries({
      canonical: snapshot.canonical,
      revisionId: snapshot.revision.revisionId,
      overrides: new Map(),
    });
    this.compiledValidator.validateActive(compiled, snapshot.canonical);
    return compiled;
  }

  compileProspective(input: {
    active: CompiledRevisionContext;
    canonical: ProtocolContextView;
    overrides: readonly ProspectiveSwapOverride[];
  }): CompiledRevisionContext {
    this.protocolValidator.validate(input.canonical);
    if (
      input.active.sessionId !== input.canonical.sessionId ||
      input.active.canonicalThroughOrdinal !== input.canonical.messages.length ||
      input.active.manifest.canonicalSequenceHash !==
        canonicalSequenceHash(input.canonical)
    ) {
      throw new ContextRevisionError(
        "Prospective compilation base does not match canonical history.",
      );
    }
    this.compiledValidator.validateActive(input.active, input.canonical);
    const overrides = new Map(
      input.overrides.map((override) => [override.messageId, override] as const),
    );
    if (overrides.size !== input.overrides.length) {
      throw new ContextRevisionError("Prospective overrides contain duplicate IDs.");
    }
    const compiled = compileEntries({
      canonical: input.canonical,
      revisionId: input.active.revisionId,
      overrides,
    });
    this.compiledValidator.validateProspective(
      compiled,
      input.canonical,
      input.overrides,
    );
    return compiled;
  }
}

function compileEntries(input: {
  canonical: ProtocolContextView;
  revisionId: CompiledRevisionContext["revisionId"];
  overrides: ReadonlyMap<string, ProspectiveSwapOverride>;
}): CompiledRevisionContext {
  const materialized = materializeAgentMessages(input.canonical.messages);
  const entries = input.canonical.messages.map((record, index) => {
    const canonicalMessage = requireItem(materialized, index, "canonical message");
    const override = input.overrides.get(record.messageId);
    const message =
      override === undefined
        ? canonicalMessage
        : swappedToolMessage(canonicalMessage, override);
    return Object.freeze<CompiledContextEntry>({
      frameId: record.frameId,
      messageId: record.messageId,
      ordinal: record.ordinal,
      representation: override === undefined ? "canonical" : "swapped",
      sourceContentSha256: record.contentSha256,
      message: immutableRecord(message),
    });
  });
  const manifest = Object.freeze({
    frameCount: input.canonical.frames.length,
    messageCount: entries.length,
    canonicalSequenceHash: canonicalSequenceHash(input.canonical),
    renderedMessageHash: renderedMessageHash(entries),
  });
  return Object.freeze({
    sessionId: input.canonical.sessionId,
    revisionId: input.revisionId,
    canonicalThroughOrdinal: input.canonical.messages.length,
    entries: Object.freeze(entries),
    manifest,
  });
}

function swappedToolMessage(
  message: AgentMessage,
  override: ProspectiveSwapOverride,
): AgentMessage {
  if (message.role !== "tool") {
    throw new ContextRevisionError(
      `Swap override at ordinal ${override.ordinal} does not target a tool message.`,
    );
  }
  return {
    ...message,
    content: override.renderedContent,
  };
}

function validateSnapshotIdentity(snapshot: StoredContextSnapshotV4): void {
  if (
    snapshot.meta.sessionId !== snapshot.canonical.sessionId ||
    snapshot.revision.sessionId !== snapshot.canonical.sessionId ||
    snapshot.meta.activeRevisionId !== snapshot.revision.revisionId
  ) {
    throw new ContextRevisionError(
      "Active context revision identity does not match canonical history.",
    );
  }
  if (
    snapshot.revision.revisionNumber !== 1 ||
    snapshot.revision.kind !== "initial_full" ||
    snapshot.revision.keepFromOrdinal !== 1
  ) {
    throw new ContextRevisionError("Unsupported active context revision.");
  }
  const firstFrame = snapshot.canonical.frames[0];
  const firstMessage = snapshot.canonical.messages[0];
  if (
    firstFrame?.kind !== "system" ||
    firstFrame.firstOrdinal !== 1 ||
    firstMessage?.role !== "system" ||
    firstMessage.ordinal !== 1 ||
    snapshot.canonical.messages.at(-1)?.ordinal !== snapshot.canonical.messages.length
  ) {
    throw new ContextRevisionError(
      "Canonical context does not preserve the initial_full ordinal boundary.",
    );
  }
}

function requireItem<T>(items: readonly T[], index: number, name: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new ContextRevisionError(`Missing ${name} at index ${index}.`);
  }
  return item;
}
