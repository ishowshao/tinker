import type { Database } from "bun:sqlite";
import {
  canonicalToolResultContentHash,
  toolResultDisplayText,
} from "../agent/tool-result-content";
import { ContextProtocolValidator } from "../context/context-protocol-validator";
import {
  immutableRecord,
  interruptedCompletionInputs,
  observationForCompletion,
  type CanonicalMessageRecord,
  type ProtocolContextView,
  type ProtocolFrame,
  type ToolCompletion,
  type ToolResultRecord,
} from "../context/protocol-frame";
import type {
  IterationId,
  RuntimeIdFactory,
  SessionId,
  TurnId,
} from "../ids/runtime-id";
import { stableJsonStringify } from "../model/model-request-preflight";
import { SessionError } from "./session-errors";
import type { SessionStore } from "./session-store";
import { type SessionRecoveryResult } from "./session-store-contracts";
import type { SessionStoreLedgerWriter } from "./session-store-ledger-writer";
import { insertMessage, insertToolResult } from "./session-store-record-writer";
import { requireItem, requireSingleChange, runTransaction } from "./session-store-sql";

/** Repairs only the interrupted canonical tail before the session is resumed. */
export class SessionStoreRecovery {
  private readonly validator = new ContextProtocolValidator();
  constructor(
    private readonly database: Database,
    private readonly sessionId: SessionId,
    private readonly clock: () => string,
    private readonly requireOpen: () => void,
    private readonly ledgerWriter: Pick<
      SessionStoreLedgerWriter,
      "markOpenTurnInterrupted" | "markTerminalRows"
    >,
    private readonly store: Pick<SessionStore, "loadProtocolView" | "validateAll">,
  ) {}

  recoverInterruptedState(
    idFactory: RuntimeIdFactory,
    recallIndexRebuilt: boolean,
  ): SessionRecoveryResult {
    this.requireOpen();
    const view = this.store.loadProtocolView();
    const openTurns = this.database
      .query("SELECT turn_id FROM turns WHERE status = 'open' ORDER BY turn_number")
      .all() as Array<{ turn_id: string }>;
    const openFrames = view.frames.filter((frame) => frame.state === "open");
    if (openTurns.length === 0 && openFrames.length === 0) {
      return {
        syntheticCompletionCount: 0,
        recallIndexRebuilt,
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
      this.ledgerWriter.markOpenTurnInterrupted(
        turnId,
        openIterations[0]?.iteration_id as IterationId | undefined,
      );
      this.store.validateAll({ allowOpenTail: false });
      return {
        recoveredTurnId: turnId,
        syntheticCompletionCount: 0,
        recallIndexRebuilt,
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
        this.ledgerWriter.markTerminalRows(
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
    this.store.validateAll({ allowOpenTail: false });
    return {
      recoveredTurnId: turnId,
      recoveredFrameId: frame.frameId,
      syntheticCompletionCount: messages.length,
      recallIndexRebuilt,
    };
  }

  private recoveryError(message: string): SessionError {
    return new SessionError("SESSION_RECOVERY_FAILED", "recover_session", message, {
      sessionId: this.sessionId,
    });
  }
}
