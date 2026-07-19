import path from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type {
  ContextRevisionId,
  ContextSurfaceId,
  IterationId,
  MessageId,
  ProtocolFrameId,
  RuntimeIdFactory,
  SessionId,
  ToolCallId,
  TurnId,
} from "../ids/runtime-id";
import {
  createModelContextProfile,
  type ModelContextProfile,
} from "../model/model-context-profile";
import type { ModelMessageProtocol } from "../model/model-client";
import type { ToolDefinition, ToolRawResult } from "../tools/types";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
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
import { recallFirstRetirementPolicyV1 } from "../context/context-policy";
import {
  ContextSwapRenderer,
  SWAP_OBSERVATION_FORMAT,
} from "../context/context-swap-renderer";
import {
  SUPPORTED_TOOL_OBSERVATION_FORMATS,
  contentHash,
  immutableCanonicalClone,
  immutableRecord,
  interruptedCompletionInputs,
  observationForCompletion,
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
  type ContextSurfaceChanges,
  type StoredContextSurfaceV8,
} from "../context/context-surface";
import type {
  StoredContextRevisionV8,
  StoredContextSnapshotV8,
  StoredContextOverrideV8,
  SwapOverride,
} from "../context/context-revision";
import type { IterationIdentity, ToolCall } from "../agent/types";
import type { MeasuredContextAnchor } from "../agent/context-meter";
import type { ProjectInstructionManifest } from "../instructions/project-instructions";
import { SUPPORTED_RECALL_RETIREMENT_CONTRACT_VERSIONS } from "../context/recall-retirement-contract";
import type { ClosedTurnBoundary } from "../context/prefix-retirement-planner";
import {
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
  SESSION_SCHEMA_V8_FINGERPRINT,
  SESSION_SCHEMA_VERSION,
  configureWritableDatabase,
  createSessionSchema,
  dropSessionCloneTriggers,
  rebuildRecallIndex,
  reinstallSessionCloneTriggers,
  verifyRecallIndex,
  verifySessionSchema,
  verifySqliteIntegrity,
} from "./session-schema";
import type { AgentEvent } from "../events/types";
import { renderObservationLogEvent } from "../events/observation-text-log";
import {
  SKILL_FILE_MAX_BYTES,
  SKILL_RESOURCE_MAX_DEPTH,
  SKILL_RESOURCE_MAX_ENTRIES,
  type SkillScope,
} from "../skills/skill-loader";
import type {
  ActiveSkillManifestEntry,
  SkillCatalogManifestEntry,
} from "../skills/skill-catalog";
import {
  SKILL_ACTIVATION_RECEIPT_FORMAT,
  SKILL_POLICY_VERSION,
  renderSkillActivationReceipt,
} from "../skills/skill-context";

export type SessionCompatibilityContract = {
  modelName: string;
  profileName?: string;
  includeReasoningContent: boolean;
  contextProfile: ModelContextProfile;
  messageProtocol: ModelMessageProtocol;
};

export type StoredSessionMetaV8 = {
  schemaVersion: 8;
  schemaFingerprint: string;
  initializationState: "creating" | "ready";
  sessionId: SessionId;
  workspaceRoot: string;
  modelName: string;
  systemPromptSha256: string;
  projectInstruction?: ProjectInstructionManifest;
  sessionCompatibilityJson: string | null;
  sessionCompatibilitySha256: string | null;
  activeRevisionId: ContextRevisionId | null;
  nextTurnNumber: number;
  nextEventSequence: number;
  openCount: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  lastClosedAt: string | null;
  lastCloseReason:
    | "oneshot_complete"
    | "tui_exit"
    | "session_switch"
    | "runner_failed"
    | "initialization_failed"
    | null;
};

export type SessionCloseReason = NonNullable<StoredSessionMetaV8["lastCloseReason"]>;

export type SessionRecoveryResult = {
  recoveredTurnId?: TurnId;
  recoveredFrameId?: ProtocolFrameId;
  syntheticCompletionCount: number;
  recallIndexRebuilt: boolean;
};

type StoredMeasuredContextState = {
  revisionId: ContextRevisionId;
  anchor: MeasuredContextAnchor;
};

export type CommitSwapRevisionInput = {
  revisionId: ContextRevisionId;
  expectedBaseRevisionId: ContextRevisionId;
  expectedBaseRevisionNumber: number;
  expectedCanonicalThroughOrdinal: number;
  expectedBaseActiveOverrideManifestSha256: string;
  policyVersion: "swap-only-v1";
  rendererFormat: typeof SWAP_OBSERVATION_FORMAT;
  planHash: string;
  addedOverrides: readonly SwapOverride[];
  nextActiveOverrideManifestSha256: string;
  canonicalSequenceSha256: string;
  renderedMessageSha256: string;
};

export type CommitSwapRevisionFaultStage =
  | "before_revision_insert"
  | "after_revision_insert"
  | "after_first_override_insert"
  | "after_overrides_insert"
  | "after_measurement_delete"
  | "after_active_update";

export type CommitSwapRevisionOptions = {
  faultInjector?: (stage: CommitSwapRevisionFaultStage) => void;
};

export type CommitSurfaceRefreshInput = {
  revisionId: ContextRevisionId;
  expectedBaseRevisionId: ContextRevisionId;
  expectedBaseRevisionNumber: number;
  expectedCanonicalThroughOrdinal: number;
  expectedBaseActiveOverrideManifestSha256: string;
  surface: StoredContextSurfaceV8;
  changes: ContextSurfaceChanges;
  changeManifestSha256: string;
  canonicalSequenceSha256: string;
  renderedMessageSha256: string;
};

export type CommitSurfaceRefreshFaultStage =
  | "before_surface_insert"
  | "after_surface_insert"
  | "after_revision_insert"
  | "after_measurement_delete"
  | "after_active_update";

export type CommitSurfaceRefreshOptions = {
  faultInjector?: (stage: CommitSurfaceRefreshFaultStage) => void;
};

export type CommitPrefixRetirementRevisionInput = {
  revisionId: ContextRevisionId;
  expectedBaseRevisionId: ContextRevisionId;
  expectedBaseRevisionNumber: number;
  expectedBaseKeepFromOrdinal: number;
  expectedCanonicalThroughOrdinal: number;
  expectedSurfaceSha256: string;
  expectedBaseActiveOverrideManifestSha256: string;
  policyVersion: "recall-first-retirement-v1";
  planHash: string;
  nextKeepFromOrdinal: number;
  retiredThroughOrdinal: number;
  retiredTurnCount: number;
  retiredFrameCount: number;
  retiredMessageCount: number;
  nextActiveOverrideCount: number;
  nextActiveOverrideManifestSha256: string;
  canonicalSequenceSha256: string;
  renderedMessageSha256: string;
};

export type CommitPrefixRetirementRevisionFaultStage =
  | "before_revision_insert"
  | "after_revision_insert"
  | "after_override_readback"
  | "after_measurement_delete"
  | "after_active_update"
  | "after_snapshot_readback";

export type CommitPrefixRetirementRevisionOptions = {
  faultInjector?: (stage: CommitPrefixRetirementRevisionFaultStage) => void;
};

