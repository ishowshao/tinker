import type {
  ContextRevisionId,
  MessageId,
  RuntimeIdFactory,
  SessionId,
  ToolCallId,
} from "../ids/runtime-id";
import type { ToolDefinition } from "../tools/types";
import type {
  BuiltContextRequest,
  StoredContextRevisionV8,
  StoredContextSnapshotV8,
  StoredContextOverrideV8,
} from "../context/context-revision";
import {
  createContextSurface,
  type StoredContextSurfaceV8,
} from "../context/context-surface";
import {
  ContextRevisionCompiler,
  createInitialContextRevision,
} from "../context/context-revision-compiler";
import {
  ContextProtocolError,
  ContextProtocolValidator,
} from "../context/context-protocol-validator";
import {
  CURRENT_TOOL_OBSERVATION_FORMAT,
  contentHash,
  immutableCanonicalClone,
  immutableRecord,
  observationForCompletion,
  rawResultHash,
  userMessageHash,
  type CanonicalMessageRecord,
  type ProtocolContextView,
  type ProtocolFrame,
  type ToolCompletion,
  type ToolCompletionInput,
  type ToolResultRecord,
} from "../context/protocol-frame";
import { ContextBuilder } from "./context-builder";
import { CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION } from "../context/recall-retirement-contract";
import type {
  AssistantMessage,
  IterationIdentity,
  RunAgentResult,
  ToolCall,
  TurnIdentity,
  UserMessage,
} from "./types";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import { validateUserMessage } from "../image/image-types";

export type SessionLedger = {
  beginTurn(input: {
    turn: TurnIdentity;
    userMessage: UserMessage;
    admissionBase?: AdmissionBaseToken;
  }): PendingLedgerTurn;
  buildCommittedModelRequest(tools: readonly ToolDefinition[]): BuiltContextRequest;
  buildCandidateModelRequest(
    userMessage: UserMessage,
    tools: readonly ToolDefinition[],
  ): BuiltContextRequest;
  committedMessageCount(): number;
  snapshot(options?: {
    fullIntegrity?: boolean;
    allowOpenTail?: boolean;
    allowFaulted?: boolean;
  }): ProtocolContextView;
  fault(error: unknown): void;
};

export type AdmissionBaseToken = {
  readonly canonicalMessageCount: number;
  readonly canonicalHeadMessageId: MessageId;
  readonly canonicalHeadContentSha256: string;
  readonly activeRevisionId: ContextRevisionId;
  readonly activeRevisionNumber: number;
  readonly surfaceSha256: string;
  readonly sessionCompatibilitySha256: string;
  readonly nextTurnNumber: number;
};

export class AdmissionStaleError extends Error {
  readonly code = "ADMISSION_STALE";

  constructor() {
    super("Turn admission became stale before commit; the Prompt was not accepted.");
    this.name = "AdmissionStaleError";
  }
}

export type PendingLedgerTurn = {
  readonly agent: AgentTurnLedger;
  projectedMessageCount(): number;
  finish(result: RunAgentResult): void;
  fault(error: unknown): void;
};

export type AgentTurnLedger = {
  appendAssistant(input: {
    iteration: IterationIdentity;
    message: AssistantMessage;
    provider: string;
    model: string;
  }): void;
  assertCanExecuteTool(call: ToolCall): void;
  commitToolCompletions(
    completions: readonly ToolCompletionInput[],
  ): readonly CommittedToolCompletion[];
  buildModelRequest(tools: readonly ToolDefinition[]): BuiltContextRequest;
};

export type CommittedToolCompletion = {
  readonly toolCallId: ToolCallId;
  readonly toolMessageId: MessageId;
  readonly ordinal: number;
};

export type LedgerMutation =
  | {
      kind: "begin_turn";
      turn: TurnIdentity;
      frame: ProtocolFrame;
      message: CanonicalMessageRecord;
      admissionBase?: AdmissionBaseToken;
      next: ProtocolContextView;
    }
  | {
      kind: "append_assistant";
      iteration: IterationIdentity;
      frame: ProtocolFrame;
      message: CanonicalMessageRecord;
      next: ProtocolContextView;
    }
  | {
      kind: "commit_tool_completions";
      frameBefore: ProtocolFrame;
      frameAfter: ProtocolFrame;
      messages: readonly CanonicalMessageRecord[];
      toolResults: readonly ToolResultRecord[];
      next: ProtocolContextView;
    }
  | {
      kind: "finish_turn";
      turn: TurnIdentity;
      result: RunAgentResult;
      finalMessageId?: CanonicalMessageRecord["messageId"];
      next: ProtocolContextView;
    };

