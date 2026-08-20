import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  createRuntimeSession,
  type RuntimeSession,
} from "../src/agent/runtime-session";
import type { UserMessage } from "../src/agent/types";
import {
  deriveRunnerConfig,
  resolvePublicConfig,
  type RunnerConfig,
} from "../src/cli/config";
import type { EventSink } from "../src/events/event-sink";
import type { AgentEvent } from "../src/events/types";
import { runtimeIdFactory } from "../src/ids/runtime-id";
import type { SessionId } from "../src/ids/runtime-id";
import { createUuidV7 } from "../src/ids/uuid-v7";
import type { ImportedImageAsset } from "../src/image/image-asset-store";
import type { UserImageAttachment } from "../src/image/image-types";
import {
  IMAGE_INPUT_POLICY,
  imagePlanningTokens,
} from "../src/image/image-input-policy";
import { OpenAIChatModelClient } from "../src/model/openai-chat-model-client";

const LIVE_ENABLE_ENV = "TINKER_LIVE_K3_IMAGE";
const DEFAULT_PROFILE = "k3";

type LiveConfig = RunnerConfig;

type HttpObservation = {
  kind: "chat";
  requestBodyBytes: number;
  hasTools: boolean;
  imageDataUrlCount: number;
  imageDimensions: readonly { width: number; height: number }[];
  status?: number;
};

type ImageCaseResult = {
  name: string;
  finalText: string;
  planningTokens: number;
  admissionSource: "estimated_full";
  admittedInputTokens: number;
  chatPromptTokens: number;
  chatBodyBytes: number;
  wireImageDimensions: readonly { width: number; height: number }[];
};

if (process.env[LIVE_ENABLE_ENV] !== "1") {
  throw new Error(
    `Refusing to call the real K3 endpoint without ${LIVE_ENABLE_ENV}=1.`,
  );
}

