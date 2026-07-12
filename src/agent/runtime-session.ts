import path from "node:path";
import { CompositeEventSink } from "../events/composite-event-sink";
import type { EventSink } from "../events/event-sink";
import { JsonlEventLog } from "../events/jsonl-event-log";
import { ObservationTextLog } from "../events/observation-text-log";
import type { AgentEvent, AgentEventInput, AgentEventType } from "../events/types";
import {
  runtimeIdFactory,
  type RuntimeIdFactory,
  type SessionId,
} from "../ids/runtime-id";
import { loadMcpConfig } from "../mcp/mcp-config";
import { createMcpManager, type McpManager } from "../mcp/mcp-manager";
import type { ModelClient } from "../model/model-client";
import {
  assertMatchingContextBudget,
  type ModelContextBudget,
  type ModelContextProfile,
} from "../model/model-context-profile";
import { ObservationBuilder } from "../observation/observation-builder";
import { ContextProtocolError } from "../context/context-protocol-validator";
import { createDefaultTooling, type DefaultTooling } from "../tools/registry";
import type { Refiner } from "../tools/web-fetch/refiner";
import {
  SessionStore,
  createRuntimeContract,
  type SessionRecoveryResult,
} from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import { SessionError } from "../session/session-errors";
import { FatalAgentTurnError, runAgent } from "./loop";
import { SessionLedgerWriteError, type SessionLedger } from "./session-ledger";
import { TurnCancelledError } from "./turn-cancellation";
import type {
  IterationIdentity,
  RunAgentResult,
  ToolCallIdentity,
  TurnIdentity,
} from "./types";
import { ContextMeter } from "./context-meter";

export type ExecuteTurnInput = {
  userPrompt: string;
  signal: AbortSignal;
};

export type SessionDisposeReason =
  | { type: "oneshot_complete" }
  | { type: "tui_exit" }
  | { type: "session_switch" }
  | { type: "runner_failed"; error: string }
  | { type: "initialization_failed"; error: string };

export type RuntimeSession = {
  readonly sessionId: SessionId;
  readonly resumed: boolean;
  readonly recovery: SessionRecoveryResult;
  executeTurn(input: ExecuteTurnInput): Promise<RunAgentResult>;
  canSwitchSession(): boolean;
  dispose(reason: SessionDisposeReason): Promise<void>;
};

export type RuntimeSessionContext = {
  readonly sessionId: SessionId;
  createIteration(turn: TurnIdentity, iterationNumber: number): IterationIdentity;
  createToolCall(
    iteration: IterationIdentity,
    toolCallNumber: number,
  ): ToolCallIdentity;
  finishIterationForContinuation(iteration: IterationIdentity): void;
  append(input: AgentEventInput): Promise<void>;
};

export type CreateRuntimeSessionInput = {
  selection: RuntimeSessionSelection;
  workspaceRoot: string;
  modelName: string;
  maxIterations: number;
  includeReasoningContent: boolean;
  contextProfile: ModelContextProfile;
  contextBudget: ModelContextBudget;
  systemPrompt: string;
  modelClient: ModelClient;
  presentationSinks?: EventSink[];
  persistence?:
    | false
    | {
        eventLogPath?: string;
        observationLogPath?: string;
      };
  webFetchRefiner?: Refiner;
};

export type RuntimeSessionSelection =
  | { mode: "new"; sessionId: SessionId }
  | { mode: "resume"; sessionId: SessionId };

export type RuntimeSessionFactoryDependencies = {
  idFactory: RuntimeIdFactory;
  createTooling: typeof createDefaultTooling;
  loadMcpConfig: typeof loadMcpConfig;
  createMcpManager: typeof createMcpManager;
  createObservationBuilder: () => ObservationBuilder;
  openStore: (
    input: CreateRuntimeSessionInput,
    idFactory: RuntimeIdFactory,
  ) => Promise<SessionStore>;
  createLedger: (store: SessionStore, idFactory: RuntimeIdFactory) => SessionLedger;
  createEventSink: (input: CreateRuntimeSessionInput) => EventSink;
};

export class RuntimeEventAppendError extends Error {
  readonly eventType: AgentEventType;

