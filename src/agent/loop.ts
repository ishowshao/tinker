import type { EventSink } from "../events/event-sink";
import type { ModelClient } from "../model/model-client";
import type { ObservationBuilder } from "../observation/observation-builder";
import type { ToolRegistry, ToolRuntime } from "../tools/registry";
import { ContextBuilder } from "./context-builder";
import { throwIfTurnCancelled } from "./turn-cancellation";
import type { AgentMessage, RunAgentResult, ToolCall, TurnCancellation } from "./types";

export type RunAgentInput = {
  systemPrompt: string;
  userPrompt: string;
  initialMessages?: AgentMessage[];
  maxSteps: number;
  model: ModelClient;
  tools: ToolRegistry;
  toolRuntime: ToolRuntime;
  observationBuilder: ObservationBuilder;
  contextBuilder?: ContextBuilder;
  eventSink: EventSink;
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

  if (input.signal.aborted) {
    return cancelledResult(messages, {
      source: "user",
      phase: "agent_boundary",
      step: 1,
    });
  }

  for (let step = 1; step <= input.maxSteps; step += 1) {
    await input.eventSink.append({
      type: "model.step.started",
      step,
    });

    let modelOutput;

    try {
      throwIfTurnCancelled(input.signal);
      modelOutput = await input.model.step(
        contextBuilder.build({
          messages,
          tools: input.tools.definitions(),
        }),
        { signal: input.signal },
      );
      throwIfTurnCancelled(input.signal);
    } catch (error) {
      if (input.signal.aborted) {
        return cancelledResult(messages, {
          source: "user",
          phase: "model_request",
          step,
        });
      }

      return failedResult(messages, error);
    }

    messages.push(modelOutput.message);

    await input.eventSink.append({
      type: "model.step.finished",
      step,
      output: modelOutput,
    });

    const toolCalls =
      modelOutput.message.role === "assistant"
        ? (modelOutput.message.toolCalls ?? [])
        : [];

    if (toolCalls.length === 0) {
      return {
        status: "completed",
        finalText:
          modelOutput.message.role === "assistant"
            ? (modelOutput.message.content ?? "")
            : "",
        messages,
      };
    }

    const progressContent =
      modelOutput.message.role === "assistant"
        ? modelOutput.message.content?.trim()
        : undefined;

    if (progressContent !== undefined && progressContent !== "") {
      await input.eventSink.append({
        type: "assistant.progress",
        step,
        content: progressContent,
      });
    }

    for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
      const call = requireToolCall(toolCalls, callIndex);

      if (input.signal.aborted) {
        appendCancelledToolMessages(messages, toolCalls, callIndex);
        return cancelledResult(messages, {
          source: "user",
          phase: "agent_boundary",
          step,
        });
      }

      await input.eventSink.append({
        type: "tool.started",
        step,
        call,
      });

      let raw;
      try {
        raw = await input.toolRuntime.execute(call, { signal: input.signal });
      } catch (error) {
        if (!input.signal.aborted) {
          return failedResult(messages, error);
        }

        appendCancelledToolMessages(messages, toolCalls, callIndex, call);
        return cancelledResult(messages, {
          source: "user",
          phase: "tool_execution",
          step,
          toolCallId: call.id,
          toolName: call.name,
        });
      }

      await input.eventSink.append({
        type: "tool.raw_result",
        step,
        call,
        raw,
      });

      await input.eventSink.append({
        type: "tool.finished",
        step,
        call,
        ok: raw.ok,
      });

      const observation = input.observationBuilder.build({
        call,
        raw,
      });

      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: observation.content,
      });

      await input.eventSink.append({
        type: "tool.observation",
        step,
        call,
        observation,
      });

      if (input.signal.aborted) {
        appendCancelledToolMessages(messages, toolCalls, callIndex + 1);
        return cancelledResult(messages, {
          source: "user",
          phase: "agent_boundary",
          step,
        });
      }
    }
  }

  if (input.signal.aborted) {
    return cancelledResult(messages, {
      source: "user",
      phase: "agent_boundary",
      step: input.maxSteps,
    });
  }

  return {
    status: "failed",
    error: `Agent stopped after maxSteps=${input.maxSteps}`,
    messages,
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
      toolCallId: call.id,
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

function cancelledResult(
  messages: AgentMessage[],
  cancellation: TurnCancellation,
): RunAgentResult {
  return {
    status: "cancelled",
    cancellation,
    messages,
  };
}

function failedResult(messages: AgentMessage[], error: unknown): RunAgentResult {
  return {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
    messages,
  };
}
