import type { AgentMessage, IterationIdentity, ToolCall } from "../agent/types";
import type { RuntimeSessionContext } from "../agent/runtime-session";
import type { ModelRequestOutput, ModelUsage } from "./model-client";
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
  options: {
    identity?: {
      iteration: IterationIdentity;
      runtimeSession: RuntimeSessionContext;
    };
    provider: string;
    model: string;
  },
): ModelRequestOutput {
  const completion = requireRecord(response, "response", options);
  if (!Array.isArray(completion.choices) || completion.choices.length === 0) {
    throw providerResponseError(options, "choices[0]", "is missing");
  }

  const choice = requireRecord(completion.choices[0], "choices[0]", options);
  const message = requireRecord(choice.message, "choices[0].message", options);
  if (message.role !== "assistant") {
    throw providerResponseError(
      options,
      "choices[0].message.role",
      'must be "assistant"',
    );
  }
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
    throw providerResponseError(
      options,
      "choices[0].message.tool_calls",
      "must be an array",
    );
  }
  const rawToolCalls = message.tool_calls ?? [];
  if (rawToolCalls.length > 0 && options.identity === undefined) {
    throw providerResponseError(
      options,
      "choices[0].message.tool_calls",
      "requires an iteration identity context",
    );
  }
  const toolCalls = rawToolCalls.map((raw, index) =>
    parseToolCall(raw, index, options.identity!, options),
  );
  const content = normalizeContent(
    message.content,
    "choices[0].message.content",
    options,
  );
  if ((content === null || content.trim() === "") && toolCalls.length === 0) {
    throw providerResponseError(
      options,
      "choices[0].message",
      "has neither non-empty text nor tool calls",
    );
  }

  const finishReason = optionalString(
    choice.finish_reason,
    "choices[0].finish_reason",
    options,
  );

  return {
    message: {
      role: "assistant",
      content,
      reasoningContent: normalizeContent(
        message.reasoning_content,
        "choices[0].message.reasoning_content",
        options,
      ),
      toolCalls: toolCalls.length === 0 ? undefined : toolCalls,
    },
    finishReason,
    usage: parseUsage(completion.usage, options),
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
    runtimeSession: RuntimeSessionContext;
  },
  options: { provider: string; model: string },
): ToolCall {
  const path = `choices[0].message.tool_calls[${index}]`;
  const record = requireRecord(raw, path, options);
  if (record.type !== "function") {
    throw providerResponseError(options, `${path}.type`, 'must be "function"');
  }
  const providerToolCallId = requireNonEmptyString(record.id, `${path}.id`, options);
  const fn = requireRecord(record.function, `${path}.function`, options);
  const name = requireNonEmptyString(fn.name, `${path}.function.name`, options);
  const rawArgs = requireString(fn.arguments, `${path}.function.arguments`, options);
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

function normalizeContent(
  content: unknown,
  path: string,
  options: { provider: string; model: string },
): string | null {
  if (content === null || content === undefined) {
    return null;
  }

  if (typeof content === "string") {
    return content;
  }

  throw providerResponseError(options, path, "must be a string or null");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireRecord(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): Record<string, unknown> {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    throw providerResponseError(options, path, "must be a non-empty object");
  }

  return record;
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw providerResponseError(options, path, "must be a non-empty string");
  }

  return value;
}

function requireString(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): string {
  if (typeof value !== "string") {
    throw providerResponseError(options, path, "must be a string");
  }
  return value;
}

function optionalString(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requireString(value, path, options);
}

function parseUsage(
  value: unknown,
  options: { provider: string; model: string },
): ModelUsage | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const usage = requireRecord(value, "usage", options);
  const promptTokens = optionalTokenCount(
    usage.prompt_tokens,
    "usage.prompt_tokens",
    options,
  );
  const completionTokens = optionalTokenCount(
    usage.completion_tokens,
    "usage.completion_tokens",
    options,
  );
  const totalTokens = optionalTokenCount(
    usage.total_tokens,
    "usage.total_tokens",
    options,
  );
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    throw providerResponseError(
      options,
      "usage",
      "must contain at least one token count",
    );
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    source: "provider",
  };
}

function optionalTokenCount(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw providerResponseError(options, path, "must be a non-negative integer");
  }
  return value as number;
}

function providerResponseError(
  options: { provider: string; model: string },
  path: string,
  detail: string,
): Error {
  return new Error(
    `Invalid provider response (provider=${options.provider}, model=${options.model}): ${path} ${detail}.`,
  );
}
