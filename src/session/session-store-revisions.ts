import type { Database } from "bun:sqlite";
import {
  activeOverrideManifestHash,
  canonicalSequenceHash,
  renderedMessageHash,
} from "../context/compiled-context-hash";
import type {
  StoredContextRevisionV8,
  SwapOverride,
} from "../context/context-revision";
import { ContextRevisionCompiler } from "../context/context-revision-compiler";
import {
  contextSurfaceChangeManifestHash,
  contextSurfaceChanges,
  validateStoredContextSurface,
} from "../context/context-surface";
import { SWAP_OBSERVATION_FORMAT } from "../context/context-swap-renderer";
import { type ProtocolContextView } from "../context/protocol-frame";
import type { SessionId } from "../ids/runtime-id";
import { stableJsonStringify } from "../model/model-request-preflight";
import {
  renderSkillActivationReceipt,
  SKILL_ACTIVATION_RECEIPT_FORMAT,
  SKILL_POLICY_VERSION,
} from "../skills/skill-context";
import { sessionWriteError } from "./session-errors";
import type { SessionStore } from "./session-store";
import {
  loadMeasuredContextState,
  readRetirementBoundaries,
  requireActiveRevisionId,
} from "./session-store-context-readers";
import {
  skillActivationManifestSha256,
  type CommitPrefixRetirementRevisionInput,
  type CommitPrefixRetirementRevisionOptions,
  type CommitSkillsUpdateInput,
  type CommitSkillsUpdateOptions,
  type CommitSurfaceRefreshInput,
  type CommitSurfaceRefreshOptions,
  type CommitSwapRevisionInput,
  type CommitSwapRevisionOptions,
} from "./session-store-contracts";
import { decodeStoredSwapOverride } from "./session-store-record-codecs";
import { insertContextSurface } from "./session-store-record-writer";
import { requireItem, requireSingleChange, runTransaction } from "./session-store-sql";

type RevisionStore = Pick<
  SessionStore,
  | "loadContextSnapshot"
  | "assertContextRevisionBoundary"
  | "assertContextRevisionIdle"
  | "readMeta"
  | "loadSkillActivations"
>;
/** Each operation owns its complete validation-and-write transaction. */
export class SessionStoreRevisions {
  private readonly revisionCompiler = new ContextRevisionCompiler();
  constructor(
    private readonly database: Database,
    private readonly sessionId: SessionId,
    private readonly clock: () => string,
    private readonly store: RevisionStore,
    private readonly requireOpen: () => void,
    private readonly validateAddedOverrides: (
      overrides: readonly SwapOverride[],
      canonical: ProtocolContextView,
    ) => void,
  ) {}

