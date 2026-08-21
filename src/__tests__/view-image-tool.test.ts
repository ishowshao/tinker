import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  createRuntimeSession,
  type CreateRuntimeSessionInput,
} from "../agent/runtime-session";
import type { AgentMessage, ToolCall, ToolMessage } from "../agent/types";
import {
  canonicalToolResultContentHash,
  validateToolResultContent,
} from "../agent/tool-result-content";
import { runtimeIdFactory } from "../ids/runtime-id";
import { ImageAssetStore } from "../image/image-asset-store";
import { imageAssetIdForBytes } from "../image/image-types";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import { OpenAIResponsesModelClient } from "../model/openai-responses-model-client";
import type {
  ModelClient,
  ModelRequestInput,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling } from "../tools/registry";
import {
  createViewImageToolExecutor,
  VIEW_IMAGE_TOOL_DEFINITION,
} from "../tools/view-image";
import {
  createTestHistoryReader,
  createTestRuntime,
  prepareTestModelRequest,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

describe("ViewImage capability boundary", () => {
  test("validates adapter capability before runtime startup", () => {
    expect(
      () =>
        new OpenAIChatModelClient({
          apiKey: "test-key",
          model: "test-model",
          profileName: "chat-image-tools",
          contextBudget: TEST_CONTEXT_BUDGET,
          inputModalities: ["text", "image"],
          toolResultModalities: ["text", "image"],
        }),
    ).toThrow(
      'Profile "chat-image-tools" declares image tool results, but adapter "openai-chat" does not support them.',
    );
    expect(
      () =>
        new OpenAIResponsesModelClient({
          apiKey: "test-key",
          model: "test-model",
          contextBudget: TEST_CONTEXT_BUDGET,
          inputModalities: ["text"],
          toolResultModalities: ["text", "image"],
        }),
    ).toThrow('require "image" in the model input modalities');
  });

  test("runtime registration depends only on both effective image capabilities", async () => {
    await withWorkspace(async (workspace) => {
      for (const [inputImage, toolImage, expected] of [
        [false, false, false],
        [true, false, false],
        [true, true, true],
      ] as const) {
        const model = new CapabilityCaptureModel({ inputImage, toolImage });
        const session = await createRuntimeSession(runtimeInput(workspace, model), {
          loadMcpConfig: async () => undefined,
        });
        try {
          const result = await session.executeTurn({
            userMessage: { role: "user", content: "capture tools" },
            signal: new AbortController().signal,
          });
          expect(result.status).toBe("completed");
          expect(model.toolNames.includes("ViewImage")).toBe(expected);
        } finally {
          await session.dispose({ type: "tui_exit" });
        }
      }
    });
  });
});

describe("ViewImage execution", () => {
  test("publishes supported images, deduplicates bytes, and emits safe canonical blocks", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "tinker-view-image-outside-"));
    try {
      await withWorkspace(async (workspace) => {
        const formats = [
          ["inside.png", "png", "image/png"],
          ["inside.jpg", "jpeg", "image/jpeg"],
          ["inside.webp", "webp", "image/webp"],
        ] as const;
        for (const [name, format] of formats) {
          await writeFile(path.join(workspace, name), await fixtureBytes(format));
        }
        const duplicate = await fixtureBytes("png");
        const outsidePath = path.join(outside, "outside.not-an-image-extension");
        await writeFile(outsidePath, duplicate);
        await writeFile(path.join(workspace, "duplicate.png"), duplicate);

        const assetStore = await ImageAssetStore.open({ workspaceRoot: workspace });
        const testRuntime = createTestRuntime();
        const tooling = createDefaultTooling({
          workspaceRoot: workspace,
          runtimeSession: testRuntime.runtimeSession,
          historyReader: createTestHistoryReader(testRuntime.runtimeSession.sessionId),
          imageAssetStore: assetStore,
          supportsViewImage: true,
        });
        try {
          expect(
            tooling.registry.definitions().find((entry) => entry.name === "ViewImage"),
          ).toEqual(VIEW_IMAGE_TOOL_DEFINITION);

          for (const [name, , mimeType] of formats) {
            const raw = await tooling.runtime.execute(
              toolCall(testRuntime, name),
              toolContext(),
            );
            expect(raw).toMatchObject({
              kind: "view_image",
              ok: true,
              filePath: name,
              originalName: name,
              asset: { mimeType, width: 16, height: 8 },
            });
          }

          const inside = await tooling.runtime.execute(
            toolCall(testRuntime, "duplicate.png"),
            toolContext(),
          );
          const external = await tooling.runtime.execute(
            toolCall(testRuntime, outsidePath),
            toolContext(),
          );
          if (
            inside.kind !== "view_image" ||
            !inside.ok ||
            inside.asset === undefined ||
            external.kind !== "view_image" ||
            !external.ok ||
            external.asset === undefined
          ) {
            throw new Error("Expected successful duplicate ViewImage results.");
          }
          expect(external.asset.assetId).toBe(inside.asset.assetId);

          const observation = new ObservationBuilder().build({
            call: toolCall(testRuntime, outsidePath),
            raw: external,
          });
          expect(observation.content).toEqual([
            {
              type: "text",
              text: `Viewed image ${outsidePath} (image/png, 16x8, ${duplicate.length} bytes, asset=${external.asset.assetId.slice(0, 12)}…).`,
            },
            { type: "image", asset: external.asset },
          ]);
          expect(observation.displayText).toContain("[Image: image/png, 16x8");
          expect(JSON.stringify({ raw: external, observation })).not.toContain(
            "data:image",
          );
          expect(JSON.stringify({ raw: external, observation })).not.toContain(
            duplicate.toString("base64"),
          );
        } finally {
          await tooling.dispose();
        }
      });
    } finally {
      await rm(outside, { recursive: true });
    }
  });

  test("returns ordinary failures for strict arguments and unsafe paths", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "tinker-view-image-reject-"));
    try {
      await withWorkspace(async (workspace) => {
        const bytes = await fixtureBytes("png");
        const outsidePath = path.join(outside, "outside.png");
        await writeFile(outsidePath, bytes);
        await symlink(outsidePath, path.join(workspace, "linked.png"));
        const assetStore = await ImageAssetStore.open({ workspaceRoot: workspace });
        const testRuntime = createTestRuntime();
        const tooling = createDefaultTooling({
          workspaceRoot: workspace,
          runtimeSession: testRuntime.runtimeSession,
          historyReader: createTestHistoryReader(testRuntime.runtimeSession.sessionId),
          imageAssetStore: assetStore,
          supportsViewImage: true,
        });
        try {
          for (const args of [
            null,
            {},
            { file_path: "" },
            { file_path: "linked.png", extra: true },
          ]) {
            const raw = await tooling.runtime.execute(
              testRuntime.toolCall({ name: "ViewImage", args }),
              toolContext(),
            );
            expect(raw).toMatchObject({ kind: "view_image", ok: false });
          }

          const escape = await tooling.runtime.execute(
            toolCall(testRuntime, path.relative(workspace, outsidePath)),
            toolContext(),
          );
          expect(escape).toMatchObject({ kind: "view_image", ok: false });
          if (escape.kind !== "view_image") {
            throw new Error("Expected a ViewImage escape result.");
          }
          expect(escape.error).toContain("outside the workspace");
          const linked = await tooling.runtime.execute(
            toolCall(testRuntime, "linked.png"),
            toolContext(),
          );
          expect(linked).toMatchObject({ kind: "view_image", ok: false });
          if (linked.kind !== "view_image") {
            throw new Error("Expected a ViewImage symlink result.");
          }
          expect(linked.error).toContain("non-symlink");
          const failedObservation = new ObservationBuilder().build({
            call: toolCall(testRuntime, "linked.png"),
            raw: linked,
          });
          expect(failedObservation.content).toHaveLength(1);
          expect(failedObservation.content[0]?.type).toBe("text");
        } finally {
          await tooling.dispose();
        }
      });
    } finally {
      await rm(outside, { recursive: true });
    }
  });

  test("propagates cancellation before import, during import, and after publish", async () => {
    const testRuntime = createTestRuntime();
    const call = toolCall(testRuntime, "cancel.png");

    const beforeReason = new Error("cancel before import");
    const beforeController = new AbortController();
    beforeController.abort(beforeReason);
    const beforeExecutor = createViewImageToolExecutor({
      imageAssetStore: imageAssetStoreStub(async () => {
        throw new Error("pre-cancelled execution reached import");
      }),
    });
    expect(
      beforeExecutor.execute(call.args, call, {
        signal: beforeController.signal,
      }),
    ).rejects.toBe(beforeReason);

    const duringReason = new Error("cancel during import");
    const duringController = new AbortController();
    let importStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      importStarted = resolve;
    });
    const duringExecutor = createViewImageToolExecutor({
      imageAssetStore: imageAssetStoreStub(
        (_filePath, options) =>
          new Promise((_resolve, reject) => {
            const signal = options?.signal;
            if (signal === undefined) {
              throw new Error("ViewImage did not pass its cancellation signal.");
            }
            importStarted();
            signal.addEventListener("abort", () => reject(duringReason), {
              once: true,
            });
          }),
      ),
    });
    const during = duringExecutor.execute(call.args, call, {
      signal: duringController.signal,
    });
    await started;
    duringController.abort(duringReason);
    expect(during).rejects.toBe(duringReason);

    const afterPublishReason = new Error("cancel after publish");
    const afterPublishController = new AbortController();
    const afterPublishExecutor = createViewImageToolExecutor({
      imageAssetStore: imageAssetStoreStub(async () => {
        afterPublishController.abort(afterPublishReason);
        return {
          originalName: "cancel.png",
          asset: {
            assetId: imageAssetIdForBytes(Buffer.from("published-before-cancel")),
            mimeType: "image/png",
            byteLength: 100,
            width: 10,
            height: 5,
          },
        };
      }),
    });
    expect(
      afterPublishExecutor.execute(call.args, call, {
        signal: afterPublishController.signal,
      }),
    ).rejects.toBe(afterPublishReason);
  });
});

