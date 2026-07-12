import path from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  open,
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
  IterationId,
  MessageId,
  ProtocolFrameId,
  RuntimeIdFactory,
  SessionId,
  ToolCallId,
  TurnId,
} from "../ids/runtime-id";
import type {
  ModelContextBudget,
  ModelContextProfile,
} from "../model/model-context-profile";
import type { ToolRawResult } from "../tools/types";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import {
  ContextProtocolError,
  ContextProtocolValidator,
} from "../context/context-protocol-validator";
import {
  TOOL_OBSERVATION_FORMAT,
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
import type { IterationIdentity, ToolCall } from "../agent/types";
import {
  InMemorySessionLedger,
  type LedgerMutation,
  type SessionLedgerCommitter,
} from "../agent/session-ledger";
import { SessionError, sessionOpenError, sessionWriteError } from "./session-errors";
import { SessionLease } from "./session-lock";
import {
  SESSION_SCHEMA_V1_FINGERPRINT,
  SESSION_SCHEMA_VERSION,
  configureWritableDatabase,
  createSessionSchema,
  verifySessionSchema,
  verifySqliteIntegrity,
} from "./session-schema";

export type RuntimeContractV1 = {
  version: 1;
  modelName: string;
  includeReasoningContent: boolean;
  contextProfile: ModelContextProfile;
  contextBudget: ModelContextBudget;
  systemPromptSha256: string;
  toolSchemaSha256: string;
  requestConfigSha256: string;
  observationFormat: typeof TOOL_OBSERVATION_FORMAT;
};

export type StoredSessionMetaV1 = {
  schemaVersion: 1;
  schemaFingerprint: string;
  initializationState: "creating" | "ready";
  sessionId: SessionId;
  workspaceRoot: string;
  modelName: string;
  systemPromptSha256: string;
  toolSchemaSha256: string | null;
  runtimeContractJson: string | null;
  runtimeContractSha256: string | null;
  activeRevisionId: ContextRevisionId;
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

export type SessionCloseReason = NonNullable<StoredSessionMetaV1["lastCloseReason"]>;

export type SessionRecoveryResult = {
  recoveredTurnId?: TurnId;
  recoveredFrameId?: ProtocolFrameId;
  syntheticCompletionCount: number;
};

export type CreateNewSessionStoreInput = {
  workspaceRoot: string;
  sessionId: SessionId;
  modelName: string;
  systemPrompt: string;
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
      const revisionId = input.idFactory.createContextRevisionId();
      runTransaction(database, () => {
        database!
          .query(
            `INSERT INTO session_meta (
            singleton, schema_version, schema_fingerprint, initialization_state,
            session_id, workspace_root, model_name, system_prompt_sha256,
            tool_schema_sha256, runtime_contract_json, runtime_contract_sha256,
            active_revision_id, next_turn_number, next_event_sequence, open_count,
            created_at, updated_at, last_opened_at, last_closed_at, last_close_reason
          ) VALUES (1, ?, ?, 'creating', ?, ?, ?, ?, NULL, NULL, NULL, ?, 1, 1, 1, ?, ?, ?, NULL, NULL)`,
          )
          .run(
            SESSION_SCHEMA_VERSION,
            SESSION_SCHEMA_V1_FINGERPRINT,
            input.sessionId,
            workspaceRoot,
            input.modelName,
            sha256(input.systemPrompt),
            revisionId,
            createdAt,
            createdAt,
            createdAt,
          );
        insertFrame(database!, requireItem(initialView.frames, 0, "system frame"));
        insertMessage(
          database!,
          requireItem(initialView.messages, 0, "system message"),
        );
        database!
          .query(
            `INSERT INTO context_revisions (
            revision_id, session_id, revision_number, kind, keep_from_ordinal, created_at
          ) VALUES (?, ?, 1, 'initial_full', 1, ?)`,
          )
          .run(revisionId, input.sessionId, createdAt);
      });

      const store = new SessionStore(database, lease, {
        sessionId: input.sessionId,
        workspaceRoot,
        sessionDirectory,
        databasePath,
        clock,
      });
      await store.correctDatabaseModes();
      store.validateAll({ allowOpenTail: false });
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
      store.validateAll({ allowOpenTail: true });
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
        requireSingleChange(updated.changes, "advance iteration counter");
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
        requireSingleChange(updated.changes, "finish continuing iteration");
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
        requireSingleChange(updated.changes, "advance event sequence");
        return sequence;
      });
    } catch (error) {
      throw sessionWriteError("allocate_event_sequence", this.sessionId, error);
    }
  }

  finalizeRuntimeContract(contract: RuntimeContractV1): void {
    this.requireOpen();
    const json = stableJsonStringify(contract);
    const contractSha256 = sha256(json);
    const now = this.clock();
    try {
      runTransaction(this.database, () => {
        const updated = this.database
          .query(
            `UPDATE session_meta
           SET initialization_state = 'ready', tool_schema_sha256 = ?,
               runtime_contract_json = ?, runtime_contract_sha256 = ?, updated_at = ?
           WHERE singleton = 1 AND initialization_state = 'creating'
             AND runtime_contract_json IS NULL`,
          )
          .run(contract.toolSchemaSha256, json, contractSha256, now);
        requireSingleChange(updated.changes, "finalize runtime contract");
      });
    } catch (error) {
      throw sessionWriteError("finalize_runtime_contract", this.sessionId, error);
    }
  }

  assertRuntimeContract(contract: RuntimeContractV1): void {
    const meta = this.readMeta();
    const current = stableJsonStringify(contract);
    const currentHash = sha256(current);
    if (
      meta.runtimeContractJson !== current ||
      meta.runtimeContractSha256 !== currentHash
    ) {
      const changed = runtimeContractDifferences(meta.runtimeContractJson, contract);
      throw new SessionError(
        "SESSION_RUNTIME_MISMATCH",
        "compare_runtime_contract",
        `Session runtime contract changed: ${changed.join(", ") || "stored contract is invalid"}.`,
        { sessionId: this.sessionId },
      );
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
        requireSingleChange(updated.changes, "increment open count");
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
      return { syntheticCompletionCount: 0 };
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
      return { recoveredTurnId: turnId, syntheticCompletionCount: 0 };
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
        requireSingleChange(frameUpdate.changes, "close recovered frame");
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
    };
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

  readMeta(): StoredSessionMetaV1 {
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

  nextTurnNumber(): number {
    return this.readMeta().nextTurnNumber;
  }

  validateAll(options: { allowOpenTail: boolean }): ProtocolContextView {
    const meta = this.readMeta();
    if (
      meta.sessionId !== this.sessionId ||
      meta.schemaFingerprint !== SESSION_SCHEMA_V1_FINGERPRINT
    ) {
      throw new SessionError(
        "SESSION_SCHEMA_INVALID",
        "validate_store",
        "Session metadata identity or schema fingerprint does not match.",
        { sessionId: this.sessionId },
      );
    }
    const view = this.loadProtocolView();
    try {
      this.validator.validate(view, {
        allowOpenTail: options.allowOpenTail,
        fullIntegrity: true,
      });
      this.validateInitialRevision(meta);
      this.validateCounters(meta, view);
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
    return view;
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
        requireSingleChange(updated.changes, "close session activation");
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
    requireSingleChange(updated.changes, "advance turn counter");
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
      requireSingleChange(updated.changes, "advance tool call counter");
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
      insertMessage(
        this.database,
        requireItem(mutation.messages, index, "tool message"),
      );
      insertToolResult(
        this.database,
        requireItem(mutation.toolResults, index, "tool result"),
      );
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
      requireSingleChange(updated.changes, "close tool exchange frame");
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
    requireSingleChange(iteration.changes, "finish iteration");
    const turn = this.database
      .query(
        `UPDATE turns SET status = ?, last_iteration_id = ?, final_message_id = ?,
         terminal_detail_json = ?, finished_at = ?
       WHERE turn_id = ? AND status = 'open'`,
      )
      .run(turnStatus, iterationId, finalMessageId, terminalDetailJson, now, turnId);
    requireSingleChange(turn.changes, "finish turn");
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
          requireSingleChange(iteration.changes, "interrupt iteration");
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
        requireSingleChange(turn.changes, "interrupt turn");
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

  private validateInitialRevision(meta: StoredSessionMetaV1): void {
    const rows = this.database.query("SELECT * FROM context_revisions").all() as Array<
      Record<string, unknown>
    >;
    if (rows.length !== 1) {
      throw new Error(`Expected one initial context revision; found ${rows.length}.`);
    }
    const row = rows[0];
    if (
      stringFromSql(row.revision_id, "revision_id") !== meta.activeRevisionId ||
      numberFromSql(row.revision_number, "revision_number") !== 1 ||
      row.kind !== "initial_full" ||
      numberFromSql(row.keep_from_ordinal, "keep_from_ordinal") !== 1 ||
      row.session_id !== this.sessionId
    ) {
      throw new Error("Initial context revision invariant failed.");
    }
  }

  private validateCounters(meta: StoredSessionMetaV1, view: ProtocolContextView): void {
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
    requireSingleChange(updated.changes, "touch session");
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

export function createRuntimeContract(input: {
  modelName: string;
  includeReasoningContent: boolean;
  contextProfile: ModelContextProfile;
  contextBudget: ModelContextBudget;
  systemPrompt: string;
  toolSchemaSha256: string;
  requestConfigSha256: string;
}): RuntimeContractV1 {
  return Object.freeze({
    version: 1,
    modelName: input.modelName,
    includeReasoningContent: input.includeReasoningContent,
    contextProfile: immutableCanonicalClone(input.contextProfile),
    contextBudget: immutableCanonicalClone(input.contextBudget),
    systemPromptSha256: sha256(input.systemPrompt),
    toolSchemaSha256: input.toolSchemaSha256,
    requestConfigSha256: input.requestConfigSha256,
    observationFormat: TOOL_OBSERVATION_FORMAT,
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
        [TOOL_OBSERVATION_FORMAT] as const,
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

export function decodeStoredToolRawResult(value: unknown): ToolRawResult {
  const raw = recordFromSql(value, "tool raw result");
  enumFromSql(
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
      "mcp",
      "generic",
    ] as const,
    "tool raw result kind",
  );
  if (typeof raw.ok !== "boolean") {
    throw new Error("tool raw result ok must be a boolean.");
  }
  return immutableCanonicalClone(raw) as ToolRawResult;
}

function decodeMeta(value: unknown, expectedSessionId: SessionId): StoredSessionMetaV1 {
  const row = recordFromSql(value, "session metadata");
  const sessionId = stringFromSql(row.session_id, "session_id") as SessionId;
  if (sessionId !== expectedSessionId) {
    throw new Error(`Metadata session ID ${sessionId} does not match directory.`);
  }
  return {
    schemaVersion: numberFromSql(row.schema_version, "schema_version") as 1,
    schemaFingerprint: stringFromSql(row.schema_fingerprint, "schema_fingerprint"),
    initializationState: enumFromSql(
      row.initialization_state,
      ["creating", "ready"] as const,
      "initialization_state",
    ),
    sessionId,
    workspaceRoot: stringFromSql(row.workspace_root, "workspace_root"),
    modelName: stringFromSql(row.model_name, "model_name"),
    systemPromptSha256: stringFromSql(row.system_prompt_sha256, "system_prompt_sha256"),
    toolSchemaSha256: nullableStringFromSql(
      row.tool_schema_sha256,
      "tool_schema_sha256",
    ),
    runtimeContractJson: nullableStringFromSql(
      row.runtime_contract_json,
      "runtime_contract_json",
    ),
    runtimeContractSha256: nullableStringFromSql(
      row.runtime_contract_sha256,
      "runtime_contract_sha256",
    ),
    activeRevisionId: stringFromSql(
      row.active_revision_id,
      "active_revision_id",
    ) as ContextRevisionId,
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

function runtimeContractDifferences(
  storedJson: string | null,
  current: RuntimeContractV1,
): string[] {
  if (storedJson === null) {
    return ["runtimeContract"];
  }
  const stored = parseJson(storedJson, "runtime_contract_json");
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return ["runtimeContract"];
  }
  const record = stored as Record<string, unknown>;
  return Object.keys(current).filter(
    (key) =>
      stableJsonStringify(record[key]) !==
      stableJsonStringify(current[key as keyof RuntimeContractV1]),
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

function requireSingleChange(changes: number | bigint, operation: string): void {
  if (Number(changes) !== 1) {
    throw new Error(`${operation} must change exactly one row; changed ${changes}.`);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