  commitSwapRevision(
    input: CommitSwapRevisionInput,
    options: CommitSwapRevisionOptions = {},
  ): Extract<StoredContextRevisionV8, { kind: "swap_only" }> {
    this.requireOpen();
    assertCommitSwapRevisionInput(input);
    const now = this.clock();
    try {
      return runTransaction(this.database, () => {
        const snapshot = this.store.loadContextSnapshot();
        const baseRevision = snapshot.revision;
        if (
          baseRevision.revisionId !== input.expectedBaseRevisionId ||
          baseRevision.revisionNumber !== input.expectedBaseRevisionNumber ||
          snapshot.canonical.messages.length !==
            input.expectedCanonicalThroughOrdinal ||
          baseRevision.activeOverrideManifestSha256 !==
            input.expectedBaseActiveOverrideManifestSha256
        ) {
          throw new Error("Context revision commit base is stale.");
        }
        this.store.assertContextRevisionBoundary(input.activeTurnId);

        const active = this.revisionCompiler.compileActive(snapshot);
        const candidateOverrides = [
          ...snapshot.activeOverrides,
          ...input.addedOverrides,
        ];
        if (
          new Set(candidateOverrides.map((override) => override.messageId)).size !==
            candidateOverrides.length ||
          activeOverrideManifestHash(candidateOverrides) !==
            input.nextActiveOverrideManifestSha256
        ) {
          throw new Error("Candidate override manifest is invalid.");
        }
        const candidate = this.revisionCompiler.compileProspective({
          active,
          canonical: snapshot.canonical,
          activeOverrides: snapshot.activeOverrides,
          addedOverrides: input.addedOverrides,
          activeSurface: snapshot.surface,
        });
        if (
          canonicalSequenceHash(
            snapshot.canonical,
            input.expectedCanonicalThroughOrdinal,
          ) !== input.canonicalSequenceSha256 ||
          renderedMessageHash(
            candidate.entries,
            input.expectedCanonicalThroughOrdinal,
          ) !== input.renderedMessageSha256
        ) {
          throw new Error("Candidate context revision prefix hash is invalid.");
        }
        this.validateAddedOverrides(input.addedOverrides, snapshot.canonical);

        const revisionNumber = baseRevision.revisionNumber + 1;
        const activeOverrideCount =
          baseRevision.activeOverrideCount + input.addedOverrides.length;
        options.faultInjector?.("before_revision_insert");
        this.database
          .query(
            `INSERT INTO context_revisions (
              revision_id, session_id, revision_number, parent_revision_id, kind,
              surface_id, surface_sha256, keep_from_ordinal,
              source_through_ordinal, added_override_count,
              active_override_count, active_override_manifest_sha256,
              canonical_sequence_sha256, rendered_message_sha256, policy_version,
              renderer_format, plan_sha256, change_manifest_sha256, created_at
            ) VALUES (?, ?, ?, ?, 'swap_only', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          )
          .run(
            input.revisionId,
            this.sessionId,
            revisionNumber,
            baseRevision.revisionId,
            baseRevision.surfaceId,
            baseRevision.surfaceSha256,
            baseRevision.keepFromOrdinal,
            input.expectedCanonicalThroughOrdinal,
            input.addedOverrides.length,
            activeOverrideCount,
            input.nextActiveOverrideManifestSha256,
            input.canonicalSequenceSha256,
            input.renderedMessageSha256,
            input.policyVersion,
            input.rendererFormat,
            input.planHash,
            now,
          );
        options.faultInjector?.("after_revision_insert");

        for (let index = 0; index < input.addedOverrides.length; index += 1) {
          const override = requireItem(
            input.addedOverrides,
            index,
            "added context override",
          );
          this.database
            .query(
              `INSERT INTO context_overrides (
                introduced_revision_id, session_id, message_id, frame_id, ordinal,
                representation, renderer_format, source, original_content_sha256,
                rendered_content, rendered_content_sha256, original_bytes,
                rendered_bytes, byte_savings, created_at
              ) VALUES (?, ?, ?, ?, ?, 'swapped', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.revisionId,
              this.sessionId,
              override.messageId,
              override.frameId,
              override.ordinal,
              input.rendererFormat,
              override.source,
              override.originalContentSha256,
              override.renderedContent,
              override.renderedContentSha256,
              override.originalBytes,
              override.renderedBytes,
              override.byteSavings,
              now,
            );
          if (index === 0) {
            options.faultInjector?.("after_first_override_insert");
          }
        }
        options.faultInjector?.("after_overrides_insert");

        const storedCandidateOverrides = this.database
          .query(
            `SELECT co.* FROM context_overrides co
             JOIN context_revisions cr
               ON cr.revision_id = co.introduced_revision_id
             WHERE cr.revision_number <= ? AND co.ordinal >= ?
             ORDER BY co.ordinal`,
          )
          .all(revisionNumber, baseRevision.keepFromOrdinal)
          .map(decodeStoredSwapOverride);
        if (
          storedCandidateOverrides.length !== activeOverrideCount ||
          activeOverrideManifestHash(storedCandidateOverrides) !==
            input.nextActiveOverrideManifestSha256
        ) {
          throw new Error("Stored candidate override readback is invalid.");
        }

        this.database.query("DELETE FROM context_measurement_state").run();
        options.faultInjector?.("after_measurement_delete");
        const switched = this.database
          .query(
            `UPDATE session_meta
             SET active_revision_id = ?, updated_at = ?
             WHERE singleton = 1 AND active_revision_id = ?`,
          )
          .run(input.revisionId, now, baseRevision.revisionId);
        requireSingleChange(
          this.database,
          switched.changes,
          "activate context revision",
        );
        options.faultInjector?.("after_active_update");

        const readback = this.store.loadContextSnapshot();
        if (
          readback.revision.kind !== "swap_only" ||
          readback.revision.revisionId !== input.revisionId ||
          loadMeasuredContextState(this.database, this.sessionId) !== undefined
        ) {
          throw new Error("Committed context revision readback failed.");
        }
        return readback.revision;
      });
    } catch (error) {
      if (
        requireActiveRevisionId(this.store.readMeta()) !== input.expectedBaseRevisionId
      ) {
        throw new Error("Failed context revision transaction changed active state.", {
          cause: error,
        });
      }
      throw sessionWriteError("commit_context_revision", this.sessionId, error);
    }
  }

