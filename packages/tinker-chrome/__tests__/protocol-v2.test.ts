import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MAX_SNAPSHOT_CODE_POINTS, PLUGIN_CAPABILITIES_V2 } from "../src/constants";
import {
  parseBridgeRequestV2,
  parseBridgeResponseV2,
  parseGetNetworkRequestResultV2,
  parseListConsoleMessagesResultV2,
  parseListPagesResultV2,
  parsePageActionResultV2,
  parsePageSnapshotV2,
  parsePluginHelloV2,
} from "../src/protocol-v2";

test("Tinker Chrome v2 accepts exact capabilities and typed snapshot params", () => {
  expect(
    parsePluginHelloV2({
      kind: "plugin_hello",
      protocolVersion: 2,
      pluginVersion: "0.2.0",
      capabilities: [...PLUGIN_CAPABILITIES_V2],
    }),
  ).toEqual({
    kind: "plugin_hello",
    protocolVersion: 2,
    pluginVersion: "0.2.0",
    capabilities: [...PLUGIN_CAPABILITIES_V2],
  });

  const runtimeId = randomUUID();
  const requestId = randomUUID();
  const pageId = randomUUID();
  expect(
    parseBridgeRequestV2({
      kind: "request",
      protocolVersion: 2,
      runtimeId,
      requestId,
      method: "page.snapshot",
      deadlineUnixMs: Date.now() + 1_000,
      params: { pageId, verbose: false },
    }),
  ).toMatchObject({ method: "page.snapshot", params: { pageId, verbose: false } });
});

test("Tinker Chrome v2 rejects loose envelopes and method params", () => {
  const base = {
    kind: "request",
    protocolVersion: 2,
    runtimeId: randomUUID(),
    requestId: randomUUID(),
    method: "page.snapshot",
    deadlineUnixMs: Date.now() + 1_000,
  };
  expect(() =>
    parseBridgeRequestV2({ ...base, params: { pageId: randomUUID() } }),
  ).toThrow("missing required field verbose");
  expect(() =>
    parseBridgeRequestV2({
      ...base,
      params: { pageId: randomUUID(), verbose: false, ignored: true },
    }),
  ).toThrow("unknown field ignored");
  expect(() =>
    parseBridgeResponseV2({
      kind: "response",
      protocolVersion: 2,
      runtimeId: randomUUID(),
      requestId: randomUUID(),
      ok: false,
      error: {
        code: "TAB_CLOSED",
        message: "closed",
        retryable: false,
        outcome: "not_started",
        ignored: true,
      },
    }),
  ).toThrow("unknown field ignored");
});

test("Tinker Chrome v2 validates bounded snapshot and action results", () => {
  const pageId = randomUUID();
  expect(
    parsePageSnapshotV2({
      schemaVersion: 2,
      pageId,
      url: "https://example.com/",
      title: "Example Domain",
      verbose: false,
      snapshot: 'uid=1_0 RootWebArea "Example Domain"\n',
      truncated: false,
    }),
  ).toMatchObject({ pageId, verbose: false, truncated: false });
  expect(() =>
    parsePageSnapshotV2({
      schemaVersion: 2,
      pageId,
      url: "https://example.com/",
      title: "Example Domain",
      verbose: false,
      snapshot: "x".repeat(MAX_SNAPSHOT_CODE_POINTS + 1),
      truncated: false,
    }),
  ).toThrow(`at most ${MAX_SNAPSHOT_CODE_POINTS} code points`);
  expect(
    parsePageActionResultV2(
      {
        schemaVersion: 2,
        pageId,
        action: "click",
        performed: true,
        url: "https://www.iana.org/help/example-domains",
        navigatedToUrl: "https://www.iana.org/help/example-domains",
        dialog: null,
      },
      "click",
    ),
  ).toMatchObject({ pageId, action: "click", performed: true });
  expect(
    parsePageActionResultV2(
      {
        schemaVersion: 2,
        pageId,
        action: "drag",
        performed: true,
        url: "https://example.com/",
        navigatedToUrl: null,
        dialog: null,
      },
      "drag",
    ),
  ).toMatchObject({ pageId, action: "drag", performed: true });
});

