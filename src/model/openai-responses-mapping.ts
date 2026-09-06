import type {
  EasyInputMessage,
  FunctionTool,
  ResponseInputItem,
  ResponseInputMessageContentList,
} from "openai/resources/responses/responses";
import type {
  AgentMessage,
  IterationIdentity,
  ToolCall,
  UserMessage,
} from "../agent/types";
import {
  toolResultText,
  validateToolResultContent,
} from "../agent/tool-result-content";
import type { RuntimeSessionContext } from "../agent/runtime-session";
import {
  parseImageAssetId,
  validateUserMessage,
  type ImageAssetId,
} from "../image/image-types";
import type { ToolDefinition } from "../tools/types";
import {
  ProviderResponseError,
  type ModelRequestOutput,
  type ModelUsage,
  type ProviderResponseDiagnostics,
} from "./model-client";
import { imageAssetUrlMarker } from "./openai-image-mapping";
import { sanitizedProviderError } from "./openai-model-utils";

export type OpenAIResponsesMappingOptions = {
  materializedImages?: ReadonlyMap<ImageAssetId, string>;
};

export function toOpenAIResponsesInput(
  messages: readonly AgentMessage[],
  options: OpenAIResponsesMappingOptions = {},
): ResponseInputItem[] {
  return messages.flatMap((message) => toOpenAIResponsesItems(message, options));
}

export function toOpenAIResponsesItems(
  message: AgentMessage,
  options: OpenAIResponsesMappingOptions = {},
): ResponseInputItem[] {
  if (message.role === "assistant") {
    const items: ResponseInputItem[] = [];
    if (message.content !== undefined && message.content !== null) {
      items.push({
        type: "message",
        role: "assistant",
        content: message.content,
      } satisfies EasyInputMessage);
    }
    for (const call of message.toolCalls ?? []) {
      items.push({
        type: "function_call",
        call_id: call.providerToolCallId,
        name: call.name,
        arguments: toolArguments(call),
      });
    }
    return items;
  }

  if (message.role === "tool") {
    validateToolResultContent(message.content);
    const hasImage = message.content.some((block) => block.type === "image");
    return [
      {
        type: "function_call_output",
        call_id: message.providerToolCallId,
        output: hasImage
          ? message.content.map((block) =>
              block.type === "text"
                ? ({ type: "input_text", text: block.text } as const)
                : ({
                    type: "input_image",
                    detail: "auto" as const,
                    image_url:
                      options.materializedImages === undefined
                        ? (imageAssetUrlMarker(
                            block.asset.assetId,
                          ) as unknown as string)
                        : requireMaterializedImage(
                            options.materializedImages,
                            block.asset.assetId,
                          ),
                  } as const),
            )
          : toolResultText(message.content),
      },
    ];
  }

  if (message.role === "user") {
    return [
      {
        type: "message",
        role: "user",
        content: toOpenAIResponsesUserContent(message, options.materializedImages),
      },
    ];
  }

  return [{ type: "message", role: "system", content: message.content }];
}

export function toOpenAIResponsesUserContent(
  message: UserMessage,
  materializedImages?: ReadonlyMap<ImageAssetId, string>,
): string | ResponseInputMessageContentList {
  validateUserMessage(message);
  const attachments = message.attachments;
  if (attachments === undefined) {
    return message.content;
  }
  return [
    ...attachments.flatMap(
      (attachment): ResponseInputMessageContentList => [
        { type: "input_text", text: `<image name=${attachment.label}>` },
        {
          type: "input_image",
          detail: "auto",
          image_url:
            materializedImages === undefined
              ? (imageAssetUrlMarker(attachment.assetId) as unknown as string)
              : requireMaterializedImage(materializedImages, attachment.assetId),
        },
        { type: "input_text", text: "</image>" },
      ],
    ),
    { type: "input_text", text: message.content },
  ];
}

export function toOpenAIResponsesTools(
  tools: readonly ToolDefinition[],
): FunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

