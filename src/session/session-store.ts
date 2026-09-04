import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import type { MeasuredContextAnchor } from "../agent/context-meter";
import {
  InMemorySessionLedger,
  type LedgerMutation,
  type SessionLedgerCommitter,
} from "../agent/session-ledger";
import type { IterationIdentity } from "../agent/types";
import {
  ContextProtocolError,
  ContextProtocolValidator,
} from "../context/context-protocol-validator";
import type {
  StoredContextRevisionV8,
  StoredContextSnapshotV8,
} from "../context/context-revision";
import { createInitialContextRevision } from "../context/context-revision-compiler";
import {
  validateStoredContextSurface,
  type StoredContextSurfaceV8,
} from "../context/context-surface";
import type {
  ActiveTurnBoundary,
  ClosedTurnBoundary,
} from "../context/prefix-retirement-planner";
import { contentHash, type ProtocolContextView } from "../context/protocol-frame";
import type {
  ContextRevisionId,
  IterationId,
  MessageId,
  RuntimeIdFactory,
  SessionId,
  TurnId,
} from "../ids/runtime-id";
import { ImageAssetStore } from "../image/image-asset-store";
import { type ImageAssetRef } from "../image/image-types";
import type { ProjectInstructionManifest } from "../instructions/project-instructions";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import {
  cloneDiagnosticFiles,
  rekeyProtocolView,
  rekeyStoredToolCalls,
  rewriteCloneRevisionHashes,
  SESSION_SCOPED_TABLES,
} from "./session-clone-helpers";
import {
  compatibilityContractDifferences,
  decodeMeta,
  normalizeSessionCompatibilityContract,
} from "./session-compatibility-codec";
import { SessionError, sessionOpenError, sessionWriteError } from "./session-errors";
import {
  createSessionHistoryReader,
  type SessionHistoryReader,
} from "./session-history-reader";
import { SessionLease } from "./session-lock";
import {
  configureWritableDatabase,
  createSessionSchema,
  dropSessionCloneTriggers,
  rebuildRecallIndex,
  reinstallSessionCloneTriggers,
  SESSION_SCHEMA_V10_FINGERPRINT,
  SESSION_SCHEMA_VERSION,
  upgradeActiveTurnRetirementContract,
  upgradeRecallIndexContract,
  verifyReadableSessionSchema,
  verifyRecallIndex,
  verifySessionSchema,
  verifySqliteIntegrity,
} from "./session-schema";
import {
  loadMeasuredContextState,
  readRetirementBoundaries,
  requireActiveRevisionId,
} from "./session-store-context-readers";
import {
  type CloneSessionStoreInput,
  type CommitPrefixRetirementRevisionInput,
  type CommitPrefixRetirementRevisionOptions,
  type CommitSkillsUpdateInput,
  type CommitSkillsUpdateOptions,
  type CommitSurfaceRefreshInput,
  type CommitSurfaceRefreshOptions,
  type CommitSwapRevisionInput,
  type CommitSwapRevisionOptions,
  type CompletedTurnMessageSnapshot,
  type CompletedTurnSnapshot,
  type CreateNewSessionStoreInput,
  type OpenSessionStoreInput,
  type SessionCloseReason,
  type SessionCompatibilityContract,
  type SessionRecoveryResult,
  type StoredSessionMetaV10,
  type StoredSkillActivation,
} from "./session-store-contracts";
import {
  assertPathMissing,
  canonicalWorkspaceRoot,
  chmodIfExists,
  ensureSessionsRoot,
  removeKnownInitializationFiles,
  safeSessionDirectory,
  unlinkIfExists,
  validateSecureDirectory,
  validateSecureFile,
  validateSecureOptionalFile,
  validateSessionsRoot,
} from "./session-store-filesystem";
import { SessionStoreLedgerWriter } from "./session-store-ledger-writer";
import {
  decodeFrame,
  decodeMessage,
  decodeSkillActivation,
  decodeToolResult,
  imageAssetRefFromAttachment,
  loadMessageImageAttachments,
  loadToolMessageContentBlocks,
} from "./session-store-record-codecs";
import {
  insertContextSurface,
  insertFrame,
  insertMessage,
} from "./session-store-record-writer";
import { SessionStoreRecovery } from "./session-store-recovery";
import { SessionStoreRevisions } from "./session-store-revisions";
import { requireItem, requireSingleChange, runTransaction } from "./session-store-sql";
import { SessionStoreValidation } from "./session-store-validation";
import {
  assertMeasuredContextAnchor,
  enumFromSql,
  nullableStringFromSql,
  nullableTextFromSql,
  numberFromSql,
  recordFromSql,
  stringFromSql,
} from "./session-store-value-codecs";
import {
  canonicalHomeRoot,
  resolveWorkspaceStorageRoot,
  workspaceStorageRoot,
} from "./workspace-storage";
export { createSessionCompatibilityContract } from "./session-compatibility-codec";
export * from "./session-store-contracts";
export { decodeStoredToolCalls } from "./session-store-record-codecs";
export { decodeStoredToolRawResult } from "./session-tool-result-codec";

export class SessionStore implements SessionLedgerCommitter {
  readonly sessionId: SessionId;
  readonly workspaceRoot: string;
  readonly sessionDirectory: string;
  readonly databasePath: string;
  private readonly validation: SessionStoreValidation;
  private readonly recovery: SessionStoreRecovery;
  private readonly revisions: SessionStoreRevisions;
  private readonly ledgerWriter: SessionStoreLedgerWriter;
  private closed = false;
  private recallIndexRebuilt = false;
  private readonly validator = new ContextProtocolValidator();