  constructor(eventType: AgentEventType, options?: ErrorOptions) {
    super(`Failed to append runtime event ${eventType}.`, options);
    this.name = "RuntimeEventAppendError";
    this.eventType = eventType;
  }
}

type RuntimeSessionState =
  | "initializing"
  | "ready"
  | "executing"
  | "faulted"
  | "disposing"
  | "disposed";

type ActiveTurn = {
  controller: AbortController;
  completion: Promise<RunAgentResult>;
};

const defaultDependencies: RuntimeSessionFactoryDependencies = {
  idFactory: runtimeIdFactory,
  createTooling: createDefaultTooling,
  loadMcpConfig,
  createMcpManager,
  createObservationBuilder: () => new ObservationBuilder(),
  openStore: (input, idFactory) =>
    input.selection.mode === "new"
      ? SessionStore.createNew({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.selection.sessionId,
          modelName: input.modelName,
          systemPrompt: input.systemPrompt,
          idFactory,
        })
      : SessionStore.openExisting({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.selection.sessionId,
        }),
  createLedger: (store, idFactory) => new SqliteSessionLedger(store, idFactory),
  createEventSink,
};

class DefaultRuntimeSession implements RuntimeSession {
  readonly sessionId: SessionId;
  readonly resumed: boolean;
  recovery: SessionRecoveryResult = {
    syntheticCompletionCount: 0,
    recallIndexRebuilt: false,
  };
  private state: RuntimeSessionState = "initializing";
  private nextTurnNumber: number;
  private readonly turns = new Map<string, TurnIdentity>();
  private readonly iterations = new Map<string, IterationIdentity>();
  private readonly toolCalls = new Map<string, ToolCallIdentity>();
  private readonly nextIterationNumberByTurn = new Map<string, number>();
  private readonly nextToolCallNumberByIteration = new Map<string, number>();
  private eventTail: Promise<void> = Promise.resolve();
  private tooling?: DefaultTooling;
  private mcpManager?: McpManager;
  private ledger?: SessionLedger;
  private activeTurn?: ActiveTurn;
  private disposePromise?: Promise<void>;
  private faultCause?: unknown;
  private readonly contextMeter: ContextMeter;

  private readonly context: RuntimeSessionContext;

  private constructor(
    private readonly input: CreateRuntimeSessionInput,
    private readonly dependencies: RuntimeSessionFactoryDependencies,
    private readonly eventSink: EventSink,
    private readonly observationBuilder: ObservationBuilder,
    private readonly store: SessionStore,
  ) {
    this.sessionId = input.selection.sessionId;
    this.resumed = input.selection.mode === "resume";
    this.nextTurnNumber = store.nextTurnNumber();
    this.contextMeter = new ContextMeter(input.contextBudget, {
      onMeasuredAnchor: (anchor) => store.writeMeasuredContextAnchor(anchor),
    });
    this.context = {
      sessionId: this.sessionId,
      createIteration: (turn, iterationNumber) =>
        this.createIteration(turn, iterationNumber),
      createToolCall: (iteration, toolCallNumber) =>
        this.createToolCall(iteration, toolCallNumber),
      finishIterationForContinuation: (iteration) =>
        this.finishIterationForContinuation(iteration),
      append: (event) => this.append(event),
    };
  }

