import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ChromeBridgeServer } from "./bridge-server";
import {
  MAX_ACTION_TEXT_CODE_POINTS,
  MAX_KEY_CHARS,
  MAX_SCROLL_AMOUNT,
  MAX_URL_CHARS,
  MAX_WAIT_TEXTS,
  OPEN_PAGE_TIMEOUT_MS,
  PAGE_ACTION_TIMEOUT_MS,
  PAGE_SNAPSHOT_TIMEOUT_MS,
  PAGE_SUMMARY_TIMEOUT_MS,
  PAGE_WAIT_DEFAULT_TIMEOUT_MS,
  PAGE_WAIT_MAX_TIMEOUT_MS,
  PLUGIN_VERSION,
} from "./constants";
import { ChromeBridgeError, internalBridgeError } from "./errors";
import {
  type BridgeMethodV2,
  parseOpenPageResultV2,
  parsePageActionResultV2,
  parsePageSnapshotV2,
  parsePageSummaryV2,
  parsePageWaitResultV2,
  requireUuid,
} from "./protocol-v2";

const PAGE_ID_PROPERTY = {
  type: "string" as const,
  format: "uuid",
  description: "Opaque pageId returned by open_page",
};
const UID_PROPERTY = {
  type: "string" as const,
  minLength: 1,
  description: "Element uid from the latest take_snapshot result",
};

export const OPEN_PAGE_TOOL: Tool = {
  name: "open_page",
  description: "Open an HTTP or HTTPS URL in a new visible Chrome tab.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: {
        type: "string",
        minLength: 1,
        maxLength: MAX_URL_CHARS,
        description: "HTTP or HTTPS URL to open in a new visible Chrome tab",
      },
    },
    required: ["url"],
  },
};

export const GET_PAGE_SUMMARY_TOOL: Tool = {
  name: "get_page_summary",
  description:
    "Read a bounded text summary from a Chrome page previously opened by open_page.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: {
        ...PAGE_ID_PROPERTY,
      },
    },
    required: ["pageId"],
  },
};

export const TAKE_SNAPSHOT_TOOL: Tool = {
  name: "take_snapshot",
  description:
    "Take a bounded text snapshot of the page accessibility tree. Use element uids only from the latest snapshot.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      verbose: {
        type: "boolean",
        description:
          "Include the full accessibility tree instead of interesting nodes only. Default false.",
      },
    },
    required: ["pageId"],
  },
};

export const CLICK_TOOL: Tool = {
  name: "click",
  description: "Click an element from the latest accessibility snapshot.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      uid: { ...UID_PROPERTY },
    },
    required: ["pageId", "uid"],
  },
};

export const FILL_TOOL: Tool = {
  name: "fill",
  description:
    "Fill an input, textarea, select, checkbox, radio, or switch from the latest snapshot.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      uid: { ...UID_PROPERTY },
      value: {
        type: "string",
        maxLength: MAX_ACTION_TEXT_CODE_POINTS,
        description: "Value to fill; use true or false for toggles",
      },
    },
    required: ["pageId", "uid", "value"],
  },
};

export const PRESS_KEY_TOOL: Tool = {
  name: "press_key",
  description:
    'Press a key or key combination such as "Enter", "Control+A", or "Meta+L".',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      key: {
        type: "string",
        minLength: 1,
        maxLength: MAX_KEY_CHARS,
      },
    },
    required: ["pageId", "key"],
  },
};

export const TYPE_TEXT_TOOL: Tool = {
  name: "type_text",
  description: "Type text into the currently focused page element.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      text: {
        type: "string",
        minLength: 1,
        maxLength: MAX_ACTION_TEXT_CODE_POINTS,
      },
      submitKey: {
        type: "string",
        minLength: 1,
        maxLength: MAX_KEY_CHARS,
        description: "Optional key or key combination to press after typing",
      },
    },
    required: ["pageId", "text"],
  },
};

export const WAIT_FOR_TOOL: Tool = {
  name: "wait_for",
  description:
    "Wait until any requested text appears in the page accessibility or text surface.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      text: {
        type: "array",
        minItems: 1,
        maxItems: MAX_WAIT_TEXTS,
        items: { type: "string", minLength: 1 },
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: PAGE_WAIT_MAX_TIMEOUT_MS,
        description: `Default ${PAGE_WAIT_DEFAULT_TIMEOUT_MS}`,
      },
    },
    required: ["pageId", "text"],
  },
};

export const SCROLL_TOOL: Tool = {
  name: "scroll",
  description: "Scroll the page in one direction by a bounded pixel amount.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      direction: {
        type: "string",
        enum: ["up", "down", "left", "right"],
      },
      amount: {
        type: "integer",
        minimum: 1,
        maximum: MAX_SCROLL_AMOUNT,
        description: "Pixel amount; default 500",
      },
    },
    required: ["pageId", "direction"],
  },
};

