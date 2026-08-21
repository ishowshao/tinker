import type {
  AgentMessage,
  IterationIdentity,
  ToolCall,
  UserMessage,
} from "../agent/types";
import type { RuntimeSessionContext } from "../agent/runtime-session";
import {
  ProviderResponseError,
  type ModelRequestOutput,
  type ModelUsage,
  type ProviderResponseDiagnostics,
} from "./model-client";
import type { ToolDefinition } from "../tools/types";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionContentPart,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { validateUserMessage, type ImageAssetId } from "../image/image-types";
import { imageAssetUrlMarker } from "./openai-image-mapping";
import { toolResultText } from "../agent/tool-result-content";

type DeepSeekAssistantMessageParam = ChatCompletionAssistantMessageParam & {
  reasoning_content?: string | null;
};

export type OpenAIChatMessageMappingOptions = {
  includeReasoningContent?: boolean;
  materializedImages?: ReadonlyMap<ImageAssetId, string>;
};

export function toOpenAIChatMessages(
  messages: readonly AgentMessage[],
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
        content: toolResultText(message.content),
      };
    }

    if (message.role === "user") {
      return {
        role: "user",
        content: toOpenAIUserContent(message, options.materializedImages),
      };
    }

    return message;
  });
}

export function toOpenAIUserContent(
  message: UserMessage,
  materializedImages?: ReadonlyMap<ImageAssetId, string>,
): string | ChatCompletionContentPart[] {
  validateUserMessage(message);
  const attachments = message.attachments;
  if (attachments === undefined) {
    return message.content;
  }
  return [
    ...attachments.flatMap((attachment): ChatCompletionContentPart[] => [
      { type: "text", text: `<image name=${attachment.label}>` },
      {
        type: "image_url",
        image_url: {
          url:
            materializedImages === undefined
              ? (imageAssetUrlMarker(attachment.assetId) as unknown as string)
              : requireMaterializedImage(materializedImages, attachment.assetId),
        },
      },
      { type: "text", text: "</image>" },
    ]),
    { type: "text", text: message.content },
  ];
}

function requireMaterializedImage(
  materializedImages: ReadonlyMap<ImageAssetId, string>,
  assetId: ImageAssetId,
): string {
  const dataUrl = materializedImages.get(assetId);
  if (dataUrl === undefined) {
    throw new Error(`Image asset ${assetId.slice(0, 12)}… was not materialized.`);
  }
  return dataUrl;
}