const profileName = process.argv[2] ?? DEFAULT_PROFILE;
const configuration = await resolvePublicConfig({
  env: process.env,
  cwd: process.cwd(),
});
if (configuration.mode !== "profile") {
  throw new Error("TINKER_MODELS must point to a model profile file.");
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-k3-image-live-"));
let activeSession: RuntimeSession | undefined;
try {
  const config = {
    ...deriveRunnerConfig(configuration, {
      sessionId: createUuidV7() as SessionId,
      profileName,
    }),
    workspaceRoot: workspace,
    maxIterations: 4,
  };
  const probeConfig = liveProbeConfig(config);
  await writeVisualFixture(workspace, "red-a.png", "#e00000", "A");
  await writeVisualFixture(workspace, "blue-b.png", "#0047d8", "B");
  const dimensionFixtures = [
    ["square-512.png", 512, 512],
    ["square-1024.png", 1024, 1024],
    ["square-1536.png", 1536, 1536],
    ["square-2048.png", 2048, 2048],
    ["landscape-3000x1000.png", 3000, 1000],
    ["portrait-1000x3000.png", 1000, 3000],
  ] as const;
  for (const [name, width, height] of dimensionFixtures) {
    await writeVisualFixture(workspace, name, "#365f91", "S", width, height);
  }
  await writeFile(path.join(workspace, "tool-probe.txt"), "tool-loop-ok\n", "utf8");

  const observations: HttpObservation[] = [];
  const observedFetch = createObservedFetch(observations);
  const singleInput = {
    config: probeConfig,
    workspace,
    observedFetch,
    observations,
    files: ["red-a.png"],
    content:
      "Inspect [Image #1]. Return only SINGLE=<dominant lowercase English color>/<visible uppercase letter>.",
    expected: "single=red/a",
    name: "single-image",
  } as const;
  const single = await runImageCase({
    ...singleInput,
    setActiveSession(session) {
      activeSession = session;
    },
  });
  activeSession = undefined;

  const pairInput = {
    config: probeConfig,
    workspace,
    observedFetch,
    observations,
    files: ["red-a.png", "blue-b.png"],
    content:
      "Visually inspect both attachments and return only [Image #1]=<dominant lowercase English color>/<visible uppercase letter>; [Image #2]=<dominant lowercase English color>/<visible uppercase letter>.",
    expected: "[image#1]=red/a;[image#2]=blue/b",
    name: "two-image-label-association",
  } as const;
  const pair = await runImageCase({
    ...pairInput,
    setActiveSession(session) {
      activeSession = session;
    },
  });
  activeSession = undefined;

  const dimensionRegression: ImageCaseResult[] = [];
  for (const [name] of dimensionFixtures) {
    dimensionRegression.push(
      await runImageCase({
        config: probeConfig,
        workspace,
        observedFetch,
        observations,
        files: [name],
        content: "Inspect [Image #1] and reply with exactly OK.",
        expected: "ok",
        name,
        setActiveSession(session) {
          activeSession = session;
        },
      }),
    );
    activeSession = undefined;
  }

  const imageToolReplay = await runImageToolReplay({
    config: probeConfig,
    workspace,
    observedFetch,
    observations,
    setActiveSession(session) {
      activeSession = session;
    },
  });
  activeSession = undefined;

  const toolLoop = await runStreamingToolLoop({
    config: probeConfig,
    workspace,
    observedFetch,
    setActiveSession(session) {
      activeSession = session;
    },
  });
  activeSession = undefined;

  const nonStreaming = await runNonStreamingBaseline(probeConfig, observedFetch);

  console.log(
    JSON.stringify(
      {
        profile: profileName,
        model: config.modelName,
        runtimeAdmission: { available: true, strategy: "local-image-buckets" },
        single,
        pair,
        dimensionRegression,
        imageToolReplay,
        toolLoop,
        nonStreaming,
        httpRequestCounts: {
          chat: observations.filter((entry) => entry.kind === "chat").length,
          estimate: 0,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await activeSession?.dispose({ type: "tui_exit" }).catch(() => undefined);
  await rm(workspace, { recursive: true });
}

async function runImageToolReplay(input: {
  config: LiveConfig;
  workspace: string;
  observedFetch: typeof fetch;
  observations: HttpObservation[];
  setActiveSession(session: RuntimeSession | undefined): void;
}): Promise<{
  finalText: string;
  modelRequestCount: number;
  estimateRequestCount: 0;
  imageChatRequestCount: number;
  secondIterationSource: "measured_plus_estimated_delta";
}> {
  const events: AgentEvent[] = [];
  const observationStart = input.observations.length;
  const session = await createLiveSession(
    input.config,
    input.workspace,
    input.observedFetch,
    events,
  );
  input.setActiveSession(session);
  try {
    const imported = await session.importImage(
      "red-a.png",
      new AbortController().signal,
      1,
    );
    const result = await session.executeTurn({
      userMessage: imageMessage(
        'Call the Glob tool exactly once with pattern "**/*.txt". After its result, inspect [Image #1] and reply only IMAGE-TOOL=<dominant lowercase English color>/<visible uppercase letter>.',
        [imported],
      ),
      signal: new AbortController().signal,
    });
    if (result.status !== "completed") {
      throw new Error(`Image tool replay did not complete: ${result.status}.`);
    }
    requireExpectedOutput(result.finalText, "image-tool=red/a", "image tool replay");
    const current = input.observations.slice(observationStart);
    const chats = current.filter((entry) => entry.kind === "chat");
    const modelRequests = events.filter(
      (event) => event.type === "model.request.finished",
    );
    const toolCalls = events.filter(
      (event) => event.type === "tool.started" && event.data.call.name === "Glob",
    );
    if (
      chats.length !== 2 ||
      modelRequests.length !== 2 ||
      toolCalls.length !== 1 ||
      chats.some((entry) => entry.imageDataUrlCount !== 1)
    ) {
      throw new Error(
        `Image tool replay contract failed: chats=${chats.length}, modelRequests=${modelRequests.length}, tools=${toolCalls.length}, imageCounts=${chats.map((entry) => entry.imageDataUrlCount).join(",")}.`,
      );
    }
    const preflights = events.filter(
      (event): event is Extract<AgentEvent, { type: "context.usage.updated" }> =>
        event.type === "context.usage.updated" && event.data.phase === "preflight",
    );
    const secondIterationSource = preflights.at(-1)?.data.snapshot.source;
    if (secondIterationSource !== "measured_plus_estimated_delta") {
      throw new Error(
        `Image tool replay did not reuse its measured anchor: ${secondIterationSource ?? "missing"}.`,
      );
    }
    return {
      finalText: result.finalText,
      modelRequestCount: modelRequests.length,
      estimateRequestCount: 0,
      imageChatRequestCount: chats.length,
      secondIterationSource,
    };
  } finally {
    await session.dispose({ type: "tui_exit" });
    input.setActiveSession(undefined);
  }
}

async function runImageCase(input: {
  config: LiveConfig;
  workspace: string;
  observedFetch: typeof fetch;
  observations: HttpObservation[];
  files: readonly string[];
  content: string;
  expected: string;
  name: string;
  setActiveSession(session: RuntimeSession | undefined): void;
}): Promise<ImageCaseResult> {
  const events: AgentEvent[] = [];
  const observationStart = input.observations.length;
  const session = await createLiveSession(
    input.config,
    input.workspace,
    input.observedFetch,
    events,
  );
  input.setActiveSession(session);
  try {
    const imported: ImportedImageAsset[] = [];
    for (let index = 0; index < input.files.length; index += 1) {
      imported.push(
        await session.importImage(
          input.files[index],
          new AbortController().signal,
          index + 1,
        ),
      );
    }
    const result = await session.executeTurn({
      userMessage: imageMessage(input.content, imported),
      signal: new AbortController().signal,
    });
    if (result.status !== "completed") {
      throw new Error(`${input.name} did not complete: ${result.status}.`);
    }
    requireExpectedOutput(result.finalText, input.expected, input.name);

    const current = input.observations.slice(observationStart);
    const chats = current.filter((entry) => entry.kind === "chat");
    if (chats.length !== 1) {
      throw new Error(
        `${input.name} expected one chat request; received ${chats.length}.`,
      );
    }
    if (
      chats[0].imageDimensions.some(
        ({ width, height }) =>
          Math.max(width, height) > IMAGE_INPUT_POLICY.maxProviderLongEdge,
      )
    ) {
      throw new Error(`${input.name} exceeded the provider image size policy.`);
    }
    const preflight = events.find(
      (event) =>
        event.type === "context.usage.updated" && event.data.phase === "preflight",
    );
    if (preflight?.type !== "context.usage.updated") {
      throw new Error(`${input.name} did not record admission usage.`);
    }
    const admissionSource = preflight.data.snapshot.source;
    if (admissionSource !== "estimated_full") {
      throw new Error(
        `${input.name} used an unexpected admission source: ${admissionSource}.`,
      );
    }
    const modelFinished = events.find(
      (event) => event.type === "model.request.finished",
    );
    if (modelFinished?.type !== "model.request.finished") {
      throw new Error(`${input.name} did not record provider usage.`);
    }
    const planningTokens = preflight.data.snapshot.rawFullEstimate?.imageTokens ?? 0;
    const expectedPlanningTokens = chats[0].imageDimensions.reduce(
      (total, image) => total + imagePlanningTokens(image.width, image.height),
      0,
    );
    if (planningTokens !== expectedPlanningTokens) {
      throw new Error(
        `${input.name} planning mismatch: ${planningTokens} vs ${expectedPlanningTokens}.`,
      );
    }
    return {
      name: input.name,
      finalText: result.finalText,
      planningTokens,
      admissionSource,
      admittedInputTokens: preflight.data.snapshot.usedInputTokens,
      chatPromptTokens: modelFinished.data.output.usage.promptTokens,
      chatBodyBytes: chats[0].requestBodyBytes,
      wireImageDimensions: chats[0].imageDimensions,
    };
  } finally {
    await session.dispose({ type: "tui_exit" });
    input.setActiveSession(undefined);
  }
}

async function runStreamingToolLoop(input: {
  config: LiveConfig;
  workspace: string;
  observedFetch: typeof fetch;
  setActiveSession(session: RuntimeSession | undefined): void;
}): Promise<{
  finalText: string;
  modelRequestCount: number;
  toolCallCount: number;
  reasoningResponseCount: number;
}> {
  const events: AgentEvent[] = [];
  const session = await createLiveSession(
    input.config,
    input.workspace,
    input.observedFetch,
    events,
  );
  input.setActiveSession(session);
  try {
    const result = await session.executeTurn({
      userMessage: {
        role: "user",
        content:
          'Call the Glob tool exactly once with pattern "**/*.txt". After the tool result, reply with exactly TOOL-OK.',
      },
      signal: new AbortController().signal,
    });
    if (result.status !== "completed") {
      throw new Error(`Streaming tool loop did not complete: ${result.status}.`);
    }
    requireExpectedOutput(result.finalText, "tool-ok", "streaming tool loop");
    const toolCalls = events.filter(
      (event) => event.type === "tool.started" && event.data.call.name === "Glob",
    );
    const modelRequests = events.filter(
      (event) => event.type === "model.request.finished",
    );
    if (toolCalls.length !== 1 || modelRequests.length !== 2) {
      throw new Error(
        `Streaming tool loop expected one Glob call and two model requests; received ${toolCalls.length} and ${modelRequests.length}.`,
      );
    }
    return {
      finalText: result.finalText,
      modelRequestCount: modelRequests.length,
      toolCallCount: toolCalls.length,
      reasoningResponseCount: modelRequests.filter(
        (event) =>
          event.type === "model.request.finished" &&
          (event.data.output.message.reasoningContent?.length ?? 0) > 0,
      ).length,
    };
  } finally {
    await session.dispose({ type: "tui_exit" });
    input.setActiveSession(undefined);
  }
}

async function runNonStreamingBaseline(
  config: LiveConfig,
  observedFetch: typeof fetch,
): Promise<{ finalText: string; promptTokens: number }> {
  const client = createClient(config, observedFetch, false);
  const prepared = client.prepare({
    messages: [
      { role: "system", content: "Follow the requested output format exactly." },
      { role: "user", content: "Reply with exactly NONSTREAM-OK." },
    ],
    tools: [],
  });
  const output = await client.request(prepared, {
    signal: new AbortController().signal,
  });
  const finalText = output.message.content ?? "";
  requireExpectedOutput(finalText, "nonstream-ok", "non-streaming baseline");
  return { finalText, promptTokens: output.usage.promptTokens };
}

async function createLiveSession(
  config: LiveConfig,
  workspaceRoot: string,
  observedFetch: typeof fetch,
  events: AgentEvent[],
): Promise<RuntimeSession> {
  const sink: EventSink = {
    name: "k3-image-live-smoke",
    async append(event) {
      events.push(event);
    },
  };
  return createRuntimeSession(
    {
      selection: { mode: "new", sessionId: runtimeIdFactory.createSessionId() },
      workspaceRoot,
      modelName: config.modelName,
      profileName: config.profileName,
      maxIterations: config.maxIterations,
      includeReasoningContent: config.includeReasoningContent,
      contextProfile: config.contextProfile,
      contextBudget: config.contextBudget,
      systemPrompt:
        "Follow explicit output formats exactly. Do not call tools unless the user requires one.",
      modelClient: createClient(config, observedFetch, true),
      presentationSinks: [sink],
      persistence: false,
      toolingConfig: configuration.tooling,
    },
    { loadMcpConfig: async () => undefined },
  );
}

function createClient(
  config: LiveConfig,
  observedFetch: typeof fetch,
  stream: boolean,
): OpenAIChatModelClient {
  return new OpenAIChatModelClient({
    apiKey: requireString(config.apiKey, "K3 API key"),
    baseURL: requireString(config.apiBase, "K3 API base URL"),
    model: config.modelName,
    contextBudget: config.contextBudget,
    includeReasoningContent: config.includeReasoningContent,
    inputModalities: config.inputModalities,
    stream,
    fetch: observedFetch,
  });
}

function createObservedFetch(observations: HttpObservation[]): typeof fetch {
  const implementation = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith("/chat/completions")) {
      throw new Error(`Unexpected K3 live endpoint: ${new URL(url).pathname}.`);
    }
    const body = await requestBody(input, init);
    const decodedBody = JSON.parse(body) as Record<string, unknown>;
    const observation: HttpObservation = {
      kind: "chat",
      requestBodyBytes: Buffer.byteLength(body, "utf8"),
      hasTools: Array.isArray(decodedBody.tools),
      imageDataUrlCount: countImageDataUrls(decodedBody),
      imageDimensions: await imageDataUrlDimensions(decodedBody),
    };
    observations.push(observation);
    const response = await fetch(input, init);
    observation.status = response.status;
    return response;
  };
  return Object.assign(implementation, { preconnect() {} });
}

function countImageDataUrls(value: unknown): number {
  if (typeof value === "string") {
    return value.startsWith("data:image/") ? 1 : 0;
  }
  if (Array.isArray(value)) {
    const entries: unknown[] = value;
    let total = 0;
    for (const entry of entries) {
      total += countImageDataUrls(entry);
    }
    return total;
  }
  if (isRecord(value)) {
    return Object.values(value).reduce<number>(
      (total, entry) => total + countImageDataUrls(entry),
      0,
    );
  }
  return 0;
}

async function imageDataUrlDimensions(
  value: unknown,
): Promise<readonly { width: number; height: number }[]> {
  const urls: string[] = [];
  collectImageDataUrls(value, urls);
  return Promise.all(
    urls.map(async (url) => {
      const separator = url.indexOf(",");
      if (separator < 0) {
        throw new Error("Live image data URL has no payload separator.");
      }
      const metadata = await sharp(
        Buffer.from(url.slice(separator + 1), "base64"),
      ).metadata();
      return {
        width: requirePositiveInteger(metadata.width, "live image width"),
        height: requirePositiveInteger(metadata.height, "live image height"),
      };
    }),
  );
}

function collectImageDataUrls(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) {
      output.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectImageDataUrls(entry, output);
    }
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      collectImageDataUrls(entry, output);
    }
  }
}

