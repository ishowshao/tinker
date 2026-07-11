import { describe, expect, test } from "bun:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentEvent } from "../events/types";
import { StdoutEventPrinter } from "../events/stdout-event-printer";
import { createMcpManager } from "../mcp/mcp-manager";
import {
  createMcpToolExecutor as createMcpToolExecutorBase,
  mcpToolName,
  sanitizeInputSchema,
} from "../mcp/mcp-tool-executor";
import { ObservationBuilder } from "../observation/observation-builder";
import type { ToolCall } from "../agent/types";
import { TurnCancelledError } from "../agent/turn-cancellation";
import type { McpToolRawResult, ToolExecutionContext } from "../tools/types";
import {
  applyAgentEvent,
  createInitialTuiState,
  visibleTimelineItems,
} from "../tui/event-store";
import type { SessionId } from "../ids/runtime-id";
import { createTestRuntime, type TestToolCallInput } from "./test-runtime";

const ECHO_TOOL: Tool = {
  name: "echo",
  description: "Echo a message back.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
};

const testToolContext: ToolExecutionContext = {
  signal: new AbortController().signal,
};
const testRuntime = createTestRuntime();

function createMcpToolExecutor(
  options: Parameters<typeof createMcpToolExecutorBase>[0],
) {
  const tool = createMcpToolExecutorBase(options);
  return {
    ...tool,
    execute: (
      args: unknown,
      call: TestToolCallInput | ToolCall,
      context: ToolExecutionContext = testToolContext,
    ) =>
      tool.execute(
        args,
        "sessionId" in call ? call : testRuntime.toolCall(call),
        context,
      ),
  };
}

