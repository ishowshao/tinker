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
  CONSOLE_MESSAGE_TYPES,
  DEBUG_LIST_DEFAULT_PAGE_SIZE,
  DEBUG_LIST_MAX_PAGE_SIZE,
  MAX_ACTION_TEXT_CODE_POINTS,
  MAX_DIALOG_TEXT_CODE_POINTS,
  MAX_KEY_CHARS,
  MAX_SCROLL_AMOUNT,
  MAX_URL_CHARS,
  MAX_WAIT_TEXTS,
  NETWORK_RESOURCE_TYPES,
  OPEN_PAGE_TIMEOUT_MS,
  PAGE_ACTION_TIMEOUT_MS,
  PAGE_DEBUG_TIMEOUT_MS,
  PAGE_NAVIGATION_TIMEOUT_MS,
  PAGE_SNAPSHOT_TIMEOUT_MS,
  PAGE_SUMMARY_TIMEOUT_MS,
  PAGE_WAIT_DEFAULT_TIMEOUT_MS,
  PAGE_WAIT_MAX_TIMEOUT_MS,
  PLUGIN_VERSION,
} from "./constants";
import { ChromeBridgeError, internalBridgeError } from "./errors";
import {
  type BridgeMethodV2,
  parseClosePageResultV2,
  parseGetConsoleMessageResultV2,
  parseGetNetworkRequestResultV2,
  parseListConsoleMessagesResultV2,
  parseListNetworkRequestsResultV2,
  parseListPagesResultV2,
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

export const LIST_PAGES_TOOL: Tool = {
  name: "list_pages",
  description: "List HTTP(S) Chrome pages owned by this Tinker runtime.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
};

export const NAVIGATE_PAGE_TOOL: Tool = {
  name: "navigate_page",
  description: "Navigate an owned page by URL, back, forward, or reload.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      type: {
        type: "string",
        enum: ["url", "back", "forward", "reload"],
      },
      url: {
        type: "string",
        minLength: 1,
        maxLength: MAX_URL_CHARS,
        description: "Required only when type is url; must be HTTP or HTTPS",
      },
      ignoreCache: {
        type: "boolean",
        description: "Ignore cache when type is reload. Default false.",
      },
      handleBeforeUnload: {
        type: "string",
        enum: ["accept", "dismiss"],
        description: "How to handle beforeunload dialogs. Default accept.",
      },
    },
    required: ["pageId", "type"],
  },
};

export const CLOSE_PAGE_TOOL: Tool = {
  name: "close_page",
  description: "Close a Chrome page owned by this Tinker runtime.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { pageId: { ...PAGE_ID_PROPERTY } },
    required: ["pageId"],
  },
};

export const HANDLE_DIALOG_TOOL: Tool = {
  name: "handle_dialog",
  description: "Accept or dismiss an open JavaScript dialog on an owned page.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      action: { type: "string", enum: ["accept", "dismiss"] },
      promptText: {
        type: "string",
        maxLength: MAX_DIALOG_TEXT_CODE_POINTS,
        description: "Optional prompt value when accepting a prompt dialog",
      },
    },
    required: ["pageId", "action"],
  },
};

export const LIST_CONSOLE_MESSAGES_TOOL: Tool = {
  name: "list_console_messages",
  description:
    "List bounded console messages collected for an owned page since its latest navigation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      pageIdx: { type: "integer", minimum: 0 },
      pageSize: {
        type: "integer",
        minimum: 1,
        maximum: DEBUG_LIST_MAX_PAGE_SIZE,
        description: `Default ${DEBUG_LIST_DEFAULT_PAGE_SIZE}`,
      },
      types: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", enum: [...CONSOLE_MESSAGE_TYPES] },
      },
      includePreservedMessages: {
        type: "boolean",
        description: "Include messages preserved across the latest three navigations",
      },
    },
    required: ["pageId"],
  },
};

export const GET_CONSOLE_MESSAGE_TOOL: Tool = {
  name: "get_console_message",
  description: "Get bounded arguments and stack details for one console message ID.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      msgid: { type: "integer", minimum: 1 },
    },
    required: ["pageId", "msgid"],
  },
};

