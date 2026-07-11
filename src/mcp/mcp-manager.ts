import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RuntimeSession } from "../agent/runtime-session";
import type { ToolExecutor } from "../tools/types";
import type { McpConfig, McpServerConfig } from "./mcp-config";
import { createMcpToolExecutor } from "./mcp-tool-executor";

const STDERR_TAIL_MAX_CHARS = 2_000;

export type McpClientConnection = {
  client: Client;
  close(): Promise<void>;
};

export type McpClientFactory = (
  serverName: string,
  serverConfig: McpServerConfig,
) => Promise<McpClientConnection>;

export type McpManager = {
  executors: ToolExecutor[];
  dispose(): Promise<void>;
};

export type CreateMcpManagerOptions = {
  config: McpConfig;
  runtimeSession: RuntimeSession;
  clientFactory?: McpClientFactory;
  timeoutMs?: number;
  maxObservationChars?: number;
};

export async function createMcpManager(
  options: CreateMcpManagerOptions,
): Promise<McpManager> {
  const clientFactory = options.clientFactory ?? stdioClientFactory;
  const timeoutMs =
    options.timeoutMs ?? parsePositiveIntegerEnv("TINKER_MCP_TIMEOUT_MS");
  const maxObservationChars =
    options.maxObservationChars ??
    parsePositiveIntegerEnv("TINKER_MCP_MAX_OBSERVATION_CHARS");
  const connections: McpClientConnection[] = [];
  const executors: ToolExecutor[] = [];

  for (const [serverName, serverConfig] of options.config.servers) {
    let connection: McpClientConnection;
    let tools;

    try {
      connection = await clientFactory(serverName, serverConfig);
    } catch (error) {
      await options.runtimeSession.append({
        type: "mcp.server.failed",
        sessionId: options.runtimeSession.sessionId,
        data: {
          serverName,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      continue;
    }

    try {
      tools = (await connection.client.listTools()).tools;
    } catch (error) {
      await connection.close().catch(() => undefined);
      await options.runtimeSession.append({
        type: "mcp.server.failed",
        sessionId: options.runtimeSession.sessionId,
        data: {
          serverName,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      continue;
    }

    connections.push(connection);

    const seenToolNames = new Set<string>();

    for (const tool of tools) {
      if (seenToolNames.has(tool.name)) {
        continue;
      }

      seenToolNames.add(tool.name);
      executors.push(
        createMcpToolExecutor({
          client: connection.client,
          serverName,
          tool,
          timeoutMs,
          maxObservationChars,
        }),
      );
    }

    await options.runtimeSession.append({
      type: "mcp.server.connected",
      sessionId: options.runtimeSession.sessionId,
      data: { serverName, toolCount: seenToolNames.size },
    });
  }

  return {
    executors,
    async dispose(): Promise<void> {
      await Promise.all(
        connections.map((connection) => connection.close().catch(() => undefined)),
      );
    },
  };
}

function parsePositiveIntegerEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; received ${value}`);
  }

  return parsed;
}

async function stdioClientFactory(
  serverName: string,
  serverConfig: McpServerConfig,
): Promise<McpClientConnection> {
  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args,
    env: { ...getDefaultEnvironment(), ...serverConfig.env },
    cwd: serverConfig.cwd,
    stderr: "pipe",
  });

  let stderrTail = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_MAX_CHARS);
  });

  const client = new Client({ name: "tinker", version: "0.1.0" });

  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    const stderrSuffix =
      stderrTail.trim() === "" ? "" : `\nServer stderr:\n${stderrTail.trim()}`;
    throw new Error(
      `Failed to connect to MCP server "${serverName}" (${serverConfig.command}): ${message}${stderrSuffix}`,
      { cause: error },
    );
  }

  return {
    client,
    close: () => client.close(),
  };
}
