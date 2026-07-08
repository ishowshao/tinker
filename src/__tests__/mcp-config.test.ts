import { describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadMcpConfig, parseMcpConfig } from "../mcp/mcp-config";

describe("mcp config", () => {
  test("returns undefined when .mcp.json does not exist", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "tinker-mcp-"));
    expect(await loadMcpConfig(workspaceRoot)).toBeUndefined();
  });

  test("loads a valid stdio server config", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "tinker-mcp-"));
    await writeFile(
      path.join(workspaceRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          playwright: {
            command: "npx",
            args: ["-y", "@playwright/mcp@latest"],
            env: { DEBUG: "1" },
          },
        },
      }),
      "utf8",
    );

    const config = await loadMcpConfig(workspaceRoot);
    expect(config?.servers.size).toBe(1);
    expect(config?.servers.get("playwright")).toEqual({
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      env: { DEBUG: "1" },
      cwd: undefined,
    });
  });

  test("defaults args and env when omitted", () => {
    const config = parseMcpConfig(
      JSON.stringify({ mcpServers: { srv: { command: "bun" } } }),
      "/x/.mcp.json",
    );

    expect(config.servers.get("srv")).toEqual({
      command: "bun",
      args: [],
      env: {},
      cwd: undefined,
    });
  });

  test("accepts a config without mcpServers", () => {
    const config = parseMcpConfig("{}", "/x/.mcp.json");
    expect(config.servers.size).toBe(0);
  });

  test("rejects invalid JSON with the file path in the error", () => {
    expect(() => parseMcpConfig("{nope", "/x/.mcp.json")).toThrow("/x/.mcp.json");
  });

  test("rejects server names containing __", () => {
    expect(() =>
      parseMcpConfig(
        JSON.stringify({ mcpServers: { bad__name: { command: "bun" } } }),
        "/x/.mcp.json",
      ),
    ).toThrow('server "bad__name"');
  });

  test("rejects server names with invalid characters", () => {
    expect(() =>
      parseMcpConfig(
        JSON.stringify({ mcpServers: { "bad name": { command: "bun" } } }),
        "/x/.mcp.json",
      ),
    ).toThrow("invalid name");
  });

  test("rejects a missing command", () => {
    expect(() =>
      parseMcpConfig(JSON.stringify({ mcpServers: { srv: {} } }), "/x/.mcp.json"),
    ).toThrow('"command"');
  });

  test("rejects non-stdio server types", () => {
    expect(() =>
      parseMcpConfig(
        JSON.stringify({
          mcpServers: { srv: { type: "http", url: "https://example.com" } },
        }),
        "/x/.mcp.json",
      ),
    ).toThrow('Only "stdio" servers are supported');
  });

  test("rejects non-string args entries", () => {
    expect(() =>
      parseMcpConfig(
        JSON.stringify({ mcpServers: { srv: { command: "bun", args: [1] } } }),
        "/x/.mcp.json",
      ),
    ).toThrow('"args"');
  });

  test("rejects non-string env values", () => {
    expect(() =>
      parseMcpConfig(
        JSON.stringify({
          mcpServers: { srv: { command: "bun", env: { A: 1 } } },
        }),
        "/x/.mcp.json",
      ),
    ).toThrow('"env"');
  });
});
