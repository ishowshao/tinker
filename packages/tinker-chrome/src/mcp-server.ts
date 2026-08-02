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
  MAX_DEVICE_SCALE_FACTOR,
  MAX_DIALOG_TEXT_CODE_POINTS,
  MAX_EXTRA_HTTP_HEADERS,
  MAX_FILE_PATH_CHARS,
  MAX_FORM_ELEMENTS,
  MAX_HTTP_HEADER_NAME_CHARS,
  MAX_HTTP_HEADER_VALUE_CHARS,
  MAX_KEY_CHARS,
  MAX_SCROLL_AMOUNT,
  MAX_URL_CHARS,
  MAX_VIEWPORT_DIMENSION,
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
  type EmulateParamsV2,
  type GeolocationV2,
  type NetworkConditionV2,
  type ViewportV2,
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
import { resolveUploadFilePath } from "./upload-file-access";

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
const INCLUDE_SNAPSHOT_PROPERTY = {
  type: "boolean" as const,
  description: "Include a fresh bounded accessibility snapshot after the action.",
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
      doubleClick: {
        type: "boolean",
        description: "Click twice instead of once. Default false.",
      },
      includeSnapshot: { ...INCLUDE_SNAPSHOT_PROPERTY },
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
      includeSnapshot: { ...INCLUDE_SNAPSHOT_PROPERTY },
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
      includeSnapshot: { ...INCLUDE_SNAPSHOT_PROPERTY },
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
      includeSnapshot: { ...INCLUDE_SNAPSHOT_PROPERTY },
    },
    required: ["pageId", "uid"],
  },
};

export const FILL_FORM_TOOL: Tool = {
  name: "fill_form",
  description:
    "Fill multiple inputs, selects, checkboxes, radios, or switches from one accessibility snapshot.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      elements: {
        type: "array",
        minItems: 1,
        maxItems: MAX_FORM_ELEMENTS,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            uid: { ...UID_PROPERTY },
            value: {
              type: "string",
              maxLength: MAX_ACTION_TEXT_CODE_POINTS,
              description: "Value to fill; use true or false for toggles",
            },
          },
          required: ["uid", "value"],
        },
      },
      includeSnapshot: { ...INCLUDE_SNAPSHOT_PROPERTY },
    },
    required: ["pageId", "elements"],
  },
};

export const DRAG_TOOL: Tool = {
  name: "drag",
  description: "Drag one element from the latest snapshot onto another element.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      fromUid: { ...UID_PROPERTY, description: "UID of the element to drag" },
      toUid: { ...UID_PROPERTY, description: "UID of the drop target" },
      includeSnapshot: { ...INCLUDE_SNAPSHOT_PROPERTY },
    },
    required: ["pageId", "fromUid", "toUid"],
  },
};

export const RESIZE_PAGE_TOOL: Tool = {
  name: "resize_page",
  description: "Resize the selected Chrome page's content area.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      width: {
        type: "integer",
        minimum: 1,
        maximum: MAX_VIEWPORT_DIMENSION,
      },
      height: {
        type: "integer",
        minimum: 1,
        maximum: MAX_VIEWPORT_DIMENSION,
      },
    },
    required: ["pageId", "width", "height"],
  },
};

export const EMULATE_TOOL: Tool = {
  name: "emulate",
  description:
    "Configure network, CPU, geolocation, user agent, color scheme, viewport, and HTTP-header emulation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      networkConditions: {
        type: "string",
        enum: ["Offline", "Slow 3G", "Fast 3G", "Slow 4G", "Fast 4G"],
        description: "Omit to disable network throttling.",
      },
      cpuThrottlingRate: {
        type: "number",
        minimum: 1,
        maximum: 20,
        description: "CPU slowdown factor. Omit or use 1 to disable throttling.",
      },
      geolocation: {
        type: "string",
        description:
          "Latitude and longitude as <latitude>,<longitude>. Omit to clear the override.",
      },
      userAgent: {
        type: "string",
        maxLength: 1_000,
        description: "Use an empty string to clear the user-agent override.",
      },
      colorScheme: {
        type: "string",
        enum: ["dark", "light", "auto"],
        description: "Omit or use auto to restore the default color scheme.",
      },
      viewport: {
        type: "string",
        description:
          "Viewport as <width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape]. Omit to reset it.",
      },
      extraHttpHeaders: {
        type: "string",
        description:
          'Extra headers as a JSON object string, for example {"X-Test":"value"}. Use an empty string to clear them; omit to preserve them.',
      },
    },
    required: ["pageId"],
  },
};