test("Tinker Chrome v2 normalizes strict input, emulation, and upload params", () => {
  const base = {
    kind: "request",
    protocolVersion: 2,
    runtimeId: randomUUID(),
    requestId: randomUUID(),
    deadlineUnixMs: Date.now() + 1_000,
  };
  const pageId = randomUUID();
  expect(
    parseBridgeRequestV2({
      ...base,
      method: "page.click",
      params: { pageId, uid: "1_1", doubleClick: true },
    }),
  ).toMatchObject({
    method: "page.click",
    params: { pageId, uid: "1_1", doubleClick: true },
  });
  expect(
    parseBridgeRequestV2({
      ...base,
      requestId: randomUUID(),
      method: "page.fill_form",
      params: {
        pageId,
        elements: [
          { uid: "1_2", value: "Ada" },
          { uid: "1_3", value: "true" },
        ],
      },
    }),
  ).toMatchObject({ method: "page.fill_form", params: { pageId } });
  expect(
    parseBridgeRequestV2({
      ...base,
      requestId: randomUUID(),
      method: "page.emulate",
      params: {
        pageId,
        networkConditions: "Fast 3G",
        cpuThrottlingRate: 2,
        geolocation: { latitude: 1.25, longitude: 103.8 },
        userAgent: "Tinker Chrome Test",
        colorScheme: "dark",
        viewport: {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
          isLandscape: false,
        },
        extraHttpHeaders: { "X-Tinker-Test": "yes" },
      },
    }),
  ).toMatchObject({
    method: "page.emulate",
    params: {
      pageId,
      networkConditions: "Fast 3G",
      viewport: { width: 390, height: 844 },
    },
  });
  expect(
    parseBridgeRequestV2({
      ...base,
      requestId: randomUUID(),
      method: "page.upload_file",
      params: { pageId, uid: "1_4", filePath: "/tmp/tinker-upload.txt" },
    }),
  ).toMatchObject({ method: "page.upload_file", params: { pageId } });
  expect(() =>
    parseBridgeRequestV2({
      ...base,
      requestId: randomUUID(),
      method: "page.emulate",
      params: {
        pageId,
        networkConditions: null,
        cpuThrottlingRate: 1,
        geolocation: null,
        userAgent: null,
        colorScheme: "auto",
        viewport: null,
        extraHttpHeaders: { Authorization: 123 },
      },
    }),
  ).toThrow("HTTP header Authorization must be a string");
});

test("Tinker Chrome v2 normalizes strict page lifecycle and debug requests", () => {
  const base = {
    kind: "request",
    protocolVersion: 2,
    runtimeId: randomUUID(),
    requestId: randomUUID(),
    deadlineUnixMs: Date.now() + 1_000,
  };
  const pageId = randomUUID();
  expect(
    parseBridgeRequestV2({
      ...base,
      method: "page.list",
      params: {},
    }),
  ).toMatchObject({ method: "page.list", params: {} });
  expect(
    parseBridgeRequestV2({
      ...base,
      method: "page.navigate",
      params: {
        pageId,
        type: "reload",
        url: null,
        ignoreCache: true,
        handleBeforeUnload: "accept",
      },
    }),
  ).toMatchObject({ method: "page.navigate", params: { pageId, type: "reload" } });
  expect(
    parseBridgeRequestV2({
      ...base,
      method: "page.console.list",
      params: {
        pageId,
        pageIdx: 0,
        pageSize: 50,
        types: ["error", "warn"],
        includePreservedMessages: false,
      },
    }),
  ).toMatchObject({ method: "page.console.list", params: { pageId } });
  expect(() =>
    parseBridgeRequestV2({
      ...base,
      method: "page.navigate",
      params: {
        pageId,
        type: "back",
        url: "https://example.com/",
        ignoreCache: false,
        handleBeforeUnload: "accept",
      },
    }),
  ).toThrow("url must be present only when navigation type is url");
});

test("Tinker Chrome v2 validates bounded page and debug results", () => {
  const pageId = randomUUID();
  expect(
    parseListPagesResultV2({
      schemaVersion: 2,
      pages: [
        {
          pageId,
          url: "https://example.com/",
          title: "Example Domain",
          loadState: "complete",
          active: true,
        },
      ],
      truncated: false,
    }),
  ).toMatchObject({ pages: [{ pageId, active: true }] });
  expect(
    parseListConsoleMessagesResultV2({
      schemaVersion: 2,
      pageId,
      pageIdx: 0,
      pageSize: 50,
      totalMessages: 1,
      totalPages: 1,
      output: "msgid=1 [log] ready (0 args)",
      truncated: false,
    }),
  ).toMatchObject({ pageId, totalMessages: 1 });
  expect(
    parseGetNetworkRequestResultV2({
      schemaVersion: 2,
      pageId,
      reqid: 2,
      output: "## Request https://example.com/",
      truncated: false,
    }),
  ).toMatchObject({ pageId, reqid: 2 });
});
