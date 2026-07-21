import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ChromeBridgeError } from "../src/errors";
import {
  createTinkerChromeMcpServer,
  type ChromeBridgeClient,
} from "../src/mcp-server";
import type { BridgeMethod } from "../src/protocol-v1";

describe("Tinker Chrome MCP server", () => {
  test("lists a fixed tool surface while Chrome is offline", async () => {
    const client = await connectClient({
      request: () =>
        Promise.reject(
          new ChromeBridgeError({
            code: "PLUGIN_NOT_CONNECTED",
            message: "offline",
            retryable: true,
            outcome: "not_started",
          }),
        ),
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "open_page",
      "get_page_summary",
    ]);

    const result = await client.callTool({
      name: "open_page",
      arguments: { url: "https://example.com" },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("code=PLUGIN_NOT_CONNECTED");
    await client.close();
  });

  test("maps bridge page results into bounded MCP text", async () => {
    const bridge: ChromeBridgeClient = {
      request(method: BridgeMethod, params: unknown): Promise<unknown> {
        const record = params as Record<string, string>;
        if (method === "page.open") {
          return Promise.resolve({
            pageId: record.pageId,
            url: "https://example.com/",
            title: "Example Domain",
            loadState: "complete",
          });
        }
        return Promise.resolve({
          schemaVersion: 1,
          pageId: record.pageId,
          url: "https://example.com/",
          title: "Example Domain",
          headings: [{ level: 1, text: "Example Domain" }],
          content: "This domain is for use in examples.",
          truncated: false,
        });
      },
    };
    const client = await connectClient(bridge);
    const opened = await client.callTool({
      name: "open_page",
      arguments: { url: "https://example.com" },
    });
    const pageId = /pageId=([^\n]+)/.exec(resultText(opened))?.[1];
    expect(pageId).toBeString();

    const summary = await client.callTool({
      name: "get_page_summary",
      arguments: { pageId },
    });
    expect(resultText(summary)).toContain("title=Example Domain");
    expect(resultText(summary)).toContain("This domain is for use in examples.");
    await client.close();
  });

  test("rejects non-HTTP URLs before calling the bridge", async () => {
    let called = false;
    const client = await connectClient({
      request: () => {
        called = true;
        return Promise.resolve({});
      },
    });
    const result = await client.callTool({
      name: "open_page",
      arguments: { url: "file:///tmp/private" },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("code=INVALID_URL");
    expect(called).toBe(false);
    await client.close();
  });
});

async function connectClient(bridge: ChromeBridgeClient): Promise<Client> {
  const server = createTinkerChromeMcpServer(bridge);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

function resultText(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("Expected an MCP content result.");
  }
  const block: unknown = result.content[0];
  if (typeof block !== "object" || block === null || !("type" in block)) {
    throw new Error("Expected an MCP content block.");
  }
  if (block?.type !== "text") {
    throw new Error("Expected a text tool result.");
  }
  if (!("text" in block) || typeof block.text !== "string") {
    throw new Error("Expected text content.");
  }
  return block.text;
}
