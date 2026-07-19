import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RuntimeSessionContext } from "../agent/runtime-session";
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
  readonly executors: ToolExecutor[];
  readonly inventory: McpInventorySnapshot;
  dispose(): Promise<void>;
};

export type McpInventorySnapshot = {
  readonly servers: readonly McpServerInventory[];
};

export type McpServerInventory = {
  readonly name: string;
  readonly tools: readonly string[];
};

export type CreateMcpManagerOptions = {
  config: McpConfig;
  runtimeSession: RuntimeSessionContext;
  clientFactory?: McpClientFactory;
  timeoutMs?: number;
  maxObservationChars?: number;
};

export class McpInitializationError extends Error {
  constructor(
    readonly serverName: string,
    readonly stage: "connect" | "list_tools" | "validate_tools",
    options?: ErrorOptions,
  ) {
    super(`MCP server ${serverName} failed during ${stage}.`, options);
    this.name = "McpInitializationError";
  }
}

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
  const servers: McpServerInventory[] = [];

  try {
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
            error: "connection failed",
          },
        });
        throw new McpInitializationError(serverName, "connect", {
          cause: error,
        });
      }

      try {
        tools = (await connection.client.listTools()).tools;
      } catch (error) {
        let cause: unknown = error;
        try {
          await connection.close();
        } catch (closeError) {
          cause = new AggregateError(
            [error, closeError],
            `Failed to inspect and close MCP server ${serverName}.`,
            { cause: closeError },
          );
        }
        await options.runtimeSession.append({
          type: "mcp.server.failed",
          sessionId: options.runtimeSession.sessionId,
          data: {
            serverName,
            error: "tool discovery failed",
          },
        });
        throw new McpInitializationError(serverName, "list_tools", {
          cause,
        });
      }

      connections.push(connection);

      const seenToolNames = new Set<string>();
      try {
        for (const tool of tools) {
          if (
            tool.name.trim() === "" ||
            typeof tool.inputSchema !== "object" ||
            tool.inputSchema === null ||
            Array.isArray(tool.inputSchema) ||
            tool.inputSchema.type !== "object"
          ) {
            throw new Error("MCP tool name or input schema is invalid.");
          }
          if (seenToolNames.has(tool.name)) {
            throw new Error(`Duplicate MCP tool name ${tool.name}.`);
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
      } catch (error) {
        await options.runtimeSession.append({
          type: "mcp.server.failed",
          sessionId: options.runtimeSession.sessionId,
          data: {
            serverName,
            error: "tool validation failed",
          },
        });
        throw new McpInitializationError(serverName, "validate_tools", {
          cause: error,
        });
      }

      await options.runtimeSession.append({
        type: "mcp.server.connected",
        sessionId: options.runtimeSession.sessionId,
        data: { serverName, toolCount: seenToolNames.size },
      });
      servers.push(
        Object.freeze({
          name: serverName,
          tools: Object.freeze([...seenToolNames].sort(compareText)),
        }),
      );
    }
    executors.sort((left, right) =>
      compareText(left.definition.name, right.definition.name),
    );
    servers.sort((left, right) => compareText(left.name, right.name));
  } catch (error) {
    const errors = [error];
    await closeConnections(connections, errors);
    if (errors.length === 1) {
      throw error;
    }
    throw new AggregateError(errors, "MCP manager initialization failed.", {
      cause: error,
    });
  }

  let disposePromise: Promise<void> | undefined;
  return {
    executors,
    inventory: Object.freeze({ servers: Object.freeze(servers) }),
    dispose(): Promise<void> {
      disposePromise ??= disposeConnections(connections);
      return disposePromise;
    },
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function disposeConnections(connections: McpClientConnection[]): Promise<void> {
  const errors: unknown[] = [];
  await closeConnections(connections, errors);
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Failed to close MCP connections.");
  }
}

async function closeConnections(
  connections: McpClientConnection[],
  errors: unknown[],
): Promise<void> {
  for (let index = connections.length - 1; index >= 0; index -= 1) {
    const connection = connections[index];
    if (connection === undefined) {
      throw new Error(`Missing MCP connection at index ${index}.`);
    }
    try {
      await connection.close();
    } catch (error) {
      errors.push(error);
    }
  }
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