export type SessionLedgerCommitter = {
  commit(mutation: LedgerMutation): void;
};

export class SessionLedgerWriteError extends Error {
  readonly operation: LedgerMutation["kind"];

  constructor(operation: LedgerMutation["kind"], options?: ErrorOptions) {
    super(`Session ledger ${operation} commit failed.`, options);
    this.name = "SessionLedgerWriteError";
    this.operation = operation;
  }
}

export type CreateInMemorySessionLedgerInput = {
  sessionId: SessionId;
  idFactory: RuntimeIdFactory;
  systemPrompt?: string;
  initialView?: ProtocolContextView;
  initialSnapshot?: StoredContextSnapshotV8;
  initialSurface?: StoredContextSurfaceV8;
  initialToolDefinitions?: readonly ToolDefinition[];
  initialRevisionId?: ContextRevisionId;
  contextBuilder?: ContextBuilder;
  revisionCompiler?: ContextRevisionCompiler;
  clock?: () => string;
  committer?: SessionLedgerCommitter;
};

type PendingState = "open" | "finished" | "faulted";

export class InMemorySessionLedger implements SessionLedger {
  private view: ProtocolContextView;
  private pending?: InMemoryPendingLedgerTurn;
  private readonly validator = new ContextProtocolValidator();
  private readonly contextBuilder: ContextBuilder;
  private readonly revisionCompiler: ContextRevisionCompiler;
  private readonly revision: StoredContextRevisionV8;
  private readonly surface: StoredContextSurfaceV8;
  private readonly activeOverrides: readonly StoredContextOverrideV8[];
  private readonly clock: () => string;

  constructor(private readonly input: CreateInMemorySessionLedgerInput) {
    this.contextBuilder = input.contextBuilder ?? new ContextBuilder();
    this.revisionCompiler = input.revisionCompiler ?? new ContextRevisionCompiler();
    this.clock = input.clock ?? (() => new Date().toISOString());
    const sourceCount = [
      input.systemPrompt,
      input.initialView,
      input.initialSnapshot,
    ].filter((value) => value !== undefined).length;
    if (sourceCount !== 1) {
      throw new Error("Session ledger requires exactly one canonical history source.");
    }
    if (input.initialSnapshot !== undefined) {
      if (input.initialRevisionId !== undefined) {
        throw new Error(
          "Session ledger cannot override the revision in an initial snapshot.",
        );
      }
      this.view = immutableView(input.initialSnapshot.canonical);
      this.revision = input.initialSnapshot.revision;
      this.surface = input.initialSnapshot.surface;
      this.activeOverrides = input.initialSnapshot.activeOverrides;
    } else {
      this.view =
        input.initialView === undefined
          ? createInitialView(
              input.sessionId,
              input.systemPrompt!,
              input.idFactory,
              this.clock,
            )
          : immutableView(input.initialView);
      const systemMessage = this.view.messages[0];
      if (systemMessage?.role !== "system") {
        throw new Error("Session ledger canonical history has no system message.");
      }
      this.surface =
        input.initialSurface ??
        createInMemoryContextSurface({
          sessionId: input.sessionId,
          systemPrompt: systemMessage.content,
          tools: input.initialToolDefinitions ?? [],
          idFactory: input.idFactory,
          createdAt: this.view.frames[0]?.createdAt ?? this.clock(),
        });
      this.revision = createInitialContextRevision({
        revisionId:
          input.initialRevisionId ?? input.idFactory.createContextRevisionId(),
        canonical: this.view,
        surface: this.surface,
        createdAt: this.view.frames[0]?.createdAt ?? this.clock(),
      });
      this.activeOverrides = Object.freeze([]);
    }
    if (
      this.view.sessionId !== input.sessionId ||
      this.revision.sessionId !== input.sessionId ||
      this.surface.sessionId !== input.sessionId
    ) {
      throw new Error("Session ledger history or revision belongs to another session.");
    }
    if (input.initialSnapshot === undefined) {
      this.validator.validate(this.view, {
        allowOpenTail: true,
        fullIntegrity: true,
      });
    }
  }

