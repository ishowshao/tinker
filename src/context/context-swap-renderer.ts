import { contentHash } from "./protocol-frame";
import { formatMessageSource } from "./context-source";
import type { CanonicalMessageRecord, ToolResultRecord } from "./protocol-frame";
import type { ToolRawResult, ToolRawResultKind } from "../tools/types";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import type { SwapOverride } from "./context-revision";

const MAX_METADATA_BYTES = 1_024;
const MAX_SCALAR_BYTES = 256;

export const SWAP_OBSERVATION_FORMAT = "swap-observation-v1" as const;
export const SWAP_TOOL_IMAGE_FORMAT = "swap-tool-image-v1" as const;

export const SWAPPABLE_RAW_KINDS = Object.freeze([
  "read",
  "glob",
  "grep",
  "bash",
  "task_output",
  "web_search",
  "web_fetch",
  "mcp",
  "view_image",
] as const satisfies readonly ToolRawResultKind[]);

export type SwappableRawKind = (typeof SWAPPABLE_RAW_KINDS)[number];

export class SwapRenderUnsupportedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SwapRenderUnsupportedError";
  }
}

export class ContextSwapRenderer {
  render(input: {
    message: Extract<CanonicalMessageRecord, { role: "tool" }>;
    result: ToolResultRecord;
  }): SwapOverride {
    const { message, result } = input;
    if (
      result.toolMessageId !== message.messageId ||
      result.frameId !== message.frameId ||
      result.toolCallId !== message.toolCallId ||
      result.observationSha256 !== message.contentSha256
    ) {
      throw new SwapRenderUnsupportedError(
        "source_hash_mismatch",
        "Canonical tool result does not match its message.",
      );
    }
    if (result.completion.kind !== "returned") {
      throw new SwapRenderUnsupportedError(
        "synthetic_completion",
        "Synthetic tool completions cannot be swapped.",
      );
    }
    const raw = result.completion.raw;
    if (!isSwappableRawResult(raw)) {
      throw new SwapRenderUnsupportedError(
        "raw_kind_not_allowlisted",
        "Tool result kind is not eligible for swap rendering.",
      );
    }
    assertHistoricalRawIsStable(raw);

    const source = formatMessageSource(message.messageId);
    const renderedContent =
      raw.kind === "view_image"
        ? renderImagePlaceholder(raw)
        : [
            "[Tinker historical tool observation swapped]",
            `source=${source}`,
            `contentSha256=${message.contentSha256}`,
            `tool=${stableJsonStringify(compactExternalString(message.name))}`,
            `metadata=${renderMetadata(raw)}`,
            "historical=Use RecallGet with source to recover the original observation.",
            `current=${currentGuidance(raw.kind)}`,
          ].join("\n");
    const originalBytes = utf8Bytes(message.displayText);
    const renderedBytes = utf8Bytes(renderedContent);
    if (raw.kind !== "view_image" && renderedBytes >= originalBytes) {
      throw new SwapRenderUnsupportedError(
        "placeholder_not_smaller",
        "Rendered placeholder is not smaller than its canonical observation.",
      );
    }
    return Object.freeze({
      frameId: message.frameId,
      messageId: message.messageId,
      ordinal: message.ordinal,
      source,
      originalContentSha256: message.contentSha256,
      renderedContent,
      renderedContentSha256: contentHash(renderedContent),
      originalBytes,
      renderedBytes,
      byteSavings: originalBytes - renderedBytes,
      ...(raw.kind === "view_image" ? { rendererFormat: SWAP_TOOL_IMAGE_FORMAT } : {}),
    });
  }
}

export function isSwappableRawResult(
  raw: ToolRawResult,
): raw is Extract<ToolRawResult, { kind: SwappableRawKind }> {
  return (SWAPPABLE_RAW_KINDS as readonly string[]).includes(raw.kind);
}

function assertHistoricalRawIsStable(
  raw: Extract<ToolRawResult, { kind: SwappableRawKind }>,
): void {
  if (raw.kind === "bash" && raw.status === "running") {
    throw new SwapRenderUnsupportedError(
      "running_task",
      "Running Bash results cannot be rendered as historical placeholders.",
    );
  }
  if (
    raw.kind === "task_output" &&
    (raw.status === "running" || raw.status === "stopping")
  ) {
    throw new SwapRenderUnsupportedError(
      "running_task",
      "Running task output cannot be rendered as a historical placeholder.",
    );
  }
  if (raw.kind === "view_image" && (!raw.ok || raw.asset === undefined)) {
    throw new SwapRenderUnsupportedError(
      "unsuccessful_image",
      "Only successful ViewImage results can use the image swap renderer.",
    );
  }
}

