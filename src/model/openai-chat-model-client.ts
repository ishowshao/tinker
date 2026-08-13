import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { AssistantMessage } from "../agent/types";
import {
  IMAGE_INPUT_POLICY,
  IMAGE_INPUT_POLICY_VERSION,
} from "../image/image-input-policy";
import type { ModelContextBudget } from "./model-context-profile";
import type { InputTokenEstimator } from "./input-token-estimator";
import { ProviderResponseError } from "./model-client";
import type {
  MaterializedModelRequest,
  ModelClient,
  ModelMaterializeOptions,
  ModelMessageProtocol,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
  PreparedPromptSegment,
} from "./model-client";
import {
  fromOpenAIChatCompletion,
  toOpenAIChatMessages,
  toOpenAIChatTools,
} from "./openai-chat-mapping";
import { OpenAIChatCompletionStreamAccumulator } from "./openai-chat-stream";
import {
  deepFreeze,
  imageUserSegment,
  materializeOpenAIRequest,
  normalizedEndpointPolicy,
  sanitizedProviderError,
  segmentKind,
} from "./openai-model-utils";
import { MoonshotInputTokenEstimator } from "./moonshot-input-token-estimator";
import type { ReasoningEffortController } from "./reasoning-effort";
import { sha256, stableJsonStringify } from "./model-request-preflight";

const OPENAI_CHAT_SERIALIZATION_VERSION = "openai-chat-v2";
const OPENAI_CHAT_TIMEOUT_MS = 30 * 60 * 1_000;

export class OpenAIChatModelClient implements ModelClient {
  readonly messageProtocol: ModelMessageProtocol = Object.freeze({
    adapter: "openai-chat",
    serializationVersion: OPENAI_CHAT_SERIALIZATION_VERSION,
  });
  readonly inputTokenEstimator?: InputTokenEstimator;
  readonly reasoningEffort?: ReasoningEffortController;
  private readonly client: OpenAI;
  private readonly preparedRequests = new WeakSet<object>();
  private readonly materializedRequests = new WeakSet<object>();
  private readonly provider: string;
  private readonly stream: boolean;
  readonly inputModalities: readonly ("text" | "image")[];

  constructor(
    private readonly options: {
      apiKey: string;
      contextBudget: ModelContextBudget;
      baseURL?: string;
      includeReasoningContent?: boolean;
      inputModalities?: readonly ("text" | "image")[];
      tokenEstimator?: {
        kind: "moonshot-estimate-token-count-v1";
        model: string;
        apiBase: string;
        apiKey: string;
        timeoutMs: number;
        maxRetries: 0;
      };
      model: string;
      providerName?: string;
      reasoningEffort?: ReasoningEffortController;
      stream?: boolean;
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {
    this.provider = options.providerName ?? "openai-compatible";
    this.stream = options.stream ?? true;
    this.reasoningEffort = options.reasoningEffort;
    this.inputModalities = Object.freeze([...(options.inputModalities ?? ["text"])]);
    const supportsImages = this.inputModalities.includes("image");
    if (!this.inputModalities.includes("text")) {
      throw new Error('OpenAI chat input modalities must include "text".');
    }
    if (supportsImages && options.tokenEstimator === undefined) {
      throw new Error("Image-capable OpenAI chat requires a token estimator.");
    }
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? OPENAI_CHAT_TIMEOUT_MS,
      // Retries are orchestrated by the agent loop so they surface as
      // cancellable, observable runtime events instead of hidden SDK waits.
      maxRetries: 0,
      fetch: options.fetch,
    });
    if (options.tokenEstimator !== undefined) {
      this.inputTokenEstimator = new MoonshotInputTokenEstimator({
        apiKey: options.tokenEstimator.apiKey,
        baseURL: options.tokenEstimator.apiBase,
        model: options.tokenEstimator.model,
        timeoutMs: options.tokenEstimator.timeoutMs,
        fetch: options.fetch,
      });
    }
  }

