import path from "node:path";
import { readFile } from "node:fs/promises";

export type McpServerConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
};

export type McpConfig = {
  servers: Map<string, McpServerConfig>;
};

const SERVER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export function mcpConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".mcp.json");
}

export async function loadMcpConfig(
  workspaceRoot: string,
): Promise<McpConfig | undefined> {
  const configPath = mcpConfigPath(workspaceRoot);
  let raw: string;

  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }

    throw new Error(
      `Failed to read MCP config at ${configPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return parseMcpConfig(raw, configPath);
}

export function parseMcpConfig(raw: string, sourcePath: string): McpConfig {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in MCP config ${sourcePath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (!isRecord(json)) {
    throw new Error(`MCP config ${sourcePath} must be a JSON object.`);
  }

  const mcpServers = json.mcpServers;

  if (mcpServers === undefined) {
    return { servers: new Map() };
  }

  if (!isRecord(mcpServers)) {
    throw new Error(`MCP config ${sourcePath}: "mcpServers" must be an object.`);
  }

  const servers = new Map<string, McpServerConfig>();

  for (const [serverName, serverValue] of Object.entries(mcpServers)) {
    servers.set(serverName, parseServerConfig(serverName, serverValue, sourcePath));
  }

  return { servers };
}

function parseServerConfig(
  serverName: string,
  value: unknown,
  sourcePath: string,
): McpServerConfig {
  const where = `MCP config ${sourcePath}: server "${serverName}"`;

  if (!SERVER_NAME_PATTERN.test(serverName) || serverName.includes("__")) {
    throw new Error(
      `${where} has an invalid name. Server names must match ${SERVER_NAME_PATTERN} and must not contain "__".`,
    );
  }

  if (!isRecord(value)) {
    throw new Error(`${where} must be an object.`);
  }

  if (value.type !== undefined && value.type !== "stdio") {
    throw new Error(
      `${where} has unsupported type ${JSON.stringify(value.type)}. Only "stdio" servers are supported.`,
    );
  }

  if (typeof value.command !== "string" || value.command.trim() === "") {
    throw new Error(`${where} requires a non-empty string "command".`);
  }

  const args = value.args ?? [];

  if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) {
    throw new Error(`${where}: "args" must be an array of strings.`);
  }

  const env = value.env ?? {};

  if (!isRecord(env) || !Object.values(env).every((item) => typeof item === "string")) {
    throw new Error(`${where}: "env" must be an object mapping strings to strings.`);
  }

  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    throw new Error(`${where}: "cwd" must be a string.`);
  }

  return {
    command: value.command,
    args,
    env: env as Record<string, string>,
    cwd: value.cwd,
  };
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