function renderImagePlaceholder(
  raw: Extract<ToolRawResult, { kind: "view_image" }>,
): string {
  if (!raw.ok || raw.asset === undefined) {
    throw new SwapRenderUnsupportedError(
      "unsuccessful_image",
      "Only successful ViewImage results can use the image swap renderer.",
    );
  }
  const asset = raw.asset;
  return `[Tool image omitted from compacted context: ViewImage ${raw.filePath}, ${asset.mimeType}, ${asset.width}x${asset.height}, asset=${asset.assetId.slice(0, 12)}…. Use ViewImage again if the current image is required.]`;
}

function renderMetadata(
  raw: Extract<ToolRawResult, { kind: SwappableRawKind }>,
): string {
  const entries: readonly (readonly [string, unknown])[] = metadataEntries(raw);
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (value === undefined) {
      continue;
    }
    const next = {
      ...metadata,
      [key]: typeof value === "string" ? compactExternalString(value) : value,
    };
    if (utf8Bytes(stableJsonStringify(next)) <= MAX_METADATA_BYTES) {
      Object.assign(metadata, { [key]: next[key] });
    }
  }
  const rendered = stableJsonStringify(metadata);
  if (utf8Bytes(rendered) > MAX_METADATA_BYTES) {
    throw new SwapRenderUnsupportedError(
      "metadata_too_large",
      "Swap placeholder metadata exceeded its byte limit.",
    );
  }
  return rendered;
}

function metadataEntries(
  raw: Extract<ToolRawResult, { kind: SwappableRawKind }>,
): readonly (readonly [string, unknown])[] {
  switch (raw.kind) {
    case "read":
      return [
        ["filePath", raw.filePath],
        ["startLine", raw.startLine],
        ["endLine", raw.endLine],
        ["sha256", raw.sha256],
        ["sizeBytes", raw.sizeBytes],
      ];
    case "glob":
      return [
        ["pattern", raw.pattern],
        ["searchPath", raw.searchPath],
        ["matchCount", raw.matchCount],
        ["totalMatches", raw.totalMatches],
        ["returnedCount", raw.returnedCount],
        ["appliedOffset", raw.appliedOffset],
        ["hasMore", raw.hasMore],
        ["nextOffset", raw.nextOffset],
      ];
    case "grep":
      return [
        ["pattern", raw.pattern],
        ["searchPath", raw.searchPath],
        ["mode", raw.mode],
        ["numMatches", raw.numMatches],
        ["truncated", raw.truncated],
      ];
    case "bash":
      return [
        ["status", raw.status],
        ["exitCode", raw.exitCode],
        ["outputFilePath", raw.outputFilePath],
        ["outputBytes", raw.outputBytes],
        ["command", raw.command],
      ];
    case "task_output":
      return [
        ["taskId", raw.taskId],
        ["status", raw.status],
        ["outputFilePath", raw.outputFilePath],
        ["outputBytes", raw.outputBytes],
      ];
    case "web_search":
      return [
        ["query", raw.query],
        ["resultCount", raw.resultCount],
        ["requestId", raw.requestId],
      ];
    case "web_fetch":
      return [
        ["url", raw.url],
        ["finalUrl", raw.finalUrl],
        ["title", raw.title],
        ["httpStatusCode", raw.httpStatusCode],
      ];
    case "mcp":
      return [
        ["serverName", raw.serverName],
        ["serverToolName", raw.serverToolName],
        ["isError", raw.isError],
        ["contentBlockCount", raw.contentBlockCount],
      ];
    case "view_image":
      return [
        ["filePath", raw.filePath],
        ["mimeType", raw.asset?.mimeType],
        ["width", raw.asset?.width],
        ["height", raw.asset?.height],
        ["assetId", raw.asset?.assetId],
      ];
  }
}

function currentGuidance(kind: SwappableRawKind): string {
  switch (kind) {
    case "read":
      return "Use Read to inspect the current file state before relying on historical content.";
    case "glob":
      return "Use Glob to inspect the current workspace matches.";
    case "grep":
      return "Use Grep to inspect current workspace matches.";
    case "bash":
      return "Inspect current state before deciding whether a historical command should be rerun.";
    case "task_output":
      return "Use TaskOutput to inspect the task's current recorded output and status.";
    case "web_search":
      return "Use WebSearch when current search results are required.";
    case "web_fetch":
      return "Use WebFetch when the current page content is required.";
    case "mcp":
      return "Call the MCP tool again only when current external state is required.";
    case "view_image":
      return "Use ViewImage again if the current image is required.";
  }
}

function compactExternalString(
  value: string,
):
  | string
  | { readonly prefix: string; readonly byteLength: number; readonly sha256: string } {
  const byteLength = utf8Bytes(value);
  if (byteLength <= MAX_SCALAR_BYTES) {
    return value;
  }
  return Object.freeze({
    prefix: utf8Prefix(value, MAX_SCALAR_BYTES),
    byteLength,
    sha256: sha256(value),
  });
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let prefix = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > maximumBytes) {
      break;
    }
    prefix += character;
    bytes += characterBytes;
  }
  return prefix;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
