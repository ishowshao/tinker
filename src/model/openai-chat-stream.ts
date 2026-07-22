import { ProviderResponseError } from "./model-client";

type ProviderContext = { provider: string; model: string };

type ToolCallAccumulator = {
  id?: string;
  type?: "function";
  name?: string;
  arguments: string;
};

/**
 * Reassembles OpenAI chat completion stream chunks into a non-streaming
 * chat.completion-shaped object so the result can be validated and mapped by
 * fromOpenAIChatCompletion exactly like a non-streaming response.
 */
export function accumulateOpenAIChatCompletionChunks(
  chunks: readonly unknown[],
  options: ProviderContext,
): Record<string, unknown> {
  if (chunks.length === 0) {
    throw providerStreamError(options, "chunks", "must not be empty");
  }

  let role: "assistant" | undefined;
  let content: string | undefined;
  let reasoningContent: string | undefined;
  let finishReason: string | undefined;
  let resolvedModel: string | undefined;
  let usage: Record<string, unknown> | undefined;
  const toolCalls: ToolCallAccumulator[] = [];

  chunks.forEach((chunk, chunkIndex) => {
    const path = `chunk[${chunkIndex}]`;
    const record = requireRecord(chunk, path, options);

    if (record.model !== undefined && record.model !== null) {
      if (typeof record.model !== "string" || record.model.trim() === "") {
        throw providerStreamError(options, `${path}.model`, "must be a string");
      }
      if (resolvedModel !== undefined && resolvedModel !== record.model) {
        throw providerStreamError(
          options,
          `${path}.model`,
          `conflicts with previously streamed model ${JSON.stringify(resolvedModel)}`,
        );
      }
      resolvedModel = record.model;
    }

    if (record.usage !== undefined && record.usage !== null) {
      usage = requireRecord(record.usage, `${path}.usage`, options);
    }

    if (record.choices === undefined || record.choices === null) {
      return;
    }
    if (!Array.isArray(record.choices)) {
      throw providerStreamError(options, `${path}.choices`, "must be an array");
    }
    // The usage-only final chunk from stream_options.include_usage has empty choices.
    for (const [choiceIndex, rawChoice] of record.choices.entries()) {
      const choicePath = `${path}.choices[${choiceIndex}]`;
      const choice = requireRecord(rawChoice, choicePath, options);
      if (choice.index !== 0) {
        throw providerStreamError(options, `${choicePath}.index`, "must be 0");
      }
      if (typeof choice.finish_reason === "string") {
        finishReason = choice.finish_reason;
      } else if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        throw providerStreamError(
          options,
          `${choicePath}.finish_reason`,
          "must be a string or null",
        );
      }

      if (choice.delta === undefined || choice.delta === null) {
        continue;
      }
      const deltaPath = `${choicePath}.delta`;
      const delta = asRecord(choice.delta, deltaPath, options);
      if (delta.role !== undefined && delta.role !== null) {
        if (delta.role !== "assistant") {
          throw providerStreamError(
            options,
            `${deltaPath}.role`,
            'must be "assistant"',
          );
        }
        role = delta.role;
      }
      content = appendOptionalText(
        content,
        delta.content,
        `${deltaPath}.content`,
        options,
      );
      reasoningContent = appendOptionalText(
        reasoningContent,
        delta.reasoning_content,
        `${deltaPath}.reasoning_content`,
        options,
      );
      if (delta.tool_calls === undefined || delta.tool_calls === null) {
        continue;
      }
      if (!Array.isArray(delta.tool_calls)) {
        throw providerStreamError(
          options,
          `${deltaPath}.tool_calls`,
          "must be an array",
        );
      }
      for (const [fragmentIndex, rawFragment] of delta.tool_calls.entries()) {
        mergeToolCallFragment(
          toolCalls,
          rawFragment,
          `${deltaPath}.tool_calls[${fragmentIndex}]`,
          options,
        );
      }
    }
  });

  // Only fields the provider actually streamed are emitted; the strict
  // non-streaming mapper rejects a missing role, id, type, or name.
  const message: Record<string, unknown> = {
    ...(role === undefined ? {} : { role }),
    content: content ?? null,
    ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent }),
    ...(toolCalls.length === 0
      ? {}
      : {
          tool_calls: toolCalls.map((call) => ({
            ...(call.id === undefined ? {} : { id: call.id }),
            ...(call.type === undefined ? {} : { type: call.type }),
            function: {
              ...(call.name === undefined ? {} : { name: call.name }),
              arguments: call.arguments,
            },
          })),
        }),
  };

  return {
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason ?? null,
      },
    ],
    ...(usage === undefined ? {} : { usage }),
    ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
  };
}