export const UPLOAD_FILE_TOOL: Tool = {
  name: "upload_file",
  description:
    "Upload one local file through a file input or an element that opens a file chooser.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { ...PAGE_ID_PROPERTY },
      uid: { ...UID_PROPERTY },
      filePath: {
        type: "string",
        minLength: 1,
        maxLength: MAX_FILE_PATH_CHARS,
        description:
          "Absolute path inside an MCP workspace root or the system temporary directory",
      },
      includeSnapshot: { ...INCLUDE_SNAPSHOT_PROPERTY },
    },
    required: ["pageId", "uid", "filePath"],
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
  FILL_FORM_TOOL,
  DRAG_TOOL,
  PRESS_KEY_TOOL,
  TYPE_TEXT_TOOL,
  WAIT_FOR_TOOL,
  SCROLL_TOOL,
  HOVER_TOOL,
  RESIZE_PAGE_TOOL,
  EMULATE_TOOL,
  UPLOAD_FILE_TOOL,
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
        "Use open_page first and retain its pageId. Use list_pages to recover owned pageIds. Take a fresh snapshot before uid-based actions and after every navigation. Prefer fill_form over repeated fill calls. If an action reports a dialog, call handle_dialog. Use list_console_messages/list_network_requests before their matching get tool. Only pages opened by this server can be observed or controlled. upload_file accepts files only from client workspace roots or the system temporary directory.",
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
          return await callClick(bridge, request.params.arguments);
        case FILL_TOOL.name:
          return await callFill(bridge, request.params.arguments);
        case FILL_FORM_TOOL.name:
          return await callFillForm(bridge, request.params.arguments);
        case DRAG_TOOL.name:
          return await callDrag(bridge, request.params.arguments);
        case PRESS_KEY_TOOL.name:
          return await callPressKey(bridge, request.params.arguments);
        case TYPE_TEXT_TOOL.name:
          return await callTypeText(bridge, request.params.arguments);
        case WAIT_FOR_TOOL.name:
          return await callWaitFor(bridge, request.params.arguments);
        case SCROLL_TOOL.name:
          return await callScroll(bridge, request.params.arguments);
        case HOVER_TOOL.name:
          return await callHover(bridge, request.params.arguments);
        case RESIZE_PAGE_TOOL.name:
          return await callResizePage(bridge, request.params.arguments);
        case EMULATE_TOOL.name:
          return await callEmulate(bridge, request.params.arguments);
        case UPLOAD_FILE_TOOL.name:
          return await callUploadFile(bridge, request.params.arguments, async () => {
            if (server.getClientCapabilities()?.roots === undefined) {
              return [];
            }
            return (await server.listRoots()).roots.map((root) => root.uri);
          });
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

