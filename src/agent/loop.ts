import type { ModelClient } from "../model/model-client";
import type { ObservationBuilder } from "../observation/observation-builder";
import type { ToolRegistry, ToolRuntime } from "../tools/registry";
import { ContextBuilder } from "./context-builder";
import type { RuntimeSession } from "./runtime-session";
import { throwIfTurnCancelled } from "./turn-cancellation";
import type {
  AgentMessage,
  IterationIdentity,
  RunAgentResult,
  ToolCall,
  TurnCancellation,
  TurnIdentity,
} from "./types";

export type RunAgentInput = {
  systemPrompt: string;
  userPrompt: string;
  initialMessages?: AgentMessage[];
  maxIterations: number;
  model: ModelClient;
  tools: ToolRegistry;
  toolRuntime: ToolRuntime;
  observationBuilder: ObservationBuilder;
  contextBuilder?: ContextBuilder;
  runtimeSession: RuntimeSession;
  turn: TurnIdentity;
  signal: AbortSignal;
};

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const contextBuilder = input.contextBuilder ?? new ContextBuilder();
  const messages: AgentMessage[] =
    input.initialMessages === undefined
      ? [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ]
      : [...input.initialMessages, { role: "user", content: input.userPrompt }];

  let lastIteration: IterationIdentity | undefined;

  for (
    let iterationNumber = 1;
    iterationNumber <= input.maxIterations;
    iterationNumber += 1
  ) {
    const iteration = input.runtimeSession.createIteration(input.turn, iterationNumber);
    lastIteration = iteration;
    await input.runtimeSession.append({
      type: "agent.iteration.started",
      ...iteration,
      data: { iterationNumber },
    });

    if (input.signal.aborted) {
      return cancelledResult(
        messages,
        cancellation(iteration, "agent_boundary"),
        iteration,
      );
    }

    await input.runtimeSession.append({
      type: "model.request.started",
      ...iteration,
      data: {},
    });

    let modelOutput;
    try {
      throwIfTurnCancelled(input.signal);
      modelOutput = await input.model.request(
        contextBuilder.build({
          messages,
          tools: input.tools.definitions(),
        }),
        {
          signal: input.signal,
          identity: {
            iteration,
            runtimeSession: input.runtimeSession,
          },
        },
      );
      throwIfTurnCancelled(input.signal);
    } catch (error) {
      if (input.signal.aborted) {
        return cancelledResult(
          messages,
          cancellation(iteration, "model_request"),
          iteration,
        );
      }

      return failedResult(messages, error, iteration);
    }

    messages.push(modelOutput.message);

    await input.runtimeSession.append({
      type: "model.request.finished",
      ...iteration,
      data: { output: modelOutput },
    });

    const toolCalls = modelOutput.message.toolCalls ?? [];
    if (toolCalls.length === 0) {
      await input.runtimeSession.append({
        type: "agent.iteration.finished",
        ...iteration,
        data: { outcome: "completed", toolCallCount: 0 },
      });
      return {
        status: "completed",
        finalText: modelOutput.message.content ?? "",
        messages,
        lastIteration: iteration,
      };
    }

    const progressContent = modelOutput.message.content?.trim();
    if (progressContent !== undefined && progressContent !== "") {
      await input.runtimeSession.append({
        type: "assistant.progress",
        ...iteration,
        data: { content: progressContent },
      });
    }

    for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
      const call = requireToolCall(toolCalls, callIndex);
      requireCallInIteration(call, iteration, callIndex + 1);

      if (input.signal.aborted) {
        appendCancelledToolMessages(messages, toolCalls, callIndex);
        return cancelledResult(
          messages,
          cancellation(iteration, "agent_boundary"),
          iteration,
        );
      }

      await input.runtimeSession.append({
        type: "tool.started",
        ...call,
        data: { call },
      });

      let raw;
      try {
        raw = await input.toolRuntime.execute(call, { signal: input.signal });
      } catch (error) {
        if (!input.signal.aborted) {
          return failedResult(messages, error, iteration);
        }

        appendCancelledToolMessages(messages, toolCalls, callIndex, call);
        return cancelledResult(
          messages,
          cancellation(iteration, "tool_execution", call),
          iteration,
        );
      }

      await input.runtimeSession.append({
        type: "tool.raw_result",
        ...call,
        data: { call, raw },
      });
      await input.runtimeSession.append({
        type: "tool.finished",
        ...call,
        data: { call, ok: raw.ok },
      });

      const observation = input.observationBuilder.build({ call, raw });
      messages.push({
        role: "tool",
        toolCallId: call.toolCallId,
        providerToolCallId: call.providerToolCallId,
        name: call.name,
        content: observation.content,
      });

      await input.runtimeSession.append({
        type: "tool.observation",
        ...call,
        data: { call, observation },
      });

      if (input.signal.aborted) {
        appendCancelledToolMessages(messages, toolCalls, callIndex + 1);
        return cancelledResult(
          messages,
          cancellation(iteration, "agent_boundary"),
          iteration,
        );
      }
    }

    await input.runtimeSession.append({
      type: "agent.iteration.finished",
      ...iteration,
      data: { outcome: "continue", toolCallCount: toolCalls.length },
    });
  }

  if (lastIteration === undefined) {
    throw new Error("Agent loop did not create an iteration identity.");
  }

  return {
    status: "failed",
    error: `Agent turn ${input.turn.turnId} stopped after maxIterations=${input.maxIterations}; last iteration=${lastIteration.iterationId}`,
    messages,
    lastIteration,
  };
}

