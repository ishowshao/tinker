import type { AgentMessage } from "../agent/types";
import type { ContextRevisionId } from "../ids/runtime-id";
import { CompiledContextValidator } from "./compiled-context-validator";
import {
  activeOverrideManifestHash,
  canonicalRenderedMessageHash,
  canonicalSequenceHash,
  renderedMessageHash,
} from "./compiled-context-hash";
import { ContextProtocolValidator } from "./context-protocol-validator";
import type {
  CompiledContextEntry,
  CompiledRevisionContext,
  StoredContextSnapshotV5,
  StoredInitialContextRevisionV5,
  SwapOverride,
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

  compileActive(snapshot: StoredContextSnapshotV5): CompiledRevisionContext {
    validateSnapshotIdentity(snapshot);
    this.protocolValidator.validate(snapshot.canonical);
    const overrides = overrideMap(snapshot.activeOverrides);
    const compiled = compileEntries({
      canonical: snapshot.canonical,
      revisionId: snapshot.revision.revisionId,
      overrides,
    });
    this.compiledValidator.validateActive(
      compiled,
      snapshot.canonical,
      snapshot.activeOverrides,
    );
    if (
      compiled.manifest.canonicalSequenceHash !==
        canonicalSequenceHash(snapshot.canonical) ||
      canonicalSequenceHash(
        snapshot.canonical,
        snapshot.revision.sourceThroughOrdinal,
      ) !== snapshot.revision.canonicalSequenceSha256 ||
      renderedMessageHash(compiled.entries, snapshot.revision.sourceThroughOrdinal) !==
        snapshot.revision.renderedMessageSha256
    ) {
      throw new ContextRevisionError(
        "Active context revision prefix hash does not match stored history.",
      );
    }
    return compiled;
  }

  compileProspective(input: {
    active: CompiledRevisionContext;
    canonical: ProtocolContextView;
    activeOverrides: readonly SwapOverride[];
    addedOverrides: readonly SwapOverride[];
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
    this.compiledValidator.validateActive(
      input.active,
      input.canonical,
      input.activeOverrides,
    );
    const candidateOverrides = [...input.activeOverrides, ...input.addedOverrides];
    const overrides = overrideMap(candidateOverrides);
    if (overrides.size !== candidateOverrides.length) {
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
      candidateOverrides,
    );
    return compiled;
  }
}

function compileEntries(input: {
  canonical: ProtocolContextView;
  revisionId: CompiledRevisionContext["revisionId"];
  overrides: ReadonlyMap<string, SwapOverride>;
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
  override: SwapOverride,
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

function validateSnapshotIdentity(snapshot: StoredContextSnapshotV5): void {
  if (
    snapshot.meta.sessionId !== snapshot.canonical.sessionId ||
    snapshot.revision.sessionId !== snapshot.canonical.sessionId ||
    snapshot.meta.activeRevisionId !== snapshot.revision.revisionId
  ) {
    throw new ContextRevisionError(
      "Active context revision identity does not match canonical history.",
    );
  }
  if (snapshot.revision.keepFromOrdinal !== 1) {
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
  const boundaryFrame = snapshot.canonical.frames.find(
    (frame) => frame.lastOrdinal === snapshot.revision.sourceThroughOrdinal,
  );
  if (
    snapshot.revision.sourceThroughOrdinal > snapshot.canonical.messages.length ||
    boundaryFrame?.state !== "closed"
  ) {
    throw new ContextRevisionError(
      "Active context revision source boundary is not a closed frame boundary.",
    );
  }

  if (snapshot.revision.kind === "initial_full") {
    if (
      snapshot.revision.revisionNumber !== 1 ||
      snapshot.revision.parentRevisionId !== null ||
      snapshot.revision.sourceThroughOrdinal !== 1 ||
      snapshot.revision.addedOverrideCount !== 0 ||
      snapshot.revision.totalOverrideCount !== 0 ||
      snapshot.activeOverrides.length !== 0
    ) {
      throw new ContextRevisionError("Initial context revision invariant failed.");
    }
  } else if (
    snapshot.revision.revisionNumber < 2 ||
    snapshot.revision.addedOverrideCount < 1 ||
    snapshot.revision.totalOverrideCount < snapshot.revision.addedOverrideCount ||
    snapshot.revision.policyVersion !== "swap-only-v1" ||
    snapshot.revision.rendererFormat !== "swap-observation-v1" ||
    snapshot.activeOverrides.length !== snapshot.revision.totalOverrideCount
  ) {
    throw new ContextRevisionError("Swap context revision invariant failed.");
  }

  if (
    activeOverrideManifestHash(snapshot.activeOverrides) !==
    snapshot.revision.overrideManifestSha256
  ) {
    throw new ContextRevisionError(
      "Active context revision override manifest does not match stored overrides.",
    );
  }
}

export function createInitialContextRevision(input: {
  revisionId: ContextRevisionId;
  canonical: ProtocolContextView;
  createdAt: string;
}): StoredInitialContextRevisionV5 {
  const firstFrame = input.canonical.frames[0];
  const firstMessage = input.canonical.messages[0];
  if (
    input.canonical.messages.length !== 1 ||
    input.canonical.frames.length !== 1 ||
    firstFrame?.kind !== "system" ||
    firstFrame.state !== "closed" ||
    firstFrame.firstOrdinal !== 1 ||
    firstFrame.lastOrdinal !== 1 ||
    firstMessage?.role !== "system" ||
    firstMessage.ordinal !== 1
  ) {
    throw new ContextRevisionError(
      "Initial context revision requires exactly one closed system frame.",
    );
  }
  return Object.freeze({
    revisionId: input.revisionId,
    sessionId: input.canonical.sessionId,
    revisionNumber: 1,
    parentRevisionId: null,
    kind: "initial_full",
    keepFromOrdinal: 1,
    sourceThroughOrdinal: 1,
    addedOverrideCount: 0,
    totalOverrideCount: 0,
    overrideManifestSha256: activeOverrideManifestHash([]),
    canonicalSequenceSha256: canonicalSequenceHash(input.canonical, 1),
    renderedMessageSha256: canonicalRenderedMessageHash(input.canonical, 1),
    createdAt: input.createdAt,
  });
}

function overrideMap(
  overrides: readonly SwapOverride[],
): ReadonlyMap<string, SwapOverride> {
  return new Map(overrides.map((override) => [override.messageId, override] as const));
}

function requireItem<T>(items: readonly T[], index: number, name: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new ContextRevisionError(`Missing ${name} at index ${index}.`);
  }
  return item;
}
