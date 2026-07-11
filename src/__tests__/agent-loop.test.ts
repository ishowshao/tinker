import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../agent/loop";
import type { RuntimeSessionContext } from "../agent/runtime-session";
import { InMemorySessionConversation } from "../agent/session-conversation";
import type { AgentMessage } from "../agent/types";
import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import type {
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling } from "../tools/registry";
import {
  createTestContextMeter,
  createTestRuntime,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

class ScriptedModel extends TestModelClient {
  calls = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.calls += 1;

    if (this.calls === 1) {
      return testModelOutput(prepared, {
        role: "assistant",
        content: "I will read README first.",
        toolCalls: [
          {
            ...requireRuntime(options).createToolCall(requireIteration(options), 1),
            providerToolCallId: "provider-call-1",
            name: "Read",
            args: { file_path: "README.md" },
          },
        ],
      });
    }

    const toolMessage = input.messages.at(-1) as AgentMessage;
    expect(toolMessage.role).toBe("tool");
    expect(toolMessage.content).toContain("Read succeeded");

    return testModelOutput(prepared, {
      role: "assistant",
      content: "README was read.",
    });
  }
}

class CapturingModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push({
      ...input,
      messages: [...input.messages],
      tools: [...input.tools],
    });

    return testModelOutput(prepared, {
      role: "assistant",
      content: "Second prompt answered.",
    });
  }
}

class ArrayEventSink implements EventSink {
  readonly events: AgentEvent[] = [];

  async append(event: AgentEvent): Promise<void> {
    this.events.push(event);
  }
}

describe("runAgent", () => {
  test("runs assistant tool call observation final-answer loop", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-agent-"));

    try {
      await writeFile(path.join(workspace, "README.md"), "# Tinker\n", "utf8");

      const events = new ArrayEventSink();
      const identity = createTestRuntime(events);
      const runtimeSession = identity.runtimeSession;
      const turn = identity.turn;
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        runtimeSession,
      });
      const conversation = new InMemorySessionConversation("system");
      const pendingConversation = conversation.beginTurn("Read README.md");
      const result = await runAgent({
        conversation: pendingConversation.agent,
        maxIterations: 4,
        model: new ScriptedModel(),
        contextMeter: createTestContextMeter(),
        tools: tooling.registry,
        toolRuntime: tooling.runtime,
        observationBuilder: new ObservationBuilder(),
        runtimeSession,
        turn,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe("completed");
      expect(result.status === "completed" ? result.finalText : "").toBe(
        "README was read.",
      );
      const progressEvent = events.events.find(
        (event) => event.type === "assistant.progress",
      );
      expect(progressEvent).toMatchObject({
        type: "assistant.progress",
        data: { content: "I will read README first." },
      });
      expect(events.events.map((event) => event.type)).toContain("tool.observation");
      expect(events.events.map((event) => event.type)).toContain(
        "model.request.finished",
      );
      pendingConversation.commit();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("continues from initial messages when provided", async () => {
    const events = new ArrayEventSink();
    const identity = createTestRuntime(events);
    const runtimeSession = identity.runtimeSession;
    const turn = identity.turn;
    const tooling = createDefaultTooling({
      workspaceRoot: process.cwd(),
      runtimeSession,
    });
    const model = new CapturingModel();
    const conversation = new InMemorySessionConversation("system");
    const firstTurn = conversation.beginTurn("First prompt");
    firstTurn.agent.appendAssistant({
      role: "assistant",
      content: "First prompt answered.",
    });
    firstTurn.commit();
    const initialMessages: AgentMessage[] = conversation.snapshot();
    const secondTurn = conversation.beginTurn("Second prompt");

    const result = await runAgent({
      conversation: secondTurn.agent,
      maxIterations: 4,
      model,
      contextMeter: createTestContextMeter(),
      tools: tooling.registry,
      toolRuntime: tooling.runtime,
      observationBuilder: new ObservationBuilder(),
      runtimeSession,
      turn,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("completed");
    expect(events.events.map((event) => event.type)).toEqual([
      "agent.iteration.started",
      "context.usage.updated",
      "model.request.started",
      "model.request.finished",
      "context.usage.updated",
      "agent.iteration.finished",
    ]);
    expect(
      events.events
        .filter((event) => event.type === "context.usage.updated")
        .map((event) => event.data.phase),
    ).toEqual(["preflight", "measured"]);
    expect(model.inputs[0]?.messages).toEqual([
      ...initialMessages,
      { role: "user", content: "Second prompt" },
    ]);
    secondTurn.commit();
    expect(conversation.snapshot()).toEqual([
      ...initialMessages,
      { role: "user", content: "Second prompt" },
      { role: "assistant", content: "Second prompt answered." },
    ]);
    expect(result).not.toHaveProperty("messages");
  });
});

function requireRuntime(options: ModelRequestOptions): RuntimeSessionContext {
  if (options.identity === undefined) {
    throw new Error("Expected model request identity.");
  }
  return options.identity.runtimeSession;
}

function requireIteration(options: ModelRequestOptions) {
  if (options.identity === undefined) {
    throw new Error("Expected model request identity.");
  }
  return options.identity.iteration;
}