async function callClick(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(
    args,
    ["pageId", "uid"],
    ["doubleClick", "includeSnapshot"],
  );
  const pageId = requireUuid(input.pageId, "pageId");
  const uid = requireNonEmptyString(input.uid, "uid", 200);
  const doubleClick = optionalBoolean(input.doubleClick, "doubleClick");
  const includeSnapshot = optionalBoolean(input.includeSnapshot, "includeSnapshot");
  const result = parsePageActionResultV2(
    await bridge.request(
      "page.click",
      { pageId, uid, doubleClick },
      PAGE_ACTION_TIMEOUT_MS,
    ),
    "click",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResultWithSnapshot(bridge, result, includeSnapshot);
}

async function callFill(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(
    args,
    ["pageId", "uid", "value"],
    ["includeSnapshot"],
  );
  const pageId = requireUuid(input.pageId, "pageId");
  const uid = requireNonEmptyString(input.uid, "uid", 200);
  const value = requireString(input.value, "value", MAX_ACTION_TEXT_CODE_POINTS);
  const includeSnapshot = optionalBoolean(input.includeSnapshot, "includeSnapshot");
  const result = parsePageActionResultV2(
    await bridge.request("page.fill", { pageId, uid, value }, PAGE_ACTION_TIMEOUT_MS),
    "fill",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResultWithSnapshot(bridge, result, includeSnapshot);
}

async function callFillForm(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(args, ["pageId", "elements"], ["includeSnapshot"]);
  const pageId = requireUuid(input.pageId, "pageId");
  if (
    !Array.isArray(input.elements) ||
    input.elements.length === 0 ||
    input.elements.length > MAX_FORM_ELEMENTS
  ) {
    throw invalidArgumentError(
      `elements must contain between 1 and ${MAX_FORM_ELEMENTS} items.`,
    );
  }
  const elements = input.elements.map((value, index) => {
    const element = requireUnknownObject(value, `elements[${index}]`, ["uid", "value"]);
    return {
      uid: requireNonEmptyString(element.uid, `elements[${index}].uid`, 200),
      value: requireString(
        element.value,
        `elements[${index}].value`,
        MAX_ACTION_TEXT_CODE_POINTS,
      ),
    };
  });
  const includeSnapshot = optionalBoolean(input.includeSnapshot, "includeSnapshot");
  const result = parsePageActionResultV2(
    await bridge.request(
      "page.fill_form",
      { pageId, elements },
      PAGE_ACTION_TIMEOUT_MS,
    ),
    "fill_form",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResultWithSnapshot(bridge, result, includeSnapshot);
}

async function callDrag(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(
    args,
    ["pageId", "fromUid", "toUid"],
    ["includeSnapshot"],
  );
  const pageId = requireUuid(input.pageId, "pageId");
  const fromUid = requireNonEmptyString(input.fromUid, "fromUid", 200);
  const toUid = requireNonEmptyString(input.toUid, "toUid", 200);
  const includeSnapshot = optionalBoolean(input.includeSnapshot, "includeSnapshot");
  const result = parsePageActionResultV2(
    await bridge.request(
      "page.drag",
      { pageId, fromUid, toUid },
      PAGE_ACTION_TIMEOUT_MS,
    ),
    "drag",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResultWithSnapshot(bridge, result, includeSnapshot);
}

async function callPressKey(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(args, ["pageId", "key"], ["includeSnapshot"]);
  const pageId = requireUuid(input.pageId, "pageId");
  const key = requireNonEmptyString(input.key, "key", MAX_KEY_CHARS);
  const includeSnapshot = optionalBoolean(input.includeSnapshot, "includeSnapshot");
  const result = parsePageActionResultV2(
    await bridge.request("page.press_key", { pageId, key }, PAGE_ACTION_TIMEOUT_MS),
    "press_key",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResultWithSnapshot(bridge, result, includeSnapshot);
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

async function callHover(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(args, ["pageId", "uid"], ["includeSnapshot"]);
  const pageId = requireUuid(input.pageId, "pageId");
  const uid = requireNonEmptyString(input.uid, "uid", 200);
  const includeSnapshot = optionalBoolean(input.includeSnapshot, "includeSnapshot");
  const result = parsePageActionResultV2(
    await bridge.request("page.hover", { pageId, uid }, PAGE_ACTION_TIMEOUT_MS),
    "hover",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResultWithSnapshot(bridge, result, includeSnapshot);
}

async function callResizePage(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireExactObject(args, ["pageId", "width", "height"]);
  const pageId = requireUuid(input.pageId, "pageId");
  const width = requireInteger(input.width, "width", 1, MAX_VIEWPORT_DIMENSION);
  const height = requireInteger(input.height, "height", 1, MAX_VIEWPORT_DIMENSION);
  const result = parsePageActionResultV2(
    await bridge.request(
      "page.resize",
      { pageId, width, height },
      PAGE_ACTION_TIMEOUT_MS,
    ),
    "resize_page",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResult(result);
}

async function callEmulate(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const input = requireObjectKeys(
    args,
    ["pageId"],
    [
      "networkConditions",
      "cpuThrottlingRate",
      "geolocation",
      "userAgent",
      "colorScheme",
      "viewport",
      "extraHttpHeaders",
    ],
  );
  const pageId = requireUuid(input.pageId, "pageId");
  const networkConditions = parseNetworkConditions(input.networkConditions);
  const cpuThrottlingRate =
    input.cpuThrottlingRate === undefined
      ? 1
      : requireNumber(input.cpuThrottlingRate, "cpuThrottlingRate", 1, 20);
  const geolocation = parseGeolocation(input.geolocation);
  const userAgent =
    input.userAgent === undefined
      ? null
      : requireString(input.userAgent, "userAgent", 1_000) || null;
  const colorScheme = parseColorScheme(input.colorScheme);
  const viewport = parseViewport(input.viewport);
  const extraHttpHeaders = parseExtraHttpHeaders(input.extraHttpHeaders);
  const result = parsePageActionResultV2(
    await bridge.request(
      "page.emulate",
      {
        pageId,
        networkConditions,
        cpuThrottlingRate,
        geolocation,
        userAgent,
        colorScheme,
        viewport,
        extraHttpHeaders,
      },
      PAGE_NAVIGATION_TIMEOUT_MS,
    ),
    "emulate",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResult(result);
}

async function callUploadFile(
  bridge: ChromeBridgeClient,
  args: Record<string, unknown> | undefined,
  rootUris: () => Promise<string[]>,
): Promise<CallToolResult> {
  const input = requireObjectKeys(
    args,
    ["pageId", "uid", "filePath"],
    ["includeSnapshot"],
  );
  const pageId = requireUuid(input.pageId, "pageId");
  const uid = requireNonEmptyString(input.uid, "uid", 200);
  const requestedPath = requireNonEmptyString(
    input.filePath,
    "filePath",
    MAX_FILE_PATH_CHARS,
  );
  const includeSnapshot = optionalBoolean(input.includeSnapshot, "includeSnapshot");
  const filePath = await resolveUploadFilePath(requestedPath, await rootUris());
  const result = parsePageActionResultV2(
    await bridge.request(
      "page.upload_file",
      { pageId, uid, filePath },
      PAGE_ACTION_TIMEOUT_MS,
    ),
    "upload_file",
  );
  requireMatchingPageId(result.pageId, pageId);
  return actionResultWithSnapshot(bridge, result, includeSnapshot);
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

async function actionResultWithSnapshot(
  bridge: ChromeBridgeClient,
  result: ReturnType<typeof parsePageActionResultV2>,
  includeSnapshot: boolean,
): Promise<CallToolResult> {
  const base = actionResult(result);
  if (!includeSnapshot) {
    return base;
  }
  const block = base.content[0];
  if (block?.type !== "text") {
    throw new Error("Chrome action result must contain text.");
  }
  if (result.dialog !== null) {
    return {
      content: [
        {
          type: "text",
          text: `${block.text}\npostActionSnapshot=blocked_by_dialog`,
        },
      ],
    };
  }
  try {
    const snapshot = parsePageSnapshotV2(
      await bridge.request(
        "page.snapshot",
        { pageId: result.pageId, verbose: false },
        PAGE_SNAPSHOT_TIMEOUT_MS,
      ),
    );
    requireMatchingPageId(snapshot.pageId, result.pageId);
    return {
      content: [
        {
          type: "text",
          text: [
            block.text,
            "postActionSnapshot=included",
            `snapshotTruncated=${String(snapshot.truncated)}`,
            "",
            snapshot.snapshot,
          ].join("\n"),
        },
      ],
    };
  } catch (error) {
    const snapshotError = internalBridgeError(error);
    return {
      content: [
        {
          type: "text",
          text: [
            block.text,
            "postActionSnapshot=unavailable",
            `snapshotErrorCode=${snapshotError.code}`,
            `snapshotError=${singleLine(snapshotError.message).slice(0, 1_000)}`,
          ].join("\n"),
        },
      ],
    };
  }
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

function optionalBoolean(value: unknown, label: string): boolean {
  return value === undefined ? false : requireBoolean(value, label);
}

function requireNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidArgumentError(
      `${label} must be a number from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

function requireUnknownObject(
  value: unknown,
  label: string,
  requiredKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidArgumentError(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !requiredKeys.includes(key));
  if (unknown !== undefined) {
    throw invalidArgumentError(`${label} contains unknown field ${unknown}.`);
  }
  const missing = requiredKeys.find((key) => !(key in record));
  if (missing !== undefined) {
    throw invalidArgumentError(`${label} is missing ${missing}.`);
  }
  return record;
}

function parseNetworkConditions(value: unknown): NetworkConditionV2 | null {
  if (value === undefined) {
    return null;
  }
  const supported: readonly NetworkConditionV2[] = [
    "Offline",
    "Slow 3G",
    "Fast 3G",
    "Slow 4G",
    "Fast 4G",
  ];
  if (!supported.includes(value as NetworkConditionV2)) {
    throw invalidArgumentError("networkConditions is not supported.");
  }
  return value as NetworkConditionV2;
}

function parseColorScheme(value: unknown): EmulateParamsV2["colorScheme"] {
  if (value === undefined) {
    return "auto";
  }
  if (value !== "dark" && value !== "light" && value !== "auto") {
    throw invalidArgumentError("colorScheme must be dark, light, or auto.");
  }
  return value;
}

function parseGeolocation(value: unknown): GeolocationV2 | null {
  if (value === undefined) {
    return null;
  }
  const parts = requireNonEmptyString(value, "geolocation", 100).split(",");
  if (parts.length !== 2) {
    throw invalidArgumentError("geolocation must use <latitude>,<longitude>.");
  }
  return {
    latitude: requireNumber(Number(parts[0]), "latitude", -90, 90),
    longitude: requireNumber(Number(parts[1]), "longitude", -180, 180),
  };
}

function parseViewport(value: unknown): ViewportV2 | null {
  if (value === undefined) {
    return null;
  }
  const [dimensions = "", ...tags] = requireNonEmptyString(
    value,
    "viewport",
    200,
  ).split(",");
  const dimensionParts = dimensions.split("x");
  if (dimensionParts.length < 2 || dimensionParts.length > 3) {
    throw invalidArgumentError(
      "viewport must use <width>x<height>x<devicePixelRatio>.",
    );
  }
  const allowedTags = ["mobile", "touch", "landscape"] as const;
  if (
    tags.some((tag) => !allowedTags.includes(tag as (typeof allowedTags)[number])) ||
    new Set(tags).size !== tags.length
  ) {
    throw invalidArgumentError(
      "viewport tags may contain mobile, touch, and landscape once each.",
    );
  }
  const width = requireInteger(
    Number(dimensionParts[0]),
    "viewport width",
    1,
    MAX_VIEWPORT_DIMENSION,
  );
  const height = requireInteger(
    Number(dimensionParts[1]),
    "viewport height",
    1,
    MAX_VIEWPORT_DIMENSION,
  );
  const deviceScaleFactor =
    dimensionParts[2] === undefined
      ? 1
      : requireNumber(
          Number(dimensionParts[2]),
          "viewport devicePixelRatio",
          0.1,
          MAX_DEVICE_SCALE_FACTOR,
        );
  return {
    width,
    height,
    deviceScaleFactor,
    isMobile: tags.includes("mobile"),
    hasTouch: tags.includes("touch"),
    isLandscape: tags.includes("landscape"),
  };
}

function parseExtraHttpHeaders(value: unknown): Record<string, string> | null {
  if (value === undefined) {
    return null;
  }
  const input = requireString(value, "extraHttpHeaders", 64_000);
  if (input === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw invalidArgumentError(
      `extraHttpHeaders is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidArgumentError("extraHttpHeaders must be a JSON object.");
  }
  const entries = Object.entries(parsed);
  if (entries.length > MAX_EXTRA_HTTP_HEADERS) {
    throw invalidArgumentError(
      `extraHttpHeaders may contain at most ${MAX_EXTRA_HTTP_HEADERS} entries.`,
    );
  }
  return Object.fromEntries(
    entries.map(([name, headerValue]) => [
      requireNonEmptyString(name, "HTTP header name", MAX_HTTP_HEADER_NAME_CHARS),
      requireString(headerValue, `HTTP header ${name}`, MAX_HTTP_HEADER_VALUE_CHARS),
    ]),
  );
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
