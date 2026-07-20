import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { UserMessage } from "../agent/types";
import { ContextMeter } from "../agent/context-meter";
import { runtimeIdFactory } from "../ids/runtime-id";
import { ImageAssetStore } from "../image/image-asset-store";
import { IMAGE_INPUT_POLICY } from "../image/image-input-policy";
import {
  imageAssetIdForBytes,
  type ImageAssetId,
  type ImageAssetRef,
  type UserImageAttachment,
} from "../image/image-types";
import type { MaterializedModelRequest } from "../model/model-client";
import type { InputTokenEstimator } from "../model/input-token-estimator";
import { MoonshotInputTokenEstimator } from "../model/moonshot-input-token-estimator";
import {
  imageAssetUrlMarker,
  parseImageAssetUrlMarker,
  toOpenAIUserContent,
} from "../model/openai-chat-mapping";
import {
  exactJsonBodyBytes,
  OpenAIChatModelClient,
} from "../model/openai-chat-model-client";
import { TEST_CONTEXT_BUDGET } from "./test-runtime";

describe("OpenAI multimodal mapping and materialization", () => {
  test("maps ordered image blocks before the complete Prompt without local metadata", () => {
    const first = syntheticAsset("first", 12);
    const second = syntheticAsset("second", 15, "image/webp");
    const message = messageWithAttachments("compare [Image #1] with [Image #2]", [
      attachment(first, "[Image #1]", 8, 18, "before.png"),
      attachment(second, "[Image #2]", 24, 34, "after.webp"),
    ]);

    const mapped = toOpenAIUserContent(
      message,
      new Map([
        [first.assetId, "data:image/png;base64,Zmlyc3Q="],
        [second.assetId, "data:image/webp;base64,c2Vjb25k"],
      ]),
    );

    expect(mapped).toEqual([
      { type: "text", text: "<image name=[Image #1]>" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,Zmlyc3Q=" },
      },
      { type: "text", text: "</image>" },
      { type: "text", text: "<image name=[Image #2]>" },
      {
        type: "image_url",
        image_url: { url: "data:image/webp;base64,c2Vjb25k" },
      },
      { type: "text", text: "</image>" },
      {
        type: "text",
        text: "compare [Image #1] with [Image #2]",
      },
    ]);
    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toContain("before.png");
    expect(serialized).not.toContain("after.webp");
    expect(serialized).not.toContain("detail");
    expect(serialized).not.toContain("path");
  });

  test("keeps prepare pure, reads a repeated asset once, and sizes the exact wire body", async () => {
    await withWorkspace(async (workspace) => {
      const sourceBytes = await sharp({
        create: {
          width: 2,
          height: 2,
          channels: 3,
          background: { r: 240, g: 20, b: 80 },
        },
      })
        .png()
        .toBuffer();
      await writeFile(path.join(workspace, "shared.png"), sourceBytes);
      const store = await ImageAssetStore.open({ workspaceRoot: workspace });
      const imported = await store.importWorkspaceFile("shared.png");
      const message = messageWithAttachments("[Image #1] and [Image #2]", [
        attachment(imported.asset, "[Image #1]", 0, 10, "one.png"),
        attachment(imported.asset, "[Image #2]", 15, 25, "two.png"),
      ]);
      let chatBody: string | undefined;
      const client = imageClient(
        stubFetch(async (_url, init) => {
          chatBody = init?.body as string;
          return completionResponse();
        }),
      );
      let readCount = 0;
      const countingStore = {
        readVerified: async (
          asset: ImageAssetRef,
          options: { signal?: AbortSignal },
        ) => {
          readCount += 1;
          return store.readVerified(asset, options);
        },
      } as ImageAssetStore;

      const prepared = client.prepare({ messages: [message], tools: [] });
      expect(readCount).toBe(0);
      expect(prepared.mediaOccurrenceCount).toBe(2);
      expect(JSON.stringify(prepared.promptSegments)).not.toContain("base64");
      const materialized = await client.materialize(prepared, {
        assetStore: countingStore,
        signal: new AbortController().signal,
      });

      expect(readCount).toBe(1);
      expect(materialized.bodyBytes).toBe(
        Buffer.byteLength(JSON.stringify(materialized.payload), "utf8"),
      );
      const payloadText = JSON.stringify(materialized.payload);
      expect(payloadText.match(/data:image\/png;base64,/g)).toHaveLength(2);
      expect(payloadText).not.toContain(imported.asset.assetId);
      let estimateCalls = 0;
      const estimator: InputTokenEstimator = {
        kind: "moonshot-estimate-token-count-v1",
        compatibility: {
          kind: "moonshot-estimate-token-count-v1",
          coverageVersion: "full-request-v1",
          model: "kimi-k3",
          endpoint: "https://api.moonshot.test/v1/tokenizers/estimate-token-count",
          timeoutMs: 30_000,
          maxRetries: 0,
        },
        async estimate() {
          estimateCalls += 1;
          return {
            inputTokens: 100,
            source: "provider_estimated",
            coverage: "full_request",
          };
        },
      };
      const meter = new ContextMeter(TEST_CONTEXT_BUDGET);
      await meter.estimateProviderInput(materialized, estimator, {
        signal: new AbortController().signal,
      });
      await meter.estimateProviderInput(Object.freeze({ ...materialized }), estimator, {
        signal: new AbortController().signal,
      });
      expect(estimateCalls).toBe(1);
      await client.request(materialized, {
        signal: new AbortController().signal,
      });
      expect(chatBody).toBe(JSON.stringify(materialized.payload));
      expect(Buffer.byteLength(chatBody!, "utf8")).toBe(materialized.bodyBytes);
    });
  });

  test("refuses unmaterialized image dispatch", async () => {
    let fetchCount = 0;
    const client = imageClient(
      stubFetch(async () => {
        fetchCount += 1;
        return completionResponse();
      }),
    );
    const asset = syntheticAsset("unmaterialized", 8);
    const prepared = client.prepare({
      messages: [
        messageWithAttachments("see [Image #1]", [
          attachment(asset, "[Image #1]", 4, 14, "source.png"),
        ]),
      ],
      tools: [],
    });

    expect(
      client.request(prepared, { signal: new AbortController().signal }),
    ).rejects.toThrow("must be materialized");
    expect(fetchCount).toBe(0);
  });

  test("rejects image count and lower-bound body limits before asset reads", async () => {
    const client = imageClient(stubFetch(async () => completionResponse()));
    let readCount = 0;
    const unreadableStore = {
      readVerified: async () => {
        readCount += 1;
        throw new Error("asset read must not occur");
      },
    } as unknown as ImageAssetStore;

    const nineMessages = Array.from({ length: 9 }, (_, index) => {
      const asset = syntheticAsset(`aggregate-${index}`, 1);
      return messageWithAttachments("[Image #1]", [
        attachment(asset, "[Image #1]", 0, 10, `${index}.png`),
      ]);
    });
    const tooMany = client.prepare({ messages: nineMessages, tools: [] });
    expect(
      client.materialize(tooMany, {
        assetStore: unreadableStore,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("9 images; maximum is 8");
    expect(readCount).toBe(0);

    const hugeAssets = Array.from({ length: 4 }, (_, index) =>
      syntheticAsset(`body-${index}`, IMAGE_INPUT_POLICY.maxBytesPerImage),
    );
    const bodyMessage = sequentialMessage(hugeAssets);
    const tooLarge = client.prepare({ messages: [bodyMessage], tools: [] });
    expect(
      client.materialize(tooLarge, {
        assetStore: unreadableStore,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("UTF-8 bytes");
    expect(readCount).toBe(0);
  });

  test("marker-aware JSON sizing matches JSON.stringify for Unicode and repeated assets", () => {
    const first = imageAssetIdForBytes(Buffer.from("sizer-first"));
    const second = imageAssetIdForBytes(Buffer.from("sizer-second"));
    const lengths = new Map<ImageAssetId, number>([
      [first, 31],
      [second, 97],
    ]);
    const samples = [
      "plain",
      'quotes " slash \\ newline\n',
      "emoji 🙂 雪 café",
      "control \u0000 and lone surrogate \ud800",
    ];

    for (const text of samples) {
      const payload = {
        model: "kimi-k3",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text },
              { type: "image_url", image_url: { url: imageAssetUrlMarker(first) } },
              { type: "image_url", image_url: { url: imageAssetUrlMarker(first) } },
              { type: "image_url", image_url: { url: imageAssetUrlMarker(second) } },
            ],
          },
        ],
        enabled: true,
        count: 3,
      };
      const concrete = replaceMarkers(payload, lengths);
      expect(exactJsonBodyBytes(payload, lengths)).toBe(
        Buffer.byteLength(JSON.stringify(concrete), "utf8"),
      );
    }
  });
});

describe("MoonshotInputTokenEstimator", () => {
  test("posts estimator model, messages, and tools and validates total_tokens", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const estimator = new MoonshotInputTokenEstimator({
      apiKey: "secret-key",
      baseURL: "https://api.moonshot.test/v1",
      model: "kimi-k3",
      timeoutMs: 1_000,
      fetch: stubFetch(async (url, init) => {
        capturedUrl = requestUrl(url);
        capturedInit = init;
        return Response.json({ data: { total_tokens: 321 } });
      }),
    });
    const request = materializedEstimateRequest({
      model: "k3",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ secret: "tool-schema" }],
    });

    const estimate = await estimator.estimate(request, {
      signal: new AbortController().signal,
    });

    expect(capturedUrl).toBe(
      "https://api.moonshot.test/v1/tokenizers/estimate-token-count",
    );
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      model: "kimi-k3",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ secret: "tool-schema" }],
    });
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe(
      "Bearer secret-key",
    );
    expect(estimate).toEqual({
      inputTokens: 321,
      source: "provider_estimated",
      coverage: "full_request",
    });
    expect(estimator.compatibility).toEqual({
      kind: "moonshot-estimate-token-count-v1",
      coverageVersion: "full-request-v1",
      model: "kimi-k3",
      endpoint: "https://api.moonshot.test/v1/tokenizers/estimate-token-count",
      timeoutMs: 1_000,
      maxRetries: 0,
    });
    expect(JSON.stringify(estimator.compatibility)).not.toContain("secret-key");
  });

  test("does not retry HTTP failures or call fetch after user abort", async () => {
    let fetchCount = 0;
    const estimator = new MoonshotInputTokenEstimator({
      apiKey: "key",
      baseURL: "https://api.moonshot.test/v1",
      model: "kimi-k3",
      timeoutMs: 1_000,
      fetch: stubFetch(async () => {
        fetchCount += 1;
        return new Response("busy", { status: 503 });
      }),
    });
    const request = materializedEstimateRequest({
      model: "kimi-k3",
      messages: [],
    });
    expect(
      estimator.estimate(request, { signal: new AbortController().signal }),
    ).rejects.toThrow("HTTP 503");
    expect(fetchCount).toBe(1);

    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    expect(estimator.estimate(request, { signal: controller.signal })).rejects.toThrow(
      "user cancelled",
    );
    expect(fetchCount).toBe(1);
  });

  test("aborts one in-flight request at its timeout", async () => {
    let fetchCount = 0;
    const estimator = new MoonshotInputTokenEstimator({
      apiKey: "key",
      baseURL: "https://api.moonshot.test/v1",
      model: "kimi-k3",
      timeoutMs: 5,
      fetch: stubFetch(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            fetchCount += 1;
            init?.signal?.addEventListener(
              "abort",
              () => {
                const reason: unknown = init.signal?.reason;
                reject(
                  reason instanceof Error
                    ? reason
                    : new Error("Token estimate aborted."),
                );
              },
              { once: true },
            );
          }),
      ),
    });

    expect(
      estimator.estimate(
        materializedEstimateRequest({ model: "kimi-k3", messages: [] }),
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("timed out");
    expect(fetchCount).toBe(1);
  });
});

