import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRuntimeSession,
  type CreateRuntimeSessionInput,
} from "../agent/runtime-session";
import { TurnCancelledError, cancellationError } from "../agent/turn-cancellation";
import { runtimeIdFactory, type SessionId } from "../ids/runtime-id";
import type {
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { ResumeProjectionReader } from "../session/resume-projection";
import { readLastAssistantResponse } from "../session/session-last-response-reader";
import {
  collectingEventSink,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
} from "./test-runtime";

const LONG_MARKDOWN = `# Long response\n\n${"content ".repeat(700)}\n`;

class LongResponseModel extends TestModelClient {
  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    return testModelOutput(prepared, {
      role: "assistant",
      content: LONG_MARKDOWN,
    });
  }
}

class ResponseThenFailureAndCancellationModel extends TestModelClient {
  readonly cancellationStarted: Promise<void>;
  private requestCount = 0;
  private markCancellationStarted!: () => void;

  constructor() {
    super();
    this.cancellationStarted = new Promise((resolve) => {
      this.markCancellationStarted = resolve;
    });
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    if (this.requestCount === 1) {
      return testModelOutput(prepared, {
        role: "assistant",
        content: "last completed response",
      });
    }
    if (this.requestCount === 2) {
      throw new Error("model unavailable");
    }

    this.markCancellationStarted();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(cancellationError(options.signal));
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

describe("session last response reader", () => {
  test("returns complete canonical Markdown beyond the resume projection limit", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-last-response-"));
    const sessionId = runtimeIdFactory.createSessionId();
    try {
      const session = await createRuntimeSession(
        runtimeInput(workspace, sessionId, new LongResponseModel()),
        { loadMcpConfig: async () => undefined },
      );
      expect(
        await readLastAssistantResponse({ workspaceRoot: workspace, sessionId }),
      ).toBeUndefined();

      const result = await session.executeTurn({
        userPrompt: "write a long response",
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("completed");
      await session.dispose({ type: "tui_exit" });

      const projection = await ResumeProjectionReader.read({
        workspaceRoot: workspace,
        sessionId,
        modelName: "test-model",
      });
      expect(projection.finalText).not.toBe(LONG_MARKDOWN);
      expect(projection.finalText?.endsWith("\n…")).toBe(true);
      expect(
        await readLastAssistantResponse({ workspaceRoot: workspace, sessionId }),
      ).toBe(LONG_MARKDOWN);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("keeps the last completed response after failed and cancelled turns", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-last-response-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const model = new ResponseThenFailureAndCancellationModel();
    try {
      const session = await createRuntimeSession(
        runtimeInput(workspace, sessionId, model),
        { loadMcpConfig: async () => undefined },
      );
      const completed = await session.executeTurn({
        userPrompt: "complete",
        signal: new AbortController().signal,
      });
      expect(completed.status).toBe("completed");

      const failed = await session.executeTurn({
        userPrompt: "fail",
        signal: new AbortController().signal,
      });
      expect(failed.status).toBe("failed");
      expect(
        await readLastAssistantResponse({ workspaceRoot: workspace, sessionId }),
      ).toBe("last completed response");

      const controller = new AbortController();
      const pending = session.executeTurn({
        userPrompt: "cancel",
        signal: controller.signal,
      });
      await model.cancellationStarted;
      controller.abort(new TurnCancelledError("user"));
      const cancelled = await pending;
      expect(cancelled.status).toBe("cancelled");
      expect(
        await readLastAssistantResponse({ workspaceRoot: workspace, sessionId }),
      ).toBe("last completed response");
      await session.dispose({ type: "tui_exit" });
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

function runtimeInput(
  workspaceRoot: string,
  sessionId: SessionId,
  modelClient: TestModelClient,
): CreateRuntimeSessionInput {
  return {
    selection: { mode: "new", sessionId },
    workspaceRoot,
    modelName: "test-model",
    profileName: "test-profile",
    maxIterations: 2,
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    systemPrompt: "system",
    modelClient,
    presentationSinks: [collectingEventSink()],
    persistence: false,
  };
}