  static async create(
    input: CreateRuntimeSessionInput,
    dependencies: RuntimeSessionFactoryDependencies,
  ): Promise<RuntimeSession> {
    validateCreateInput(input);
    const store = await dependencies.openStore(input, dependencies.idFactory);
    let session: DefaultRuntimeSession;
    try {
      session = new DefaultRuntimeSession(
        input,
        dependencies,
        dependencies.createEventSink(input),
        dependencies.createObservationBuilder(),
        store,
      );
    } catch (error) {
      if (input.selection.mode === "new") {
        await store
          .deleteFromDisk()
          .catch(() => store.abandon().catch(() => undefined));
      } else {
        await store.abandon().catch(() => undefined);
      }
      throw error;
    }
    let started = false;

    try {
      if (input.selection.mode === "new") {
        await session.append({
          type: "session.started",
          sessionId: session.sessionId,
          data: {
            workspaceRoot: store.workspaceRoot,
            model: input.modelName,
            maxIterations: input.maxIterations,
            includeReasoningContent: input.includeReasoningContent,
            contextProfile: input.contextProfile,
            contextBudget: input.contextBudget,
          },
        });
        started = true;
      }

      session.tooling = dependencies.createTooling({
        workspaceRoot: input.workspaceRoot,
        runtimeSession: session.context,
        historyReader: store.historyReader(),
        webFetchRefiner: input.webFetchRefiner,
      });

      const mcpConfig = await dependencies.loadMcpConfig(input.workspaceRoot);
      if (mcpConfig !== undefined) {
        session.mcpManager = await dependencies.createMcpManager({
          config: mcpConfig,
          runtimeSession: session.context,
        });
        for (const executor of session.mcpManager.executors) {
          session.tooling.registry.register(executor, "MCP");
        }
      }

      const definitions = session.requireTooling().registry.definitions();
      const contractPrepared = input.modelClient.prepare({
        messages: [{ role: "system", content: input.systemPrompt }],
        tools: definitions,
      });
      const runtimeContract = createRuntimeContract({
        modelName: input.modelName,
        includeReasoningContent: input.includeReasoningContent,
        contextProfile: input.contextProfile,
        contextBudget: input.contextBudget,
        systemPrompt: input.systemPrompt,
        toolSchemaSha256: contractPrepared.toolSchemaHash,
        requestConfigSha256: contractPrepared.requestConfigHash,
      });
      if (input.selection.mode === "new") {
        store.finalizeRuntimeContract(runtimeContract);
      } else {
        store.assertRuntimeContract(runtimeContract);
        session.recovery = store.recoverInterruptedState(dependencies.idFactory);
        const openCount = store.markResumed();
        if (
          session.recovery.recoveredTurnId !== undefined &&
          session.recovery.recoveredFrameId !== undefined
        ) {
          await session.append({
            type: "session.interrupted_frame_recovered",
            sessionId: session.sessionId,
            data: {
              turnId: session.recovery.recoveredTurnId,
              frameId: session.recovery.recoveredFrameId,
              syntheticCompletionCount: session.recovery.syntheticCompletionCount,
            },
          });
        }
        await session.append({
          type: "session.resumed",
          sessionId: session.sessionId,
          data: {
            openCount,
            ...session.recovery,
          },
        });
      }

      session.ledger = dependencies.createLedger(store, dependencies.idFactory);
      const initialPrepared = input.modelClient.prepare(
        session.requireLedger().buildCommittedModelRequest(definitions),
      );
      if (input.selection.mode === "resume") {
        const storedAnchor = store.readActiveMeasuredContextAnchor();
        if (storedAnchor !== undefined) {
          session.contextMeter.restoreExactMeasuredAnchor(
            initialPrepared,
            storedAnchor,
          );
        }
      }
      const initialSnapshot = session.contextMeter.measure(initialPrepared);
      await session.append({
        type: "context.usage.updated",
        sessionId: session.sessionId,
        data: { phase: "initial", snapshot: initialSnapshot },
      });

      session.state = "ready";
      return session;
    } catch (error) {
      return session.rollbackInitialization(error, started);
    }
  }

  executeTurn(input: ExecuteTurnInput): Promise<RunAgentResult> {
    if (this.state !== "ready") {
      throw new Error(`Cannot execute a turn while RuntimeSession is ${this.state}.`);
    }
    if (input.userPrompt.trim() === "") {
      throw new Error("Cannot execute a turn with an empty prompt.");
    }
    if (this.activeTurn !== undefined) {
      throw new Error("Cannot execute concurrent turns in one RuntimeSession.");
    }

    let admissionPrepared;
    try {
      admissionPrepared = this.input.modelClient.prepare(
        this.requireLedger().buildCandidateModelRequest(
          input.userPrompt,
          this.requireTooling().registry.definitions(),
        ),
      );
    } catch (error) {
      if (isCanonicalRuntimeFault(error)) {
        this.fault(error);
      }
      throw error;
    }
    const admissionSnapshot = this.contextMeter.measure(admissionPrepared);
    this.contextMeter.assertWithinBudget(admissionSnapshot);

    const controller = new AbortController();
    const removeExternalAbortListener = forwardExternalAbort(input.signal, controller);
    const turn = this.stageTurn(input.userPrompt);
    let pendingLedgerTurn;
    try {
      pendingLedgerTurn = this.requireLedger().beginTurn({
        turn,
        userPrompt: input.userPrompt,
      });
      this.registerTurn(turn);
    } catch (error) {
      this.fault(error);
      throw error;
    }
    this.state = "executing";
    const completion = this.performExecuteTurn(
      input.userPrompt,
      turn,
      pendingLedgerTurn,
      controller.signal,
      removeExternalAbortListener,
    );
    this.activeTurn = { controller, completion };
    return completion;
  }

