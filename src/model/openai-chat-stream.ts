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
export class OpenAIChatCompletionStreamAccumulator {
  private chunkCount = 0;
  private role: "assistant" | undefined;
  private content: string | undefined;
  private reasoningContent: string | undefined;
  private finishReason: string | undefined;
  private resolvedModel: string | undefined;
  private usage: Record<string, unknown> | undefined;
  private readonly toolCalls: ToolCallAccumulator[] = [];

  constructor(private readonly options: ProviderContext) {}

  push(chunk: unknown): string | undefined {
    const chunkIndex = this.chunkCount;
    this.chunkCount += 1;
    const path = `chunk[${chunkIndex}]`;
    const record = requireRecord(chunk, path, this.options);
    let chunkContent: string | undefined;

    if (record.model !== undefined && record.model !== null) {
      if (typeof record.model !== "string" || record.model.trim() === "") {
        throw providerStreamError(this.options, `${path}.model`, "must be a string");
      }
      if (this.resolvedModel !== undefined && this.resolvedModel !== record.model) {
        throw providerStreamError(
          this.options,
          `${path}.model`,
          `conflicts with previously streamed model ${JSON.stringify(this.resolvedModel)}`,
        );
      }
      this.resolvedModel = record.model;
    }

    if (record.usage !== undefined && record.usage !== null) {
      this.usage = requireRecord(record.usage, `${path}.usage`, this.options);
    }

    if (record.choices === undefined || record.choices === null) {
      return chunkContent;
    }
    if (!Array.isArray(record.choices)) {
      throw providerStreamError(this.options, `${path}.choices`, "must be an array");
    }
    // The usage-only final chunk from stream_options.include_usage has empty choices.
    for (const [choiceIndex, rawChoice] of record.choices.entries()) {
      const choicePath = `${path}.choices[${choiceIndex}]`;
      const choice = requireRecord(rawChoice, choicePath, this.options);
      if (choice.index !== 0) {
        throw providerStreamError(this.options, `${choicePath}.index`, "must be 0");
      }
      if (typeof choice.finish_reason === "string") {
        this.finishReason = choice.finish_reason;
      } else if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        throw providerStreamError(
          this.options,
          `${choicePath}.finish_reason`,
          "must be a string or null",
        );
      }

      if (choice.delta === undefined || choice.delta === null) {
        continue;
      }
      const deltaPath = `${choicePath}.delta`;
      const delta = asRecord(choice.delta, deltaPath, this.options);
      if (delta.role !== undefined && delta.role !== null) {
        if (delta.role !== "assistant") {
          throw providerStreamError(
            this.options,
            `${deltaPath}.role`,
            'must be "assistant"',
          );
        }
        this.role = delta.role;
      }
      const contentDelta = appendOptionalText(
        undefined,
        delta.content,
        `${deltaPath}.content`,
        this.options,
      );
      if (contentDelta !== undefined) {
        this.content = (this.content ?? "") + contentDelta;
        chunkContent = (chunkContent ?? "") + contentDelta;
      }
      this.reasoningContent = appendOptionalText(
        this.reasoningContent,
        delta.reasoning_content,
        `${deltaPath}.reasoning_content`,
        this.options,
      );
      if (delta.tool_calls === undefined || delta.tool_calls === null) {
        continue;
      }
      if (!Array.isArray(delta.tool_calls)) {
        throw providerStreamError(
          this.options,
          `${deltaPath}.tool_calls`,
          "must be an array",
        );
      }
      for (const [fragmentIndex, rawFragment] of delta.tool_calls.entries()) {
        mergeToolCallFragment(
          this.toolCalls,
          rawFragment,
          `${deltaPath}.tool_calls[${fragmentIndex}]`,
          this.options,
        );
      }
    }
    return chunkContent;
  }

  finish(): Record<string, unknown> {
    if (this.chunkCount === 0) {
      throw providerStreamError(this.options, "chunks", "must not be empty");
    }

    // Only fields the provider actually streamed are emitted; the strict
    // non-streaming mapper rejects a missing role, id, type, or name.
    const message: Record<string, unknown> = {
      ...(this.role === undefined ? {} : { role: this.role }),
      content: this.content ?? null,
      ...(this.reasoningContent === undefined
        ? {}
        : { reasoning_content: this.reasoningContent }),
      ...(this.toolCalls.length === 0
        ? {}
        : {
            tool_calls: this.toolCalls.map((call) => ({
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
          finish_reason: this.finishReason ?? null,
        },
      ],
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      ...(this.resolvedModel === undefined ? {} : { model: this.resolvedModel }),
    };
  }
}

export function accumulateOpenAIChatCompletionChunks(
  chunks: readonly unknown[],
  options: ProviderContext,
): Record<string, unknown> {
  const accumulator = new OpenAIChatCompletionStreamAccumulator(options);
  for (const chunk of chunks) {
    accumulator.push(chunk);
  }
  return accumulator.finish();
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
