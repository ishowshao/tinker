import {
  CONSOLE_MESSAGE_TYPES,
  DEBUG_LIST_MAX_PAGE_SIZE,
  MAX_ACTION_TEXT_CODE_POINTS,
  MAX_CONTENT_CODE_POINTS,
  MAX_DEBUG_OUTPUT_CODE_POINTS,
  MAX_DIALOG_TEXT_CODE_POINTS,
  MAX_DESCRIPTION_CODE_POINTS,
  MAX_HEADING_CODE_POINTS,
  MAX_HEADINGS,
  MAX_KEY_CHARS,
  MAX_OWNED_PAGES,
  MAX_SCROLL_AMOUNT,
  MAX_SNAPSHOT_CODE_POINTS,
  MAX_URL_CHARS,
  MAX_WAIT_TEXTS,
  NETWORK_RESOURCE_TYPES,
  PAGE_WAIT_MAX_TIMEOUT_MS,
  PLUGIN_CAPABILITIES_V2,
  PROTOCOL_VERSION_V2,
} from "./constants";
import {
  type ChromeBridgeErrorCodeV2,
  type ChromeBridgeErrorDetails,
  type ChromeBridgeOutcome,
  isChromeBridgeErrorCodeV2,
} from "./errors";

export type PluginCapabilityV2 = (typeof PLUGIN_CAPABILITIES_V2)[number];
export type BridgeMethodV2 = PluginCapabilityV2;
export type ScrollDirectionV2 = "up" | "down" | "left" | "right";
export type NavigationTypeV2 = "url" | "back" | "forward" | "reload";
export type DialogActionV2 = "accept" | "dismiss";
export type DialogTypeV2 = "alert" | "beforeunload" | "confirm" | "prompt";
export type ConsoleMessageTypeV2 = (typeof CONSOLE_MESSAGE_TYPES)[number];
export type NetworkResourceTypeV2 = (typeof NETWORK_RESOURCE_TYPES)[number];
export type PageActionV2 =
  | "click"
  | "fill"
  | "press_key"
  | "type_text"
  | "scroll"
  | "hover"
  | "navigate_page"
  | "handle_dialog";

export type PageDialogInfoV2 = {
  type: DialogTypeV2;
  message: string;
  defaultValue: string;
};

export type PluginHelloV2 = {
  kind: "plugin_hello";
  protocolVersion: 2;
  pluginVersion: string;
  capabilities: PluginCapabilityV2[];
};

export type BridgeHelloV2 = {
  kind: "hello";
  protocolVersion: 2;
  runtimeId: string;
  authToken: string;
  extensionOrigin: string;
  pluginVersion: string;
  capabilities: PluginCapabilityV2[];
};

export type BridgeHelloAckV2 = {
  kind: "hello_ack";
  protocolVersion: 2;
  runtimeId: string;
};

export type OpenPageParamsV2 = { pageId: string; url: string };
export type PageIdParamsV2 = { pageId: string };
export type SnapshotParamsV2 = { pageId: string; verbose: boolean };
export type ClickParamsV2 = { pageId: string; uid: string };
export type FillParamsV2 = { pageId: string; uid: string; value: string };
export type PressKeyParamsV2 = { pageId: string; key: string };
export type TypeTextParamsV2 = {
  pageId: string;
  text: string;
  submitKey: string | null;
};
export type WaitForParamsV2 = {
  pageId: string;
  texts: string[];
  timeoutMs: number;
};
export type ScrollParamsV2 = {
  pageId: string;
  direction: ScrollDirectionV2;
  amount: number;
};
export type HoverParamsV2 = { pageId: string; uid: string };
export type ListPagesParamsV2 = Record<string, never>;
export type NavigatePageParamsV2 = {
  pageId: string;
  type: NavigationTypeV2;
  url: string | null;
  ignoreCache: boolean;
  handleBeforeUnload: DialogActionV2;
};
export type HandleDialogParamsV2 = {
  pageId: string;
  action: DialogActionV2;
  promptText: string | null;
};
export type ListConsoleMessagesParamsV2 = {
  pageId: string;
  pageIdx: number;
  pageSize: number;
  types: ConsoleMessageTypeV2[];
  includePreservedMessages: boolean;
};
export type GetConsoleMessageParamsV2 = { pageId: string; msgid: number };
export type ListNetworkRequestsParamsV2 = {
  pageId: string;
  pageIdx: number;
  pageSize: number;
  resourceTypes: NetworkResourceTypeV2[];
  includePreservedRequests: boolean;
};
export type GetNetworkRequestParamsV2 = { pageId: string; reqid: number };

type BridgeRequestBaseV2 = {
  kind: "request";
  protocolVersion: 2;
  runtimeId: string;
  requestId: string;
  deadlineUnixMs: number;
};

