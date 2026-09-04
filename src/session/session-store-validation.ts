import type { Database } from "bun:sqlite";
import { activeOverrideManifestHash } from "../context/compiled-context-hash";
import type {
  StoredContextOverrideV8,
  StoredContextRevisionV8,
  StoredContextSnapshotV8,
  SwapOverride,
} from "../context/context-revision";
import { ContextRevisionCompiler } from "../context/context-revision-compiler";
import {
  contextSurfaceChangeManifestHash,
  contextSurfaceChanges,
  validateStoredContextSurface,
  type StoredContextSurfaceV8,
} from "../context/context-surface";
import {
  ContextSwapRenderer,
  SWAP_OBSERVATION_FORMAT,
  SWAP_TOOL_IMAGE_FORMAT,
} from "../context/context-swap-renderer";
import {
  type CanonicalMessageRecord,
  type ProtocolContextView,
  type ToolResultRecord,
} from "../context/protocol-frame";
import type {
  ContextRevisionId,
  ContextSurfaceId,
  MessageId,
  SessionId,
} from "../ids/runtime-id";
import { stableJsonStringify } from "../model/model-request-preflight";
import {
  renderSkillActivationReceipt,
  SKILL_ACTIVATION_RECEIPT_FORMAT,
} from "../skills/skill-context";
import type { SessionStore } from "./session-store";
import {
  loadMeasuredContextState,
  previousRevision,
  requireActiveRevisionId,
} from "./session-store-context-readers";
import {
  skillActivationManifestSha256,
  type StoredSessionMetaV10,
} from "./session-store-contracts";
import {
  decodeContextRevision,
  decodeContextSurface,
  decodeStoredSwapOverride,
  protocolPrefixView,
  stripStoredOverride,
} from "./session-store-record-codecs";
import { requireItem } from "./session-store-sql";
import {
  enumFromSql,
  nullableStringFromSql,
  numberFromSql,
  stringFromSql,
} from "./session-store-value-codecs";

/** Validates persisted state without mutating canonical history. */
export class SessionStoreValidation {
  private readonly revisionCompiler = new ContextRevisionCompiler();
  private readonly swapRenderer = new ContextSwapRenderer();
  constructor(
    private readonly database: Database,
    private readonly sessionId: SessionId,
    private readonly loadSkillActivations: SessionStore["loadSkillActivations"],
  ) {}

