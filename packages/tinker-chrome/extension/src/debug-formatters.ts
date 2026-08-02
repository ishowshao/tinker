/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Console and network formatting adapted from ChromeDevTools/
 * chrome-devtools-mcp ConsoleFormatter, NetworkFormatter, and pagination
 * utilities.
 */
import type { HTTPRequest } from "puppeteer-core";
import {
  MAX_DEBUG_OUTPUT_CODE_POINTS,
  MAX_DEBUG_TEXT_CODE_POINTS,
} from "../../src/constants";
import type { CollectedItem, ConsoleEntry } from "./page-collector";

export type FormattedDebugOutput = {
  output: string;
  truncated: boolean;
};

export type FormattedDebugList = FormattedDebugOutput & {
  pageIdx: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

type PaginationOptions = {
  pageIdx: number;
  pageSize: number;
};

type ConsoleSummary = {
  entry: CollectedItem<ConsoleEntry>;
  type: string;
  text: string;
  argsCount: number;
  count: number;
};

export function formatConsoleList(
  entries: Array<CollectedItem<ConsoleEntry>>,
  options: PaginationOptions,
): FormattedDebugList {
  const grouped = groupConsecutiveConsoleMessages(entries);
  const page = paginate(grouped, options);
  const lines = [paginationLine(page)];
  if (page.items.length === 0) {
    lines.push("<no console messages found>");
  } else {
    for (const item of page.items) {
      const countSuffix = item.count > 1 ? ` [${item.count} times]` : "";
      lines.push(
        `msgid=${item.entry.id} [${item.type}] ${singleLine(item.text)} (${item.argsCount} args)${countSuffix}`,
      );
    }
  }
  return {
    ...boundedOutput(lines.join("\n")),
    pageIdx: page.pageIdx,
    pageSize: options.pageSize,
    totalItems: grouped.length,
    totalPages: page.totalPages,
  };
}

export async function formatConsoleDetail(
  entry: CollectedItem<ConsoleEntry>,
): Promise<FormattedDebugOutput> {
  const summary = consoleSummary(entry);
  const lines = [`ID: ${entry.id}`, `Message: ${summary.type}> ${summary.text}`];
  if (entry.item instanceof Error) {
    if (entry.item.stack) {
      lines.push("### Stack trace", entry.item.stack);
    }
    return boundedOutput(lines.join("\n"));
  }

  const location = entry.item.location();
  if (location.url !== undefined) {
    lines.push(`Location: ${formatLocation(location)}`);
  }
  const args = await Promise.all(
    entry.item.args().map(async (argument, index) => {
      try {
        return formatDebugValue(await argument.jsonValue());
      } catch {
        return `<error: Argument ${index} is no longer available>`;
      }
    }),
  );
  if (args.length > 0) {
    lines.push("### Arguments");
    args.forEach((argument, index) => lines.push(`Arg #${index}: ${argument}`));
  }
  const stack = entry.item.stackTrace();
  if (stack.length > 0) {
    lines.push(
      "### Stack trace",
      ...stack.map((frame) => `at ${formatLocation(frame)}`),
    );
  }
  return boundedOutput(lines.join("\n"));
}

export function formatNetworkList(
  entries: Array<CollectedItem<HTTPRequest>>,
  options: PaginationOptions,
): FormattedDebugList {
  const page = paginate(entries, options);
  const lines = [paginationLine(page)];
  if (page.items.length === 0) {
    lines.push("<no network requests found>");
  } else {
    lines.push(...page.items.map(formatNetworkSummary));
  }
  return {
    ...boundedOutput(lines.join("\n")),
    pageIdx: page.pageIdx,
    pageSize: options.pageSize,
    totalItems: entries.length,
    totalPages: page.totalPages,
  };
}

export async function formatNetworkDetail(
  entry: CollectedItem<HTTPRequest>,
  resolveRequestId: (request: HTTPRequest) => number | undefined,
): Promise<FormattedDebugOutput> {
  const request = entry.item;
  const lines = [
    `## Request ${request.url()}`,
    `Request ID: ${entry.id}`,
    `Resource type: ${request.resourceType()}`,
    `Status: ${networkStatus(request)}`,
    "### Request Headers",
    ...formatHeaders(request.headers()),
  ];

  if (request.hasPostData()) {
    const body = await request
      .fetchPostData()
      .catch(() => request.postData() ?? "<request body not available anymore>");
    lines.push(
      "### Request Body",
      truncateText(body ?? "<empty request>", MAX_DEBUG_TEXT_CODE_POINTS),
    );
  }

  const response = request.response();
  if (response !== null) {
    lines.push("### Response Headers", ...formatHeaders(response.headers()));
    lines.push("### Response Body", await responseBody(response));
  }
  const failure = request.failure();
  if (failure !== null) {
    lines.push("### Request failed with", failure.errorText);
  }

  const redirectChain = [...request.redirectChain()].reverse();
  if (redirectChain.length > 0) {
    lines.push("### Redirect chain");
    redirectChain.forEach((redirect, index) => {
      const id = resolveRequestId(redirect);
      lines.push(
        `${"  ".repeat(index)}${formatNetworkSummary({ id: id ?? 0, item: redirect })}`,
      );
    });
  }
  return boundedOutput(lines.join("\n"));
}

function groupConsecutiveConsoleMessages(
  entries: Array<CollectedItem<ConsoleEntry>>,
): ConsoleSummary[] {
  const grouped: ConsoleSummary[] = [];
  for (const entry of entries) {
    const summary = consoleSummary(entry);
    const previous = grouped.at(-1);
    if (
      previous !== undefined &&
      previous.type === summary.type &&
      previous.text === summary.text &&
      previous.argsCount === summary.argsCount
    ) {
      previous.count += 1;
    } else {
      grouped.push(summary);
    }
  }
  return grouped;
}

function consoleSummary(entry: CollectedItem<ConsoleEntry>): ConsoleSummary {
  if (entry.item instanceof Error) {
    return {
      entry,
      type: "error",
      text: entry.item.message,
      argsCount: 0,
      count: 1,
    };
  }
  return {
    entry,
    type: entry.item.type(),
    text: entry.item.text(),
    argsCount: entry.item.args().length,
    count: 1,
  };
}

function formatNetworkSummary(entry: CollectedItem<HTTPRequest>): string {
  return `reqid=${entry.id} ${entry.item.method()} ${entry.item.url()} [${networkStatus(entry.item)}] type=${entry.item.resourceType()}`;
}

function networkStatus(request: HTTPRequest): string {
  return (
    request.response()?.status().toString() ?? request.failure()?.errorText ?? "pending"
  );
}

function formatHeaders(headers: Record<string, string>): string[] {
  const entries = Object.entries(headers).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) {
    return ["<none>"];
  }
  return entries.map(([name, value]) => {
    const normalized = name.toLowerCase();
    const safeValue = SENSITIVE_HEADERS.has(normalized) ? "<redacted>" : value;
    return `- ${name}: ${singleLine(safeValue)}`;
  });
}