export const LIST_NETWORK_REQUESTS_TOOL: Tool = {
  name: "list_network_requests",
  description:
    "List bounded network requests collected for an owned page since its latest navigation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      pageIdx: { type: "integer", minimum: 0 },
      pageSize: {
        type: "integer",
        minimum: 1,
        maximum: DEBUG_LIST_MAX_PAGE_SIZE,
        description: `Default ${DEBUG_LIST_DEFAULT_PAGE_SIZE}`,
      },
      resourceTypes: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", enum: [...NETWORK_RESOURCE_TYPES] },
      },
      includePreservedRequests: {
        type: "boolean",
        description: "Include requests preserved across the latest three navigations",
      },
    },
    required: ["pageId"],
  },
};

export const GET_NETWORK_REQUEST_TOOL: Tool = {
  name: "get_network_request",
  description:
    "Get bounded request headers, bodies, response data, failure, and redirects for one request ID.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      reqid: { type: "integer", minimum: 1 },
    },
    required: ["pageId", "reqid"],
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
  LIST_PAGES_TOOL,
  NAVIGATE_PAGE_TOOL,
  CLOSE_PAGE_TOOL,
  HANDLE_DIALOG_TOOL,
  LIST_CONSOLE_MESSAGES_TOOL,
  GET_CONSOLE_MESSAGE_TOOL,
  LIST_NETWORK_REQUESTS_TOOL,
  GET_NETWORK_REQUEST_TOOL,
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
        "Use open_page first and retain its pageId. Use list_pages to recover owned pageIds. Take a fresh snapshot before uid-based actions and after every navigation. If an action reports a dialog, call handle_dialog. Use list_console_messages/list_network_requests before their matching get tool. Only pages opened by this server can be observed or controlled.",
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
        case LIST_PAGES_TOOL.name:
          return await callListPages(bridge, request.params.arguments);
        case NAVIGATE_PAGE_TOOL.name:
          return await callNavigatePage(bridge, request.params.arguments);
        case CLOSE_PAGE_TOOL.name:
          return await callClosePage(bridge, request.params.arguments);
        case HANDLE_DIALOG_TOOL.name:
          return await callHandleDialog(bridge, request.params.arguments);
        case LIST_CONSOLE_MESSAGES_TOOL.name:
          return await callListConsoleMessages(bridge, request.params.arguments);
        case GET_CONSOLE_MESSAGE_TOOL.name:
          return await callGetConsoleMessage(bridge, request.params.arguments);
        case LIST_NETWORK_REQUESTS_TOOL.name:
          return await callListNetworkRequests(bridge, request.params.arguments);
        case GET_NETWORK_REQUEST_TOOL.name:
          return await callGetNetworkRequest(bridge, request.params.arguments);
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
  const verbose =
    input.verbose === undefined ? false : requireBoolean(input.verbose, "verbose");
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

async function callListPages(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  requireNoArguments(args);
  const result = parseListPagesResultV2(
    await bridge.request("page.list", {}, PAGE_DEBUG_TIMEOUT_MS),
  );
  const pages =
    result.pages.length === 0
      ? "<no owned Chrome pages>"
      : result.pages
          .map((page) =>
            [
              `pageId=${page.pageId}`,
              `url=${singleLine(page.url)}`,
              `title=${singleLine(page.title)}`,
              `loadState=${page.loadState}`,
              `active=${String(page.active)}`,
            ].join(" "),
          )
          .join("\n");
  return {
    content: [
      {
        type: "text",
        text: [
          "Chrome pages owned by this Tinker runtime.",
          `count=${result.pages.length}`,
          `truncated=${String(result.truncated)}`,
          "",
          pages,
        ].join("\n"),
      },
    ],
  };
}