  dispose(reason: SessionDisposeReason): Promise<void> {
    this.disposePromise ??= this.performDispose(reason);
    return this.disposePromise;
  }

  canSwitchSession(): boolean {
    return (
      this.state === "ready" &&
      this.activeTurn === undefined &&
      (this.tooling?.taskManager
        .listBackgroundTasks()
        .every((task) => task.status !== "running" && task.status !== "stopping") ??
        true)
    );
  }

  private async performExecuteTurn(
    userPrompt: string,
    turn: TurnIdentity,
    pendingLedgerTurn: ReturnType<SessionLedger["beginTurn"]>,
    signal: AbortSignal,
    removeExternalAbortListener: () => void,
  ): Promise<RunAgentResult> {
    let settled = false;

    try {
      await this.append({
        type: "turn.started",
        ...turn,
        data: { userPrompt },
      });

      let result: RunAgentResult;
      try {
        result = await runAgent({
          ledger: pendingLedgerTurn.agent,
          maxIterations: this.input.maxIterations,
          model: this.input.modelClient,
          contextMeter: this.contextMeter,
          tools: this.requireTooling().registry,
          toolRuntime: this.requireTooling().runtime,
          observationBuilder: this.observationBuilder,
          runtimeSession: this.context,
          turn,
          signal,
        });
      } catch (error) {
        if (error instanceof RuntimeEventAppendError) {
          throw error;
        }

        if (error instanceof FatalAgentTurnError) {
          await this.appendTerminalEvent(
            turn,
            error.result,
            pendingLedgerTurn.projectedMessageCount(),
          );
          pendingLedgerTurn.finish(error.result);
          settled = true;
          throw error;
        }

        await this.append({
          type: "turn.failed",
          ...turn,
          data: { error: errorMessage(error) },
        });
        throw error;
      }

      const projectedMessageCount = pendingLedgerTurn.projectedMessageCount();
      await this.appendTerminalEvent(turn, result, projectedMessageCount);
      pendingLedgerTurn.finish(result);
      settled = true;
      return result;
    } catch (error) {
      if (!settled) {
        pendingLedgerTurn.fault(error);
      }
      this.fault(error);
      throw error;
    } finally {
      removeExternalAbortListener();
      this.activeTurn = undefined;
      if (this.state === "executing") {
        this.state = "ready";
      }
    }
  }

  private async appendTerminalEvent(
    turn: TurnIdentity,
    result: RunAgentResult,
    projectedMessageCount: number,
  ): Promise<void> {
    if (result.status === "completed") {
      await this.append({
        type: "turn.finished",
        ...turn,
        data: {
          status: result.status,
          finalText: result.finalText,
          lastIteration: result.lastIteration,
          messageCount: projectedMessageCount,
        },
      });
      return;
    }

    if (result.status === "cancelled") {
      await this.append({
        type: "turn.cancelled",
        ...result.lastIteration,
        data: { cancellation: result.cancellation },
      });
      return;
    }

    await this.append({
      type: "turn.failed",
      ...result.lastIteration,
      data: { error: result.error },
    });
  }

