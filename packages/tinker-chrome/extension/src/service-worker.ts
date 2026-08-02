import {
  MAX_CONTENT_CODE_POINTS,
  MAX_DESCRIPTION_CODE_POINTS,
  MAX_HEADING_CODE_POINTS,
  MAX_HEADINGS,
  NATIVE_HOST_NAME,
  PLUGIN_CAPABILITIES_V2,
  PLUGIN_VERSION,
  PROTOCOL_VERSION_V2,
} from "../../src/constants";
import { ChromeBridgeError, internalBridgeError } from "../../src/errors";
import {
  type BridgeFailureV2,
  type BridgeRequestV2,
  type BridgeSuccessV2,
  type OpenPageResultV2,
  type PageSummaryV2,
  isReadOnlyBridgeMethodV2,
  parseBridgeHelloAckV2,
  parseBridgePingV2,
  parseBridgeRequestV2,
  requireUuid,
} from "../../src/protocol-v2";
import {
  extractPageSummaryDocument,
  type PageSummaryLimits,
} from "./page-summary-extractor";
import { PageAutomationManager } from "./page-automation";

type StoredPageV1 = {
  schemaVersion: 1;
  runtimeId: string;
  pageId: string;
  tabId: number;
};

const PAGE_KEY_PREFIX = "tinkerChromePageV1:";
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const SUMMARY_LIMITS: PageSummaryLimits = {
  maxContentCodePoints: MAX_CONTENT_CODE_POINTS,
  maxDescriptionCodePoints: MAX_DESCRIPTION_CODE_POINTS,
  maxHeadingCodePoints: MAX_HEADING_CODE_POINTS,
  maxHeadings: MAX_HEADINGS,
};

let nativePort: chrome.runtime.Port | undefined;
let currentRuntimeId: string | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
const activeRequestIds = new Set<string>();
const automation = new PageAutomationManager();

function ensureNativePort(): void {
  if (nativePort !== undefined || reconnectTimer !== undefined) {
    return;
  }

  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    currentRuntimeId = undefined;
    port.onMessage.addListener((message: unknown) => {
      void handleNativeMessage(port, message).catch((error) => {
        log("native_message_failed", { message: asError(error).message });
        port.disconnect();
      });
    });
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) {
        return;
      }
      const message = chrome.runtime.lastError?.message;
      nativePort = undefined;
      currentRuntimeId = undefined;
      activeRequestIds.clear();
      void automation.closeAll();
      log("native_port_disconnected", { message });
      scheduleReconnect();
    });
    port.postMessage({
      kind: "plugin_hello",
      protocolVersion: PROTOCOL_VERSION_V2,
      pluginVersion: PLUGIN_VERSION,
      capabilities: [...PLUGIN_CAPABILITIES_V2],
    });
    reconnectAttempt = 0;
    log("native_port_connected");
  } catch (error) {
    nativePort = undefined;
    log("native_port_connect_failed", { message: asError(error).message });
    scheduleReconnect();
  }
}