  prepare(input: ModelRequestInput): PreparedModelRequest {
    const messages = toOpenAIChatMessages(input.messages, {
      includeReasoningContent: this.options.includeReasoningContent,
    });
    const tools = input.tools.length > 0 ? toOpenAIChatTools(input.tools) : undefined;
    const reasoningEffort = this.reasoningEffort?.snapshot().effort;
    const payload = deepFreeze({
      model: this.options.model,
      messages,
      ...(tools === undefined ? {} : { tools, tool_choice: "auto" as const }),
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
      max_completion_tokens: this.options.contextBudget.requestMaxOutputTokens,
      ...(this.stream
        ? {
            stream: true as const,
            stream_options: { include_usage: true as const },
          }
        : {}),
    });
    const toolSegments = (tools ?? []).map(
      (tool): PreparedPromptSegment => ({
        kind: "tool_schema",
        normalizedText: stableJsonStringify(tool),
      }),
    );
    const messageSegments = input.messages.map(
      (message, index): PreparedPromptSegment =>
        message.role === "user" && message.attachments !== undefined
          ? imageUserSegment(message)
          : {
              kind: segmentKind(message.role),
              normalizedText: stableJsonStringify(messages[index]),
            },
    );
    const mediaOccurrenceCount = messageSegments.reduce(
      (total, segment) => total + (segment.media?.length ?? 0),
      0,
    );
    const requestConfigHash = sha256(
      stableJsonStringify({
        adapter: this.messageProtocol.adapter,
        serializationVersion: this.messageProtocol.serializationVersion,
        endpoint: normalizedEndpointPolicy(this.options.baseURL),
        model: this.options.model,
        requestMaxOutputTokens: this.options.contextBudget.requestMaxOutputTokens,
        includeReasoningContent: this.options.includeReasoningContent === true,
        stream: this.stream,
        inputModalities: this.inputModalities,
        requestPolicy: { toolChoice: "auto" },
        imagePolicy: {
          version: IMAGE_INPUT_POLICY_VERSION,
          ...IMAGE_INPUT_POLICY,
        },
        ...(this.inputTokenEstimator === undefined
          ? {}
          : { tokenEstimator: this.inputTokenEstimator.compatibility }),
      }),
    );
    const prepared: PreparedModelRequest = {
      provider: this.provider,
      model: this.options.model,
      payload,
      promptSegments: Object.freeze([...toolSegments, ...messageSegments]),
      requestConfigHash,
      toolSchemaHash: sha256(
        toolSegments.map((segment) => segment.normalizedText).join("\n"),
      ),
      requestMaxOutputTokens: this.options.contextBudget.requestMaxOutputTokens,
      mediaOccurrenceCount,
      assistantReplaySegments: (message) => this.assistantReplaySegments(message),
    };
    Object.freeze(prepared);
    this.preparedRequests.add(prepared);
    return prepared;
  }

  async materialize(
    prepared: PreparedModelRequest,
    options: ModelMaterializeOptions,
  ): Promise<MaterializedModelRequest> {
    this.assertPrepared(prepared);
    if (prepared.mediaOccurrenceCount > 0 && !this.inputModalities.includes("image")) {
      throw new Error("Current model profile does not support image input.");
    }
    const materialized = await materializeOpenAIRequest(prepared, options);
    this.materializedRequests.add(materialized);
    return materialized;
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.assertPrepared(prepared);
    if (prepared.mediaOccurrenceCount > 0 && !this.materializedRequests.has(prepared)) {
      throw new Error("Image request must be materialized before provider dispatch.");
    }

    const response = this.stream
      ? await this.requestStreaming(prepared, options)
      : await this.requestNonStreaming(prepared, options.signal);

    return fromOpenAIChatCompletion(response, {
      identity: options.identity,
      provider: this.provider,
      model: this.options.model,
    });
  }

  private async requestStreaming(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<Record<string, unknown>> {
    const accumulator = new OpenAIChatCompletionStreamAccumulator({
      provider: this.provider,
      model: this.options.model,
    });
    try {
      const stream = await this.client.chat.completions.create(
        prepared.payload as ChatCompletionCreateParamsStreaming,
        { signal: options.signal },
      );
      for await (const chunk of stream) {
        const content = accumulator.push(chunk);
        if (content !== undefined && content !== "") {
          options.onTextDelta?.(content);
        }
      }
      return accumulator.finish();
    } catch (error) {
      if (error instanceof ProviderResponseError) {
        throw error;
      }
      throw sanitizedProviderError(error, this.provider, this.options.model);
    }
  }

  private async requestNonStreaming(
    prepared: PreparedModelRequest,
    signal: AbortSignal,
  ) {
    try {
      return await this.client.chat.completions.create(
        prepared.payload as ChatCompletionCreateParamsNonStreaming,
        { signal },
      );
    } catch (error) {
      throw sanitizedProviderError(error, this.provider, this.options.model);
    }
  }

  private assistantReplaySegments(message: AssistantMessage): PreparedPromptSegment[] {
    const [mapped] = toOpenAIChatMessages([message], {
      includeReasoningContent: this.options.includeReasoningContent,
    });
    if (mapped === undefined) {
      throw new Error("OpenAI assistant replay mapping produced no message.");
    }
    return [
      {
        kind: "assistant",
        normalizedText: stableJsonStringify(mapped),
      },
    ];
  }

  private assertPrepared(prepared: PreparedModelRequest): void {
    if (
      !this.preparedRequests.has(prepared) &&
      !this.materializedRequests.has(prepared)
    ) {
      throw new Error(
        `OpenAI chat request was not prepared by this client (provider=${this.provider}, model=${this.options.model}).`,
      );
    }
    if (
      prepared.provider !== this.provider ||
      prepared.model !== this.options.model ||
      prepared.requestMaxOutputTokens !==
        this.options.contextBudget.requestMaxOutputTokens
    ) {
      throw new Error(
        "Prepared OpenAI chat request configuration does not match client.",
      );
    }
  }
}

export { exactJsonBodyBytes } from "./openai-model-utils";