function imageClient(fetchImpl: typeof fetch): OpenAIChatModelClient {
  return new OpenAIChatModelClient({
    apiKey: "test-key",
    baseURL: "https://api.moonshot.test/v1",
    model: "kimi-k3",
    contextBudget: TEST_CONTEXT_BUDGET,
    inputModalities: ["text", "image"],
    tokenEstimator: {
      kind: "moonshot-estimate-token-count-v1",
      model: "kimi-k3",
      apiBase: "https://api.moonshot.test/v1",
      apiKey: "estimator-key",
      timeoutMs: 30_000,
      maxRetries: 0,
    },
    stream: false,
    fetch: fetchImpl,
  });
}

function syntheticAsset(
  seed: string,
  byteLength: number,
  mimeType: ImageAssetRef["mimeType"] = "image/png",
): ImageAssetRef {
  return Object.freeze({
    assetId: imageAssetIdForBytes(Buffer.from(seed)),
    mimeType,
    byteLength,
    width: 1,
    height: 1,
  });
}

function attachment(
  asset: ImageAssetRef,
  label: string,
  start: number,
  end: number,
  originalName: string,
): UserImageAttachment {
  return Object.freeze({
    attachmentId: runtimeIdFactory.createImageAttachmentId(),
    ...asset,
    label,
    range: Object.freeze({ start, end }),
    originalName,
  });
}

