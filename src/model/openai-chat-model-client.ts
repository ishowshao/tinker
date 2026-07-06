import OpenAI from "openai";
import type { ModelClient, ModelStepInput, ModelStepOutput } from "./model-client";
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
      model: string;
      timeoutMs?: number;
    },
  ) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs,
    });
  }

  async step(input: ModelStepInput): Promise<ModelStepOutput> {
    const response = await this.client.chat.completions.create({
      model: this.options.model,
      messages: toOpenAIChatMessages(input.messages),
      tools: toOpenAIChatTools(input.tools),
      tool_choice: input.tools.length > 0 ? "auto" : "none",
    });

    return fromOpenAIChatCompletion(response);
  }
}
