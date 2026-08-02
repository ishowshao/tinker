import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ChromeBridgeError } from "../src/errors";
import {
  createTinkerChromeMcpServer,
  type ChromeBridgeClient,
} from "../src/mcp-server";
import type { BridgeMethodV2 } from "../src/protocol-v2";

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
      "take_snapshot",
      "click",
      "fill",
      "fill_form",
      "drag",
      "press_key",
      "type_text",
      "wait_for",
      "scroll",
      "hover",
      "resize_page",
      "emulate",
      "upload_file",
      "list_pages",
      "navigate_page",
      "close_page",
      "handle_dialog",
      "list_console_messages",
      "get_console_message",
      "list_network_requests",
      "get_network_request",
    ]);

    const result = await client.callTool({
      name: "open_page",
      arguments: { url: "https://example.com" },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("code=PLUGIN_NOT_CONNECTED");
    expect(resultText(result)).toContain("retryable=true");
    expect(resultText(result)).toContain("outcome=not_started");
    await client.close();
  });

  test("maps bridge page results into bounded MCP text", async () => {
    const bridge: ChromeBridgeClient = {
      request(method: BridgeMethodV2, params: unknown): Promise<unknown> {
        const record = params as Record<string, string>;
        if (method === "page.open") {
          return Promise.resolve({
            schemaVersion: 2,
            pageId: record.pageId,
            url: "https://example.com/",
            title: "Example Domain",
            loadState: "complete",
          });
        }
        return Promise.resolve({
          schemaVersion: 2,
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

  test("maps snapshots and actions through strict v2 params", async () => {
    const pageId = crypto.randomUUID();
    const calls: Array<{ method: BridgeMethodV2; params: unknown }> = [];
    const bridge: ChromeBridgeClient = {
      request(method, params): Promise<unknown> {
        calls.push({ method, params });
        if (method === "page.snapshot") {
          return Promise.resolve({
            schemaVersion: 2,
            pageId,
            url: "https://example.com/",
            title: "Example Domain",
            verbose: false,
            snapshot: 'uid=1_0 RootWebArea "Example Domain"\n',
            truncated: false,
          });
        }
        if (method === "page.wait_for") {
          return Promise.resolve({
            schemaVersion: 2,
            pageId,
            matchedText: "Ready",
            url: "https://example.com/",
          });
        }
        const action = method.slice("page.".length);
        return Promise.resolve({
          schemaVersion: 2,
          pageId,
          action,
          performed: true,
          url: "https://example.com/",
          navigatedToUrl: null,
          dialog: null,
        });
      },
    };
    const client = await connectClient(bridge);
    const snapshot = await client.callTool({
      name: "take_snapshot",
      arguments: { pageId },
    });
    expect(resultText(snapshot)).toContain("uid=1_0 RootWebArea");

    const callsToMake = [
      ["click", { pageId, uid: "1_1" }],
      ["fill", { pageId, uid: "1_2", value: "hello" }],
      ["press_key", { pageId, key: "Enter" }],
      ["type_text", { pageId, text: "world" }],
      ["scroll", { pageId, direction: "down" }],
      ["hover", { pageId, uid: "1_3" }],
    ] as const;
    for (const [name, args] of callsToMake) {
      const result = await client.callTool({ name, arguments: args });
      expect(resultText(result)).toContain("outcome=performed");
    }
    const waited = await client.callTool({
      name: "wait_for",
      arguments: { pageId, text: ["Ready"] },
    });
    expect(resultText(waited)).toContain("matchedText=Ready");
    expect(calls.map((call) => call.method)).toEqual([
      "page.snapshot",
      "page.click",
      "page.fill",
      "page.press_key",
      "page.type_text",
      "page.scroll",
      "page.hover",
      "page.wait_for",
    ]);
    await client.close();
  });

  test("maps form, drag, responsive, emulation, upload, and snapshot options", async () => {
    const pageId = crypto.randomUUID();
    const calls: Array<{ method: BridgeMethodV2; params: unknown }> = [];
    const bridge: ChromeBridgeClient = {
      request(method, params): Promise<unknown> {
        calls.push({ method, params });
        if (method === "page.snapshot") {
          return Promise.resolve({
            schemaVersion: 2,
            pageId,
            url: "https://example.com/",
            title: "Example Domain",
            verbose: false,
            snapshot: 'uid=1_9 button "Done"',
            truncated: false,
          });
        }
        const action =
          method === "page.resize" ? "resize_page" : method.slice("page.".length);
        return Promise.resolve({
          schemaVersion: 2,
          pageId,
          action,
          performed: true,
          url: "https://example.com/",
          navigatedToUrl: null,
          dialog: null,
        });
      },
    };
    const uploadDirectory = await mkdtemp(path.join(tmpdir(), "tinker-upload-test-"));
    const uploadPath = path.join(uploadDirectory, "fixture.txt");
    await writeFile(uploadPath, "upload fixture", "utf8");
    const canonicalUploadPath = await realpath(uploadPath);
    const client = await connectClient(bridge);
    try {
      const clicked = await client.callTool({
        name: "click",
        arguments: {
          pageId,
          uid: "1_1",
          doubleClick: true,
          includeSnapshot: true,
        },
      });
      expect(resultText(clicked)).toContain("postActionSnapshot=included");
      expect(resultText(clicked)).toContain('uid=1_9 button "Done"');

      await client.callTool({
        name: "fill_form",
        arguments: {
          pageId,
          elements: [
            { uid: "1_2", value: "Ada" },
            { uid: "1_3", value: "true" },
          ],
        },
      });
      await client.callTool({
        name: "drag",
        arguments: { pageId, fromUid: "1_4", toUid: "1_5" },
      });
      await client.callTool({
        name: "resize_page",
        arguments: { pageId, width: 800, height: 600 },
      });
      await client.callTool({
        name: "emulate",
        arguments: {
          pageId,
          networkConditions: "Fast 3G",
          cpuThrottlingRate: 2,
          geolocation: "1.25,103.8",
          userAgent: "Tinker Chrome Test",
          colorScheme: "dark",
          viewport: "390x844x3,mobile,touch",
          extraHttpHeaders: '{"X-Tinker-Test":"yes"}',
        },
      });
      await client.callTool({
        name: "upload_file",
        arguments: { pageId, uid: "1_6", filePath: uploadPath },
      });

      expect(calls).toContainEqual({
        method: "page.click",
        params: { pageId, uid: "1_1", doubleClick: true },
      });
      expect(calls).toContainEqual({
        method: "page.emulate",
        params: {
          pageId,
          networkConditions: "Fast 3G",
          cpuThrottlingRate: 2,
          geolocation: { latitude: 1.25, longitude: 103.8 },
          userAgent: "Tinker Chrome Test",
          colorScheme: "dark",
          viewport: {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
            isLandscape: false,
          },
          extraHttpHeaders: { "X-Tinker-Test": "yes" },
        },
      });
      expect(calls).toContainEqual({
        method: "page.upload_file",
        params: { pageId, uid: "1_6", filePath: canonicalUploadPath },
      });
    } finally {
      await client.close();
      await unlink(uploadPath);
      await rmdir(uploadDirectory);
    }
  });

  test("preserves a performed action when its optional snapshot is unavailable", async () => {
    const pageId = crypto.randomUUID();
    let snapshotCalls = 0;
    const client = await connectClient({
      request(method): Promise<unknown> {
        if (method === "page.snapshot") {
          snapshotCalls += 1;
          return Promise.reject(
            new ChromeBridgeError({
              code: "SNAPSHOT_FAILED",
              message: "snapshot unavailable",
              retryable: true,
              outcome: "not_started",
            }),
          );
        }
        const action = method === "page.click" ? "click" : "fill";
        return Promise.resolve({
          schemaVersion: 2,
          pageId,
          action,
          performed: true,
          url: "https://example.com/",
          navigatedToUrl: null,
          dialog:
            method === "page.click"
              ? { type: "confirm", message: "Continue?", defaultValue: "" }
              : null,
        });
      },
    });
    try {
      const unavailable = await client.callTool({
        name: "fill",
        arguments: {
          pageId,
          uid: "1_1",
          value: "Ada",
          includeSnapshot: true,
        },
      });
      expect(unavailable.isError).not.toBe(true);
      expect(resultText(unavailable)).toContain("outcome=performed");
      expect(resultText(unavailable)).toContain("postActionSnapshot=unavailable");
      expect(resultText(unavailable)).toContain("snapshotErrorCode=SNAPSHOT_FAILED");

      const blocked = await client.callTool({
        name: "click",
        arguments: { pageId, uid: "1_2", includeSnapshot: true },
      });
      expect(resultText(blocked)).toContain("postActionSnapshot=blocked_by_dialog");
      expect(snapshotCalls).toBe(1);
    } finally {
      await client.close();
    }
  });

  test("maps page lifecycle and debug tools through normalized strict params", async () => {
    const pageId = crypto.randomUUID();
    const calls: Array<{ method: BridgeMethodV2; params: unknown }> = [];
    const bridge: ChromeBridgeClient = {
      request(method, params): Promise<unknown> {
        calls.push({ method, params });
        switch (method) {
          case "page.list":
            return Promise.resolve({
              schemaVersion: 2,
              pages: [
                {
                  pageId,
                  url: "https://example.com/",
                  title: "Example Domain",
                  loadState: "complete",
                  active: true,
                },
              ],
              truncated: false,
            });
          case "page.navigate":
          case "page.handle_dialog":
            return Promise.resolve({
              schemaVersion: 2,
              pageId,
              action: method === "page.navigate" ? "navigate_page" : "handle_dialog",
              performed: true,
              url: "https://example.com/next",
              navigatedToUrl:
                method === "page.navigate" ? "https://example.com/next" : null,
              dialog: null,
            });
          case "page.close":
            return Promise.resolve({ schemaVersion: 2, pageId, closed: true });
          case "page.console.list":
            return Promise.resolve({
              schemaVersion: 2,
              pageId,
              pageIdx: 0,
              pageSize: 50,
              totalMessages: 1,
              totalPages: 1,
              output: "msgid=1 [log] ready (1 args)",
              truncated: false,
            });
          case "page.console.get":
            return Promise.resolve({
              schemaVersion: 2,
              pageId,
              msgid: 1,
              output: "ID: 1\nMessage: log> ready",
              truncated: false,
            });
          case "page.network.list":
            return Promise.resolve({
              schemaVersion: 2,
              pageId,
              pageIdx: 0,
              pageSize: 50,
              totalRequests: 1,
              totalPages: 1,
              output: "reqid=2 GET https://example.com/api [200] type=fetch",
              truncated: false,
            });
          case "page.network.get":
            return Promise.resolve({
              schemaVersion: 2,
              pageId,
              reqid: 2,
              output: "## Request https://example.com/api\nStatus: 200",
              truncated: false,
            });
          default:
            throw new Error(`Unexpected method ${method}`);
        }
      },
    };
    const client = await connectClient(bridge);

    expect(resultText(await client.callTool({ name: "list_pages" }))).toContain(
      `pageId=${pageId}`,
    );
    expect(
      resultText(
        await client.callTool({
          name: "navigate_page",
          arguments: { pageId, type: "url", url: "https://example.com/next" },
        }),
      ),
    ).toContain("action=navigate_page");
    expect(
      resultText(
        await client.callTool({
          name: "handle_dialog",
          arguments: { pageId, action: "accept" },
        }),
      ),
    ).toContain("action=handle_dialog");
    expect(
      resultText(
        await client.callTool({ name: "list_console_messages", arguments: { pageId } }),
      ),
    ).toContain("msgid=1");
    expect(
      resultText(
        await client.callTool({
          name: "get_console_message",
          arguments: { pageId, msgid: 1 },
        }),
      ),
    ).toContain("Message: log> ready");
    expect(
      resultText(
        await client.callTool({ name: "list_network_requests", arguments: { pageId } }),
      ),
    ).toContain("reqid=2");
    expect(
      resultText(
        await client.callTool({
          name: "get_network_request",
          arguments: { pageId, reqid: 2 },
        }),
      ),
    ).toContain("Status: 200");
    expect(
      resultText(await client.callTool({ name: "close_page", arguments: { pageId } })),
    ).toContain("outcome=performed");

    expect(calls).toEqual([
      { method: "page.list", params: {} },
      {
        method: "page.navigate",
        params: {
          pageId,
          type: "url",
          url: "https://example.com/next",
          ignoreCache: false,
          handleBeforeUnload: "accept",
        },
      },
      {
        method: "page.handle_dialog",
        params: { pageId, action: "accept", promptText: null },
      },
      {
        method: "page.console.list",
        params: {
          pageId,
          pageIdx: 0,
          pageSize: 50,
          types: [],
          includePreservedMessages: false,
        },
      },
      { method: "page.console.get", params: { pageId, msgid: 1 } },
      {
        method: "page.network.list",
        params: {
          pageId,
          pageIdx: 0,
          pageSize: 50,
          resourceTypes: [],
          includePreservedRequests: false,
        },
      },
      { method: "page.network.get", params: { pageId, reqid: 2 } },
      { method: "page.close", params: { pageId } },
    ]);
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
