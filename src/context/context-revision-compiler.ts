import type { AgentMessage } from "../agent/types";
import { textToolResultContent } from "../agent/tool-result-content";
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
  StoredContextSnapshotV8,
  StoredInitialContextRevisionV8,
  SwapOverride,
} from "./context-revision";
import type { StoredContextSurfaceV8 } from "./context-surface";
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

  compileActive(
    snapshot: StoredContextSnapshotV8,
    options: { readonly allowOpenTail?: boolean } = {},
  ): CompiledRevisionContext {
    validateSnapshotIdentity(snapshot);
    this.protocolValidator.validate(snapshot.canonical, {
      allowOpenTail: options.allowOpenTail,
    });
    const overrides = overrideMap(snapshot.activeOverrides);
    const compiled = compileEntries({
      canonical: snapshot.canonical,
      revisionId: snapshot.revision.revisionId,
      overrides,
      keepFromOrdinal: snapshot.revision.keepFromOrdinal,
      systemPrompt: snapshot.surface.systemPrompt,
      surfaceSha256: snapshot.surface.surfaceSha256,
    });
    this.compiledValidator.validateActive(
      compiled,
      snapshot.canonical,
      snapshot.activeOverrides,
      snapshot.surface,
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

  compileForIdentityRekey(input: {
    canonical: ProtocolContextView;
    revisionId: ContextRevisionId;
    activeOverrides: readonly SwapOverride[];
    keepFromOrdinal: number;
    surface: StoredContextSurfaceV8;
  }): CompiledRevisionContext {
    this.protocolValidator.validate(input.canonical);
    const compiled = compileEntries({
      canonical: input.canonical,
      revisionId: input.revisionId,
      overrides: overrideMap(input.activeOverrides),
      keepFromOrdinal: input.keepFromOrdinal,
      systemPrompt: input.surface.systemPrompt,
      surfaceSha256: input.surface.surfaceSha256,
    });
    this.compiledValidator.validateActive(
      compiled,
      input.canonical,
      input.activeOverrides,
      input.surface,
    );
    return compiled;
  }

  compileProspective(input: {
    active: CompiledRevisionContext;
    canonical: ProtocolContextView;
    activeOverrides: readonly SwapOverride[];
    addedOverrides: readonly SwapOverride[];
    activeSurface: StoredContextSurfaceV8;
    surface?: StoredContextSurfaceV8;
    keepFromOrdinal?: number;
    allowCombinedSurfaceAndOverrides?: boolean;
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
      input.activeSurface,
    );
    const keepFromOrdinal =
      input.keepFromOrdinal ?? input.active.manifest.keepFromOrdinal;
    if (
      !Number.isSafeInteger(keepFromOrdinal) ||
      keepFromOrdinal < input.active.manifest.keepFromOrdinal
    ) {
      throw new ContextRevisionError(
        "Prospective keep boundary must move monotonically forward.",
      );
    }
    const changes = [
      input.addedOverrides.length > 0,
      input.surface !== undefined &&
        input.surface.surfaceSha256 !== input.activeSurface.surfaceSha256,
      keepFromOrdinal > input.active.manifest.keepFromOrdinal,
    ].filter(Boolean).length;
    if (changes > 1 && input.allowCombinedSurfaceAndOverrides !== true) {
      throw new ContextRevisionError(
        "A prospective context revision cannot combine revision semantics.",
      );
    }
    const candidateOverrides =
      keepFromOrdinal > input.active.manifest.keepFromOrdinal
        ? input.activeOverrides.filter(
            (override) => override.ordinal >= keepFromOrdinal,
          )
        : [...input.activeOverrides, ...input.addedOverrides];
    const overrides = overrideMap(candidateOverrides);
    if (overrides.size !== candidateOverrides.length) {
      throw new ContextRevisionError("Prospective overrides contain duplicate IDs.");
    }
    const surface = input.surface ?? input.activeSurface;
    const compiled = compileEntries({
      canonical: input.canonical,
      revisionId: input.active.revisionId,
      overrides,
      keepFromOrdinal,
      systemPrompt: surface.systemPrompt,
      surfaceSha256: surface.surfaceSha256,
    });
    this.compiledValidator.validateProspective(
      compiled,
      input.canonical,
      candidateOverrides,
      surface,
    );
    return compiled;
  }
}

function compileEntries(input: {
  canonical: ProtocolContextView;
  revisionId: CompiledRevisionContext["revisionId"];
  overrides: ReadonlyMap<string, SwapOverride>;
  keepFromOrdinal: number;
  systemPrompt: string;
  surfaceSha256: string;
}): CompiledRevisionContext {
  const records =
    input.keepFromOrdinal === 1
      ? input.canonical.messages
      : [
          requireItem(input.canonical.messages, 0, "canonical system message"),
          ...input.canonical.messages.slice(input.keepFromOrdinal - 1),
        ];
  const materialized = materializeAgentMessages(records);
  const entries = records.map((record, index) => {
    const canonicalMessage = requireItem(materialized, index, "canonical message");
    const override = input.overrides.get(record.messageId);
    const surfacedMessage =
      record.ordinal === 1
        ? surfacedSystemMessage(canonicalMessage, input.systemPrompt)
        : canonicalMessage;
    const message =
      override === undefined
        ? surfacedMessage
        : swappedToolMessage(surfacedMessage, override);
    const representation =
      override !== undefined
        ? "swapped"
        : record.ordinal === 1 && input.systemPrompt !== record.content
          ? "surface"
          : "canonical";
    return Object.freeze<CompiledContextEntry>({
      frameId: record.frameId,
      messageId: record.messageId,
      ordinal: record.ordinal,
      representation,
      sourceContentSha256: record.contentSha256,
      message: immutableRecord(message),
    });
  });
  const manifest = Object.freeze({
    canonicalFrameCount: input.canonical.frames.length,
    canonicalMessageCount: input.canonical.messages.length,
    activeFrameCount:
      input.keepFromOrdinal === 1
        ? input.canonical.frames.length
        : 1 +
          input.canonical.frames.filter(
            (frame) => frame.firstOrdinal >= input.keepFromOrdinal,
          ).length,
    activeMessageCount: entries.length,
    keepFromOrdinal: input.keepFromOrdinal,
    canonicalSequenceHash: canonicalSequenceHash(input.canonical),
    renderedMessageHash: renderedMessageHash(entries),
    surfaceSha256: input.surfaceSha256,
  });
  return Object.freeze({
    sessionId: input.canonical.sessionId,
    revisionId: input.revisionId,
    canonicalThroughOrdinal: input.canonical.messages.length,
    entries: Object.freeze(entries),
    manifest,
  });
}

function surfacedSystemMessage(
  message: AgentMessage,
  systemPrompt: string,
): AgentMessage {
  if (message.role !== "system") {
    throw new ContextRevisionError("Canonical ordinal 1 is not a system message.");
  }
  if (systemPrompt.trim() === "") {
    throw new ContextRevisionError("Active context surface prompt is empty.");
  }
  return { role: "system", content: systemPrompt };
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
    content: textToolResultContent(override.renderedContent),
  };
}