function messageWithAttachments(
  content: string,
  attachments: readonly UserImageAttachment[],
): UserMessage {
  return Object.freeze({
    role: "user",
    content,
    attachments: Object.freeze([...attachments]),
  });
}

function sequentialMessage(assets: readonly ImageAssetRef[]): UserMessage {
  const chunks: string[] = [];
  const attachments: UserImageAttachment[] = [];
  let cursor = 0;
  for (const [index, asset] of assets.entries()) {
    const label = `[Image #${index + 1}]`;
    if (index > 0) {
      chunks.push(" ");
      cursor += 1;
    }
    chunks.push(label);
    attachments.push(
      attachment(asset, label, cursor, cursor + [...label].length, `${index}.png`),
    );
    cursor += [...label].length;
  }
  return messageWithAttachments(chunks.join(""), attachments);
}

function completionResponse(): Response {
  return Response.json({
    id: "chatcmpl-image-test",
    object: "chat.completion",
    created: 0,
    model: "kimi-k3",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  });
}

function stubFetch(
  implementation: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(implementation, { preconnect() {} });
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

function replaceMarkers(
  value: unknown,
  lengths: ReadonlyMap<ImageAssetId, number>,
): unknown {
  const assetId = parseImageAssetUrlMarker(value);
  if (assetId !== undefined) {
    return "x".repeat(lengths.get(assetId)!);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceMarkers(entry, lengths));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceMarkers(entry, lengths),
      ]),
    );
  }
  return value;
}

function materializedEstimateRequest(payload: unknown): MaterializedModelRequest {
  return { payload } as MaterializedModelRequest;
}

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-image-model-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true });
  }
}
