import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createRuntimeSession } from "../agent/runtime-session";
import { toolResultDisplayText } from "../agent/tool-result-content";
import type {
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { createInput } from "./helpers/runtime-session-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";
import {
  collectingEventSink,
  deterministicIdFactory,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

isolateTinkerHome();

class DangerousConfirmationModel extends TestModelClient {
  private requestCount = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    if (this.requestCount === 1) {
      if (options.identity === undefined) {
        throw new Error("Expected runtime identity for Bash confirmation.");
      }
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...options.identity.runtimeSession.createToolCall(
              options.identity.iteration,
              1,
            ),
            providerToolCallId: "provider-dangerous",
            name: "Bash",
            args: { command: "reboot" },
          },
        ],
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "used a safer approach",
    });
  }
}

class AskUserModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push({ messages: [...input.messages], tools: [...input.tools] });
    if (this.inputs.length === 1) {
      if (options.identity === undefined) {
        throw new Error("Expected runtime identity for AskUser.");
      }
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...options.identity.runtimeSession.createToolCall(
              options.identity.iteration,
              1,
            ),
            providerToolCallId: "provider-ask-user",
            name: "AskUser",
            args: {
              question: "Which scope?",
              options: [
                { description: "Current project" },
                { description: "All projects" },
              ],
            },
          },
        ],
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "used the answer",
    });
  }
}

describe("RuntimeSession user interactions", () => {
  test("pauses for AskUser, resolves the selected option, and audits it", async () => {
    const sink = collectingEventSink();
    const model = new AskUserModel();
    const input = {
      ...createInput(model, sink, "ask-user"),
      enableAskUser: true,
    };
    const session = await createRuntimeSession(input, {
      idFactory: deterministicIdFactory("ask-user"),
      loadMcpConfig: async () => undefined,
    });
    let markPending: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      markPending = resolve;
    });
    const unsubscribe = session.subscribeAskUser(() => {
      if (session.askUser().pending !== undefined) {
        markPending?.();
      }
    });

    try {
      const completion = session.executeTurn({
        userMessage: { role: "user", content: "configure it" },
        signal: new AbortController().signal,
      });
      await pending;
      expect(session.askUser().pending).toEqual({
        question: "Which scope?",
        options: [{ description: "Current project" }, { description: "All projects" }],
      });
      expect(
        session.resolveAskUser({ outcome: "selected", selectedIndex: 9 }),
      ).rejects.toThrow("out of range");
      expect(session.askUser().pending).toBeDefined();
      await session.resolveAskUser({ outcome: "selected", selectedIndex: 0 });
      expect(await completion).toMatchObject({
        status: "completed",
        finalText: "used the answer",
      });
      const toolMessage = model.inputs[1]?.messages.at(-1);
      expect(toolMessage?.role).toBe("tool");
      if (toolMessage?.role === "tool") {
        expect(toolResultDisplayText(toolMessage.content)).toBe(
          "User selected: Current project",
        );
      }
      expect(
        sink.events
          .filter((event) => event.type.startsWith("tool.user_question."))
          .map((event) => event.type),
      ).toEqual(["tool.user_question.requested", "tool.user_question.resolved"]);
    } finally {
      unsubscribe();
      await session.dispose({ type: "oneshot_complete" });
      await rm(input.workspaceRoot, { recursive: true });
    }
  });

  test("pauses TUI Bash execution for a decision and audits the denial", async () => {
    const sink = collectingEventSink();
    const input = {
      ...createInput(new DangerousConfirmationModel(), sink, "bash-confirm"),
      bashGuard: {
        mode: "guard" as const,
        source: "default" as const,
        surface: "tui" as const,
      },
    };
    const session = await createRuntimeSession(input, {
      idFactory: deterministicIdFactory("bash-confirm"),
      loadMcpConfig: async () => undefined,
    });
    let markPending: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      markPending = resolve;
    });
    const unsubscribe = session.subscribeBashGuard(() => {
      if (session.bashGuard().pending !== undefined) {
        markPending?.();
      }
    });

    try {
      const completion = session.executeTurn({
        userMessage: { role: "user", content: "do it" },
        signal: new AbortController().signal,
      });
      await pending;
      expect(session.bashGuard()).toMatchObject({
        mode: "guard",
        pending: {
          command: "reboot",
          reason: "system power command reboot",
        },
      });

      await session.resolveBashConfirmation("deny");
      expect(await completion).toMatchObject({
        status: "completed",
        finalText: "used a safer approach",
      });
      expect(
        sink.events
          .filter((event) => event.type.startsWith("tool.confirmation."))
          .map((event) => ({
            type: event.type,
            decision:
              event.type === "tool.confirmation.resolved"
                ? event.data.decision
                : undefined,
          })),
      ).toEqual([
        { type: "tool.confirmation.requested", decision: undefined },
        { type: "tool.confirmation.resolved", decision: "deny" },
      ]);
    } finally {
      unsubscribe();
      await session.dispose({ type: "oneshot_complete" });
      await rm(input.workspaceRoot, { recursive: true });
    }
  });
});