async function connectTestClient(options: {
  tools: Tool[];
  onCallTool: (
    name: string,
    args: Record<string, unknown> | undefined,
  ) => CallToolResult | Promise<CallToolResult>;
}): Promise<Client> {
  const server = new Server(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: options.tools }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    options.onCallTool(request.params.name, request.params.arguments),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

function collectingEventSink(): {
  events: AgentEvent[];
  append(e: AgentEvent): Promise<void>;
} {
  const events: AgentEvent[] = [];
  return {
    events,
    async append(event: AgentEvent): Promise<void> {
      events.push(event);
    },
  };
}

describe("mcp tool naming and schema", () => {
  test("mcpToolName prefixes server and tool name", () => {
    expect(mcpToolName("playwright", "browser_click")).toBe(
      "mcp__playwright__browser_click",
    );
  });

  test("sanitizeInputSchema strips $schema and keeps the rest", () => {
    expect(
      sanitizeInputSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { a: { type: "string" } },
      }),
    ).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  test("sanitizeInputSchema replaces non-object schemas", () => {
    expect(sanitizeInputSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(sanitizeInputSchema({ type: "string" })).toEqual({
      type: "object",
      properties: {},
    });
  });
});

describe("mcp tool executor", () => {
  test("propagates cancellation without closing the MCP client", async () => {
    const client = await connectTestClient({
      tools: [ECHO_TOOL],
      onCallTool: () => new Promise<CallToolResult>(() => undefined),
    });
    const executor = createMcpToolExecutor({
      client,
      serverName: "srv",
      tool: ECHO_TOOL,
    });
    const controller = new AbortController();

    const pending = executor.execute(
      { message: "wait" },
      {
        providerToolCallId: "call_1",
        name: "mcp__srv__echo",
        args: { message: "wait" },
      },
      { signal: controller.signal },
    );
    controller.abort(new TurnCancelledError("user"));

    expect(pending).rejects.toBeInstanceOf(TurnCancelledError);
    await client.close();
  });

  test("exposes a prefixed definition with the tool input schema", async () => {
    const client = await connectTestClient({
      tools: [ECHO_TOOL],
      onCallTool: () => ({ content: [] }),
    });

    const executor = createMcpToolExecutor({
      client,
      serverName: "srv",
      tool: ECHO_TOOL,
    });

    expect(executor.definition.name).toBe("mcp__srv__echo");
    expect(executor.definition.description).toBe("Echo a message back.");
    expect(executor.definition.parameters).toEqual(ECHO_TOOL.inputSchema);
    await client.close();
  });

  test("passes arguments through and returns text content", async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const client = await connectTestClient({
      tools: [ECHO_TOOL],
      onCallTool: (_name, args) => {
        receivedArgs = args;
        return { content: [{ type: "text", text: `echo: ${String(args?.message)}` }] };
      },
    });

    const executor = createMcpToolExecutor({
      client,
      serverName: "srv",
      tool: ECHO_TOOL,
    });
    const raw = (await executor.execute(
      { message: "hi" },
      { providerToolCallId: "call_1", name: "mcp__srv__echo", args: { message: "hi" } },
    )) as McpToolRawResult;

    expect(receivedArgs).toEqual({ message: "hi" });
    expect(raw.ok).toBe(true);
    expect(raw.text).toBe("echo: hi");
    expect(raw.serverName).toBe("srv");
    expect(raw.serverToolName).toBe("echo");
    await client.close();
  });

  test("joins multiple text blocks and renders non-text placeholders", async () => {
    const client = await connectTestClient({
      tools: [ECHO_TOOL],
      onCallTool: () => ({
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
          { type: "text", text: "second" },
        ],
      }),
    });

    const executor = createMcpToolExecutor({
      client,
      serverName: "srv",
      tool: ECHO_TOOL,
    });
    const raw = (await executor.execute(
      {},
      { providerToolCallId: "call_1", name: "mcp__srv__echo", args: {} },
    )) as McpToolRawResult;

    expect(raw.text).toBe("first\n[image image/png content omitted]\nsecond");
    expect(raw.contentBlockCount).toBe(3);
    await client.close();
  });

  test("truncates output beyond maxObservationChars", async () => {
    const client = await connectTestClient({
      tools: [ECHO_TOOL],
      onCallTool: () => ({
        content: [{ type: "text", text: "x".repeat(100) }],
      }),
    });

    const executor = createMcpToolExecutor({
      client,
      serverName: "srv",
      tool: ECHO_TOOL,
      maxObservationChars: 10,
    });
    const raw = (await executor.execute(
      {},
      { providerToolCallId: "call_1", name: "mcp__srv__echo", args: {} },
    )) as McpToolRawResult;

    expect(raw.text).toBe("x".repeat(10));
    expect(raw.truncated).toBe(true);
    await client.close();
  });

  test("maps isError results to ok=false", async () => {
    const client = await connectTestClient({
      tools: [ECHO_TOOL],
      onCallTool: () => ({
        content: [{ type: "text", text: "element not found" }],
        isError: true,
      }),
    });

    const executor = createMcpToolExecutor({
      client,
      serverName: "srv",
      tool: ECHO_TOOL,
    });
    const raw = (await executor.execute(
      {},
      { providerToolCallId: "call_1", name: "mcp__srv__echo", args: {} },
    )) as McpToolRawResult;

    expect(raw.ok).toBe(false);
    expect(raw.isError).toBe(true);
    expect(raw.text).toBe("element not found");
    await client.close();
  });

  test("maps transport errors to ok=false with a reason", async () => {
    const client = await connectTestClient({
      tools: [ECHO_TOOL],
      onCallTool: () => {
        throw new Error("boom");
      },
    });

    const executor = createMcpToolExecutor({
      client,
      serverName: "srv",
      tool: ECHO_TOOL,
    });
    const raw = (await executor.execute(
      {},
      { providerToolCallId: "call_1", name: "mcp__srv__echo", args: {} },
    )) as McpToolRawResult;

    expect(raw.ok).toBe(false);
    expect(raw.error).toContain("boom");
    await client.close();
  });

  test("rejects non-object arguments without calling the server", async () => {
    const client = await connectTestClient({
      tools: [ECHO_TOOL],
      onCallTool: () => {
        throw new Error("should not be called");
      },
    });

    const executor = createMcpToolExecutor({
      client,
      serverName: "srv",
      tool: ECHO_TOOL,
    });
    const raw = (await executor.execute("nope", {
      providerToolCallId: "call_1",
      name: "mcp__srv__echo",
      args: "nope",
    })) as McpToolRawResult;

    expect(raw.ok).toBe(false);
    expect(raw.error).toContain("must be an object");
    await client.close();
  });
});

describe("mcp manager", () => {
  test("registers tools from good servers and reports failed servers", async () => {
    const client = await connectTestClient({
      tools: [ECHO_TOOL],
      onCallTool: () => ({ content: [] }),
    });
    let closed = false;
    const sink = collectingEventSink();
    const runtimeSession = createTestRuntime(sink).runtimeSession;

    const manager = await createMcpManager({
      config: {
        servers: new Map([
          ["bad", { command: "nope", args: [], env: {} }],
          ["good", { command: "nope", args: [], env: {} }],
        ]),
      },
      runtimeSession,
      clientFactory: async (serverName) => {
        if (serverName === "bad") {
          throw new Error("spawn failed");
        }

        return {
          client,
          close: async () => {
            closed = true;
            await client.close();
          },
        };
      },
    });

    expect(manager.executors.map((executor) => executor.definition.name)).toEqual([
      "mcp__good__echo",
    ]);
    expect(
      sink.events.map((event) => ({ type: event.type, data: event.data })),
    ).toEqual([
      {
        type: "mcp.server.failed",
        data: { serverName: "bad", error: "spawn failed" },
      },
      {
        type: "mcp.server.connected",
        data: { serverName: "good", toolCount: 1 },
      },
    ]);

    await manager.dispose();
    expect(closed).toBe(true);
  });

  test(
    "connects to a real stdio server",
    async () => {
      const sink = collectingEventSink();
      const runtimeSession = createTestRuntime(sink).runtimeSession;
      const fixturePath = path.join(import.meta.dir, "fixtures", "fake-mcp-server.ts");

      const manager = await createMcpManager({
        config: {
          servers: new Map([
            ["fixture", { command: process.execPath, args: [fixturePath], env: {} }],
          ]),
        },
        runtimeSession,
      });

      try {
        expect(
          sink.events.map((event) => ({ type: event.type, data: event.data })),
        ).toEqual([
          {
            type: "mcp.server.connected",
            data: { serverName: "fixture", toolCount: 1 },
          },
        ]);

        const executor = manager.executors[0];
        expect(executor?.definition.name).toBe("mcp__fixture__echo");

        const raw = (await executor?.execute(
          { message: "hi" },
          testRuntime.toolCall({
            providerToolCallId: "call_1",
            name: "mcp__fixture__echo",
            args: { message: "hi" },
          }),
          testToolContext,
        )) as McpToolRawResult;
        expect(raw.ok).toBe(true);
        expect(raw.text).toBe("echo: hi");
      } finally {
        await manager.dispose();
      }
    },
    { timeout: 20_000 },
  );
});

