import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeSession } from "../agent/runtime-session";
import { toolResultDisplayText } from "../agent/tool-result-content";
import type { AgentMessage, AssistantMessage } from "../agent/types";
import { runtimeIdFactory } from "../ids/runtime-id";
import type {
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { deriveModelContextBudget } from "../model/model-context-profile";
import {
  collectingEventSink,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

const CONTEXT_PROFILE = {
  contextWindowTokens: 160 * 1_024,
  maxSupportedOutputTokens: 64 * 1_024,
} as const;
const CONTEXT_BUDGET = deriveModelContextBudget(CONTEXT_PROFILE);
const NOTICE_MARKER = "[tinker context notice]";
const LARGE_MARKER = "pressure-notice-large-observation";

describe("context pressure notice", () => {
  test("sends one notice on escalation, suppresses automatic swap once, then resumes automation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-pressure-notice-"));
    const sessionId = runtimeIdFactory.createSessionId();
    await writeFile(
      path.join(workspace, "large.txt"),
      `${LARGE_MARKER}\n${"x".repeat(235 * 1_024)}`,
      "utf8",
    );
    const sink = collectingEventSink();
    const model = new NoticeAutomationModel();
    const session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId },
        workspaceRoot: workspace,
        modelName: "test-model",
        profileName: "deepseek-v4-flash",
        maxIterations: 5,
        includeReasoningContent: false,
        contextProfile: CONTEXT_PROFILE,
        contextBudget: CONTEXT_BUDGET,
        systemPrompt: "system",
        modelClient: model,
        presentationSinks: [sink],
        persistence: false,
      },
      { loadMcpConfig: async () => undefined },
    );
    try {
      const result = await session.executeTurn({
        userMessage: { role: "user", content: "trigger a pressure notice" },
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({
        status: "completed",
        finalText: "pressure notice verified",
      });
      expect(model.noticeText).toContain(NOTICE_MARKER);
      expect(model.noticeText).toContain('"high"');
      expect(model.noticeText).toContain("Automatic compaction will resume");
      expect(model.sawSwapPlaceholder).toBe(true);

      const notices = sink.events.filter(
        (event) => event.type === "context.pressure_notice.sent",
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.data).toMatchObject({
        pressure: "triggered",
        automaticSwapEnabled: true,
      });

      const noticeSequence = notices[0]?.eventSequence;
      const secondRequest = sink.events.find(
        (event) =>
          event.type === "model.request.started" && event.iterationNumber === 2,
      );
      const thirdRequest = sink.events.find(
        (event) =>
          event.type === "model.request.started" && event.iterationNumber === 3,
      );
      if (
        noticeSequence === undefined ||
        secondRequest === undefined ||
        thirdRequest === undefined
      ) {
        throw new Error("Missing notice or follow-up request events.");
      }
      expect(noticeSequence).toBeLessThan(secondRequest.eventSequence);

      // The notice lease suppresses automatic compaction for exactly the
      // iteration that delivered the notice; the next iteration end runs it.
      const automaticSwaps = sink.events.filter(
        (event) =>
          event.type === "context.revision.finished" &&
          event.data.strategy === "swap" &&
          event.data.reason === "runtime_pressure",
      );
      expect(automaticSwaps).toHaveLength(1);
      expect(
        sink.events.some(
          (event) =>
            event.type === "context.revision.started" &&
            event.data.strategy === "retire_prefix",
        ),
      ).toBe(false);
      expect(noticeSequence).toBeLessThan(
        automaticSwaps[0]?.eventSequence ?? Number.NaN,
      );
      expect(automaticSwaps[0]?.eventSequence ?? 0).toBeLessThan(
        thirdRequest.eventSequence,
      );
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("notifies with the disabled-automation wording and re-arms once per turn", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-pressure-notice-off-"),
    );
    const sessionId = runtimeIdFactory.createSessionId();
    await writeFile(
      path.join(workspace, "large.txt"),
      `${LARGE_MARKER}\n${"y".repeat(235 * 1_024)}`,
      "utf8",
    );
    const sink = collectingEventSink();
    const model = new NoticeNoAutomationModel();
    const contextAutomationPolicy = {
      policyId: "test-automation-disabled",
      automaticSwap: false,
      automaticPrefixRetirement: false,
    };
    const session = await createRuntimeSession(
      {
        selection: { mode: "new", sessionId },
        workspaceRoot: workspace,
        modelName: "test-model",
        maxIterations: 3,
        includeReasoningContent: false,
        contextProfile: CONTEXT_PROFILE,
        contextBudget: CONTEXT_BUDGET,
        systemPrompt: "system",
        modelClient: model,
        presentationSinks: [sink],
        persistence: false,
      },
      { loadMcpConfig: async () => undefined, contextAutomationPolicy },
    );
    try {
      const first = await session.executeTurn({
        userMessage: { role: "user", content: "first pressured turn" },
        signal: new AbortController().signal,
      });
      expect(first).toMatchObject({ status: "completed" });
      expect(model.noticeTexts).toHaveLength(1);
      expect(model.noticeTexts[0]).toContain("Automatic compaction is disabled");

      const second = await session.executeTurn({
        userMessage: { role: "user", content: "second pressured turn" },
        signal: new AbortController().signal,
      });
      expect(second).toMatchObject({
        status: "completed",
        finalText: "second turn verified",
      });
      expect(model.noticeTexts).toHaveLength(2);

      const notices = sink.events.filter(
        (event) => event.type === "context.pressure_notice.sent",
      );
      expect(notices).toHaveLength(2);
      expect(notices.every((event) => !event.data.automaticSwapEnabled)).toBe(true);
      expect(
        sink.events.filter((event) => event.type === "context.revision.started"),
      ).toHaveLength(0);
    } finally {
      await session.dispose({ type: "tui_exit" }).catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });
});