  loadValidatedContextSnapshot(
    meta: StoredSessionMetaV10,
    canonical: ProtocolContextView,
  ): StoredContextSnapshotV8 {
    const activeRevisionId = requireActiveRevisionId(meta);
    const surfaces = this.database
      .query("SELECT * FROM context_surfaces ORDER BY rowid")
      .all()
      .map(decodeContextSurface);
    const surfacesById = new Map<ContextSurfaceId, StoredContextSurfaceV8>();
    for (const surface of surfaces) {
      validateStoredContextSurface(surface);
      if (surface.sessionId !== this.sessionId || surfacesById.has(surface.surfaceId)) {
        throw new Error("Context surface identity is invalid or duplicated.");
      }
      surfacesById.set(surface.surfaceId, surface);
    }

    const revisions = this.database
      .query("SELECT * FROM context_revisions ORDER BY revision_number")
      .all()
      .map(decodeContextRevision);
    if (revisions.length === 0) {
      throw new Error("Session has no context revision.");
    }

    const revisionNumberById = new Map<ContextRevisionId, number>();
    for (let index = 0; index < revisions.length; index += 1) {
      const revision = requireItem(revisions, index, "context revision");
      const previous = revisions[index - 1];
      const surface = surfacesById.get(revision.surfaceId);
      if (
        revision.sessionId !== this.sessionId ||
        revision.revisionNumber !== index + 1 ||
        surface === undefined ||
        surface.surfaceSha256 !== revision.surfaceSha256 ||
        (index === 0
          ? revision.kind !== "initial_full" || revision.parentRevisionId !== null
          : revision.kind === "initial_full" ||
            revision.parentRevisionId !== previous?.revisionId) ||
        ((revision.kind === "swap_only" || revision.kind === "prefix_retirement") &&
          revision.surfaceId !== previous?.surfaceId) ||
        (revision.kind === "surface_refresh" &&
          revision.surfaceId === previous?.surfaceId) ||
        (previous !== undefined &&
          (revision.keepFromOrdinal < previous.keepFromOrdinal ||
            ((revision.kind === "swap_only" ||
              revision.kind === "surface_refresh" ||
              revision.kind === "skills_update") &&
              revision.keepFromOrdinal !== previous.keepFromOrdinal) ||
            (revision.kind === "prefix_retirement" &&
              revision.keepFromOrdinal <= previous.keepFromOrdinal)))
      ) {
        throw new Error("Context revision chain is not linear and contiguous.");
      }
      const boundary = canonical.frames.find(
        (frame) => frame.lastOrdinal === revision.sourceThroughOrdinal,
      );
      if (
        revision.sourceThroughOrdinal > canonical.messages.length ||
        boundary?.state !== "closed"
      ) {
        throw new Error(
          `Context revision ${revision.revisionId} has an invalid source boundary.`,
        );
      }
      revisionNumberById.set(revision.revisionId, revision.revisionNumber);
    }
    const introducedSurfaceIds = new Set(
      revisions.flatMap((revision, index) => {
        const previous = revisions[index - 1];
        return revision.kind === "initial_full" ||
          revision.kind === "surface_refresh" ||
          (revision.kind === "skills_update" &&
            revision.surfaceId !== previous?.surfaceId)
          ? [revision.surfaceId]
          : [];
      }),
    );
    if (
      introducedSurfaceIds.size !== surfaces.length ||
      surfaces.some((surface) => !introducedSurfaceIds.has(surface.surfaceId))
    ) {
      throw new Error("Context surface chain contains an orphan or duplicate surface.");
    }

    const activeRevision = requireItem(
      revisions,
      revisions.length - 1,
      "active context revision",
    );
    if (activeRevision.revisionId !== activeRevisionId) {
      throw new Error("Active context revision is not the latest committed revision.");
    }
    const activeSurface = surfacesById.get(activeRevision.surfaceId);
    if (activeSurface === undefined) {
      throw new Error("Active context revision surface is missing.");
    }

    const overrides = this.database
      .query(
        `SELECT co.* FROM context_overrides co
         JOIN context_revisions cr
           ON cr.revision_id = co.introduced_revision_id
         ORDER BY cr.revision_number, co.ordinal`,
      )
      .all()
      .map(decodeStoredSwapOverride);
    this.validateStoredOverrides(overrides, canonical, revisions, revisionNumberById);
    this.validateSkillActivationRows(canonical, revisions, overrides, surfaces);

    for (const revision of revisions) {
      const surface = surfacesById.get(revision.surfaceId);
      if (surface === undefined) {
        throw new Error(`Context revision ${revision.revisionId} has no surface.`);
      }
      const activeOverrides = overrides.filter(
        (override) =>
          (revisionNumberById.get(override.introducedRevisionId) ??
            Number.POSITIVE_INFINITY) <= revision.revisionNumber &&
          override.ordinal >= revision.keepFromOrdinal,
      );
      const introducedCount = overrides.filter(
        (override) => override.introducedRevisionId === revision.revisionId,
      ).length;
      if (
        introducedCount !== revision.addedOverrideCount ||
        activeOverrides.length !== revision.activeOverrideCount ||
        activeOverrideManifestHash(activeOverrides) !==
          revision.activeOverrideManifestSha256
      ) {
        throw new Error(
          `Context revision ${revision.revisionId} override manifest is invalid.`,
        );
      }
      if (
        revision.kind === "surface_refresh" &&
        previousRevision(revisions, revision)?.activeOverrideManifestSha256 !==
          revision.activeOverrideManifestSha256
      ) {
        throw new Error(
          `Context surface revision ${revision.revisionId} changed overrides.`,
        );
      }
      if (revision.kind === "skills_update") {
        const parent = previousRevision(revisions, revision);
        const parentSurface =
          parent === undefined ? undefined : surfacesById.get(parent.surfaceId);
        const settlements = this.loadSkillActivations().filter(
          (activation) => activation.settledRevisionId === revision.revisionId,
        );
        if (
          parentSurface === undefined ||
          contextSurfaceChangeManifestHash(
            contextSurfaceChanges(parentSurface, surface),
          ) !== revision.changeManifestSha256 ||
          settlements.length !== revision.addedOverrideCount ||
          skillActivationManifestSha256(
            settlements.map((activation) => ({
              activationMessageId: activation.activationMessageId,
              name: activation.name,
              state: activation.state === "promoted" ? "promoted" : "rejected",
              ...(activation.rejectionReason === undefined
                ? {}
                : { rejectionReason: activation.rejectionReason }),
            })),
          ) !== revision.activationManifestSha256
        ) {
          throw new Error(
            `Agent Skills revision ${revision.revisionId} manifest is invalid.`,
          );
        }
      }
      if (revision.kind === "prefix_retirement") {
        const parent = previousRevision(revisions, revision);
        if (parent === undefined) {
          throw new Error("Prefix retirement revision has no parent.");
        }
        const retiredStart = Math.max(parent.keepFromOrdinal, 2);
        const retiredMessages = canonical.messages.filter(
          (message) =>
            message.ordinal >= retiredStart &&
            message.ordinal < revision.keepFromOrdinal,
        );
        const retiredFrames = canonical.frames.filter(
          (frame) =>
            frame.firstOrdinal >= retiredStart &&
            (frame.lastOrdinal ?? Number.POSITIVE_INFINITY) < revision.keepFromOrdinal,
        );
        const retiredTurns = new Set(
          retiredMessages.flatMap((message) =>
            message.role === "system" ? [] : [message.turnId],
          ),
        );
        if (
          revision.retiredThroughOrdinal !== revision.keepFromOrdinal - 1 ||
          revision.retiredMessageCount !== retiredMessages.length ||
          revision.retiredFrameCount !== retiredFrames.length ||
          revision.retiredTurnCount !== retiredTurns.size
        ) {
          throw new Error(
            `Context retirement revision ${revision.revisionId} counts are invalid.`,
          );
        }
      }
      if (revision.kind === "surface_refresh") {
        const parent = previousRevision(revisions, revision);
        const parentSurface =
          parent === undefined ? undefined : surfacesById.get(parent.surfaceId);
        if (
          parentSurface === undefined ||
          contextSurfaceChangeManifestHash(
            contextSurfaceChanges(parentSurface, surface),
          ) !== revision.changeManifestSha256
        ) {
          throw new Error(
            `Context surface revision ${revision.revisionId} change manifest is invalid.`,
          );
        }
      }
      const prefix = protocolPrefixView(canonical, revision.sourceThroughOrdinal);
      this.revisionCompiler.compileActive({
        meta: Object.freeze({
          sessionId: this.sessionId,
          activeRevisionId: revision.revisionId,
        }),
        revision,
        surface,
        activeOverrides,
        canonical: prefix,
      });
    }

    const measurement = loadMeasuredContextState(this.database, this.sessionId);
    if (
      measurement !== undefined &&
      measurement.revisionId !== activeRevision.revisionId
    ) {
      throw new Error("Context measurement is not bound to the active revision.");
    }

    return Object.freeze({
      meta: Object.freeze({
        sessionId: meta.sessionId,
        activeRevisionId,
      }),
      revision: activeRevision,
      surface: activeSurface,
      activeOverrides: Object.freeze(
        overrides.filter(
          (override) =>
            (revisionNumberById.get(override.introducedRevisionId) ??
              Number.POSITIVE_INFINITY) <= activeRevision.revisionNumber &&
            override.ordinal >= activeRevision.keepFromOrdinal,
        ),
      ),
      canonical,
    });
  }

