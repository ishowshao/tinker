import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { cancellationError, throwIfTurnCancelled } from "../agent/turn-cancellation";
import { defineToolExecutor } from "../tools/types";
import type {
  JsonSchema,
  McpToolRawResult,
  ToolExecutionContext,
  ToolExecutor,
} from "../tools/types";
import { DEFAULT_PUBLIC_TOOLING_CONFIG } from "../cli/public-config-contract";

export const MCP_TOOL_NAME_PREFIX = "mcp__";

export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_NAME_PREFIX}${serverName}__${toolName}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_NAME_PREFIX);
}

export function sanitizeInputSchema(schema: unknown): JsonSchema {
  if (
    typeof schema !== "object" ||
    schema === null ||
    Array.isArray(schema) ||
    (schema as Record<string, unknown>).type !== "object"
  ) {
    return { type: "object", properties: {} };
  }

  const rest = { ...(schema as Record<string, unknown>) };
  delete rest.$schema;
  return rest;
}

export type CreateMcpToolExecutorOptions = {
  client: Client;
  serverName: string;
  tool: Tool;
  timeoutMs?: number;
  maxObservationChars?: number;
};

export function createMcpToolExecutor(
  options: CreateMcpToolExecutorOptions,
): ToolExecutor {
  const toolName = mcpToolName(options.serverName, options.tool.name);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUBLIC_TOOLING_CONFIG.mcpTimeoutMs;
  const maxObservationChars =
    options.maxObservationChars ?? DEFAULT_PUBLIC_TOOLING_CONFIG.mcpMaxObservationChars;

  const base = {
    toolName,
    serverName: options.serverName,
    serverToolName: options.tool.name,
  };

  return defineToolExecutor("mcp", {
    definition: {
      name: toolName,
      description:
        options.tool.description ??
        `MCP tool ${options.tool.name} from server ${options.serverName}`,
      parameters: sanitizeInputSchema(options.tool.inputSchema),
    },
    async execute(
      args: unknown,
      _call,
      context: ToolExecutionContext,
    ): Promise<McpToolRawResult> {
      throwIfTurnCancelled(context.signal);
      if (args !== undefined && !isRecord(args)) {
        return {
          ok: false,
          ...base,
          error: `MCP tool arguments must be an object; received ${JSON.stringify(args)}`,
        };
      }

      let result;

      try {
        result = await options.client.callTool(
          {
            name: options.tool.name,
            arguments: args ?? {},
          },
          undefined,
          { timeout: timeoutMs, signal: context.signal },
        );
      } catch (error) {
        if (context.signal.aborted) {
          throw cancellationError(context.signal, error);
        }

        return {
          ok: false,
          ...base,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      const blocks = Array.isArray(result.content) ? result.content : [];
      const rendered = renderContentBlocks(blocks, maxObservationChars);
      const isError = result.isError === true;

      return {
        ok: !isError,
        ...base,
        isError,
        text: rendered.text,
        truncated: rendered.truncated,
        contentBlockCount: blocks.length,
      };
    },
  });
}

function renderContentBlocks(
  blocks: unknown[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const parts: string[] = [];

  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }

    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }

    parts.push(renderNonTextBlockPlaceholder(block));
  }

  const text = parts.join("\n");

  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return { text: text.slice(0, maxChars), truncated: true };
}

function renderNonTextBlockPlaceholder(block: Record<string, unknown>): string {
  const type = typeof block.type === "string" ? block.type : "unknown";

  if (type === "image" || type === "audio") {
    const mimeType = typeof block.mimeType === "string" ? ` ${block.mimeType}` : "";
    return `[${type}${mimeType} content omitted]`;
  }

  if (type === "resource_link") {
    const uri = typeof block.uri === "string" ? ` ${block.uri}` : "";
    return `[resource link${uri}]`;
  }

  if (type === "resource") {
    const resource = isRecord(block.resource) ? block.resource : {};
    if (typeof resource.text === "string") {
      return resource.text;
    }

    const uri = typeof resource.uri === "string" ? ` ${resource.uri}` : "";
    return `[resource${uri} content omitted]`;
  }

  return `[${type} content omitted]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
