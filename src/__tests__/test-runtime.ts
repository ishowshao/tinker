import { RuntimeSession } from "../agent/runtime-session";
import type { ToolCall } from "../agent/types";
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
  let toolCallNumber = 0;
  const runtimeSession = new RuntimeSession(eventSink, {
    idFactory: deterministicIdFactory(),
  });
  const turn = runtimeSession.createTurn("test prompt");
  const iteration = runtimeSession.createIteration(turn, 1);

  return {
    runtimeSession,
    turn,
    iteration,
    toolCall(input: {
      providerToolCallId?: string;
      name: string;
      args: unknown;
      rawArgs?: string;
      argsParseError?: string;
    }): ToolCall {
      toolCallNumber += 1;
      return {
        ...runtimeSession.createToolCall(iteration, toolCallNumber),
        providerToolCallId:
          input.providerToolCallId ?? `provider-call-${toolCallNumber}`,
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