async function callNavigatePage(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(
    args,
    ["pageId", "type"],
    ["url", "ignoreCache", "handleBeforeUnload"],
  );
  const pageId = requireUuid(input.pageId, "pageId");
  if (
    input.type !== "url" &&
    input.type !== "back" &&
    input.type !== "forward" &&
    input.type !== "reload"
  ) {
    throw invalidArgumentError("type must be url, back, forward, or reload.");
  }
  const type = input.type;
  let url: string | null = null;
  if (type === "url") {
    if (input.url === undefined) {
      throw invalidArgumentError("url is required when type is url.");
    }
    url = requireHttpUrl(input.url);
  } else if (input.url !== undefined) {
    throw invalidArgumentError("url is allowed only when type is url.");
  }
  const ignoreCache =
    input.ignoreCache === undefined
      ? false
      : requireBoolean(input.ignoreCache, "ignoreCache");
  if (ignoreCache && type !== "reload") {
    throw invalidArgumentError("ignoreCache is allowed only when type is reload.");
  }
  if (
    input.handleBeforeUnload !== undefined &&
    input.handleBeforeUnload !== "accept" &&
    input.handleBeforeUnload !== "dismiss"
  ) {
    throw invalidArgumentError("handleBeforeUnload must be accept or dismiss.");
  }
  const handleBeforeUnload = input.handleBeforeUnload ?? "accept";
  const result = parsePageActionResultV2(
    await bridge.request(
      "page.navigate",
      { pageId, type, url, ignoreCache, handleBeforeUnload },
      PAGE_NAVIGATION_TIMEOUT_MS,
    ),
    "navigate_page",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResult(result);
}

async function callClosePage(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireExactObject(args, ["pageId"]);
  const pageId = requireUuid(input.pageId, "pageId");
  const result = parseClosePageResultV2(
    await bridge.request("page.close", { pageId }, PAGE_ACTION_TIMEOUT_MS),
  );
  requireMatchingPageId(result.pageId, pageId);
  return {
    content: [
      {
        type: "text",
        text: [
          "Chrome page closed.",
          `pageId=${result.pageId}`,
          "outcome=performed",
        ].join("\n"),
      },
    ],
  };
}

async function callHandleDialog(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(args, ["pageId", "action"], ["promptText"]);
  const pageId = requireUuid(input.pageId, "pageId");
  if (input.action !== "accept" && input.action !== "dismiss") {
    throw invalidArgumentError("action must be accept or dismiss.");
  }
  const action = input.action;
  const promptText =
    input.promptText === undefined
      ? null
      : requireString(input.promptText, "promptText", MAX_DIALOG_TEXT_CODE_POINTS);
  if (action === "dismiss" && promptText !== null) {
    throw invalidArgumentError("promptText is allowed only when action is accept.");
  }
  const result = parsePageActionResultV2(
    await bridge.request(
      "page.handle_dialog",
      { pageId, action, promptText },
      PAGE_ACTION_TIMEOUT_MS,
    ),
    "handle_dialog",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResult(result);
}

async function callListConsoleMessages(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(
    args,
    ["pageId"],
    ["pageIdx", "pageSize", "types", "includePreservedMessages"],
  );
  const pageId = requireUuid(input.pageId, "pageId");
  const pageIdx =
    input.pageIdx === undefined
      ? 0
      : requireInteger(input.pageIdx, "pageIdx", 0, Number.MAX_SAFE_INTEGER);
  const pageSize =
    input.pageSize === undefined
      ? DEBUG_LIST_DEFAULT_PAGE_SIZE
      : requireInteger(input.pageSize, "pageSize", 1, DEBUG_LIST_MAX_PAGE_SIZE);
  const types =
    input.types === undefined
      ? []
      : requireEnumArray(input.types, "types", CONSOLE_MESSAGE_TYPES);
  const includePreservedMessages =
    input.includePreservedMessages === undefined
      ? false
      : requireBoolean(input.includePreservedMessages, "includePreservedMessages");
  const result = parseListConsoleMessagesResultV2(
    await bridge.request(
      "page.console.list",
      { pageId, pageIdx, pageSize, types, includePreservedMessages },
      PAGE_DEBUG_TIMEOUT_MS,
    ),
  );
  requireMatchingPageId(result.pageId, pageId);
  return debugListResult("Chrome console messages.", result, result.totalMessages);
}

async function callGetConsoleMessage(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireExactObject(args, ["pageId", "msgid"]);
  const pageId = requireUuid(input.pageId, "pageId");
  const msgid = requireInteger(input.msgid, "msgid", 1, Number.MAX_SAFE_INTEGER);
  const result = parseGetConsoleMessageResultV2(
    await bridge.request("page.console.get", { pageId, msgid }, PAGE_DEBUG_TIMEOUT_MS),
  );
  requireMatchingPageId(result.pageId, pageId);
  return debugDetailResult("Chrome console message.", result);
}

async function callListNetworkRequests(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(
    args,
    ["pageId"],
    ["pageIdx", "pageSize", "resourceTypes", "includePreservedRequests"],
  );
  const pageId = requireUuid(input.pageId, "pageId");
  const pageIdx =
    input.pageIdx === undefined
      ? 0
      : requireInteger(input.pageIdx, "pageIdx", 0, Number.MAX_SAFE_INTEGER);
  const pageSize =
    input.pageSize === undefined
      ? DEBUG_LIST_DEFAULT_PAGE_SIZE
      : requireInteger(input.pageSize, "pageSize", 1, DEBUG_LIST_MAX_PAGE_SIZE);
  const resourceTypes =
    input.resourceTypes === undefined
      ? []
      : requireEnumArray(input.resourceTypes, "resourceTypes", NETWORK_RESOURCE_TYPES);
  const includePreservedRequests =
    input.includePreservedRequests === undefined
      ? false
      : requireBoolean(input.includePreservedRequests, "includePreservedRequests");
  const result = parseListNetworkRequestsResultV2(
    await bridge.request(
      "page.network.list",
      { pageId, pageIdx, pageSize, resourceTypes, includePreservedRequests },
      PAGE_DEBUG_TIMEOUT_MS,
    ),
  );
  requireMatchingPageId(result.pageId, pageId);
  return debugListResult("Chrome network requests.", result, result.totalRequests);
}

async function callGetNetworkRequest(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireExactObject(args, ["pageId", "reqid"]);
  const pageId = requireUuid(input.pageId, "pageId");
  const reqid = requireInteger(input.reqid, "reqid", 1, Number.MAX_SAFE_INTEGER);
  const result = parseGetNetworkRequestResultV2(
    await bridge.request("page.network.get", { pageId, reqid }, PAGE_DEBUG_TIMEOUT_MS),
  );
  requireMatchingPageId(result.pageId, pageId);
  return debugDetailResult("Chrome network request.", result);
}

function actionResult(
  result: ReturnType<typeof parsePageActionResultV2>,
): CallToolResult {
  const dialogLines =
    result.dialog === null
      ? []
      : [
          `dialogType=${result.dialog.type}`,
          `dialogMessage=${singleLine(result.dialog.message)}`,
          `dialogDefaultValue=${singleLine(result.dialog.defaultValue)}`,
          "Call handle_dialog before continuing page interaction.",
        ];
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
          ...dialogLines,
        ].join("\n"),
      },
    ],
  };
}

