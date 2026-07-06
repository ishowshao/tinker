import type { AgentMessage, ToolCall } from "../agent/types";
import type { ModelStepOutput } from "./model-client";
import type { ToolDefinition } from "../tools/types";
import { createUuidV7 } from "../ids/uuid-v7";
import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export function toOpenAIChatMessages(
  messages: AgentMessage[],
): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.toolCalls?.map(toOpenAIToolCall),
      };
    }

    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }

    return message;
  });
}

export function toOpenAIChatTools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function fromOpenAIChatCompletion(response: unknown): ModelStepOutput {
  const completion = asRecord(response);
  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice.message);
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = rawToolCalls.map(parseToolCall);

  return {
    message: {
      role: "assistant",
      content: normalizeContent(message.content),
      toolCalls: toolCalls.length === 0 ? undefined : toolCalls,
    },
    finishReason:
      typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
    usage: completion.usage,
    rawResponse: response,
  };
}

function toOpenAIToolCall(call: ToolCall): ChatCompletionMessageFunctionToolCall {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments:
        call.rawArgs ??
        (typeof call.args === "string" ? call.args : JSON.stringify(call.args)),
    },
  };
}

function parseToolCall(raw: unknown): ToolCall {
  const record = asRecord(raw);
  const fn = asRecord(record.function);
  const rawArgs = typeof fn.arguments === "string" ? fn.arguments : "";
  let args: unknown = {};
  let argsParseError: string | undefined;

  if (rawArgs.trim() !== "") {
    try {
      args = JSON.parse(rawArgs);
    } catch (error) {
      argsParseError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    id: typeof record.id === "string" ? record.id : createUuidV7(),
    name: typeof fn.name === "string" ? fn.name : "",
    args,
    rawArgs,
    argsParseError,
  };
}

function normalizeContent(content: unknown): string | null {
  if (content === null || content === undefined) {
    return null;
  }

  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