  private async performDispose(reason: SessionDisposeReason): Promise<void> {
    if (this.state === "disposed") {
      return;
    }

    this.state = "disposing";
    const errors: unknown[] = this.faultCause === undefined ? [] : [this.faultCause];
    const activeTurn = this.activeTurn;
    if (activeTurn !== undefined) {
      activeTurn.controller.abort(new TurnCancelledError("session_dispose"));
      try {
        await activeTurn.completion;
      } catch {
        // The executeTurn caller owns its primary error. Disposal still continues.
      }
    }

    if (this.mcpManager !== undefined) {
      await collectError(errors, () => this.mcpManager!.dispose());
    }
    if (this.tooling !== undefined) {
      await collectError(errors, () => this.tooling!.dispose(reason.type));
    }
    await collectError(errors, () =>
      this.append({
        type: "session.finished",
        sessionId: this.sessionId,
        data: {
          reason: reason.type,
          ...("error" in reason ? { error: reason.error } : {}),
        },
      }),
    );
    await collectError(errors, () => this.store.close(reason.type));

    this.state = "disposed";
    throwCollectedErrors(errors, "RuntimeSession disposal failed.");
  }

  private async rollbackInitialization(
    initializationError: unknown,
    started: boolean,
  ): Promise<never> {
    this.state = "disposing";
    const errors: unknown[] = [initializationError];

    if (this.mcpManager !== undefined) {
      await collectError(errors, () => this.mcpManager!.dispose());
    }
    if (this.tooling !== undefined) {
      await collectError(errors, () => this.tooling!.dispose("initialization_failed"));
    }
    if (started) {
      await collectError(errors, () =>
        this.append({
          type: "session.finished",
          sessionId: this.sessionId,
          data: {
            reason: "initialization_failed",
            error: errorMessage(initializationError),
          },
        }),
      );
    }
    await collectError(errors, async () => {
      let meta;
      try {
        meta = this.store.readMeta();
      } catch (error) {
        await this.store.abandon().catch(() => undefined);
        throw error;
      }
      if (
        this.input.selection.mode === "new" &&
        meta.initializationState === "creating" &&
        meta.nextTurnNumber === 1
      ) {
        await this.store.deleteFromDisk();
        return;
      }
      await this.store.close("initialization_failed");
    });

    this.state = "disposed";
    throwCollectedErrors(errors, "RuntimeSession initialization failed.");
    throw new Error("Initialization error collection unexpectedly returned.");
  }

  private stageTurn(userPrompt: string): TurnIdentity {
    if (userPrompt.trim() === "") {
      throw new Error("Cannot create an AgentTurn for an empty prompt.");
    }

    const identity: TurnIdentity = {
      sessionId: this.sessionId,
      turnId: this.dependencies.idFactory.createTurnId(),
      turnNumber: this.nextTurnNumber,
    };
    return identity;
  }

  private registerTurn(identity: TurnIdentity): void {
    if (identity.turnNumber !== this.nextTurnNumber) {
      throw new Error(
        `turnNumber must be ${this.nextTurnNumber}; received ${identity.turnNumber}.`,
      );
    }
    this.nextTurnNumber += 1;
    this.turns.set(identity.turnId, identity);
    this.nextIterationNumberByTurn.set(identity.turnId, 1);
  }

  private createIteration(
    turn: TurnIdentity,
    iterationNumber: number,
  ): IterationIdentity {
    this.requireTurn(turn);
    requirePositiveNumber(iterationNumber, "iterationNumber");
    const expected = this.nextIterationNumberByTurn.get(turn.turnId);
    if (iterationNumber !== expected) {
      throw new Error(
        `iterationNumber for turn ${turn.turnId} must be ${expected}; received ${iterationNumber}.`,
      );
    }

    const identity: IterationIdentity = {
      ...turn,
      iterationId: this.dependencies.idFactory.createIterationId(),
      iterationNumber,
    };
    this.store.beginIteration(identity);
    this.iterations.set(identity.iterationId, identity);
    this.nextIterationNumberByTurn.set(turn.turnId, iterationNumber + 1);
    this.nextToolCallNumberByIteration.set(identity.iterationId, 1);
    return identity;
  }