function debugListResult(
  heading: string,
  result: {
    pageId: string;
    pageIdx: number;
    pageSize: number;
    totalPages: number;
    output: string;
    truncated: boolean;
  },
  totalItems: number,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          heading,
          `pageId=${result.pageId}`,
          `pageIdx=${result.pageIdx}`,
          `pageSize=${result.pageSize}`,
          `totalItems=${totalItems}`,
          `totalPages=${result.totalPages}`,
          `truncated=${String(result.truncated)}`,
          "",
          result.output,
        ].join("\n"),
      },
    ],
  };
}

function debugDetailResult(
  heading: string,
  result: { pageId: string; output: string; truncated: boolean },
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          heading,
          `pageId=${result.pageId}`,
          `truncated=${String(result.truncated)}`,
          "",
          result.output,
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

function requireNoArguments(value: Record<string, unknown> | undefined): void {
  if (value === undefined) {
    return;
  }
  requireExactObject(value, []);
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

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidArgumentError(`${label} must be a boolean.`);
  }
  return value;
}

function requireEnumArray<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T[] {
  if (!Array.isArray(value) || value.length > allowed.length) {
    throw invalidArgumentError(`${label} must be an array of supported values.`);
  }
  const items = value.map((item) => {
    if (!allowed.includes(item as T)) {
      throw invalidArgumentError(
        `${label} contains unsupported value ${JSON.stringify(item)}.`,
      );
    }
    return item as T;
  });
  if (new Set(items).size !== items.length) {
    throw invalidArgumentError(`${label} must not contain duplicate values.`);
  }
  return items;
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

function requireHttpUrl(value: unknown): string {
  const input = requireNonEmptyString(value, "url", MAX_URL_CHARS);
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw invalidUrlError("url is not a valid absolute URL.", error);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidUrlError("Only http: and https: URLs are supported.");
  }
  return url.href;
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