export type StoredSkillActivation = {
  readonly activationMessageId: MessageId;
  readonly toolCallId: ToolCallId;
  readonly sessionId: SessionId;
  readonly name: string;
  readonly scope: SkillScope;
  readonly skillFileSha256: string;
  readonly state: "pending" | "dispatched" | "promoted" | "rejected";
  readonly dispatchedIterationId?: IterationId;
  readonly settledRevisionId?: ContextRevisionId;
  readonly rejectionReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CommitSkillsUpdateInput = {
  revisionId: ContextRevisionId;
  expectedBaseRevisionId: ContextRevisionId;
  expectedBaseRevisionNumber: number;
  expectedCanonicalThroughOrdinal: number;
  expectedBaseActiveOverrideManifestSha256: string;
  surface: StoredContextSurfaceV8;
  changes: ContextSurfaceChanges;
  changeManifestSha256: string;
  activationManifestSha256: string;
  addedOverrides: readonly SwapOverride[];
  nextActiveOverrideManifestSha256: string;
  settlements: readonly {
    activationMessageId: MessageId;
    name: string;
    state: "promoted" | "rejected";
    rejectionReason?: string;
  }[];
  canonicalSequenceSha256: string;
  renderedMessageSha256: string;
};

export type CommitSkillsUpdateFaultStage =
  | "before_surface_insert"
  | "after_surface_insert"
  | "after_revision_insert"
  | "after_first_override_insert"
  | "after_overrides_insert"
  | "after_activations_update"
  | "after_measurement_delete"
  | "after_active_update";

export type CommitSkillsUpdateOptions = {
  faultInjector?: (stage: CommitSkillsUpdateFaultStage) => void;
};

export type CloneSessionFaultStage =
  | "after_staging_mkdir"
  | "after_snapshot"
  | "after_trigger_drop"
  | "after_identity_update"
  | "after_revision_hash_rewrite"
  | "after_trigger_reinstall"
  | "after_recall_validation"
  | "after_event_rewrite"
  | "after_observation_render"
  | "after_artifact_validation"
  | "before_publish_rename";

export type CloneSessionStoreInput = {
  targetSessionId: SessionId;
  faultInjector?: (stage: CloneSessionFaultStage) => void;
};

export function skillActivationManifestSha256(
  settlements: CommitSkillsUpdateInput["settlements"],
): string {
  return sha256(
    stableJsonStringify(
      [...settlements]
        .sort(
          (left, right) =>
            compareCanonicalText(left.name, right.name) ||
            compareCanonicalText(left.activationMessageId, right.activationMessageId),
        )
        .map((settlement) => ({
          activationMessageId: settlement.activationMessageId,
          name: settlement.name,
          state: settlement.state,
          ...(settlement.rejectionReason === undefined
            ? {}
            : { rejectionReason: settlement.rejectionReason }),
        })),
    ),
  );
}

export type CreateNewSessionStoreInput = {
  workspaceRoot: string;
  sessionId: SessionId;
  modelName: string;
  systemPrompt: string;
  projectInstruction?: ProjectInstructionManifest;
  idFactory: RuntimeIdFactory;
  clock?: () => string;
};

export type OpenSessionStoreInput = {
  workspaceRoot: string;
  sessionId: SessionId;
  clock?: () => string;
  allowIncomplete?: boolean;
};

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
    },
  ) {
    this.sessionId = input.sessionId;
    this.workspaceRoot = input.workspaceRoot;
    this.sessionDirectory = input.sessionDirectory;
    this.databasePath = input.databasePath;
    this.clock = input.clock;
  }

  private readonly clock: () => string;

  static async createNew(input: CreateNewSessionStoreInput): Promise<SessionStore> {
    const clock = input.clock ?? (() => new Date().toISOString());
    const workspaceRoot = await canonicalWorkspaceRoot(input.workspaceRoot);
    const sessionsRoot = await ensureSessionsRoot(workspaceRoot);
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
            SESSION_SCHEMA_V8_FINGERPRINT,
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
    const sessionsRoot = path.join(workspaceRoot, ".tinker", "sessions");
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
      verifySessionSchema(database, input.sessionId);
      verifySqliteIntegrity(database, input.sessionId);
      const store = new SessionStore(database, lease, {
        sessionId: input.sessionId,
        workspaceRoot,
        sessionDirectory,
        databasePath,
        clock,
      });
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
    this.requireOpen();
    const row = this.database
      .query(
        `SELECT
          (SELECT COUNT(*) FROM turns WHERE status = 'open') AS open_turns,
          (SELECT COUNT(*) FROM iterations WHERE outcome = 'open') AS open_iterations,
          (SELECT COUNT(*) FROM protocol_frames WHERE state = 'open') AS open_frames`,
      )
      .get() as Record<string, unknown> | null;
    if (
      row === null ||
      numberFromSql(row.open_turns, "open_turns") !== 0 ||
      numberFromSql(row.open_iterations, "open_iterations") !== 0 ||
      numberFromSql(row.open_frames, "open_frames") !== 0
    ) {
      throw new SessionError(
        "SESSION_INTEGRITY_FAILED",
        "assert_context_revision_idle",
        "Context revision requires a fully idle session store.",
        { sessionId: this.sessionId },
      );
    }
  }

  loadClosedTurnBoundaries(): readonly ClosedTurnBoundary[] {
    this.requireOpen();
    this.assertContextRevisionIdle();
    const canonical = this.loadProtocolView();
    this.validator.validate(canonical, { fullIntegrity: true });
    return this.readClosedTurnBoundaries(canonical);
  }

  private readClosedTurnBoundaries(
    canonical: ProtocolContextView,
  ): readonly ClosedTurnBoundary[] {
    const rows = this.database
      .query("SELECT * FROM turns ORDER BY turn_number")
      .all() as Array<Record<string, unknown>>;
    const boundaries: ClosedTurnBoundary[] = [];
    let expectedOrdinal = 2;
    for (let index = 0; index < rows.length; index += 1) {
      const row = requireItem(rows, index, "turn row");
      const turnId = stringFromSql(row.turn_id, "turn_id") as TurnId;
      const turnNumber = numberFromSql(row.turn_number, "turn_number");
      const status = enumFromSql(
        row.status,
        ["completed", "failed", "cancelled", "interrupted"] as const,
        "closed turn status",
      );
      const frames = canonical.frames.filter((frame) => frame.turnId === turnId);
      const messages = canonical.messages.filter(
        (message) => message.role !== "system" && message.turnId === turnId,
      );
      const firstMessage = messages[0];
      const lastMessage = messages.at(-1);
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
    return Object.freeze(boundaries);
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
        this.assertContextRevisionIdle();

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
        this.assertContextRevisionIdle();
        const closedTurns = this.readClosedTurnBoundaries(snapshot.canonical);
        const activeTurns = closedTurns.filter(
          (turn) => turn.firstOrdinal >= baseRevision.keepFromOrdinal,
        );
        const nextBoundary = activeTurns.find(
          (turn) => turn.firstOrdinal === input.nextKeepFromOrdinal,
        );
        const retainedTurns = activeTurns.filter(
          (turn) => turn.firstOrdinal >= input.nextKeepFromOrdinal,
        );
        const retiredTurns = activeTurns.filter(
          (turn) => turn.lastOrdinal < input.nextKeepFromOrdinal,
        );
        if (
          nextBoundary === undefined ||
          input.nextKeepFromOrdinal <= baseRevision.keepFromOrdinal ||
          retainedTurns.length <
            recallFirstRetirementPolicyV1.protectedRecentTurnCount ||
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
              content: message.content,
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
      const messageId = idFactory.createMessageId();
      const message = immutableRecord<CanonicalMessageRecord>({
        messageId,
        sessionId: this.sessionId,
        frameId: frame.frameId,
        ordinal: view.messages.length + messages.length + 1,
        contentSha256: contentHash(content),
        createdAt,
        role: "tool",
        turnId,
        iterationId: frame.iterationId,
        toolCallId: input.call.toolCallId,
        providerToolCallId: input.call.providerToolCallId,
        name: input.call.name,
        content,
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
        observationSha256: contentHash(content),
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

  loadProtocolView(): ProtocolContextView {
    this.requireOpen();
    const frames = this.database
      .query("SELECT * FROM protocol_frames ORDER BY first_ordinal")
      .all()
      .map(decodeFrame);
    const messages = this.database
      .query("SELECT * FROM messages ORDER BY ordinal")
      .all()
      .map(decodeMessage);
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

  loadContextSnapshot(): StoredContextSnapshotV8 {
    this.requireOpen();
    const meta = this.readMeta();
    try {
      if (
        meta.sessionId !== this.sessionId ||
        meta.schemaFingerprint !== SESSION_SCHEMA_V8_FINGERPRINT
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

  readMeta(): StoredSessionMetaV8 {
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
      meta.schemaFingerprint !== SESSION_SCHEMA_V8_FINGERPRINT ||
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
      });
      clonedStore.validateAll({ allowOpenTail: false });

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
    meta: StoredSessionMetaV8,
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
          override.rendererFormat !== SWAP_OBSERVATION_FORMAT) ||
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
        override.rendererFormat === SWAP_OBSERVATION_FORMAT
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
        content: message.content,
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

  private validateCounters(meta: StoredSessionMetaV8, view: ProtocolContextView): void {
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

export function createSessionCompatibilityContract(input: {
  modelName: string;
  profileName?: string;
  includeReasoningContent: boolean;
  contextProfile: ModelContextProfile;
  messageProtocol: ModelMessageProtocol;
}): SessionCompatibilityContract {
  if (input.modelName.trim() === "") {
    throw new Error("Session compatibility model name must not be empty.");
  }
  if (input.profileName !== undefined && input.profileName.trim() === "") {
    throw new Error("Session compatibility profile name must not be empty.");
  }
  if (typeof input.includeReasoningContent !== "boolean") {
    throw new Error("Session compatibility reasoning replay flag must be boolean.");
  }
  if (
    !["openai-chat", "fake"].includes(input.messageProtocol.adapter) ||
    input.messageProtocol.serializationVersion.trim() === ""
  ) {
    throw new Error("Session compatibility message protocol is invalid.");
  }
  return Object.freeze({
    modelName: input.modelName,
    ...(input.profileName === undefined ? {} : { profileName: input.profileName }),
    includeReasoningContent: input.includeReasoningContent,
    contextProfile: Object.freeze(createModelContextProfile(input.contextProfile)),
    messageProtocol: immutableCanonicalClone(input.messageProtocol),
  });
}

function normalizeSessionCompatibilityContract(
  contract: SessionCompatibilityContract,
): SessionCompatibilityContract {
  return createSessionCompatibilityContract({
    modelName: contract.modelName,
    ...(contract.profileName === undefined
      ? {}
      : { profileName: contract.profileName }),
    includeReasoningContent: contract.includeReasoningContent,
    contextProfile: contract.contextProfile,
    messageProtocol: contract.messageProtocol,
  });
}

export function sessionDatabasePath(
  workspaceRoot: string,
  sessionId: SessionId,
): string {
  return path.join(workspaceRoot, ".tinker", "sessions", sessionId, "session.sqlite");
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
      message.content,
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

function decodeFrame(rowValue: unknown): ProtocolFrame {
  const row = recordFromSql(rowValue, "protocol frame");
  const state = enumFromSql(row.state, ["open", "closed"] as const, "frame state");
  const kind = enumFromSql(
    row.kind,
    ["system", "user", "assistant_text", "tool_exchange"] as const,
    "frame kind",
  );
  const lastOrdinal = nullableNumberFromSql(row.last_ordinal, "last_ordinal");
  const closedAt = nullableStringFromSql(row.closed_at, "closed_at");
  return immutableRecord({
    frameId: stringFromSql(row.frame_id, "frame_id") as ProtocolFrameId,
    sessionId: stringFromSql(row.session_id, "session_id") as SessionId,
    ...(row.turn_id === null
      ? {}
      : { turnId: stringFromSql(row.turn_id, "turn_id") as TurnId }),
    ...(row.iteration_id === null
      ? {}
      : {
          iterationId: stringFromSql(row.iteration_id, "iteration_id") as IterationId,
        }),
    kind,
    state,
    firstOrdinal: numberFromSql(row.first_ordinal, "first_ordinal"),
    ...(lastOrdinal === null ? {} : { lastOrdinal }),
    createdAt: timestampFromSql(row.created_at, "created_at"),
    ...(closedAt === null ? {} : { closedAt: timestampValue(closedAt, "closed_at") }),
  });
}

function decodeMessage(rowValue: unknown): CanonicalMessageRecord {
  const row = recordFromSql(rowValue, "message");
  const base = {
    messageId: stringFromSql(row.message_id, "message_id") as MessageId,
    sessionId: stringFromSql(row.session_id, "session_id") as SessionId,
    frameId: stringFromSql(row.frame_id, "frame_id") as ProtocolFrameId,
    ordinal: numberFromSql(row.ordinal, "ordinal"),
    contentSha256: stringFromSql(row.content_sha256, "content_sha256"),
    createdAt: timestampFromSql(row.created_at, "created_at"),
  };
  const role = enumFromSql(
    row.role,
    ["system", "user", "assistant", "tool"] as const,
    "message role",
  );
  switch (role) {
    case "system":
      return immutableRecord({
        ...base,
        role,
        content: stringFromSql(row.content, "content"),
        origin: "runtime",
      });
    case "user":
      return immutableRecord({
        ...base,
        role,
        turnId: stringFromSql(row.turn_id, "turn_id") as TurnId,
        content: stringFromSql(row.content, "content"),
        origin: "user",
      });
    case "assistant": {
      const content = nullableTextFromSql(row.content, "content");
      const reasoningPresent = numberFromSql(
        row.reasoning_content_present,
        "reasoning_content_present",
      );
      if (reasoningPresent !== 0 && reasoningPresent !== 1) {
        throw new Error("reasoning_content_present must be 0 or 1.");
      }
      const toolCalls =
        row.tool_calls_json === null
          ? undefined
          : decodeStoredToolCalls(
              stringFromSql(row.tool_calls_json, "tool_calls_json"),
            );
      return immutableRecord({
        ...base,
        role,
        turnId: stringFromSql(row.turn_id, "turn_id") as TurnId,
        iterationId: stringFromSql(row.iteration_id, "iteration_id") as IterationId,
        content,
        ...(reasoningPresent === 0
          ? {}
          : {
              reasoningContent: nullableTextFromSql(
                row.reasoning_content,
                "reasoning_content",
              ),
            }),
        ...(toolCalls === undefined ? {} : { toolCalls }),
        provider: stringFromSql(row.provider, "provider"),
        model: stringFromSql(row.model, "model"),
        origin: "model",
      });
    }
    case "tool":
      return immutableRecord({
        ...base,
        role,
        turnId: stringFromSql(row.turn_id, "turn_id") as TurnId,
        iterationId: stringFromSql(row.iteration_id, "iteration_id") as IterationId,
        toolCallId: stringFromSql(row.tool_call_id, "tool_call_id") as ToolCallId,
        providerToolCallId: stringFromSql(
          row.provider_tool_call_id,
          "provider_tool_call_id",
        ),
        name: stringFromSql(row.name, "name"),
        content: stringFromSql(row.content, "content"),
        origin: enumFromSql(row.origin, ["tool", "runtime"] as const, "tool origin"),
      });
  }
}

function decodeToolResult(rowValue: unknown): ToolResultRecord {
  const row = recordFromSql(rowValue, "tool result");
  const kind = enumFromSql(
    row.completion_kind,
    ["returned", "synthetic"] as const,
    "completion kind",
  );
  let completion: ToolCompletion;
  if (kind === "returned") {
    completion = immutableRecord({
      kind,
      raw: decodeStoredToolRawResult(
        parseJson(stringFromSql(row.raw_json, "raw_json"), "raw_json"),
      ),
      rawSha256: stringFromSql(row.raw_sha256, "raw_sha256"),
      observationFormat: enumFromSql(
        row.observation_format,
        SUPPORTED_TOOL_OBSERVATION_FORMATS,
        "observation format",
      ),
    });
  } else {
    const reason = enumFromSql(
      row.synthetic_reason,
      [
        "cancelled_active",
        "skipped_after_cancel",
        "failed_active",
        "skipped_after_failure",
        "interrupted_active",
        "skipped_after_interruption",
      ] as const,
      "synthetic reason",
    );
    completion = immutableRecord({
      kind,
      reason,
      ...(row.synthetic_detail === null
        ? {}
        : {
            detail: stringFromSql(row.synthetic_detail, "synthetic_detail"),
          }),
    });
  }
  return immutableRecord({
    sessionId: stringFromSql(row.session_id, "session_id") as SessionId,
    frameId: stringFromSql(row.frame_id, "frame_id") as ProtocolFrameId,
    toolCallId: stringFromSql(row.tool_call_id, "tool_call_id") as ToolCallId,
    toolMessageId: stringFromSql(row.tool_message_id, "tool_message_id") as MessageId,
    completion,
    observationSha256: stringFromSql(row.observation_sha256, "observation_sha256"),
    createdAt: timestampFromSql(row.created_at, "created_at"),
  });
}

function decodeContextSurface(rowValue: unknown): StoredContextSurfaceV8 {
  const row = recordFromSql(rowValue, "context surface");
  const projectInstruction =
    row.project_instruction_json === null
      ? undefined
      : decodeProjectInstructionManifest(
          parseJson(
            stringFromSql(row.project_instruction_json, "project_instruction_json"),
            "project_instruction_json",
          ),
        );
  const toolDefinitions = decodeToolDefinitions(
    parseJson(
      stringFromSql(row.tool_definitions_json, "tool_definitions_json"),
      "tool_definitions_json",
    ),
  );
  const skillCatalog = decodeSkillCatalogManifest(
    parseJson(
      stringFromSql(row.skill_catalog_json, "skill_catalog_json"),
      "skill_catalog_json",
    ),
  );
  const activeSkills = decodeActiveSkillsManifest(
    parseJson(
      stringFromSql(row.active_skills_json, "active_skills_json"),
      "active_skills_json",
    ),
  );
  const surface = Object.freeze({
    surfaceId: stringFromSql(row.surface_id, "surface_id") as ContextSurfaceId,
    sessionId: stringFromSql(row.session_id, "session_id") as SessionId,
    systemPrompt: stringFromSql(row.system_prompt, "system_prompt"),
    systemPromptSha256: sha256FromSql(row.system_prompt_sha256, "system_prompt_sha256"),
    recallContractVersion: enumFromSql(
      row.recall_contract_version,
      SUPPORTED_RECALL_RETIREMENT_CONTRACT_VERSIONS,
      "recall_contract_version",
    ),
    ...(projectInstruction === undefined ? {} : { projectInstruction }),
    skillCatalog,
    skillCatalogSha256: sha256FromSql(row.skill_catalog_sha256, "skill_catalog_sha256"),
    activeSkills,
    activeSkillsSha256: sha256FromSql(row.active_skills_sha256, "active_skills_sha256"),
    toolDefinitions,
    toolDefinitionsSha256: sha256FromSql(
      row.tool_definitions_sha256,
      "tool_definitions_sha256",
    ),
    toolSchemaSha256: sha256FromSql(row.tool_schema_sha256, "tool_schema_sha256"),
    requestConfigSha256: sha256FromSql(
      row.request_config_sha256,
      "request_config_sha256",
    ),
    requestMaxOutputTokens: numberFromSql(
      row.request_max_output_tokens,
      "request_max_output_tokens",
    ),
    surfaceSha256: sha256FromSql(row.surface_sha256, "surface_sha256"),
    createdAt: timestampFromSql(row.created_at, "created_at"),
  });
  validateStoredContextSurface(surface);
  return surface;
}

function decodeContextRevision(rowValue: unknown): StoredContextRevisionV8 {
  const row = recordFromSql(rowValue, "context revision");
  const kind = enumFromSql(
    row.kind,
    [
      "initial_full",
      "swap_only",
      "surface_refresh",
      "prefix_retirement",
      "skills_update",
    ] as const,
    "context revision kind",
  );
  const common = {
    revisionId: stringFromSql(row.revision_id, "revision_id") as ContextRevisionId,
    sessionId: stringFromSql(row.session_id, "session_id") as SessionId,
    surfaceId: stringFromSql(row.surface_id, "surface_id") as ContextSurfaceId,
    surfaceSha256: sha256FromSql(row.surface_sha256, "surface_sha256"),
    keepFromOrdinal: numberFromSql(row.keep_from_ordinal, "keep_from_ordinal"),
    sourceThroughOrdinal: numberFromSql(
      row.source_through_ordinal,
      "source_through_ordinal",
    ),
    addedOverrideCount: numberFromSql(row.added_override_count, "added_override_count"),
    activeOverrideCount: numberFromSql(
      row.active_override_count,
      "active_override_count",
    ),
    activeOverrideManifestSha256: sha256FromSql(
      row.active_override_manifest_sha256,
      "active_override_manifest_sha256",
    ),
    canonicalSequenceSha256: sha256FromSql(
      row.canonical_sequence_sha256,
      "canonical_sequence_sha256",
    ),
    renderedMessageSha256: sha256FromSql(
      row.rendered_message_sha256,
      "rendered_message_sha256",
    ),
    createdAt: timestampFromSql(row.created_at, "created_at"),
  };
  if (common.keepFromOrdinal < 1) {
    throw new Error("Context revision keep_from_ordinal must be positive.");
  }
  const revisionNumber = numberFromSql(row.revision_number, "revision_number");
  const parentRevisionId = nullableStringFromSql(
    row.parent_revision_id,
    "parent_revision_id",
  ) as ContextRevisionId | null;
  if (kind === "initial_full") {
    if (
      revisionNumber !== 1 ||
      parentRevisionId !== null ||
      common.sourceThroughOrdinal !== 1 ||
      common.addedOverrideCount !== 0 ||
      common.activeOverrideCount !== 0 ||
      common.keepFromOrdinal !== 1 ||
      row.policy_version !== null ||
      row.renderer_format !== null ||
      row.plan_sha256 !== null ||
      row.change_manifest_sha256 !== null ||
      row.activation_manifest_sha256 !== null ||
      !hasNoRetirementFields(row)
    ) {
      throw new Error("Initial context revision row is invalid.");
    }
    return Object.freeze({
      ...common,
      revisionNumber: 1,
      parentRevisionId: null,
      kind,
      keepFromOrdinal: 1,
      sourceThroughOrdinal: 1,
      addedOverrideCount: 0,
      activeOverrideCount: 0,
    });
  }
  if (
    kind === "swap_only" &&
    (revisionNumber < 2 ||
      parentRevisionId === null ||
      common.addedOverrideCount < 1 ||
      common.activeOverrideCount < common.addedOverrideCount)
  ) {
    throw new Error("Swap context revision row is invalid.");
  }
  if (kind === "swap_only") {
    if (
      row.change_manifest_sha256 !== null ||
      row.activation_manifest_sha256 !== null ||
      !hasNoRetirementFields(row)
    ) {
      throw new Error("Swap context revision has a change manifest.");
    }
    return Object.freeze({
      ...common,
      revisionNumber,
      parentRevisionId: parentRevisionId!,
      kind,
      policyVersion: enumFromSql(
        row.policy_version,
        ["swap-only-v1"] as const,
        "context revision policy",
      ),
      rendererFormat: enumFromSql(
        row.renderer_format,
        [SWAP_OBSERVATION_FORMAT] as const,
        "context revision renderer format",
      ),
      planSha256: sha256FromSql(row.plan_sha256, "plan_sha256"),
    });
  }
  if (kind === "skills_update") {
    if (
      revisionNumber < 2 ||
      parentRevisionId === null ||
      common.addedOverrideCount < 1 ||
      common.activeOverrideCount < common.addedOverrideCount ||
      row.plan_sha256 !== null ||
      !hasNoRetirementFields(row)
    ) {
      throw new Error("Agent Skills context revision row is invalid.");
    }
    return Object.freeze({
      ...common,
      revisionNumber,
      parentRevisionId,
      kind,
      policyVersion: enumFromSql(
        row.policy_version,
        [SKILL_POLICY_VERSION] as const,
        "Agent Skills context revision policy",
      ),
      rendererFormat: enumFromSql(
        row.renderer_format,
        [SKILL_ACTIVATION_RECEIPT_FORMAT] as const,
        "Agent Skills context revision renderer format",
      ),
      changeManifestSha256: sha256FromSql(
        row.change_manifest_sha256,
        "change_manifest_sha256",
      ),
      activationManifestSha256: sha256FromSql(
        row.activation_manifest_sha256,
        "activation_manifest_sha256",
      ),
    });
  }
  if (kind === "prefix_retirement") {
    const retiredThroughOrdinal = numberFromSql(
      row.retired_through_ordinal,
      "retired_through_ordinal",
    );
    const retiredTurnCount = numberFromSql(
      row.retired_turn_count,
      "retired_turn_count",
    );
    const retiredFrameCount = numberFromSql(
      row.retired_frame_count,
      "retired_frame_count",
    );
    const retiredMessageCount = numberFromSql(
      row.retired_message_count,
      "retired_message_count",
    );
    if (
      revisionNumber < 2 ||
      parentRevisionId === null ||
      common.keepFromOrdinal <= 1 ||
      common.addedOverrideCount !== 0 ||
      retiredThroughOrdinal !== common.keepFromOrdinal - 1 ||
      retiredTurnCount < 1 ||
      retiredFrameCount < 1 ||
      retiredMessageCount < 1 ||
      row.renderer_format !== null ||
      row.change_manifest_sha256 !== null ||
      row.activation_manifest_sha256 !== null
    ) {
      throw new Error("Prefix retirement revision row is invalid.");
    }
    return Object.freeze({
      ...common,
      revisionNumber,
      parentRevisionId,
      kind,
      addedOverrideCount: 0,
      policyVersion: enumFromSql(
        row.policy_version,
        ["recall-first-retirement-v1"] as const,
        "context revision policy",
      ),
      planSha256: sha256FromSql(row.plan_sha256, "plan_sha256"),
      retiredThroughOrdinal,
      retiredTurnCount,
      retiredFrameCount,
      retiredMessageCount,
    });
  }
  if (
    revisionNumber < 2 ||
    parentRevisionId === null ||
    common.addedOverrideCount !== 0 ||
    row.policy_version !== null ||
    row.renderer_format !== null ||
    row.plan_sha256 !== null ||
    row.activation_manifest_sha256 !== null ||
    !hasNoRetirementFields(row)
  ) {
    throw new Error("Surface context revision row is invalid.");
  }
  return Object.freeze({
    ...common,
    revisionNumber,
    parentRevisionId,
    kind,
    addedOverrideCount: 0,
    changeManifestSha256: sha256FromSql(
      row.change_manifest_sha256,
      "change_manifest_sha256",
    ),
  });
}

function hasNoRetirementFields(row: Record<string, unknown>): boolean {
  return (
    row.retired_through_ordinal === null &&
    row.retired_turn_count === null &&
    row.retired_frame_count === null &&
    row.retired_message_count === null
  );
}

function decodeStoredSwapOverride(rowValue: unknown): StoredContextOverrideV8 {
  const row = recordFromSql(rowValue, "context override");
  if (row.representation !== "swapped") {
    throw new Error("Context override representation must be swapped.");
  }
  return Object.freeze({
    introducedRevisionId: stringFromSql(
      row.introduced_revision_id,
      "introduced_revision_id",
    ) as ContextRevisionId,
    frameId: stringFromSql(row.frame_id, "frame_id") as ProtocolFrameId,
    messageId: stringFromSql(row.message_id, "message_id") as MessageId,
    ordinal: numberFromSql(row.ordinal, "ordinal"),
    rendererFormat: enumFromSql(
      row.renderer_format,
      [SWAP_OBSERVATION_FORMAT, SKILL_ACTIVATION_RECEIPT_FORMAT] as const,
      "context override renderer format",
    ),
    source: stringFromSql(row.source, "source") as StoredContextOverrideV8["source"],
    originalContentSha256: sha256FromSql(
      row.original_content_sha256,
      "original_content_sha256",
    ),
    renderedContent: stringFromSql(row.rendered_content, "rendered_content"),
    renderedContentSha256: sha256FromSql(
      row.rendered_content_sha256,
      "rendered_content_sha256",
    ),
    originalBytes: numberFromSql(row.original_bytes, "original_bytes"),
    renderedBytes: numberFromSql(row.rendered_bytes, "rendered_bytes"),
    byteSavings: numberFromSql(row.byte_savings, "byte_savings"),
    createdAt: timestampFromSql(row.created_at, "created_at"),
  });
}

function stripStoredOverride(override: StoredContextOverrideV8): SwapOverride {
  return Object.freeze({
    frameId: override.frameId,
    messageId: override.messageId,
    ordinal: override.ordinal,
    source: override.source,
    originalContentSha256: override.originalContentSha256,
    renderedContent: override.renderedContent,
    renderedContentSha256: override.renderedContentSha256,
    originalBytes: override.originalBytes,
    renderedBytes: override.renderedBytes,
    byteSavings: override.byteSavings,
    ...(override.rendererFormat === SWAP_OBSERVATION_FORMAT
      ? {}
      : { rendererFormat: override.rendererFormat }),
  });
}

function decodeSkillActivation(rowValue: unknown): StoredSkillActivation {
  const row = recordFromSql(rowValue, "skill activation");
  const state = enumFromSql(
    row.state,
    ["pending", "dispatched", "promoted", "rejected"] as const,
    "skill activation state",
  );
  const dispatchedIterationId = nullableStringFromSql(
    row.dispatched_iteration_id,
    "dispatched_iteration_id",
  ) as IterationId | null;
  const settledRevisionId = nullableStringFromSql(
    row.settled_revision_id,
    "settled_revision_id",
  ) as ContextRevisionId | null;
  const rejectionReason = nullableStringFromSql(
    row.rejection_reason,
    "rejection_reason",
  );
  if (
    (state === "pending" &&
      (dispatchedIterationId !== null ||
        settledRevisionId !== null ||
        rejectionReason !== null)) ||
    (state === "dispatched" &&
      (dispatchedIterationId === null ||
        settledRevisionId !== null ||
        rejectionReason !== null)) ||
    (state === "promoted" &&
      (dispatchedIterationId === null ||
        settledRevisionId === null ||
        rejectionReason !== null)) ||
    (state === "rejected" &&
      (settledRevisionId === null ||
        rejectionReason === null ||
        rejectionReason.trim() === ""))
  ) {
    throw new Error("Skill activation lifecycle fields are invalid.");
  }
  return Object.freeze({
    activationMessageId: stringFromSql(
      row.activation_message_id,
      "activation_message_id",
    ) as MessageId,
    toolCallId: stringFromSql(row.tool_call_id, "tool_call_id") as ToolCallId,
    sessionId: stringFromSql(row.session_id, "session_id") as SessionId,
    name: stringFromSql(row.name, "skill activation name"),
    scope: enumFromSql(
      row.scope,
      ["project", "user"] as const,
      "skill activation scope",
    ),
    skillFileSha256: sha256FromSql(row.skill_file_sha256, "skill_file_sha256"),
    state,
    ...(dispatchedIterationId === null ? {} : { dispatchedIterationId }),
    ...(settledRevisionId === null ? {} : { settledRevisionId }),
    ...(rejectionReason === null ? {} : { rejectionReason }),
    createdAt: timestampFromSql(row.created_at, "created_at"),
    updatedAt: timestampFromSql(row.updated_at, "updated_at"),
  });
}

function protocolPrefixView(
  canonical: ProtocolContextView,
  throughOrdinal: number,
): ProtocolContextView {
  const messages = canonical.messages.filter(
    (message) => message.ordinal <= throughOrdinal,
  );
  const messageIds = new Set(messages.map((message) => message.messageId));
  return Object.freeze({
    sessionId: canonical.sessionId,
    faulted: false,
    frames: Object.freeze(
      canonical.frames.filter(
        (frame) =>
          frame.state === "closed" &&
          frame.lastOrdinal !== undefined &&
          frame.lastOrdinal <= throughOrdinal,
      ),
    ),
    messages: Object.freeze(messages),
    toolResults: Object.freeze(
      canonical.toolResults.filter((result) => messageIds.has(result.toolMessageId)),
    ),
  });
}

export function decodeStoredToolCalls(json: string): readonly ToolCall[] {
  const value = parseJson(json, "tool_calls_json");
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("tool_calls_json must contain a non-empty array.");
  }
  const calls = value.map((entry, index): ToolCall => {
    const call = recordFromSql(entry, `tool call ${index}`);
    assertObjectKeys(
      call,
      [
        "args",
        "argsParseError",
        "iterationId",
        "iterationNumber",
        "name",
        "providerToolCallId",
        "rawArgs",
        "sessionId",
        "toolCallId",
        "toolCallNumber",
        "turnId",
        "turnNumber",
      ],
      [
        "args",
        "iterationId",
        "iterationNumber",
        "name",
        "providerToolCallId",
        "sessionId",
        "toolCallId",
        "toolCallNumber",
        "turnId",
        "turnNumber",
      ],
      `tool call ${index}`,
    );
    const toolCallNumber = numberFromJson(call.toolCallNumber, "toolCallNumber");
    return {
      sessionId: stringFromSql(call.sessionId, "sessionId") as SessionId,
      turnId: stringFromSql(call.turnId, "turnId") as TurnId,
      turnNumber: numberFromJson(call.turnNumber, "turnNumber"),
      iterationId: stringFromSql(call.iterationId, "iterationId") as IterationId,
      iterationNumber: numberFromJson(call.iterationNumber, "iterationNumber"),
      toolCallId: stringFromSql(call.toolCallId, "toolCallId") as ToolCallId,
      toolCallNumber,
      providerToolCallId: stringFromSql(call.providerToolCallId, "providerToolCallId"),
      name: stringFromSql(call.name, "name"),
      args: immutableCanonicalClone(call.args),
      ...(call.rawArgs === undefined
        ? {}
        : { rawArgs: stringFromSql(call.rawArgs, "rawArgs") }),
      ...(call.argsParseError === undefined
        ? {}
        : {
            argsParseError: stringFromSql(call.argsParseError, "argsParseError"),
          }),
    };
  });
  return Object.freeze(calls);
}

function decodeProjectInstructionManifest(value: unknown): ProjectInstructionManifest {
  const record = recordFromSql(value, "project instruction manifest");
  assertObjectKeys(
    record,
    ["path", "byteLength", "sha256"],
    ["path", "byteLength", "sha256"],
    "project instruction manifest",
  );
  return Object.freeze({
    path: enumFromSql(
      record.path,
      ["AGENTS.md", "CLAUDE.md"] as const,
      "project instruction path",
    ),
    byteLength: numberFromJson(record.byteLength, "project instruction byteLength"),
    sha256: sha256FromSql(record.sha256, "project instruction sha256"),
  });
}

function decodeSkillCatalogManifest(
  value: unknown,
): readonly SkillCatalogManifestEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("skill_catalog_json must contain an array.");
  }
  return Object.freeze(
    value.map((entry, index) => {
      const record = recordFromSql(entry, `skill catalog entry ${index}`);
      assertObjectKeys(
        record,
        [
          "name",
          "scope",
          "directorySha256",
          "descriptionSha256",
          "skillFileSha256",
          "byteLength",
        ],
        [
          "name",
          "scope",
          "directorySha256",
          "descriptionSha256",
          "skillFileSha256",
          "byteLength",
        ],
        `skill catalog entry ${index}`,
      );
      return Object.freeze({
        name: stringFromSql(record.name, "skill name"),
        scope: enumFromSql(record.scope, ["project", "user"] as const, "skill scope"),
        directorySha256: sha256FromSql(record.directorySha256, "skill directorySha256"),
        descriptionSha256: sha256FromSql(
          record.descriptionSha256,
          "skill descriptionSha256",
        ),
        skillFileSha256: sha256FromSql(record.skillFileSha256, "skill skillFileSha256"),
        byteLength: numberFromJson(record.byteLength, "skill byteLength"),
      });
    }),
  );
}

function decodeActiveSkillsManifest(
  value: unknown,
): readonly ActiveSkillManifestEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("active_skills_json must contain an array.");
  }
  return Object.freeze(
    value.map((entry, index) => {
      const record = recordFromSql(entry, `active skill entry ${index}`);
      assertObjectKeys(
        record,
        [
          "name",
          "scope",
          "directorySha256",
          "descriptionSha256",
          "skillFileSha256",
          "byteLength",
          "activationMessageId",
        ],
        [
          "name",
          "scope",
          "directorySha256",
          "descriptionSha256",
          "skillFileSha256",
          "byteLength",
          "activationMessageId",
        ],
        `active skill entry ${index}`,
      );
      const [catalogEntry] = decodeSkillCatalogManifest([
        {
          name: record.name,
          scope: record.scope,
          directorySha256: record.directorySha256,
          descriptionSha256: record.descriptionSha256,
          skillFileSha256: record.skillFileSha256,
          byteLength: record.byteLength,
        },
      ]);
      if (catalogEntry === undefined) {
        throw new Error(`Active skill entry ${index} is missing.`);
      }
      return Object.freeze({
        ...catalogEntry,
        activationMessageId: stringFromSql(
          record.activationMessageId,
          "skill activationMessageId",
        ) as MessageId,
      });
    }),
  );
}

function decodeToolDefinitions(value: unknown): readonly ToolDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error("tool_definitions_json must contain an array.");
  }
  const definitions = value.map((entry, index): ToolDefinition => {
    const record = recordFromSql(entry, `tool definition ${index}`);
    assertObjectKeys(
      record,
      ["name", "description", "parameters"],
      ["name", "description", "parameters"],
      `tool definition ${index}`,
    );
    const parameters = recordFromSql(
      record.parameters,
      `tool definition ${index} parameters`,
    );
    return Object.freeze({
      name: stringFromSql(record.name, `tool definition ${index} name`),
      description: stringFromSql(
        record.description,
        `tool definition ${index} description`,
      ),
      parameters: immutableCanonicalClone(parameters),
    });
  });
  return Object.freeze(definitions);
}

export function decodeStoredToolRawResult(value: unknown): ToolRawResult {
  const raw = recordFromSql(value, "tool raw result");
  const kind = enumFromSql(
    raw.kind,
    [
      "read",
      "write",
      "edit",
      "glob",
      "grep",
      "bash",
      "task_list",
      "task_output",
      "task_stop",
      "web_search",
      "web_fetch",
      "recall",
      "skill",
      "mcp",
      "generic",
    ] as const,
    "tool raw result kind",
  );
  if (typeof raw.ok !== "boolean") {
    throw new Error("tool raw result ok must be a boolean.");
  }
  if (kind === "skill") {
    return decodeStoredSkillRawResult(raw);
  }
  return immutableCanonicalClone(raw) as ToolRawResult;
}

function decodeStoredSkillRawResult(
  raw: Record<string, unknown>,
): Extract<ToolRawResult, { kind: "skill" }> {
  const status = enumFromSql(
    raw.status,
    ["loaded", "already_loaded", "already_active", "failed"] as const,
    "Skill raw result status",
  );
  const name = stringFromSql(raw.name, "Skill raw result name");
  if (status === "failed") {
    if (raw.ok !== false) {
      throw new Error("Failed Skill raw result must have ok=false.");
    }
    assertObjectKeys(
      raw,
      ["kind", "ok", "status", "name", "errorCode", "error"],
      ["kind", "ok", "status", "name", "errorCode", "error"],
      "failed Skill raw result",
    );
    const errorCode = stringFromSql(raw.errorCode, "Skill errorCode");
    const error = stringFromSql(raw.error, "Skill error");
    if (
      (name !== "" && !isValidSkillName(name)) ||
      !/^[A-Z][A-Z0-9_]{0,79}$/.test(errorCode) ||
      error.trim() === ""
    ) {
      throw new Error("Failed Skill raw result fields are invalid.");
    }
    return immutableRecord({
      kind: "skill" as const,
      ok: false as const,
      status,
      name,
      errorCode,
      error,
    });
  }
  if (raw.ok !== true) {
    throw new Error("Successful Skill raw result must have ok=true.");
  }
  const scope = enumFromSql(
    raw.scope,
    ["project", "user"] as const,
    "Skill raw result scope",
  );
  const skillFileSha256 = sha256FromSql(raw.sha256, "Skill raw result sha256");
  if (!isValidSkillName(name)) {
    throw new Error("Successful Skill raw result name is invalid.");
  }
  if (status === "already_loaded") {
    assertObjectKeys(
      raw,
      ["kind", "ok", "status", "name", "scope", "lifecycle", "sha256"],
      ["kind", "ok", "status", "name", "scope", "lifecycle", "sha256"],
      "already loaded Skill raw result",
    );
    return immutableRecord({
      kind: "skill" as const,
      ok: true as const,
      status,
      name,
      scope,
      lifecycle: enumFromSql(
        raw.lifecycle,
        ["pending", "dispatched"] as const,
        "Skill lifecycle",
      ),
      sha256: skillFileSha256,
    });
  }
  if (status === "already_active") {
    assertObjectKeys(
      raw,
      ["kind", "ok", "status", "name", "scope", "sha256"],
      ["kind", "ok", "status", "name", "scope", "sha256"],
      "already active Skill raw result",
    );
    return immutableRecord({
      kind: "skill" as const,
      ok: true as const,
      status,
      name,
      scope,
      sha256: skillFileSha256,
    });
  }
  assertObjectKeys(
    raw,
    [
      "kind",
      "ok",
      "status",
      "name",
      "scope",
      "directory",
      "skillFilePath",
      "content",
      "byteLength",
      "sha256",
      "resources",
      "resourcesTruncated",
    ],
    [
      "kind",
      "ok",
      "status",
      "name",
      "scope",
      "directory",
      "skillFilePath",
      "content",
      "byteLength",
      "sha256",
      "resources",
      "resourcesTruncated",
    ],
    "loaded Skill raw result",
  );
  if (
    !Array.isArray(raw.resources) ||
    raw.resources.some((entry) => typeof entry !== "string") ||
    raw.resources.length > SKILL_RESOURCE_MAX_ENTRIES ||
    typeof raw.resourcesTruncated !== "boolean"
  ) {
    throw new Error("Loaded Skill resource manifest is invalid.");
  }
  const directory = stringFromSql(raw.directory, "Skill directory");
  const skillFilePath = stringFromSql(raw.skillFilePath, "Skill file path");
  const content = stringFromSql(raw.content, "Skill content");
  const byteLength = numberFromJson(raw.byteLength, "Skill byteLength");
  const resources = raw.resources as string[];
  if (
    !path.isAbsolute(directory) ||
    !path.isAbsolute(skillFilePath) ||
    !isPathWithin(directory, skillFilePath) ||
    byteLength < 1 ||
    byteLength > SKILL_FILE_MAX_BYTES ||
    Buffer.byteLength(content, "utf8") !== byteLength ||
    sha256(content) !== skillFileSha256 ||
    !isValidResourceManifest(resources)
  ) {
    throw new Error("Loaded Skill raw result snapshot is invalid.");
  }
  return immutableRecord({
    kind: "skill" as const,
    ok: true as const,
    status,
    name,
    scope,
    directory,
    skillFilePath,
    content,
    byteLength,
    sha256: skillFileSha256,
    resources: Object.freeze([...resources]),
    resourcesTruncated: raw.resourcesTruncated,
  });
}

function isValidSkillName(value: string): boolean {
  return value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isValidResourceManifest(resources: readonly string[]): boolean {
  let previous: string | undefined;
  for (const resource of resources) {
    const parts = resource.split("/");
    if (
      resource === "" ||
      resource.includes("\\") ||
      path.posix.isAbsolute(resource) ||
      path.posix.normalize(resource) !== resource ||
      !["assets", "references", "scripts"].includes(parts[0] ?? "") ||
      parts.length < 2 ||
      parts.length > SKILL_RESOURCE_MAX_DEPTH + 1 ||
      (previous !== undefined && previous >= resource)
    ) {
      return false;
    }
    previous = resource;
  }
  return true;
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

function requireActiveRevisionId(meta: StoredSessionMetaV8): ContextRevisionId {
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

function decodeMeta(value: unknown, expectedSessionId: SessionId): StoredSessionMetaV8 {
  const row = recordFromSql(value, "session metadata");
  const sessionId = stringFromSql(row.session_id, "session_id") as SessionId;
  if (sessionId !== expectedSessionId) {
    throw new Error(`Metadata session ID ${sessionId} does not match directory.`);
  }
  const schemaVersion = numberFromSql(row.schema_version, "schema_version");
  if (schemaVersion !== 8) {
    throw new Error(
      `Session metadata schema version must be 8; received ${schemaVersion}.`,
    );
  }
  const projectInstructionFile = nullableStringFromSql(
    row.project_instruction_file,
    "project_instruction_file",
  );
  const projectInstructionByteLength = nullableNumberFromSql(
    row.project_instruction_byte_length,
    "project_instruction_byte_length",
  );
  const projectInstructionSha256 = nullableStringFromSql(
    row.project_instruction_sha256,
    "project_instruction_sha256",
  );
  if (
    (projectInstructionFile === null) !== (projectInstructionByteLength === null) ||
    (projectInstructionFile === null) !== (projectInstructionSha256 === null)
  ) {
    throw new Error("Project instruction metadata must be entirely set or null.");
  }
  if (
    projectInstructionFile !== null &&
    projectInstructionFile !== "AGENTS.md" &&
    projectInstructionFile !== "CLAUDE.md"
  ) {
    throw new Error(`Invalid project instruction file ${projectInstructionFile}.`);
  }
  const projectInstruction: ProjectInstructionManifest | undefined =
    projectInstructionFile === null ||
    projectInstructionByteLength === null ||
    projectInstructionSha256 === null
      ? undefined
      : {
          path: projectInstructionFile === "AGENTS.md" ? "AGENTS.md" : "CLAUDE.md",
          byteLength: projectInstructionByteLength,
          sha256: sha256FromSql(projectInstructionSha256, "project_instruction_sha256"),
        };
  const initializationState = enumFromSql(
    row.initialization_state,
    ["creating", "ready"] as const,
    "initialization_state",
  );
  const sessionCompatibilityJson = nullableStringFromSql(
    row.session_compatibility_json,
    "session_compatibility_json",
  );
  const sessionCompatibilitySha256 = nullableStringFromSql(
    row.session_compatibility_sha256,
    "session_compatibility_sha256",
  );
  const activeRevisionId = nullableStringFromSql(
    row.active_revision_id,
    "active_revision_id",
  ) as ContextRevisionId | null;
  const modelName = stringFromSql(row.model_name, "model_name");
  const storedContract =
    sessionCompatibilityJson === null
      ? undefined
      : decodeSessionCompatibilityContract(sessionCompatibilityJson);
  if (
    (sessionCompatibilityJson === null) !== (sessionCompatibilitySha256 === null) ||
    (sessionCompatibilityJson !== null &&
      sha256(sessionCompatibilityJson) !== sessionCompatibilitySha256) ||
    (initializationState === "creating") !== (activeRevisionId === null) ||
    (initializationState === "creating") !== (sessionCompatibilityJson === null) ||
    (storedContract !== undefined &&
      (storedContract.modelName !== modelName ||
        stableJsonStringify(storedContract) !== sessionCompatibilityJson))
  ) {
    throw new Error("Session compatibility or initialization metadata is invalid.");
  }
  return {
    schemaVersion,
    schemaFingerprint: stringFromSql(row.schema_fingerprint, "schema_fingerprint"),
    initializationState,
    sessionId,
    workspaceRoot: stringFromSql(row.workspace_root, "workspace_root"),
    modelName,
    systemPromptSha256: stringFromSql(row.system_prompt_sha256, "system_prompt_sha256"),
    ...(projectInstruction === undefined ? {} : { projectInstruction }),
    sessionCompatibilityJson,
    sessionCompatibilitySha256,
    activeRevisionId,
    nextTurnNumber: numberFromSql(row.next_turn_number, "next_turn_number"),
    nextEventSequence: numberFromSql(row.next_event_sequence, "next_event_sequence"),
    openCount: numberFromSql(row.open_count, "open_count"),
    createdAt: timestampFromSql(row.created_at, "created_at"),
    updatedAt: timestampFromSql(row.updated_at, "updated_at"),
    lastOpenedAt: timestampFromSql(row.last_opened_at, "last_opened_at"),
    lastClosedAt:
      row.last_closed_at === null
        ? null
        : timestampFromSql(row.last_closed_at, "last_closed_at"),
    lastCloseReason:
      row.last_close_reason === null
        ? null
        : enumFromSql(
            row.last_close_reason,
            [
              "oneshot_complete",
              "tui_exit",
              "session_switch",
              "runner_failed",
              "initialization_failed",
            ] as const,
            "last_close_reason",
          ),
  };
}

function compatibilityContractDifferences(
  storedJson: string | null,
  current: SessionCompatibilityContract,
): string[] {
  if (storedJson === null) {
    return ["sessionCompatibility"];
  }
  const stored = parseJson(storedJson, "session_compatibility_json");
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return ["sessionCompatibility"];
  }
  const record = stored as Record<string, unknown>;
  const fields: readonly (keyof SessionCompatibilityContract)[] = [
    "modelName",
    "profileName",
    "includeReasoningContent",
    "contextProfile",
    "messageProtocol",
  ];
  return fields.filter((key) => {
    const storedValue = record[key];
    const currentValue = current[key];
    if (storedValue === undefined || currentValue === undefined) {
      return storedValue !== currentValue;
    }
    return stableJsonStringify(storedValue) !== stableJsonStringify(currentValue);
  });
}

function decodeSessionCompatibilityContract(
  json: string,
): SessionCompatibilityContract {
  const record = recordFromSql(
    parseJson(json, "session_compatibility_json"),
    "session compatibility contract",
  );
  assertObjectKeys(
    record,
    [
      "modelName",
      "profileName",
      "includeReasoningContent",
      "contextProfile",
      "messageProtocol",
    ],
    ["modelName", "includeReasoningContent", "contextProfile", "messageProtocol"],
    "session compatibility contract",
  );
  const contextProfile = recordFromSql(
    record.contextProfile,
    "session compatibility context profile",
  );
  assertObjectKeys(
    contextProfile,
    ["contextWindowTokens", "maxSupportedOutputTokens"],
    ["contextWindowTokens", "maxSupportedOutputTokens"],
    "session compatibility context profile",
  );
  const messageProtocol = recordFromSql(
    record.messageProtocol,
    "session compatibility message protocol",
  );
  assertObjectKeys(
    messageProtocol,
    ["adapter", "serializationVersion"],
    ["adapter", "serializationVersion"],
    "session compatibility message protocol",
  );
  if (typeof record.includeReasoningContent !== "boolean") {
    throw new Error("Session compatibility reasoning replay flag must be boolean.");
  }
  return createSessionCompatibilityContract({
    modelName: stringFromSql(record.modelName, "compatibility modelName"),
    ...(record.profileName === undefined
      ? {}
      : {
          profileName: stringFromSql(record.profileName, "compatibility profileName"),
        }),
    includeReasoningContent: record.includeReasoningContent,
    contextProfile: {
      contextWindowTokens: numberFromJson(
        contextProfile.contextWindowTokens,
        "compatibility contextWindowTokens",
      ),
      maxSupportedOutputTokens: numberFromJson(
        contextProfile.maxSupportedOutputTokens,
        "compatibility maxSupportedOutputTokens",
      ),
    },
    messageProtocol: {
      adapter: enumFromSql(
        messageProtocol.adapter,
        ["openai-chat", "fake"] as const,
        "compatibility message adapter",
      ),
      serializationVersion: stringFromSql(
        messageProtocol.serializationVersion,
        "compatibility serializationVersion",
      ),
    },
  });
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

const SESSION_SCOPED_TABLES = [
  "session_meta",
  "turns",
  "iterations",
  "protocol_frames",
  "messages",
  "tool_results",
  "context_surfaces",
  "context_revisions",
  "context_overrides",
  "skill_activations",
  "context_measurement_state",
] as const;

function rekeyStoredToolCalls(database: Database, targetSessionId: SessionId): void {
  const rows = database
    .query(
      `SELECT message_id, tool_calls_json FROM messages
       WHERE tool_calls_json IS NOT NULL ORDER BY ordinal`,
    )
    .all() as Array<{ message_id: string; tool_calls_json: string }>;
  for (const row of rows) {
    const calls = decodeStoredToolCalls(row.tool_calls_json).map((call) => ({
      ...call,
      sessionId: targetSessionId,
    }));
    database
      .query("UPDATE messages SET tool_calls_json = ? WHERE message_id = ?")
      .run(stableJsonStringify(calls), row.message_id);
  }
}

function rekeyProtocolView(
  source: ProtocolContextView,
  targetSessionId: SessionId,
): ProtocolContextView {
  return {
    sessionId: targetSessionId,
    faulted: source.faulted,
    frames: source.frames.map((frame) => ({
      ...frame,
      sessionId: targetSessionId,
    })),
    messages: source.messages.map((message) => ({
      ...message,
      sessionId: targetSessionId,
      ...(message.role === "assistant" && message.toolCalls !== undefined
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              ...call,
              sessionId: targetSessionId,
            })),
          }
        : {}),
    })),
    toolResults: source.toolResults.map((result) => ({
      ...result,
      sessionId: targetSessionId,
    })),
  };
}

function rewriteCloneRevisionHashes(
  database: Database,
  canonical: ProtocolContextView,
): void {
  const surfaces = database
    .query("SELECT * FROM context_surfaces")
    .all()
    .map(decodeContextSurface);
  const surfacesById = new Map(surfaces.map((surface) => [surface.surfaceId, surface]));
  const revisions = database
    .query("SELECT * FROM context_revisions ORDER BY revision_number")
    .all()
    .map(decodeContextRevision);
  const revisionNumberById = new Map(
    revisions.map((revision) => [revision.revisionId, revision.revisionNumber]),
  );
  const overrides = database
    .query(
      `SELECT co.* FROM context_overrides co
       JOIN context_revisions cr ON cr.revision_id = co.introduced_revision_id
       ORDER BY cr.revision_number, co.ordinal`,
    )
    .all()
    .map(decodeStoredSwapOverride);
  const compiler = new ContextRevisionCompiler();
  for (const revision of revisions) {
    const surface = surfacesById.get(revision.surfaceId);
    if (surface === undefined) {
      throw new Error(`Cloned revision ${revision.revisionId} has no surface.`);
    }
    const activeOverrides = overrides.filter(
      (override) =>
        (revisionNumberById.get(override.introducedRevisionId) ??
          Number.POSITIVE_INFINITY) <= revision.revisionNumber &&
        override.ordinal >= revision.keepFromOrdinal,
    );
    const prefix = protocolPrefixView(canonical, revision.sourceThroughOrdinal);
    const compiled = compiler.compileForIdentityRekey({
      canonical: prefix,
      revisionId: revision.revisionId,
      activeOverrides,
      keepFromOrdinal: revision.keepFromOrdinal,
      surface,
    });
    database
      .query(
        `UPDATE context_revisions
         SET canonical_sequence_sha256 = ?, rendered_message_sha256 = ?
         WHERE revision_id = ?`,
      )
      .run(
        canonicalSequenceHash(canonical, revision.sourceThroughOrdinal),
        renderedMessageHash(compiled.entries, revision.sourceThroughOrdinal),
        revision.revisionId,
      );
  }
}

async function cloneDiagnosticFiles(input: {
  sourceDirectory: string;
  stagingDirectory: string;
  sourceSessionId: SessionId;
  targetSessionId: SessionId;
  nextEventSequence: number;
  faultInjector?: (stage: CloneSessionFaultStage) => void;
}): Promise<void> {
  const sourcePath = path.join(input.sourceDirectory, "events.jsonl");
  try {
    await lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  await validateSecureFile(sourcePath, input.sourceSessionId);

  const bytes = await readFile(sourcePath);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const rawLines = text.split("\n");
  if (rawLines.at(-1) === "") {
    rawLines.pop();
  }
  const events: AgentEvent[] = [];
  let previousSequence = 0;
  for (const [index, line] of rawLines.entries()) {
    if (line === "") {
      throw new Error(`Session event log contains an empty line at ${index + 1}.`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Session event log has invalid JSON at line ${index + 1}.`, {
        cause: error,
      });
    }
    if (!isEventEnvelope(value)) {
      throw new Error(
        `Session event log has an invalid envelope at line ${index + 1}.`,
      );
    }
    if (value.sessionId !== input.sourceSessionId) {
      throw new Error(`Session event log identity changed at line ${index + 1}.`);
    }
    if (value.eventSequence <= previousSequence) {
      throw new Error(
        `Session event sequence is not strictly increasing at line ${index + 1}.`,
      );
    }
    if (value.eventSequence >= input.nextEventSequence) {
      throw new Error(
        `Session event sequence exceeds the canonical next counter at line ${index + 1}.`,
      );
    }
    previousSequence = value.eventSequence;
    events.push({ ...value, sessionId: input.targetSessionId });
  }

  const eventText = events.map((event) => JSON.stringify(event)).join("\n");
  await writePrivateNewFile(
    path.join(input.stagingDirectory, "events.jsonl"),
    eventText === "" ? "" : `${eventText}\n`,
  );
  input.faultInjector?.("after_event_rewrite");
  const observationText = events
    .map((event) => renderObservationLogEvent(event))
    .filter((block): block is string => block !== undefined)
    .join("");
  await writePrivateNewFile(
    path.join(input.stagingDirectory, "observations.md"),
    observationText,
  );
  input.faultInjector?.("after_observation_render");
}

function isEventEnvelope(value: unknown): value is AgentEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    Number.isSafeInteger(record.eventSequence) &&
    Number(record.eventSequence) >= 1 &&
    typeof record.timestamp === "string" &&
    typeof record.type === "string" &&
    record.data !== null &&
    typeof record.data === "object"
  );
}

async function writePrivateNewFile(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
}

async function assertPathMissing(
  filePath: string,
  sessionId: SessionId,
): Promise<void> {
  try {
    await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new SessionError(
    "SESSION_ALREADY_EXISTS",
    "clone_session",
    `Session directory already exists: ${filePath}.`,
    { sessionId },
  );
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new Error("Session workspace root must be absolute.");
  }
  return realpath(workspaceRoot);
}

async function ensureSessionsRoot(workspaceRoot: string): Promise<string> {
  const tinkerRoot = path.join(workspaceRoot, ".tinker");
  const sessionsRoot = path.join(tinkerRoot, "sessions");
  await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  await validateSessionsRoot(sessionsRoot);
  await chmod(tinkerRoot, 0o700);
  await chmod(sessionsRoot, 0o700);
  return sessionsRoot;
}

async function validateSessionsRoot(
  sessionsRoot: string,
  sessionId?: SessionId,
): Promise<void> {
  const tinkerRoot = path.dirname(sessionsRoot);
  for (const directory of [tinkerRoot, sessionsRoot]) {
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SessionError(
          "SESSION_STORE_NOT_FOUND",
          "validate_session_root",
          `Session root does not exist: ${directory}.`,
          { sessionId, cause: error },
        );
      }
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new SessionError(
        "SESSION_PERMISSION_INVALID",
        "validate_session_root",
        `Session root must not be a symlink: ${directory}.`,
        { sessionId },
      );
    }
  }
  if ((await realpath(sessionsRoot)) !== sessionsRoot) {
    throw new SessionError(
      "SESSION_PERMISSION_INVALID",
      "validate_session_root",
      `Session root resolves outside its canonical path: ${sessionsRoot}.`,
      { sessionId },
    );
  }
}

function safeSessionDirectory(sessionsRoot: string, sessionId: SessionId): string {
  const value = String(sessionId);
  if (
    value.trim() === "" ||
    value !== value.trim() ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new SessionError(
      "SESSION_ID_INVALID",
      "resolve_session_path",
      `Unsafe session ID: ${JSON.stringify(value)}.`,
      { sessionId },
    );
  }
  const directory = path.join(sessionsRoot, value);
  if (path.dirname(directory) !== sessionsRoot) {
    throw new SessionError(
      "SESSION_ID_INVALID",
      "resolve_session_path",
      `Session ID escapes the sessions directory: ${JSON.stringify(value)}.`,
      { sessionId },
    );
  }
  return directory;
}

async function validateSecureDirectory(
  directory: string,
  sessionId: SessionId,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionError(
        "SESSION_STORE_NOT_FOUND",
        "open_session",
        `Session directory does not exist: ${directory}.`,
        { sessionId, cause: error },
      );
    }
    throw error;
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid())
  ) {
    throw new SessionError(
      "SESSION_PERMISSION_INVALID",
      "open_session",
      `Session directory must be an owner-only real directory: ${directory}.`,
      { sessionId },
    );
  }
}

async function validateSecureFile(
  filePath: string,
  sessionId: SessionId,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionError(
        "SESSION_STORE_NOT_FOUND",
        "open_session",
        `Session database does not exist: ${filePath}.`,
        { sessionId, cause: error },
      );
    }
    throw error;
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid())
  ) {
    throw new SessionError(
      "SESSION_PERMISSION_INVALID",
      "open_session",
      `Session database must be an owner-only regular file: ${filePath}.`,
      { sessionId },
    );
  }
}

async function validateSecureOptionalFile(
  filePath: string,
  sessionId: SessionId,
): Promise<void> {
  try {
    await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  await validateSecureFile(filePath, sessionId);
}

async function removeKnownInitializationFiles(sessionDirectory: string): Promise<void> {
  for (const name of [
    "session.sqlite-wal",
    "session.sqlite-shm",
    "session.sqlite",
    "events.jsonl",
    "observations.md",
    "active.lock.reclaim",
    "active.lock",
  ]) {
    await unlinkIfExists(path.join(sessionDirectory, name));
  }
  try {
    await rmdir(sessionDirectory);
  } catch (error) {
    if (
      !new Set(["ENOENT", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")
    ) {
      throw error;
    }
  }
}

async function chmodIfExists(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
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

function recordFromSql(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertObjectKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  name: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  const missing = required.filter((key) => !(key in record));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${name} has invalid keys; unknown=${unknown.join(",") || "none"} missing=${missing.join(",") || "none"}.`,
    );
  }
}

function stringFromSql(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function sha256FromSql(value: unknown, name: string): string {
  const hash = stringFromSql(value, name);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest.`);
  }
  return hash;
}

function assertMeasuredContextAnchor(anchor: MeasuredContextAnchor): void {
  for (const [name, value] of [
    ["promptTokens", anchor.promptTokens],
    ["completionTokens", anchor.completionTokens],
    ["totalTokens", anchor.totalTokens],
    ["segmentCount", anchor.segmentCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `Measured context anchor ${name} must be a non-negative safe integer; received ${value}.`,
      );
    }
  }
  if (anchor.totalTokens !== anchor.promptTokens + anchor.completionTokens) {
    throw new Error(
      "Measured context anchor totalTokens must equal promptTokens + completionTokens.",
    );
  }
  for (const [name, value] of [
    ["prefixHash", anchor.prefixHash],
    ["requestConfigHash", anchor.requestConfigHash],
    ["toolSchemaHash", anchor.toolSchemaHash],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`Measured context anchor ${name} must be a SHA-256 digest.`);
    }
  }
}

function nullableStringFromSql(value: unknown, name: string): string | null {
  return value === null ? null : stringFromSql(value, name);
}

function nullableTextFromSql(value: unknown, name: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string or null.`);
  }
  return value;
}

function numberFromSql(value: unknown, name: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${name} must be a safe non-negative integer.`);
  }
  return number;
}

function nullableNumberFromSql(value: unknown, name: string): number | null {
  return value === null ? null : numberFromSql(value, name);
}

function numberFromJson(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value as number;
}

function enumFromSql<const T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${name} has unsupported value ${JSON.stringify(value)}.`);
  }
  return value;
}

function timestampFromSql(value: unknown, name: string): string {
  return timestampValue(stringFromSql(value, name), name);
}

function timestampValue(value: string, name: string): string {
  if (Number.isNaN(Date.parse(value)) || !value.endsWith("Z")) {
    throw new Error(`${name} must be a UTC ISO-8601 timestamp.`);
  }
  return value;
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} is not valid JSON.`, { cause: error });
  }
}

function requireItem<T>(items: readonly T[], index: number, name: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Missing ${name} at index ${index}.`);
  }
  return item;
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
