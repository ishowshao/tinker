import type { EventSink } from "../events/event-sink";
import type { ModelClient } from "../model/model-client";
import type { ObservationBuilder } from "../observation/observation-builder";
import type { ToolRegistry, ToolRuntime } from "../tools/registry";
import { ContextBuilder } from "./context-builder";
import type { AgentMessage, RunAgentResult } from "./types";

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

  for (let step = 1; step <= input.maxSteps; step += 1) {
    await input.eventSink.append({
      type: "model.step.started",
      step,
    });

    let modelOutput;

    try {
      modelOutput = await input.model.step(
        contextBuilder.build({
          messages,
          tools: input.tools.definitions(),
        }),
      );
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        messages,
      };
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
        ok: true,
        finalText:
          modelOutput.message.role === "assistant"
            ? (modelOutput.message.content ?? "")
            : "",
        messages,
      };
    }

    for (const call of toolCalls) {
      await input.eventSink.append({
        type: "tool.started",
        step,
        call,
      });

      const raw = await input.toolRuntime.execute(call);

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
    }
  }

  return {
    ok: false,
    error: `Agent stopped after maxSteps=${input.maxSteps}`,
    messages,
  };
}