export type BridgeRequestV2 =
  | (BridgeRequestBaseV2 & { method: "page.open"; params: OpenPageParamsV2 })
  | (BridgeRequestBaseV2 & { method: "page.summary"; params: PageIdParamsV2 })
  | (BridgeRequestBaseV2 & { method: "page.snapshot"; params: SnapshotParamsV2 })
  | (BridgeRequestBaseV2 & { method: "page.click"; params: ClickParamsV2 })
  | (BridgeRequestBaseV2 & { method: "page.fill"; params: FillParamsV2 })
  | (BridgeRequestBaseV2 & {
      method: "page.press_key";
      params: PressKeyParamsV2;
    })
  | (BridgeRequestBaseV2 & {
      method: "page.type_text";
      params: TypeTextParamsV2;
    })
  | (BridgeRequestBaseV2 & {
      method: "page.wait_for";
      params: WaitForParamsV2;
    })
  | (BridgeRequestBaseV2 & { method: "page.scroll"; params: ScrollParamsV2 })
  | (BridgeRequestBaseV2 & { method: "page.hover"; params: HoverParamsV2 })
  | (BridgeRequestBaseV2 & { method: "page.list"; params: ListPagesParamsV2 })
  | (BridgeRequestBaseV2 & {
      method: "page.navigate";
      params: NavigatePageParamsV2;
    })
  | (BridgeRequestBaseV2 & { method: "page.close"; params: PageIdParamsV2 })
  | (BridgeRequestBaseV2 & {
      method: "page.handle_dialog";
      params: HandleDialogParamsV2;
    })
  | (BridgeRequestBaseV2 & {
      method: "page.console.list";
      params: ListConsoleMessagesParamsV2;
    })
  | (BridgeRequestBaseV2 & {
      method: "page.console.get";
      params: GetConsoleMessageParamsV2;
    })
  | (BridgeRequestBaseV2 & {
      method: "page.network.list";
      params: ListNetworkRequestsParamsV2;
    })
  | (BridgeRequestBaseV2 & {
      method: "page.network.get";
      params: GetNetworkRequestParamsV2;
    });

export type BridgeSuccessV2 = {
  kind: "response";
  protocolVersion: 2;
  runtimeId: string;
  requestId: string;
  ok: true;
  result: unknown;
};

export type BridgeFailureV2 = {
  kind: "response";
  protocolVersion: 2;
  runtimeId: string;
  requestId: string;
  ok: false;
  error: {
    code: ChromeBridgeErrorCodeV2;
    message: string;
    retryable: boolean;
    outcome: ChromeBridgeOutcome;
    details?: ChromeBridgeErrorDetails;
  };
};

export type BridgeResponseV2 = BridgeSuccessV2 | BridgeFailureV2;

export type BridgePingV2 = {
  kind: "ping";
  protocolVersion: 2;
  runtimeId: string;
  sentAtUnixMs: number;
};

export type BridgePongV2 = {
  kind: "pong";
  protocolVersion: 2;
  runtimeId: string;
  sentAtUnixMs: number;
};

export type OpenPageResultV2 = {
  schemaVersion: 2;
  pageId: string;
  url: string;
  title: string;
  loadState: "complete";
};

export type PageSummaryV2 = {
  schemaVersion: 2;
  pageId: string;
  url: string;
  title: string;
  description?: string;
  canonicalUrl?: string;
  language?: string;
  headings: Array<{ level: 1 | 2 | 3; text: string }>;
  content: string;
  truncated: boolean;
};

export type PageSnapshotV2 = {
  schemaVersion: 2;
  pageId: string;
  url: string;
  title: string;
  verbose: boolean;
  snapshot: string;
  truncated: boolean;
};

export type PageActionResultV2 = {
  schemaVersion: 2;
  pageId: string;
  action: PageActionV2;
  performed: true;
  url: string;
  navigatedToUrl: string | null;
  dialog: PageDialogInfoV2 | null;
};

export type PageWaitResultV2 = {
  schemaVersion: 2;
  pageId: string;
  matchedText: string;
  url: string;
};

export type PageInfoV2 = {
  pageId: string;
  url: string;
  title: string;
  loadState: "loading" | "complete";
  active: boolean;
};

export type ListPagesResultV2 = {
  schemaVersion: 2;
  pages: PageInfoV2[];
  truncated: boolean;
};

export type ClosePageResultV2 = {
  schemaVersion: 2;
  pageId: string;
  closed: true;
};

export type ListConsoleMessagesResultV2 = {
  schemaVersion: 2;
  pageId: string;
  pageIdx: number;
  pageSize: number;
  totalMessages: number;
  totalPages: number;
  output: string;
  truncated: boolean;
};

export type GetConsoleMessageResultV2 = {
  schemaVersion: 2;
  pageId: string;
  msgid: number;
  output: string;
  truncated: boolean;
};

export type ListNetworkRequestsResultV2 = {
  schemaVersion: 2;
  pageId: string;
  pageIdx: number;
  pageSize: number;
  totalRequests: number;
  totalPages: number;
  output: string;
  truncated: boolean;
};

export type GetNetworkRequestResultV2 = {
  schemaVersion: 2;
  pageId: string;
  reqid: number;
  output: string;
  truncated: boolean;
};

export type BridgeResultV2 =
  | OpenPageResultV2
  | PageSummaryV2
  | PageSnapshotV2
  | PageActionResultV2
  | PageWaitResultV2
  | ListPagesResultV2
  | ClosePageResultV2
  | ListConsoleMessagesResultV2
  | GetConsoleMessageResultV2
  | ListNetworkRequestsResultV2
  | GetNetworkRequestResultV2;

export function parsePluginHelloV2(value: unknown): PluginHelloV2 {
  const record = requireRecord(value, "plugin hello");
  requireExactKeys(record, [
    "kind",
    "protocolVersion",
    "pluginVersion",
    "capabilities",
  ]);
  requireLiteral(record.kind, "plugin_hello", "plugin hello kind");
  requireProtocolVersionV2(record.protocolVersion);
  return {
    kind: "plugin_hello",
    protocolVersion: PROTOCOL_VERSION_V2,
    pluginVersion: requireNonEmptyString(record.pluginVersion, "plugin version"),
    capabilities: parseCapabilitiesV2(record.capabilities),
  };
}

