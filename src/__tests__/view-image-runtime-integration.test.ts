import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  createRuntimeSession,
  type CreateRuntimeSessionInput,
} from "../agent/runtime-session";
import type { AgentEvent } from "../events/types";
import { runtimeIdFactory } from "../ids/runtime-id";
import { OpenAIResponsesModelClient } from "../model/openai-responses-model-client";
import { TEST_CONTEXT_BUDGET, TEST_CONTEXT_PROFILE } from "./test-runtime";

describe("ViewImage runtime integration", () => {
  test("executes, persists, replays, and presents a Responses image tool result safely", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-view-runtime-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const events: AgentEvent[] = [];
    const bodies: Record<string, unknown>[] = [];
    let session: Awaited<ReturnType<typeof createRuntimeSession>> | undefined;
    try {
      await writeFile(
        path.join(workspace, "runtime-fixture.png"),
        await sharp({
          create: {
            width: 40,
            height: 24,
            channels: 3,
            background: { r: 230, g: 180, b: 20 },
          },
        })
          .png()
          .toBuffer(),
      );
      const client = new OpenAIResponsesModelClient({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
        model: "test-model",
        profileName: "responses-image-tools",
        contextBudget: TEST_CONTEXT_BUDGET,
        inputModalities: ["text", "image"],
        toolResultModalities: ["text", "image"],
        stream: false,
        fetch: stubFetch(async (_input, init) => {
          if (typeof init?.body !== "string") {
            throw new Error("Expected a JSON request body.");
          }
          const body = JSON.parse(init.body) as Record<string, unknown>;
          bodies.push(body);
          if (bodies.length === 1) {
            return Response.json(
              responsesPayload([
                {
                  type: "function_call",
                  id: "fc_runtime_view",
                  call_id: "provider-runtime-view",
                  name: "ViewImage",
                  arguments: '{"file_path":"runtime-fixture.png"}',
                  status: "completed",
                },
              ]),
            );
          }
          return Response.json(
            responsesPayload([
              {
                type: "message",
                id: `msg_${bodies.length}`,
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text:
                      bodies.length === 2
                        ? "VIEW_IMAGE_RUNTIME_OK"
                        : "VIEW_IMAGE_REPLAY_OK",
                    annotations: [],
                  },
                ],
              },
            ]),
          );
        }),
      });
      session = await createRuntimeSession(
        runtimeInput(workspace, sessionId, client, events),
        { loadMcpConfig: async () => undefined },
      );

      const first = await session.executeTurn({
        userMessage: { role: "user", content: "inspect runtime-fixture.png" },
        signal: new AbortController().signal,
      });
      expect(first).toMatchObject({
        status: "completed",
        finalText: "VIEW_IMAGE_RUNTIME_OK",
      });
      expect(bodies).toHaveLength(2);
      expect(JSON.stringify(bodies[0])).toContain('"name":"ViewImage"');
      const imageOutput = findViewImageOutput(bodies[1]);
      expect(imageOutput).toMatchObject({
        type: "function_call_output",
        call_id: "provider-runtime-view",
      });
      const output = imageOutput.output;
      if (!Array.isArray(output)) {
        throw new Error("ViewImage function output must be a content list.");
      }
      expect(output[0]).toMatchObject({ type: "input_text" });
      expect((output[0] as { text?: unknown }).text).toContain("Viewed image");
      expect(output[1]).toMatchObject({ type: "input_image", detail: "auto" });
      expect((output[1] as { image_url?: unknown }).image_url).toMatch(
        /^data:image\/png;base64,/,
      );

      const followUp = await session.executeTurn({
        userMessage: { role: "user", content: "repeat the runtime anchor" },
        signal: new AbortController().signal,
      });
      expect(followUp).toMatchObject({
        status: "completed",
        finalText: "VIEW_IMAGE_REPLAY_OK",
      });
      expect(bodies).toHaveLength(3);
      expect(findViewImageOutput(bodies[2])).toMatchObject({
        call_id: "provider-runtime-view",
        output: [{ type: "input_text" }, { type: "input_image", detail: "auto" }],
      });

      const observationEvent = events.find(
        (event) => event.type === "tool.observation",
      );
      expect(observationEvent?.data.observation.content).toMatchObject([
        { type: "text" },
        { type: "image", asset: { mimeType: "image/png", width: 40, height: 24 } },
      ]);
      expect(JSON.stringify(events)).not.toContain("data:image");
      expect(JSON.stringify(events)).not.toContain("base64");

      const database = new Database(
        path.join(workspace, ".tinker", "sessions", sessionId, "session.sqlite"),
        { readonly: true },
      );
      const canonicalText = JSON.stringify({
        messages: database.query("SELECT content FROM messages").all(),
        results: database.query("SELECT raw_json FROM tool_results").all(),
        blocks: database
          .query("SELECT kind, text_content, asset_id FROM tool_message_content_blocks")
          .all(),
      });
      expect(canonicalText).not.toContain("data:image");
      expect(canonicalText).not.toContain("base64");
      expect(
        database.query("SELECT COUNT(*) AS count FROM context_measurement_state").get(),
      ).toEqual({ count: 1 });
      database.close();

      const observationsPath = path.join(
        workspace,
        ".tinker",
        "sessions",
        sessionId,
        "observations.md",
      );
      const observationLog = await readFile(observationsPath, "utf8").catch(() => "");
      expect(observationLog).not.toContain("data:image");
      expect(observationLog).not.toContain("base64");
    } finally {
      await session?.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });
});

function runtimeInput(
  workspaceRoot: string,
  sessionId: ReturnType<typeof runtimeIdFactory.createSessionId>,
  modelClient: OpenAIResponsesModelClient,
  events: AgentEvent[],
): CreateRuntimeSessionInput {
  return {
    selection: { mode: "new", sessionId },
    workspaceRoot,
    modelName: "test-model",
    profileName: "responses-image-tools",
    maxIterations: 3,
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    systemPrompt: "system",
    modelClient,
    presentationSinks: [
      {
        async append(event: AgentEvent) {
          events.push(event);
        },
      },
    ],
    persistence: false,
  };
}

function findViewImageOutput(body: Record<string, unknown>): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input)) {
    throw new Error("Responses request has no input array.");
  }
  const output = input.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>).type === "function_call_output" &&
      (item as Record<string, unknown>).call_id === "provider-runtime-view",
  );
  if (output === undefined) {
    throw new Error("Responses request did not replay the ViewImage output.");
  }
  return output;
}

function responsesPayload(output: readonly unknown[]) {
  return {
    id: `resp_${runtimeIdFactory.createMessageId()}`,
    object: "response",
    status: "completed",
    incomplete_details: null,
    output,
    usage: {
      input_tokens: 600,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 620,
    },
  };
}

function stubFetch(
  implementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(implementation, { preconnect() {} });
}