  private constructor(
    private readonly database: Database,
    private readonly lease: SessionLease,
    input: {
      sessionId: SessionId;
      workspaceRoot: string;
      sessionDirectory: string;
      databasePath: string;
      clock: () => string;
      homeRoot?: string;
    },
  ) {
    this.sessionId = input.sessionId;
    this.workspaceRoot = input.workspaceRoot;
    this.sessionDirectory = input.sessionDirectory;
    this.databasePath = input.databasePath;
    this.clock = input.clock;
    this.homeRoot = input.homeRoot;
    this.validation = new SessionStoreValidation(database, this.sessionId, (states) =>
      this.loadSkillActivations(states),
    );
    this.revisions = new SessionStoreRevisions(
      database,
      this.sessionId,
      this.clock,
      {
        loadContextSnapshot: () => this.loadContextSnapshot(),
        assertContextRevisionBoundary: (turnId) =>
          this.assertContextRevisionBoundary(turnId),
        assertContextRevisionIdle: () => this.assertContextRevisionIdle(),
        readMeta: () => this.readMeta(),
        loadSkillActivations: (states) => this.loadSkillActivations(states),
      },
      () => this.requireOpen(),
      (overrides, canonical) =>
        this.validation.validateAddedOverrides(overrides, canonical),
    );
    this.ledgerWriter = new SessionStoreLedgerWriter(
      database,
      this.sessionId,
      this.clock,
      () => this.requireOpen(),
      {
        readMeta: () => this.readMeta(),
        loadContextSnapshot: () => this.loadContextSnapshot(),
      },
    );
    this.recovery = new SessionStoreRecovery(
      database,
      this.sessionId,
      this.clock,
      () => this.requireOpen(),
      this.ledgerWriter,
      {
        loadProtocolView: () => this.loadProtocolView(),
        validateAll: (options) => this.validateAll(options),
      },
    );
  }

  private readonly homeRoot?: string;

  private readonly clock: () => string;

  commit(mutation: LedgerMutation): void {
    this.ledgerWriter.commit(mutation);
  }

  commitSwapRevision(
    input: CommitSwapRevisionInput,
    options: CommitSwapRevisionOptions = {},
  ): Extract<StoredContextRevisionV8, { kind: "swap_only" }> {
    return this.revisions.commitSwapRevision(input, options);
  }

  commitPrefixRetirementRevision(
    input: CommitPrefixRetirementRevisionInput,
    options: CommitPrefixRetirementRevisionOptions = {},
  ): Extract<StoredContextRevisionV8, { kind: "prefix_retirement" }> {
    return this.revisions.commitPrefixRetirementRevision(input, options);
  }

  commitSurfaceRefresh(
    input: CommitSurfaceRefreshInput,
    options: CommitSurfaceRefreshOptions = {},
  ): Extract<StoredContextRevisionV8, { kind: "surface_refresh" }> {
    return this.revisions.commitSurfaceRefresh(input, options);
  }

  commitSkillsUpdate(
    input: CommitSkillsUpdateInput,
    options: CommitSkillsUpdateOptions = {},
  ): Extract<StoredContextRevisionV8, { kind: "skills_update" }> {
    return this.revisions.commitSkillsUpdate(input, options);
  }

  static async createNew(input: CreateNewSessionStoreInput): Promise<SessionStore> {
    const clock = input.clock ?? (() => new Date().toISOString());
    const workspaceRoot = await canonicalWorkspaceRoot(input.workspaceRoot);
    const sessionsRoot = await ensureSessionsRoot(workspaceRoot, input.homeRoot);
    const sessionDirectory = safeSessionDirectory(sessionsRoot, input.sessionId);
    try {
      await mkdir(sessionDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SessionError(
          "SESSION_ALREADY_EXISTS",
          "create_session",
          `Session directory already exists: ${sessionDirectory}.`,
          { sessionId: input.sessionId, cause: error },
        );
      }
      throw error;
    }
    await chmod(sessionDirectory, 0o700);

    let lease: SessionLease | undefined;
    let database: Database | undefined;
    const databasePath = path.join(sessionDirectory, "session.sqlite");
    try {
      lease = await SessionLease.acquire({
        sessionDirectory,
        sessionId: input.sessionId,
      });
      const handle = await open(databasePath, "wx", 0o600);
      await handle.close();
      database = openWritableDatabase(databasePath);
      createSessionSchema(database);
      verifySessionSchema(database, input.sessionId);

      const initialLedger = new InMemorySessionLedger({
        sessionId: input.sessionId,
        systemPrompt: input.systemPrompt,
        idFactory: input.idFactory,
        clock,
      });
      const initialView = initialLedger.snapshot({ fullIntegrity: true });
      const createdAt = clock();
      runTransaction(database, () => {
        database!
          .query(
            `INSERT INTO session_meta (
            singleton, schema_version, schema_fingerprint, initialization_state,
            session_id, workspace_root, model_name, system_prompt_sha256,
            project_instruction_file, project_instruction_byte_length,
            project_instruction_sha256,
            session_compatibility_json, session_compatibility_sha256,
            active_revision_id, next_turn_number, next_event_sequence, open_count,
            created_at, updated_at, last_opened_at, last_closed_at, last_close_reason
          ) VALUES (1, ?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, 1, 1, ?, ?, ?, NULL, NULL)`,
          )
          .run(
            SESSION_SCHEMA_VERSION,
            SESSION_SCHEMA_V10_FINGERPRINT,
            input.sessionId,
            workspaceRoot,
            input.modelName,
            sha256(input.systemPrompt),
            input.projectInstruction?.path ?? null,
            input.projectInstruction?.byteLength ?? null,
            input.projectInstruction?.sha256 ?? null,
            createdAt,
            createdAt,
            createdAt,
          );
        insertFrame(database!, requireItem(initialView.frames, 0, "system frame"));
        insertMessage(
          database!,
          requireItem(initialView.messages, 0, "system message"),
        );
      });

      const store = new SessionStore(database, lease, {
        sessionId: input.sessionId,
        workspaceRoot,
        sessionDirectory,
        databasePath,
        clock,
        ...(input.homeRoot === undefined ? {} : { homeRoot: input.homeRoot }),
      });
      await store.correctDatabaseModes();
      store.validateCreatingState();
      verifyRecallIndex(database, input.sessionId);
      return store;
    } catch (error) {
      database?.close();
      if (lease !== undefined) {
        await lease.release().catch(() => undefined);
      }
      await removeKnownInitializationFiles(sessionDirectory);
      throw error;
    }
  }

