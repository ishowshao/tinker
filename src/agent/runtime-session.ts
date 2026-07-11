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
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling, type DefaultTooling } from "../tools/registry";
import type { Refiner } from "../tools/web-fetch/refiner";
import { runAgent } from "./loop";
import { TurnCancelledError } from "./turn-cancellation";
import type {
  AgentMessage,
  IterationIdentity,
  RunAgentResult,
  ToolCallIdentity,
  TurnIdentity,
} from "./types";

export type ExecuteTurnInput = {
  userPrompt: string;
  signal: AbortSignal;
};

export type SessionDisposeReason =
  | { type: "oneshot_complete" }
  | { type: "tui_exit" }
  | { type: "runner_failed"; error: string }
  | { type: "initialization_failed"; error: string };

export type RuntimeSession = {
  readonly sessionId: SessionId;
  executeTurn(input: ExecuteTurnInput): Promise<RunAgentResult>;
  dispose(reason: SessionDisposeReason): Promise<void>;
};

export type RuntimeSessionContext = {
  readonly sessionId: SessionId;
  createIteration(turn: TurnIdentity, iterationNumber: number): IterationIdentity;
  createToolCall(
    iteration: IterationIdentity,
    toolCallNumber: number,
  ): ToolCallIdentity;
  append(input: AgentEventInput): Promise<void>;
};

export type CreateRuntimeSessionInput = {
  sessionId: SessionId;
  workspaceRoot: string;
  modelName: string;
  maxIterations: number;
  includeReasoningContent: boolean;
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

export type RuntimeSessionFactoryDependencies = {
  idFactory: RuntimeIdFactory;
  createTooling: typeof createDefaultTooling;
  loadMcpConfig: typeof loadMcpConfig;
  createMcpManager: typeof createMcpManager;
  createObservationBuilder: () => ObservationBuilder;
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
};

class DefaultRuntimeSession implements RuntimeSession {
  readonly sessionId: SessionId;
  private state: RuntimeSessionState = "initializing";
  private eventSequence = 0;
  private nextTurnNumber = 1;
  private readonly turns = new Map<string, TurnIdentity>();
  private readonly iterations = new Map<string, IterationIdentity>();
  private readonly toolCalls = new Map<string, ToolCallIdentity>();
  private readonly nextIterationNumberByTurn = new Map<string, number>();
  private readonly nextToolCallNumberByIteration = new Map<string, number>();
  private eventTail: Promise<void> = Promise.resolve();
  private tooling?: DefaultTooling;
  private mcpManager?: McpManager;
  private sessionMessages?: AgentMessage[];
  private activeTurn?: ActiveTurn;
  private disposePromise?: Promise<void>;
  private faultCause?: RuntimeEventAppendError;

  private readonly context: RuntimeSessionContext;

  private constructor(
    private readonly input: CreateRuntimeSessionInput,
    private readonly dependencies: RuntimeSessionFactoryDependencies,
    private readonly eventSink: EventSink,
    private readonly observationBuilder: ObservationBuilder,
  ) {
    this.sessionId = input.sessionId;
    this.context = {
      sessionId: this.sessionId,
      createIteration: (turn, iterationNumber) =>
        this.createIteration(turn, iterationNumber),
      createToolCall: (iteration, toolCallNumber) =>
        this.createToolCall(iteration, toolCallNumber),
      append: (event) => this.append(event),
    };
  }

  static async create(
    input: CreateRuntimeSessionInput,
    dependencies: RuntimeSessionFactoryDependencies,
  ): Promise<RuntimeSession> {
    validateCreateInput(input);
    const session = new DefaultRuntimeSession(
      input,
      dependencies,
      createEventSink(input),
      dependencies.createObservationBuilder(),
    );
    let started = false;

    try {
      await session.append({
        type: "session.started",
        sessionId: session.sessionId,
        data: {
          workspaceRoot: input.workspaceRoot,
          model: input.modelName,
          maxIterations: input.maxIterations,
          includeReasoningContent: input.includeReasoningContent,
        },
      });
      started = true;

      session.tooling = dependencies.createTooling({
        workspaceRoot: input.workspaceRoot,
        runtimeSession: session.context,
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

    const controller = new AbortController();
    const removeExternalAbortListener = forwardExternalAbort(input.signal, controller);
    const turn = this.createTurn(input.userPrompt);
    this.state = "executing";
    const completion = this.performExecuteTurn(
      input.userPrompt,
      turn,
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

  private async performExecuteTurn(
    userPrompt: string,
    turn: TurnIdentity,
    signal: AbortSignal,
    removeExternalAbortListener: () => void,
  ): Promise<RunAgentResult> {
    let terminalAttempted = false;

    try {
      await this.append({
        type: "turn.started",
        ...turn,
        data: { userPrompt },
      });

      let result: RunAgentResult;
      try {
        result = await runAgent({
          systemPrompt: this.input.systemPrompt,
          userPrompt,
          initialMessages: this.sessionMessages,
          maxIterations: this.input.maxIterations,
          model: this.input.modelClient,
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

        terminalAttempted = true;
        await this.append({
          type: "turn.failed",
          ...turn,
          data: { error: errorMessage(error) },
        });
        throw error;
      }

      terminalAttempted = true;
      await this.appendTerminalEvent(turn, result);
      this.sessionMessages = result.messages;
      return result;
    } catch (error) {
      if (error instanceof RuntimeEventAppendError || terminalAttempted) {
        throw error;
      }

      await this.append({
        type: "turn.failed",
        ...turn,
        data: { error: errorMessage(error) },
      });
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
  ): Promise<void> {
    if (result.status === "completed") {
      await this.append({
        type: "turn.finished",
        ...turn,
        data: {
          status: result.status,
          finalText: result.finalText,
          lastIteration: result.lastIteration,
          messageCount: result.messages.length,
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

    this.state = "disposed";
    throwCollectedErrors(errors, "RuntimeSession initialization failed.");
    throw new Error("Initialization error collection unexpectedly returned.");
  }

  private createTurn(userPrompt: string): TurnIdentity {
    if (userPrompt.trim() === "") {
      throw new Error("Cannot create an AgentTurn for an empty prompt.");
    }

    const identity: TurnIdentity = {
      sessionId: this.sessionId,
      turnId: this.dependencies.idFactory.createTurnId(),
      turnNumber: this.nextTurnNumber,
    };
    this.nextTurnNumber += 1;
    this.turns.set(identity.turnId, identity);
    this.nextIterationNumberByTurn.set(identity.turnId, 1);
    return identity;
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

  private append(input: AgentEventInput): Promise<void> {
    if (this.state === "disposed") {
      throw new Error("Cannot append events after RuntimeSession is disposed.");
    }

    this.validateEventIdentity(input);
    const event: AgentEvent = {
      ...input,
      eventSequence: this.eventSequence + 1,
      timestamp: new Date().toISOString(),
    } as AgentEvent;
    this.eventSequence += 1;

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
        this.faultCause ??= appendError;
        if (this.state !== "disposing") {
          this.state = "faulted";
        }
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
      input.sessionId,
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
  if (input.sessionId.trim() === "") {
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
    typeof input.modelClient.request !== "function"
  ) {
    throw new Error("RuntimeSession modelClient must implement request().");
  }
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