class NoticeAutomationModel extends TestModelClient {
  requestCount = 0;
  noticeText?: string;
  sawSwapPlaceholder = false;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    const input = testModelRequestInput(prepared);
    switch (this.requestCount) {
      case 1:
        return toolOutput(prepared, options, [
          { name: "Read", args: { file_path: "large.txt" } },
        ]);
      case 2: {
        const notice = latestUserText(input.messages);
        expect(notice).toContain(NOTICE_MARKER);
        this.noticeText = notice;
        return toolOutput(prepared, options, [{ name: "ContextStatus", args: {} }]);
      }
      case 3: {
        const read = requireToolMessage(input.messages, "Read");
        this.sawSwapPlaceholder = toolResultDisplayText(read.content).includes(
          "[Tinker historical tool observation swapped]",
        );
        return testModelOutput(prepared, {
          role: "assistant",
          content: "pressure notice verified",
        });
      }
      default:
        throw new Error("Unexpected notice fixture iteration.");
    }
  }
}

class NoticeNoAutomationModel extends TestModelClient {
  requestCount = 0;
  readonly noticeTexts: string[] = [];

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    const input = testModelRequestInput(prepared);
    const userTexts = input.messages
      .filter(
        (message): message is Extract<AgentMessage, { role: "user" }> =>
          message.role === "user",
      )
      .map((message) => message.content)
      .filter(
        (content): content is string =>
          typeof content === "string" && content.includes(NOTICE_MARKER),
      );
    for (const text of userTexts) {
      if (!this.noticeTexts.includes(text)) {
        this.noticeTexts.push(text);
      }
    }
    if (this.requestCount === 1) {
      return toolOutput(prepared, options, [
        { name: "Read", args: { file_path: "large.txt" } },
      ]);
    }
    if (this.requestCount === 3) {
      // Stay under the input budget in the second turn: a tiny tool call keeps
      // the loop iterating without adding another large observation.
      return toolOutput(prepared, options, [{ name: "ContextStatus", args: {} }]);
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: this.requestCount === 2 ? "first turn done" : "second turn verified",
    });
  }
}

function toolOutput(
  prepared: PreparedModelRequest,
  options: ModelRequestOptions,
  calls: readonly { name: string; args: unknown }[],
): ModelRequestOutput {
  if (options.identity === undefined) {
    throw new Error("Pressure notice fixture has no runtime identity.");
  }
  const { iteration, runtimeSession } = options.identity;
  const message: AssistantMessage = {
    role: "assistant",
    toolCalls: calls.map((call, index) => ({
      ...runtimeSession.createToolCall(iteration, index + 1),
      providerToolCallId: `notice-${iteration.iterationNumber}-${index + 1}`,
      ...call,
    })),
  };
  return testModelOutput(prepared, message, "tool_calls");
}

function latestUserText(messages: readonly AgentMessage[]): string {
  const users = messages.filter(
    (message): message is Extract<AgentMessage, { role: "user" }> =>
      message.role === "user",
  );
  const latest = users.at(-1);
  if (latest === undefined || typeof latest.content !== "string") {
    throw new Error("Missing trailing user message.");
  }
  return latest.content;
}

function requireToolMessage(
  messages: readonly AgentMessage[],
  name: string,
): Extract<AgentMessage, { role: "tool" }> {
  const result = messages.find(
    (message): message is Extract<AgentMessage, { role: "tool" }> =>
      message.role === "tool" && message.name === name,
  );
  if (result === undefined) throw new Error(`Missing ${name} tool message.`);
  return result;
}