  beginTurn(input: {
    turn: TurnIdentity;
    userMessage: UserMessage;
    admissionBase?: AdmissionBaseToken;
  }): PendingLedgerTurn {
    this.requireHealthy("begin a turn");
    validateUserMessage(input.userMessage);
    if (input.turn.sessionId !== this.input.sessionId) {
      throw new Error(`Turn ${input.turn.turnId} belongs to another session.`);
    }
    if (this.pending !== undefined) {
      throw new Error("Cannot begin a ledger turn while another turn is open.");
    }
    this.assertNoOpenFrame();
    if (input.admissionBase !== undefined) {
      this.assertAdmissionBase(input.admissionBase, input.turn.turnNumber);
    }

    const createdAt = this.clock();
    const ordinal = this.view.messages.length + 1;
    const frameId = this.input.idFactory.createProtocolFrameId();
    const message = immutableRecord<CanonicalMessageRecord>({
      messageId: this.input.idFactory.createMessageId(),
      sessionId: this.input.sessionId,
      frameId,
      ordinal,
      contentSha256: userMessageHash(input.userMessage),
      createdAt,
      role: "user",
      turnId: input.turn.turnId,
      content: input.userMessage.content,
      ...(input.userMessage.attachments === undefined
        ? {}
        : {
            attachments: Object.freeze(
              immutableCanonicalClone(input.userMessage.attachments),
            ),
          }),
      origin: "user",
    });
    const frame = immutableRecord<ProtocolFrame>({
      frameId,
      sessionId: this.input.sessionId,
      turnId: input.turn.turnId,
      kind: "user",
      state: "closed",
      firstOrdinal: ordinal,
      lastOrdinal: ordinal,
      createdAt,
      closedAt: createdAt,
    });
    const next = appendView(this.view, [frame], [message], []);
    this.validator.validate(next, { fullIntegrity: true });
    this.commit({
      kind: "begin_turn",
      turn: input.turn,
      frame,
      message,
      ...(input.admissionBase === undefined
        ? {}
        : { admissionBase: input.admissionBase }),
      next,
    });

    const pending = new InMemoryPendingLedgerTurn(this, input.turn);
    this.pending = pending;
    return pending;
  }

  buildCommittedModelRequest(tools: readonly ToolDefinition[]): BuiltContextRequest {
    this.requireHealthy("build committed context");
    if (this.pending !== undefined) {
      throw new Error("Cannot build committed context while a turn is open.");
    }
    return this.buildRequest(tools);
  }

  buildCandidateModelRequest(
    userMessage: UserMessage,
    tools: readonly ToolDefinition[],
  ): BuiltContextRequest {
    this.requireHealthy("build candidate context");
    if (this.pending !== undefined) {
      throw new Error("Cannot build candidate context while a turn is open.");
    }
    return this.buildRequest(tools, userMessage);
  }

  committedMessageCount(): number {
    return this.view.messages.length;
  }

  snapshot(
    options: {
      fullIntegrity?: boolean;
      allowOpenTail?: boolean;
      allowFaulted?: boolean;
    } = {},
  ): ProtocolContextView {
    const validationView =
      options.allowFaulted === true && this.view.faulted
        ? { ...this.view, faulted: false }
        : this.view;
    this.validator.validate(validationView, {
      fullIntegrity: options.fullIntegrity,
      allowOpenTail: options.allowOpenTail,
    });
    return this.view;
  }

  fault(error?: unknown): void {
    void error;
    if (!this.view.faulted) {
      this.view = immutableView({ ...this.view, faulted: true });
    }
    this.pending?.markFaulted();
    this.pending = undefined;
  }

