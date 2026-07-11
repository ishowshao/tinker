import type { EventSink } from "../events/event-sink";
import type { AgentEvent, AgentEventInput } from "../events/types";
import {
  runtimeIdFactory,
  type RuntimeIdFactory,
  type SessionId,
} from "../ids/runtime-id";
import type { IterationIdentity, ToolCallIdentity, TurnIdentity } from "./types";

export class RuntimeSession {
  readonly sessionId: SessionId;
  private eventSequence = 0;
  private nextTurnNumber = 1;
  private readonly turns = new Map<string, TurnIdentity>();
  private readonly iterations = new Map<string, IterationIdentity>();
  private readonly toolCalls = new Map<string, ToolCallIdentity>();
  private readonly nextIterationNumberByTurn = new Map<string, number>();
  private readonly nextToolCallNumberByIteration = new Map<string, number>();
  private readonly idFactory: RuntimeIdFactory;
  private eventTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly eventSink: EventSink,
    options: { idFactory?: RuntimeIdFactory; sessionId?: SessionId } = {},
  ) {
    this.idFactory = options.idFactory ?? runtimeIdFactory;
    this.sessionId = options.sessionId ?? this.idFactory.createSessionId();
  }

  createTurn(userPrompt: string): TurnIdentity {
    if (userPrompt.trim() === "") {
      throw new Error("Cannot create an AgentTurn for an empty prompt.");
    }

    const identity: TurnIdentity = {
      sessionId: this.sessionId,
      turnId: this.idFactory.createTurnId(),
      turnNumber: this.nextTurnNumber,
    };
    this.nextTurnNumber += 1;
    this.turns.set(identity.turnId, identity);
    this.nextIterationNumberByTurn.set(identity.turnId, 1);
    return identity;
  }

  createIteration(turn: TurnIdentity, iterationNumber: number): IterationIdentity {
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
      iterationId: this.idFactory.createIterationId(),
      iterationNumber,
    };
    this.iterations.set(identity.iterationId, identity);
    this.nextIterationNumberByTurn.set(turn.turnId, iterationNumber + 1);
    this.nextToolCallNumberByIteration.set(identity.iterationId, 1);
    return identity;
  }

  createToolCall(
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
      toolCallId: this.idFactory.createToolCallId(),
      toolCallNumber,
    };
    this.toolCalls.set(identity.toolCallId, identity);
    this.nextToolCallNumberByIteration.set(iteration.iterationId, toolCallNumber + 1);
    return identity;
  }

  append(input: AgentEventInput): Promise<void> {
    this.validateEventIdentity(input);
    const event: AgentEvent = {
      ...input,
      eventSequence: this.eventSequence + 1,
      timestamp: new Date().toISOString(),
    } as AgentEvent;
    this.eventSequence += 1;

    const write = this.eventTail.then(() => this.eventSink.append(event));
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
}

function requirePositiveNumber(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer; received ${value}.`);
  }
}