async function handleNativeMessage(
  port: chrome.runtime.Port,
  message: unknown,
): Promise<void> {
  if (nativePort !== port) {
    return;
  }
  if (currentRuntimeId === undefined) {
    const ack = parseBridgeHelloAckV2(message);
    currentRuntimeId = ack.runtimeId;
    log("bridge_ready", { runtimeId: ack.runtimeId });
    return;
  }
  if (
    typeof message === "object" &&
    message !== null &&
    "kind" in message &&
    message.kind === "ping"
  ) {
    const ping = parseBridgePingV2(message);
    requireCurrentRuntime(ping.runtimeId);
    port.postMessage({
      kind: "pong",
      protocolVersion: PROTOCOL_VERSION_V2,
      runtimeId: ping.runtimeId,
      sentAtUnixMs: ping.sentAtUnixMs,
    });
    return;
  }

  const request = parseBridgeRequestV2(message);
  requireCurrentRuntime(request.runtimeId);
  if (request.deadlineUnixMs <= Date.now()) {
    postFailure(
      port,
      request,
      new ChromeBridgeError({
        code: "REQUEST_TIMEOUT",
        message: "Chrome request deadline has already expired.",
        retryable: isReadOnlyBridgeMethodV2(request.method),
        outcome: "not_started",
      }),
    );
    return;
  }
  if (activeRequestIds.has(request.requestId)) {
    throw new Error(`Duplicate active requestId ${request.requestId}.`);
  }

  activeRequestIds.add(request.requestId);
  try {
    const result = await routeRequest(request);
    const response: BridgeSuccessV2 = {
      kind: "response",
      protocolVersion: PROTOCOL_VERSION_V2,
      runtimeId: request.runtimeId,
      requestId: request.requestId,
      ok: true,
      result,
    };
    if (nativePort === port && currentRuntimeId === request.runtimeId) {
      port.postMessage(response);
    }
  } catch (error) {
    if (nativePort === port && currentRuntimeId === request.runtimeId) {
      postFailure(port, request, internalBridgeError(error));
    }
  } finally {
    activeRequestIds.delete(request.requestId);
  }
}

async function routeRequest(request: BridgeRequestV2): Promise<unknown> {
  switch (request.method) {
    case "page.open":
      return openPage(request);
    case "page.summary":
      return getPageSummary(request);
    case "page.snapshot": {
      const owned = await requireOwnedPage(request);
      return automation.snapshot({
        pageId: request.params.pageId,
        tabId: owned.page.tabId,
        verbose: request.params.verbose,
      });
    }
    case "page.click": {
      const owned = await requireOwnedPage(request);
      return automation.click({
        pageId: request.params.pageId,
        tabId: owned.page.tabId,
        uid: request.params.uid,
      });
    }
    case "page.fill": {
      const owned = await requireOwnedPage(request);
      return automation.fill({
        pageId: request.params.pageId,
        tabId: owned.page.tabId,
        uid: request.params.uid,
        value: request.params.value,
      });
    }
    case "page.press_key": {
      const owned = await requireOwnedPage(request);
      return automation.pressKey({
        pageId: request.params.pageId,
        tabId: owned.page.tabId,
        key: request.params.key,
      });
    }
    case "page.type_text": {
      const owned = await requireOwnedPage(request);
      return automation.typeText({
        pageId: request.params.pageId,
        tabId: owned.page.tabId,
        text: request.params.text,
        submitKey: request.params.submitKey,
      });
    }
    case "page.wait_for": {
      const owned = await requireOwnedPage(request);
      return automation.waitFor({
        pageId: request.params.pageId,
        tabId: owned.page.tabId,
        texts: request.params.texts,
        timeoutMs: request.params.timeoutMs,
      });
    }
    case "page.scroll": {
      const owned = await requireOwnedPage(request);
      return automation.scroll({
        pageId: request.params.pageId,
        tabId: owned.page.tabId,
        direction: request.params.direction,
        amount: request.params.amount,
      });
    }
    case "page.hover": {
      const owned = await requireOwnedPage(request);
      return automation.hover({
        pageId: request.params.pageId,
        tabId: owned.page.tabId,
        uid: request.params.uid,
      });
    }
  }
}