export function parseBridgeHelloV2(value: unknown): BridgeHelloV2 {
  const record = requireRecord(value, "bridge hello");
  requireExactKeys(record, [
    "kind",
    "protocolVersion",
    "runtimeId",
    "authToken",
    "extensionOrigin",
    "pluginVersion",
    "capabilities",
  ]);
  requireLiteral(record.kind, "hello", "bridge hello kind");
  requireProtocolVersionV2(record.protocolVersion);
  return {
    kind: "hello",
    protocolVersion: PROTOCOL_VERSION_V2,
    runtimeId: requireUuid(record.runtimeId, "runtimeId"),
    authToken: requireNonEmptyString(record.authToken, "authToken"),
    extensionOrigin: requireNonEmptyString(record.extensionOrigin, "extensionOrigin"),
    pluginVersion: requireNonEmptyString(record.pluginVersion, "pluginVersion"),
    capabilities: parseCapabilitiesV2(record.capabilities),
  };
}

export function parseBridgeHelloAckV2(value: unknown): BridgeHelloAckV2 {
  const record = requireRecord(value, "bridge hello ack");
  requireExactKeys(record, ["kind", "protocolVersion", "runtimeId"]);
  requireLiteral(record.kind, "hello_ack", "bridge hello ack kind");
  requireProtocolVersionV2(record.protocolVersion);
  return {
    kind: "hello_ack",
    protocolVersion: PROTOCOL_VERSION_V2,
    runtimeId: requireUuid(record.runtimeId, "runtimeId"),
  };
}

export function parseBridgeRequestV2(value: unknown): BridgeRequestV2 {
  const record = requireRecord(value, "bridge request");
  requireExactKeys(record, [
    "kind",
    "protocolVersion",
    "runtimeId",
    "requestId",
    "method",
    "deadlineUnixMs",
    "params",
  ]);
  requireLiteral(record.kind, "request", "bridge request kind");
  requireProtocolVersionV2(record.protocolVersion);
  const method = requireMethodV2(record.method);
  const deadlineUnixMs = requireSafeInteger(record.deadlineUnixMs, "deadlineUnixMs");
  if (deadlineUnixMs <= 0) {
    throw new Error("deadlineUnixMs must be positive.");
  }
  const base: BridgeRequestBaseV2 = {
    kind: "request",
    protocolVersion: PROTOCOL_VERSION_V2,
    runtimeId: requireUuid(record.runtimeId, "runtimeId"),
    requestId: requireUuid(record.requestId, "requestId"),
    deadlineUnixMs,
  };
  switch (method) {
    case "page.open":
      return { ...base, method, params: parseOpenPageParams(record.params) };
    case "page.summary":
      return { ...base, method, params: parsePageIdParams(record.params) };
    case "page.snapshot":
      return { ...base, method, params: parseSnapshotParams(record.params) };
    case "page.click":
      return { ...base, method, params: parseClickParams(record.params) };
    case "page.fill":
      return { ...base, method, params: parseFillParams(record.params) };
    case "page.press_key":
      return { ...base, method, params: parsePressKeyParams(record.params) };
    case "page.type_text":
      return { ...base, method, params: parseTypeTextParams(record.params) };
    case "page.wait_for":
      return { ...base, method, params: parseWaitForParams(record.params) };
    case "page.scroll":
      return { ...base, method, params: parseScrollParams(record.params) };
    case "page.hover":
      return { ...base, method, params: parseHoverParams(record.params) };
    case "page.list":
      return { ...base, method, params: parseListPagesParams(record.params) };
    case "page.navigate":
      return { ...base, method, params: parseNavigatePageParams(record.params) };
    case "page.close":
      return { ...base, method, params: parsePageIdParams(record.params) };
    case "page.handle_dialog":
      return { ...base, method, params: parseHandleDialogParams(record.params) };
    case "page.console.list":
      return {
        ...base,
        method,
        params: parseListConsoleMessagesParams(record.params),
      };
    case "page.console.get":
      return {
        ...base,
        method,
        params: parseGetConsoleMessageParams(record.params),
      };
    case "page.network.list":
      return {
        ...base,
        method,
        params: parseListNetworkRequestsParams(record.params),
      };
    case "page.network.get":
      return {
        ...base,
        method,
        params: parseGetNetworkRequestParams(record.params),
      };
  }
}

export function parseBridgeResponseV2(value: unknown): BridgeResponseV2 {
  const record = requireRecord(value, "bridge response");
  requireLiteral(record.kind, "response", "bridge response kind");
  requireProtocolVersionV2(record.protocolVersion);
  if (record.ok === true) {
    requireExactKeys(record, [
      "kind",
      "protocolVersion",
      "runtimeId",
      "requestId",
      "ok",
      "result",
    ]);
    return {
      kind: "response",
      protocolVersion: PROTOCOL_VERSION_V2,
      runtimeId: requireUuid(record.runtimeId, "runtimeId"),
      requestId: requireUuid(record.requestId, "requestId"),
      ok: true,
      result: record.result,
    };
  }
  requireLiteral(record.ok, false, "bridge response ok");
  requireExactKeys(record, [
    "kind",
    "protocolVersion",
    "runtimeId",
    "requestId",
    "ok",
    "error",
  ]);
  return {
    kind: "response",
    protocolVersion: PROTOCOL_VERSION_V2,
    runtimeId: requireUuid(record.runtimeId, "runtimeId"),
    requestId: requireUuid(record.requestId, "requestId"),
    ok: false,
    error: parseBridgeFailureBody(record.error),
  };
}

export function parseBridgePingV2(value: unknown): BridgePingV2 {
  return parseHeartbeatV2(value, "ping");
}

export function parseBridgePongV2(value: unknown): BridgePongV2 {
  return parseHeartbeatV2(value, "pong");
}