export function toOpenAIChatTools(
  tools: readonly ToolDefinition[],
): ChatCompletionTool[] {
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
  const content = normalizeContent(
    message.content,
    "choices[0].message.content",
    options,
  );
  const finishReason = optionalString(
    choice.finish_reason,
    "choices[0].finish_reason",
    options,
  );
  const usage = parseUsage(completion.usage, options);
  const reasoningContent = normalizeContent(
    message.reasoning_content,
    "choices[0].message.reasoning_content",
    options,
  );
  const diagnostics = responseDiagnostics(options, {
    path: "choices[0].message",
    finishReason,
    contentChars: content?.length ?? 0,
    reasoningChars: reasoningContent?.length ?? 0,
    toolCallCount: rawToolCalls.length,
    usage,
  });
  if ((content === null || content.trim() === "") && rawToolCalls.length === 0) {
    if (
      finishReason === "stop" &&
      reasoningContent !== null &&
      reasoningContent.trim() !== ""
    ) {
      throw new ProviderResponseError(
        "reasoning_only_assistant",
        `Invalid provider response (provider=${options.provider}, model=${options.model}): choices[0].message contains reasoning but neither non-empty final text nor tool calls.`,
        diagnostics,
      );
    }
    throw providerResponseError(
      options,
      "choices[0].message",
      "has neither non-empty text nor tool calls",
      diagnostics,
    );
  }

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

  return {
    message: {
      role: "assistant",
      content,
      reasoningContent,
      toolCalls: toolCalls.length === 0 ? undefined : toolCalls,
    },
    finishReason,
    usage,
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
): ModelUsage {
  if (value === undefined || value === null) {
    throw providerResponseError(options, "usage", "is required");
  }

  const usage = requireRecord(value, "usage", options);
  const promptTokens = requireTokenCount(
    usage.prompt_tokens,
    "usage.prompt_tokens",
    options,
  );
  const completionTokens = requireTokenCount(
    usage.completion_tokens,
    "usage.completion_tokens",
    options,
  );
  const totalTokens = requireTokenCount(
    usage.total_tokens,
    "usage.total_tokens",
    options,
  );
  if (totalTokens !== promptTokens + completionTokens) {
    throw providerResponseError(
      options,
      "usage.total_tokens",
      `must equal usage.prompt_tokens + usage.completion_tokens (${promptTokens + completionTokens})`,
    );
  }

  const directHit = optionalTokenCount(
    usage.prompt_cache_hit_tokens,
    "usage.prompt_cache_hit_tokens",
    options,
  );
  const directMiss = optionalTokenCount(
    usage.prompt_cache_miss_tokens,
    "usage.prompt_cache_miss_tokens",
    options,
  );
  if ((directHit === undefined) !== (directMiss === undefined)) {
    throw providerResponseError(
      options,
      "usage.prompt_cache_hit_tokens",
      "and usage.prompt_cache_miss_tokens must be provided together",
    );
  }

  const cachedTokens = parseNestedTokenCount(
    usage.prompt_tokens_details,
    "usage.prompt_tokens_details",
    "cached_tokens",
    options,
  );
  const detailHit = cachedTokens;
  const detailMiss =
    cachedTokens === undefined ? undefined : promptTokens - cachedTokens;
  if (detailMiss !== undefined && detailMiss < 0) {
    throw providerResponseError(
      options,
      "usage.prompt_tokens_details.cached_tokens",
      "must not exceed usage.prompt_tokens",
    );
  }
  if (
    directHit !== undefined &&
    (directHit !== detailHit || directMiss !== detailMiss) &&
    detailHit !== undefined
  ) {
    throw providerResponseError(
      options,
      "usage.prompt_cache_hit_tokens",
      "conflicts with usage.prompt_tokens_details.cached_tokens",
    );
  }

  const promptCacheHitTokens = directHit ?? detailHit;
  const promptCacheMissTokens = directMiss ?? detailMiss;
  if (
    promptCacheHitTokens !== undefined &&
    promptCacheMissTokens !== undefined &&
    promptCacheHitTokens + promptCacheMissTokens !== promptTokens
  ) {
    throw providerResponseError(
      options,
      "usage.prompt_cache_hit_tokens",
      "plus usage.prompt_cache_miss_tokens must equal usage.prompt_tokens",
    );
  }

  const reasoningTokens = parseNestedTokenCount(
    usage.completion_tokens_details,
    "usage.completion_tokens_details",
    "reasoning_tokens",
    options,
  );
  if (reasoningTokens !== undefined && reasoningTokens > completionTokens) {
    throw providerResponseError(
      options,
      "usage.completion_tokens_details.reasoning_tokens",
      "must not exceed usage.completion_tokens",
    );
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(promptCacheHitTokens === undefined
      ? {}
      : { promptCacheHitTokens, promptCacheMissTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function requireTokenCount(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): number {
  const count = optionalTokenCount(value, path, options);
  if (count === undefined) {
    throw providerResponseError(options, path, "is required");
  }
  return count;
}

function parseNestedTokenCount(
  value: unknown,
  path: string,
  property: string,
  options: { provider: string; model: string },
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = requireObject(value, path, options);
  return optionalTokenCount(record[property], `${path}.${property}`, options);
}

function requireObject(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw providerResponseError(options, path, "must be an object");
  }
  return value as Record<string, unknown>;
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
  diagnostics: ProviderResponseDiagnostics = responseDiagnostics(options, { path }),
): ProviderResponseError {
  return new ProviderResponseError(
    "invalid_provider_response",
    `Invalid provider response (provider=${options.provider}, model=${options.model}): ${path} ${detail}.`,
    { ...diagnostics, path },
  );
}

function responseDiagnostics(
  options: { provider: string; model: string },
  diagnostics: Omit<ProviderResponseDiagnostics, "provider" | "model">,
): ProviderResponseDiagnostics {
  return {
    provider: options.provider,
    model: options.model,
    ...diagnostics,
  };
}
