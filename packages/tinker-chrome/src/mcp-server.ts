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
  MAX_URL_CHARS,
  OPEN_PAGE_TIMEOUT_MS,
  PAGE_SUMMARY_TIMEOUT_MS,
} from "./constants";
import { ChromeBridgeError, internalBridgeError } from "./errors";
import {
  type BridgeMethod,
  parseOpenPageResult,
  parsePageSummary,
  requireUuid,
} from "./protocol-v1";

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
        type: "string",
        format: "uuid",
        description: "Opaque pageId returned by open_page",
      },
    },
    required: ["pageId"],
  },
};

export const TINKER_CHROME_TOOLS = [OPEN_PAGE_TOOL, GET_PAGE_SUMMARY_TOOL] as const;

export type ChromeBridgeClient = {
  request(method: BridgeMethod, params: unknown, timeoutMs: number): Promise<unknown>;
};

export function createTinkerChromeMcpServer(bridge: ChromeBridgeClient): Server {
  const server = new Server(
    { name: "tinker-chrome-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Use open_page before get_page_summary. Only pages opened by this server can be summarized.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...TINKER_CHROME_TOOLS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === OPEN_PAGE_TOOL.name) {
        return await callOpenPage(bridge, request.params.arguments);
      }
      if (request.params.name === GET_PAGE_SUMMARY_TOOL.name) {
        return await callGetPageSummary(bridge, request.params.arguments);
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
  if (typeof input.url !== "string" || input.url.length > MAX_URL_CHARS) {
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
  const result = parseOpenPageResult(
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
  const summary = parsePageSummary(
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
  if (value === undefined || Array.isArray(value)) {
    throw new ChromeBridgeError({
      code: "INTERNAL_ERROR",
      message: "Tool arguments must be an object.",
      retryable: false,
      outcome: "not_started",
    });
  }
  const keys = Object.keys(value);
  if (
    keys.length !== requiredKeys.length ||
    requiredKeys.some((key) => !(key in value))
  ) {
    throw new ChromeBridgeError({
      code: "INTERNAL_ERROR",
      message: `Tool arguments must contain exactly: ${requiredKeys.join(", ")}.`,
      retryable: false,
      outcome: "not_started",
    });
  }
  return value;
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
