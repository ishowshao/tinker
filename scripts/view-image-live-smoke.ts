import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  createRuntimeSession,
  type RuntimeSession,
} from "../src/agent/runtime-session";
import {
  deriveRunnerConfig,
  resolvePublicConfig,
  type RunnerConfig,
} from "../src/cli/config";
import type { EventSink } from "../src/events/event-sink";
import type { AgentEvent } from "../src/events/types";
import { runtimeIdFactory } from "../src/ids/runtime-id";
import type { SessionId } from "../src/ids/runtime-id";
import { OpenAIResponsesModelClient } from "../src/model/openai-responses-model-client";
import { createReasoningEffortController } from "../src/model/reasoning-effort";
import { resolveSessionDatabasePath } from "../src/session/session-store";

const LIVE_ENABLE_ENV = "TINKER_LIVE_VIEW_IMAGE";

type RequestObservation = {
  readonly bodyBytes: number;
  readonly stream: boolean;
  readonly viewImageToolDeclared: boolean;
  readonly toolImageCount: number;
  readonly totalImageCount: number;
  readonly status?: number;
};

type LiveModeResult = {
  readonly stream: boolean;
  readonly firstFinalText: string;
  readonly replayFinalText: string;
  readonly modelRequestCount: number;
  readonly viewImageCallCount: number;
  readonly requestObservations: readonly RequestObservation[];
  readonly imagePreflightSource: string;
  readonly imagePlanningTokens: number;
  readonly providerPromptTokens: number;
  readonly persistedDataUrlCount: 0;
};

if (process.env[LIVE_ENABLE_ENV] !== "1") {
  throw new Error(`Refusing to call a real provider without ${LIVE_ENABLE_ENV}=1.`);
}