async function responseBody(
  response: NonNullable<ReturnType<HTTPRequest["response"]>>,
): Promise<string> {
  try {
    const buffer = await response.content();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (decoded.length === 0) {
      return "<empty response>";
    }
    return truncateText(decoded, MAX_DEBUG_TEXT_CODE_POINTS);
  } catch {
    return "<binary data or response body not available anymore>";
  }
}

function formatDebugValue(value: unknown): string {
  let formatted: string;
  if (typeof value === "string") {
    formatted = value;
  } else {
    try {
      formatted = JSON.stringify(value) ?? String(value);
    } catch {
      formatted = String(value);
    }
  }
  return truncateText(formatted, MAX_DEBUG_TEXT_CODE_POINTS);
}

function formatLocation(location: {
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}): string {
  const url = location.url ?? "<anonymous>";
  const line = location.lineNumber === undefined ? "?" : location.lineNumber + 1;
  const column = location.columnNumber === undefined ? "?" : location.columnNumber + 1;
  return `${url}:${line}:${column}`;
}

function paginate<T>(
  items: T[],
  options: PaginationOptions,
): {
  items: T[];
  pageIdx: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
} {
  const totalPages = Math.ceil(items.length / options.pageSize);
  const pageIdx = totalPages > 0 && options.pageIdx < totalPages ? options.pageIdx : 0;
  const start = pageIdx * options.pageSize;
  return {
    items: items.slice(start, start + options.pageSize),
    pageIdx,
    pageSize: options.pageSize,
    totalItems: items.length,
    totalPages,
  };
}

function paginationLine(page: ReturnType<typeof paginate>): string {
  if (page.totalItems === 0) {
    return "Showing 0 of 0.";
  }
  const start = page.pageIdx * page.pageSize + 1;
  const end = Math.min(start + page.items.length - 1, page.totalItems);
  return `Showing ${start}-${end} of ${page.totalItems} (Page ${page.pageIdx + 1} of ${page.totalPages}).`;
}

function boundedOutput(text: string): FormattedDebugOutput {
  const codePoints = Array.from(text);
  if (codePoints.length <= MAX_DEBUG_OUTPUT_CODE_POINTS) {
    return { output: text, truncated: false };
  }
  const marker = "\n... debug output truncated ...";
  const markerCodePoints = Array.from(marker);
  return {
    output: [
      ...codePoints.slice(0, MAX_DEBUG_OUTPUT_CODE_POINTS - markerCodePoints.length),
      ...markerCodePoints,
    ].join(""),
    truncated: true,
  };
}

function truncateText(text: string, maxCodePoints: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= maxCodePoints) {
    return text;
  }
  const marker = "... <truncated>";
  const markerCodePoints = Array.from(marker);
  return [
    ...codePoints.slice(0, maxCodePoints - markerCodePoints.length),
    ...markerCodePoints,
  ].join("");
}

function singleLine(text: string): string {
  return text.replaceAll(/[\r\n\t]+/g, " ").trim();
}

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);