describe("ViewImage provider mapping", () => {
  test("Responses materializes ordered tool images and counts repeated assets per occurrence", async () => {
    await withWorkspace(async (workspace) => {
      const bytes = await fixtureBytes("png", 3000, 1000);
      await writeFile(path.join(workspace, "wide.png"), bytes);
      const store = await ImageAssetStore.open({ workspaceRoot: workspace });
      const imported = await store.importFile("wide.png");
      const toolMessage = imageToolMessage(imported.asset);
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: "see [Image #1]",
          attachments: [
            {
              attachmentId: runtimeIdFactory.createImageAttachmentId(),
              ...imported.asset,
              label: "[Image #1]",
              range: { start: 4, end: 14 },
              originalName: imported.originalName,
            },
          ],
        },
        toolMessage,
      ];
      const client = new OpenAIResponsesModelClient({
        apiKey: "test-key",
        model: "test-model",
        contextBudget: TEST_CONTEXT_BUDGET,
        inputModalities: ["text", "image"],
        toolResultModalities: ["text", "image"],
        stream: false,
      });
      const prepared = client.prepare({ messages, tools: [] });
      expect(prepared.mediaOccurrenceCount).toBe(2);
      expect(
        prepared.promptSegments.flatMap((segment) => segment.media ?? []),
      ).toMatchObject([
        {
          source: "user_attachment",
          messageOrdinal: 1,
          blockPosition: 0,
          width: 2048,
          height: 683,
          planningTokens: 5504,
        },
        {
          source: "tool_result",
          messageOrdinal: 2,
          blockPosition: 1,
          width: 2048,
          height: 683,
          planningTokens: 5504,
        },
      ]);
      const preparedJson = JSON.stringify(prepared.payload);
      expect(preparedJson).not.toContain("data:image");
      expect(preparedJson).toContain('"type":"input_image"');

      let readCount = 0;
      const countedStore = {
        readVerified: async (...args: Parameters<ImageAssetStore["readVerified"]>) => {
          readCount += 1;
          return store.readVerified(...args);
        },
      } as ImageAssetStore;
      const materialized = await client.materialize(prepared, {
        assetStore: countedStore,
        signal: new AbortController().signal,
      });
      expect(readCount).toBe(1);
      const payload = JSON.stringify(materialized.payload);
      expect(payload.match(/data:image\/png;base64,/gu)).toHaveLength(2);
      expect(payload).toContain('"detail":"auto"');

      const chat = new OpenAIChatModelClient({
        apiKey: "test-key",
        model: "test-model",
        contextBudget: TEST_CONTEXT_BUDGET,
        inputModalities: ["text", "image"],
        toolResultModalities: ["text"],
      });
      expect(() => chat.prepare({ messages: [toolMessage], tools: [] })).toThrow(
        "Text-only tool result mapping received an image block",
      );
    });
  });
});

