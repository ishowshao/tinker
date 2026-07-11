import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../agent/loop";
import type { RuntimeSessionContext } from "../agent/runtime-session";
import type { AgentMessage } from "../agent/types";
import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import type {
  ModelClient,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
} from "../model/model-client";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling } from "../tools/registry";
import { createTestRuntime } from "./test-runtime";

class ScriptedModel implements ModelClient {
  calls = 0;

  async request(
    input: ModelRequestInput,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.calls += 1;

    if (this.calls === 1) {
      return {
        message: {
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
        },
      };
    }

    const toolMessage = input.messages.at(-1) as AgentMessage;
    expect(toolMessage.role).toBe("tool");
    expect(toolMessage.content).toContain("Read succeeded");

    return {
      message: {
        role: "assistant",
        content: "README was read.",
      },
    };
  }
}

class CapturingModel implements ModelClient {
  readonly inputs: ModelRequestInput[] = [];

  async request(input: ModelRequestInput): Promise<ModelRequestOutput> {
    this.inputs.push({
      ...input,
      messages: [...input.messages],
      tools: [...input.tools],
    });

    return {
      message: {
        role: "assistant",
        content: "Second prompt answered.",
      },
    };
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
      const result = await runAgent({
        systemPrompt: "system",
        userPrompt: "Read README.md",
        maxIterations: 4,
        model: new ScriptedModel(),
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
    const initialMessages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "First prompt" },
      { role: "assistant", content: "First prompt answered." },
    ];

    const result = await runAgent({
      systemPrompt: "new system should not be inserted",
      userPrompt: "Second prompt",
      initialMessages,
      maxIterations: 4,
      model,
      tools: tooling.registry,
      toolRuntime: tooling.runtime,
      observationBuilder: new ObservationBuilder(),
      runtimeSession,
      turn,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("completed");
    expect(model.inputs[0]?.messages).toEqual([
      ...initialMessages,
      { role: "user", content: "Second prompt" },
    ]);
    expect(result.messages).toEqual([
      ...initialMessages,
      { role: "user", content: "Second prompt" },
      { role: "assistant", content: "Second prompt answered." },
    ]);
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
