import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRuntimeSession,
  type CreateRuntimeSessionInput,
} from "../agent/runtime-session";
import { runtimeIdFactory } from "../ids/runtime-id";
import type { ModelRequestOutput, PreparedModelRequest } from "../model/model-client";
import { ResumeProjectionReader } from "../session/resume-projection";
import { SessionCatalog } from "../session/session-catalog";
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
});

function runtimeInput(
  workspaceRoot: string,
  sessionId: ReturnType<typeof runtimeIdFactory.createSessionId>,
): CreateRuntimeSessionInput {
  return {
    selection: { mode: "new", sessionId },
    workspaceRoot,
    modelName: "test-model",
    maxIterations: 2,
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    systemPrompt: "system",
    modelClient: new ProjectionModel(),
    presentationSinks: [collectingEventSink()],
    persistence: false,
  };
}