export function fromOpenAIResponse(
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
  const root = requireRecord(response, "response", options);
  const status = requireString(root.status, "status", options);
  if (status === "failed") {
    const error = requireRecord(root.error, "error", options);
    const code = requireString(error.code, "error.code", options);
    const message = requireString(error.message, "error.message", options);
    throw sanitizedProviderError(
      Object.assign(new Error(message), { code }),
      options.provider,
      options.model,
    );
  }
  if (status !== "completed" && status !== "incomplete") {
    throw providerResponseError(
      options,
      "status",
      `must be a terminal success status, received ${JSON.stringify(status)}`,
    );
  }
  if (!Array.isArray(root.output)) {
    throw providerResponseError(options, "output", "must be an array");
  }

  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const rawToolCalls: { raw: unknown; path: string }[] = [];
  for (let outputIndex = 0; outputIndex < root.output.length; outputIndex += 1) {
    const path = `output[${outputIndex}]`;
    const item = requireRecord(root.output[outputIndex], path, options);
    const type = requireString(item.type, `${path}.type`, options);
    if (type === "message") {
      parseOutputMessage(item, path, contentParts, options);
    } else if (type === "function_call") {
      rawToolCalls.push({ raw: item, path });
    } else if (type === "reasoning") {
      parseReasoningItem(item, path, reasoningParts, options);
    }
  }

  const content = contentParts.length === 0 ? null : contentParts.join("");
  const reasoningContent =
    reasoningParts.length === 0 ? null : reasoningParts.join("\n\n");
  const usage = parseUsage(root.usage, options);
  const incompleteReason =
    status === "incomplete"
      ? optionalIncompleteReason(root.incomplete_details, options)
      : undefined;
  const finishReason =
    rawToolCalls.length > 0 ? "tool_calls" : (incompleteReason ?? "stop");
  const diagnostics = responseDiagnostics(options, {
    path: "output",
    finishReason,
    contentChars: content?.length ?? 0,
    reasoningChars: reasoningContent?.length ?? 0,
    toolCallCount: rawToolCalls.length,
    usage,
  });

  if ((content === null || content.trim() === "") && rawToolCalls.length === 0) {
    if (reasoningContent !== null && reasoningContent.trim() !== "") {
      throw new ProviderResponseError(
        "reasoning_only_assistant",
        `Invalid provider response (provider=${options.provider}, model=${options.model}): output contains reasoning but neither non-empty final text nor function calls.`,
        diagnostics,
      );
    }
    throw providerResponseError(
      options,
      "output",
      "has neither non-empty text nor function calls",
      diagnostics,
    );
  }

  if (rawToolCalls.length > 0 && options.identity === undefined) {
    throw providerResponseError(
      options,
      "output",
      "contains function calls but has no iteration identity context",
      diagnostics,
    );
  }
  const toolCalls = rawToolCalls.map(({ raw, path }, index) =>
    parseToolCall(raw, path, index, options.identity!, options),
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

function parseOutputMessage(
  item: Record<string, unknown>,
  path: string,
  parts: string[],
  options: { provider: string; model: string },
): void {
  if (item.role !== "assistant") {
    throw providerResponseError(options, `${path}.role`, 'must be "assistant"');
  }
  if (!Array.isArray(item.content)) {
    throw providerResponseError(options, `${path}.content`, "must be an array");
  }
  for (let index = 0; index < item.content.length; index += 1) {
    const contentPath = `${path}.content[${index}]`;
    const content = requireRecord(item.content[index], contentPath, options);
    const type = requireString(content.type, `${contentPath}.type`, options);
    if (type === "output_text") {
      parts.push(requireString(content.text, `${contentPath}.text`, options));
    } else if (type === "refusal") {
      parts.push(requireString(content.refusal, `${contentPath}.refusal`, options));
    } else {
      throw providerResponseError(
        options,
        `${contentPath}.type`,
        `is unsupported: ${JSON.stringify(type)}`,
      );
    }
  }
}

function parseReasoningItem(
  item: Record<string, unknown>,
  path: string,
  parts: string[],
  options: { provider: string; model: string },
): void {
  const contentParts = parseReasoningParts(
    item.content,
    `${path}.content`,
    "reasoning_text",
    options,
  );
  if (contentParts.length > 0) {
    parts.push(...contentParts);
    return;
  }
  parts.push(
    ...parseReasoningParts(item.summary, `${path}.summary`, "summary_text", options),
  );
}

function parseReasoningParts(
  value: unknown,
  path: string,
  expectedType: "reasoning_text" | "summary_text",
  options: { provider: string; model: string },
): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw providerResponseError(options, path, "must be an array");
  }
  return value.map((raw, index) => {
    const partPath = `${path}[${index}]`;
    const part = requireRecord(raw, partPath, options);
    if (part.type !== expectedType) {
      throw providerResponseError(
        options,
        `${partPath}.type`,
        `must be ${JSON.stringify(expectedType)}`,
      );
    }
    return requireString(part.text, `${partPath}.text`, options);
  });
}