async function openPage(
  request: Extract<BridgeRequestV2, { method: "page.open" }>,
): Promise<OpenPageResultV2> {
  const pageId = requireUuid(request.params.pageId, "pageId");
  const url = requireHttpUrl(request.params.url);

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.create({ url, active: true });
  } catch (error) {
    throw new ChromeBridgeError({
      code: "TAB_CREATE_FAILED",
      message: `Chrome could not create the tab: ${asError(error).message}`,
      retryable: false,
      outcome: "not_started",
      cause: error,
    });
  }
  if (tab.id === undefined) {
    throw new ChromeBridgeError({
      code: "TAB_CREATE_FAILED",
      message: "Chrome created a tab without an ID.",
      retryable: false,
      outcome: "unknown",
    });
  }

  const storedPage: StoredPageV1 = {
    schemaVersion: 1,
    runtimeId: request.runtimeId,
    pageId,
    tabId: tab.id,
  };
  await chrome.storage.session.set({
    [pageKey(request.runtimeId, pageId)]: storedPage,
  });

  let completed: chrome.tabs.Tab;
  try {
    completed = await waitForTabComplete(tab.id, request.deadlineUnixMs);
  } catch (error) {
    if (error instanceof ChromeBridgeError) {
      throw error;
    }
    const current = await chrome.tabs.get(tab.id).catch(() => undefined);
    throw new ChromeBridgeError({
      code: "NAVIGATION_TIMEOUT",
      message: "Chrome page did not finish loading before the deadline.",
      retryable: true,
      outcome: "performed",
      details: {
        pageId,
        ...(current?.url === undefined ? {} : { url: current.url }),
      },
      cause: error,
    });
  }

  return {
    schemaVersion: 2,
    pageId,
    url: requireHttpUrl(completed.url),
    title: completed.title ?? "",
    loadState: "complete",
  };
}

async function getPageSummary(
  request: Extract<BridgeRequestV2, { method: "page.summary" }>,
): Promise<PageSummaryV2> {
  const pageId = requireUuid(request.params.pageId, "pageId");
  const { page } = await requireOwnedPage(request);

  let extracted: Awaited<ReturnType<typeof extractPageSummaryDocument>> | undefined;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: page.tabId, allFrames: false },
      world: "ISOLATED",
      func: extractPageSummaryDocument,
      args: [SUMMARY_LIMITS],
    });
    extracted = results[0]?.result;
  } catch (error) {
    throw new ChromeBridgeError({
      code: "PAGE_ACCESS_DENIED",
      message: `Chrome denied page summary access: ${asError(error).message}`,
      retryable: false,
      outcome: "not_started",
      cause: error,
    });
  }
  if (extracted === undefined || extracted.content.trim() === "") {
    throw new ChromeBridgeError({
      code: "SUMMARY_EMPTY",
      message: "The Chrome page did not contain readable text.",
      retryable: false,
      outcome: "not_started",
    });
  }

  return {
    schemaVersion: 2,
    pageId,
    ...extracted,
  };
}

async function requireOwnedPage(
  request: Exclude<BridgeRequestV2, { method: "page.open" }>,
): Promise<{ page: StoredPageV1; tab: chrome.tabs.Tab }> {
  const pageId = request.params.pageId;
  const key = pageKey(request.runtimeId, pageId);
  const stored = (await chrome.storage.session.get(key))[key];
  const page = parseStoredPage(stored, request.runtimeId, pageId);

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(page.tabId);
  } catch (error) {
    await chrome.storage.session.remove(key);
    await automation.closeTab(page.tabId);
    throw new ChromeBridgeError({
      code: "TAB_CLOSED",
      message: "The Chrome tab for this page has been closed.",
      retryable: false,
      outcome: "not_started",
      cause: error,
    });
  }
  if (tab.status !== "complete") {
    try {
      tab = await waitForTabComplete(page.tabId, request.deadlineUnixMs);
    } catch (error) {
      if (error instanceof ChromeBridgeError) {
        throw error;
      }
      throw new ChromeBridgeError({
        code: "PAGE_NOT_READY",
        message: "The Chrome page did not finish loading before the deadline.",
        retryable: true,
        outcome: "not_started",
        cause: error,
      });
    }
  }
  requireHttpUrl(tab.url);
  return { page, tab };
}