export const HOVER_TOOL: Tool = {
  name: "hover",
  description: "Hover over an element from the latest accessibility snapshot.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      uid: { ...UID_PROPERTY },
    },
    required: ["pageId", "uid"],
  },
};

export const TINKER_CHROME_TOOLS = [
  OPEN_PAGE_TOOL,
  GET_PAGE_SUMMARY_TOOL,
  TAKE_SNAPSHOT_TOOL,
  CLICK_TOOL,
  FILL_TOOL,
  PRESS_KEY_TOOL,
  TYPE_TEXT_TOOL,
  WAIT_FOR_TOOL,
  SCROLL_TOOL,
  HOVER_TOOL,
] as const;

export type ChromeBridgeClient = {
  request(method: BridgeMethodV2, params: unknown, timeoutMs: number): Promise<unknown>;
};

export function createTinkerChromeMcpServer(bridge: ChromeBridgeClient): Server {
  const server = new Server(
    { name: "tinker-chrome-mcp", version: PLUGIN_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Use open_page first. Take a fresh snapshot before uid-based actions and after every navigation. Only pages opened by this server can be observed or controlled.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...TINKER_CHROME_TOOLS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      switch (request.params.name) {
        case OPEN_PAGE_TOOL.name:
          return await callOpenPage(bridge, request.params.arguments);
        case GET_PAGE_SUMMARY_TOOL.name:
          return await callGetPageSummary(bridge, request.params.arguments);
        case TAKE_SNAPSHOT_TOOL.name:
          return await callTakeSnapshot(bridge, request.params.arguments);
        case CLICK_TOOL.name:
          return await callUidAction("click", bridge, request.params.arguments);
        case FILL_TOOL.name:
          return await callFill(bridge, request.params.arguments);
        case PRESS_KEY_TOOL.name:
          return await callPressKey(bridge, request.params.arguments);
        case TYPE_TEXT_TOOL.name:
          return await callTypeText(bridge, request.params.arguments);
        case WAIT_FOR_TOOL.name:
          return await callWaitFor(bridge, request.params.arguments);
        case SCROLL_TOOL.name:
          return await callScroll(bridge, request.params.arguments);
        case HOVER_TOOL.name:
          return await callUidAction("hover", bridge, request.params.arguments);
      }
      return errorResult(
        new ChromeBridgeError({
          code: "INTERNAL_ERROR",
          message: `Unknown Tinker Chrome tool ${request.params.name}.`,
          retryable: false,
          outcome: "not_started",
        }),
      );
    } catch (error) {
      return errorResult(internalBridgeError(error));
    }
  });

  return server;
}

export async function runTinkerChromeMcpServer(): Promise<void> {
  const bridge = await ChromeBridgeServer.start();
  const server = createTinkerChromeMcpServer(bridge);
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= bridge.close();
    return closePromise;
  };
  server.onclose = () => {
    void close();
  };
  server.onerror = (error) => {
    process.stderr.write(
      `${JSON.stringify({ component: "tinker-chrome-mcp", event: "mcp_error", message: error.message })}\n`,
    );
  };

  const handleSignal = () => {
    void close().finally(() => process.exit(0));
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  // The SDK's StdioServerTransport never observes stdin EOF, so a client that
  // closes our stdin would otherwise wait out its 2s kill timeout on every quit.
  process.stdin.once("end", handleSignal);

  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await close();
    throw error;
  }
}

async function callOpenPage(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireExactObject(args, ["url"]);
  if (
    typeof input.url !== "string" ||
    input.url.length === 0 ||
    input.url.length > MAX_URL_CHARS
  ) {
    throw invalidUrlError("url must be a non-empty string of at most 8192 characters.");
  }

  let url: URL;
  try {
    url = new URL(input.url);
  } catch (error) {
    throw invalidUrlError("url is not a valid absolute URL.", error);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidUrlError("Only http: and https: URLs are supported.");
  }

  const pageId = crypto.randomUUID();
  const result = parseOpenPageResultV2(
    await bridge.request("page.open", { pageId, url: url.href }, OPEN_PAGE_TIMEOUT_MS),
  );
  if (result.pageId !== pageId) {
    throw new ChromeBridgeError({
      code: "INVALID_PLUGIN_RESPONSE",
      message: "Chrome returned a different pageId.",
      retryable: false,
      outcome: "unknown",
    });
  }

  return {
    content: [
      {
        type: "text",
        text: [
          "Opened a Chrome page.",
          `pageId=${result.pageId}`,
          `url=${singleLine(result.url)}`,
          `title=${singleLine(result.title)}`,
          `loadState=${result.loadState}`,
        ].join("\n"),
      },
    ],
  };
}