  static async openExisting(input: OpenSessionStoreInput): Promise<SessionStore> {
    const clock = input.clock ?? (() => new Date().toISOString());
    const workspaceRoot = await canonicalWorkspaceRoot(input.workspaceRoot);
    const sessionsRoot = path.join(
      workspaceStorageRoot(workspaceRoot, await canonicalHomeRoot(input.homeRoot)),
      "sessions",
    );
    await validateSessionsRoot(sessionsRoot, input.sessionId);
    const sessionDirectory = safeSessionDirectory(sessionsRoot, input.sessionId);
    await validateSecureDirectory(sessionDirectory, input.sessionId);
    const databasePath = path.join(sessionDirectory, "session.sqlite");
    await validateSecureFile(databasePath, input.sessionId);
    for (const optionalFile of [
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      path.join(sessionDirectory, "events.jsonl"),
      path.join(sessionDirectory, "observations.md"),
    ]) {
      await validateSecureOptionalFile(optionalFile, input.sessionId);
    }

    const lease = await SessionLease.acquire({
      sessionDirectory,
      sessionId: input.sessionId,
    });
    let database: Database | undefined;
    try {
      database = openWritableDatabase(databasePath);
      verifySqliteIntegrity(database, input.sessionId);
      verifyReadableSessionSchema(database, input.sessionId);
      const recallIndexContractUpgraded = runTransaction(database, () =>
        upgradeRecallIndexContract(database!),
      );
      runTransaction(database, () => upgradeActiveTurnRetirementContract(database!));
      verifySessionSchema(database, input.sessionId);
      const store = new SessionStore(database, lease, {
        sessionId: input.sessionId,
        workspaceRoot,
        sessionDirectory,
        databasePath,
        clock,
        ...(input.homeRoot === undefined ? {} : { homeRoot: input.homeRoot }),
      });
      store.recallIndexRebuilt = recallIndexContractUpgraded;
      const meta = store.readMeta();
      if (meta.initializationState !== "ready" && input.allowIncomplete !== true) {
        throw new SessionError(
          "SESSION_INTEGRITY_FAILED",
          "open_session",
          `Session ${input.sessionId} did not finish initialization.`,
          { sessionId: input.sessionId },
        );
      }
      if (meta.workspaceRoot !== workspaceRoot) {
        throw new SessionError(
          "SESSION_WORKSPACE_MISMATCH",
          "open_session",
          `Session workspace is ${meta.workspaceRoot}, current workspace is ${workspaceRoot}.`,
          { sessionId: input.sessionId },
        );
      }
      if (meta.initializationState === "creating") {
        store.validateCreatingState();
      } else {
        store.validateAll({ allowOpenTail: true });
        await store.verifyImageAssetFiles();
      }
      try {
        verifyRecallIndex(database, input.sessionId);
      } catch (error) {
        if (
          !(error instanceof SessionError) ||
          error.code !== "SESSION_RECALL_INDEX_INVALID"
        ) {
          throw error;
        }
        try {
          runTransaction(database, () =>
            rebuildRecallIndex(database!, input.sessionId),
          );
          verifyRecallIndex(database, input.sessionId);
        } catch (rebuildError) {
          if (
            rebuildError instanceof SessionError &&
            rebuildError.code === "SESSION_RECALL_INDEX_INVALID"
          ) {
            throw rebuildError;
          }
          throw new SessionError(
            "SESSION_RECALL_INDEX_INVALID",
            "rebuild_recall_index",
            "Session Recall index rebuild transaction failed.",
            { sessionId: input.sessionId, cause: rebuildError },
          );
        }
        store.recallIndexRebuilt = true;
      }
      await store.correctDatabaseModes();
      return store;
    } catch (error) {
      database?.close();
      await lease.release().catch(() => undefined);
      throw sessionOpenError("open_session", input.sessionId, error);
    }
  }

  beginIteration(iteration: IterationIdentity): void {
    this.requireOpen();
    const now = this.clock();
    try {
      runTransaction(this.database, () => {
        const turn = this.ledgerWriter.requireTurnRow(iteration.turnId);
        if (
          turn.status !== "open" ||
          numberFromSql(turn.next_iteration_number, "next_iteration_number") !==
            iteration.iterationNumber
        ) {
          throw new Error(
            `Iteration ${iteration.iterationId} does not match the open turn counter.`,
          );
        }
        this.database
          .query(
            `INSERT INTO iterations (
            session_id, turn_id, iteration_id, iteration_number, outcome,
            next_tool_call_number, started_at, finished_at
          ) VALUES (?, ?, ?, ?, 'open', 1, ?, NULL)`,
          )
          .run(
            this.sessionId,
            iteration.turnId,
            iteration.iterationId,
            iteration.iterationNumber,
            now,
          );
        const updated = this.database
          .query(
            `UPDATE turns SET next_iteration_number = ?, last_iteration_id = ?
           WHERE turn_id = ? AND status = 'open' AND next_iteration_number = ?`,
          )
          .run(
            iteration.iterationNumber + 1,
            iteration.iterationId,
            iteration.turnId,
            iteration.iterationNumber,
          );
        requireSingleChange(
          this.database,
          updated.changes,
          "advance iteration counter",
        );
      });
    } catch (error) {
      throw sessionWriteError("begin_iteration", this.sessionId, error);
    }
  }

  finishIterationForContinuation(iteration: IterationIdentity): void {
    this.requireOpen();
    const now = this.clock();
    try {
      runTransaction(this.database, () => {
        const updated = this.database
          .query(
            `UPDATE iterations SET outcome = 'continue', finished_at = ?
           WHERE iteration_id = ? AND turn_id = ? AND outcome = 'open'`,
          )
          .run(now, iteration.iterationId, iteration.turnId);
        requireSingleChange(
          this.database,
          updated.changes,
          "finish continuing iteration",
        );
        this.ledgerWriter.touch(now);
      });
    } catch (error) {
      throw sessionWriteError("finish_iteration", this.sessionId, error);
    }
  }

  allocateEventSequence(): number {
    this.requireOpen();
    const now = this.clock();
    try {
      return runTransaction(this.database, () => {
        const meta = this.readMeta();
        const sequence = meta.nextEventSequence;
        const updated = this.database
          .query(
            `UPDATE session_meta SET next_event_sequence = ?, updated_at = ?
           WHERE singleton = 1 AND next_event_sequence = ?`,
          )
          .run(sequence + 1, now, sequence);
        requireSingleChange(this.database, updated.changes, "advance event sequence");
        return sequence;
      });
    } catch (error) {
      throw sessionWriteError("allocate_event_sequence", this.sessionId, error);
    }
  }