export function parseBridgeResultV2(
  method: BridgeMethodV2,
  value: unknown,
): BridgeResultV2 {
  switch (method) {
    case "page.open":
      return parseOpenPageResultV2(value);
    case "page.summary":
      return parsePageSummaryV2(value);
    case "page.snapshot":
      return parsePageSnapshotV2(value);
    case "page.wait_for":
      return parsePageWaitResultV2(value);
    case "page.click":
      return parsePageActionResultV2(value, "click");
    case "page.fill":
      return parsePageActionResultV2(value, "fill");
    case "page.press_key":
      return parsePageActionResultV2(value, "press_key");
    case "page.type_text":
      return parsePageActionResultV2(value, "type_text");
    case "page.scroll":
      return parsePageActionResultV2(value, "scroll");
    case "page.hover":
      return parsePageActionResultV2(value, "hover");
    case "page.list":
      return parseListPagesResultV2(value);
    case "page.navigate":
      return parsePageActionResultV2(value, "navigate_page");
    case "page.close":
      return parseClosePageResultV2(value);
    case "page.handle_dialog":
      return parsePageActionResultV2(value, "handle_dialog");
    case "page.console.list":
      return parseListConsoleMessagesResultV2(value);
    case "page.console.get":
      return parseGetConsoleMessageResultV2(value);
    case "page.network.list":
      return parseListNetworkRequestsResultV2(value);
    case "page.network.get":
      return parseGetNetworkRequestResultV2(value);
  }
}

export function parseOpenPageResultV2(value: unknown): OpenPageResultV2 {
  const record = requireRecord(value, "open page result");
  requireExactKeys(record, ["schemaVersion", "pageId", "url", "title", "loadState"]);
  requireLiteral(record.schemaVersion, 2, "open page schemaVersion");
  requireLiteral(record.loadState, "complete", "open page loadState");
  return {
    schemaVersion: 2,
    pageId: requireUuid(record.pageId, "pageId"),
    url: requireBoundedString(record.url, "url", MAX_URL_CHARS, true),
    title: requireBoundedString(record.title, "title", MAX_HEADING_CODE_POINTS, false),
    loadState: "complete",
  };
}

export function parsePageSummaryV2(value: unknown): PageSummaryV2 {
  const record = requireRecord(value, "page summary");
  requireKeys(record, {
    required: [
      "schemaVersion",
      "pageId",
      "url",
      "title",
      "headings",
      "content",
      "truncated",
    ],
    optional: ["description", "canonicalUrl", "language"],
  });
  requireLiteral(record.schemaVersion, 2, "summary schemaVersion");
  if (!Array.isArray(record.headings) || record.headings.length > MAX_HEADINGS) {
    throw new Error(
      `Page summary headings must contain at most ${MAX_HEADINGS} items.`,
    );
  }
  const headings = record.headings.map((heading, index) => {
    const item = requireRecord(heading, `heading ${index}`);
    requireExactKeys(item, ["level", "text"]);
    if (item.level !== 1 && item.level !== 2 && item.level !== 3) {
      throw new Error(`Heading ${index} has an invalid level.`);
    }
    const level: 1 | 2 | 3 = item.level;
    return {
      level,
      text: requireBoundedString(
        item.text,
        `heading ${index} text`,
        MAX_HEADING_CODE_POINTS,
        true,
      ),
    };
  });
  return {
    schemaVersion: 2,
    pageId: requireUuid(record.pageId, "pageId"),
    url: requireBoundedString(record.url, "url", MAX_URL_CHARS, true),
    title: requireBoundedString(record.title, "title", MAX_HEADING_CODE_POINTS, false),
    ...(record.description === undefined
      ? {}
      : {
          description: requireBoundedString(
            record.description,
            "description",
            MAX_DESCRIPTION_CODE_POINTS,
            false,
          ),
        }),
    ...(record.canonicalUrl === undefined
      ? {}
      : {
          canonicalUrl: requireBoundedString(
            record.canonicalUrl,
            "canonicalUrl",
            MAX_URL_CHARS,
            false,
          ),
        }),
    ...(record.language === undefined
      ? {}
      : {
          language: requireBoundedString(record.language, "language", 100, false),
        }),
    headings,
    content: requireBoundedString(
      record.content,
      "content",
      MAX_CONTENT_CODE_POINTS,
      true,
    ),
    truncated: requireBoolean(record.truncated, "truncated"),
  };
}

export function parsePageSnapshotV2(value: unknown): PageSnapshotV2 {
  const record = requireRecord(value, "page snapshot");
  requireExactKeys(record, [
    "schemaVersion",
    "pageId",
    "url",
    "title",
    "verbose",
    "snapshot",
    "truncated",
  ]);
  requireLiteral(record.schemaVersion, 2, "snapshot schemaVersion");
  return {
    schemaVersion: 2,
    pageId: requireUuid(record.pageId, "pageId"),
    url: requireBoundedString(record.url, "url", MAX_URL_CHARS, true),
    title: requireBoundedString(record.title, "title", MAX_HEADING_CODE_POINTS, false),
    verbose: requireBoolean(record.verbose, "verbose"),
    snapshot: requireBoundedString(
      record.snapshot,
      "snapshot",
      MAX_SNAPSHOT_CODE_POINTS,
      true,
    ),
    truncated: requireBoolean(record.truncated, "truncated"),
  };
}