function parseToolCall(
  raw: unknown,
  path: string,
  index: number,
  context: {
    iteration: IterationIdentity;
    runtimeSession: RuntimeSessionContext;
  },
  options: { provider: string; model: string },
): ToolCall {
  const item = requireRecord(raw, path, options);
  const providerToolCallId = requireNonEmptyString(
    item.call_id,
    `${path}.call_id`,
    options,
  );
  const name = requireNonEmptyString(item.name, `${path}.name`, options);
  const rawArgs = requireString(item.arguments, `${path}.arguments`, options);
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

function parseUsage(
  value: unknown,
  options: { provider: string; model: string },
): ModelUsage {
  const usage = requireRecord(value, "usage", options);
  const promptTokens = requireNonNegativeInteger(
    usage.input_tokens,
    "usage.input_tokens",
    options,
  );
  const completionTokens = requireNonNegativeInteger(
    usage.output_tokens,
    "usage.output_tokens",
    options,
  );
  const totalTokens = requireNonNegativeInteger(
    usage.total_tokens,
    "usage.total_tokens",
    options,
  );
  if (totalTokens !== promptTokens + completionTokens) {
    throw providerResponseError(
      options,
      "usage.total_tokens",
      `must equal usage.input_tokens + usage.output_tokens (${promptTokens + completionTokens})`,
    );
  }
  const inputDetails = optionalRecord(
    usage.input_tokens_details,
    "usage.input_tokens_details",
    options,
  );
  const outputDetails = optionalRecord(
    usage.output_tokens_details,
    "usage.output_tokens_details",
    options,
  );
  const cachedTokens = optionalNonNegativeInteger(
    inputDetails?.cached_tokens,
    "usage.input_tokens_details.cached_tokens",
    options,
  );
  const reasoningTokens = optionalNonNegativeInteger(
    outputDetails?.reasoning_tokens,
    "usage.output_tokens_details.reasoning_tokens",
    options,
  );
  if (cachedTokens !== undefined && cachedTokens > promptTokens) {
    throw providerResponseError(
      options,
      "usage.input_tokens_details.cached_tokens",
      "must not exceed usage.input_tokens",
    );
  }
  if (reasoningTokens !== undefined && reasoningTokens > completionTokens) {
    throw providerResponseError(
      options,
      "usage.output_tokens_details.reasoning_tokens",
      "must not exceed usage.output_tokens",
    );
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedTokens === undefined
      ? {}
      : {
          promptCacheHitTokens: cachedTokens,
          promptCacheMissTokens: promptTokens - cachedTokens,
        }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function optionalIncompleteReason(
  value: unknown,
  options: { provider: string; model: string },
): string | undefined {
  if (value === undefined || value === null) {
    return "incomplete";
  }
  const details = requireRecord(value, "incomplete_details", options);
  return requireNonEmptyString(details.reason, "incomplete_details.reason", options);
}

function toolArguments(call: ToolCall): string {
  return (
    call.rawArgs ??
    (typeof call.args === "string" ? call.args : JSON.stringify(call.args))
  );
}

function requireMaterializedImage(
  materializedImages: ReadonlyMap<ImageAssetId, string>,
  assetId: ImageAssetId,
): string {
  parseImageAssetId(assetId);
  const dataUrl = materializedImages.get(assetId);
  if (dataUrl === undefined) {
    throw new Error(`Image asset ${assetId.slice(0, 12)}… was not materialized.`);
  }
  return dataUrl;
}

function requireRecord(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw providerResponseError(options, path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalRecord(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireRecord(value, path, options);
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

function requireNonEmptyString(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): string {
  const string = requireString(value, path, options);
  if (string.trim() === "") {
    throw providerResponseError(options, path, "must be non-empty");
  }
  return string;
}

function requireNonNegativeInteger(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw providerResponseError(options, path, "must be a non-negative integer");
  }
  return value as number;
}

function optionalNonNegativeInteger(
  value: unknown,
  path: string,
  options: { provider: string; model: string },
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireNonNegativeInteger(value, path, options);
}

function providerResponseError(
  options: { provider: string; model: string },
  path: string,
  detail: string,
  diagnostics: ProviderResponseDiagnostics = responseDiagnostics(options, {
    path,
  }),
): ProviderResponseError {
  return new ProviderResponseError(
    "invalid_provider_response",
    `Invalid provider response (provider=${options.provider}, model=${options.model}): ${path} ${detail}.`,
    diagnostics,
  );
}

function responseDiagnostics(
  options: { provider: string; model: string },
  diagnostics: Omit<ProviderResponseDiagnostics, "provider" | "model">,
): ProviderResponseDiagnostics {
  return { provider: options.provider, model: options.model, ...diagnostics };
}
