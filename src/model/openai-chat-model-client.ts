import OpenAI from "openai";
import type {
  ModelClient,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
} from "./model-client";
import {
  fromOpenAIChatCompletion,
  toOpenAIChatMessages,
  toOpenAIChatTools,
} from "./openai-chat-mapping";

export class OpenAIChatModelClient implements ModelClient {
  private readonly client: OpenAI;

  constructor(
    private readonly options: {
      apiKey: string;
      baseURL?: string;
      includeReasoningContent?: boolean;
      model: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs,
      fetch: options.fetch,
    });
  }

  async request(
    input: ModelRequestInput,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const response = await this.client.chat.completions.create(
      {
        model: this.options.model,
        messages: toOpenAIChatMessages(input.messages, {
          includeReasoningContent: this.options.includeReasoningContent,
        }),
        tools: input.tools.length > 0 ? toOpenAIChatTools(input.tools) : undefined,
        tool_choice: input.tools.length > 0 ? "auto" : undefined,
      },
      { signal: options.signal },
    );

    return fromOpenAIChatCompletion(response, options.identity);
  }
}
