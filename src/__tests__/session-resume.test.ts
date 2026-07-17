import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";
import {
  RuntimeEventAppendError,
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
import { SessionStore, sessionDatabasePath } from "../session/session-store";
import type { ToolExecutor } from "../tools/types";
import {
  buildSystemPrompt,
  loadProjectInstructions,
  type ProjectInstructionManifest,
  projectInstructionManifest,
} from "../instructions/project-instructions";
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
  test("keeps the creation snapshot immutable and refreshes current project instructions on resume", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-runtime-rules-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const nextSessionId = runtimeIdFactory.createSessionId();
    const sink = collectingEventSink();
    const instructionPath = path.join(workspace, "AGENTS.md");
    try {
      await writeFile(instructionPath, "rule version one\n");
      const firstSnapshot = await loadProjectInstructions(workspace);
      const firstPrompt = buildSystemPrompt({
        workspaceRoot: firstSnapshot.workspaceRoot,
        runtimeInstructions: "runtime",
        projectInstructions: firstSnapshot,
      });
      const firstModel = new ResumeModel();
      let session = await createRuntimeSession(
        sessionInput(workspace, sessionId, firstModel, sink, "new", {
          systemPrompt: firstPrompt,
          projectInstruction: projectInstructionManifest(firstSnapshot),
        }),
        { loadMcpConfig: async () => undefined },
      );
      await session.executeTurn({
        userPrompt: "before file change",
        signal: new AbortController().signal,
      });

      await writeFile(instructionPath, "rule version two\n");
      await session.executeTurn({
        userPrompt: "after file change",
        signal: new AbortController().signal,
      });
      expect(firstModel.inputs[1]?.messages[0]?.content).toContain("rule version one");
      expect(firstModel.inputs[1]?.messages[0]?.content).not.toContain(
        "rule version two",
      );
      await session.dispose({ type: "tui_exit" });

      const resumedSnapshot = await loadProjectInstructions(workspace);
      const resumedPrompt = buildSystemPrompt({
        workspaceRoot: resumedSnapshot.workspaceRoot,
        runtimeInstructions: "runtime",
        projectInstructions: resumedSnapshot,
      });
      const resumedModel = new ResumeModel();
      session = await createRuntimeSession(
        sessionInput(workspace, sessionId, resumedModel, sink, "resume", {
          systemPrompt: resumedPrompt,
          projectInstruction: projectInstructionManifest(resumedSnapshot),
        }),
        { loadMcpConfig: async () => undefined },
      );
      await session.executeTurn({
        userPrompt: "after resume",
        signal: new AbortController().signal,
      });
      expect(resumedModel.inputs[0]?.messages[0]?.content).toContain(
        "rule version two",
      );
      expect(resumedModel.inputs[0]?.messages[0]?.content).not.toContain(
        "rule version one",
      );
      expect(
        sink.events.find((event) => event.type === "session.resumed")?.data,
      ).toMatchObject({ projectInstructionFile: "AGENTS.md" });
      expect(
        sink.events.find(
          (event) =>
            event.type === "context.revision.finished" &&
            event.data.strategy === "surface_refresh",
        )?.data,
      ).toMatchObject({
        strategy: "surface_refresh",
        changed: ["system_prompt", "project_instruction"],
      });
      await session.dispose({ type: "tui_exit" });

      const database = new Database(sessionDatabasePath(workspace, sessionId), {
        readonly: true,
      });
      expect(
        (
          database
            .query("SELECT content FROM messages WHERE role = 'system'")
            .get() as { content: string }
        ).content,
      ).toContain("rule version one");
      database.close();

      const nextSnapshot = await loadProjectInstructions(workspace);
      const nextPrompt = buildSystemPrompt({
        workspaceRoot: nextSnapshot.workspaceRoot,
        runtimeInstructions: "runtime",
        projectInstructions: nextSnapshot,
      });
      const nextModel = new ResumeModel();
      const nextSession = await createRuntimeSession(
        sessionInput(workspace, nextSessionId, nextModel, sink, "new", {
          systemPrompt: nextPrompt,
          projectInstruction: projectInstructionManifest(nextSnapshot),
        }),
        { loadMcpConfig: async () => undefined },
      );
      await nextSession.executeTurn({
        userPrompt: "new session",
        signal: new AbortController().signal,
      });
      expect(nextModel.inputs[0]?.messages[0]?.content).toContain("rule version two");
      await nextSession.dispose({ type: "tui_exit" });

      const startedEvents = sink.events.filter(
        (event) => event.type === "session.started",
      );
      expect(startedEvents[0]?.data.projectInstructions.instruction).toEqual(
        projectInstructionManifest(firstSnapshot),
      );
      expect(startedEvents[1]?.data.projectInstructions.instruction).toEqual(
        projectInstructionManifest(nextSnapshot),
      );
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("fast-fails resume when the stored system prompt is corrupted", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-runtime-rules-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const sink = collectingEventSink();
    try {
      const active = await createRuntimeSession(
        sessionInput(workspace, sessionId, new ResumeModel(), sink, "new"),
        { loadMcpConfig: async () => undefined },
      );
      await active.dispose({ type: "tui_exit" });

      const database = new Database(sessionDatabasePath(workspace, sessionId));
      const trigger = database
        .query(
          "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'messages_no_update'",
        )
        .get() as { sql: string };
      database.exec("DROP TRIGGER messages_no_update");
      database
        .query("UPDATE messages SET content = 'tampered' WHERE role = 'system'")
        .run();
      database.exec(trigger.sql);
      database.close();

      const error = await createRuntimeSession(
        sessionInput(workspace, sessionId, new ResumeModel(), sink, "resume"),
        { loadMcpConfig: async () => undefined },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("SESSION_RECOVERY_FAILED");
      expect((error as SessionError).operation).toBe("read_creation_system_prompt");
      expect(
        sink.events.filter((event) => event.type === "session.resumed"),
      ).toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("records deterministic surface revisions when an MCP tool is added and removed", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-runtime-mcp-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const sink = collectingEventSink();
    let mcpEnabled = false;
    const mcpTool: ToolExecutor = {
      definition: {
        name: "mcp__fixture__echo",
        description: "Echo a message",
        parameters: { type: "object", properties: {} },
      },
      async execute() {
        return {
          kind: "generic",
          ok: false,
          toolName: "mcp__fixture__echo",
          error: "unused test executor",
        };
      },
    };
    const dependencies = {
      loadMcpConfig: async () =>
        mcpEnabled
          ? {
              servers: new Map([["fixture", { command: "unused", args: [], env: {} }]]),
            }
          : undefined,
      createMcpManager: async () => ({
        executors: [mcpTool],
        async dispose() {},
      }),
    };

    try {
      let model = new ResumeModel();
      let session = await createRuntimeSession(
        sessionInput(workspace, sessionId, model, sink, "new"),
        dependencies,
      );
      await session.dispose({ type: "tui_exit" });

      mcpEnabled = true;
      model = new ResumeModel();
      session = await createRuntimeSession(
        sessionInput(workspace, sessionId, model, sink, "resume"),
        dependencies,
      );
      await session.executeTurn({
        userPrompt: "after MCP add",
        signal: new AbortController().signal,
      });
      expect(model.inputs[0]?.tools.map((tool) => tool.name)).toContain(
        "mcp__fixture__echo",
      );
      await session.dispose({ type: "tui_exit" });

      mcpEnabled = false;
      model = new ResumeModel();
      session = await createRuntimeSession(
        sessionInput(workspace, sessionId, model, sink, "resume"),
        dependencies,
      );
      await session.executeTurn({
        userPrompt: "after MCP remove",
        signal: new AbortController().signal,
      });
      expect(model.inputs[0]?.tools.map((tool) => tool.name)).not.toContain(
        "mcp__fixture__echo",
      );
      await session.dispose({ type: "tui_exit" });

      const refreshes = sink.events.flatMap((event) =>
        event.type === "context.revision.finished" &&
        event.data.strategy === "surface_refresh"
          ? [
              {
                revisionNumber: event.data.revisionNumber,
                changed: event.data.changed,
              },
            ]
          : [],
      );
      expect(refreshes).toEqual([
        {
          revisionNumber: 2,
          changed: ["tool_definitions"],
        },
        {
          revisionNumber: 3,
          changed: ["tool_definitions"],
        },
      ]);

      const database = new Database(sessionDatabasePath(workspace, sessionId), {
        readonly: true,
      });
      expect(
        database
          .query(
            "SELECT revision_number, kind FROM context_revisions ORDER BY revision_number",
          )
          .all(),
      ).toEqual([
        { revision_number: 1, kind: "initial_full" },
        { revision_number: 2, kind: "surface_refresh" },
        { revision_number: 3, kind: "surface_refresh" },
      ]);
      database.close();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("keeps a committed surface revision when finished-event reporting fails", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-surface-event-"));
    const sessionId = runtimeIdFactory.createSessionId();
    try {
      const first = await createRuntimeSession(
        sessionInput(
          workspace,
          sessionId,
          new ResumeModel(),
          collectingEventSink(),
          "new",
        ),
        { loadMcpConfig: async () => undefined },
      );
      await first.dispose({ type: "tui_exit" });

      const error = await createRuntimeSession(
        sessionInput(
          workspace,
          sessionId,
          new ResumeModel(),
          collectingEventSink(),
          "resume",
          { systemPrompt: "system-v2" },
        ),
        {
          loadMcpConfig: async () => undefined,
          createEventSink: () => ({
            name: "surface-finished-fault",
            async append(event) {
              if (event.type === "context.revision.finished") {
                throw new Error("injected surface event failure");
              }
            },
          }),
        },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RuntimeEventAppendError);

      const reopened = await SessionStore.openExisting({
        workspaceRoot: workspace,
        sessionId,
      });
      try {
        expect(reopened.loadContextSnapshot()).toMatchObject({
          revision: { kind: "surface_refresh", revisionNumber: 2 },
          surface: { systemPrompt: "system-v2" },
        });
        expect(reopened.readActiveMeasuredContextAnchor()).toBeUndefined();
      } finally {
        await reopened.close("tui_exit");
      }
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

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

  test("binds a session to its profile without mutating history on mismatch", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-runtime-contract-"));
    const sessionId = runtimeIdFactory.createSessionId();
    const sink = collectingEventSink();
    try {
      const firstModel = new ResumeModel();
      const firstInput = sessionInput(workspace, sessionId, firstModel, sink, "new");
      firstInput.profileName = "deepseek";
      const first = await createRuntimeSession(firstInput, {
        loadMcpConfig: async () => undefined,
      });
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
      mismatchInput.profileName = "gpt";
      const error = await createRuntimeSession(mismatchInput, {
        loadMcpConfig: async () => undefined,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("SESSION_COMPATIBILITY_MISMATCH");
      expect(mismatchedModel.inputs).toHaveLength(0);

      const resumedModel = new ResumeModel();
      const resumeInput = sessionInput(
        workspace,
        sessionId,
        resumedModel,
        sink,
        "resume",
      );
      resumeInput.profileName = "deepseek";
      const resumed = await createRuntimeSession(resumeInput, {
        loadMcpConfig: async () => undefined,
      });
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
  newSession: {
    systemPrompt: string;
    projectInstruction?: ProjectInstructionManifest;
  } = { systemPrompt: "system" },
): CreateRuntimeSessionInput {
  const common = {
    workspaceRoot,
    modelName: "test-model",
    maxIterations: 2,
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    modelClient,
    systemPrompt: newSession.systemPrompt,
    projectInstruction: newSession.projectInstruction,
    presentationSinks: [sink],
    persistence: false as const,
  };
  return mode === "new"
    ? {
        ...common,
        selection: { mode, sessionId },
      }
    : { ...common, selection: { mode, sessionId } };
}