function mergeToolCallFragment(
  toolCalls: ToolCallAccumulator[],
  rawFragment: unknown,
  path: string,
  options: ProviderContext,
): void {
  const fragment = requireRecord(rawFragment, path, options);
  const index = fragment.index;
  if (!Number.isSafeInteger(index) || (index as number) < 0) {
    throw providerStreamError(
      options,
      `${path}.index`,
      "must be a non-negative integer",
    );
  }
  if ((index as number) > toolCalls.length) {
    throw providerStreamError(
      options,
      `${path}.index`,
      `skips tool call index ${toolCalls.length}`,
    );
  }
  const entry =
    toolCalls[index as number] ?? (toolCalls[index as number] = { arguments: "" });

  if (fragment.type !== undefined && fragment.type !== null) {
    if (fragment.type !== "function") {
      throw providerStreamError(options, `${path}.type`, 'must be "function"');
    }
    entry.type = fragment.type;
  }
  if (fragment.id !== undefined && fragment.id !== null) {
    if (typeof fragment.id !== "string" || fragment.id === "") {
      throw providerStreamError(options, `${path}.id`, "must be a non-empty string");
    }
    if (entry.id !== undefined && entry.id !== fragment.id) {
      throw providerStreamError(
        options,
        `${path}.id`,
        `conflicts with previously streamed id ${JSON.stringify(entry.id)}`,
      );
    }
    entry.id = fragment.id;
  }
  if (fragment.function === undefined || fragment.function === null) {
    return;
  }
  const fn = asRecord(fragment.function, `${path}.function`, options);
  if (fn.name !== undefined && fn.name !== null) {
    if (typeof fn.name !== "string") {
      throw providerStreamError(options, `${path}.function.name`, "must be a string");
    }
    // Later name fragments replace the value (OpenAI aggregation semantics);
    // only arguments accumulate.
    entry.name = fn.name;
  }
  if (fn.arguments !== undefined && fn.arguments !== null) {
    if (typeof fn.arguments !== "string") {
      throw providerStreamError(
        options,
        `${path}.function.arguments`,
        "must be a string",
      );
    }
    entry.arguments += fn.arguments;
  }
}

function appendOptionalText(
  current: string | undefined,
  value: unknown,
  path: string,
  options: ProviderContext,
): string | undefined {
  if (value === undefined || value === null) {
    return current;
  }
  if (typeof value !== "string") {
    throw providerStreamError(options, path, "must be a string or null");
  }
  return (current ?? "") + value;
}

function asRecord(
  value: unknown,
  path: string,
  options: ProviderContext,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw providerStreamError(options, path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function requireRecord(
  value: unknown,
  path: string,
  options: ProviderContext,
): Record<string, unknown> {
  const record = asRecord(value, path, options);
  if (Object.keys(record).length === 0) {
    throw providerStreamError(options, path, "must be a non-empty object");
  }
  return record;
}

function providerStreamError(
  options: ProviderContext,
  path: string,
  detail: string,
): ProviderResponseError {
  return new ProviderResponseError(
    "invalid_provider_stream",
    `Invalid provider stream (provider=${options.provider}, model=${options.model}): ${path} ${detail}.`,
    { provider: options.provider, model: options.model, path },
  );
}
