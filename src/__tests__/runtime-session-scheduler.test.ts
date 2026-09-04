import { describe, expect, test } from "bun:test";
import type {
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { createTestSession } from "./helpers/runtime-session-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";
import {
  collectingEventSink,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

isolateTinkerHome();

class DeferredBoundaryModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];
  readonly firstRequestStarted: Promise<void>;
  private markFirstRequestStarted!: () => void;
  private resolveFirst!: () => void;
  private readonly releaseFirst = new Promise<void>((resolve) => {
    this.resolveFirst = resolve;
  });

  constructor(private readonly firstOutcome: "final" | "tool") {
    super();
    this.firstRequestStarted = new Promise((resolve) => {
      this.markFirstRequestStarted = resolve;
    });
  }

  release(): void {
    this.resolveFirst();
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push({ messages: [...input.messages], tools: [...input.tools] });
    if (this.inputs.length === 1) {
      this.markFirstRequestStarted();
      await this.releaseFirst;
      if (this.firstOutcome === "tool") {
        if (options.identity === undefined) {
          throw new Error("Expected model request identity.");
        }
        return testModelOutput(prepared, {
          role: "assistant",
          toolCalls: [
            {
              ...options.identity.runtimeSession.createToolCall(
                options.identity.iteration,
                1,
              ),
              providerToolCallId: "provider-steering-read",
              name: "Read",
              args: { file_path: "README.md", limit: 1 },
            },
          ],
        });
      }
      return testModelOutput(prepared, {
        role: "assistant",
        content: "first answer",
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "follow-up answer",
    });
  }
}

describe("RuntimeSession prompt scheduling", () => {
  test("applies queued follow-ups inside the current turn after a complete tool batch", async () => {
    const sink = collectingEventSink();
    const model = new DeferredBoundaryModel("tool");
    const session = await createTestSession(model, sink, "steering-tool");
    const controller = new AbortController();

    const accepted = await session.admitTurn({
      userMessage: { role: "user", content: "inspect" },
      signal: controller.signal,
    });
    await model.firstRequestStarted;
    expect(
      session.queueFollowUp({ role: "user", content: "also check compatibility" }),
    ).toMatchObject({ kind: "queued", pendingCount: 1 });
    model.release();
    const result = await accepted.completion;

    expect(result.status).toBe("completed");
    expect(model.inputs).toHaveLength(2);
    expect(model.inputs[1]?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(model.inputs[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: "also check compatibility",
    });
    expect(
      sink.events
        .filter((event) => event.type === "turn.started")
        .map((event) => event.turnNumber),
    ).toEqual([1]);
    expect(sink.events.some((event) => event.type === "turn.steering.applied")).toBe(
      true,
    );
    expect(session.promptScheduler()).toEqual({ state: "idle", pendingCount: 0 });
    await session.dispose({ type: "oneshot_complete" });
  });

  test("starts a new turn for a queued follow-up after a final response", async () => {
    const sink = collectingEventSink();
    const model = new DeferredBoundaryModel("final");
    const session = await createTestSession(model, sink, "steering-final");
    const accepted = await session.admitTurn({
      userMessage: { role: "user", content: "explain" },
      signal: new AbortController().signal,
    });
    await model.firstRequestStarted;
    session.queueFollowUp({ role: "user", content: "now refactor" });
    model.release();
    const result = await accepted.completion;

    expect(result.status).toBe("completed");
    expect(model.inputs).toHaveLength(2);
    expect(model.inputs[1]?.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "explain" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "now refactor" },
    ]);
    expect(
      sink.events
        .filter((event) => event.type === "turn.started")
        .map((event) => event.turnNumber),
    ).toEqual([1, 2]);
    expect(sink.events.some((event) => event.type === "turn.steering.applied")).toBe(
      false,
    );
    await session.dispose({ type: "oneshot_complete" });
  });
});