  commitPrefixRetirementRevision(
    input: CommitPrefixRetirementRevisionInput,
    options: CommitPrefixRetirementRevisionOptions = {},
  ): Extract<StoredContextRevisionV8, { kind: "prefix_retirement" }> {
    this.requireOpen();
    assertCommitPrefixRetirementRevisionInput(input);
    const now = this.clock();
    try {
      return runTransaction(this.database, () => {
        const snapshot = this.store.loadContextSnapshot();
        const baseRevision = snapshot.revision;
        if (
          baseRevision.revisionId !== input.expectedBaseRevisionId ||
          baseRevision.revisionNumber !== input.expectedBaseRevisionNumber ||
          baseRevision.keepFromOrdinal !== input.expectedBaseKeepFromOrdinal ||
          snapshot.canonical.messages.length !==
            input.expectedCanonicalThroughOrdinal ||
          snapshot.surface.surfaceSha256 !== input.expectedSurfaceSha256 ||
          baseRevision.activeOverrideManifestSha256 !==
            input.expectedBaseActiveOverrideManifestSha256
        ) {
          throw new Error("Prefix retirement commit base is stale.");
        }
        this.store.assertContextRevisionBoundary(input.activeTurnId);
        const retirementBoundaries = readRetirementBoundaries(
          this.database,
          snapshot.canonical,
          input.activeTurnId,
        );
        const closedTurns = retirementBoundaries.closedTurns;
        const activeTurns = closedTurns.filter(
          (turn) => turn.firstOrdinal >= baseRevision.keepFromOrdinal,
        );
        const nextBoundary = [
          ...activeTurns,
          ...(retirementBoundaries.activeTurn === undefined
            ? []
            : [retirementBoundaries.activeTurn]),
        ].find((turn) => turn.firstOrdinal === input.nextKeepFromOrdinal);
        const retiredTurns = activeTurns.filter(
          (turn) => turn.lastOrdinal < input.nextKeepFromOrdinal,
        );
        if (
          nextBoundary === undefined ||
          input.nextKeepFromOrdinal <= baseRevision.keepFromOrdinal ||
          retiredTurns.length !== input.retiredTurnCount ||
          retiredTurns.reduce((total, turn) => total + turn.frameCount, 0) !==
            input.retiredFrameCount ||
          retiredTurns.reduce((total, turn) => total + turn.messageCount, 0) !==
            input.retiredMessageCount
        ) {
          throw new Error("Prefix retirement turn boundary is invalid.");
        }

        const active = this.revisionCompiler.compileActive(snapshot);
        const nextActiveOverrides = snapshot.activeOverrides.filter(
          (override) => override.ordinal >= input.nextKeepFromOrdinal,
        );
        const candidate = this.revisionCompiler.compileProspective({
          active,
          canonical: snapshot.canonical,
          activeOverrides: snapshot.activeOverrides,
          addedOverrides: [],
          activeSurface: snapshot.surface,
          keepFromOrdinal: input.nextKeepFromOrdinal,
        });
        if (
          input.retiredThroughOrdinal !== input.nextKeepFromOrdinal - 1 ||
          nextActiveOverrides.length !== input.nextActiveOverrideCount ||
          activeOverrideManifestHash(nextActiveOverrides) !==
            input.nextActiveOverrideManifestSha256 ||
          canonicalSequenceHash(
            snapshot.canonical,
            input.expectedCanonicalThroughOrdinal,
          ) !== input.canonicalSequenceSha256 ||
          renderedMessageHash(
            candidate.entries,
            input.expectedCanonicalThroughOrdinal,
          ) !== input.renderedMessageSha256
        ) {
          throw new Error("Prefix retirement candidate is invalid.");
        }

        const revisionNumber = baseRevision.revisionNumber + 1;
        options.faultInjector?.("before_revision_insert");
        this.database
          .query(
            `INSERT INTO context_revisions (
              revision_id, session_id, revision_number, parent_revision_id, kind,
              surface_id, surface_sha256, keep_from_ordinal,
              source_through_ordinal, added_override_count, active_override_count,
              active_override_manifest_sha256, canonical_sequence_sha256,
              rendered_message_sha256, policy_version, renderer_format,
              plan_sha256, change_manifest_sha256, retired_through_ordinal,
              retired_turn_count, retired_frame_count, retired_message_count,
              created_at
            ) VALUES (?, ?, ?, ?, 'prefix_retirement', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.revisionId,
            this.sessionId,
            revisionNumber,
            baseRevision.revisionId,
            baseRevision.surfaceId,
            baseRevision.surfaceSha256,
            input.nextKeepFromOrdinal,
            input.expectedCanonicalThroughOrdinal,
            input.nextActiveOverrideCount,
            input.nextActiveOverrideManifestSha256,
            input.canonicalSequenceSha256,
            input.renderedMessageSha256,
            input.policyVersion,
            input.planHash,
            input.retiredThroughOrdinal,
            input.retiredTurnCount,
            input.retiredFrameCount,
            input.retiredMessageCount,
            now,
          );
        options.faultInjector?.("after_revision_insert");

        const storedActiveOverrides = this.database
          .query(
            `SELECT co.* FROM context_overrides co
             JOIN context_revisions introduced
               ON introduced.revision_id = co.introduced_revision_id
             WHERE introduced.revision_number <= ? AND co.ordinal >= ?
             ORDER BY co.ordinal`,
          )
          .all(revisionNumber, input.nextKeepFromOrdinal)
          .map(decodeStoredSwapOverride);
        if (
          storedActiveOverrides.length !== input.nextActiveOverrideCount ||
          activeOverrideManifestHash(storedActiveOverrides) !==
            input.nextActiveOverrideManifestSha256
        ) {
          throw new Error("Prefix retirement override readback is invalid.");
        }
        options.faultInjector?.("after_override_readback");

        this.database.query("DELETE FROM context_measurement_state").run();
        options.faultInjector?.("after_measurement_delete");
        const switched = this.database
          .query(
            `UPDATE session_meta SET active_revision_id = ?, updated_at = ?
             WHERE singleton = 1 AND active_revision_id = ?`,
          )
          .run(input.revisionId, now, baseRevision.revisionId);
        requireSingleChange(
          this.database,
          switched.changes,
          "activate prefix retirement revision",
        );
        options.faultInjector?.("after_active_update");

        const readback = this.store.loadContextSnapshot();
        if (
          readback.revision.kind !== "prefix_retirement" ||
          readback.revision.revisionId !== input.revisionId ||
          readback.revision.keepFromOrdinal !== input.nextKeepFromOrdinal ||
          loadMeasuredContextState(this.database, this.sessionId) !== undefined
        ) {
          throw new Error("Committed prefix retirement readback failed.");
        }
        options.faultInjector?.("after_snapshot_readback");
        return readback.revision;
      });
    } catch (error) {
      if (
        requireActiveRevisionId(this.store.readMeta()) !== input.expectedBaseRevisionId
      ) {
        throw new Error("Failed prefix retirement changed active state.", {
          cause: error,
        });
      }
      throw sessionWriteError("commit_prefix_retirement", this.sessionId, error);
    }
  }

  commitSurfaceRefresh(
    input: CommitSurfaceRefreshInput,
    options: CommitSurfaceRefreshOptions = {},
  ): Extract<StoredContextRevisionV8, { kind: "surface_refresh" }> {
    this.requireOpen();
    assertCommitSurfaceRefreshInput(input);
    const now = this.clock();
    try {
      return runTransaction(this.database, () => {
        const snapshot = this.store.loadContextSnapshot();
        const baseRevision = snapshot.revision;
        if (
          baseRevision.revisionId !== input.expectedBaseRevisionId ||
          baseRevision.revisionNumber !== input.expectedBaseRevisionNumber ||
          snapshot.canonical.messages.length !==
            input.expectedCanonicalThroughOrdinal ||
          baseRevision.activeOverrideManifestSha256 !==
            input.expectedBaseActiveOverrideManifestSha256
        ) {
          throw new Error("Context surface refresh base is stale.");
        }
        this.store.assertContextRevisionIdle();
        validateStoredContextSurface(input.surface);
        if (
          input.surface.sessionId !== this.sessionId ||
          input.surface.surfaceId === snapshot.surface.surfaceId ||
          input.surface.surfaceSha256 === snapshot.surface.surfaceSha256
        ) {
          throw new Error("Context surface refresh does not introduce a new surface.");
        }
        const actualChanges = contextSurfaceChanges(snapshot.surface, input.surface);
        if (
          stableJsonStringify(actualChanges) !== stableJsonStringify(input.changes) ||
          contextSurfaceChangeManifestHash(actualChanges) !==
            input.changeManifestSha256 ||
          !Object.values(actualChanges).some(Boolean)
        ) {
          throw new Error("Context surface refresh change manifest is invalid.");
        }

        const active = this.revisionCompiler.compileActive(snapshot);
        const candidate = this.revisionCompiler.compileProspective({
          active,
          canonical: snapshot.canonical,
          activeOverrides: snapshot.activeOverrides,
          addedOverrides: [],
          activeSurface: snapshot.surface,
          surface: input.surface,
        });
        if (
          canonicalSequenceHash(
            snapshot.canonical,
            input.expectedCanonicalThroughOrdinal,
          ) !== input.canonicalSequenceSha256 ||
          renderedMessageHash(
            candidate.entries,
            input.expectedCanonicalThroughOrdinal,
          ) !== input.renderedMessageSha256
        ) {
          throw new Error("Candidate context surface prefix hash is invalid.");
        }

        const revisionNumber = baseRevision.revisionNumber + 1;
        options.faultInjector?.("before_surface_insert");
        insertContextSurface(this.database, input.surface);
        options.faultInjector?.("after_surface_insert");
        this.database
          .query(
            `INSERT INTO context_revisions (
              revision_id, session_id, revision_number, parent_revision_id, kind,
              surface_id, surface_sha256, keep_from_ordinal,
              source_through_ordinal, added_override_count, active_override_count,
              active_override_manifest_sha256, canonical_sequence_sha256,
              rendered_message_sha256, policy_version, renderer_format,
              plan_sha256, change_manifest_sha256, created_at
            ) VALUES (?, ?, ?, ?, 'surface_refresh', ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
          )
          .run(
            input.revisionId,
            this.sessionId,
            revisionNumber,
            baseRevision.revisionId,
            input.surface.surfaceId,
            input.surface.surfaceSha256,
            baseRevision.keepFromOrdinal,
            input.expectedCanonicalThroughOrdinal,
            baseRevision.activeOverrideCount,
            baseRevision.activeOverrideManifestSha256,
            input.canonicalSequenceSha256,
            input.renderedMessageSha256,
            input.changeManifestSha256,
            now,
          );
        options.faultInjector?.("after_revision_insert");

        this.database.query("DELETE FROM context_measurement_state").run();
        options.faultInjector?.("after_measurement_delete");
        const switched = this.database
          .query(
            `UPDATE session_meta SET active_revision_id = ?, updated_at = ?
             WHERE singleton = 1 AND active_revision_id = ?`,
          )
          .run(input.revisionId, now, baseRevision.revisionId);
        requireSingleChange(
          this.database,
          switched.changes,
          "activate context surface revision",
        );
        options.faultInjector?.("after_active_update");

        const readback = this.store.loadContextSnapshot();
        if (
          readback.revision.kind !== "surface_refresh" ||
          readback.revision.revisionId !== input.revisionId ||
          readback.surface.surfaceId !== input.surface.surfaceId ||
          loadMeasuredContextState(this.database, this.sessionId) !== undefined
        ) {
          throw new Error("Committed context surface revision readback failed.");
        }
        return readback.revision;
      });
    } catch (error) {
      if (
        requireActiveRevisionId(this.store.readMeta()) !== input.expectedBaseRevisionId
      ) {
        throw new Error("Failed context surface transaction changed active state.", {
          cause: error,
        });
      }
      throw sessionWriteError("commit_context_surface", this.sessionId, error);
    }
  }

  commitSkillsUpdate(
    input: CommitSkillsUpdateInput,
    options: CommitSkillsUpdateOptions = {},
  ): Extract<StoredContextRevisionV8, { kind: "skills_update" }> {
    this.requireOpen();
    assertCommitSkillsUpdateInput(input);
    const now = this.clock();
    try {
      return runTransaction(this.database, () => {
        const snapshot = this.store.loadContextSnapshot();
        const baseRevision = snapshot.revision;
        if (
          baseRevision.revisionId !== input.expectedBaseRevisionId ||
          baseRevision.revisionNumber !== input.expectedBaseRevisionNumber ||
          snapshot.canonical.messages.length !==
            input.expectedCanonicalThroughOrdinal ||
          baseRevision.activeOverrideManifestSha256 !==
            input.expectedBaseActiveOverrideManifestSha256
        ) {
          throw new Error("Agent Skills update base is stale.");
        }
        this.store.assertContextRevisionIdle();
        validateStoredContextSurface(input.surface);

        const surfaceChanged =
          input.surface.surfaceSha256 !== snapshot.surface.surfaceSha256;
        const actualChanges = contextSurfaceChanges(snapshot.surface, input.surface);
        if (
          input.surface.sessionId !== this.sessionId ||
          stableJsonStringify(actualChanges) !== stableJsonStringify(input.changes) ||
          contextSurfaceChangeManifestHash(actualChanges) !==
            input.changeManifestSha256 ||
          (surfaceChanged && input.surface.surfaceId === snapshot.surface.surfaceId) ||
          (!surfaceChanged && input.surface.surfaceId !== snapshot.surface.surfaceId) ||
          (!surfaceChanged && Object.values(actualChanges).some(Boolean))
        ) {
          throw new Error("Agent Skills surface change manifest is invalid.");
        }

        const unresolved = new Map(
          this.store
            .loadSkillActivations(["pending", "dispatched"])
            .map((entry) => [entry.activationMessageId, entry]),
        );
        if (
          input.settlements.length !== input.addedOverrides.length ||
          input.settlements.length !== unresolved.size ||
          new Set(input.settlements.map((entry) => entry.activationMessageId)).size !==
            input.settlements.length ||
          skillActivationManifestSha256(input.settlements) !==
            input.activationManifestSha256
        ) {
          throw new Error("Agent Skills settlement manifest is invalid.");
        }
        const canonicalMessages = new Map(
          snapshot.canonical.messages.map((message) => [message.messageId, message]),
        );
        const providedOverrides = new Map(
          input.addedOverrides.map((override) => [override.messageId, override]),
        );
        for (const settlement of input.settlements) {
          const activation = unresolved.get(settlement.activationMessageId);
          const message = canonicalMessages.get(settlement.activationMessageId);
          const override = providedOverrides.get(settlement.activationMessageId);
          if (
            activation === undefined ||
            message?.role !== "tool" ||
            message.name !== "Skill" ||
            override === undefined ||
            settlement.name !== activation.name ||
            (settlement.state === "promoted" &&
              (activation.state !== "dispatched" ||
                settlement.rejectionReason !== undefined)) ||
            (settlement.state === "rejected" &&
              (settlement.rejectionReason === undefined ||
                settlement.rejectionReason.trim() === "" ||
                settlement.rejectionReason.length > 256))
          ) {
            throw new Error(
              `Agent Skill activation ${settlement.activationMessageId} cannot be settled.`,
            );
          }
          const activeManifest = input.surface.activeSkills.find(
            (entry) =>
              entry.name === activation.name &&
              entry.activationMessageId === activation.activationMessageId,
          );
          if (
            (settlement.state === "promoted" && activeManifest === undefined) ||
            (settlement.state === "rejected" && activeManifest !== undefined)
          ) {
            throw new Error("Agent Skills active manifest does not match settlements.");
          }
          const expected = renderSkillActivationReceipt({
            message: {
              messageId: message.messageId,
              frameId: message.frameId,
              ordinal: message.ordinal,
              content: message.displayText,
              contentSha256: message.contentSha256,
            },
            name: activation.name,
            outcome:
              settlement.state === "promoted"
                ? "promoted"
                : settlement.rejectionReason === "unavailable"
                  ? "unavailable"
                  : "rejected",
          });
          if (stableJsonStringify(expected) !== stableJsonStringify(override)) {
            throw new Error("Agent Skill activation receipt is not deterministic.");
          }
        }

        const active = this.revisionCompiler.compileActive(snapshot);
        const candidateOverrides = [
          ...snapshot.activeOverrides,
          ...input.addedOverrides,
        ];
        if (
          new Set(candidateOverrides.map((override) => override.messageId)).size !==
            candidateOverrides.length ||
          activeOverrideManifestHash(candidateOverrides) !==
            input.nextActiveOverrideManifestSha256
        ) {
          throw new Error("Agent Skills override manifest is invalid.");
        }
        const candidate = this.revisionCompiler.compileProspective({
          active,
          canonical: snapshot.canonical,
          activeOverrides: snapshot.activeOverrides,
          addedOverrides: input.addedOverrides,
          activeSurface: snapshot.surface,
          ...(surfaceChanged ? { surface: input.surface } : {}),
          allowCombinedSurfaceAndOverrides: true,
        });
        if (
          canonicalSequenceHash(
            snapshot.canonical,
            input.expectedCanonicalThroughOrdinal,
          ) !== input.canonicalSequenceSha256 ||
          renderedMessageHash(
            candidate.entries,
            input.expectedCanonicalThroughOrdinal,
          ) !== input.renderedMessageSha256
        ) {
          throw new Error("Agent Skills compiled context hashes are invalid.");
        }

        options.faultInjector?.("before_surface_insert");
        if (surfaceChanged) {
          insertContextSurface(this.database, input.surface);
        }
        options.faultInjector?.("after_surface_insert");
        const revisionNumber = baseRevision.revisionNumber + 1;
        const activeOverrideCount =
          baseRevision.activeOverrideCount + input.addedOverrides.length;
        this.database
          .query(
            `INSERT INTO context_revisions (
              revision_id, session_id, revision_number, parent_revision_id, kind,
              surface_id, surface_sha256, keep_from_ordinal,
              source_through_ordinal, added_override_count, active_override_count,
              active_override_manifest_sha256, canonical_sequence_sha256,
              rendered_message_sha256, policy_version, renderer_format,
              plan_sha256, change_manifest_sha256, activation_manifest_sha256,
              retired_through_ordinal, retired_turn_count, retired_frame_count,
              retired_message_count, created_at
            ) VALUES (?, ?, ?, ?, 'skills_update', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, ?)`,
          )
          .run(
            input.revisionId,
            this.sessionId,
            revisionNumber,
            baseRevision.revisionId,
            input.surface.surfaceId,
            input.surface.surfaceSha256,
            baseRevision.keepFromOrdinal,
            input.expectedCanonicalThroughOrdinal,
            input.addedOverrides.length,
            activeOverrideCount,
            input.nextActiveOverrideManifestSha256,
            input.canonicalSequenceSha256,
            input.renderedMessageSha256,
            SKILL_POLICY_VERSION,
            SKILL_ACTIVATION_RECEIPT_FORMAT,
            input.changeManifestSha256,
            input.activationManifestSha256,
            now,
          );
        options.faultInjector?.("after_revision_insert");

        for (let index = 0; index < input.addedOverrides.length; index += 1) {
          const override = requireItem(
            input.addedOverrides,
            index,
            "Agent Skill receipt override",
          );
          this.database
            .query(
              `INSERT INTO context_overrides (
                introduced_revision_id, session_id, message_id, frame_id, ordinal,
                representation, renderer_format, source, original_content_sha256,
                rendered_content, rendered_content_sha256, original_bytes,
                rendered_bytes, byte_savings, created_at
              ) VALUES (?, ?, ?, ?, ?, 'swapped', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.revisionId,
              this.sessionId,
              override.messageId,
              override.frameId,
              override.ordinal,
              SKILL_ACTIVATION_RECEIPT_FORMAT,
              override.source,
              override.originalContentSha256,
              override.renderedContent,
              override.renderedContentSha256,
              override.originalBytes,
              override.renderedBytes,
              override.byteSavings,
              now,
            );
          if (index === 0) {
            options.faultInjector?.("after_first_override_insert");
          }
        }
        options.faultInjector?.("after_overrides_insert");

        for (const settlement of input.settlements) {
          const activation = unresolved.get(settlement.activationMessageId)!;
          const updated =
            settlement.state === "promoted"
              ? this.database
                  .query(
                    `UPDATE skill_activations
                     SET state = 'promoted', settled_revision_id = ?, updated_at = ?
                     WHERE activation_message_id = ? AND state = 'dispatched'`,
                  )
                  .run(input.revisionId, now, settlement.activationMessageId)
              : this.database
                  .query(
                    `UPDATE skill_activations
                     SET state = 'rejected', settled_revision_id = ?, rejection_reason = ?, updated_at = ?
                     WHERE activation_message_id = ? AND state = ?`,
                  )
                  .run(
                    input.revisionId,
                    settlement.rejectionReason!,
                    now,
                    settlement.activationMessageId,
                    activation.state,
                  );
          requireSingleChange(
            this.database,
            updated.changes,
            `settle Agent Skill activation ${settlement.activationMessageId}`,
          );
        }
        options.faultInjector?.("after_activations_update");

        this.database.query("DELETE FROM context_measurement_state").run();
        options.faultInjector?.("after_measurement_delete");
        const switched = this.database
          .query(
            `UPDATE session_meta SET active_revision_id = ?, updated_at = ?
             WHERE singleton = 1 AND active_revision_id = ?`,
          )
          .run(input.revisionId, now, baseRevision.revisionId);
        requireSingleChange(
          this.database,
          switched.changes,
          "activate Agent Skills context revision",
        );
        options.faultInjector?.("after_active_update");

        const readback = this.store.loadContextSnapshot();
        if (
          readback.revision.kind !== "skills_update" ||
          readback.revision.revisionId !== input.revisionId ||
          readback.surface.surfaceId !== input.surface.surfaceId ||
          loadMeasuredContextState(this.database, this.sessionId) !== undefined ||
          this.store
            .loadSkillActivations(["pending", "dispatched"])
            .some((entry) =>
              input.settlements.some(
                (settlement) =>
                  settlement.activationMessageId === entry.activationMessageId,
              ),
            )
        ) {
          throw new Error("Committed Agent Skills update readback failed.");
        }
        return readback.revision;
      });
    } catch (error) {
      if (
        requireActiveRevisionId(this.store.readMeta()) !== input.expectedBaseRevisionId
      ) {
        throw new Error("Failed Agent Skills transaction changed active state.", {
          cause: error,
        });
      }
      throw sessionWriteError("commit_skills_update", this.sessionId, error);
    }
  }
}
function assertCommitSwapRevisionInput(input: CommitSwapRevisionInput): void {
  if (
    input.revisionId.trim() === "" ||
    input.expectedBaseRevisionId.trim() === "" ||
    !Number.isSafeInteger(input.expectedBaseRevisionNumber) ||
    input.expectedBaseRevisionNumber < 1 ||
    !Number.isSafeInteger(input.expectedCanonicalThroughOrdinal) ||
    input.expectedCanonicalThroughOrdinal < 1 ||
    input.addedOverrides.length < 1 ||
    input.policyVersion !== "swap-only-v1" ||
    input.rendererFormat !== SWAP_OBSERVATION_FORMAT
  ) {
    throw new Error("Commit swap revision input is invalid.");
  }
  for (const [name, hash] of [
    [
      "expectedBaseActiveOverrideManifestSha256",
      input.expectedBaseActiveOverrideManifestSha256,
    ],
    ["planHash", input.planHash],
    ["nextActiveOverrideManifestSha256", input.nextActiveOverrideManifestSha256],
    ["canonicalSequenceSha256", input.canonicalSequenceSha256],
    ["renderedMessageSha256", input.renderedMessageSha256],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`Commit swap revision ${name} must be a SHA-256 hash.`);
    }
  }
}

function assertCommitSurfaceRefreshInput(input: CommitSurfaceRefreshInput): void {
  if (
    input.revisionId.trim() === "" ||
    input.expectedBaseRevisionId.trim() === "" ||
    !Number.isSafeInteger(input.expectedBaseRevisionNumber) ||
    input.expectedBaseRevisionNumber < 1 ||
    !Number.isSafeInteger(input.expectedCanonicalThroughOrdinal) ||
    input.expectedCanonicalThroughOrdinal < 1
  ) {
    throw new Error("Commit surface refresh input is invalid.");
  }
  for (const [name, hash] of [
    [
      "expectedBaseActiveOverrideManifestSha256",
      input.expectedBaseActiveOverrideManifestSha256,
    ],
    ["changeManifestSha256", input.changeManifestSha256],
    ["canonicalSequenceSha256", input.canonicalSequenceSha256],
    ["renderedMessageSha256", input.renderedMessageSha256],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`Commit surface refresh ${name} must be a SHA-256 hash.`);
    }
  }
}

function assertCommitSkillsUpdateInput(input: CommitSkillsUpdateInput): void {
  if (
    input.revisionId.trim() === "" ||
    input.expectedBaseRevisionId.trim() === "" ||
    !Number.isSafeInteger(input.expectedBaseRevisionNumber) ||
    input.expectedBaseRevisionNumber < 1 ||
    !Number.isSafeInteger(input.expectedCanonicalThroughOrdinal) ||
    input.expectedCanonicalThroughOrdinal < 1 ||
    input.addedOverrides.length < 1 ||
    input.settlements.length !== input.addedOverrides.length
  ) {
    throw new Error("Commit Agent Skills update input is invalid.");
  }
  for (const [name, hash] of [
    [
      "expectedBaseActiveOverrideManifestSha256",
      input.expectedBaseActiveOverrideManifestSha256,
    ],
    ["changeManifestSha256", input.changeManifestSha256],
    ["activationManifestSha256", input.activationManifestSha256],
    ["nextActiveOverrideManifestSha256", input.nextActiveOverrideManifestSha256],
    ["canonicalSequenceSha256", input.canonicalSequenceSha256],
    ["renderedMessageSha256", input.renderedMessageSha256],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`Commit Agent Skills update ${name} must be a SHA-256 hash.`);
    }
  }
}

function assertCommitPrefixRetirementRevisionInput(
  input: CommitPrefixRetirementRevisionInput,
): void {
  if (
    input.revisionId.trim() === "" ||
    input.expectedBaseRevisionId.trim() === "" ||
    input.policyVersion !== "recall-first-retirement-v1" ||
    !Number.isSafeInteger(input.expectedBaseRevisionNumber) ||
    input.expectedBaseRevisionNumber < 1 ||
    !Number.isSafeInteger(input.expectedBaseKeepFromOrdinal) ||
    input.expectedBaseKeepFromOrdinal < 1 ||
    !Number.isSafeInteger(input.expectedCanonicalThroughOrdinal) ||
    input.expectedCanonicalThroughOrdinal < 1 ||
    !Number.isSafeInteger(input.nextKeepFromOrdinal) ||
    input.nextKeepFromOrdinal <= input.expectedBaseKeepFromOrdinal ||
    input.retiredThroughOrdinal !== input.nextKeepFromOrdinal - 1 ||
    !Number.isSafeInteger(input.retiredTurnCount) ||
    input.retiredTurnCount < 1 ||
    !Number.isSafeInteger(input.retiredFrameCount) ||
    input.retiredFrameCount < 1 ||
    !Number.isSafeInteger(input.retiredMessageCount) ||
    input.retiredMessageCount < 1 ||
    !Number.isSafeInteger(input.nextActiveOverrideCount) ||
    input.nextActiveOverrideCount < 0
  ) {
    throw new Error("Commit prefix retirement input is invalid.");
  }
  for (const [name, hash] of [
    ["expectedSurfaceSha256", input.expectedSurfaceSha256],
    [
      "expectedBaseActiveOverrideManifestSha256",
      input.expectedBaseActiveOverrideManifestSha256,
    ],
    ["planHash", input.planHash],
    ["nextActiveOverrideManifestSha256", input.nextActiveOverrideManifestSha256],
    ["canonicalSequenceSha256", input.canonicalSequenceSha256],
    ["renderedMessageSha256", input.renderedMessageSha256],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`Commit prefix retirement ${name} must be a SHA-256 hash.`);
    }
  }
}
