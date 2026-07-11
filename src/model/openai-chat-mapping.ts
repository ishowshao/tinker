import type { AgentMessage, IterationIdentity, ToolCall } from "../agent/types";
import type { RuntimeSession } from "../agent/runtime-session";
import type { ModelRequestOutput } from "./model-client";
import type { ToolDefinition } from "../tools/types";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

type DeepSeekAssistantMessageParam = ChatCompletionAssistantMessageParam & {
  reasoning_content?: string | null;
};

export type OpenAIChatMessageMappingOptions = {
  includeReasoningContent?: boolean;
};

export function toOpenAIChatMessages(
  messages: AgentMessage[],
  options: OpenAIChatMessageMappingOptions = {},
): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    if (message.role === "assistant") {
      const assistantMessage: DeepSeekAssistantMessageParam = {
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.toolCalls?.map(toOpenAIToolCall),
      };

      if (
        options.includeReasoningContent === true &&
        message.reasoningContent !== undefined
      ) {
        assistantMessage.reasoning_content = message.reasoningContent;
      }

      return assistantMessage;
    }

    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.providerToolCallId,
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

export function fromOpenAIChatCompletion(
  response: unknown,
  context:
    | {
        iteration: IterationIdentity;
        runtimeSession: RuntimeSession;
      }
    | undefined,
): ModelRequestOutput {
  const completion = asRecord(response);
  if (!Array.isArray(completion.choices) || completion.choices.length === 0) {
    throw new Error("OpenAI Chat Completions response is missing choices[0].");
  }

  const choice = requireRecord(completion.choices[0], "choices[0]");
  const message = requireRecord(choice.message, "choices[0].message");
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (rawToolCalls.length > 0 && context === undefined) {
    throw new Error(
      "OpenAI Chat Completions returned tool calls without an iteration identity context.",
    );
  }
  const toolCalls = rawToolCalls.map((raw, index) =>
    parseToolCall(raw, index, context!),
  );
  const content = normalizeContent(message.content);
  if ((content === null || content.trim() === "") && toolCalls.length === 0) {
    throw new Error(
      "OpenAI Chat Completions assistant message has neither text nor tool calls.",
    );
  }

  return {
    message: {
      role: "assistant",
      content,
      reasoningContent: normalizeContent(message.reasoning_content),
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
    id: call.providerToolCallId,
    type: "function",
    function: {
      name: call.name,
      arguments:
        call.rawArgs ??
        (typeof call.args === "string" ? call.args : JSON.stringify(call.args)),
    },
  };
}

function parseToolCall(
  raw: unknown,
  index: number,
  context: {
    iteration: IterationIdentity;
    runtimeSession: RuntimeSession;
  },
): ToolCall {
  const record = requireRecord(raw, `choices[0].message.tool_calls[${index}]`);
  const providerToolCallId = requireNonEmptyString(
    record.id,
    `choices[0].message.tool_calls[${index}].id`,
  );
  const fn = requireRecord(
    record.function,
    `choices[0].message.tool_calls[${index}].function`,
  );
  const name = requireNonEmptyString(
    fn.name,
    `choices[0].message.tool_calls[${index}].function.name`,
  );
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
    ...context.runtimeSession.createToolCall(context.iteration, index + 1),
    providerToolCallId,
    name,
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

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    throw new Error(`OpenAI Chat Completions response has invalid ${path}.`);
  }

  return record;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`OpenAI Chat Completions response has invalid ${path}.`);
  }

  return value;
}
