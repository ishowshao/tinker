import { PLUGIN_CAPABILITIES, PROTOCOL_VERSION } from "./constants";
import {
  type ChromeBridgeErrorCode,
  type ChromeBridgeErrorDetails,
  type ChromeBridgeOutcome,
  isChromeBridgeErrorCode,
} from "./errors";

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];
export type BridgeMethod = PluginCapability;

export type PluginHelloV1 = {
  kind: "plugin_hello";
  protocolVersion: 1;
  pluginVersion: string;
  capabilities: ["page.open", "page.summary"];
};

export type BridgeHelloV1 = {
  kind: "hello";
  protocolVersion: 1;
  runtimeId: string;
  authToken: string;
  extensionOrigin: string;
  pluginVersion: string;
  capabilities: ["page.open", "page.summary"];
};

export type BridgeHelloAckV1 = {
  kind: "hello_ack";
  protocolVersion: 1;
  runtimeId: string;
};

export type BridgeRequestV1 = {
  kind: "request";
  protocolVersion: 1;
  runtimeId: string;
  requestId: string;
  method: BridgeMethod;
  deadlineUnixMs: number;
  params: unknown;
};

export type BridgeSuccessV1 = {
  kind: "response";
  protocolVersion: 1;
  runtimeId: string;
  requestId: string;
  ok: true;
  result: unknown;
};

export type BridgeFailureV1 = {
  kind: "response";
  protocolVersion: 1;
  runtimeId: string;
  requestId: string;
  ok: false;
  error: {
    code: ChromeBridgeErrorCode;
    message: string;
    retryable: boolean;
    outcome: ChromeBridgeOutcome;
    details?: ChromeBridgeErrorDetails;
  };
};

export type BridgeResponseV1 = BridgeSuccessV1 | BridgeFailureV1;

export type BridgePingV1 = {
  kind: "ping";
  protocolVersion: 1;
  runtimeId: string;
  sentAtUnixMs: number;
};

export type BridgePongV1 = {
  kind: "pong";
  protocolVersion: 1;
  runtimeId: string;
  sentAtUnixMs: number;
};

export type OpenPageResultV1 = {
  pageId: string;
  url: string;
  title: string;
  loadState: "complete";
};

export type PageSummaryV1 = {
  schemaVersion: 1;
  pageId: string;
  url: string;
  title: string;
  description?: string;
  canonicalUrl?: string;
  language?: string;
  headings: Array<{
    level: 1 | 2 | 3;
    text: string;
  }>;
  content: string;
  truncated: boolean;
};

export function parsePluginHello(value: unknown): PluginHelloV1 {
  const record = requireRecord(value, "plugin hello");
  requireExactKeys(record, [
    "kind",
    "protocolVersion",
    "pluginVersion",
    "capabilities",
  ]);
  requireLiteral(record.kind, "plugin_hello", "plugin hello kind");
  requireProtocolVersion(record.protocolVersion);
  const pluginVersion = requireNonEmptyString(record.pluginVersion, "plugin version");
  const capabilities = parseCapabilities(record.capabilities);

  return {
    kind: "plugin_hello",
    protocolVersion: PROTOCOL_VERSION,
    pluginVersion,
    capabilities,
  };
}

export function parseBridgeHello(value: unknown): BridgeHelloV1 {
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
  requireProtocolVersion(record.protocolVersion);

  return {
    kind: "hello",
    protocolVersion: PROTOCOL_VERSION,
    runtimeId: requireUuid(record.runtimeId, "runtimeId"),
    authToken: requireNonEmptyString(record.authToken, "authToken"),
    extensionOrigin: requireNonEmptyString(record.extensionOrigin, "extensionOrigin"),
    pluginVersion: requireNonEmptyString(record.pluginVersion, "pluginVersion"),
    capabilities: parseCapabilities(record.capabilities),
  };
}

export function parseBridgeHelloAck(value: unknown): BridgeHelloAckV1 {
  const record = requireRecord(value, "bridge hello ack");
  requireExactKeys(record, ["kind", "protocolVersion", "runtimeId"]);
  requireLiteral(record.kind, "hello_ack", "bridge hello ack kind");
  requireProtocolVersion(record.protocolVersion);

  return {
    kind: "hello_ack",
    protocolVersion: PROTOCOL_VERSION,
    runtimeId: requireUuid(record.runtimeId, "runtimeId"),
  };
}

export function parseBridgeRequest(value: unknown): BridgeRequestV1 {
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
  requireProtocolVersion(record.protocolVersion);

  if (!PLUGIN_CAPABILITIES.includes(record.method as PluginCapability)) {
    throw new Error(`Unsupported bridge method ${JSON.stringify(record.method)}.`);
  }

  const deadlineUnixMs = requireSafeInteger(record.deadlineUnixMs, "deadlineUnixMs");
  if (deadlineUnixMs <= 0) {
    throw new Error("deadlineUnixMs must be positive.");
  }

  return {
    kind: "request",
    protocolVersion: PROTOCOL_VERSION,
    runtimeId: requireUuid(record.runtimeId, "runtimeId"),
    requestId: requireUuid(record.requestId, "requestId"),
    method: record.method as BridgeMethod,
    deadlineUnixMs,
    params: record.params,
  };
}

