import OpenAI from "openai";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses";
import type { AssistantMessage } from "../agent/types";
import {
  IMAGE_INPUT_POLICY,
  IMAGE_INPUT_POLICY_VERSION,
} from "../image/image-input-policy";
import type { ModelContextBudget } from "./model-context-profile";
import { ProviderResponseError, validateModelModalities } from "./model-client";
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
  deepFreeze,
  imageToolSegment,
  imageUserSegment,
  materializeOpenAIRequest,
  normalizedEndpointPolicy,
  sanitizedProviderError,
  segmentKind,
} from "./openai-model-utils";
import {
  fromOpenAIResponse,
  toOpenAIResponsesInput,
  toOpenAIResponsesItems,
  toOpenAIResponsesTools,
} from "./openai-responses-mapping";
import { OpenAIResponsesStreamAccumulator } from "./openai-responses-stream";
import type { ReasoningEffortController } from "./reasoning-effort";
import { sha256, stableJsonStringify } from "./model-request-preflight";

const OPENAI_RESPONSES_SERIALIZATION_VERSION = "openai-responses-v2";
const OPENAI_RESPONSES_TIMEOUT_MS = 30 * 60 * 1_000;

export class OpenAIResponsesModelClient implements ModelClient {
  readonly messageProtocol: ModelMessageProtocol = Object.freeze({
    adapter: "openai-responses",
    serializationVersion: OPENAI_RESPONSES_SERIALIZATION_VERSION,
  });
  readonly inputModalities: readonly ("text" | "image")[];
  readonly toolResultModalities: readonly ("text" | "image")[];
  readonly reasoningEffort?: ReasoningEffortController;
  private readonly client: OpenAI;
  private readonly preparedRequests = new WeakSet<object>();
  private readonly materializedRequests = new WeakSet<object>();
  private readonly provider: string;
  private readonly stream: boolean;

  constructor(
    private readonly options: {
      apiKey: string;
      contextBudget: ModelContextBudget;
      baseURL?: string;
      inputModalities?: readonly ("text" | "image")[];
      toolResultModalities?: readonly ("text" | "image")[];
      profileName?: string;
      model: string;
      providerName?: string;
      reasoningEffort?: ReasoningEffortController;
      stream?: boolean;
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {
    this.provider = options.providerName ?? "responses-compatible";
    this.stream = options.stream ?? true;
    this.reasoningEffort = options.reasoningEffort;
    const modalities = validateModelModalities({
      profileName: options.profileName,
      adapter: this.messageProtocol.adapter,
      inputModalities: options.inputModalities ?? ["text"],
      toolResultModalities: options.toolResultModalities ?? ["text"],
      adapterToolResultModalities: ["text", "image"],
    });
    this.inputModalities = modalities.inputModalities;
    this.toolResultModalities = modalities.toolResultModalities;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? OPENAI_RESPONSES_TIMEOUT_MS,
      maxRetries: 0,
      fetch: options.fetch,
    });
  }

  prepare(input: ModelRequestInput): PreparedModelRequest {
    const itemsByMessage = input.messages.map((message) =>
      toOpenAIResponsesItems(message),
    );
    const items = toOpenAIResponsesInput(input.messages);
    const tools =
      input.tools.length > 0 ? toOpenAIResponsesTools(input.tools) : undefined;
    const reasoningEffort = this.reasoningEffort?.snapshot().effort;
    const payload = deepFreeze({
      model: this.options.model,
      input: items,
      ...(tools === undefined ? {} : { tools, tool_choice: "auto" as const }),
      ...(reasoningEffort === undefined
        ? {}
        : { reasoning: { effort: reasoningEffort } }),
      max_output_tokens: this.options.contextBudget.requestMaxOutputTokens,
      store: false as const,
      ...(this.stream ? { stream: true as const } : {}),
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
          ? imageUserSegment(message, index + 1)
          : message.role === "tool"
            ? imageToolSegment(
                message,
                index + 1,
                stableJsonStringify(itemsByMessage[index]),
              )
            : {
                kind: segmentKind(message.role),
                normalizedText: stableJsonStringify(itemsByMessage[index]),
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
        stream: this.stream,
        inputModalities: this.inputModalities,
        toolResultModalities: this.toolResultModalities,
        requestPolicy: { store: false, toolChoice: "auto" },
        imagePolicy: {
          version: IMAGE_INPUT_POLICY_VERSION,
          ...IMAGE_INPUT_POLICY,
        },
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
    return fromOpenAIResponse(response, {
      identity: options.identity,
      provider: this.provider,
      model: this.options.model,
    });
  }

  private async requestStreaming(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<unknown> {
    const accumulator = new OpenAIResponsesStreamAccumulator({
      provider: this.provider,
      model: this.options.model,
    });
    try {
      const stream = await this.client.responses.create(
        prepared.payload as ResponseCreateParamsStreaming,
        { signal: options.signal },
      );
      for await (const event of stream) {
        const content = accumulator.push(event);
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
  ): Promise<unknown> {
    try {
      return await this.client.responses.create(
        prepared.payload as ResponseCreateParamsNonStreaming,
        { signal },
      );
    } catch (error) {
      throw sanitizedProviderError(error, this.provider, this.options.model);
    }
  }

  private assistantReplaySegments(message: AssistantMessage): PreparedPromptSegment[] {
    const items = toOpenAIResponsesItems(message);
    if (items.length === 0) {
      throw new Error("OpenAI Responses assistant replay mapping produced no items.");
    }
    return [
      {
        kind: "assistant",
        normalizedText: stableJsonStringify(items),
      },
    ];
  }

  private assertPrepared(prepared: PreparedModelRequest): void {
    if (
      !this.preparedRequests.has(prepared) &&
      !this.materializedRequests.has(prepared)
    ) {
      throw new Error(
        `OpenAI Responses request was not prepared by this client (provider=${this.provider}, model=${this.options.model}).`,
      );
    }
    if (
      prepared.provider !== this.provider ||
      prepared.model !== this.options.model ||
      prepared.requestMaxOutputTokens !==
        this.options.contextBudget.requestMaxOutputTokens
    ) {
      throw new Error(
        "Prepared OpenAI Responses request configuration does not match client.",
      );
    }
  }
}