export function parsePageActionResultV2(
  value: unknown,
  expectedAction?: PageActionV2,
): PageActionResultV2 {
  const record = requireRecord(value, "page action result");
  requireExactKeys(record, [
    "schemaVersion",
    "pageId",
    "action",
    "performed",
    "url",
    "navigatedToUrl",
    "dialog",
  ]);
  requireLiteral(record.schemaVersion, 2, "action schemaVersion");
  requireLiteral(record.performed, true, "action performed");
  if (!PAGE_ACTIONS.includes(record.action as PageActionV2)) {
    throw new Error(`Unknown page action ${JSON.stringify(record.action)}.`);
  }
  const action = record.action as PageActionV2;
  if (expectedAction !== undefined && action !== expectedAction) {
    throw new Error(`Expected action ${expectedAction}; received ${action}.`);
  }
  return {
    schemaVersion: 2,
    pageId: requireUuid(record.pageId, "pageId"),
    action,
    performed: true,
    url: requireBoundedString(record.url, "url", MAX_URL_CHARS, true),
    navigatedToUrl:
      record.navigatedToUrl === null
        ? null
        : requireBoundedString(
            record.navigatedToUrl,
            "navigatedToUrl",
            MAX_URL_CHARS,
            true,
          ),
    dialog: record.dialog === null ? null : parsePageDialogInfo(record.dialog),
  };
}

export function parsePageWaitResultV2(value: unknown): PageWaitResultV2 {
  const record = requireRecord(value, "page wait result");
  requireExactKeys(record, ["schemaVersion", "pageId", "matchedText", "url"]);
  requireLiteral(record.schemaVersion, 2, "wait schemaVersion");
  return {
    schemaVersion: 2,
    pageId: requireUuid(record.pageId, "pageId"),
    matchedText: requireBoundedString(record.matchedText, "matchedText", 1_000, true),
    url: requireBoundedString(record.url, "url", MAX_URL_CHARS, true),
  };
}

export function parseListPagesResultV2(value: unknown): ListPagesResultV2 {
  const record = requireRecord(value, "list pages result");
  requireExactKeys(record, ["schemaVersion", "pages", "truncated"]);
  requireLiteral(record.schemaVersion, 2, "list pages schemaVersion");
  if (!Array.isArray(record.pages) || record.pages.length > MAX_OWNED_PAGES) {
    throw new Error(`Page list must contain at most ${MAX_OWNED_PAGES} pages.`);
  }
  return {
    schemaVersion: 2,
    pages: record.pages.map((page, index) => parsePageInfo(page, index)),
    truncated: requireBoolean(record.truncated, "page list truncated"),
  };
}

export function parseClosePageResultV2(value: unknown): ClosePageResultV2 {
  const record = requireRecord(value, "close page result");
  requireExactKeys(record, ["schemaVersion", "pageId", "closed"]);
  requireLiteral(record.schemaVersion, 2, "close page schemaVersion");
  requireLiteral(record.closed, true, "close page closed");
  return {
    schemaVersion: 2,
    pageId: requireUuid(record.pageId, "pageId"),
    closed: true,
  };
}

export function parseListConsoleMessagesResultV2(
  value: unknown,
): ListConsoleMessagesResultV2 {
  const record = parseDebugListResult(value, "console messages", "totalMessages");
  return {
    schemaVersion: 2,
    pageId: record.pageId,
    pageIdx: record.pageIdx,
    pageSize: record.pageSize,
    totalMessages: record.totalItems,
    totalPages: record.totalPages,
    output: record.output,
    truncated: record.truncated,
  };
}

export function parseGetConsoleMessageResultV2(
  value: unknown,
): GetConsoleMessageResultV2 {
  const record = parseDebugDetailResult(value, "console message", "msgid");
  return {
    schemaVersion: 2,
    pageId: record.pageId,
    msgid: record.itemId,
    output: record.output,
    truncated: record.truncated,
  };
}

export function parseListNetworkRequestsResultV2(
  value: unknown,
): ListNetworkRequestsResultV2 {
  const record = parseDebugListResult(value, "network requests", "totalRequests");
  return {
    schemaVersion: 2,
    pageId: record.pageId,
    pageIdx: record.pageIdx,
    pageSize: record.pageSize,
    totalRequests: record.totalItems,
    totalPages: record.totalPages,
    output: record.output,
    truncated: record.truncated,
  };
}

export function parseGetNetworkRequestResultV2(
  value: unknown,
): GetNetworkRequestResultV2 {
  const record = parseDebugDetailResult(value, "network request", "reqid");
  return {
    schemaVersion: 2,
    pageId: record.pageId,
    reqid: record.itemId,
    output: record.output,
    truncated: record.truncated,
  };
}

function parsePageInfo(value: unknown, index: number): PageInfoV2 {
  const record = requireRecord(value, `page ${index}`);
  requireExactKeys(record, ["pageId", "url", "title", "loadState", "active"]);
  if (record.loadState !== "loading" && record.loadState !== "complete") {
    throw new Error(`Page ${index} loadState is invalid.`);
  }
  return {
    pageId: requireUuid(record.pageId, `page ${index} pageId`),
    url: requireBoundedString(record.url, `page ${index} url`, MAX_URL_CHARS, false),
    title: requireBoundedString(
      record.title,
      `page ${index} title`,
      MAX_HEADING_CODE_POINTS,
      false,
    ),
    loadState: record.loadState,
    active: requireBoolean(record.active, `page ${index} active`),
  };
}

function parsePageDialogInfo(value: unknown): PageDialogInfoV2 {
  const record = requireRecord(value, "page dialog");
  requireExactKeys(record, ["type", "message", "defaultValue"]);
  if (!DIALOG_TYPES.includes(record.type as DialogTypeV2)) {
    throw new Error(`Unknown dialog type ${JSON.stringify(record.type)}.`);
  }
  return {
    type: record.type as DialogTypeV2,
    message: requireBoundedString(
      record.message,
      "dialog message",
      MAX_DIALOG_TEXT_CODE_POINTS,
      false,
    ),
    defaultValue: requireBoundedString(
      record.defaultValue,
      "dialog defaultValue",
      MAX_DIALOG_TEXT_CODE_POINTS,
      false,
    ),
  };
}