describe("mcp observation", () => {
  const builder = new ObservationBuilder();
  const call = testRuntime.toolCall({
    providerToolCallId: "call_1",
    name: "mcp__srv__echo",
    args: {},
  });
  const base = {
    kind: "mcp" as const,
    toolName: "mcp__srv__echo",
    serverName: "srv",
    serverToolName: "echo",
  };

  test("renders text content on success", () => {
    const observation = builder.build({
      call,
      raw: { ok: true, ...base, isError: false, text: "hello", truncated: false },
    });
    expect(observation.content).toBe("hello");
  });

  test("appends a truncation notice", () => {
    const observation = builder.build({
      call,
      raw: { ok: true, ...base, isError: false, text: "hello", truncated: true },
    });
    expect(observation.content).toContain("[Output truncated to 5 characters.]");
  });

  test("renders server-reported errors", () => {
    const observation = builder.build({
      call,
      raw: { ok: false, ...base, isError: true, text: "element not found" },
    });
    expect(observation.content).toBe(
      "mcp__srv__echo failed (server reported error):\nelement not found",
    );
  });

  test("renders transport failures", () => {
    const observation = builder.build({
      call,
      raw: { ok: false, ...base, error: "timeout" },
    });
    expect(observation.content).toBe("mcp__srv__echo failed: timeout");
  });

  test("renders a placeholder when there is no text content", () => {
    const observation = builder.build({
      call,
      raw: { ok: true, ...base, isError: false, text: "", contentBlockCount: 1 },
    });
    expect(observation.content).toBe("(no text content, 1 content block)");
  });
});

describe("mcp events in tui and stdout", () => {
  test("tui event store renders mcp server events", () => {
    let state = createInitialTuiState({
      sessionId: "session-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    state = applyAgentEvent(state, {
      type: "mcp.server.connected",
      sessionId: "session-1" as SessionId,
      eventSequence: 1,
      timestamp: "2026-07-11T00:00:00.000Z",
      data: { serverName: "playwright", toolCount: 21 },
    });
    expect(visibleTimelineItems(state).at(-1)?.text).toBe(
      "mcp playwright connected -> 21 tools",
    );
    expect(visibleTimelineItems(state).at(-1)?.status).toBe("info");

    state = applyAgentEvent(state, {
      type: "mcp.server.failed",
      sessionId: "session-1" as SessionId,
      eventSequence: 2,
      timestamp: "2026-07-11T00:00:01.000Z",
      data: { serverName: "chrome", error: "spawn failed" },
    });
    expect(visibleTimelineItems(state).at(-1)?.text).toBe(
      "mcp chrome failed -> spawn failed",
    );
    expect(visibleTimelineItems(state).at(-1)?.status).toBe("failed");
  });

  test("stdout event printer prints mcp server events", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const printer = new StdoutEventPrinter(
      { write: (chunk: string) => out.push(chunk) },
      { write: (chunk: string) => err.push(chunk) },
    );

    await printer.append({
      type: "mcp.server.connected",
      sessionId: "session-1" as SessionId,
      eventSequence: 1,
      timestamp: "2026-07-11T00:00:00.000Z",
      data: { serverName: "playwright", toolCount: 21 },
    });
    await printer.append({
      type: "mcp.server.failed",
      sessionId: "session-1" as SessionId,
      eventSequence: 2,
      timestamp: "2026-07-11T00:00:01.000Z",
      data: { serverName: "chrome", error: "spawn failed" },
    });

    expect(out.join("")).toBe("mcp.server.connected name=playwright tools=21\n");
    expect(err.join("")).toBe("mcp.server.failed name=chrome error=spawn failed\n");
  });
});