  private validateStoredOverrides(
    overrides: readonly StoredContextOverrideV8[],
    canonical: ProtocolContextView,
    revisions: readonly StoredContextRevisionV8[],
    revisionNumberById: ReadonlyMap<ContextRevisionId, number>,
  ): void {
    const messages = new Map(
      canonical.messages.map((message) => [message.messageId, message] as const),
    );
    const frames = new Map(
      canonical.frames.map((frame) => [frame.frameId, frame] as const),
    );
    const results = new Map(
      canonical.toolResults.map((result) => [result.toolMessageId, result] as const),
    );
    const revisionsById = new Map(
      revisions.map((revision) => [revision.revisionId, revision] as const),
    );
    const seenMessages = new Set<MessageId>();
    for (const override of overrides) {
      const revision = revisionsById.get(override.introducedRevisionId);
      const message = messages.get(override.messageId);
      const frame = frames.get(override.frameId);
      const result = results.get(override.messageId);
      if (
        (revision?.kind !== "swap_only" && revision?.kind !== "skills_update") ||
        (revision.kind === "swap_only" &&
          override.rendererFormat !== SWAP_OBSERVATION_FORMAT &&
          override.rendererFormat !== SWAP_TOOL_IMAGE_FORMAT) ||
        (revision.kind === "skills_update" &&
          override.rendererFormat !== SKILL_ACTIVATION_RECEIPT_FORMAT) ||
        revisionNumberById.get(revision.revisionId) === undefined ||
        override.ordinal < revision.keepFromOrdinal ||
        override.ordinal > revision.sourceThroughOrdinal ||
        seenMessages.has(override.messageId) ||
        message?.role !== "tool" ||
        message.frameId !== override.frameId ||
        message.ordinal !== override.ordinal ||
        frame?.kind !== "tool_exchange" ||
        frame.state !== "closed" ||
        result === undefined
      ) {
        throw new Error("Stored context override canonical identity is invalid.");
      }
      const rendered =
        override.rendererFormat === SWAP_OBSERVATION_FORMAT ||
        override.rendererFormat === SWAP_TOOL_IMAGE_FORMAT
          ? this.swapRenderer.render({ message, result })
          : this.renderStoredSkillReceipt(message, result, revision.revisionId);
      if (
        stableJsonStringify(rendered) !==
        stableJsonStringify(stripStoredOverride(override))
      ) {
        throw new Error(
          `Stored context override ${override.messageId} does not match deterministic rendering.`,
        );
      }
      seenMessages.add(override.messageId);
    }
  }