const cancelledToolContent =
  "Tool execution was cancelled by the user. Side effects may have partially completed; inspect current state before retrying.";
const skippedToolContent = "Tool call was skipped because the user cancelled the turn.";

function appendCancelledToolMessages(
  messages: AgentMessage[],
  toolCalls: ToolCall[],
  startIndex: number,
  activeCall?: ToolCall,
): void {
  for (let index = startIndex; index < toolCalls.length; index += 1) {
    const call = requireToolCall(toolCalls, index);
    messages.push({
      role: "tool",
      toolCallId: call.toolCallId,
      providerToolCallId: call.providerToolCallId,
      name: call.name,
      content: call === activeCall ? cancelledToolContent : skippedToolContent,
    });
  }
}

function requireToolCall(toolCalls: ToolCall[], index: number): ToolCall {
  const call = toolCalls[index];
  if (call === undefined) {
    throw new Error(`Missing tool call at index ${index}.`);
  }
  return call;
}

function requireCallInIteration(
  call: ToolCall,
  iteration: IterationIdentity,
  toolCallNumber: number,
): void {
  if (
    call.sessionId !== iteration.sessionId ||
    call.turnId !== iteration.turnId ||
    call.iterationId !== iteration.iterationId ||
    call.toolCallNumber !== toolCallNumber
  ) {
    throw new Error(
      `Tool call ${call.toolCallId} has invalid identity for iteration ${iteration.iterationId}.`,
    );
  }
}

function cancellation(
  iteration: IterationIdentity,
  phase: TurnCancellation["phase"],
  call?: ToolCall,
): TurnCancellation {
  return {
    source: "user",
    phase,
    iterationId: iteration.iterationId,
    iterationNumber: iteration.iterationNumber,
    toolCallId: call?.toolCallId,
    toolName: call?.name,
  };
}

function cancelledResult(
  messages: AgentMessage[],
  turnCancellation: TurnCancellation,
  lastIteration: IterationIdentity,
): RunAgentResult {
  return {
    status: "cancelled",
    cancellation: turnCancellation,
    messages,
    lastIteration,
  };
}

function failedResult(
  messages: AgentMessage[],
  error: unknown,
  lastIteration: IterationIdentity,
): RunAgentResult {
  return {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
    messages,
    lastIteration,
  };
}
