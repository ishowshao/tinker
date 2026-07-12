import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRuntimeSession,
  type CreateRuntimeSessionInput,
} from "../agent/runtime-session";
import { runtimeIdFactory } from "../ids/runtime-id";
import type {
  ModelRequestInput,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { SessionError } from "../session/session-errors";
import {
  collectingEventSink,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

class ResumeModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push({
      messages: [...input.messages],
      tools: [...input.tools],
    });
    return testModelOutput(prepared, {
      role: "assistant",
      content: `answer-${this.inputs.length}`,
    });
  }
}

describe("RuntimeSession resume", () => {
  test("restores history, counters, and event sequence across activations", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-runtime-resume-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const sink = collectingEventSink();
    const model = new ResumeModel();
    try {
      let session = await createRuntimeSession(
        sessionInput(workspace, sessionId, model, sink, "new"),
        { loadMcpConfig: async () => undefined },
      );
      await session.executeTurn({
        userPrompt: "first",
        signal: new AbortController().signal,
      });
      await session.executeTurn({
        userPrompt: "second",
        signal: new AbortController().signal,
      });
      const lastMeasured = [...sink.events]
        .reverse()
        .find(
          (event) =>
            event.type === "context.usage.updated" && event.data.phase === "measured",
        );
      if (lastMeasured?.type !== "context.usage.updated") {
        throw new Error("Expected measured context usage before resume.");
      }
      await session.dispose({ type: "tui_exit" });

      const resumeEventStart = sink.events.length;
      session = await createRuntimeSession(
        sessionInput(workspace, sessionId, model, sink, "resume"),
        { loadMcpConfig: async () => undefined },
      );
      expect(session.resumed).toBe(true);
      expect(session.recovery.syntheticCompletionCount).toBe(0);
      expect(session.recovery.recallIndexRebuilt).toBe(false);
      const resumedInitial = sink.events
        .slice(resumeEventStart)
        .find(
          (event) =>
            event.type === "context.usage.updated" && event.data.phase === "initial",
        );
      if (resumedInitial?.type !== "context.usage.updated") {
        throw new Error("Expected initial context usage after resume.");
      }
      expect(resumedInitial.data.snapshot).toMatchObject({
        source: "measured_plus_estimated_delta",
        usedInputTokens: lastMeasured.data.snapshot.usedInputTokens,
        rawDeltaTokens: 0,
        guardedDeltaTokens: 0,
        calibrationSampleCount: 0,
      });
      await session.executeTurn({
        userPrompt: "third",
        signal: new AbortController().signal,
      });
      await session.dispose({ type: "tui_exit" });

      expect(model.inputs[2]?.messages).toEqual([
        { role: "system", content: "system" },
        { role: "user", content: "first" },
        { role: "assistant", content: "answer-1" },
        { role: "user", content: "second" },
        { role: "assistant", content: "answer-2" },
        { role: "user", content: "third" },
      ]);
      expect(
        sink.events
          .filter((event) => event.type === "turn.started")
          .map((event) => event.turnNumber),
      ).toEqual([1, 2, 3]);
      expect(
        sink.events.filter((event) => event.type === "session.started"),
      ).toHaveLength(1);
      expect(
        sink.events.filter((event) => event.type === "session.resumed"),
      ).toHaveLength(1);
      expect(
        sink.events.find((event) => event.type === "session.resumed")?.data,
      ).toMatchObject({ recallIndexRebuilt: false });
      const sequences = sink.events.map((event) => event.eventSequence);
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects a second writer before any provider request", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-runtime-lock-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const activeModel = new ResumeModel();
    const contenderModel = new ResumeModel();
    const sink = collectingEventSink();
    let active;
    try {
      active = await createRuntimeSession(
        sessionInput(workspace, sessionId, activeModel, sink, "new"),
        { loadMcpConfig: async () => undefined },
      );
      const error = await createRuntimeSession(
        sessionInput(workspace, sessionId, contenderModel, sink, "resume"),
        { loadMcpConfig: async () => undefined },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("SESSION_LOCKED");
      expect(contenderModel.inputs).toHaveLength(0);
    } finally {
      await active?.dispose({ type: "tui_exit" });
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects a runtime contract change without mutating history", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-runtime-contract-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const sink = collectingEventSink();
    try {
      const firstModel = new ResumeModel();
      const first = await createRuntimeSession(
        sessionInput(workspace, sessionId, firstModel, sink, "new"),
        { loadMcpConfig: async () => undefined },
      );
      await first.executeTurn({
        userPrompt: "persisted",
        signal: new AbortController().signal,
      });
      await first.dispose({ type: "tui_exit" });

      const mismatchedModel = new ResumeModel();
      const mismatchInput = sessionInput(
        workspace,
        sessionId,
        mismatchedModel,
        sink,
        "resume",
      );
      mismatchInput.modelName = "different-model";
      const error = await createRuntimeSession(mismatchInput, {
        loadMcpConfig: async () => undefined,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("SESSION_RUNTIME_MISMATCH");
      expect(mismatchedModel.inputs).toHaveLength(0);

      const resumedModel = new ResumeModel();
      const resumed = await createRuntimeSession(
        sessionInput(workspace, sessionId, resumedModel, sink, "resume"),
        { loadMcpConfig: async () => undefined },
      );
      await resumed.executeTurn({
        userPrompt: "after mismatch",
        signal: new AbortController().signal,
      });
      expect(resumedModel.inputs[0]?.messages).toContainEqual({
        role: "user",
        content: "persisted",
      });
      await resumed.dispose({ type: "tui_exit" });
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

function sessionInput(
  workspaceRoot: string,
  sessionId: ReturnType<typeof runtimeIdFactory.createSessionId>,
  modelClient: ResumeModel,
  sink: ReturnType<typeof collectingEventSink>,
  mode: "new" | "resume",
): CreateRuntimeSessionInput {
  return {
    selection: { mode, sessionId },
    workspaceRoot,
    modelName: "test-model",
    maxIterations: 2,
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    systemPrompt: "system",
    modelClient,
    presentationSinks: [sink],
    persistence: false,
  };
}