  private validateSkillActivationRows(
    canonical: ProtocolContextView,
    revisions: readonly StoredContextRevisionV8[],
    overrides: readonly StoredContextOverrideV8[],
    surfaces: readonly StoredContextSurfaceV8[],
  ): void {
    const activations = this.loadSkillActivations();
    const activationByMessage = new Map(
      activations.map((activation) => [activation.activationMessageId, activation]),
    );
    const messages = new Map(
      canonical.messages.map((message) => [message.messageId, message]),
    );
    const results = new Map(
      canonical.toolResults.map((result) => [result.toolMessageId, result]),
    );
    const loadedResults = canonical.toolResults.filter(
      (result) =>
        result.completion.kind === "returned" &&
        result.completion.raw.kind === "skill" &&
        result.completion.raw.ok &&
        result.completion.raw.status === "loaded",
    );
    if (loadedResults.length !== activations.length) {
      throw new Error("Loaded Agent Skill results and activation rows differ.");
    }
    const revisionsById = new Map(
      revisions.map((revision) => [revision.revisionId, revision]),
    );
    const overridesByMessage = new Map(
      overrides.map((override) => [override.messageId, override]),
    );
    for (const activation of activations) {
      const message = messages.get(activation.activationMessageId);
      const result = results.get(activation.activationMessageId);
      const raw =
        result?.completion.kind === "returned" ? result.completion.raw : undefined;
      if (
        activation.sessionId !== this.sessionId ||
        message?.role !== "tool" ||
        message.name !== "Skill" ||
        message.toolCallId !== activation.toolCallId ||
        raw?.kind !== "skill" ||
        !raw.ok ||
        raw.status !== "loaded" ||
        raw.name !== activation.name ||
        raw.scope !== activation.scope ||
        raw.sha256 !== activation.skillFileSha256
      ) {
        throw new Error("Agent Skill activation canonical identity is invalid.");
      }
      if (activation.settledRevisionId !== undefined) {
        const revision = revisionsById.get(activation.settledRevisionId);
        const override = overridesByMessage.get(activation.activationMessageId);
        if (
          revision?.kind !== "skills_update" ||
          override?.introducedRevisionId !== revision.revisionId ||
          override.rendererFormat !== SKILL_ACTIVATION_RECEIPT_FORMAT
        ) {
          throw new Error("Settled Agent Skill activation receipt is invalid.");
        }
      }
    }
    for (const surface of surfaces) {
      for (const active of surface.activeSkills) {
        const activation = activationByMessage.get(active.activationMessageId);
        if (activation?.state !== "promoted" || activation.name !== active.name) {
          throw new Error(
            "Context surface references an invalid Agent Skill activation.",
          );
        }
      }
    }
  }