function parseDebugListResult(
  value: unknown,
  label: string,
  totalKey: "totalMessages" | "totalRequests",
): {
  pageId: string;
  pageIdx: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  output: string;
  truncated: boolean;
} {
  const record = requireRecord(value, `${label} result`);
  requireExactKeys(record, [
    "schemaVersion",
    "pageId",
    "pageIdx",
    "pageSize",
    totalKey,
    "totalPages",
    "output",
    "truncated",
  ]);
  requireLiteral(record.schemaVersion, 2, `${label} schemaVersion`);
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    pageIdx: requireBoundedInteger(
      record.pageIdx,
      "pageIdx",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    pageSize: requireBoundedInteger(
      record.pageSize,
      "pageSize",
      1,
      DEBUG_LIST_MAX_PAGE_SIZE,
    ),
    totalItems: requireBoundedInteger(
      record[totalKey],
      totalKey,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    totalPages: requireBoundedInteger(
      record.totalPages,
      "totalPages",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    output: requireBoundedString(
      record.output,
      `${label} output`,
      MAX_DEBUG_OUTPUT_CODE_POINTS,
      false,
    ),
    truncated: requireBoolean(record.truncated, `${label} truncated`),
  };
}

function parseDebugDetailResult(
  value: unknown,
  label: string,
  idKey: "msgid" | "reqid",
): {
  pageId: string;
  itemId: number;
  output: string;
  truncated: boolean;
} {
  const record = requireRecord(value, `${label} result`);
  requireExactKeys(record, ["schemaVersion", "pageId", idKey, "output", "truncated"]);
  requireLiteral(record.schemaVersion, 2, `${label} schemaVersion`);
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    itemId: requireBoundedInteger(record[idKey], idKey, 1, Number.MAX_SAFE_INTEGER),
    output: requireBoundedString(
      record.output,
      `${label} output`,
      MAX_DEBUG_OUTPUT_CODE_POINTS,
      false,
    ),
    truncated: requireBoolean(record.truncated, `${label} truncated`),
  };
}

export function requireUuid(value: unknown, label: string): string {
  const text = requireNonEmptyString(value, label);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      text,
    )
  ) {
    throw new Error(`${label} must be a UUID.`);
  }
  return text;
}

export function isReadOnlyBridgeMethodV2(method: BridgeMethodV2): boolean {
  return (
    method === "page.summary" ||
    method === "page.snapshot" ||
    method === "page.wait_for" ||
    method === "page.list" ||
    method === "page.console.list" ||
    method === "page.console.get" ||
    method === "page.network.list" ||
    method === "page.network.get"
  );
}

export function isActionBridgeMethodV2(method: BridgeMethodV2): boolean {
  return (
    method === "page.click" ||
    method === "page.fill" ||
    method === "page.press_key" ||
    method === "page.type_text" ||
    method === "page.scroll" ||
    method === "page.hover" ||
    method === "page.navigate" ||
    method === "page.close" ||
    method === "page.handle_dialog"
  );
}

function parseOpenPageParams(value: unknown): OpenPageParamsV2 {
  const record = requireExactRecord(value, "page.open params", ["pageId", "url"]);
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    url: requireBoundedString(record.url, "url", MAX_URL_CHARS, true),
  };
}

function parsePageIdParams(value: unknown): PageIdParamsV2 {
  const record = requireExactRecord(value, "page params", ["pageId"]);
  return { pageId: requireUuid(record.pageId, "pageId") };
}

function parseSnapshotParams(value: unknown): SnapshotParamsV2 {
  const record = requireExactRecord(value, "page.snapshot params", [
    "pageId",
    "verbose",
  ]);
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    verbose: requireBoolean(record.verbose, "verbose"),
  };
}

function parseClickParams(value: unknown): ClickParamsV2 {
  const record = requireExactRecord(value, "page.click params", ["pageId", "uid"]);
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    uid: requireBoundedString(record.uid, "uid", 200, true),
  };
}

function parseFillParams(value: unknown): FillParamsV2 {
  const record = requireExactRecord(value, "page.fill params", [
    "pageId",
    "uid",
    "value",
  ]);
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    uid: requireBoundedString(record.uid, "uid", 200, true),
    value: requireBoundedString(
      record.value,
      "value",
      MAX_ACTION_TEXT_CODE_POINTS,
      false,
    ),
  };
}

function parsePressKeyParams(value: unknown): PressKeyParamsV2 {
  const record = requireExactRecord(value, "page.press_key params", ["pageId", "key"]);
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    key: requireBoundedString(record.key, "key", MAX_KEY_CHARS, true),
  };
}

function parseTypeTextParams(value: unknown): TypeTextParamsV2 {
  const record = requireExactRecord(value, "page.type_text params", [
    "pageId",
    "text",
    "submitKey",
  ]);
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    text: requireBoundedString(record.text, "text", MAX_ACTION_TEXT_CODE_POINTS, true),
    submitKey:
      record.submitKey === null
        ? null
        : requireBoundedString(record.submitKey, "submitKey", MAX_KEY_CHARS, true),
  };
}

function parseWaitForParams(value: unknown): WaitForParamsV2 {
  const record = requireExactRecord(value, "page.wait_for params", [
    "pageId",
    "texts",
    "timeoutMs",
  ]);
  if (
    !Array.isArray(record.texts) ||
    record.texts.length === 0 ||
    record.texts.length > MAX_WAIT_TEXTS
  ) {
    throw new Error(`texts must contain from 1 through ${MAX_WAIT_TEXTS} items.`);
  }
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    texts: record.texts.map((text, index) =>
      requireBoundedString(text, `texts[${index}]`, 1_000, true),
    ),
    timeoutMs: requireBoundedInteger(
      record.timeoutMs,
      "timeoutMs",
      1,
      PAGE_WAIT_MAX_TIMEOUT_MS,
    ),
  };
}

