import type { RuntimeSessionContext } from "../agent/runtime-session";
import type {
  IterationIdentity,
  ToolCall,
  ToolCallIdentity,
  TurnIdentity,
} from "../agent/types";
import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import type {
  IterationId,
  RuntimeIdFactory,
  SessionId,
  ToolCallId,
  TurnId,
} from "../ids/runtime-id";

export function createTestRuntime(eventSink: EventSink = collectingEventSink()) {
  const idFactory = deterministicIdFactory();
  const sessionId = idFactory.createSessionId();
  const turn: TurnIdentity = {
    sessionId,
    turnId: idFactory.createTurnId(),
    turnNumber: 1,
  };
  const iteration: IterationIdentity = {
    ...turn,
    iterationId: idFactory.createIterationId(),
    iterationNumber: 1,
  };
  let eventSequence = 0;
  let nextIterationNumber = 1;
  let nextToolCallNumber = 1;
  const knownIterations = new Map<string, IterationIdentity>([
    [iteration.iterationId, iteration],
  ]);

  const runtimeSession: RuntimeSessionContext = {
    sessionId,
    createIteration(inputTurn, iterationNumber) {
      if (
        inputTurn.sessionId !== turn.sessionId ||
        inputTurn.turnId !== turn.turnId ||
        inputTurn.turnNumber !== turn.turnNumber
      ) {
        throw new Error(`Unknown or mismatched turn identity: ${inputTurn.turnId}.`);
      }
      if (iterationNumber !== nextIterationNumber) {
        throw new Error(
          `iterationNumber must be ${nextIterationNumber}; received ${iterationNumber}.`,
        );
      }
      if (iterationNumber === 1) {
        nextIterationNumber = 2;
        return iteration;
      }
      const identity: IterationIdentity = {
        ...turn,
        iterationId: idFactory.createIterationId(),
        iterationNumber,
      };
      nextIterationNumber += 1;
      nextToolCallNumber = 1;
      knownIterations.set(identity.iterationId, identity);
      return identity;
    },
    createToolCall(inputIteration, toolCallNumber): ToolCallIdentity {
      if (!knownIterations.has(inputIteration.iterationId)) {
        throw new Error(
          `Unknown or mismatched iteration identity: ${inputIteration.iterationId}.`,
        );
      }
      if (toolCallNumber !== nextToolCallNumber) {
        throw new Error(
          `toolCallNumber must be ${nextToolCallNumber}; received ${toolCallNumber}.`,
        );
      }
      nextToolCallNumber += 1;
      return {
        ...inputIteration,
        toolCallId: idFactory.createToolCallId(),
        toolCallNumber,
      };
    },
    async append(input) {
      eventSequence += 1;
      await eventSink.append({
        ...input,
        eventSequence,
        timestamp: new Date().toISOString(),
      } as AgentEvent);
    },
  };

  return {
    runtimeSession,
    turn,
    iteration,
    toolCall(input: TestToolCallInput): ToolCall {
      const identity = runtimeSession.createToolCall(iteration, nextToolCallNumber);
      return {
        ...identity,
        providerToolCallId:
          input.providerToolCallId ?? `provider-call-${identity.toolCallNumber}`,
        name: input.name,
        args: input.args,
        rawArgs: input.rawArgs,
        argsParseError: input.argsParseError,
      };
    },
  };
}

export type TestToolCallInput = {
  providerToolCallId?: string;
  name: string;
  args: unknown;
  rawArgs?: string;
  argsParseError?: string;
};

export function collectingEventSink(): EventSink & { events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    events,
    async append(event) {
      events.push(event);
    },
  };
}

export function deterministicIdFactory(prefix = "test"): RuntimeIdFactory {
  let session = 0;
  let turn = 0;
  let iteration = 0;
  let toolCall = 0;
  return {
    createSessionId: () => `${prefix}-session-${++session}` as SessionId,
    createTurnId: () => `${prefix}-turn-${++turn}` as TurnId,
    createIterationId: () => `${prefix}-iteration-${++iteration}` as IterationId,
    createToolCallId: () => `${prefix}-tool-call-${++toolCall}` as ToolCallId,
  };
}
