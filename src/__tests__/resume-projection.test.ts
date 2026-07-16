import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRuntimeSession,
  type CreateRuntimeSessionInput,
} from "../agent/runtime-session";
import type { EventSink } from "../events/event-sink";
import { runtimeIdFactory } from "../ids/runtime-id";
import type {
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { ResumeProjectionReader } from "../session/resume-projection";
import { SessionCatalog } from "../session/session-catalog";
import { type TimelineItem, visibleTimelineItems } from "../tui/event-store";
import { TuiProjectionStore } from "../tui/tui-projection-store";
import {
  collectingEventSink,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
} from "./test-runtime";

class ProjectionModel extends TestModelClient {
  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    return testModelOutput(prepared, {
      role: "assistant",
      content: "stored answer",
    });
  }
}

class BashProjectionModel extends TestModelClient {
  private requestCount = 0;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requestCount += 1;
    if (this.requestCount === 1) {
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
            providerToolCallId: "provider-projection-bash",
            name: "Bash",
            args: {
              command: "printf 'one\\ntwo\\nthree\\nfour\\nfive\\nsix\\n'",
              description: "Print fixture output",
            },
          },
        ],
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "stored answer after Bash",
    });
  }
}

describe("session catalog and resume projection", () => {
  test("lists independently, hydrates a bounded view, and deletes explicitly", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-catalog-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const logsOnlyId = runtimeIdFactory.createSessionId();
    try {
      const session = await createRuntimeSession(runtimeInput(workspace, sessionId), {
        loadMcpConfig: async () => undefined,
      });
      await session.executeTurn({
        userPrompt: "catalog prompt",
        signal: new AbortController().signal,
      });
      await session.dispose({ type: "tui_exit" });

      const logsOnlyDirectory = path.join(workspace, ".tinker", "sessions", logsOnlyId);
      await mkdir(logsOnlyDirectory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(logsOnlyDirectory, "events.jsonl"), "{}\n", {
        mode: 0o600,
      });

      const catalog = new SessionCatalog({ workspaceRoot: workspace });
      expect(await catalog.get(sessionId)).toMatchObject({
        sessionId,
        modelName: "test-model",
        profileName: "test-profile",
      });
      const summaries = await catalog.list();
      expect(
        summaries.find((summary) => summary.sessionId === sessionId),
      ).toMatchObject({
        status: "resumable",
        turnCount: 1,
        firstUserPromptPreview: "catalog prompt",
      });
      expect(
        summaries.find((summary) => summary.sessionId === logsOnlyId)?.status,
      ).toBe("unavailable");

      const projection = await ResumeProjectionReader.read({
        workspaceRoot: workspace,
        sessionId,
        modelName: "test-model",
      });
      expect(projection.recentTurns).toHaveLength(1);
      expect(projection.recentTurns[0]?.items.map((item) => item.text)).toEqual([
        "catalog prompt",
        "model iteration 1 -> assistant response",
        "stored answer",
      ]);
      expect(projection.backgroundTasks).toEqual([]);
      const projectionStore = new TuiProjectionStore({
        sessionId,
        modelName: "test-model",
        workspaceRoot: projection.workspaceRoot,
      });
      projectionStore.hydrate(projection);
      expect(projectionStore.getSnapshot().status).toBe("done");

      await catalog.delete(sessionId);
      expect(
        (await catalog.list()).some((summary) => summary.sessionId === sessionId),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("reconstructs the same completed timeline presentation as the live TUI", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-projection-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const model = new BashProjectionModel();
    const liveProjection = new TuiProjectionStore({
      sessionId,
      modelName: "test-model",
      workspaceRoot: workspace,
    });
    try {
      const session = await createRuntimeSession(
        runtimeInput(workspace, sessionId, model, liveProjection),
        { loadMcpConfig: async () => undefined },
      );
      await session.executeTurn({
        userPrompt: "run the fixture",
        signal: new AbortController().signal,
      });
      const liveItems = visibleTimelineItems(liveProjection.getSnapshot());
      await session.dispose({ type: "tui_exit" });

      const resumed = await ResumeProjectionReader.read({
        workspaceRoot: workspace,
        sessionId,
        modelName: "test-model",
      });
      const resumedItems = visibleTimelineItems(resumed);

      expect(resumedItems.map(displayShape)).toEqual(liveItems.map(displayShape));
      expect(resumedItems.map((item) => item.text)).toEqual([
        "run the fixture",
        "model iteration 1 -> 1 tool call",
        "Bash Print fixture output -> exit 0",
        "model iteration 2 -> assistant response",
        "stored answer after Bash",
      ]);
      expect(resumedItems[2]?.bash).toMatchObject({
        command: "printf 'one\\ntwo\\nthree\\nfour\\nfive\\nsix\\n'",
        outputPreview: ["two", "three", "four", "five", "six"],
        omittedOutputLines: 1,
      });
      expect(resumedItems[2]?.bash?.outputFilePath).toContain(".tinker/bash/");
      expect(resumedItems.some((item) => item.label === "Bash")).toBe(false);
      expect(resumedItems.some((item) => item.text.includes("outputFilePath="))).toBe(
        false,
      );
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

function runtimeInput(
  workspaceRoot: string,
  sessionId: ReturnType<typeof runtimeIdFactory.createSessionId>,
  modelClient: TestModelClient = new ProjectionModel(),
  presentationSink: EventSink = collectingEventSink(),
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
    presentationSinks: [presentationSink],
    persistence: false,
  };
}

function displayShape(item: TimelineItem) {
  return {
    label: item.label,
    text: item.text,
    status: item.status,
    bash: item.bash,
    diff: item.diff,
    diffTruncated: item.diffTruncated,
  };
}