const configuration = await resolvePublicConfig({
  env: process.env,
  cwd: process.cwd(),
});
if (configuration.mode !== "profile") {
  throw new Error("TINKER_MODELS must point to a model profile file.");
}
const requestedProfile = process.argv[2];
const selected = deriveRunnerConfig(configuration, {
  sessionId: runtimeIdFactory.createSessionId(),
  ...(requestedProfile === undefined ? {} : { profileName: requestedProfile }),
});
if (selected.api !== "responses") {
  throw new Error(
    `Selected profile ${JSON.stringify(selected.profileName ?? selected.modelName)} uses ${selected.api}; ViewImage live validation requires Responses.`,
  );
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-view-image-live-"));
let activeSession: RuntimeSession | undefined;
try {
  await writeSemanticFixture(workspace);
  const results: LiveModeResult[] = [];
  for (const stream of [true, false] as const) {
    results.push(
      await runMode({
        config: selected,
        workspace,
        stream,
        setActiveSession(session) {
          activeSession = session;
        },
      }),
    );
    activeSession = undefined;
  }
  console.log(
    JSON.stringify(
      {
        profile: selected.profileName ?? configuration.profiles.defaultProfile,
        model: selected.modelName,
        api: selected.api,
        configuredCapabilities: {
          inputModalities: selected.inputModalities,
          toolResultModalities: selected.toolResultModalities,
        },
        probeCapabilities: {
          inputModalities: ["text", "image"],
          toolResultModalities: ["text", "image"],
          localProfileModified: false,
        },
        modes: results,
        estimatorRequestCount: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await activeSession?.dispose({ type: "tui_exit" }).catch(() => undefined);
  await rm(workspace, { recursive: true });
}

async function runMode(input: {
  readonly config: RunnerConfig;
  readonly workspace: string;
  readonly stream: boolean;
  setActiveSession(session: RuntimeSession | undefined): void;
}): Promise<LiveModeResult> {
  const sessionId = runtimeIdFactory.createSessionId();
  const events: AgentEvent[] = [];
  const observations: RequestObservation[] = [];
  const observedFetch = createObservedFetch(observations);
  const reasoningEffort = createReasoningEffortController(input.config.reasoning);
  const sink: EventSink = {
    name: "view-image-live-smoke",
    async append(event) {
      events.push(event);
    },
  };
  const modelClient = new OpenAIResponsesModelClient({
    apiKey: input.config.apiKey,
    baseURL: input.config.apiBase,
    model: input.config.modelName,
    profileName: input.config.profileName,
    contextBudget: input.config.contextBudget,
    inputModalities: ["text", "image"],
    toolResultModalities: ["text", "image"],
    stream: input.stream,
    fetch: observedFetch,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  });
  const session = await createRuntimeSession(
    {
      selection: { mode: "new", sessionId },
      workspaceRoot: input.workspace,
      modelName: input.config.modelName,
      profileName: input.config.profileName,
      maxIterations: 4,
      includeReasoningContent: false,
      contextProfile: input.config.contextProfile,
      contextBudget: input.config.contextBudget,
      systemPrompt:
        "Follow exact output formats. When explicitly required, call ViewImage exactly once before answering from the image.",
      modelClient,
      presentationSinks: [sink],
      persistence: false,
      toolingConfig: configuration.tooling,
    },
    { loadMcpConfig: async () => undefined },
  );
  input.setActiveSession(session);
  try {
    const first = await session.executeTurn({
      userMessage: {
        role: "user",
        content:
          "Call ViewImage exactly once with file_path semantic-fixture.png. Inspect the returned image, then reply with only VIEWIMAGE=red/A,blue/B if the left panel is red with A and the right panel is blue with B.",
      },
      signal: new AbortController().signal,
    });
    if (first.status !== "completed") {
      throw new Error(`ViewImage ${modeName(input.stream)} turn ${first.status}.`);
    }
    requireSemanticResult(first.finalText, "viewimage=red/a,blue/b", "first turn");

    const replay = await session.executeTurn({
      userMessage: {
        role: "user",
        content:
          "Do not call any tool. Using the image result already in this session, reply with only REPLAY=red/A,blue/B.",
      },
      signal: new AbortController().signal,
    });
    if (replay.status !== "completed") {
      throw new Error(`ViewImage replay ${modeName(input.stream)} ${replay.status}.`);
    }
    requireSemanticResult(replay.finalText, "replay=red/a,blue/b", "replay turn");

    const viewImageCalls = events.filter(
      (event) => event.type === "tool.started" && event.data.call.name === "ViewImage",
    );
    const modelRequests = events.filter(
      (event) => event.type === "model.request.finished",
    );
    if (viewImageCalls.length !== 1 || modelRequests.length !== 3) {
      throw new Error(
        `Expected one ViewImage call and three model requests; received ${viewImageCalls.length} and ${modelRequests.length}.`,
      );
    }
    if (
      observations.length !== 3 ||
      observations[0]?.toolImageCount !== 0 ||
      observations[1]?.toolImageCount !== 1 ||
      observations[2]?.toolImageCount !== 1
    ) {
      throw new Error(
        `Unexpected tool-image replay counts: ${observations.map((entry) => entry.toolImageCount).join(",")}.`,
      );
    }
    if (observations.some((entry) => entry.stream !== input.stream)) {
      throw new Error("Provider request stream mode did not match the live probe.");
    }
    if (observations.some((entry) => !entry.viewImageToolDeclared)) {
      throw new Error("ViewImage was not declared on every live provider request.");
    }
    if (observations.some((entry) => entry.status !== 200)) {
      throw new Error(
        `Unexpected provider statuses: ${observations.map((entry) => entry.status).join(",")}.`,
      );
    }
    if (
      observations[0]?.totalImageCount !== 0 ||
      observations[1]?.totalImageCount !== 1 ||
      observations[2]?.totalImageCount !== 1
    ) {
      throw new Error(
        `Unexpected total image counts: ${observations.map((entry) => entry.totalImageCount).join(",")}.`,
      );
    }

    const preflights = events.filter(
      (event): event is Extract<AgentEvent, { type: "context.usage.updated" }> =>
        event.type === "context.usage.updated" && event.data.phase === "preflight",
    );
    const imagePreflight = preflights.find(
      (event) => (event.data.snapshot.rawFullEstimate?.imageTokens ?? 0) > 0,
    );
    if (imagePreflight === undefined) {
      throw new Error("ViewImage live request recorded no image planning tokens.");
    }
    const providerPromptTokens = modelRequests[1]?.data.output.usage.promptTokens;
    if (providerPromptTokens === undefined || providerPromptTokens < 1) {
      throw new Error("ViewImage live request recorded no provider prompt usage.");
    }

    await assertNoPersistedDataUrl(input.workspace, sessionId, events);
    return {
      stream: input.stream,
      firstFinalText: first.finalText,
      replayFinalText: replay.finalText,
      modelRequestCount: modelRequests.length,
      viewImageCallCount: viewImageCalls.length,
      requestObservations: observations,
      imagePreflightSource: imagePreflight.data.snapshot.source,
      imagePlanningTokens:
        imagePreflight.data.snapshot.rawFullEstimate?.imageTokens ?? 0,
      providerPromptTokens,
      persistedDataUrlCount: 0,
    };
  } finally {
    await session.dispose({ type: "tui_exit" });
    input.setActiveSession(undefined);
  }
}

function createObservedFetch(observations: RequestObservation[]): typeof fetch {
  const implementation = async (
    request: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = request instanceof Request ? request.url : String(request);
    if (!new URL(url).pathname.endsWith("/responses")) {
      throw new Error(`Unexpected live endpoint ${new URL(url).pathname}.`);
    }
    const bodyText = await requestBody(request, init);
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    const observation: RequestObservation = {
      bodyBytes: Buffer.byteLength(bodyText, "utf8"),
      stream: body.stream === true,
      viewImageToolDeclared: hasViewImageTool(body),
      toolImageCount: countToolResultImages(body),
      totalImageCount: countImageDataUrls(body),
    };
    observations.push(observation);
    const response = await fetch(request, init);
    Object.assign(observation, { status: response.status });
    return response;
  };
  return Object.assign(implementation, { preconnect() {} });
}

function hasViewImageTool(body: Record<string, unknown>): boolean {
  return (
    Array.isArray(body.tools) &&
    body.tools.some(
      (tool) => isRecord(tool) && tool.name === "ViewImage" && tool.type === "function",
    )
  );
}

function countToolResultImages(body: Record<string, unknown>): number {
  if (!Array.isArray(body.input)) return 0;
  return body.input.reduce<number>((total, item) => {
    if (!isRecord(item) || item.type !== "function_call_output") return total;
    return total + countImageDataUrls(item.output);
  }, 0);
}

function countImageDataUrls(value: unknown): number {
  if (typeof value === "string") {
    return value.startsWith("data:image/") ? 1 : 0;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((total, entry) => total + countImageDataUrls(entry), 0);
  }
  if (isRecord(value)) {
    return Object.values(value).reduce<number>(
      (total, entry) => total + countImageDataUrls(entry),
      0,
    );
  }
  return 0;
}

async function requestBody(
  request: string | URL | Request,
  init?: RequestInit,
): Promise<string> {
  if (typeof init?.body === "string") return init.body;
  if (request instanceof Request) return request.clone().text();
  throw new Error("Live Responses request body is not inspectable.");
}

async function assertNoPersistedDataUrl(
  workspaceRoot: string,
  sessionId: SessionId,
  events: readonly AgentEvent[],
): Promise<void> {
  const database = new Database(
    await resolveSessionDatabasePath(workspaceRoot, sessionId),
    { readonly: true },
  );
  try {
    const stored = JSON.stringify({
      messages: database.query("SELECT content FROM messages").all(),
      results: database.query("SELECT raw_json FROM tool_results").all(),
      blocks: database
        .query("SELECT kind, text_content, asset_id FROM tool_message_content_blocks")
        .all(),
    });
    if (
      stored.includes("data:image") ||
      stored.includes(";base64,") ||
      JSON.stringify(events).includes("data:image") ||
      JSON.stringify(events).includes(";base64,")
    ) {
      throw new Error("ViewImage bytes leaked into durable or event state.");
    }
  } finally {
    database.close();
  }
}

async function writeSemanticFixture(workspaceRoot: string): Promise<void> {
  const width = 800;
  const height = 400;
  const overlay = Buffer.from(
    `<svg width="${width}" height="${height}">
      <rect x="0" y="0" width="400" height="400" fill="#e00000"/>
      <rect x="400" y="0" width="400" height="400" fill="#0047d8"/>
      <text x="200" y="280" text-anchor="middle" font-family="Arial" font-size="240" font-weight="bold" fill="white">A</text>
      <text x="600" y="280" text-anchor="middle" font-family="Arial" font-size="240" font-weight="bold" fill="white">B</text>
    </svg>`,
  );
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "white",
    },
  })
    .composite([{ input: overlay }])
    .png()
    .toFile(path.join(workspaceRoot, "semantic-fixture.png"));
}

function requireSemanticResult(value: string, expected: string, label: string): void {
  const normalized = value.toLowerCase().replace(/[\s`"']/gu, "");
  if (!normalized.includes(expected)) {
    throw new Error(`${label} returned an unexpected result: ${value}`);
  }
}

function modeName(stream: boolean): string {
  return stream ? "streaming" : "non-streaming";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
