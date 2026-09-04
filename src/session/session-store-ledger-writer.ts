import type { Database } from "bun:sqlite";
import { AdmissionStaleError, type LedgerMutation } from "../agent/session-ledger";
import type { IterationId, MessageId, SessionId, TurnId } from "../ids/runtime-id";
import { stableJsonStringify } from "../model/model-request-preflight";
import { SessionError, sessionWriteError } from "./session-errors";
import type { SessionStore } from "./session-store";
import {
  insertFrame,
  insertMessage,
  insertPendingSkillActivation,
  insertToolResult,
} from "./session-store-record-writer";
import { requireItem, requireSingleChange, runTransaction } from "./session-store-sql";
import { numberFromSql } from "./session-store-value-codecs";

/** Writes canonical ledger mutations using the session's existing connection. */
export class SessionStoreLedgerWriter {
  constructor(
    private readonly database: Database,
    private readonly sessionId: SessionId,
    private readonly clock: () => string,
    private readonly requireOpen: () => void,
    private readonly store: Pick<SessionStore, "readMeta" | "loadContextSnapshot">,
  ) {}

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

  private commitBeginTurn(
    mutation: Extract<LedgerMutation, { kind: "begin_turn" }>,
    now: string,
  ): void {
    const meta = this.store.readMeta();
    if (mutation.admissionBase !== undefined) {
      const snapshot = this.store.loadContextSnapshot();
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

  markTerminalRows(
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

  markOpenTurnInterrupted(turnId: TurnId, iterationId: IterationId | undefined): void {
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

  requireTurnRow(turnId: TurnId): Record<string, unknown> {
    const row = this.database
      .query("SELECT * FROM turns WHERE turn_id = ?")
      .get(turnId) as Record<string, unknown> | null;
    if (row === null) {
      throw new Error(`Unknown turn ${turnId}.`);
    }
    return row;
  }

  requireIterationRow(iterationId: IterationId): Record<string, unknown> {
    const row = this.database
      .query("SELECT * FROM iterations WHERE iteration_id = ?")
      .get(iterationId) as Record<string, unknown> | null;
    if (row === null) {
      throw new Error(`Unknown iteration ${iterationId}.`);
    }
    return row;
  }

  touch(timestamp: string): void {
    const updated = this.database
      .query("UPDATE session_meta SET updated_at = ? WHERE singleton = 1")
      .run(timestamp);
    requireSingleChange(this.database, updated.changes, "touch session");
  }
}