  private renderStoredSkillReceipt(
    message: Extract<CanonicalMessageRecord, { role: "tool" }>,
    result: ToolResultRecord,
    revisionId: ContextRevisionId,
  ): SwapOverride {
    if (
      message.name !== "Skill" ||
      result.completion.kind !== "returned" ||
      result.completion.raw.kind !== "skill" ||
      !result.completion.raw.ok ||
      result.completion.raw.status !== "loaded"
    ) {
      throw new Error("Agent Skill receipt does not target a loaded Skill result.");
    }
    const activation = this.loadSkillActivations().find(
      (entry) => entry.activationMessageId === message.messageId,
    );
    if (
      activation === undefined ||
      activation.settledRevisionId !== revisionId ||
      (activation.state !== "promoted" && activation.state !== "rejected")
    ) {
      throw new Error("Agent Skill receipt has no matching settled activation.");
    }
    return renderSkillActivationReceipt({
      message: {
        messageId: message.messageId,
        frameId: message.frameId,
        ordinal: message.ordinal,
        content: message.displayText,
        contentSha256: message.contentSha256,
      },
      name: activation.name,
      outcome:
        activation.state === "promoted"
          ? "promoted"
          : activation.rejectionReason === "unavailable"
            ? "unavailable"
            : "rejected",
    });
  }

