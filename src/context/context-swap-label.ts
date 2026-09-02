import type { ToolCall } from "../agent/types";
import type { ToolRawResult } from "../tools/types";
import type {
  CanonicalMessageRecord,
  ProtocolContextView,
  ToolResultRecord,
} from "./protocol-frame";

const MAX_LABEL_BYTES = 80;

export function renderContextSwapCandidateLabel(input: {
  canonical: ProtocolContextView;
  message: Extract<CanonicalMessageRecord, { role: "tool" }>;
  result: ToolResultRecord;
}): string {
  const call = toolCallForMessage(input.canonical, input.message);
  const raw =
    input.result.completion.kind === "returned"
      ? input.result.completion.raw
      : undefined;
  return compactLabel(labelFor(input.message.name, call, raw));
}

function labelFor(
  toolName: string,
  call: ToolCall | undefined,
  raw: ToolRawResult | undefined,
): string {
  const args = asRecord(call?.args);
  switch (raw?.kind) {
    case "bash": {
      const description = nonEmptyString(args?.description);
      const command = nonEmptyString(args?.command)?.split(/\r?\n/, 1)[0];
      return prefixed("Bash", description ?? command, toolName);
    }
    case "read": {
      const filePath = nonEmptyString(args?.file_path);
      return prefixed("Read", readLocation(filePath, args), toolName);
    }
    case "grep": {
      const pattern = nonEmptyString(args?.pattern);
      if (pattern === undefined) return toolName;
      const searchPath = nonEmptyString(args?.path);
      return `Grep: ${JSON.stringify(pattern)}${searchPath === undefined ? "" : ` in ${searchPath}`}`;
    }
    case "glob":
      return prefixed("Glob", nonEmptyString(args?.pattern), toolName);
    case "task_output":
      return prefixed("TaskOutput", nonEmptyString(args?.task_id), toolName);
    case "web_search":
      return prefixed("WebSearch", nonEmptyString(args?.query), toolName);
    case "web_fetch": {
      const url = nonEmptyString(args?.url)?.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
      return prefixed("WebFetch", url, toolName);
    }
    case "mcp":
      return `MCP: ${raw.serverName}.${raw.serverToolName}`;
    case "view_image":
      return prefixed(
        "view_image",
        nonEmptyString(args?.file_path) ?? raw.filePath,
        toolName,
      );
    default:
      return toolName;
  }
}

function toolCallForMessage(
  canonical: ProtocolContextView,
  message: Extract<CanonicalMessageRecord, { role: "tool" }>,
): ToolCall | undefined {
  const assistant = canonical.messages.find(
    (entry) => entry.role === "assistant" && entry.frameId === message.frameId,
  );
  return assistant?.role === "assistant"
    ? assistant.toolCalls?.find((call) => call.toolCallId === message.toolCallId)
    : undefined;
}

function readLocation(
  filePath: string | undefined,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (filePath === undefined) return undefined;
  const offset = positiveInteger(args?.offset);
  const limit = positiveInteger(args?.limit);
  if (offset === undefined && limit === undefined) return filePath;
  const start = offset ?? 1;
  return limit === undefined
    ? `${filePath}:${start}`
    : `${filePath}:${start}-${start + limit - 1}`;
}

function prefixed(prefix: string, value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : `${prefix}: ${value}`;
}

function compactLabel(value: string): string {
  const normalized = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  const label = normalized === "" ? "Tool" : normalized;
  if (Buffer.byteLength(label, "utf8") <= MAX_LABEL_BYTES) return label;
  return `${utf8Prefix(label, MAX_LABEL_BYTES - Buffer.byteLength("…", "utf8"))}…`;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
