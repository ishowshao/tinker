import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  parseBridgeRequest,
  parseBridgeResponse,
  parsePageSummary,
  parsePluginHello,
} from "../src/protocol-v1";

test("Tinker Chrome protocol accepts exact v1 messages", () => {
  expect(
    parsePluginHello({
      kind: "plugin_hello",
      protocolVersion: 1,
      pluginVersion: "0.1.0",
      capabilities: ["page.open", "page.summary"],
    }),
  ).toEqual({
    kind: "plugin_hello",
    protocolVersion: 1,
    pluginVersion: "0.1.0",
    capabilities: ["page.open", "page.summary"],
  });

  const runtimeId = randomUUID();
  const requestId = randomUUID();
  expect(
    parseBridgeRequest({
      kind: "request",
      protocolVersion: 1,
      runtimeId,
      requestId,
      method: "page.open",
      deadlineUnixMs: Date.now() + 1_000,
      params: { pageId: randomUUID(), url: "https://example.com/" },
    }).requestId,
  ).toBe(requestId);

  expect(
    parseBridgeResponse({
      kind: "response",
      protocolVersion: 1,
      runtimeId,
      requestId,
      ok: false,
      error: {
        code: "TAB_CLOSED",
        message: "closed",
        retryable: false,
        outcome: "performed",
      },
    }).ok,
  ).toBe(false);
});

test("Tinker Chrome protocol rejects unknown fields and loose capabilities", () => {
  expect(() =>
    parsePluginHello({
      kind: "plugin_hello",
      protocolVersion: 1,
      pluginVersion: "0.1.0",
      capabilities: ["page.summary", "page.open"],
    }),
  ).toThrow("Capabilities must be exactly");

  expect(() =>
    parseBridgeResponse({
      kind: "response",
      protocolVersion: 1,
      runtimeId: randomUUID(),
      requestId: randomUUID(),
      ok: true,
      result: {},
      ignored: true,
    }),
  ).toThrow("unknown field ignored");

  expect(() =>
    parseBridgeResponse({
      kind: "response",
      protocolVersion: 1,
      runtimeId: randomUUID(),
      requestId: randomUUID(),
      ok: false,
      error: {
        code: "SNAPSHOT_REQUIRED",
        message: "v2-only error",
        retryable: false,
        outcome: "not_started",
      },
    }),
  ).toThrow("Unknown bridge error code");
});

test("Tinker Chrome validates page summary shape", () => {
  const pageId = randomUUID();
  expect(
    parsePageSummary({
      schemaVersion: 1,
      pageId,
      url: "https://example.com/",
      title: "Example Domain",
      headings: [{ level: 1, text: "Example Domain" }],
      content: "Example content",
      truncated: false,
    }),
  ).toEqual({
    schemaVersion: 1,
    pageId,
    url: "https://example.com/",
    title: "Example Domain",
    headings: [{ level: 1, text: "Example Domain" }],
    content: "Example content",
    truncated: false,
  });
});