function parseScrollParams(value: unknown): ScrollParamsV2 {
  const record = requireExactRecord(value, "page.scroll params", [
    "pageId",
    "direction",
    "amount",
  ]);
  if (!SCROLL_DIRECTIONS.includes(record.direction as ScrollDirectionV2)) {
    throw new Error(`Unknown scroll direction ${JSON.stringify(record.direction)}.`);
  }
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    direction: record.direction as ScrollDirectionV2,
    amount: requireBoundedInteger(record.amount, "amount", 1, MAX_SCROLL_AMOUNT),
  };
}

function parseHoverParams(value: unknown): HoverParamsV2 {
  const record = requireExactRecord(value, "page.hover params", ["pageId", "uid"]);
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    uid: requireBoundedString(record.uid, "uid", 200, true),
  };
}

function parseListPagesParams(value: unknown): ListPagesParamsV2 {
  requireExactRecord(value, "page.list params", []);
  return {};
}

function parseNavigatePageParams(value: unknown): NavigatePageParamsV2 {
  const record = requireExactRecord(value, "page.navigate params", [
    "pageId",
    "type",
    "url",
    "ignoreCache",
    "handleBeforeUnload",
  ]);
  if (!NAVIGATION_TYPES.includes(record.type as NavigationTypeV2)) {
    throw new Error(`Unknown navigation type ${JSON.stringify(record.type)}.`);
  }
  const type = record.type as NavigationTypeV2;
  const url =
    record.url === null
      ? null
      : requireBoundedString(record.url, "url", MAX_URL_CHARS, true);
  if ((type === "url") !== (url !== null)) {
    throw new Error("url must be present only when navigation type is url.");
  }
  if (!DIALOG_ACTIONS.includes(record.handleBeforeUnload as DialogActionV2)) {
    throw new Error("handleBeforeUnload must be accept or dismiss.");
  }
  const ignoreCache = requireBoolean(record.ignoreCache, "ignoreCache");
  if (ignoreCache && type !== "reload") {
    throw new Error("ignoreCache is allowed only for reload navigation.");
  }
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    type,
    url,
    ignoreCache,
    handleBeforeUnload: record.handleBeforeUnload as DialogActionV2,
  };
}

function parseHandleDialogParams(value: unknown): HandleDialogParamsV2 {
  const record = requireExactRecord(value, "page.handle_dialog params", [
    "pageId",
    "action",
    "promptText",
  ]);
  if (!DIALOG_ACTIONS.includes(record.action as DialogActionV2)) {
    throw new Error("dialog action must be accept or dismiss.");
  }
  const action = record.action as DialogActionV2;
  const promptText =
    record.promptText === null
      ? null
      : requireBoundedString(
          record.promptText,
          "promptText",
          MAX_DIALOG_TEXT_CODE_POINTS,
          false,
        );
  if (action === "dismiss" && promptText !== null) {
    throw new Error("promptText is allowed only when accepting a dialog.");
  }
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    action,
    promptText,
  };
}

function parseListConsoleMessagesParams(value: unknown): ListConsoleMessagesParamsV2 {
  const record = requireExactRecord(value, "page.console.list params", [
    "pageId",
    "pageIdx",
    "pageSize",
    "types",
    "includePreservedMessages",
  ]);
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    pageIdx: requireBoundedInteger(
      record.pageIdx,
      "pageIdx",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    pageSize: requireBoundedInteger(
      record.pageSize,
      "pageSize",
      1,
      DEBUG_LIST_MAX_PAGE_SIZE,
    ),
    types: parseStringEnumArray(record.types, "types", CONSOLE_MESSAGE_TYPES),
    includePreservedMessages: requireBoolean(
      record.includePreservedMessages,
      "includePreservedMessages",
    ),
  };
}

function parseGetConsoleMessageParams(value: unknown): GetConsoleMessageParamsV2 {
  const record = requireExactRecord(value, "page.console.get params", [
    "pageId",
    "msgid",
  ]);
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    msgid: requireBoundedInteger(record.msgid, "msgid", 1, Number.MAX_SAFE_INTEGER),
  };
}

function parseListNetworkRequestsParams(value: unknown): ListNetworkRequestsParamsV2 {
  const record = requireExactRecord(value, "page.network.list params", [
    "pageId",
    "pageIdx",
    "pageSize",
    "resourceTypes",
    "includePreservedRequests",
  ]);
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    pageIdx: requireBoundedInteger(
      record.pageIdx,
      "pageIdx",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    pageSize: requireBoundedInteger(
      record.pageSize,
      "pageSize",
      1,
      DEBUG_LIST_MAX_PAGE_SIZE,
    ),
    resourceTypes: parseStringEnumArray(
      record.resourceTypes,
      "resourceTypes",
      NETWORK_RESOURCE_TYPES,
    ),
    includePreservedRequests: requireBoolean(
      record.includePreservedRequests,
      "includePreservedRequests",
    ),
  };
}

function parseGetNetworkRequestParams(value: unknown): GetNetworkRequestParamsV2 {
  const record = requireExactRecord(value, "page.network.get params", [
    "pageId",
    "reqid",
  ]);
  return {
    pageId: requireUuid(record.pageId, "pageId"),
    reqid: requireBoundedInteger(record.reqid, "reqid", 1, Number.MAX_SAFE_INTEGER),
  };
}

