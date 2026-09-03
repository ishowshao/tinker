import path from "node:path";
import { chmod, mkdir, open, readdir, rename, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type {
  ContextRevisionId,
  ContextSurfaceId,
  IterationId,
  MessageId,
  RuntimeIdFactory,
  SessionId,
  TurnId,
} from "../ids/runtime-id";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import {
  canonicalHomeRoot,
  resolveWorkspaceStorageRoot,
  workspaceStorageRoot,
} from "./workspace-storage";
import {
  ContextProtocolError,
  ContextProtocolValidator,
} from "../context/context-protocol-validator";
import {
  activeOverrideManifestHash,
  canonicalSequenceHash,
  renderedMessageHash,
} from "../context/compiled-context-hash";
import {
  ContextRevisionCompiler,
  createInitialContextRevision,
} from "../context/context-revision-compiler";
import {
  ContextSwapRenderer,
  SWAP_OBSERVATION_FORMAT,
  SWAP_TOOL_IMAGE_FORMAT,
} from "../context/context-swap-renderer";
import {
  contentHash,
  immutableRecord,
  interruptedCompletionInputs,
  observationForCompletion,
  userMessageHash,
  type CanonicalMessageRecord,
  type ProtocolContextView,
  type ProtocolFrame,
  type ToolCompletion,
  type ToolResultRecord,
} from "../context/protocol-frame";
import {
  contextSurfaceChangeManifestHash,
  contextSurfaceChanges,
  validateStoredContextSurface,
  type StoredContextSurfaceV8,
} from "../context/context-surface";
import type {
  StoredContextRevisionV8,
  StoredContextSnapshotV8,
  StoredContextOverrideV8,
  SwapOverride,
} from "../context/context-revision";
import type { IterationIdentity } from "../agent/types";
import {
  canonicalToolResultContentHash,
  toolResultDisplayText,
  validateToolResultContent,
} from "../agent/tool-result-content";
import { validateUserMessage, type ImageAssetRef } from "../image/image-types";
import { ImageAssetStore } from "../image/image-asset-store";
import type { MeasuredContextAnchor } from "../agent/context-meter";
import type { ProjectInstructionManifest } from "../instructions/project-instructions";
import type {
  ActiveTurnBoundary,
  ClosedTurnBoundary,
} from "../context/prefix-retirement-planner";
import {
  AdmissionStaleError,
  InMemorySessionLedger,
  type LedgerMutation,
  type SessionLedgerCommitter,
} from "../agent/session-ledger";
import { SessionError, sessionOpenError, sessionWriteError } from "./session-errors";
import {
  createSessionHistoryReader,
  type SessionHistoryReader,
} from "./session-history-reader";
import { SessionLease } from "./session-lock";
import {
  SESSION_SCHEMA_V10_FINGERPRINT,
  SESSION_SCHEMA_VERSION,
  upgradeActiveTurnRetirementContract,
  upgradeRecallIndexContract,
  configureWritableDatabase,
  createSessionSchema,
  dropSessionCloneTriggers,
  rebuildRecallIndex,
  reinstallSessionCloneTriggers,
  verifyReadableSessionSchema,
  verifyRecallIndex,
  verifySessionSchema,
  verifySqliteIntegrity,
} from "./session-schema";
import {
  SKILL_ACTIVATION_RECEIPT_FORMAT,
  SKILL_POLICY_VERSION,
  renderSkillActivationReceipt,
} from "../skills/skill-context";
import {
  assertMeasuredContextAnchor,
  enumFromSql,
  nullableStringFromSql,
  nullableTextFromSql,
  numberFromSql,
  recordFromSql,
  sha256FromSql,
  stringFromSql,
  timestampFromSql,
} from "./session-store-value-codecs";
export { decodeStoredToolRawResult } from "./session-tool-result-codec";
import {
  cloneDiagnosticFiles,
  rekeyProtocolView,
  rekeyStoredToolCalls,
  rewriteCloneRevisionHashes,
  SESSION_SCOPED_TABLES,
} from "./session-clone-helpers";
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
import {
  skillActivationManifestSha256,
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
  type StoredMeasuredContextState,
  type StoredSessionMetaV10,
  type StoredSkillActivation,
} from "./session-store-contracts";
export * from "./session-store-contracts";
export { createSessionCompatibilityContract } from "./session-compatibility-codec";
import {
  compatibilityContractDifferences,
  decodeMeta,
  normalizeSessionCompatibilityContract,
} from "./session-compatibility-codec";
export { decodeStoredToolCalls } from "./session-store-record-codecs";
import {
  decodeContextRevision,
  decodeContextSurface,
  decodeFrame,
  decodeMessage,
  decodeSkillActivation,
  decodeStoredSwapOverride,
  imageAssetRefFromAttachment,
  decodeToolResult,
  loadMessageImageAttachments,
  loadToolMessageContentBlocks,
  protocolPrefixView,
  stripStoredOverride,
} from "./session-store-record-codecs";

export class SessionStore implements SessionLedgerCommitter {
  readonly sessionId: SessionId;
  readonly workspaceRoot: string;
  readonly sessionDirectory: string;
  readonly databasePath: string;
  private closed = false;
  private recallIndexRebuilt = false;
  private readonly validator = new ContextProtocolValidator();
  private readonly revisionCompiler = new ContextRevisionCompiler();
  private readonly swapRenderer = new ContextSwapRenderer();

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
  }

  private readonly homeRoot?: string;

  private readonly clock: () => string;

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

  commit(mutation: LedgerMutation): void {
    this.requireOpen();
    const now = this.clock();
    try {
      runTransaction(this.database, () => {
        switch (mutation.kind) {
          case "begin_turn":
            this.commitBeginTurn(mutation, now);
            break;
          case "append_steering_users":
            this.commitSteeringUsers(mutation, now);
            break;
          case "append_assistant":
            this.commitAssistant(mutation, now);
            break;
          case "commit_tool_completions":
            this.commitToolCompletions(mutation, now);
            break;
          case "finish_turn":
            this.commitFinishTurn(mutation, now);
            break;
        }
      });
    } catch (error) {
      if (error instanceof AdmissionStaleError) {
        throw error;
      }
      throw sessionWriteError(mutation.kind, this.sessionId, error);
    }
  }

  beginIteration(iteration: IterationIdentity): void {
    this.requireOpen();
    const now = this.clock();
    try {
      runTransaction(this.database, () => {
        const turn = this.requireTurnRow(iteration.turnId);
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
        this.touch(now);
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
        this.touch(now);
      });
    } catch (error) {
      throw sessionWriteError("write_context_measurement", this.sessionId, error);
    }
  }

  readActiveMeasuredContextAnchor(): MeasuredContextAnchor | undefined {
    this.requireOpen();
    const state = this.loadMeasuredContextState();
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
    return this.readRetirementBoundaries(canonical).closedTurns;
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
    return this.readRetirementBoundaries(canonical, activeTurnId);
  }

  private readRetirementBoundaries(
    canonical: ProtocolContextView,
    activeTurnId?: TurnId,
  ): {
    readonly closedTurns: readonly ClosedTurnBoundary[];
    readonly activeTurn?: ActiveTurnBoundary;
  } {
    const rows = this.database
      .query("SELECT * FROM turns ORDER BY turn_number")
      .all() as Array<Record<string, unknown>>;
    const boundaries: ClosedTurnBoundary[] = [];
    let activeTurn: ActiveTurnBoundary | undefined;
    let expectedOrdinal = 2;
    for (let index = 0; index < rows.length; index += 1) {
      const row = requireItem(rows, index, "turn row");
      const turnId = stringFromSql(row.turn_id, "turn_id") as TurnId;
      const turnNumber = numberFromSql(row.turn_number, "turn_number");
      const status = enumFromSql(
        row.status,
        ["open", "completed", "failed", "cancelled", "interrupted"] as const,
        "turn status",
      );
      const frames = canonical.frames.filter((frame) => frame.turnId === turnId);
      const messages = canonical.messages.filter(
        (message) => message.role !== "system" && message.turnId === turnId,
      );
      const firstMessage = messages[0];
      const lastMessage = messages.at(-1);
      if (status === "open") {
        if (
          activeTurnId === undefined ||
          turnId !== activeTurnId ||
          index !== rows.length - 1 ||
          turnNumber !== index + 1 ||
          messages.length < 1 ||
          frames.length < 1 ||
          firstMessage?.role !== "user" ||
          firstMessage.ordinal !== expectedOrdinal ||
          lastMessage?.ordinal !== canonical.messages.length ||
          frames.some((frame) => frame.state !== "closed")
        ) {
          throw new Error(`Turn ${turnId} has an invalid active boundary.`);
        }
        activeTurn = Object.freeze({
          turnId,
          turnNumber,
          firstOrdinal: expectedOrdinal,
        });
        expectedOrdinal = canonical.messages.length + 1;
        continue;
      }
      let nextFrameOrdinal = expectedOrdinal;
      for (const frame of frames) {
        if (
          frame.state !== "closed" ||
          frame.firstOrdinal !== nextFrameOrdinal ||
          frame.lastOrdinal === undefined
        ) {
          throw new Error(`Turn ${turnId} has an invalid closed frame boundary.`);
        }
        nextFrameOrdinal = frame.lastOrdinal + 1;
      }
      if (
        turnNumber !== index + 1 ||
        frames.length < 1 ||
        messages.length < 1 ||
        firstMessage?.role !== "user" ||
        firstMessage.ordinal !== expectedOrdinal ||
        lastMessage === undefined ||
        nextFrameOrdinal !== lastMessage.ordinal + 1
      ) {
        throw new Error(`Turn ${turnId} has an invalid canonical boundary.`);
      }
      boundaries.push(
        Object.freeze({
          turnId,
          turnNumber,
          status,
          firstOrdinal: expectedOrdinal,
          lastOrdinal: lastMessage.ordinal,
          frameCount: frames.length,
          messageCount: messages.length,
        }),
      );
      expectedOrdinal = lastMessage.ordinal + 1;
    }
    if (expectedOrdinal !== canonical.messages.length + 1) {
      throw new Error("Closed turn boundaries do not cover canonical history.");
    }
    if ((activeTurnId === undefined) !== (activeTurn === undefined)) {
      throw new Error("Active retirement boundary does not match the open turn.");
    }
    return Object.freeze({
      closedTurns: Object.freeze(boundaries),
      ...(activeTurn === undefined ? {} : { activeTurn }),
    });
  }

  commitSwapRevision(
    input: CommitSwapRevisionInput,
    options: CommitSwapRevisionOptions = {},
  ): Extract<StoredContextRevisionV8, { kind: "swap_only" }> {
    this.requireOpen();
    assertCommitSwapRevisionInput(input);
    const now = this.clock();
    try {
      return runTransaction(this.database, () => {
        const snapshot = this.loadContextSnapshot();
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
        this.assertContextRevisionBoundary(input.activeTurnId);

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

        const readback = this.loadContextSnapshot();
        if (
          readback.revision.kind !== "swap_only" ||
          readback.revision.revisionId !== input.revisionId ||
          this.loadMeasuredContextState() !== undefined
        ) {
          throw new Error("Committed context revision readback failed.");
        }
        return readback.revision;
      });
    } catch (error) {
      if (requireActiveRevisionId(this.readMeta()) !== input.expectedBaseRevisionId) {
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
        const snapshot = this.loadContextSnapshot();
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
        this.assertContextRevisionBoundary(input.activeTurnId);
        const retirementBoundaries = this.readRetirementBoundaries(
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

        const readback = this.loadContextSnapshot();
        if (
          readback.revision.kind !== "prefix_retirement" ||
          readback.revision.revisionId !== input.revisionId ||
          readback.revision.keepFromOrdinal !== input.nextKeepFromOrdinal ||
          this.loadMeasuredContextState() !== undefined
        ) {
          throw new Error("Committed prefix retirement readback failed.");
        }
        options.faultInjector?.("after_snapshot_readback");
        return readback.revision;
      });
    } catch (error) {
      if (requireActiveRevisionId(this.readMeta()) !== input.expectedBaseRevisionId) {
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
        const snapshot = this.loadContextSnapshot();
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
        this.assertContextRevisionIdle();
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

        const readback = this.loadContextSnapshot();
        if (
          readback.revision.kind !== "surface_refresh" ||
          readback.revision.revisionId !== input.revisionId ||
          readback.surface.surfaceId !== input.surface.surfaceId ||
          this.loadMeasuredContextState() !== undefined
        ) {
          throw new Error("Committed context surface revision readback failed.");
        }
        return readback.revision;
      });
    } catch (error) {
      if (requireActiveRevisionId(this.readMeta()) !== input.expectedBaseRevisionId) {
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
        const snapshot = this.loadContextSnapshot();
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
        this.assertContextRevisionIdle();
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
          this.loadSkillActivations(["pending", "dispatched"]).map((entry) => [
            entry.activationMessageId,
            entry,
          ]),
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

        const readback = this.loadContextSnapshot();
        if (
          readback.revision.kind !== "skills_update" ||
          readback.revision.revisionId !== input.revisionId ||
          readback.surface.surfaceId !== input.surface.surfaceId ||
          this.loadMeasuredContextState() !== undefined ||
          this.loadSkillActivations(["pending", "dispatched"]).some((entry) =>
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
      if (requireActiveRevisionId(this.readMeta()) !== input.expectedBaseRevisionId) {
        throw new Error("Failed Agent Skills transaction changed active state.", {
          cause: error,
        });
      }
      throw sessionWriteError("commit_skills_update", this.sessionId, error);
    }
  }

  private validateAddedOverrides(
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
        const iteration = this.requireIterationRow(input.iterationId);
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
        this.touch(now);
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
    this.requireOpen();
    const view = this.loadProtocolView();
    const openTurns = this.database
      .query("SELECT turn_id FROM turns WHERE status = 'open' ORDER BY turn_number")
      .all() as Array<{ turn_id: string }>;
    const openFrames = view.frames.filter((frame) => frame.state === "open");
    if (openTurns.length === 0 && openFrames.length === 0) {
      return {
        syntheticCompletionCount: 0,
        recallIndexRebuilt: this.recallIndexRebuilt,
      };
    }
    if (openTurns.length !== 1 || openFrames.length > 1) {
      throw this.recoveryError(
        "Session has an invalid number of open turns or frames.",
      );
    }
    const turnId = openTurns[0].turn_id as TurnId;
    const openIterations = this.database
      .query(
        "SELECT iteration_id FROM iterations WHERE turn_id = ? AND outcome = 'open' ORDER BY iteration_number",
      )
      .all(turnId) as Array<{ iteration_id: string }>;
    if (openIterations.length > 1) {
      throw this.recoveryError(`Turn ${turnId} has multiple open iterations.`);
    }

    const frame = openFrames[0];
    if (frame === undefined) {
      this.markOpenTurnInterrupted(
        turnId,
        openIterations[0]?.iteration_id as IterationId | undefined,
      );
      this.validateAll({ allowOpenTail: false });
      return {
        recoveredTurnId: turnId,
        syntheticCompletionCount: 0,
        recallIndexRebuilt: this.recallIndexRebuilt,
      };
    }
    if (
      frame.turnId !== turnId ||
      frame !== view.frames.at(-1) ||
      openIterations.length !== 1 ||
      frame.iterationId !== openIterations[0]?.iteration_id
    ) {
      throw this.recoveryError(`Open frame ${frame.frameId} has invalid ownership.`);
    }

    const frameMessages = view.messages.filter(
      (message) => message.frameId === frame.frameId,
    );
    const assistant = frameMessages[0];
    if (assistant?.role !== "assistant" || assistant.toolCalls === undefined) {
      throw this.recoveryError(`Open frame ${frame.frameId} has no tool calls.`);
    }
    const missingCalls = assistant.toolCalls.slice(frameMessages.length - 1);
    if (missingCalls.length === 0) {
      throw this.recoveryError(`Open frame ${frame.frameId} has no missing call.`);
    }
    const completionInputs = interruptedCompletionInputs(missingCalls);
    const messages: CanonicalMessageRecord[] = [];
    const toolResults: ToolResultRecord[] = [];
    for (const input of completionInputs) {
      const createdAt = this.clock();
      const content = observationForCompletion(input);
      const displayText = toolResultDisplayText(content);
      const messageId = idFactory.createMessageId();
      const message = immutableRecord<CanonicalMessageRecord>({
        messageId,
        sessionId: this.sessionId,
        frameId: frame.frameId,
        ordinal: view.messages.length + messages.length + 1,
        contentSha256: canonicalToolResultContentHash(content),
        createdAt,
        role: "tool",
        turnId,
        iterationId: frame.iterationId,
        toolCallId: input.call.toolCallId,
        providerToolCallId: input.call.providerToolCallId,
        name: input.call.name,
        content,
        displayText,
        origin: "runtime",
      });
      const completion: ToolCompletion = immutableRecord({
        kind: "synthetic",
        reason: input.reason,
      });
      const result = immutableRecord<ToolResultRecord>({
        sessionId: this.sessionId,
        frameId: frame.frameId,
        toolCallId: input.call.toolCallId,
        toolMessageId: messageId,
        completion,
        observationSha256: canonicalToolResultContentHash(content),
        createdAt,
      });
      messages.push(message);
      toolResults.push(result);
    }
    const closedAt = this.clock();
    const closedFrame = immutableRecord<ProtocolFrame>({
      ...frame,
      state: "closed",
      lastOrdinal: view.messages.length + messages.length,
      closedAt,
    });
    const candidate: ProtocolContextView = Object.freeze({
      ...view,
      frames: Object.freeze(
        view.frames.map((entry) =>
          entry.frameId === frame.frameId ? closedFrame : entry,
        ),
      ),
      messages: Object.freeze([...view.messages, ...messages]),
      toolResults: Object.freeze([...view.toolResults, ...toolResults]),
    });
    this.validator.validate(candidate, { fullIntegrity: true });

    try {
      runTransaction(this.database, () => {
        for (let index = 0; index < messages.length; index += 1) {
          insertMessage(
            this.database,
            requireItem(messages, index, "recovery message"),
          );
          insertToolResult(
            this.database,
            requireItem(toolResults, index, "recovery tool result"),
          );
        }
        const frameUpdate = this.database
          .query(
            `UPDATE protocol_frames SET state = 'closed', last_ordinal = ?, closed_at = ?
           WHERE frame_id = ? AND state = 'open' AND last_ordinal IS NULL`,
          )
          .run(closedFrame.lastOrdinal!, closedAt, frame.frameId);
        requireSingleChange(
          this.database,
          frameUpdate.changes,
          "close recovered frame",
        );
        this.markTerminalRows(
          turnId,
          frame.iterationId!,
          "interrupted",
          "interrupted",
          null,
          stableJsonStringify({ version: 1, reason: "process_interrupted" }),
          closedAt,
        );
      });
    } catch (error) {
      throw new SessionError(
        "SESSION_RECOVERY_FAILED",
        "recover_open_frame",
        `Failed to recover open frame ${frame.frameId}.`,
        { sessionId: this.sessionId, frameId: frame.frameId, cause: error },
      );
    }
    this.validateAll({ allowOpenTail: false });
    return {
      recoveredTurnId: turnId,
      recoveredFrameId: frame.frameId,
      syntheticCompletionCount: messages.length,
      recallIndexRebuilt: this.recallIndexRebuilt,
    };
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
      return this.loadValidatedContextSnapshot(meta, canonical);
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
      this.loadValidatedContextSnapshot(meta, view);
      this.validateCounters(meta, view);
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

  private commitBeginTurn(
    mutation: Extract<LedgerMutation, { kind: "begin_turn" }>,
    now: string,
  ): void {
    const meta = this.readMeta();
    if (mutation.admissionBase !== undefined) {
      const snapshot = this.loadContextSnapshot();
      const head = snapshot.canonical.messages.at(-1);
      const base = mutation.admissionBase;
      if (
        head === undefined ||
        base.canonicalMessageCount !== snapshot.canonical.messages.length ||
        base.canonicalHeadMessageId !== head.messageId ||
        base.canonicalHeadContentSha256 !== head.contentSha256 ||
        base.activeRevisionId !== snapshot.revision.revisionId ||
        base.activeRevisionNumber !== snapshot.revision.revisionNumber ||
        base.surfaceSha256 !== snapshot.surface.surfaceSha256 ||
        base.sessionCompatibilitySha256 !== meta.sessionCompatibilitySha256 ||
        base.nextTurnNumber !== meta.nextTurnNumber
      ) {
        throw new AdmissionStaleError();
      }
    }
    if (
      meta.initializationState !== "ready" ||
      meta.nextTurnNumber !== mutation.turn.turnNumber
    ) {
      throw new Error("Session turn counter or state changed before begin_turn.");
    }
    this.database
      .query(
        `INSERT INTO turns (
        session_id, turn_id, turn_number, status, next_iteration_number,
        last_iteration_id, final_message_id, terminal_detail_json, started_at, finished_at
      ) VALUES (?, ?, ?, 'open', 1, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(this.sessionId, mutation.turn.turnId, mutation.turn.turnNumber, now);
    insertFrame(this.database, mutation.frame);
    insertMessage(this.database, mutation.message);
    const updated = this.database
      .query(
        `UPDATE session_meta SET next_turn_number = ?, updated_at = ?
       WHERE singleton = 1 AND next_turn_number = ?`,
      )
      .run(mutation.turn.turnNumber + 1, now, mutation.turn.turnNumber);
    requireSingleChange(this.database, updated.changes, "advance turn counter");
  }

  private commitSteeringUsers(
    mutation: Extract<LedgerMutation, { kind: "append_steering_users" }>,
    now: string,
  ): void {
    const turn = this.requireTurnRow(mutation.turn.turnId);
    if (turn.status !== "open") {
      throw new Error(`Turn ${mutation.turn.turnId} is not open.`);
    }
    if (
      mutation.frames.length === 0 ||
      mutation.frames.length !== mutation.messages.length
    ) {
      throw new Error(
        "Steering user mutation must contain matching frames and messages.",
      );
    }
    for (let index = 0; index < mutation.frames.length; index += 1) {
      insertFrame(this.database, requireItem(mutation.frames, index, "steering frame"));
      insertMessage(
        this.database,
        requireItem(mutation.messages, index, "steering message"),
      );
    }
    this.touch(now);
  }

  private commitAssistant(
    mutation: Extract<LedgerMutation, { kind: "append_assistant" }>,
    now: string,
  ): void {
    const iteration = this.requireIterationRow(mutation.iteration.iterationId);
    if (iteration.outcome !== "open") {
      throw new Error(`Iteration ${mutation.iteration.iterationId} is not open.`);
    }
    insertFrame(this.database, mutation.frame);
    insertMessage(this.database, mutation.message);
    if (
      mutation.message.role === "assistant" &&
      mutation.message.toolCalls !== undefined
    ) {
      const expected = numberFromSql(
        iteration.next_tool_call_number,
        "next_tool_call_number",
      );
      if (expected !== 1) {
        throw new Error(
          "Assistant tool calls were already allocated for this iteration.",
        );
      }
      const updated = this.database
        .query(
          `UPDATE iterations SET next_tool_call_number = ?
         WHERE iteration_id = ? AND outcome = 'open' AND next_tool_call_number = 1`,
        )
        .run(mutation.message.toolCalls.length + 1, mutation.iteration.iterationId);
      requireSingleChange(this.database, updated.changes, "advance tool call counter");
    }
    this.touch(now);
  }

  private commitToolCompletions(
    mutation: Extract<LedgerMutation, { kind: "commit_tool_completions" }>,
    now: string,
  ): void {
    const current = this.database
      .query("SELECT state, last_ordinal FROM protocol_frames WHERE frame_id = ?")
      .get(mutation.frameBefore.frameId) as {
      state: string;
      last_ordinal: unknown;
    } | null;
    if (current?.state !== "open" || current.last_ordinal !== null) {
      throw new Error(`Frame ${mutation.frameBefore.frameId} is not open.`);
    }
    for (let index = 0; index < mutation.messages.length; index += 1) {
      const message = requireItem(mutation.messages, index, "tool message");
      const result = requireItem(mutation.toolResults, index, "tool result");
      insertMessage(this.database, message);
      insertToolResult(this.database, result);
      insertPendingSkillActivation(this.database, message, result, now);
    }
    if (mutation.frameAfter.state === "closed") {
      const updated = this.database
        .query(
          `UPDATE protocol_frames SET state = 'closed', last_ordinal = ?, closed_at = ?
         WHERE frame_id = ? AND state = 'open' AND last_ordinal IS NULL`,
        )
        .run(
          mutation.frameAfter.lastOrdinal!,
          mutation.frameAfter.closedAt!,
          mutation.frameAfter.frameId,
        );
      requireSingleChange(this.database, updated.changes, "close tool exchange frame");
    }
    this.touch(now);
  }

  private commitFinishTurn(
    mutation: Extract<LedgerMutation, { kind: "finish_turn" }>,
    now: string,
  ): void {
    const result = mutation.result;
    const turnStatus = result.status;
    const iterationOutcome = result.status;
    const detail =
      result.status === "completed"
        ? stableJsonStringify({ version: 1, finalTextLength: result.finalText.length })
        : result.status === "failed"
          ? stableJsonStringify({ version: 1, error: result.error.slice(0, 2_000) })
          : stableJsonStringify({ version: 1, cancellation: result.cancellation });
    this.markTerminalRows(
      mutation.turn.turnId,
      result.lastIteration.iterationId,
      turnStatus,
      iterationOutcome,
      mutation.finalMessageId ?? null,
      detail,
      now,
    );
  }

  private markTerminalRows(
    turnId: TurnId,
    iterationId: IterationId,
    turnStatus: "completed" | "failed" | "cancelled" | "interrupted",
    iterationOutcome: "completed" | "failed" | "cancelled" | "interrupted",
    finalMessageId: MessageId | null,
    terminalDetailJson: string,
    now: string,
  ): void {
    const iteration = this.database
      .query(
        `UPDATE iterations SET outcome = ?, finished_at = ?
       WHERE iteration_id = ? AND turn_id = ? AND outcome = 'open'`,
      )
      .run(iterationOutcome, now, iterationId, turnId);
    requireSingleChange(this.database, iteration.changes, "finish iteration");
    const turn = this.database
      .query(
        `UPDATE turns SET status = ?, last_iteration_id = ?, final_message_id = ?,
         terminal_detail_json = ?, finished_at = ?
       WHERE turn_id = ? AND status = 'open'`,
      )
      .run(turnStatus, iterationId, finalMessageId, terminalDetailJson, now, turnId);
    requireSingleChange(this.database, turn.changes, "finish turn");
    this.touch(now);
  }

  private markOpenTurnInterrupted(
    turnId: TurnId,
    iterationId: IterationId | undefined,
  ): void {
    const now = this.clock();
    try {
      runTransaction(this.database, () => {
        if (iterationId !== undefined) {
          const iteration = this.database
            .query(
              `UPDATE iterations SET outcome = 'interrupted', finished_at = ?
             WHERE iteration_id = ? AND outcome = 'open'`,
            )
            .run(now, iterationId);
          requireSingleChange(this.database, iteration.changes, "interrupt iteration");
        }
        const turn = this.database
          .query(
            `UPDATE turns SET status = 'interrupted', finished_at = ?,
             terminal_detail_json = ?
           WHERE turn_id = ? AND status = 'open'`,
          )
          .run(
            now,
            stableJsonStringify({ version: 1, reason: "process_interrupted" }),
            turnId,
          );
        requireSingleChange(this.database, turn.changes, "interrupt turn");
        this.touch(now);
      });
    } catch (error) {
      throw new SessionError(
        "SESSION_RECOVERY_FAILED",
        "recover_open_turn",
        `Failed to mark turn ${turnId} interrupted.`,
        { sessionId: this.sessionId, cause: error },
      );
    }
  }

  private loadValidatedContextSnapshot(
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

    const measurement = this.loadMeasuredContextState();
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

  private loadMeasuredContextState(): StoredMeasuredContextState | undefined {
    const rows = this.database.query("SELECT * FROM context_measurement_state").all();
    if (rows.length > 1) {
      throw new Error(
        `Expected at most one context measurement row; found ${rows.length}.`,
      );
    }
    const row = rows[0];
    return row === undefined
      ? undefined
      : decodeMeasuredContextState(row, this.sessionId);
  }

  private validateCounters(
    meta: StoredSessionMetaV10,
    view: ProtocolContextView,
  ): void {
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

  private requireTurnRow(turnId: TurnId): Record<string, unknown> {
    const row = this.database
      .query("SELECT * FROM turns WHERE turn_id = ?")
      .get(turnId) as Record<string, unknown> | null;
    if (row === null) {
      throw new Error(`Unknown turn ${turnId}.`);
    }
    return row;
  }

  private requireIterationRow(iterationId: IterationId): Record<string, unknown> {
    const row = this.database
      .query("SELECT * FROM iterations WHERE iteration_id = ?")
      .get(iterationId) as Record<string, unknown> | null;
    if (row === null) {
      throw new Error(`Unknown iteration ${iterationId}.`);
    }
    return row;
  }

  private touch(timestamp: string): void {
    const updated = this.database
      .query("UPDATE session_meta SET updated_at = ? WHERE singleton = 1")
      .run(timestamp);
    requireSingleChange(this.database, updated.changes, "touch session");
  }

  private recoveryError(message: string): SessionError {
    return new SessionError("SESSION_RECOVERY_FAILED", "recover_session", message, {
      sessionId: this.sessionId,
    });
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

function insertPendingSkillActivation(
  database: Database,
  message: CanonicalMessageRecord,
  result: ToolResultRecord,
  now: string,
): void {
  if (
    message.role !== "tool" ||
    result.completion.kind !== "returned" ||
    result.completion.raw.kind !== "skill" ||
    !result.completion.raw.ok ||
    result.completion.raw.status !== "loaded"
  ) {
    return;
  }
  const raw = result.completion.raw;
  if (message.name !== "Skill" || message.messageId !== result.toolMessageId) {
    throw new Error("Loaded Agent Skill completion has invalid tool identity.");
  }
  database
    .query(
      `INSERT INTO skill_activations (
        activation_message_id, tool_call_id, session_id, name, scope,
        skill_file_sha256, state, dispatched_iteration_id, settled_revision_id,
        rejection_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      message.messageId,
      result.toolCallId,
      result.sessionId,
      raw.name,
      raw.scope,
      raw.sha256,
      now,
      now,
    );
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

function insertFrame(database: Database, frame: ProtocolFrame): void {
  database
    .query(
      `INSERT INTO protocol_frames (
      frame_id, session_id, turn_id, iteration_id, kind, state,
      first_ordinal, last_ordinal, created_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      frame.frameId,
      frame.sessionId,
      frame.turnId ?? null,
      frame.iterationId ?? null,
      frame.kind,
      frame.state,
      frame.firstOrdinal,
      frame.lastOrdinal ?? null,
      frame.createdAt,
      frame.closedAt ?? null,
    );
}

function insertMessage(database: Database, message: CanonicalMessageRecord): void {
  const assistant = message.role === "assistant" ? message : undefined;
  const tool = message.role === "tool" ? message : undefined;
  const turnId = "turnId" in message ? message.turnId : null;
  const iterationId = "iterationId" in message ? message.iterationId : null;
  const reasoningPresent =
    assistant !== undefined && assistant.reasoningContent !== undefined ? 1 : 0;
  database
    .query(
      `INSERT INTO messages (
      message_id, session_id, frame_id, ordinal, role, turn_id, iteration_id,
      content, content_sha256, reasoning_content, reasoning_content_present,
      tool_calls_json, provider, model, tool_call_id, provider_tool_call_id,
      name, origin, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      message.messageId,
      message.sessionId,
      message.frameId,
      message.ordinal,
      message.role,
      turnId,
      iterationId,
      message.role === "tool" ? message.displayText : message.content,
      message.contentSha256,
      assistant?.reasoningContent ?? null,
      reasoningPresent,
      assistant?.toolCalls === undefined
        ? null
        : stableJsonStringify(assistant.toolCalls),
      assistant?.provider ?? null,
      assistant?.model ?? null,
      tool?.toolCallId ?? null,
      tool?.providerToolCallId ?? null,
      tool?.name ?? null,
      message.origin,
      message.createdAt,
    );
  if (message.role === "user" && message.attachments !== undefined) {
    insertMessageImageAttachments(database, message);
  }
  if (message.role === "tool") {
    insertToolMessageContentBlocks(database, message);
  }
}

function insertMessageImageAttachments(
  database: Database,
  message: Extract<CanonicalMessageRecord, { role: "user" }>,
): void {
  const userMessage = {
    role: "user" as const,
    content: message.content,
    attachments: message.attachments,
  };
  validateUserMessage(userMessage);
  if (userMessageHash(userMessage) !== message.contentSha256) {
    throw new Error("User image attachment hash does not match the message hash.");
  }
  for (let position = 0; position < message.attachments!.length; position += 1) {
    const attachment = requireItem(message.attachments!, position, "image attachment");
    ensureImageAsset(
      database,
      imageAssetRefFromAttachment(attachment),
      message.createdAt,
    );
    database
      .query(
        `INSERT INTO message_image_attachments (
           message_id, attachment_id, asset_id, position, label,
           range_start, range_end, original_name
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.messageId,
        attachment.attachmentId,
        attachment.assetId,
        position,
        attachment.label,
        attachment.range.start,
        attachment.range.end,
        attachment.originalName,
      );
  }
}

function insertToolMessageContentBlocks(
  database: Database,
  message: Extract<CanonicalMessageRecord, { role: "tool" }>,
): void {
  validateToolResultContent(message.content);
  if (
    canonicalToolResultContentHash(message.content) !== message.contentSha256 ||
    toolResultDisplayText(message.content) !== message.displayText
  ) {
    throw new Error("Tool content blocks do not match canonical message metadata.");
  }
  for (let position = 0; position < message.content.length; position += 1) {
    const block = requireItem(message.content, position, "tool content block");
    if (block.type === "image") {
      ensureImageAsset(database, block.asset, message.createdAt);
    }
    database
      .query(
        `INSERT INTO tool_message_content_blocks (
           message_id, position, kind, text_content, asset_id
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        message.messageId,
        position,
        block.type,
        block.type === "text" ? block.text : null,
        block.type === "image" ? block.asset.assetId : null,
      );
  }
}

function ensureImageAsset(
  database: Database,
  asset: ImageAssetRef,
  createdAt: string,
): void {
  const existing = database
    .query(
      `SELECT mime_type, byte_length, width, height, created_at
       FROM image_assets WHERE asset_id = ?`,
    )
    .get(asset.assetId) as {
    mime_type: unknown;
    byte_length: unknown;
    width: unknown;
    height: unknown;
    created_at: unknown;
  } | null;
  if (existing === null) {
    database
      .query(
        `INSERT INTO image_assets (
           asset_id, mime_type, byte_length, width, height, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        asset.assetId,
        asset.mimeType,
        asset.byteLength,
        asset.width,
        asset.height,
        createdAt,
      );
    return;
  }
  timestampFromSql(existing.created_at, "image asset created_at");
  if (
    existing.mime_type !== asset.mimeType ||
    numberFromSql(existing.byte_length, "image asset byte_length") !==
      asset.byteLength ||
    numberFromSql(existing.width, "image asset width") !== asset.width ||
    numberFromSql(existing.height, "image asset height") !== asset.height
  ) {
    throw new Error(`Image asset metadata conflicts for ${asset.assetId}.`);
  }
}

function insertToolResult(database: Database, result: ToolResultRecord): void {
  const returned = result.completion.kind === "returned" ? result.completion : null;
  const synthetic = result.completion.kind === "synthetic" ? result.completion : null;
  database
    .query(
      `INSERT INTO tool_results (
      tool_call_id, session_id, frame_id, tool_message_id, completion_kind,
      raw_json, raw_sha256, observation_format, synthetic_reason,
      synthetic_detail, observation_sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      result.toolCallId,
      result.sessionId,
      result.frameId,
      result.toolMessageId,
      result.completion.kind,
      returned === null ? null : stableJsonStringify(returned.raw),
      returned?.rawSha256 ?? null,
      returned?.observationFormat ?? null,
      synthetic?.reason ?? null,
      synthetic?.detail ?? null,
      result.observationSha256,
      result.createdAt,
    );
}

function insertContextSurface(
  database: Database,
  surface: StoredContextSurfaceV8,
): void {
  validateStoredContextSurface(surface);
  database
    .query(
      `INSERT INTO context_surfaces (
        surface_id, session_id, system_prompt, system_prompt_sha256,
        recall_contract_version,
        project_instruction_json, skill_catalog_json, skill_catalog_sha256,
        active_skills_json, active_skills_sha256, tool_definitions_json,
        tool_definitions_sha256, tool_schema_sha256, request_config_sha256,
        request_max_output_tokens, surface_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      surface.surfaceId,
      surface.sessionId,
      surface.systemPrompt,
      surface.systemPromptSha256,
      surface.recallContractVersion,
      surface.projectInstruction === undefined
        ? null
        : stableJsonStringify(surface.projectInstruction),
      stableJsonStringify(surface.skillCatalog),
      surface.skillCatalogSha256,
      stableJsonStringify(surface.activeSkills),
      surface.activeSkillsSha256,
      stableJsonStringify(surface.toolDefinitions),
      surface.toolDefinitionsSha256,
      surface.toolSchemaSha256,
      surface.requestConfigSha256,
      surface.requestMaxOutputTokens,
      surface.surfaceSha256,
      surface.createdAt,
    );
}

function decodeMeasuredContextState(
  value: unknown,
  expectedSessionId: SessionId,
): StoredMeasuredContextState {
  const row = recordFromSql(value, "context measurement state");
  const sessionId = stringFromSql(row.session_id, "session_id") as SessionId;
  if (sessionId !== expectedSessionId) {
    throw new Error(
      `Context measurement session ID ${sessionId} does not match store.`,
    );
  }
  const promptTokens = numberFromSql(row.prompt_tokens, "prompt_tokens");
  const completionTokens = numberFromSql(row.completion_tokens, "completion_tokens");
  const totalTokens = numberFromSql(row.total_tokens, "total_tokens");
  if (totalTokens !== promptTokens + completionTokens) {
    throw new Error(
      "Context measurement total_tokens must equal prompt_tokens + completion_tokens.",
    );
  }
  timestampFromSql(row.updated_at, "updated_at");
  return Object.freeze({
    revisionId: stringFromSql(row.revision_id, "revision_id") as ContextRevisionId,
    anchor: Object.freeze({
      totalTokens,
      promptTokens,
      completionTokens,
      segmentCount: numberFromSql(row.segment_count, "segment_count"),
      prefixHash: sha256FromSql(row.prefix_hash, "prefix_hash"),
      requestConfigHash: sha256FromSql(row.request_config_hash, "request_config_hash"),
      toolSchemaHash: sha256FromSql(row.tool_schema_hash, "tool_schema_hash"),
    }),
  });
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

function requireActiveRevisionId(meta: StoredSessionMetaV10): ContextRevisionId {
  if (meta.initializationState !== "ready" || meta.activeRevisionId === null) {
    throw new Error("Session has no active context revision.");
  }
  return meta.activeRevisionId;
}

function previousRevision(
  revisions: readonly StoredContextRevisionV8[],
  revision: StoredContextRevisionV8,
): StoredContextRevisionV8 | undefined {
  return revisions[revision.revisionNumber - 2];
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

function runTransaction<T>(database: Database, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the mutation error; the session will fault and close the database.
    }
    throw error;
  }
}

function requireSingleChange(
  database: Database,
  reportedChanges: number | bigint,
  operation: string,
): void {
  const row = database.query("SELECT changes() AS changes").get() as {
    changes: number | bigint;
  };
  if (Number(row.changes) !== 1) {
    throw new Error(
      `${operation} must change exactly one row; changed ${row.changes} (driver reported ${reportedChanges}).`,
    );
  }
}

function requireItem<T>(items: readonly T[], index: number, name: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Missing ${name} at index ${index}.`);
  }
  return item;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