  validateCounters(meta: StoredSessionMetaV10, view: ProtocolContextView): void {
    const turns = this.database
      .query("SELECT * FROM turns ORDER BY turn_number")
      .all() as Array<Record<string, unknown>>;
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      if (numberFromSql(turn.turn_number, "turn_number") !== index + 1) {
        throw new Error("Turn number sequence has a gap.");
      }
      const turnId = stringFromSql(turn.turn_id, "turn_id");
      const turnStatus = enumFromSql(
        turn.status,
        ["open", "completed", "failed", "cancelled", "interrupted"] as const,
        "turn status",
      );
      const iterations = this.database
        .query("SELECT * FROM iterations WHERE turn_id = ? ORDER BY iteration_number")
        .all(turnId) as Array<Record<string, unknown>>;
      const storedLastIterationId = nullableStringFromSql(
        turn.last_iteration_id,
        "last_iteration_id",
      );
      const actualLastIterationId =
        iterations.length === 0
          ? null
          : stringFromSql(iterations.at(-1)!.iteration_id, "iteration_id");
      if (storedLastIterationId !== actualLastIterationId) {
        throw new Error(`Last iteration identity is invalid in turn ${turnId}.`);
      }
      for (
        let iterationIndex = 0;
        iterationIndex < iterations.length;
        iterationIndex += 1
      ) {
        const iteration = iterations[iterationIndex];
        if (
          numberFromSql(iteration.iteration_number, "iteration_number") !==
          iterationIndex + 1
        ) {
          throw new Error(`Iteration number sequence has a gap in turn ${turnId}.`);
        }
        const iterationId = stringFromSql(iteration.iteration_id, "iteration_id");
        const outcome = enumFromSql(
          iteration.outcome,
          [
            "open",
            "continue",
            "completed",
            "failed",
            "cancelled",
            "interrupted",
          ] as const,
          "iteration outcome",
        );
        if (iterationIndex < iterations.length - 1 && outcome !== "continue") {
          throw new Error(
            `Non-final iteration ${iterationId} must have continue outcome.`,
          );
        }
        const toolCalls = view.messages.flatMap((message) =>
          message.role === "assistant" && message.iterationId === iterationId
            ? (message.toolCalls ?? [])
            : [],
        );
        if (
          numberFromSql(iteration.next_tool_call_number, "next_tool_call_number") !==
          toolCalls.length + 1
        ) {
          throw new Error(`Tool call counter is invalid in iteration ${iterationId}.`);
        }
      }
      if (
        numberFromSql(turn.next_iteration_number, "next_iteration_number") !==
        iterations.length + 1
      ) {
        throw new Error(`Iteration counter is invalid in turn ${turnId}.`);
      }
      const openIterationCount = iterations.filter(
        (iteration) => iteration.outcome === "open",
      ).length;
      if (turnStatus === "open" && openIterationCount > 1) {
        throw new Error(`Open turn ${turnId} has multiple open iterations.`);
      }
      if (turnStatus !== "open" && openIterationCount !== 0) {
        throw new Error(`Terminal turn ${turnId} still has an open iteration.`);
      }
      const lastOutcome = iterations.at(-1)?.outcome;
      if (
        turnStatus !== "open" &&
        iterations.length > 0 &&
        lastOutcome !== turnStatus &&
        !(turnStatus === "interrupted" && lastOutcome === "continue")
      ) {
        throw new Error(
          `Terminal turn ${turnId} does not match its last iteration outcome.`,
        );
      }
      const finalMessageId = nullableStringFromSql(
        turn.final_message_id,
        "final_message_id",
      );
      if (turnStatus === "completed") {
        const finalMessage = view.messages.find(
          (message) => message.messageId === finalMessageId,
        );
        const lastTurnMessage = [...view.messages]
          .reverse()
          .find((message) => "turnId" in message && message.turnId === turnId);
        if (
          finalMessage?.role !== "assistant" ||
          finalMessage.turnId !== turnId ||
          (finalMessage.toolCalls?.length ?? 0) !== 0 ||
          lastTurnMessage?.messageId !== finalMessage.messageId
        ) {
          throw new Error(`Final message identity is invalid in turn ${turnId}.`);
        }
      } else if (finalMessageId !== null) {
        throw new Error(`Non-completed turn ${turnId} has a final message.`);
      }
    }
    if (meta.nextTurnNumber !== turns.length + 1) {
      throw new Error("Session turn counter is invalid.");
    }
  }

  validateAddedOverrides(
    overrides: readonly SwapOverride[],
    canonical: ProtocolContextView,
  ): void {
    const messages = new Map(
      canonical.messages.map((message) => [message.messageId, message] as const),
    );
    const results = new Map(
      canonical.toolResults.map((result) => [result.toolMessageId, result] as const),
    );
    for (const override of overrides) {
      const message = messages.get(override.messageId);
      const result = results.get(override.messageId);
      if (message?.role !== "tool" || result === undefined) {
        throw new Error("Added context override does not target a tool result.");
      }
      const expected = this.swapRenderer.render({ message, result });
      if (stableJsonStringify(expected) !== stableJsonStringify(override)) {
        throw new Error("Added context override is not deterministic.");
      }
    }
  }
}