  private createToolCall(
    iteration: IterationIdentity,
    toolCallNumber: number,
  ): ToolCallIdentity {
    this.requireIteration(iteration);
    requirePositiveNumber(toolCallNumber, "toolCallNumber");
    const expected = this.nextToolCallNumberByIteration.get(iteration.iterationId);
    if (toolCallNumber !== expected) {
      throw new Error(
        `toolCallNumber for iteration ${iteration.iterationId} must be ${expected}; received ${toolCallNumber}.`,
      );
    }

    const identity: ToolCallIdentity = {
      ...iteration,
      toolCallId: this.dependencies.idFactory.createToolCallId(),
      toolCallNumber,
    };
    this.toolCalls.set(identity.toolCallId, identity);
    this.nextToolCallNumberByIteration.set(iteration.iterationId, toolCallNumber + 1);
    return identity;
  }

  private finishIterationForContinuation(iteration: IterationIdentity): void {
    this.requireIteration(iteration);
    this.store.finishIterationForContinuation(iteration);
  }

  private append(input: AgentEventInput): Promise<void> {
    if (this.state === "disposed") {
      throw new Error("Cannot append events after RuntimeSession is disposed.");
    }

    this.validateEventIdentity(input);
    let eventSequence: number;
    try {
      eventSequence = this.store.allocateEventSequence();
    } catch (error) {
      this.fault(error);
      throw error;
    }
    const event: AgentEvent = {
      ...input,
      eventSequence,
      timestamp: new Date().toISOString(),
    } as AgentEvent;

    const write = this.eventTail
      .then(async () => {
        const result = await this.eventSink.append(event);
        for (const diagnostic of result?.diagnostics ?? []) {
          void this.append({
            type: "diagnostic.sink_failed",
            sessionId: this.sessionId,
            data: diagnostic,
          }).catch(() => undefined);
        }
      })
      .catch((error) => {
        const appendError =
          error instanceof RuntimeEventAppendError
            ? error
            : new RuntimeEventAppendError(input.type, { cause: error });
        this.fault(appendError);
        throw appendError;
      });
    this.eventTail = write.catch(() => undefined);
    return write;
  }

  private validateEventIdentity(input: AgentEventInput): void {
    if (input.sessionId !== this.sessionId) {
      throw new Error(
        `Event ${input.type} belongs to session ${input.sessionId}, expected ${this.sessionId}.`,
      );
    }

    if ("toolCallId" in input) {
      this.requireToolCall(input);
      this.requireMatchingEventData(input);
      return;
    }
    if ("iterationId" in input) {
      this.requireIteration(input);
      return;
    }
    if ("turnId" in input) {
      this.requireTurn(input);
    }
  }

  private requireMatchingEventData(input: AgentEventInput): void {
    if (!("toolCallId" in input)) {
      return;
    }

    let relatedIdentity: ToolCallIdentity | undefined;
    switch (input.type) {
      case "tool.started":
      case "tool.raw_result":
      case "tool.finished":
      case "tool.observation":
        relatedIdentity = input.data.call;
        break;
      case "bash.task.backgrounded":
      case "bash.task.stopping":
      case "bash.task.finished":
        relatedIdentity = input.data.task.origin;
        break;
      default:
        return;
    }
    if (
      relatedIdentity !== undefined &&
      relatedIdentity.toolCallId !== input.toolCallId
    ) {
      throw new Error(
        `Event ${input.type} data belongs to tool call ${relatedIdentity.toolCallId}, expected ${input.toolCallId}.`,
      );
    }
  }

  private requireTurn(turn: TurnIdentity): void {
    const registered = this.turns.get(turn.turnId);
    if (
      registered === undefined ||
      registered.sessionId !== turn.sessionId ||
      registered.turnNumber !== turn.turnNumber
    ) {
      throw new Error(`Unknown or mismatched turn identity: ${turn.turnId}.`);
    }
  }

  private requireIteration(iteration: IterationIdentity): void {
    this.requireTurn(iteration);
    const registered = this.iterations.get(iteration.iterationId);
    if (
      registered === undefined ||
      registered.turnId !== iteration.turnId ||
      registered.iterationNumber !== iteration.iterationNumber
    ) {
      throw new Error(
        `Unknown or mismatched iteration identity: ${iteration.iterationId}.`,
      );
    }
  }