  finalizeInitialization(input: {
    contract: SessionCompatibilityContract;
    surface: StoredContextSurfaceV8;
    revisionId: ContextRevisionId;
  }): void {
    this.requireOpen();
    const contract = normalizeSessionCompatibilityContract(input.contract);
    const json = stableJsonStringify(contract);
    const contractSha256 = sha256(json);
    const now = this.clock();
    try {
      runTransaction(this.database, () => {
        const meta = this.readMeta();
        if (
          meta.initializationState !== "creating" ||
          meta.activeRevisionId !== null ||
          input.surface.sessionId !== this.sessionId
        ) {
          throw new Error("Session initialization base is invalid.");
        }
        validateStoredContextSurface(input.surface);
        const canonical = this.loadProtocolView();
        const creationPrompt = this.readCreationSystemPrompt();
        if (input.surface.systemPrompt !== creationPrompt) {
          throw new Error(
            "Initial context surface must match the creation system prompt.",
          );
        }
        const revision = createInitialContextRevision({
          revisionId: input.revisionId,
          canonical,
          surface: input.surface,
          createdAt: now,
        });
        insertContextSurface(this.database, input.surface);
        this.database
          .query(
            `INSERT INTO context_revisions (
              revision_id, session_id, revision_number, parent_revision_id, kind,
              surface_id, surface_sha256, keep_from_ordinal,
              source_through_ordinal, added_override_count, active_override_count,
              active_override_manifest_sha256, canonical_sequence_sha256,
              rendered_message_sha256, policy_version, renderer_format,
              plan_sha256, change_manifest_sha256, created_at
            ) VALUES (?, ?, 1, NULL, 'initial_full', ?, ?, 1, 1, 0, 0, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
          )
          .run(
            revision.revisionId,
            this.sessionId,
            revision.surfaceId,
            revision.surfaceSha256,
            revision.activeOverrideManifestSha256,
            revision.canonicalSequenceSha256,
            revision.renderedMessageSha256,
            revision.createdAt,
          );
        const updated = this.database
          .query(
            `UPDATE session_meta
           SET initialization_state = 'ready', session_compatibility_json = ?,
               session_compatibility_sha256 = ?, active_revision_id = ?, updated_at = ?
           WHERE singleton = 1 AND initialization_state = 'creating'
             AND session_compatibility_json IS NULL AND active_revision_id IS NULL`,
          )
          .run(json, contractSha256, revision.revisionId, now);
        requireSingleChange(
          this.database,
          updated.changes,
          "finalize session initialization",
        );
        const readback = this.loadContextSnapshot();
        if (
          readback.revision.revisionId !== revision.revisionId ||
          readback.surface.surfaceId !== input.surface.surfaceId
        ) {
          throw new Error("Finalized session initialization readback failed.");
        }
      });
    } catch (error) {
      throw sessionWriteError("finalize_session_initialization", this.sessionId, error);
    }
  }

  assertSessionCompatibility(contract: SessionCompatibilityContract): void {
    const meta = this.readMeta();
    const currentContract = normalizeSessionCompatibilityContract(contract);
    const current = stableJsonStringify(currentContract);
    const currentHash = sha256(current);
    if (
      meta.sessionCompatibilityJson !== current ||
      meta.sessionCompatibilitySha256 !== currentHash
    ) {
      const changed = compatibilityContractDifferences(
        meta.sessionCompatibilityJson,
        currentContract,
      );
      throw new SessionError(
        "SESSION_COMPATIBILITY_MISMATCH",
        "compare_session_compatibility",
        `Session compatibility contract changed: ${changed.join(", ") || "stored contract is invalid"}.`,
        { sessionId: this.sessionId },
      );
    }
  }

  writeMeasuredContextAnchor(anchor: MeasuredContextAnchor): void {
    this.requireOpen();
    assertMeasuredContextAnchor(anchor);
    const revisionId = requireActiveRevisionId(this.readMeta());
    const now = this.clock();
    try {
      runTransaction(this.database, () => {
        const written = this.database
          .query(
            `INSERT INTO context_measurement_state (
              singleton, session_id, revision_id, total_tokens, prompt_tokens,
              completion_tokens, segment_count, prefix_hash, request_config_hash,
              tool_schema_hash, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(singleton) DO UPDATE SET
              revision_id = excluded.revision_id,
              total_tokens = excluded.total_tokens,
              prompt_tokens = excluded.prompt_tokens,
              completion_tokens = excluded.completion_tokens,
              segment_count = excluded.segment_count,
              prefix_hash = excluded.prefix_hash,
              request_config_hash = excluded.request_config_hash,
              tool_schema_hash = excluded.tool_schema_hash,
              updated_at = excluded.updated_at
            WHERE context_measurement_state.session_id = excluded.session_id`,
          )
          .run(
            this.sessionId,
            revisionId,
            anchor.totalTokens,
            anchor.promptTokens,
            anchor.completionTokens,
            anchor.segmentCount,
            anchor.prefixHash,
            anchor.requestConfigHash,
            anchor.toolSchemaHash,
            now,
          );
        requireSingleChange(
          this.database,
          written.changes,
          "write measured context anchor",
        );
        this.ledgerWriter.touch(now);
      });
    } catch (error) {
      throw sessionWriteError("write_context_measurement", this.sessionId, error);
    }
  }

  readActiveMeasuredContextAnchor(): MeasuredContextAnchor | undefined {
    this.requireOpen();
    const state = loadMeasuredContextState(this.database, this.sessionId);
    if (state === undefined) {
      return undefined;
    }
    if (state.revisionId !== requireActiveRevisionId(this.readMeta())) {
      return undefined;
    }
    return state.anchor;
  }

  assertContextRevisionIdle(): void {
    this.assertContextRevisionBoundary();
  }

  assertContextRevisionBoundary(activeTurnId?: TurnId): void {
    this.requireOpen();
    const row = this.database
      .query(
        `SELECT
          (SELECT COUNT(*) FROM turns WHERE status = 'open') AS open_turns,
          (SELECT turn_id FROM turns WHERE status = 'open' LIMIT 1) AS open_turn_id,
          (SELECT COUNT(*) FROM iterations WHERE outcome = 'open') AS open_iterations,
          (SELECT COUNT(*) FROM protocol_frames WHERE state = 'open') AS open_frames`,
      )
      .get() as Record<string, unknown> | null;
    const openTurnCount =
      row === null ? -1 : numberFromSql(row.open_turns, "open_turns");
    const openTurnId =
      row === null
        ? null
        : (nullableStringFromSql(row.open_turn_id, "open_turn_id") as TurnId | null);
    if (
      row === null ||
      (activeTurnId === undefined
        ? openTurnCount !== 0
        : openTurnCount !== 1 || openTurnId !== activeTurnId) ||
      numberFromSql(row.open_iterations, "open_iterations") !== 0 ||
      numberFromSql(row.open_frames, "open_frames") !== 0
    ) {
      throw new SessionError(
        "SESSION_INTEGRITY_FAILED",
        "assert_context_revision_boundary",
        "Context revision requires an idle store or a closed active-turn iteration boundary.",
        { sessionId: this.sessionId },
      );
    }
  }

  loadClosedTurnBoundaries(): readonly ClosedTurnBoundary[] {
    this.requireOpen();
    this.assertContextRevisionIdle();
    const canonical = this.loadProtocolView();
    this.validator.validate(canonical, { fullIntegrity: true });
    return readRetirementBoundaries(this.database, canonical).closedTurns;
  }

  loadRetirementBoundaries(activeTurnId?: TurnId): {
    readonly closedTurns: readonly ClosedTurnBoundary[];
    readonly activeTurn?: ActiveTurnBoundary;
  } {
    this.requireOpen();
    this.assertContextRevisionBoundary(activeTurnId);
    const canonical = this.loadProtocolView();
    this.validator.validate(canonical, {
      allowOpenTail: activeTurnId !== undefined,
      fullIntegrity: true,
    });
    return readRetirementBoundaries(this.database, canonical, activeTurnId);
  }

  loadSkillActivations(
    states?: readonly StoredSkillActivation["state"][],
  ): readonly StoredSkillActivation[] {
    this.requireOpen();
    const rows = this.database
      .query(
        `SELECT sa.*, m.ordinal AS activation_ordinal
         FROM skill_activations sa
         JOIN messages m ON m.message_id = sa.activation_message_id
         ORDER BY m.ordinal`,
      )
      .all()
      .map(decodeSkillActivation);
    const filtered =
      states === undefined ? rows : rows.filter((row) => states.includes(row.state));
    return Object.freeze(filtered);
  }

  markSkillActivationsDispatched(input: {
    iterationId: IterationId;
    activationMessageIds: readonly MessageId[];
  }): readonly StoredSkillActivation[] {
    this.requireOpen();
    if (input.activationMessageIds.length === 0) {
      return Object.freeze([]);
    }
    if (
      new Set(input.activationMessageIds).size !== input.activationMessageIds.length
    ) {
      throw new Error("Agent Skill dispatch contains duplicate activation messages.");
    }
    const now = this.clock();
    try {
      return runTransaction(this.database, () => {
        const iteration = this.ledgerWriter.requireIterationRow(input.iterationId);
        if (iteration.outcome !== "open") {
          throw new Error(`Iteration ${input.iterationId} is not open for dispatch.`);
        }
        for (const messageId of input.activationMessageIds) {
          const updated = this.database
            .query(
              `UPDATE skill_activations
               SET state = 'dispatched', dispatched_iteration_id = ?, updated_at = ?
               WHERE activation_message_id = ? AND session_id = ? AND state = 'pending'`,
            )
            .run(input.iterationId, now, messageId, this.sessionId);
          requireSingleChange(
            this.database,
            updated.changes,
            `dispatch Agent Skill activation ${messageId}`,
          );
        }
        this.ledgerWriter.touch(now);
        const dispatched = this.loadSkillActivations(["dispatched"]).filter((row) =>
          input.activationMessageIds.includes(row.activationMessageId),
        );
        if (dispatched.length !== input.activationMessageIds.length) {
          throw new Error("Agent Skill dispatch readback failed.");
        }
        return Object.freeze(dispatched);
      });
    } catch (error) {
      throw sessionWriteError("dispatch_skill_activations", this.sessionId, error);
    }
  }

  markResumed(): number {
    this.requireOpen();
    const now = this.clock();
    try {
      return runTransaction(this.database, () => {
        const meta = this.readMeta();
        const next = meta.openCount + 1;
        const updated = this.database
          .query(
            `UPDATE session_meta
           SET open_count = ?, last_opened_at = ?, updated_at = ?,
               last_closed_at = NULL, last_close_reason = NULL
           WHERE singleton = 1 AND open_count = ?`,
          )
          .run(next, now, now, meta.openCount);
        requireSingleChange(this.database, updated.changes, "increment open count");
        return next;
      });
    } catch (error) {
      throw sessionWriteError("mark_resumed", this.sessionId, error);
    }
  }

  recoverInterruptedState(idFactory: RuntimeIdFactory): SessionRecoveryResult {
    return this.recovery.recoverInterruptedState(idFactory, this.recallIndexRebuilt);
  }

  historyReader(): SessionHistoryReader {
    this.requireOpen();
    return createSessionHistoryReader({
      database: this.database,
      sessionId: this.sessionId,
      requireOpen: () => this.requireOpen(),
    });
  }

  readCompletedTurnSnapshot(turnId: TurnId): CompletedTurnSnapshot {
    this.requireOpen();
    const turnRow = this.database
      .query("SELECT status FROM turns WHERE turn_id = ?")
      .get(turnId);
    const status = enumFromSql(
      recordFromSql(turnRow, "completed turn").status,
      ["open", "completed", "failed", "cancelled", "interrupted"] as const,
      "turn status",
    );
    if (status !== "completed") {
      throw new Error(`Turn ${turnId} is not completed.`);
    }

    const rows = this.database
      .query(
        `SELECT ordinal, role, content, reasoning_content,
                reasoning_content_present, name
         FROM messages
         WHERE turn_id = ?
         ORDER BY ordinal`,
      )
      .all(turnId);
    if (rows.length === 0) {
      throw new Error(`Completed turn ${turnId} has no messages.`);
    }

    let previousOrdinal = 0;
    const messages = rows.map((value): CompletedTurnMessageSnapshot => {
      const row = recordFromSql(value, "completed turn message");
      const ordinal = numberFromSql(row.ordinal, "completed turn ordinal");
      if (ordinal < 1 || ordinal <= previousOrdinal) {
        throw new Error("Completed turn message ordinals are invalid.");
      }
      previousOrdinal = ordinal;
      const role = enumFromSql(
        row.role,
        ["user", "assistant", "tool"] as const,
        "completed turn message role",
      );
      if (role === "user") {
        if (
          row.reasoning_content !== null ||
          numberFromSql(row.reasoning_content_present, "reasoning_content_present") !==
            0 ||
          row.name !== null
        ) {
          throw new Error("Completed user message fields are invalid.");
        }
        return Object.freeze({
          ordinal,
          role,
          content: stringFromSql(row.content, "completed user content"),
        });
      }
      if (role === "assistant") {
        if (row.name !== null) {
          throw new Error("Completed assistant message name must be null.");
        }
        const reasoningPresent = numberFromSql(
          row.reasoning_content_present,
          "reasoning_content_present",
        );
        if (reasoningPresent !== 0 && reasoningPresent !== 1) {
          throw new Error("reasoning_content_present must be 0 or 1.");
        }
        if (reasoningPresent === 0 && row.reasoning_content !== null) {
          throw new Error("Absent assistant reasoning content must be null.");
        }
        return Object.freeze({
          ordinal,
          role,
          content: nullableTextFromSql(row.content, "completed assistant content"),
          ...(reasoningPresent === 0
            ? {}
            : {
                reasoningContent: nullableTextFromSql(
                  row.reasoning_content,
                  "completed assistant reasoning content",
                ),
              }),
        });
      }
      if (
        row.reasoning_content !== null ||
        numberFromSql(row.reasoning_content_present, "reasoning_content_present") !== 0
      ) {
        throw new Error("Completed tool message reasoning fields are invalid.");
      }
      return Object.freeze({
        ordinal,
        role,
        name: stringFromSql(row.name, "completed tool name"),
        content: stringFromSql(row.content, "completed tool content"),
      });
    });
    return Object.freeze({ messages: Object.freeze(messages) });
  }

  loadProtocolView(): ProtocolContextView {
    this.requireOpen();
    const imageAttachments = loadMessageImageAttachments(this.database);
    const toolContentBlocks = loadToolMessageContentBlocks(this.database);
    const frames = this.database
      .query("SELECT * FROM protocol_frames ORDER BY first_ordinal")
      .all()
      .map(decodeFrame);
    const messages = this.database
      .query("SELECT * FROM messages ORDER BY ordinal")
      .all()
      .map((row) => {
        const record = recordFromSql(row, "message");
        const messageId = stringFromSql(record.message_id, "message_id");
        const message = decodeMessage(
          row,
          imageAttachments.get(messageId),
          toolContentBlocks.get(messageId),
        );
        imageAttachments.delete(messageId);
        toolContentBlocks.delete(messageId);
        return message;
      });
    if (imageAttachments.size > 0) {
      throw new Error("Image attachment rows reference unknown messages.");
    }
    if (toolContentBlocks.size > 0) {
      throw new Error("Tool content block rows reference unknown messages.");
    }
    const toolResults = this.database
      .query(
        `SELECT tr.* FROM tool_results tr
         JOIN messages m ON m.message_id = tr.tool_message_id
         ORDER BY m.ordinal`,
      )
      .all()
      .map(decodeToolResult);
    return Object.freeze({
      sessionId: this.sessionId,
      faulted: false,
      frames: Object.freeze(frames),
      messages: Object.freeze(messages),
      toolResults: Object.freeze(toolResults),
    });
  }

  async verifyImageAssetFiles(): Promise<void> {
    this.requireOpen();
    const distinct = new Map<string, ImageAssetRef>();
    for (const message of this.loadProtocolView().messages) {
      const assets =
        message.role === "user"
          ? (message.attachments ?? []).map(imageAssetRefFromAttachment)
          : message.role === "tool"
            ? message.content.flatMap((block) =>
                block.type === "image" ? [block.asset] : [],
              )
            : [];
      for (const asset of assets) {
        const previous = distinct.get(asset.assetId);
        if (
          previous !== undefined &&
          stableJsonStringify(previous) !== stableJsonStringify(asset)
        ) {
          throw new Error(`Conflicting metadata for image asset ${asset.assetId}.`);
        }
        distinct.set(asset.assetId, asset);
      }
    }
    if (distinct.size === 0) {
      return;
    }
    const store = await ImageAssetStore.open({
      workspaceRoot: this.workspaceRoot,
      ...(this.homeRoot === undefined ? {} : { homeRoot: this.homeRoot }),
    });
    for (const asset of distinct.values()) {
      await store.verify(asset);
    }
  }

  loadContextSnapshot(): StoredContextSnapshotV8 {
    this.requireOpen();
    const meta = this.readMeta();
    try {
      if (
        meta.sessionId !== this.sessionId ||
        meta.schemaFingerprint !== SESSION_SCHEMA_V10_FINGERPRINT
      ) {
        throw new Error("Session metadata identity or schema fingerprint changed.");
      }
      const canonical = this.loadProtocolView();
      this.validator.validate(canonical, { fullIntegrity: true });
      const systemFrame = canonical.frames[0];
      const systemMessage = canonical.messages[0];
      if (
        systemFrame?.kind !== "system" ||
        systemFrame.firstOrdinal !== 1 ||
        systemMessage?.role !== "system" ||
        systemMessage.ordinal !== 1 ||
        sha256(systemMessage.content) !== meta.systemPromptSha256 ||
        canonical.messages.at(-1)?.ordinal !== canonical.messages.length
      ) {
        throw new Error("Stored context snapshot ordinal or system invariant failed.");
      }
      return this.validation.loadValidatedContextSnapshot(meta, canonical);
    } catch (error) {
      if (error instanceof SessionError) {
        throw error;
      }
      if (error instanceof ContextProtocolError) {
        throw new SessionError(
          "SESSION_PROTOCOL_INVALID",
          "load_context_snapshot",
          error.message,
          {
            sessionId: this.sessionId,
            frameId: error.frameId,
            messageId: error.messageId,
            toolCallId: error.toolCallId,
            cause: error,
          },
        );
      }
      throw new SessionError(
        "SESSION_INTEGRITY_FAILED",
        "load_context_snapshot",
        `Session context snapshot validation failed: ${errorMessage(error)}.`,
        { sessionId: this.sessionId, cause: error },
      );
    }
  }

  readMeta(): StoredSessionMetaV10 {
    this.requireOpen();
    const rows = this.database.query("SELECT * FROM session_meta").all();
    if (rows.length !== 1) {
      throw new SessionError(
        "SESSION_INTEGRITY_FAILED",
        "read_meta",
        `Session metadata must contain exactly one row; found ${rows.length}.`,
        { sessionId: this.sessionId },
      );
    }
    return decodeMeta(rows[0], this.sessionId);
  }

  readCreationSystemPrompt(): string {
    this.requireOpen();
    try {
      const frames = this.database
        .query("SELECT * FROM protocol_frames WHERE kind = 'system'")
        .all();
      if (frames.length !== 1) {
        throw new Error(`Expected one stored system frame; found ${frames.length}.`);
      }
      const frame = recordFromSql(frames[0], "stored system frame");
      if (
        frame.state !== "closed" ||
        numberFromSql(frame.first_ordinal, "first_ordinal") !== 1 ||
        numberFromSql(frame.last_ordinal, "last_ordinal") !== 1
      ) {
        throw new Error("Stored system frame invariant failed.");
      }
      const frameId = stringFromSql(frame.frame_id, "frame_id");
      const messages = this.database
        .query("SELECT * FROM messages WHERE frame_id = ?")
        .all(frameId);
      if (messages.length !== 1) {
        throw new Error(
          `Expected one stored system message; found ${messages.length}.`,
        );
      }
      const row = recordFromSql(messages[0], "stored system message");
      if (
        numberFromSql(row.ordinal, "ordinal") !== 1 ||
        row.role !== "system" ||
        row.origin !== "runtime"
      ) {
        throw new Error("Stored system message invariant failed.");
      }
      const content = stringFromSql(row.content, "content");
      if (content.trim() === "") {
        throw new Error("Stored system prompt must not be empty.");
      }
      if (
        stringFromSql(row.content_sha256, "content_sha256") !== contentHash(content)
      ) {
        throw new Error("Stored system message content hash does not match.");
      }
      if (this.readMeta().systemPromptSha256 !== sha256(content)) {
        throw new Error("Stored system prompt metadata hash does not match.");
      }
      return content;
    } catch (error) {
      if (error instanceof SessionError && error.code === "SESSION_RECOVERY_FAILED") {
        throw error;
      }
      throw new SessionError(
        "SESSION_RECOVERY_FAILED",
        "read_creation_system_prompt",
        "Creation system prompt is missing or invalid.",
        { sessionId: this.sessionId, cause: error },
      );
    }
  }

  readProjectInstructionManifest(): ProjectInstructionManifest | undefined {
    return this.readMeta().projectInstruction;
  }

  validateCreatingState(): void {
    this.requireOpen();
    const meta = this.readMeta();
    if (
      meta.initializationState !== "creating" ||
      meta.activeRevisionId !== null ||
      meta.sessionCompatibilityJson !== null ||
      meta.sessionCompatibilitySha256 !== null
    ) {
      throw new SessionError(
        "SESSION_INTEGRITY_FAILED",
        "validate_creating_store",
        "Creating session metadata is invalid.",
        { sessionId: this.sessionId },
      );
    }
    this.readCreationSystemPrompt();
    const counts = this.database
      .query(
        `SELECT
          (SELECT COUNT(*) FROM context_surfaces) AS surfaces,
          (SELECT COUNT(*) FROM context_revisions) AS revisions,
          (SELECT COUNT(*) FROM turns) AS turns`,
      )
      .get() as Record<string, unknown> | null;
    if (
      counts === null ||
      numberFromSql(counts.surfaces, "surfaces") !== 0 ||
      numberFromSql(counts.revisions, "revisions") !== 0 ||
      numberFromSql(counts.turns, "turns") !== 0
    ) {
      throw new SessionError(
        "SESSION_INTEGRITY_FAILED",
        "validate_creating_store",
        "Creating session contains finalized or turn state.",
        { sessionId: this.sessionId },
      );
    }
    const view = this.loadProtocolView();
    this.validator.validate(view, { fullIntegrity: true });
    if (view.messages.length !== 1 || view.frames.length !== 1) {
      throw new SessionError(
        "SESSION_INTEGRITY_FAILED",
        "validate_creating_store",
        "Creating session must contain only its creation system frame.",
        { sessionId: this.sessionId },
      );
    }
  }

  nextTurnNumber(): number {
    return this.readMeta().nextTurnNumber;
  }

  validateAll(options: { allowOpenTail: boolean }): ProtocolContextView {
    const meta = this.readMeta();
    if (
      meta.sessionId !== this.sessionId ||
      meta.schemaFingerprint !== SESSION_SCHEMA_V10_FINGERPRINT ||
      meta.initializationState !== "ready" ||
      meta.activeRevisionId === null
    ) {
      throw new SessionError(
        "SESSION_SCHEMA_INVALID",
        "validate_store",
        "Session metadata identity or schema fingerprint does not match.",
        { sessionId: this.sessionId },
      );
    }
    try {
      this.readCreationSystemPrompt();
      const view = this.loadProtocolView();
      this.validator.validate(view, {
        allowOpenTail: options.allowOpenTail,
        fullIntegrity: true,
      });
      this.validation.loadValidatedContextSnapshot(meta, view);
      this.validation.validateCounters(meta, view);
      return view;
    } catch (error) {
      if (error instanceof SessionError) {
        throw error;
      }
      if (error instanceof ContextProtocolError) {
        throw new SessionError(
          "SESSION_PROTOCOL_INVALID",
          "validate_store",
          error.message,
          {
            sessionId: this.sessionId,
            frameId: error.frameId,
            messageId: error.messageId,
            toolCallId: error.toolCallId,
            cause: error,
          },
        );
      }
      throw new SessionError(
        "SESSION_INTEGRITY_FAILED",
        "validate_store",
        `Session record validation failed: ${errorMessage(error)}.`,
        { sessionId: this.sessionId, cause: error },
      );
    }
  }

  async cloneTo(input: CloneSessionStoreInput): Promise<void> {
    this.requireOpen();
    if (input.targetSessionId === this.sessionId) {
      throw new Error("Session clone target must differ from the source session.");
    }

    const sourceView = this.validateAll({ allowOpenTail: false });
    const sourceMeta = this.readMeta();
    const sessionsRoot = path.dirname(this.sessionDirectory);
    await validateSessionsRoot(sessionsRoot, this.sessionId);
    const targetDirectory = safeSessionDirectory(sessionsRoot, input.targetSessionId);
    await assertPathMissing(targetDirectory, input.targetSessionId);

    const stagingDirectory = path.join(sessionsRoot, `.cloning-${randomUUID()}`);
    const stagingDatabasePath = path.join(stagingDirectory, "session.sqlite");
    let stagingDatabase: Database | undefined;
    let published = false;

    try {
      await mkdir(stagingDirectory, { mode: 0o700 });
      await chmod(stagingDirectory, 0o700);
      input.faultInjector?.("after_staging_mkdir");
      this.database.query("VACUUM INTO ?").run(stagingDatabasePath);
      await chmod(stagingDatabasePath, 0o600);
      input.faultInjector?.("after_snapshot");

      stagingDatabase = openWritableDatabase(stagingDatabasePath);
      verifySessionSchema(stagingDatabase, this.sessionId);
      dropSessionCloneTriggers(stagingDatabase);
      input.faultInjector?.("after_trigger_drop");

      const targetCanonical = rekeyProtocolView(sourceView, input.targetSessionId);
      runTransaction(stagingDatabase, () => {
        stagingDatabase!.exec("PRAGMA defer_foreign_keys = ON");
        for (const table of SESSION_SCOPED_TABLES) {
          stagingDatabase!
            .query(`UPDATE ${table} SET session_id = ? WHERE session_id = ?`)
            .run(input.targetSessionId, this.sessionId);
        }
        rekeyStoredToolCalls(stagingDatabase!, input.targetSessionId);
        input.faultInjector?.("after_identity_update");

        rewriteCloneRevisionHashes(stagingDatabase!, targetCanonical);
        input.faultInjector?.("after_revision_hash_rewrite");

        if (stagingDatabase!.query("PRAGMA foreign_key_check").all().length !== 0) {
          throw new Error("Cloned session identity re-key broke foreign keys.");
        }
      });

      reinstallSessionCloneTriggers(stagingDatabase);
      input.faultInjector?.("after_trigger_reinstall");
      verifySessionSchema(stagingDatabase, input.targetSessionId);
      verifySqliteIntegrity(stagingDatabase, input.targetSessionId);
      verifyRecallIndex(stagingDatabase, input.targetSessionId);
      input.faultInjector?.("after_recall_validation");
      const clonedStore = new SessionStore(stagingDatabase, this.lease, {
        sessionId: input.targetSessionId,
        workspaceRoot: this.workspaceRoot,
        sessionDirectory: stagingDirectory,
        databasePath: stagingDatabasePath,
        clock: this.clock,
        ...(this.homeRoot === undefined ? {} : { homeRoot: this.homeRoot }),
      });
      clonedStore.validateAll({ allowOpenTail: false });
      await clonedStore.verifyImageAssetFiles();

      await cloneDiagnosticFiles({
        sourceDirectory: this.sessionDirectory,
        stagingDirectory,
        sourceSessionId: this.sessionId,
        targetSessionId: input.targetSessionId,
        nextEventSequence: sourceMeta.nextEventSequence,
        faultInjector: input.faultInjector,
      });

      stagingDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const standaloneJournal = stagingDatabase
        .query("PRAGMA journal_mode = DELETE")
        .get() as Record<string, unknown> | null;
      if (String(standaloneJournal?.journal_mode).toLowerCase() !== "delete") {
        throw new Error("Cloned session database did not leave WAL mode.");
      }
      stagingDatabase.close();
      stagingDatabase = undefined;
      await unlinkIfExists(`${stagingDatabasePath}-wal`);
      await unlinkIfExists(`${stagingDatabasePath}-shm`);
      await validateSecureDirectory(stagingDirectory, input.targetSessionId);
      await validateSecureFile(stagingDatabasePath, input.targetSessionId);
      await validateSecureOptionalFile(
        path.join(stagingDirectory, "events.jsonl"),
        input.targetSessionId,
      );
      await validateSecureOptionalFile(
        path.join(stagingDirectory, "observations.md"),
        input.targetSessionId,
      );
      input.faultInjector?.("after_artifact_validation");
      await assertPathMissing(targetDirectory, input.targetSessionId);
      input.faultInjector?.("before_publish_rename");
      await rename(stagingDirectory, targetDirectory);
      published = true;
    } finally {
      if (stagingDatabase !== undefined) {
        try {
          stagingDatabase.close();
        } catch {
          // Preserve the clone failure.
        }
      }
      if (!published) {
        await removeKnownInitializationFiles(stagingDirectory).catch(() => undefined);
      }
    }
  }

  async close(reason: SessionCloseReason): Promise<void> {
    if (this.closed) {
      return;
    }
    let primaryError: unknown;
    const now = this.clock();
    try {
      runTransaction(this.database, () => {
        const updated = this.database
          .query(
            `UPDATE session_meta SET last_closed_at = ?, last_close_reason = ?, updated_at = ?
           WHERE singleton = 1`,
          )
          .run(now, reason, now);
        requireSingleChange(this.database, updated.changes, "close session activation");
      });
    } catch (error) {
      primaryError = sessionWriteError("close_session", this.sessionId, error);
    }
    try {
      this.database.close();
    } catch (error) {
      primaryError ??= error;
    }
    this.closed = true;
    try {
      await this.lease.release();
    } catch (error) {
      primaryError ??= error;
    }
    if (primaryError !== undefined) {
      throw asError(primaryError);
    }
  }

  async abandon(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      this.database.close();
    } catch {
      // A failed delete path may already have closed the connection.
    }
    this.closed = true;
    await this.lease.release();
  }

  async deleteFromDisk(): Promise<void> {
    this.requireOpen();
    const known = new Set([
      "session.sqlite",
      "session.sqlite-wal",
      "session.sqlite-shm",
      "events.jsonl",
      "observations.md",
      "active.lock",
      "active.lock.reclaim",
    ]);
    const entries = await readdir(this.sessionDirectory);
    const unknown = entries.filter((entry) => !known.has(entry));
    if (unknown.length > 0) {
      throw new SessionError(
        "SESSION_DELETE_BLOCKED",
        "delete_session",
        `Session directory contains unknown files: ${unknown.join(", ")}.`,
        { sessionId: this.sessionId },
      );
    }

    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.database.close();
    const tombstone = `${this.sessionDirectory}.deleting-${randomUUID()}`;
    try {
      await rename(this.sessionDirectory, tombstone);
    } catch (error) {
      this.closed = true;
      await this.lease.release().catch(() => undefined);
      throw error;
    }
    this.lease.relocate(tombstone);
    await this.lease.release();
    this.closed = true;

    try {
      for (const name of known) {
        await unlinkIfExists(path.join(tombstone, name));
      }
      await rmdir(tombstone);
    } catch (error) {
      throw new SessionError(
        "SESSION_DELETE_BLOCKED",
        "delete_session_cleanup",
        `Session was removed from the catalog, but tombstone cleanup failed: ${tombstone}.`,
        { sessionId: this.sessionId, cause: error },
      );
    }
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new Error(`SessionStore ${this.sessionId} is closed.`);
    }
  }

  private async correctDatabaseModes(): Promise<void> {
    await chmod(this.databasePath, 0o600);
    await chmodIfExists(`${this.databasePath}-wal`, 0o600);
    await chmodIfExists(`${this.databasePath}-shm`, 0o600);
  }
}

export async function resolveSessionDatabasePath(
  workspaceRoot: string,
  sessionId: SessionId,
  homeRoot?: string,
): Promise<string> {
  return path.join(
    await resolveWorkspaceStorageRoot(workspaceRoot, homeRoot),
    "sessions",
    sessionId,
    "session.sqlite",
  );
}

function openWritableDatabase(databasePath: string): Database {
  const database = new Database(databasePath, {
    create: false,
    readwrite: true,
    strict: true,
    safeIntegers: true,
  });
  configureWritableDatabase(database);
  return database;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
