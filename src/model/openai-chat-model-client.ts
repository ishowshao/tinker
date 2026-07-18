import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { AssistantMessage } from "../agent/types";
import type { ModelContextBudget } from "./model-context-profile";
import type {
  ModelClient,
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
import { accumulateOpenAIChatCompletionChunks } from "./openai-chat-stream";
import {
  canonicalJsonValue,
  sha256,
  stableJsonStringify,
} from "./model-request-preflight";

const OPENAI_CHAT_SERIALIZATION_VERSION = "openai-chat-v1";
const OPENAI_CHAT_TIMEOUT_MS = 30 * 60 * 1_000;

export class OpenAIChatModelClient implements ModelClient {
  readonly messageProtocol: ModelMessageProtocol = Object.freeze({
    adapter: "openai-chat",
    serializationVersion: OPENAI_CHAT_SERIALIZATION_VERSION,
  });
  private readonly client: OpenAI;
  private readonly preparedRequests = new WeakSet<object>();
  private readonly provider: string;
  private readonly stream: boolean;

  constructor(
    private readonly options: {
      apiKey: string;
      contextBudget: ModelContextBudget;
      baseURL?: string;
      includeReasoningContent?: boolean;
      model: string;
      providerName?: string;
      stream?: boolean;
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {
    this.provider = options.providerName ?? "openai-compatible";
    this.stream = options.stream ?? true;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? OPENAI_CHAT_TIMEOUT_MS,
      fetch: options.fetch,
    });
  }

  prepare(input: ModelRequestInput): PreparedModelRequest {
    const messages = toOpenAIChatMessages(input.messages, {
      includeReasoningContent: this.options.includeReasoningContent,
    });
    const tools = input.tools.length > 0 ? toOpenAIChatTools(input.tools) : undefined;
    const payload = deepFreeze(
      canonicalJsonValue({
        model: this.options.model,
        messages,
        tools,
        tool_choice: tools === undefined ? undefined : "auto",
        max_tokens: this.options.contextBudget.requestMaxOutputTokens,
      }),
    ) as ChatCompletionCreateParamsNonStreaming;
    const toolSegments = (payload.tools ?? []).map(
      (tool): PreparedPromptSegment => ({
        kind: "tool_schema",
        normalizedText: stableJsonStringify(tool),
      }),
    );
    const messageSegments = payload.messages.map(
      (message, index): PreparedPromptSegment => ({
        kind: segmentKind(input.messages[index]?.role),
        normalizedText: stableJsonStringify(message),
      }),
    );
    const requestConfigHash = sha256(
      stableJsonStringify({
        adapter: this.messageProtocol.adapter,
        serializationVersion: this.messageProtocol.serializationVersion,
        model: this.options.model,
        requestMaxOutputTokens: this.options.contextBudget.requestMaxOutputTokens,
        includeReasoningContent: this.options.includeReasoningContent === true,
        requestPolicy: { toolChoice: "auto" },
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
      assistantReplaySegments: (message) => this.assistantReplaySegments(message),
    };
    Object.freeze(prepared);
    this.preparedRequests.add(prepared);
    return prepared;
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    if (!this.preparedRequests.has(prepared)) {
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

    const response = this.stream
      ? await this.requestStreaming(prepared, options.signal)
      : await this.client.chat.completions.create(
          prepared.payload as ChatCompletionCreateParamsNonStreaming,
          { signal: options.signal },
        );

    return fromOpenAIChatCompletion(response, {
      identity: options.identity,
      provider: this.provider,
      model: this.options.model,
    });
  }

  private async requestStreaming(
    prepared: PreparedModelRequest,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    // The prepared payload is frozen and hashed without stream flags; the
    // streaming transport is layered on at request time only.
    const payload: ChatCompletionCreateParamsStreaming = {
      ...(prepared.payload as ChatCompletionCreateParamsNonStreaming),
      stream: true,
      stream_options: { include_usage: true },
    };
    const stream = await this.client.chat.completions.create(payload, { signal });
    const chunks: unknown[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return accumulateOpenAIChatCompletionChunks(chunks, {
      provider: this.provider,
      model: this.options.model,
    });
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
        normalizedText: stableJsonStringify(canonicalJsonValue(mapped)),
      },
    ];
  }
}

function segmentKind(
  role: ModelRequestInput["messages"][number]["role"] | undefined,
): PreparedPromptSegment["kind"] {
  switch (role) {
    case "system":
      return "kernel";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    case undefined:
      throw new Error("OpenAI message mapping changed the message count.");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
