import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../agent/loop";
import type { AgentMessage } from "../agent/types";
import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import type {
  ModelClient,
  ModelStepInput,
  ModelStepOutput,
} from "../model/model-client";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling } from "../tools/registry";

class ScriptedModel implements ModelClient {
  calls = 0;

  async step(input: ModelStepInput): Promise<ModelStepOutput> {
    this.calls += 1;

    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: "I will read README first.",
          toolCalls: [
            {
              id: "call_1",
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
  readonly inputs: ModelStepInput[] = [];

  async step(input: ModelStepInput): Promise<ModelStepOutput> {
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

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const events = new ArrayEventSink();
      const result = await runAgent({
        systemPrompt: "system",
        userPrompt: "Read README.md",
        maxSteps: 4,
        model: new ScriptedModel(),
        tools: tooling.registry,
        toolRuntime: tooling.runtime,
        observationBuilder: new ObservationBuilder(),
        eventSink: events,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe("completed");
      expect(result.status === "completed" ? result.finalText : "").toBe(
        "README was read.",
      );
      const progressEvent = events.events.find(
        (event) => event.type === "assistant.progress",
      );
      expect(progressEvent).toEqual({
        type: "assistant.progress",
        step: 1,
        content: "I will read README first.",
      });
      expect(events.events.map((event) => event.type)).toContain("tool.observation");
      expect(events.events.map((event) => event.type)).toContain("model.step.finished");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("continues from initial messages when provided", async () => {
    const tooling = createDefaultTooling({ workspaceRoot: process.cwd() });
    const events = new ArrayEventSink();
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
      maxSteps: 4,
      model,
      tools: tooling.registry,
      toolRuntime: tooling.runtime,
      observationBuilder: new ObservationBuilder(),
      eventSink: events,
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