export function parseBridgeResponse(value: unknown): BridgeResponseV1 {
  const record = requireRecord(value, "bridge response");
  requireLiteral(record.kind, "response", "bridge response kind");
  requireProtocolVersion(record.protocolVersion);
  const runtimeId = requireUuid(record.runtimeId, "runtimeId");
  const requestId = requireUuid(record.requestId, "requestId");

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
      protocolVersion: PROTOCOL_VERSION,
      runtimeId,
      requestId,
      ok: true,
      result: record.result,
    };
  }

  if (record.ok !== false) {
    throw new Error("Bridge response ok must be a boolean.");
  }
  requireExactKeys(record, [
    "kind",
    "protocolVersion",
    "runtimeId",
    "requestId",
    "ok",
    "error",
  ]);
  const error = parseBridgeFailureBody(record.error);

  return {
    kind: "response",
    protocolVersion: PROTOCOL_VERSION,
    runtimeId,
    requestId,
    ok: false,
    error,
  };
}

export function parseBridgePing(value: unknown): BridgePingV1 {
  return parseHeartbeat(value, "ping");
}

export function parseBridgePong(value: unknown): BridgePongV1 {
  return parseHeartbeat(value, "pong");
}

export function parseOpenPageResult(value: unknown): OpenPageResultV1 {
  const record = requireRecord(value, "open page result");
  requireExactKeys(record, ["pageId", "url", "title", "loadState"]);
  requireLiteral(record.loadState, "complete", "loadState");

  return {
    pageId: requireUuid(record.pageId, "pageId"),
    url: requireNonEmptyString(record.url, "url"),
    title: requireString(record.title, "title"),
    loadState: "complete",
  };
}

export function parsePageSummary(value: unknown): PageSummaryV1 {
  const record = requireRecord(value, "page summary");
  requireAllowedKeys(record, [
    "schemaVersion",
    "pageId",
    "url",
    "title",
    "description",
    "canonicalUrl",
    "language",
    "headings",
    "content",
    "truncated",
  ]);
  for (const required of [
    "schemaVersion",
    "pageId",
    "url",
    "title",
    "headings",
    "content",
    "truncated",
  ]) {
    if (!(required in record)) {
      throw new Error(`Page summary is missing ${required}.`);
    }
  }
  requireLiteral(record.schemaVersion, 1, "summary schemaVersion");
  if (!Array.isArray(record.headings)) {
    throw new Error("Page summary headings must be an array.");
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
      text: requireNonEmptyString(item.text, `heading ${index} text`),
    };
  });

  return {
    schemaVersion: 1,
    pageId: requireUuid(record.pageId, "pageId"),
    url: requireNonEmptyString(record.url, "url"),
    title: requireString(record.title, "title"),
    ...(record.description === undefined
      ? {}
      : { description: requireString(record.description, "description") }),
    ...(record.canonicalUrl === undefined
      ? {}
      : { canonicalUrl: requireString(record.canonicalUrl, "canonicalUrl") }),
    ...(record.language === undefined
      ? {}
      : { language: requireString(record.language, "language") }),
    headings,
    content: requireNonEmptyString(record.content, "content"),
    truncated: requireBoolean(record.truncated, "truncated"),
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCapabilities(value: unknown): ["page.open", "page.summary"] {
  if (
    !Array.isArray(value) ||
    value.length !== PLUGIN_CAPABILITIES.length ||
    value[0] !== PLUGIN_CAPABILITIES[0] ||
    value[1] !== PLUGIN_CAPABILITIES[1]
  ) {
    throw new Error(`Capabilities must be exactly ${PLUGIN_CAPABILITIES.join(", ")}.`);
  }
  return ["page.open", "page.summary"];
}

function parseHeartbeat<TKind extends "ping" | "pong">(
  value: unknown,
  kind: TKind,
): {
  kind: TKind;
  protocolVersion: 1;
  runtimeId: string;
  sentAtUnixMs: number;
} {
  const record = requireRecord(value, `bridge ${kind}`);
  requireExactKeys(record, ["kind", "protocolVersion", "runtimeId", "sentAtUnixMs"]);
  requireLiteral(record.kind, kind, `bridge ${kind} kind`);
  requireProtocolVersion(record.protocolVersion);
  return {
    kind,
    protocolVersion: PROTOCOL_VERSION,
    runtimeId: requireUuid(record.runtimeId, "runtimeId"),
    sentAtUnixMs: requireSafeInteger(record.sentAtUnixMs, "sentAtUnixMs"),
  };
}

function parseBridgeFailureBody(value: unknown): BridgeFailureV1["error"] {
  const record = requireRecord(value, "bridge error");
  requireAllowedKeys(record, ["code", "message", "retryable", "outcome", "details"]);
  for (const required of ["code", "message", "retryable", "outcome"]) {
    if (!(required in record)) {
      throw new Error(`Bridge error is missing ${required}.`);
    }
  }
  if (!isChromeBridgeErrorCode(record.code)) {
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): void {
  requireAllowedKeys(record, expected);
  for (const key of expected) {
    if (!(key in record)) {
      throw new Error(`Message is missing required field ${key}.`);
    }
  }
}

function requireAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new Error(`Message contains unknown field ${key}.`);
    }
  }
}

function requireProtocolVersion(value: unknown): asserts value is 1 {
  if (value !== PROTOCOL_VERSION) {
    throw new Error(
      `Protocol version must be ${PROTOCOL_VERSION}; received ${JSON.stringify(value)}.`,
    );
  }
}

function requireLiteral<T>(
  value: unknown,
  expected: T,
  label: string,
): asserts value is T {
  if (value !== expected) {
    throw new Error(`${label} must be ${JSON.stringify(expected)}.`);
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
  if (text.trim() === "") {
    throw new Error(`${label} must not be empty.`);
  }
  return text;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer.`);
  }
  return value as number;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}