function parseStringEnumArray<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T[] {
  if (!Array.isArray(value) || value.length > allowed.length) {
    throw new Error(`${label} must be an array of supported values.`);
  }
  const parsed = value.map((item) => {
    if (!allowed.includes(item as T)) {
      throw new Error(`${label} contains unsupported value ${JSON.stringify(item)}.`);
    }
    return item as T;
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new Error(`${label} must not contain duplicate values.`);
  }
  return parsed;
}

function parseCapabilitiesV2(value: unknown): PluginCapabilityV2[] {
  if (
    !Array.isArray(value) ||
    value.length !== PLUGIN_CAPABILITIES_V2.length ||
    value.some((item, index) => item !== PLUGIN_CAPABILITIES_V2[index])
  ) {
    throw new Error(
      `Capabilities must be exactly ${PLUGIN_CAPABILITIES_V2.join(", ")}.`,
    );
  }
  return [...PLUGIN_CAPABILITIES_V2];
}

function requireMethodV2(value: unknown): BridgeMethodV2 {
  if (!PLUGIN_CAPABILITIES_V2.includes(value as PluginCapabilityV2)) {
    throw new Error(`Unsupported bridge method ${JSON.stringify(value)}.`);
  }
  return value as BridgeMethodV2;
}

function parseHeartbeatV2<TKind extends "ping" | "pong">(
  value: unknown,
  kind: TKind,
): {
  kind: TKind;
  protocolVersion: 2;
  runtimeId: string;
  sentAtUnixMs: number;
} {
  const record = requireRecord(value, `bridge ${kind}`);
  requireExactKeys(record, ["kind", "protocolVersion", "runtimeId", "sentAtUnixMs"]);
  requireLiteral(record.kind, kind, `bridge ${kind} kind`);
  requireProtocolVersionV2(record.protocolVersion);
  return {
    kind,
    protocolVersion: PROTOCOL_VERSION_V2,
    runtimeId: requireUuid(record.runtimeId, "runtimeId"),
    sentAtUnixMs: requireSafeInteger(record.sentAtUnixMs, "sentAtUnixMs"),
  };
}

function parseBridgeFailureBody(value: unknown): BridgeFailureV2["error"] {
  const record = requireRecord(value, "bridge error");
  requireKeys(record, {
    required: ["code", "message", "retryable", "outcome"],
    optional: ["details"],
  });
  if (!isChromeBridgeErrorCodeV2(record.code)) {
    throw new Error(`Unknown bridge error code ${JSON.stringify(record.code)}.`);
  }
  if (
    record.outcome !== "not_started" &&
    record.outcome !== "unknown" &&
    record.outcome !== "performed"
  ) {
    throw new Error("Bridge error outcome is invalid.");
  }
  return {
    code: record.code,
    message: requireNonEmptyString(record.message, "bridge error message"),
    retryable: requireBoolean(record.retryable, "bridge error retryable"),
    outcome: record.outcome,
    ...(record.details === undefined
      ? {}
      : { details: parseErrorDetails(record.details) }),
  };
}

function parseErrorDetails(value: unknown): ChromeBridgeErrorDetails {
  const record = requireRecord(value, "bridge error details");
  const details: ChromeBridgeErrorDetails = {};
  for (const [key, item] of Object.entries(record)) {
    if (
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw new Error(`Bridge error detail ${key} is not a primitive.`);
    }
    details[key] = item;
  }
  return details;
}

function requireExactRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = requireRecord(value, label);
  requireExactKeys(record, keys);
  return record;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): void {
  requireKeys(record, { required: expected, optional: [] });
}

function requireKeys(
  record: Record<string, unknown>,
  keys: { required: readonly string[]; optional: readonly string[] },
): void {
  const allowed = new Set([...keys.required, ...keys.optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`Message contains unknown field ${key}.`);
    }
  }
  for (const key of keys.required) {
    if (!(key in record)) {
      throw new Error(`Message is missing required field ${key}.`);
    }
  }
}

function requireProtocolVersionV2(value: unknown): asserts value is 2 {
  if (value !== PROTOCOL_VERSION_V2) {
    throw new Error(
      `Protocol version must be ${PROTOCOL_VERSION_V2}; received ${JSON.stringify(value)}.`,
    );
  }
}

function requireLiteral<T>(
  value: unknown,
  literal: T,
  label: string,
): asserts value is T {
  if (value !== literal) {
    throw new Error(`${label} must be ${JSON.stringify(literal)}.`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (text.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  return text;
}

function requireBoundedString(
  value: unknown,
  label: string,
  maxCodePoints: number,
  nonEmpty: boolean,
): string {
  const text = requireString(value, label);
  if (nonEmpty && text.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  if (Array.from(text).length > maxCodePoints) {
    throw new Error(`${label} must be at most ${maxCodePoints} code points.`);
  }
  return text;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer.`);
  }
  return value as number;
}

function requireBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const integer = requireSafeInteger(value, label);
  if (integer < minimum || integer > maximum) {
    throw new Error(`${label} must be from ${minimum} through ${maximum}.`);
  }
  return integer;
}

const PAGE_ACTIONS: readonly PageActionV2[] = [
  "click",
  "fill",
  "press_key",
  "type_text",
  "scroll",
  "hover",
  "navigate_page",
  "handle_dialog",
];
const SCROLL_DIRECTIONS: readonly ScrollDirectionV2[] = ["up", "down", "left", "right"];
const NAVIGATION_TYPES: readonly NavigationTypeV2[] = [
  "url",
  "back",
  "forward",
  "reload",
];
const DIALOG_ACTIONS: readonly DialogActionV2[] = ["accept", "dismiss"];
const DIALOG_TYPES: readonly DialogTypeV2[] = [
  "alert",
  "beforeunload",
  "confirm",
  "prompt",
];