  appendAssistant(
    pending: InMemoryPendingLedgerTurn,
    input: {
      iteration: IterationIdentity;
      message: AssistantMessage;
      provider: string;
      model: string;
    },
  ): void {
    this.requirePending(pending, "append an assistant message");
    requireIterationInTurn(input.iteration, pending.turn);
    requireNonEmpty(input.provider, "assistant provider");
    requireNonEmpty(input.model, "assistant model");
    this.assertNoOpenFrame();

    const content = input.message.content ?? null;
    const toolCalls = normalizeToolCalls(input.message.toolCalls);
    if ((content === null || content.trim() === "") && toolCalls === undefined) {
      throw new ContextProtocolError(
        "invalid_assistant_frame",
        "Assistant message must contain non-empty text or tool calls.",
      );
    }
    const createdAt = this.clock();
    const ordinal = this.view.messages.length + 1;
    const frameId = this.input.idFactory.createProtocolFrameId();
    const message = immutableRecord<CanonicalMessageRecord>({
      messageId: this.input.idFactory.createMessageId(),
      sessionId: this.input.sessionId,
      frameId,
      ordinal,
      contentSha256: contentHash(content),
      createdAt,
      role: "assistant",
      turnId: pending.turn.turnId,
      iterationId: input.iteration.iterationId,
      content,
      ...(input.message.reasoningContent === undefined
        ? {}
        : { reasoningContent: input.message.reasoningContent }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
      provider: input.provider,
      model: input.model,
      origin: "model",
    });
    const frame = immutableRecord<ProtocolFrame>({
      frameId,
      sessionId: this.input.sessionId,
      turnId: pending.turn.turnId,
      iterationId: input.iteration.iterationId,
      kind: toolCalls === undefined ? "assistant_text" : "tool_exchange",
      state: toolCalls === undefined ? "closed" : "open",
      firstOrdinal: ordinal,
      ...(toolCalls === undefined ? { lastOrdinal: ordinal, closedAt: createdAt } : {}),
      createdAt,
    });
    const next = appendView(this.view, [frame], [message], []);
    this.validator.validate(next, {
      allowOpenTail: toolCalls !== undefined,
      fullIntegrity: true,
    });
    this.commit({
      kind: "append_assistant",
      iteration: input.iteration,
      frame,
      message,
      next,
    });
  }

  assertCanExecuteTool(pending: InMemoryPendingLedgerTurn, call: ToolCall): void {
    this.requirePending(pending, "execute a tool");
    const expected = this.expectedToolCall();
    if (expected === undefined) {
      throw new Error("Cannot execute a tool without an open tool exchange.");
    }
    assertSameToolCall(expected, call);
  }

  commitToolCompletions(
    pending: InMemoryPendingLedgerTurn,
    completions: readonly ToolCompletionInput[],
  ): readonly CommittedToolCompletion[] {
    this.requirePending(pending, "commit tool completions");
    if (completions.length === 0) {
      throw new Error("Tool completion batch must not be empty.");
    }
    const frameBefore = this.openFrame();
    const assistant = this.assistantForFrame(frameBefore);
    const calls = assistant.toolCalls!;
    const completedCount = this.messagesForFrame(frameBefore).length - 1;
    if (completedCount + completions.length > calls.length) {
      throw new Error(
        `Tool completion batch exceeds remaining calls in frame ${frameBefore.frameId}.`,
      );
    }

    const messages: CanonicalMessageRecord[] = [];
    const toolResults: ToolResultRecord[] = [];
    for (let index = 0; index < completions.length; index += 1) {
      const completionInput = requireItem(completions, index, "tool completion");
      const expectedCall = requireItem(
        calls,
        completedCount + index,
        "expected tool call",
      );
      assertSameToolCall(expectedCall, completionInput.call);
      validateCompletionInput(completionInput);
      const content = observationForCompletion(completionInput);
      const createdAt = this.clock();
      const messageId = this.input.idFactory.createMessageId();
      const message = immutableRecord<CanonicalMessageRecord>({
        messageId,
        sessionId: this.input.sessionId,
        frameId: frameBefore.frameId,
        ordinal: this.view.messages.length + messages.length + 1,
        contentSha256: contentHash(content),
        createdAt,
        role: "tool",
        turnId: pending.turn.turnId,
        iterationId: expectedCall.iterationId,
        toolCallId: expectedCall.toolCallId,
        providerToolCallId: expectedCall.providerToolCallId,
        name: expectedCall.name,
        content,
        origin: completionInput.kind === "returned" ? "tool" : "runtime",
      });
      const completion = canonicalCompletion(completionInput);
      const result = immutableRecord<ToolResultRecord>({
        sessionId: this.input.sessionId,
        frameId: frameBefore.frameId,
        toolCallId: expectedCall.toolCallId,
        toolMessageId: messageId,
        completion,
        observationSha256: contentHash(content),
        createdAt,
      });
      messages.push(message);
      toolResults.push(result);
    }

    const closesFrame = completedCount + completions.length === calls.length;
    const closedAt = closesFrame ? this.clock() : undefined;
    const frameAfter = immutableRecord<ProtocolFrame>({
      ...frameBefore,
      state: closesFrame ? "closed" : "open",
      ...(closesFrame
        ? {
            lastOrdinal: this.view.messages.length + messages.length,
            closedAt,
          }
        : {}),
    });
    const next = replaceFrameAndAppend(this.view, frameAfter, messages, toolResults);
    this.validator.validate(next, {
      allowOpenTail: !closesFrame,
      fullIntegrity: true,
    });
    this.commit({
      kind: "commit_tool_completions",
      frameBefore,
      frameAfter,
      messages: Object.freeze(messages),
      toolResults: Object.freeze(toolResults),
      next,
    });
    return Object.freeze(
      toolResults.map((result, index) => ({
        toolCallId: result.toolCallId,
        toolMessageId: result.toolMessageId,
        ordinal: requireItem(messages, index, "committed tool message").ordinal,
      })),
    );
  }

  buildTurnModelRequest(
    pending: InMemoryPendingLedgerTurn,
    tools: readonly ToolDefinition[],
  ): BuiltContextRequest {
    this.requirePending(pending, "build a model request");
    return this.buildRequest(tools);
  }

  finishTurn(pending: InMemoryPendingLedgerTurn, result: RunAgentResult): void {
    this.requirePending(pending, "finish a turn");
    this.assertNoOpenFrame();
    requireIterationInTurn(result.lastIteration, pending.turn);
    const finalMessage =
      result.status === "completed"
        ? [...this.view.messages]
            .reverse()
            .find(
              (message) =>
                message.role === "assistant" &&
                message.turnId === pending.turn.turnId &&
                (message.toolCalls?.length ?? 0) === 0,
            )
        : undefined;
    const mutation: LedgerMutation = {
      kind: "finish_turn",
      turn: pending.turn,
      result,
      ...(finalMessage === undefined ? {} : { finalMessageId: finalMessage.messageId }),
      next: this.view,
    };
    this.commit(mutation);
    pending.markFinished();
    this.pending = undefined;
  }

  faultTurn(pending: InMemoryPendingLedgerTurn, error: unknown): void {
    if (this.pending !== pending) {
      throw new Error("Cannot fault a turn: ledger turn ownership was lost.");
    }
    pending.requireOpen("fault a turn");
    pending.markFaulted();
    this.pending = undefined;
    this.fault(error);
  }

  private buildRequest(
    tools: readonly ToolDefinition[],
    candidateUserMessage?: UserMessage,
  ): BuiltContextRequest {
    try {
      const canonical = this.view;
      const compiled = this.revisionCompiler.compileActive(
        snapshotFor(canonical, this.revision, this.surface, this.activeOverrides),
      );
      return this.contextBuilder.build({
        canonical,
        revision: this.revision,
        surface: this.surface,
        activeOverrides: this.activeOverrides,
        compiled,
        tools,
        ...(candidateUserMessage === undefined ? {} : { candidateUserMessage }),
      });
    } catch (error) {
      if (error instanceof ContextProtocolError && error.code !== "open_frame") {
        this.fault(error);
      }
      throw error;
    }
  }

  private commit(mutation: LedgerMutation): void {
    try {
      this.input.committer?.commit(mutation);
    } catch (error) {
      if (error instanceof AdmissionStaleError) {
        throw error;
      }
      this.view = immutableView({ ...this.view, faulted: true });
      throw new SessionLedgerWriteError(mutation.kind, { cause: error });
    }
    this.view = mutation.next;
  }

  private assertAdmissionBase(token: AdmissionBaseToken, turnNumber: number): void {
    const head = this.view.messages.at(-1);
    if (
      head === undefined ||
      token.canonicalMessageCount !== this.view.messages.length ||
      token.canonicalHeadMessageId !== head.messageId ||
      token.canonicalHeadContentSha256 !== head.contentSha256 ||
      token.activeRevisionId !== this.revision.revisionId ||
      token.activeRevisionNumber !== this.revision.revisionNumber ||
      token.surfaceSha256 !== this.surface.surfaceSha256 ||
      token.nextTurnNumber !== turnNumber
    ) {
      throw new AdmissionStaleError();
    }
  }

  private requirePending(pending: InMemoryPendingLedgerTurn, action: string): void {
    this.requireHealthy(action);
    if (this.pending !== pending) {
      throw new Error(`Cannot ${action}: ledger turn ownership was lost.`);
    }
    pending.requireOpen(action);
  }

  private requireHealthy(action: string): void {
    if (this.view.faulted) {
      throw new Error(`Cannot ${action} after the session ledger faulted.`);
    }
  }

  private assertNoOpenFrame(): void {
    const open = this.view.frames.find((frame) => frame.state === "open");
    if (open !== undefined) {
      throw new ContextProtocolError("open_frame", `Frame ${open.frameId} is open.`, {
        frameId: open.frameId,
      });
    }
  }

  private openFrame(): ProtocolFrame {
    const frame = this.view.frames.at(-1);
    if (frame === undefined || frame.state !== "open") {
      throw new Error("Session ledger has no open protocol frame.");
    }
    return frame;
  }

  private assistantForFrame(
    frame: ProtocolFrame,
  ): Extract<CanonicalMessageRecord, { role: "assistant" }> {
    const assistant = this.messagesForFrame(frame)[0];
    if (assistant?.role !== "assistant" || assistant.toolCalls === undefined) {
      throw new Error(`Open frame ${frame.frameId} has no assistant tool calls.`);
    }
    return assistant;
  }

  private messagesForFrame(frame: ProtocolFrame): CanonicalMessageRecord[] {
    return this.view.messages.filter((message) => message.frameId === frame.frameId);
  }

  private expectedToolCall(): ToolCall | undefined {
    const frame = this.view.frames.at(-1);
    if (frame?.state !== "open") {
      return undefined;
    }
    const assistant = this.assistantForFrame(frame);
    return assistant.toolCalls?.[this.messagesForFrame(frame).length - 1];
  }
}

function snapshotFor(
  canonical: ProtocolContextView,
  revision: StoredContextRevisionV8,
  surface: StoredContextSurfaceV8,
  activeOverrides: readonly StoredContextOverrideV8[],
): StoredContextSnapshotV8 {
  return Object.freeze({
    meta: Object.freeze({
      sessionId: canonical.sessionId,
      activeRevisionId: revision.revisionId,
    }),
    revision,
    surface,
    activeOverrides,
    canonical,
  });
}

function createInMemoryContextSurface(input: {
  sessionId: SessionId;
  systemPrompt: string;
  tools: readonly ToolDefinition[];
  idFactory: RuntimeIdFactory;
  createdAt: string;
}): StoredContextSurfaceV8 {
  const serializedTools = input.tools.map((tool) => stableJsonStringify(tool));
  return createContextSurface({
    surfaceId: input.idFactory.createContextSurfaceId(),
    sessionId: input.sessionId,
    systemPrompt: input.systemPrompt,
    recallContractVersion: CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
    toolDefinitions: input.tools,
    prepared: {
      requestConfigHash: sha256("in-memory-model-request-v1"),
      requestMaxOutputTokens: 1,
      toolSchemaHash: sha256(serializedTools.join("\n")),
    },
    createdAt: input.createdAt,
  });
}

class InMemoryPendingLedgerTurn implements PendingLedgerTurn {
  readonly agent: AgentTurnLedger;
  private state: PendingState = "open";