function validateSnapshotIdentity(snapshot: StoredContextSnapshotV8): void {
  if (
    snapshot.meta.sessionId !== snapshot.canonical.sessionId ||
    snapshot.revision.sessionId !== snapshot.canonical.sessionId ||
    snapshot.meta.activeRevisionId !== snapshot.revision.revisionId ||
    snapshot.surface.sessionId !== snapshot.canonical.sessionId ||
    snapshot.surface.surfaceId !== snapshot.revision.surfaceId ||
    snapshot.surface.surfaceSha256 !== snapshot.revision.surfaceSha256
  ) {
    throw new ContextRevisionError(
      "Active context revision identity does not match canonical history.",
    );
  }
  if (
    !Number.isSafeInteger(snapshot.revision.keepFromOrdinal) ||
    snapshot.revision.keepFromOrdinal < 1 ||
    snapshot.revision.keepFromOrdinal > snapshot.revision.sourceThroughOrdinal
  ) {
    throw new ContextRevisionError("Active context revision boundary is invalid.");
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
      snapshot.revision.keepFromOrdinal !== 1 ||
      snapshot.revision.activeOverrideCount !== 0 ||
      snapshot.activeOverrides.length !== 0
    ) {
      throw new ContextRevisionError("Initial context revision invariant failed.");
    }
  } else if (
    snapshot.revision.kind === "swap_only" &&
    (snapshot.revision.revisionNumber < 2 ||
      snapshot.revision.addedOverrideCount < 1 ||
      snapshot.revision.activeOverrideCount < snapshot.revision.addedOverrideCount ||
      snapshot.revision.policyVersion !== "swap-only-v1" ||
      snapshot.revision.rendererFormat !== "swap-observation-v1" ||
      snapshot.activeOverrides.length !== snapshot.revision.activeOverrideCount)
  ) {
    throw new ContextRevisionError("Swap context revision invariant failed.");
  } else if (
    snapshot.revision.kind === "surface_refresh" &&
    (snapshot.revision.revisionNumber < 2 ||
      snapshot.revision.addedOverrideCount !== 0 ||
      snapshot.activeOverrides.length !== snapshot.revision.activeOverrideCount)
  ) {
    throw new ContextRevisionError("Surface context revision invariant failed.");
  } else if (
    snapshot.revision.kind === "prefix_retirement" &&
    (snapshot.revision.revisionNumber < 2 ||
      snapshot.revision.keepFromOrdinal <= 1 ||
      snapshot.revision.addedOverrideCount !== 0 ||
      snapshot.revision.retiredThroughOrdinal !==
        snapshot.revision.keepFromOrdinal - 1 ||
      snapshot.revision.retiredTurnCount < 1 ||
      snapshot.revision.retiredFrameCount < 1 ||
      snapshot.revision.retiredMessageCount < 1 ||
      snapshot.activeOverrides.length !== snapshot.revision.activeOverrideCount)
  ) {
    throw new ContextRevisionError("Prefix retirement revision invariant failed.");
  } else if (
    snapshot.revision.kind === "skills_update" &&
    (snapshot.revision.revisionNumber < 2 ||
      snapshot.revision.addedOverrideCount < 1 ||
      snapshot.revision.activeOverrideCount < snapshot.revision.addedOverrideCount ||
      snapshot.revision.policyVersion !== "agent-skills-v1" ||
      snapshot.revision.rendererFormat !== "skill-activation-receipt-v1" ||
      snapshot.activeOverrides.length !== snapshot.revision.activeOverrideCount)
  ) {
    throw new ContextRevisionError("Agent Skills context revision invariant failed.");
  }

  if (
    snapshot.activeOverrides.some(
      (override) => override.ordinal < snapshot.revision.keepFromOrdinal,
    )
  ) {
    throw new ContextRevisionError(
      "Active context revision contains an override before its keep boundary.",
    );
  }

  if (
    activeOverrideManifestHash(snapshot.activeOverrides) !==
    snapshot.revision.activeOverrideManifestSha256
  ) {
    throw new ContextRevisionError(
      "Active context revision override manifest does not match stored overrides.",
    );
  }
}

export function createInitialContextRevision(input: {
  revisionId: ContextRevisionId;
  canonical: ProtocolContextView;
  surface: StoredContextSurfaceV8;
  createdAt: string;
}): StoredInitialContextRevisionV8 {
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
    firstMessage.ordinal !== 1 ||
    input.surface.sessionId !== input.canonical.sessionId ||
    input.surface.systemPrompt !== firstMessage.content
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
    surfaceId: input.surface.surfaceId,
    surfaceSha256: input.surface.surfaceSha256,
    keepFromOrdinal: 1,
    sourceThroughOrdinal: 1,
    addedOverrideCount: 0,
    activeOverrideCount: 0,
    activeOverrideManifestSha256: activeOverrideManifestHash([]),
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
