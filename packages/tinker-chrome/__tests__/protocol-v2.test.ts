import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MAX_SNAPSHOT_CODE_POINTS, PLUGIN_CAPABILITIES_V2 } from "../src/constants";
import {
  parseBridgeRequestV2,
  parseBridgeResponseV2,
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
      },
      "click",
    ),
  ).toMatchObject({ pageId, action: "click", performed: true });
});
