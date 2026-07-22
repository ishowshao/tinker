import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  createRuntimeSession,
  type CreateRuntimeSessionInput,
  type RuntimeSession,
} from "../agent/runtime-session";
import { AdmissionStaleError } from "../agent/session-ledger";
import type { IterationIdentity, TurnIdentity, UserMessage } from "../agent/types";
import type { AgentEvent } from "../events/types";
import { runtimeIdFactory, type SessionId } from "../ids/runtime-id";
import type { ImportedImageAsset } from "../image/image-asset-store";
import { ImageNotRecognizedError } from "../image/image-probe";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import { SessionStore } from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import {
  collectingEventSink,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
} from "./test-runtime";

describe("RuntimeSession image admission", () => {
  test("classifies regular files before rejecting image input for a text-only model", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-text-file-selection-"),
    );
    const sessionId = runtimeIdFactory.createSessionId();
    const sink = collectingEventSink();
    let session: RuntimeSession | undefined;
    try {
      await writeFile(path.join(workspace, "app.ts"), "export const value = 1;\n");
      session = await createRuntimeSession(
        runtimeInput(workspace, sessionId, textClient(), sink.events, "new"),
        { loadMcpConfig: async () => undefined },
      );
      expect(session.supportsImageInput()).toBe(false);

      let importResult: Promise<ImportedImageAsset> | undefined;
      expect(() => {
        importResult = session?.importImage("app.ts", new AbortController().signal, 1);
      }).not.toThrow();
      const error = await importResult?.catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ImageNotRecognizedError);
    } finally {
      await session?.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("reuses the accepted payload and skips re-estimation when a resumed anchor covers images", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-image-runtime-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const sink = collectingEventSink();
    const estimateBodies: unknown[] = [];
    const chatBodies: unknown[] = [];
    let chatCount = 0;
    const client = imageClient(
      stubFetch(async (input, init) => {
        const url = requestUrl(input);
        if (url.endsWith("/tokenizers/estimate-token-count")) {
          estimateBodies.push(JSON.parse(init?.body as string));
          return Response.json({ data: { total_tokens: 500 } });
        }
        if (url.endsWith("/chat/completions")) {
          chatBodies.push(JSON.parse(init?.body as string));
          chatCount += 1;
          return completionResponse(chatCount);
        }
        throw new Error(`Unexpected test endpoint: ${url}`);
      }),
    );
    let session: RuntimeSession | undefined;
    try {
      await writeFixtureImage(workspace, "runtime.png");
      session = await createRuntimeSession(
        runtimeInput(workspace, sessionId, client, sink.events, "new"),
        { loadMcpConfig: async () => undefined },
      );
      expect(session.supportsImageInput()).toBe(true);
      const imported = await session.importImage(
        "runtime.png",
        new AbortController().signal,
        1,
      );
      const firstMessage = imageMessage(imported, "describe [Image #1]");
      const accepted = await session.admitTurn({
        userMessage: firstMessage,
        signal: new AbortController().signal,
      });
      const first = await accepted.completion;

      expect(first.status).toBe("completed");
      expect(estimateBodies).toHaveLength(1);
      expect(chatBodies).toHaveLength(1);
      expect(estimateBodies[0]).toMatchObject({ model: "kimi-k3" });
      expect(estimateBodies[0]).toHaveProperty("tools");
      expect(JSON.stringify(estimateBodies[0])).toContain("data:image/png;base64,");
      expect(JSON.stringify(chatBodies[0])).toContain("<image name=[Image #1]>");
      const started = sink.events.find(
        (event): event is Extract<AgentEvent, { type: "turn.started" }> =>
          event.type === "turn.started",
      );
      expect(started?.data.userPrompt).toEqual({
        version: 1,
        text: "describe [Image #1]",
        images: [
          {
            label: "[Image #1]",
            range: { start: 9, end: 19 },
            originalName: "runtime.png",
          },
        ],
        omittedImageCount: 0,
      });
      expect(JSON.stringify(started)).not.toContain(imported.asset.assetId);
      expect(JSON.stringify(started)).not.toContain("base64");

      await session.dispose({ type: "tui_exit" });
      session = undefined;
      await rm(path.join(workspace, "runtime.png"));

      session = await createRuntimeSession(
        runtimeInput(workspace, sessionId, client, sink.events, "resume"),
        { loadMcpConfig: async () => undefined },
      );
      const second = await session.executeTurn({
        userMessage: { role: "user", content: "follow up without a new image" },
        signal: new AbortController().signal,
      });

      expect(second.status).toBe("completed");
      expect(estimateBodies).toHaveLength(1);
      expect(chatBodies).toHaveLength(2);
      expect(JSON.stringify(chatBodies[1])).toContain("data:image/png;base64,");
      expect(JSON.stringify(chatBodies[1])).toContain("follow up without a new image");
    } finally {
      await session?.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("estimator failure commits no turn, sends no chat, and releases admission", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-image-runtime-estimate-fail-"),
    );
    const sessionId = runtimeIdFactory.createSessionId();
    const sink = collectingEventSink();
    let estimateCount = 0;
    let chatCount = 0;
    const client = imageClient(
      stubFetch(async (input) => {
        const url = requestUrl(input);
        if (url.endsWith("/tokenizers/estimate-token-count")) {
          estimateCount += 1;
          return new Response("unavailable", { status: 503 });
        }
        if (url.endsWith("/chat/completions")) {
          chatCount += 1;
          return completionResponse(chatCount);
        }
        throw new Error(`Unexpected test endpoint: ${url}`);
      }),
    );
    let session: RuntimeSession | undefined;
    try {
      await writeFixtureImage(workspace, "failure.png");
      session = await createRuntimeSession(
        runtimeInput(workspace, sessionId, client, sink.events, "new"),
        { loadMcpConfig: async () => undefined },
      );
      const imported = await session.importImage(
        "failure.png",
        new AbortController().signal,
        1,
      );
      const error = await session
        .admitTurn({
          userMessage: imageMessage(imported, "inspect [Image #1]"),
          signal: new AbortController().signal,
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("HTTP 503");
      expect(estimateCount).toBe(1);
      expect(chatCount).toBe(0);
      expect(sink.events.filter((event) => event.type === "turn.started")).toHaveLength(
        0,
      );

      const recovery = await session.executeTurn({
        userMessage: { role: "user", content: "text recovery" },
        signal: new AbortController().signal,
      });
      expect(recovery.status).toBe("completed");
      expect(chatCount).toBe(1);
      expect(
        sink.events.find((event) => event.type === "turn.started")?.turnNumber,
      ).toBe(1);
    } finally {
      await session?.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects a stale estimated payload and refreshes the next turn number", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-image-runtime-stale-"),
    );
    const sessionId = runtimeIdFactory.createSessionId();
    const sink = collectingEventSink();
    const estimateResponse = deferred<Response>();
    let estimatorStarted = false;
    let chatCount = 0;
    const client = imageClient(
      stubFetch(async (input) => {
        const url = requestUrl(input);
        if (url.endsWith("/tokenizers/estimate-token-count")) {
          estimatorStarted = true;
          return estimateResponse.promise;
        }
        if (url.endsWith("/chat/completions")) {
          chatCount += 1;
          return completionResponse(chatCount);
        }
        throw new Error(`Unexpected test endpoint: ${url}`);
      }),
    );
    let capturedStore: SessionStore | undefined;
    let session: RuntimeSession | undefined;
    try {
      await writeFixtureImage(workspace, "stale.png");
      const input = runtimeInput(workspace, sessionId, client, sink.events, "new");
      session = await createRuntimeSession(input, {
        loadMcpConfig: async () => undefined,
        openStore: async (runtime, idFactory) => {
          capturedStore = await SessionStore.createNew({
            workspaceRoot: runtime.workspaceRoot,
            sessionId: runtime.selection.sessionId,
            modelName: runtime.modelName,
            systemPrompt: runtime.systemPrompt,
            projectInstruction: runtime.projectInstruction,
            idFactory,
          });
          return capturedStore;
        },
      });
      const imported = await session.importImage(
        "stale.png",
        new AbortController().signal,
        1,
      );
      const admission = session.admitTurn({
        userMessage: imageMessage(imported, "compare [Image #1]"),
        signal: new AbortController().signal,
      });
      await waitUntil(() => estimatorStarted);
      appendExternalTurn(requireStore(capturedStore), 1);
      estimateResponse.resolve(Response.json({ data: { total_tokens: 500 } }));

      const stale = await admission.catch((caught: unknown) => caught);
      expect(stale).toBeInstanceOf(AdmissionStaleError);
      expect(chatCount).toBe(0);
      expect(sink.events.filter((event) => event.type === "turn.started")).toHaveLength(
        0,
      );

      const recovery = await session.executeTurn({
        userMessage: { role: "user", content: "continue after stale" },
        signal: new AbortController().signal,
      });
      expect(recovery.status).toBe("completed");
      expect(chatCount).toBe(1);
      expect(
        sink.events.find((event) => event.type === "turn.started")?.turnNumber,
      ).toBe(2);
    } finally {
      await session?.dispose({ type: "tui_exit" }).catch(() => undefined);
      await capturedStore?.abandon().catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
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

function textClient(): OpenAIChatModelClient {
  return new OpenAIChatModelClient({
    apiKey: "test-key",
    baseURL: "https://api.example.test/v1",
    model: "text-model",
    contextBudget: TEST_CONTEXT_BUDGET,
    inputModalities: ["text"],
    stream: false,
    fetch: stubFetch(async (input) => {
      throw new Error(`Unexpected text model request: ${requestUrl(input)}`);
    }),
  });
}

function runtimeInput(
  workspaceRoot: string,
  sessionId: SessionId,
  modelClient: OpenAIChatModelClient,
  events: AgentEvent[],
  mode: "new" | "resume",
): CreateRuntimeSessionInput {
  const common = {
    workspaceRoot,
    modelName: "kimi-k3",
    profileName: "kimi-k3-test",
    maxIterations: 2,
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    modelClient,
    systemPrompt: "system",
    presentationSinks: [
      {
        async append(event: AgentEvent) {
          events.push(event);
        },
      },
    ],
    persistence: false as const,
  };
  return mode === "new"
    ? { ...common, selection: { mode, sessionId } }
    : { ...common, selection: { mode, sessionId } };
}

function imageMessage(imported: ImportedImageAsset, content: string): UserMessage {
  const start = [...content].indexOf("[");
  return Object.freeze({
    role: "user",
    content,
    attachments: Object.freeze([
      Object.freeze({
        attachmentId: runtimeIdFactory.createImageAttachmentId(),
        ...imported.asset,
        label: "[Image #1]",
        range: Object.freeze({ start, end: start + 10 }),
        originalName: imported.originalName,
      }),
    ]),
  });
}

async function writeFixtureImage(workspace: string, name: string): Promise<void> {
  await writeFile(
    path.join(workspace, name),
    await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 40, g: 80, b: 120 },
      },
    })
      .png()
      .toBuffer(),
  );
}

function completionResponse(index: number): Response {
  return Response.json({
    id: `chatcmpl-runtime-${index}`,
    object: "chat.completion",
    created: 0,
    model: "kimi-k3",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: `answer ${index}` },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 100 + index,
      completion_tokens: 1,
      total_tokens: 101 + index,
    },
  });
}

function stubFetch(
  implementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(implementation, { preconnect() {} });
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function appendExternalTurn(store: SessionStore, turnNumber: number): void {
  const ledger = new SqliteSessionLedger(store, runtimeIdFactory);
  const turn: TurnIdentity = {
    sessionId: store.sessionId,
    turnId: runtimeIdFactory.createTurnId(),
    turnNumber,
  };
  const iteration: IterationIdentity = {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 1,
  };
  const pending = ledger.beginTurn({
    turn,
    userMessage: { role: "user", content: "external mutation" },
  });
  store.beginIteration(iteration);
  pending.agent.appendAssistant({
    iteration,
    message: { role: "assistant", content: "external answer" },
    provider: "test",
    model: "kimi-k3",
  });
  pending.finish({
    status: "completed",
    finalText: "external answer",
    lastIteration: iteration,
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for runtime admission.");
    }
    await Bun.sleep(5);
  }
}

function requireStore(store: SessionStore | undefined): SessionStore {
  if (store === undefined) {
    throw new Error("Expected captured SessionStore.");
  }
  return store;
}