  private requireToolCall(toolCall: ToolCallIdentity): void {
    this.requireIteration(toolCall);
    const registered = this.toolCalls.get(toolCall.toolCallId);
    if (
      registered === undefined ||
      registered.iterationId !== toolCall.iterationId ||
      registered.toolCallNumber !== toolCall.toolCallNumber
    ) {
      throw new Error(
        `Unknown or mismatched tool call identity: ${toolCall.toolCallId}.`,
      );
    }
  }

  private requireTooling(): DefaultTooling {
    if (this.tooling === undefined) {
      throw new Error("RuntimeSession tooling is not initialized.");
    }
    return this.tooling;
  }

  private requireLedger(): SessionLedger {
    if (this.ledger === undefined) {
      throw new Error("RuntimeSession ledger is not initialized.");
    }
    return this.ledger;
  }

  private fault(error: unknown): void {
    this.faultCause ??= error;
    if (this.state !== "disposing" && this.state !== "disposed") {
      this.state = "faulted";
    }
  }
}

export async function createRuntimeSession(
  input: CreateRuntimeSessionInput,
  dependencyOverrides: Partial<RuntimeSessionFactoryDependencies> = {},
): Promise<RuntimeSession> {
  return DefaultRuntimeSession.create(input, {
    ...defaultDependencies,
    ...dependencyOverrides,
  });
}

function createEventSink(input: CreateRuntimeSessionInput): EventSink {
  const requiredSinks: EventSink[] = [];
  if (input.persistence !== false) {
    const basePath = path.join(
      input.workspaceRoot,
      ".tinker",
      "sessions",
      input.selection.sessionId,
    );
    requiredSinks.push(
      new JsonlEventLog(
        input.persistence?.eventLogPath ?? path.join(basePath, "events.jsonl"),
      ),
      new ObservationTextLog(
        input.persistence?.observationLogPath ?? path.join(basePath, "observations.md"),
      ),
    );
  }
  return new CompositeEventSink({
    requiredSinks,
    auxiliarySinks: input.presentationSinks ?? [],
  });
}

function validateCreateInput(input: CreateRuntimeSessionInput): void {
  if (input.selection.sessionId.trim() === "") {
    throw new Error("RuntimeSession sessionId must not be empty.");
  }
  if (!path.isAbsolute(input.workspaceRoot)) {
    throw new Error("RuntimeSession workspaceRoot must be an absolute path.");
  }
  if (input.modelName.trim() === "") {
    throw new Error("RuntimeSession modelName must not be empty.");
  }
  requirePositiveNumber(input.maxIterations, "maxIterations");
  if (input.systemPrompt.trim() === "") {
    throw new Error("RuntimeSession systemPrompt must not be empty.");
  }
  if (
    typeof input.modelClient !== "object" ||
    input.modelClient === null ||
    typeof input.modelClient.prepare !== "function" ||
    typeof input.modelClient.request !== "function"
  ) {
    throw new Error(
      "RuntimeSession modelClient must implement prepare() and request().",
    );
  }
  assertMatchingContextBudget(input.contextProfile, input.contextBudget);
}

function forwardExternalAbort(
  externalSignal: AbortSignal,
  internalController: AbortController,
): () => void {
  const forward = () => {
    internalController.abort(
      new TurnCancelledError("user", undefined, {
        cause: externalSignal.reason,
      }),
    );
  };

  if (externalSignal.aborted) {
    forward();
    return () => undefined;
  }

  externalSignal.addEventListener("abort", forward, { once: true });
  return () => externalSignal.removeEventListener("abort", forward);
}

async function collectError(
  errors: unknown[],
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!errors.includes(error)) {
      errors.push(error);
    }
  }
}

function throwCollectedErrors(errors: unknown[], message: string): void {
  if (errors.length === 0) {
    return;
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  throw new AggregateError(errors, message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requirePositiveNumber(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer; received ${value}.`);
  }
}

function isCanonicalRuntimeFault(error: unknown): boolean {
  return (
    error instanceof ContextProtocolError ||
    error instanceof SessionLedgerWriteError ||
    error instanceof SessionError
  );
}