async function callGetPageSummary(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireExactObject(args, ["pageId"]);
  const pageId = requireUuid(input.pageId, "pageId");
  const summary = parsePageSummaryV2(
    await bridge.request("page.summary", { pageId }, PAGE_SUMMARY_TIMEOUT_MS),
  );
  if (summary.pageId !== pageId) {
    throw new ChromeBridgeError({
      code: "INVALID_PLUGIN_RESPONSE",
      message: "Chrome returned a different pageId.",
      retryable: false,
      outcome: "not_started",
    });
  }

  const headings =
    summary.headings.length === 0
      ? "(none)"
      : summary.headings
          .map((heading) => `- H${heading.level} ${singleLine(heading.text)}`)
          .join("\n");
  return {
    content: [
      {
        type: "text",
        text: [
          "Chrome page summary.",
          `pageId=${summary.pageId}`,
          `url=${singleLine(summary.url)}`,
          `title=${singleLine(summary.title)}`,
          `description=${singleLine(summary.description ?? "")}`,
          `canonicalUrl=${singleLine(summary.canonicalUrl ?? "")}`,
          `language=${singleLine(summary.language ?? "")}`,
          `truncated=${String(summary.truncated)}`,
          "",
          "Headings:",
          headings,
          "",
          "Content:",
          summary.content,
        ].join("\n"),
      },
    ],
  };
}

async function callTakeSnapshot(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(args, ["pageId"], ["verbose"]);
  const pageId = requireUuid(input.pageId, "pageId");
  const verbose = input.verbose === undefined ? false : requireBoolean(input.verbose);
  const snapshot = parsePageSnapshotV2(
    await bridge.request(
      "page.snapshot",
      { pageId, verbose },
      PAGE_SNAPSHOT_TIMEOUT_MS,
    ),
  );
  requireMatchingPageId(snapshot.pageId, pageId);
  return {
    content: [
      {
        type: "text",
        text: [
          "Chrome accessibility snapshot.",
          `pageId=${snapshot.pageId}`,
          `url=${singleLine(snapshot.url)}`,
          `title=${singleLine(snapshot.title)}`,
          `verbose=${String(snapshot.verbose)}`,
          `truncated=${String(snapshot.truncated)}`,
          "",
          snapshot.snapshot,
        ].join("\n"),
      },
    ],
  };
}