  constructor(
    private readonly ledger: InMemorySessionLedger,
    readonly turn: TurnIdentity,
  ) {
    this.agent = {
      appendAssistant: (input) => this.ledger.appendAssistant(this, input),
      assertCanExecuteTool: (call) => this.ledger.assertCanExecuteTool(this, call),
      commitToolCompletions: (completions) =>
        this.ledger.commitToolCompletions(this, completions),
      buildModelRequest: (tools) => this.ledger.buildTurnModelRequest(this, tools),
    };
  }

  projectedMessageCount(): number {
    this.requireOpen("read projected message count");
    return this.ledger.committedMessageCount();
  }

  finish(result: RunAgentResult): void {
    this.ledger.finishTurn(this, result);
  }

  fault(error: unknown): void {
    this.ledger.faultTurn(this, error);
  }

  requireOpen(action: string): void {
    if (this.state !== "open") {
      throw new Error(`Cannot ${action} after pending ledger turn was ${this.state}.`);
    }
  }

  markFinished(): void {
    this.requireOpen("finish");
    this.state = "finished";
  }

  markFaulted(): void {
    if (this.state === "open") {
      this.state = "faulted";
    }
  }
}

function createInitialView(
  sessionId: SessionId,
  systemPrompt: string,
  idFactory: RuntimeIdFactory,
  clock: () => string,
): ProtocolContextView {
  if (systemPrompt.trim() === "") {
    throw new Error("Session ledger system prompt must not be empty.");
  }
  const createdAt = clock();
  const frameId = idFactory.createProtocolFrameId();
  const message = immutableRecord<CanonicalMessageRecord>({
    messageId: idFactory.createMessageId(),
    sessionId,
    frameId,
    ordinal: 1,
    contentSha256: contentHash(systemPrompt),
    createdAt,
    role: "system",
    content: systemPrompt,
    origin: "runtime",
  });
  const frame = immutableRecord<ProtocolFrame>({
    frameId,
    sessionId,
    kind: "system",
    state: "closed",
    firstOrdinal: 1,
    lastOrdinal: 1,
    createdAt,
    closedAt: createdAt,
  });
  return immutableView({
    sessionId,
    faulted: false,
    frames: [frame],
    messages: [message],
    toolResults: [],
  });
}

function appendView(
  view: ProtocolContextView,
  frames: readonly ProtocolFrame[],
  messages: readonly CanonicalMessageRecord[],
  toolResults: readonly ToolResultRecord[],
): ProtocolContextView {
  return immutableView({
    ...view,
    frames: [...view.frames, ...frames],
    messages: [...view.messages, ...messages],
    toolResults: [...view.toolResults, ...toolResults],
  });
}

function replaceFrameAndAppend(
  view: ProtocolContextView,
  frame: ProtocolFrame,
  messages: readonly CanonicalMessageRecord[],
  toolResults: readonly ToolResultRecord[],
): ProtocolContextView {
  return immutableView({
    ...view,
    frames: view.frames.map((current) =>
      current.frameId === frame.frameId ? frame : current,
    ),
    messages: [...view.messages, ...messages],
    toolResults: [...view.toolResults, ...toolResults],
  });
}

function immutableView(view: ProtocolContextView): ProtocolContextView {
  return Object.freeze({
    sessionId: view.sessionId,
    faulted: view.faulted,
    frames: Object.freeze([...view.frames]),
    messages: Object.freeze([...view.messages]),
    toolResults: Object.freeze([...view.toolResults]),
  });
}

function normalizeToolCalls(
  calls: AssistantMessage["toolCalls"],
): readonly ToolCall[] | undefined {
  if (calls === undefined || calls.length === 0) {
    return undefined;
  }
  return Object.freeze(immutableCanonicalClone(calls));
}

function canonicalCompletion(input: ToolCompletionInput): ToolCompletion {
  if (input.kind === "synthetic") {
    return immutableRecord({
      kind: "synthetic",
      reason: input.reason,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    });
  }
  const raw = immutableCanonicalClone(input.raw);
  return immutableRecord({
    kind: "returned",
    raw,
    rawSha256: rawResultHash(raw),
    observationFormat: CURRENT_TOOL_OBSERVATION_FORMAT,
  });
}

function validateCompletionInput(input: ToolCompletionInput): void {
  if (input.kind === "returned") {
    if (typeof input.observation !== "string") {
      throw new Error("Returned tool completion observation must be a string.");
    }
    immutableCanonicalClone(input.raw);
    return;
  }
  if (input.reason === "failed_active") {
    requireNonEmpty(input.detail ?? "", "failed_active detail");
  } else if (input.detail !== undefined) {
    throw new Error(`Synthetic reason ${input.reason} does not accept detail.`);
  }
}

function requireIterationInTurn(
  iteration: IterationIdentity,
  turn: TurnIdentity,
): void {
  if (
    iteration.sessionId !== turn.sessionId ||
    iteration.turnId !== turn.turnId ||
    iteration.turnNumber !== turn.turnNumber
  ) {
    throw new Error(
      `Iteration ${iteration.iterationId} does not belong to turn ${turn.turnId}.`,
    );
  }
}

function assertSameToolCall(expected: ToolCall, actual: ToolCall): void {
  if (
    actual.toolCallId !== expected.toolCallId ||
    actual.sessionId !== expected.sessionId ||
    actual.turnId !== expected.turnId ||
    actual.iterationId !== expected.iterationId ||
    actual.toolCallNumber !== expected.toolCallNumber ||
    actual.providerToolCallId !== expected.providerToolCallId ||
    actual.name !== expected.name
  ) {
    throw new Error(
      `Tool call ${actual.toolCallId} does not match expected call ${expected.toolCallId}.`,
    );
  }
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim() === "") {
    throw new Error(`${name} must not be empty.`);
  }
}

function requireItem<T>(items: readonly T[], index: number, name: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Missing ${name} at index ${index}.`);
  }
  return item;
}
