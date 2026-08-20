import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { UserMessage } from "../agent/types";
import { runtimeIdFactory } from "../ids/runtime-id";
import { ImageAssetStore } from "../image/image-asset-store";
import {
  imageAssetIdForBytes,
  type ImageAssetId,
  type ImageAssetRef,
  type UserImageAttachment,
} from "../image/image-types";
import { toOpenAIUserContent } from "../model/openai-chat-mapping";
import {
  imageAssetUrlMarker,
  parseImageAssetUrlMarker,
} from "../model/openai-image-mapping";
import {
  assertOpenAIRequestBodyLimit,
  exactJsonBodyBytes,
  OpenAIChatModelClient,
} from "../model/openai-chat-model-client";
import { OpenAIResponsesModelClient } from "../model/openai-responses-model-client";
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

  test("uses the same materialization policy for Responses payloads", async () => {
    await withWorkspace(async (workspace) => {
      const sourceBytes = await sharp({
        create: {
          width: 3000,
          height: 1000,
          channels: 3,
          background: "#274060",
        },
      })
        .png()
        .toBuffer();
      await writeFile(path.join(workspace, "responses.png"), sourceBytes);
      const store = await ImageAssetStore.open({ workspaceRoot: workspace });
      const imported = await store.importWorkspaceFile("responses.png");
      const client = new OpenAIResponsesModelClient({
        apiKey: "test-key",
        model: "test-model",
        contextBudget: TEST_CONTEXT_BUDGET,
        inputModalities: ["text", "image"],
        stream: false,
      });
      const prepared = client.prepare({
        messages: [
          messageWithAttachments("see [Image #1]", [
            attachment(imported.asset, "[Image #1]", 4, 14, "responses.png"),
          ]),
        ],
        tools: [],
      });
      const materialized = await client.materialize(prepared, {
        assetStore: store,
        signal: new AbortController().signal,
      });

      expect(materialized.promptSegments[0]?.media?.[0]).toMatchObject({
        sourceWidth: 3000,
        sourceHeight: 1000,
        width: 2048,
        height: 683,
        planningTokens: 5504,
      });
      expect(JSON.stringify(materialized.payload)).toContain("data:image/png;base64,");
      expect(await store.readVerified(imported.asset)).toEqual(sourceBytes);
      expect(imported.asset.assetId).toBe(imageAssetIdForBytes(sourceBytes));
    });
  });

  test("rejects image count before asset reads", async () => {
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

  test("keeps the exact materialized request body limit active", () => {
    expect(() => assertOpenAIRequestBodyLimit(90_000_001, 1)).toThrow(
      "90000001 UTF-8 bytes",
    );
  });
});

function imageClient(fetchImpl: typeof fetch): OpenAIChatModelClient {
  return new OpenAIChatModelClient({
    apiKey: "test-key",
    baseURL: "https://api.moonshot.test/v1",
    model: "kimi-k3",
    contextBudget: TEST_CONTEXT_BUDGET,
    inputModalities: ["text", "image"],
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

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-image-model-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true });
  }
}