describe("canonical tool-result blocks", () => {
  test("hashes ordered text and image metadata and rejects ambiguous block arrays", () => {
    const asset = {
      assetId: imageAssetIdForBytes(Buffer.from("canonical-tool-image")),
      mimeType: "image/png" as const,
      byteLength: 100,
      width: 10,
      height: 5,
    };
    const content = [
      { type: "text" as const, text: "viewed" },
      { type: "image" as const, asset },
    ];
    const [textBlock, imageBlock] = content;
    if (textBlock === undefined || imageBlock === undefined) {
      throw new Error("Expected two canonical tool-result blocks.");
    }
    expect(canonicalToolResultContentHash(content)).not.toBe(
      canonicalToolResultContentHash([imageBlock, textBlock]),
    );
    expect(canonicalToolResultContentHash(content)).not.toBe(
      canonicalToolResultContentHash([
        textBlock,
        { type: "image", asset: { ...asset, width: 9 } },
      ]),
    );
    expect(() => validateToolResultContent([])).toThrow("non-empty array");
    expect(() =>
      validateToolResultContent([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ).toThrow("Consecutive");
  });
});

class CapabilityCaptureModel implements ModelClient {
  readonly messageProtocol = Object.freeze({
    adapter: "fake" as const,
    serializationVersion: "view-image-capability-test-v1",
  });
  readonly inputModalities: readonly ("text" | "image")[];
  readonly toolResultModalities: readonly ("text" | "image")[];
  toolNames: string[] = [];

  constructor(input: { inputImage: boolean; toolImage: boolean }) {
    this.inputModalities = Object.freeze(
      input.inputImage ? (["text", "image"] as const) : (["text"] as const),
    );
    this.toolResultModalities = Object.freeze(
      input.toolImage ? (["text", "image"] as const) : (["text"] as const),
    );
  }

  prepare(input: ModelRequestInput): PreparedModelRequest {
    return prepareTestModelRequest(input);
  }

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    this.toolNames = testModelRequestInput(prepared).tools.map((tool) => tool.name);
    return testModelOutput(prepared, {
      role: "assistant",
      content: "captured",
    });
  }
}

function runtimeInput(
  workspaceRoot: string,
  modelClient: ModelClient,
): CreateRuntimeSessionInput {
  return {
    selection: { mode: "new", sessionId: runtimeIdFactory.createSessionId() },
    workspaceRoot,
    modelName: "capability-test",
    profileName: "capability-test",
    maxIterations: 1,
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    systemPrompt: "system",
    modelClient,
    presentationSinks: [],
    persistence: false,
  };
}

function toolCall(
  runtime: ReturnType<typeof createTestRuntime>,
  filePath: string,
): ToolCall {
  return runtime.toolCall({
    providerToolCallId: runtimeIdFactory.createToolCallId(),
    name: "ViewImage",
    args: { file_path: filePath },
  });
}

function toolContext() {
  return { signal: new AbortController().signal };
}

function imageAssetStoreStub(
  importFile: ImageAssetStore["importFile"],
): ImageAssetStore {
  return { importFile } as ImageAssetStore;
}

function imageToolMessage(
  asset: Awaited<ReturnType<ImageAssetStore["importFile"]>>["asset"],
): ToolMessage {
  return {
    role: "tool",
    toolCallId: runtimeIdFactory.createToolCallId(),
    providerToolCallId: "provider-view-image",
    name: "ViewImage",
    content: [
      { type: "text", text: "Viewed image wide.png." },
      { type: "image", asset },
    ],
  };
}

async function fixtureBytes(
  format: "png" | "jpeg" | "webp",
  width = 16,
  height = 8,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 190, g: 30, b: 50 },
    },
  })
    .toFormat(format)
    .toBuffer();
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-view-image-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true });
  }
}