async function callUidAction(
  action: "click" | "hover",
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireExactObject(args, ["pageId", "uid"]);
  const pageId = requireUuid(input.pageId, "pageId");
  const uid = requireNonEmptyString(input.uid, "uid", 200);
  const method = action === "click" ? "page.click" : "page.hover";
  const result = parsePageActionResultV2(
    await bridge.request(method, { pageId, uid }, PAGE_ACTION_TIMEOUT_MS),
    action,
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResult(result);
}

async function callFill(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireExactObject(args, ["pageId", "uid", "value"]);
  const pageId = requireUuid(input.pageId, "pageId");
  const uid = requireNonEmptyString(input.uid, "uid", 200);
  const value = requireString(input.value, "value", MAX_ACTION_TEXT_CODE_POINTS);
  const result = parsePageActionResultV2(
    await bridge.request("page.fill", { pageId, uid, value }, PAGE_ACTION_TIMEOUT_MS),
    "fill",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResult(result);
}

async function callPressKey(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireExactObject(args, ["pageId", "key"]);
  const pageId = requireUuid(input.pageId, "pageId");
  const key = requireNonEmptyString(input.key, "key", MAX_KEY_CHARS);
  const result = parsePageActionResultV2(
    await bridge.request("page.press_key", { pageId, key }, PAGE_ACTION_TIMEOUT_MS),
    "press_key",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResult(result);
}

async function callTypeText(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(args, ["pageId", "text"], ["submitKey"]);
  const pageId = requireUuid(input.pageId, "pageId");
  const text = requireNonEmptyString(input.text, "text", MAX_ACTION_TEXT_CODE_POINTS);
  const submitKey =
    input.submitKey === undefined
      ? null
      : requireNonEmptyString(input.submitKey, "submitKey", MAX_KEY_CHARS);
  const result = parsePageActionResultV2(
    await bridge.request(
      "page.type_text",
      { pageId, text, submitKey },
      PAGE_ACTION_TIMEOUT_MS,
    ),
    "type_text",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResult(result);
}

async function callWaitFor(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(args, ["pageId", "text"], ["timeoutMs"]);
  const pageId = requireUuid(input.pageId, "pageId");
  const texts = requireStringArray(input.text, "text", MAX_WAIT_TEXTS);
  const timeoutMs =
    input.timeoutMs === undefined
      ? PAGE_WAIT_DEFAULT_TIMEOUT_MS
      : requireInteger(input.timeoutMs, "timeoutMs", 1, PAGE_WAIT_MAX_TIMEOUT_MS);
  const result = parsePageWaitResultV2(
    await bridge.request(
      "page.wait_for",
      { pageId, texts, timeoutMs },
      timeoutMs + 2_000,
    ),
  );
  requireMatchingPageId(result.pageId, pageId);
  return {
    content: [
      {
        type: "text",
        text: [
          "Chrome wait completed.",
          `pageId=${result.pageId}`,
          `matchedText=${singleLine(result.matchedText)}`,
          `url=${singleLine(result.url)}`,
        ].join("\n"),
      },
    ],
  };
}

async function callScroll(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(args, ["pageId", "direction"], ["amount"]);
  const pageId = requireUuid(input.pageId, "pageId");
  if (
    input.direction !== "up" &&
    input.direction !== "down" &&
    input.direction !== "left" &&
    input.direction !== "right"
  ) {
    throw invalidArgumentError("direction must be up, down, left, or right.");
  }
  const direction = input.direction;
  const amount =
    input.amount === undefined
      ? 500
      : requireInteger(input.amount, "amount", 1, MAX_SCROLL_AMOUNT);
  const result = parsePageActionResultV2(
    await bridge.request(
      "page.scroll",
      { pageId, direction, amount },
      PAGE_ACTION_TIMEOUT_MS,
    ),
    "scroll",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResult(result);
}

function actionResult(
  result: ReturnType<typeof parsePageActionResultV2>,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          "Chrome action completed.",
          `pageId=${result.pageId}`,
          `action=${result.action}`,
          "outcome=performed",
          `url=${singleLine(result.url)}`,
          `navigatedToUrl=${singleLine(result.navigatedToUrl ?? "")}`,
        ].join("\n"),
      },
    ],
  };
}

function errorResult(error: ChromeBridgeError): CallToolResult {
  const details = Object.entries(error.details ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${singleLine(String(value))}`);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: [
          "tinker-chrome error",
          `code=${error.code}`,
          `retryable=${String(error.retryable)}`,
          `outcome=${error.outcome}`,
          `message=${singleLine(error.message).slice(0, 1000)}`,
          ...details,
        ].join("\n"),
      },
    ],
  };
}

function requireExactObject(
  value: Record<string, unknown> | undefined,
  requiredKeys: readonly string[],
): Record<string, unknown> {
  return requireObjectKeys(value, requiredKeys, []);
}

function requireObjectKeys(
  value: Record<string, unknown> | undefined,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): Record<string, unknown> {
  if (value === undefined || value === null || Array.isArray(value)) {
    throw invalidArgumentError("Tool arguments must be an object.");
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw invalidArgumentError(`Tool arguments contain unknown field ${unknown}.`);
  }
  const missing = requiredKeys.find((key) => !(key in value));
  if (missing !== undefined) {
    throw invalidArgumentError(`Tool arguments are missing ${missing}.`);
  }
  return value;
}

function requireString(value: unknown, label: string, maxCodePoints: number): string {
  if (typeof value !== "string") {
    throw invalidArgumentError(`${label} must be a string.`);
  }
  if (Array.from(value).length > maxCodePoints) {
    throw invalidArgumentError(
      `${label} must be at most ${maxCodePoints} Unicode code points.`,
    );
  }
  return value;
}

function requireNonEmptyString(
  value: unknown,
  label: string,
  maxCodePoints: number,
): string {
  const text = requireString(value, label, maxCodePoints);
  if (text.length === 0) {
    throw invalidArgumentError(`${label} must not be empty.`);
  }
  return text;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw invalidArgumentError("verbose must be a boolean.");
  }
  return value;
}

function requireStringArray(value: unknown, label: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw invalidArgumentError(
      `${label} must contain between 1 and ${maxItems} strings.`,
    );
  }
  return value.map((item, index) =>
    requireNonEmptyString(item, `${label}[${index}]`, 1_000),
  );
}

function requireInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw invalidArgumentError(
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value as number;
}

function requireMatchingPageId(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new ChromeBridgeError({
      code: "INVALID_PLUGIN_RESPONSE",
      message: "Chrome returned a different pageId.",
      retryable: false,
      outcome: "unknown",
    });
  }
}

function invalidArgumentError(message: string): ChromeBridgeError {
  return new ChromeBridgeError({
    code: "INVALID_ARGUMENT",
    message,
    retryable: false,
    outcome: "not_started",
  });
}

function invalidUrlError(message: string, cause?: unknown): ChromeBridgeError {
  return new ChromeBridgeError({
    code: "INVALID_URL",
    message,
    retryable: false,
    outcome: "not_started",
    cause,
  });
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