function waitForTabComplete(
  tabId: number,
  deadlineUnixMs: number,
): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const remaining = deadlineUnixMs - Date.now();
    if (remaining <= 0) {
      reject(new Error("Tab deadline expired."));
      return;
    }
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
    };
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish(() => resolve(tab));
      }
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) {
        finish(() =>
          reject(
            new ChromeBridgeError({
              code: "TAB_CLOSED",
              message: "The Chrome tab was closed while loading.",
              retryable: false,
              outcome: "performed",
            }),
          ),
        );
      }
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Tab load timed out.")));
    }, remaining);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") {
          finish(() => resolve(tab));
        }
      })
      .catch((error) =>
        finish(() =>
          reject(
            new ChromeBridgeError({
              code: "TAB_CLOSED",
              message: "The Chrome tab was closed while loading.",
              retryable: false,
              outcome: "performed",
              cause: error,
            }),
          ),
        ),
      );
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined || nativePort !== undefined) {
    return;
  }
  const base =
    RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
    RECONNECT_DELAYS_MS.at(-1) ??
    5_000;
  reconnectAttempt += 1;
  const jittered = Math.round(base * (0.8 + Math.random() * 0.4));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    ensureNativePort();
  }, jittered);
}

function postFailure(
  port: chrome.runtime.Port,
  request: BridgeRequestV2,
  error: ChromeBridgeError,
): void {
  const response: BridgeFailureV2 = {
    kind: "response",
    protocolVersion: PROTOCOL_VERSION_V2,
    runtimeId: request.runtimeId,
    requestId: request.requestId,
    ok: false,
    error: {
      code: error.code,
      message: error.message.slice(0, 1_000),
      retryable: error.retryable,
      outcome: error.outcome,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  port.postMessage(response);
}

function requireCurrentRuntime(runtimeId: string): void {
  if (runtimeId !== currentRuntimeId) {
    throw new Error("Native message runtimeId does not match the active runtime.");
  }
}

function requireHttpUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new ChromeBridgeError({
      code: "INVALID_URL",
      message: "Chrome URL must be a string.",
      retryable: false,
      outcome: "not_started",
    });
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ChromeBridgeError({
      code: "INVALID_URL",
      message: "Chrome URL is invalid.",
      retryable: false,
      outcome: "not_started",
      cause: error,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ChromeBridgeError({
      code: "PAGE_ACCESS_DENIED",
      message: "Only HTTP and HTTPS Chrome pages are supported.",
      retryable: false,
      outcome: "not_started",
    });
  }
  return url.href;
}

function parseStoredPage(
  value: unknown,
  runtimeId: string,
  pageId: string,
): StoredPageV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ChromeBridgeError({
      code: "PAGE_NOT_FOUND",
      message: "This pageId is not owned by the active Tinker runtime.",
      retryable: false,
      outcome: "not_started",
    });
  }
  const page = value as Partial<StoredPageV1>;
  if (
    page.schemaVersion !== 1 ||
    page.runtimeId !== runtimeId ||
    page.pageId !== pageId ||
    !Number.isSafeInteger(page.tabId)
  ) {
    throw new ChromeBridgeError({
      code: "PAGE_NOT_FOUND",
      message: "Stored Chrome page state is invalid for this runtime.",
      retryable: false,
      outcome: "not_started",
    });
  }
  return page as StoredPageV1;
}

function pageKey(runtimeId: string, pageId: string): string {
  return `${PAGE_KEY_PREFIX}${runtimeId}:${pageId}`;
}

async function removePagesForTab(tabId: number): Promise<void> {
  const values = await chrome.storage.session.get(null);
  const keys = Object.entries(values)
    .filter(
      ([key, value]) =>
        key.startsWith(PAGE_KEY_PREFIX) &&
        typeof value === "object" &&
        value !== null &&
        "tabId" in value &&
        value.tabId === tabId,
    )
    .map(([key]) => key);
  if (keys.length > 0) {
    await chrome.storage.session.remove(keys);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function log(event: string, details?: Record<string, unknown>): void {
  console.info("tinker-chrome", { event, ...details });
}

chrome.runtime.onStartup.addListener(ensureNativePort);
chrome.runtime.onInstalled.addListener(ensureNativePort);
chrome.tabs.onRemoved.addListener((tabId) => {
  void automation.closeTab(tabId);
  void removePagesForTab(tabId).catch((error) => {
    log("page_cleanup_failed", { message: asError(error).message });
  });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
    automation.invalidateTab(tabId);
  }
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    void automation.closeTab(source.tabId);
  }
});

ensureNativePort();