async function requestBody(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<string> {
  if (typeof init?.body === "string") {
    return init.body;
  }
  if (input instanceof Request) {
    return input.clone().text();
  }
  throw new Error("K3 live request body is not inspectable.");
}

function imageMessage(
  content: string,
  imported: readonly ImportedImageAsset[],
): UserMessage {
  const attachments = imported.map((image, index): UserImageAttachment => {
    const label = `[Image #${index + 1}]`;
    const start = codePointIndexOf(content, label);
    return Object.freeze({
      attachmentId: runtimeIdFactory.createImageAttachmentId(),
      ...image.asset,
      label,
      range: Object.freeze({ start, end: start + [...label].length }),
      originalName: image.originalName,
    });
  });
  return Object.freeze({
    role: "user",
    content,
    attachments: Object.freeze(attachments),
  });
}

function codePointIndexOf(value: string, needle: string): number {
  const utf16Index = value.indexOf(needle);
  if (utf16Index < 0 || value.indexOf(needle, utf16Index + needle.length) >= 0) {
    throw new Error(`Expected exactly one ${needle} label in the live prompt.`);
  }
  return [...value.slice(0, utf16Index)].length;
}

async function writeVisualFixture(
  workspaceRoot: string,
  name: string,
  background: string,
  letter: string,
  width = 320,
  height = 240,
): Promise<void> {
  const overlay = Buffer.from(
    `<svg width="${width}" height="${height}"><text x="${Math.round(width / 2)}" y="${Math.round(height * 0.68)}" text-anchor="middle" font-family="Arial" font-size="${Math.max(64, Math.round(Math.min(width, height) * 0.6))}" font-weight="bold" fill="white">${letter}</text></svg>`,
  );
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background,
    },
  })
    .composite([{ input: overlay }])
    .png()
    .toFile(path.join(workspaceRoot, name));
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} is not a positive integer.`);
  }
  return value as number;
}

function liveProbeConfig(config: LiveConfig): LiveConfig {
  if (config.inputModalities.includes("image")) {
    return config;
  }
  return {
    ...config,
    inputModalities: Object.freeze(["text", "image"]),
  };
}

function requireExpectedOutput(value: string, expected: string, name: string): void {
  const normalized = value.toLowerCase().replace(/[\s`"']/g, "");
  if (!normalized.includes(expected)) {
    throw new Error(`${name} returned an unexpected semantic result: ${value}`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is missing.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
