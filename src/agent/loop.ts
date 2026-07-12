import type { ModelClient, PreparedModelRequest } from "../model/model-client";
import type { ObservationBuilder } from "../observation/observation-builder";
import type { ToolRegistry, ToolRuntime } from "../tools/registry";
import type { ContextMeter } from "./context-meter";
import type { RuntimeSessionContext } from "./runtime-session";
import type { AgentTurnLedger } from "./session-ledger";
import { ContextProtocolError } from "../context/context-protocol-validator";
import {
  normalizeSyntheticDetail,
  type SyntheticToolCompletionInput,
} from "../context/protocol-frame";
import { throwIfTurnCancelled, turnCancellationSource } from "./turn-cancellation";
import type {
  IterationIdentity,
  RunAgentResult,
  ToolCall,
  TurnCancellation,
  TurnIdentity,
} from "./types";

export type RunAgentInput = {
  ledger: AgentTurnLedger;
  maxIterations: number;
  model: ModelClient;
  contextMeter: ContextMeter;
  tools: ToolRegistry;
  toolRuntime: ToolRuntime;
  observationBuilder: ObservationBuilder;
  runtimeSession: RuntimeSessionContext;
  turn: TurnIdentity;
  signal: AbortSignal;
};

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
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
        cancellation(input.signal, iteration, "agent_boundary"),
        iteration,
      );
    }

    let prepared: PreparedModelRequest;
    let preflight;
    try {
      throwIfTurnCancelled(input.signal);
      prepared = input.model.prepare(
        input.ledger.buildModelRequest(input.tools.definitions()),
      );
      preflight = input.contextMeter.measure(prepared);
    } catch (error) {
      if (input.signal.aborted) {
        return cancelledResult(
          cancellation(input.signal, iteration, "agent_boundary"),
          iteration,
        );
      }
      return failedResult(error, iteration);
    }
    await input.runtimeSession.append({
      type: "context.usage.updated",
      ...iteration,
      data: { phase: "preflight", snapshot: preflight },
    });
    try {
      input.contextMeter.assertWithinBudget(preflight);
    } catch (error) {
      return failedResult(error, iteration);
    }

    await input.runtimeSession.append({
      type: "model.request.started",
      ...iteration,
      data: {},
    });

    let modelOutput;
    try {
      throwIfTurnCancelled(input.signal);
      modelOutput = await input.model.request(prepared, {
        signal: input.signal,
        identity: {
          iteration,
          runtimeSession: input.runtimeSession,
        },
      });
      throwIfTurnCancelled(input.signal);
    } catch (error) {
      if (input.signal.aborted) {
        return cancelledResult(
          cancellation(input.signal, iteration, "model_request"),
          iteration,
        );
      }

      return failedResult(error, iteration);
    }

    try {
      input.ledger.appendAssistant({
        iteration,
        message: modelOutput.message,
        provider: prepared.provider,
        model: prepared.model,
      });
    } catch (error) {
      if (error instanceof ContextProtocolError) {
        return failedResult(error, iteration);
      }
      throw error;
    }

    await input.runtimeSession.append({
      type: "model.request.finished",
      ...iteration,
      data: { output: modelOutput },
    });
    const measured = input.contextMeter.recordProviderUsage(prepared, modelOutput);
    await input.runtimeSession.append({
      type: "context.usage.updated",
      ...iteration,
      data: { phase: "measured", snapshot: measured },
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
        input.ledger.commitToolCompletions(
          cancelledToolCompletions(toolCalls, callIndex),
        );
        return cancelledResult(
          cancellation(input.signal, iteration, "agent_boundary"),
          iteration,
        );
      }

      input.ledger.assertCanExecuteTool(call);

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
          input.ledger.commitToolCompletions(
            failedToolCompletions(toolCalls, callIndex, error),
          );
          return failedResult(error, iteration);
        }

        input.ledger.commitToolCompletions(
          cancelledToolCompletions(toolCalls, callIndex, call),
        );
        return cancelledResult(
          cancellation(input.signal, iteration, "tool_execution", call),
          iteration,
        );
      }

      const observation = input.observationBuilder.build({ call, raw });
      input.ledger.commitToolCompletions([
        {
          call,
          kind: "returned",
          raw,
          observation: observation.content,
        },
      ]);

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

      await input.runtimeSession.append({
        type: "tool.observation",
        ...call,
        data: { call, observation },
      });

      if (input.signal.aborted) {
        if (callIndex + 1 < toolCalls.length) {
          input.ledger.commitToolCompletions(
            cancelledToolCompletions(toolCalls, callIndex + 1),
          );
        }
        return cancelledResult(
          cancellation(input.signal, iteration, "agent_boundary"),
          iteration,
        );
      }
    }

    await input.runtimeSession.append({
      type: "agent.iteration.finished",
      ...iteration,
      data: { outcome: "continue", toolCallCount: toolCalls.length },
    });
    input.runtimeSession.finishIterationForContinuation(iteration);
  }

  if (lastIteration === undefined) {
    throw new Error("Agent loop did not create an iteration identity.");
  }

  return {
    status: "failed",
    error: `Agent turn ${input.turn.turnId} stopped after maxIterations=${input.maxIterations}; last iteration=${lastIteration.iterationId}`,
    lastIteration,
  };
}

function cancelledToolCompletions(
  toolCalls: readonly ToolCall[],
  startIndex: number,
  activeCall?: ToolCall,
): SyntheticToolCompletionInput[] {
  const completions: SyntheticToolCompletionInput[] = [];
  for (let index = startIndex; index < toolCalls.length; index += 1) {
    const call = requireToolCall(toolCalls, index);
    completions.push({
      call,
      kind: "synthetic",
      reason: call === activeCall ? "cancelled_active" : "skipped_after_cancel",
    });
  }
  return completions;
}

function failedToolCompletions(
  toolCalls: readonly ToolCall[],
  startIndex: number,
  error: unknown,
): SyntheticToolCompletionInput[] {
  const completions: SyntheticToolCompletionInput[] = [];
  for (let index = startIndex; index < toolCalls.length; index += 1) {
    const call = requireToolCall(toolCalls, index);
    completions.push(
      index === startIndex
        ? {
            call,
            kind: "synthetic",
            reason: "failed_active",
            detail: normalizeSyntheticDetail(error),
          }
        : { call, kind: "synthetic", reason: "skipped_after_failure" },
    );
  }
  return completions;
}

function requireToolCall(toolCalls: readonly ToolCall[], index: number): ToolCall {
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
  signal: AbortSignal,
  iteration: IterationIdentity,
  phase: TurnCancellation["phase"],
  call?: ToolCall,
): TurnCancellation {
  return {
    source: turnCancellationSource(signal),
    phase,
    iterationId: iteration.iterationId,
    iterationNumber: iteration.iterationNumber,
    toolCallId: call?.toolCallId,
    toolName: call?.name,
  };
}

function cancelledResult(
  turnCancellation: TurnCancellation,
  lastIteration: IterationIdentity,
): RunAgentResult {
  return {
    status: "cancelled",
    cancellation: turnCancellation,
    lastIteration,
  };
}

function failedResult(
  error: unknown,
  lastIteration: IterationIdentity,
): RunAgentResult {
  return {
    status: "failed",
    error: errorMessage(error),
    lastIteration,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
