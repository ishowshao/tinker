#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "echo",
      description: "Echo a message back.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "echo") {
    const message = request.params.arguments?.message;
    const callLog = process.env.TINKER_TEST_MCP_CALL_LOG;
    if (callLog !== undefined && callLog !== "") {
      appendFileSync(
        path.resolve(callLog),
        `${JSON.stringify({
          name: request.params.name,
          arguments: request.params.arguments ?? {},
        })}\n`,
        "utf8",
      );
    }
    if (process.env.TINKER_TEST_MCP_RETURN_ROOT === "1") {
      const roots = await server.listRoots();
      return {
        content: [
          {
            type: "text",
            text: `root: ${roots.roots[0]?.uri ?? "<missing>"}`,
          },
        ],
      };
    }
    if (process.env.TINKER_TEST_MCP_RETURN_TMPDIR === "1") {
      return {
        content: [{ type: "text", text: `tmpdir: ${tmpdir()}` }],
      };
    }
    return { content: [{ type: "text", text: `echo: ${String(message)}` }] };
  }

  return {
    content: [{ type: "text", text: `unknown tool: ${request.params.name}` }],
    isError: true,
  };
});

await server.connect(new StdioServerTransport());
