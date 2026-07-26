import OpenAI from "openai";
import type { MemoryEmbeddingConfig } from "./contracts";
import { MemoryError } from "./contracts";

const EMBEDDING_TIMEOUT_MS = 60_000;
const EMBEDDING_MAX_RETRIES = 2;

export interface MemoryEmbeddingClient {
  embed(
    inputs: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly (readonly number[])[]>;
}

export class OpenAICompatibleEmbeddingClient implements MemoryEmbeddingClient {
  private readonly client: OpenAI;

  constructor(
    private readonly config: MemoryEmbeddingConfig,
    options: { readonly fetch?: typeof fetch } = {},
  ) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.apiBase,
      timeout: EMBEDDING_TIMEOUT_MS,
      maxRetries: EMBEDDING_MAX_RETRIES,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  async embed(
    inputs: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    if (inputs.length === 0) {
      throw new MemoryError(
        "memory_embedding_input_invalid",
        "Embedding input must not be empty.",
      );
    }
    signal.throwIfAborted();

    let response;
    try {
      response = await this.client.embeddings.create(
        {
          model: this.config.model,
          input: [...inputs],
          encoding_format: "float",
        },
        { signal },
      );
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new MemoryError(
        "memory_embedding_request_failed",
        "Embedding provider request failed.",
        { cause: error },
      );
    }
    signal.throwIfAborted();

    if (!Array.isArray(response.data)) {
      throw new MemoryError(
        "memory_embedding_response_invalid",
        "Embedding response did not contain a data array.",
      );
    }
    if (response.data.length !== inputs.length) {
      throw new MemoryError(
        "memory_embedding_response_invalid",
        `Embedding response returned ${response.data.length} vectors for ${inputs.length} inputs.`,
      );
    }

    const vectors: Array<readonly number[] | undefined> = Array.from({
      length: inputs.length,
    });
    for (const item of response.data) {
      if (
        !Number.isSafeInteger(item.index) ||
        item.index < 0 ||
        item.index >= inputs.length ||
        vectors[item.index] !== undefined ||
        !Array.isArray(item.embedding) ||
        item.embedding.some((value) => typeof value !== "number")
      ) {
        throw new MemoryError(
          "memory_embedding_response_invalid",
          "Embedding response indices or vectors are invalid.",
        );
      }
      vectors[item.index] = Object.freeze([...item.embedding]);
    }
    if (vectors.some((vector) => vector === undefined)) {
      throw new MemoryError(
        "memory_embedding_response_invalid",
        "Embedding response did not map every input index.",
      );
    }
    return Object.freeze(vectors as readonly (readonly number[])[]);
  }
}
