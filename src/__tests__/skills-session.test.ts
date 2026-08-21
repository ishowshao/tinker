import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createRuntimeSession,
  type CreateRuntimeSessionInput,
} from "../agent/runtime-session";
import { toolResultDisplayText } from "../agent/tool-result-content";
import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import { runtimeIdFactory, type SessionId } from "../ids/runtime-id";
import type {
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { loadSkillCatalog, type SkillCatalogSnapshot } from "../skills/skill-loader";
import {
  SessionStore,
  type CommitSkillsUpdateFaultStage,
} from "../session/session-store";
import type { ToolExecutor } from "../tools/types";
import {
  collectingEventSink,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

class ActivateSkillModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push({ messages: [...input.messages], tools: [...input.tools] });
    if (this.inputs.length === 1) {
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
            providerToolCallId: "provider-skill",
            name: "Skill",
            args: { name: "review-code" },
          },
        ],
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "review complete",
    });
  }
}

class ActivateTwoSkillsModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push({ messages: [...input.messages], tools: [...input.tools] });
    if (this.inputs.length === 1) {
      if (options.identity === undefined) {
        throw new Error("Expected model request identity.");
      }
      const identity = options.identity;
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: ["test-guidance", "review-code"].map((name, index) => ({
          ...identity.runtimeSession.createToolCall(identity.iteration, index + 1),
          providerToolCallId: `provider-skill-${index + 1}`,
          name: "Skill",
          args: { name },
        })),
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "both skills applied",
    });
  }
}

class UnexpectedRequestModel extends TestModelClient {
  async request(): Promise<ModelRequestOutput> {
    throw new Error("Model request was not expected.");
  }
}

describe("Agent Skills session lifecycle", () => {
  test("does not create a revision when an unchanged catalog is resumed", async () => {
    await withSessionFixture(async (fixture) => {
      const initial = await createRuntimeSession(
        fixture.input(
          "new",
          new UnexpectedRequestModel(),
          await fixture.loadCatalog(),
          collectingEventSink(),
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );
      await initial.dispose({ type: "tui_exit" });

      const sink = collectingEventSink();
      const resumed = await createRuntimeSession(
        fixture.input(
          "resume",
          new UnexpectedRequestModel(),
          await fixture.loadCatalog(),
          sink,
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );
      await resumed.dispose({ type: "tui_exit" });

      const reopened = await openSnapshot(fixture.workspace, fixture.sessionId);
      expect(reopened.snapshot.revision).toMatchObject({
        kind: "initial_full",
        revisionNumber: 1,
      });
      expect(
        sink.events.filter((event) => event.type === "context.revision.started"),
      ).toEqual([]);
      expect(sink.events.filter((event) => event.type === "skills.updated")).toEqual(
        [],
      );
    });
  });

  test("refreshes the surface when only an inactive skill body changes", async () => {
    await withSessionFixture(async (fixture) => {
      const initial = await createRuntimeSession(
        fixture.input(
          "new",
          new UnexpectedRequestModel(),
          await fixture.loadCatalog(),
          collectingEventSink(),
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );
      await initial.dispose({ type: "tui_exit" });
      await fixture.writeSkill(
        "Review code for correctness",
        "Changed inactive instructions.",
      );

      const sink = collectingEventSink();
      const resumed = await createRuntimeSession(
        fixture.input(
          "resume",
          new UnexpectedRequestModel(),
          await fixture.loadCatalog(),
          sink,
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );
      await resumed.dispose({ type: "tui_exit" });

      expect(
        sink.events.find(
          (event) =>
            event.type === "context.revision.started" &&
            event.data.strategy === "surface_refresh",
        ),
      ).toMatchObject({ data: { changed: ["skill_catalog"] } });
      const refreshed = await openSnapshot(fixture.workspace, fixture.sessionId);
      expect(refreshed.snapshot.revision).toMatchObject({
        kind: "surface_refresh",
        revisionNumber: 2,
      });
      expect(refreshed.snapshot.surface.activeSkills).toEqual([]);
      expect(refreshed.snapshot.surface.systemPrompt).toBe("system");
    });
  });

  test("commits one complete surface when MCP and the skill catalog change together", async () => {
    await withSessionFixture(async (fixture) => {
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
        idFactory: runtimeIdFactory,
        loadMcpConfig: async () =>
          mcpEnabled
            ? {
                servers: new Map([
                  ["fixture", { command: "unused", args: [], env: {} }],
                ]),
              }
            : undefined,
        createMcpManager: async () => ({
          executors: [mcpTool],
          inventory: { servers: [{ name: "fixture", tools: ["echo"] }] },
          async dispose() {},
        }),
      };
      const initial = await createRuntimeSession(
        fixture.input(
          "new",
          new UnexpectedRequestModel(),
          await fixture.loadCatalog(),
          collectingEventSink(),
        ),
        dependencies,
      );
      await initial.dispose({ type: "tui_exit" });

      await fixture.writeSkill(
        "Review code for correctness",
        "Changed inactive instructions.",
      );
      mcpEnabled = true;
      const sink = collectingEventSink();
      const resumed = await createRuntimeSession(
        fixture.input(
          "resume",
          new UnexpectedRequestModel(),
          await fixture.loadCatalog(),
          sink,
        ),
        dependencies,
      );
      await resumed.dispose({ type: "tui_exit" });

      const starts = sink.events.filter(
        (event) => event.type === "context.revision.started",
      );
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        data: {
          strategy: "surface_refresh",
          changed: ["skill_catalog", "tool_definitions"],
        },
      });
      const refreshed = await openSnapshot(fixture.workspace, fixture.sessionId);
      expect(refreshed.snapshot.revision).toMatchObject({
        kind: "surface_refresh",
        revisionNumber: 2,
      });
      const toolNames = refreshed.snapshot.surface.toolDefinitions.map(
        (definition) => definition.name,
      );
      expect(toolNames).toContain("Skill");
      expect(toolNames).toContain("mcp__fixture__echo");
    });
  });

  test("checks compatibility before writing skill revisions or events", async () => {
    await withSessionFixture(async (fixture) => {
      const initial = await createRuntimeSession(
        fixture.input(
          "new",
          new UnexpectedRequestModel(),
          await fixture.loadCatalog(),
          collectingEventSink(),
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );
      await initial.dispose({ type: "tui_exit" });

      const sink = collectingEventSink();
      const error = await createRuntimeSession(
        {
          ...fixture.input(
            "resume",
            new UnexpectedRequestModel(),
            await fixture.loadCatalog(),
            sink,
          ),
          modelName: "incompatible-model",
        },
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "SESSION_COMPATIBILITY_MISMATCH" });
      expect(sink.events).toEqual([]);
      const reopened = await openSnapshot(fixture.workspace, fixture.sessionId);
      expect(reopened.snapshot.revision).toMatchObject({
        kind: "initial_full",
        revisionNumber: 1,
      });
    });
  });

  test("rolls back every Agent Skills transaction fault stage", async () => {
    const stages: readonly CommitSkillsUpdateFaultStage[] = [
      "before_surface_insert",
      "after_surface_insert",
      "after_revision_insert",
      "after_first_override_insert",
      "after_overrides_insert",
      "after_activations_update",
      "after_measurement_delete",
      "after_active_update",
    ];
    for (const stage of stages) {
      await withSessionFixture(async (fixture) => {
        const session = await createRuntimeSession(
          fixture.input(
            "new",
            new ActivateSkillModel(),
            await fixture.loadCatalog(),
            collectingEventSink(),
          ),
          {
            idFactory: runtimeIdFactory,
            loadMcpConfig: async () => undefined,
            openStore: async (input, idFactory) => {
              if (input.selection.mode !== "new") {
                throw new Error("Fault fixture expected a new session.");
              }
              const store = await SessionStore.createNew({
                workspaceRoot: input.workspaceRoot,
                sessionId: input.selection.sessionId,
                modelName: input.modelName,
                systemPrompt: input.systemPrompt,
                ...(input.projectInstruction === undefined
                  ? {}
                  : { projectInstruction: input.projectInstruction }),
                idFactory,
              });
              const commit = store.commitSkillsUpdate.bind(store);
              store.commitSkillsUpdate = (update) =>
                commit(update, {
                  faultInjector(current) {
                    if (current === stage) {
                      throw new Error(`fault:${stage}`);
                    }
                  },
                });
              return store;
            },
          },
        );

        let failure: unknown;
        try {
          await session.executeTurn({
            userMessage: { role: "user", content: "review this change" },
            signal: new AbortController().signal,
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeDefined();
        await session
          .dispose({ type: "runner_failed", error: `fault:${stage}` })
          .catch(() => undefined);

        const rolledBack = await openSnapshot(fixture.workspace, fixture.sessionId);
        expect(rolledBack.snapshot.revision.kind).toBe("initial_full");
        expect(rolledBack.snapshot.surface.activeSkills).toEqual([]);
        expect(rolledBack.snapshot.activeOverrides).toEqual([]);
        expect(rolledBack.activations).toMatchObject([
          { name: "review-code", state: "dispatched" },
        ]);
      });
    }
  });

  test("promotes a dispatched activation, then refreshes and deactivates it on resume", async () => {
    await withSessionFixture(async (fixture) => {
      const model = new ActivateSkillModel();
      const sink = collectingEventSink();
      const catalog = await fixture.loadCatalog();
      const session = await createRuntimeSession(
        fixture.input("new", model, catalog, sink),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );

      expect(session.skills().skills).toEqual([
        {
          name: "review-code",
          description: "Review code for correctness",
          scope: "project",
          active: false,
        },
      ]);
      const result = await session.executeTurn({
        userMessage: { role: "user", content: "review this change" },
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({
        status: "completed",
        finalText: "review complete",
      });
      expect(session.skills().skills[0]?.active).toBe(true);

      const skillDefinition = model.inputs[0]?.tools.find(
        (definition) => definition.name === "Skill",
      );
      expect(skillDefinition).toBeDefined();
      expect(model.inputs[0]?.messages[0]?.content).not.toContain(
        "Review every changed line.",
      );
      const activationObservation = model.inputs[1]?.messages.find(
        (message) => message.role === "tool" && message.name === "Skill",
      );
      expect(activationObservation?.role).toBe("tool");
      if (activationObservation?.role !== "tool") {
        throw new Error("Expected the Skill activation observation.");
      }
      expect(toolResultDisplayText(activationObservation.content)).toContain(
        "Review every changed line.",
      );
      expect(
        sink.events.find((event) => event.type === "skills.updated"),
      ).toMatchObject({
        data: { reason: "activation", activated: ["review-code"] },
      });
      await session.dispose({ type: "oneshot_complete" });

      const promoted = await openSnapshot(fixture.workspace, fixture.sessionId);
      expect(promoted.snapshot.revision.kind).toBe("skills_update");
      expect(promoted.snapshot.surface.activeSkills).toHaveLength(1);
      expect(promoted.snapshot.surface.systemPrompt).toContain(
        "Review every changed line.",
      );
      expect(promoted.snapshot.activeOverrides[0]?.renderedContent).toContain(
        "activation promoted",
      );
      expect(promoted.activations).toMatchObject([
        { name: "review-code", state: "promoted" },
      ]);

      const source = await SessionStore.openExisting({
        workspaceRoot: fixture.workspace,
        sessionId: fixture.sessionId,
      });
      const targetSessionId = runtimeIdFactory.createSessionId();
      try {
        await source.cloneTo({ targetSessionId });
      } finally {
        await source.abandon();
      }
      const cloned = await openSnapshot(fixture.workspace, targetSessionId);
      expect(cloned.snapshot.revision).toMatchObject({
        kind: "skills_update",
        revisionNumber: promoted.snapshot.revision.revisionNumber,
      });
      expect(cloned.snapshot.surface.activeSkills).toEqual(
        promoted.snapshot.surface.activeSkills,
      );
      expect(cloned.snapshot.activeOverrides).toEqual(
        promoted.snapshot.activeOverrides,
      );
      expect(cloned.activations).toMatchObject([
        { name: "review-code", state: "promoted" },
      ]);

      await fixture.writeSkill(
        "Review code and tests",
        "Use the refreshed review checklist.",
      );
      const refreshedSink = collectingEventSink();
      const refreshedCatalog = await fixture.loadCatalog();
      const refreshed = await createRuntimeSession(
        fixture.input(
          "resume",
          new UnexpectedRequestModel(),
          refreshedCatalog,
          refreshedSink,
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );
      expect(refreshed.skills().skills).toEqual([
        {
          name: "review-code",
          description: "Review code and tests",
          scope: "project",
          active: true,
        },
      ]);
      expect(
        refreshedSink.events.find((event) => event.type === "skills.updated"),
      ).toMatchObject({
        data: { reason: "resume", refreshed: ["review-code"] },
      });
      await refreshed.dispose({ type: "tui_exit" });

      await rm(fixture.skillDirectory, { recursive: true });
      const removedSink = collectingEventSink();
      const emptyCatalog = await fixture.loadCatalog();
      const removed = await createRuntimeSession(
        fixture.input(
          "resume",
          new UnexpectedRequestModel(),
          emptyCatalog,
          removedSink,
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );
      expect(removed.skills()).toEqual({ skills: [], shadowedNames: [] });
      expect(
        removedSink.events.find((event) => event.type === "skills.updated"),
      ).toMatchObject({
        data: { reason: "resume", deactivated: ["review-code"] },
      });
      await removed.dispose({ type: "tui_exit" });

      const deactivated = await openSnapshot(fixture.workspace, fixture.sessionId);
      expect(deactivated.snapshot.surface.activeSkills).toEqual([]);
      expect(
        deactivated.snapshot.surface.toolDefinitions.some(
          (definition) => definition.name === "Skill",
        ),
      ).toBe(false);
    });
  });

  test("promotes multiple dispatched skills in one sorted revision", async () => {
    await withSessionFixture(async (fixture) => {
      const secondDirectory = path.join(
        fixture.workspace,
        ".agents",
        "skills",
        "test-guidance",
      );
      await mkdir(secondDirectory, { recursive: true });
      await writeFile(
        path.join(secondDirectory, "SKILL.md"),
        "---\nname: test-guidance\ndescription: Test guidance\n---\nRun focused tests.\n",
      );
      const model = new ActivateTwoSkillsModel();
      const sink = collectingEventSink();
      const session = await createRuntimeSession(
        fixture.input("new", model, await fixture.loadCatalog(), sink),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );

      await session.executeTurn({
        userMessage: { role: "user", content: "review and test this change" },
        signal: new AbortController().signal,
      });
      expect(session.skills().skills).toMatchObject([
        { name: "review-code", active: true },
        { name: "test-guidance", active: true },
      ]);
      expect(model.inputs[1]?.messages[0]?.content).not.toContain("Run focused tests.");
      expect(
        model.inputs[1]?.messages.filter(
          (message) => message.role === "tool" && message.name === "Skill",
        ),
      ).toHaveLength(2);
      const started = sink.events.find(
        (event) =>
          event.type === "context.revision.started" &&
          event.data.strategy === "skills_update",
      );
      expect(started).toMatchObject({
        data: { names: ["review-code", "test-guidance"] },
      });
      expect(
        sink.events.find((event) => event.type === "skills.updated"),
      ).toMatchObject({
        data: {
          activated: ["review-code", "test-guidance"],
          unavailable: [],
        },
      });
      await session.dispose({ type: "tui_exit" });

      const promoted = await openSnapshot(fixture.workspace, fixture.sessionId);
      expect(promoted.snapshot.revision).toMatchObject({
        kind: "skills_update",
        revisionNumber: 2,
        addedOverrideCount: 2,
      });
      expect(promoted.snapshot.surface.activeSkills.map((entry) => entry.name)).toEqual(
        ["review-code", "test-guidance"],
      );
      expect(
        promoted.activations
          .map((entry) => ({ name: entry.name, state: entry.state }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      ).toEqual([
        { name: "review-code", state: "promoted" },
        { name: "test-guidance", state: "promoted" },
      ]);
    });
  });

  test("keeps active instructions and Recall truth after retiring the activation turn", async () => {
    await withSessionFixture(async (fixture) => {
      const model = new ActivateSkillModel();
      const session = await createRuntimeSession(
        fixture.input("new", model, await fixture.loadCatalog(), collectingEventSink()),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
          manualRetirementTrigger: () => ({
            kind: "benchmark_forced",
            targetTokens: 1,
          }),
        },
      );
      await session.executeTurn({
        userMessage: { role: "user", content: "activate review guidance" },
        signal: new AbortController().signal,
      });
      for (let index = 0; index < 10; index += 1) {
        await session.executeTurn({
          userMessage: { role: "user", content: `tail-${index}-${"x".repeat(100)}` },
          signal: new AbortController().signal,
        });
      }

      const retirement = await session.retireContext();
      expect(retirement.status).toBe("retired");
      expect(session.skills().skills[0]?.active).toBe(true);
      await session.executeTurn({
        userMessage: { role: "user", content: "continue after retirement" },
        signal: new AbortController().signal,
      });
      expect(model.inputs.at(-1)?.messages[0]?.content).toContain(
        "Review every changed line.",
      );
      await session.dispose({ type: "tui_exit" });

      const store = await SessionStore.openExisting({
        workspaceRoot: fixture.workspace,
        sessionId: fixture.sessionId,
      });
      try {
        const snapshot = store.loadContextSnapshot();
        expect(snapshot.revision.kind).toBe("prefix_retirement");
        expect(snapshot.surface.activeSkills).toHaveLength(1);
        expect(snapshot.surface.systemPrompt).toContain("Review every changed line.");
        const history = store.historyReader().search({
          query: "Review every changed line",
          limit: 10,
          offset: 0,
        });
        expect(history.hits.some((hit) => hit.toolName === "Skill")).toBe(true);
      } finally {
        await store.abandon();
      }
    });
  });

  test("rejects and hides an activation that was never dispatched", async () => {
    await withSessionFixture(async (fixture) => {
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      const abortingSink: EventSink = {
        async append(event) {
          events.push(event);
          if (event.type === "tool.observation" && event.data.call.name === "Skill") {
            controller.abort();
          }
        },
      };
      const session = await createRuntimeSession(
        fixture.input(
          "new",
          new ActivateSkillModel(),
          await fixture.loadCatalog(),
          abortingSink,
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );

      const result = await session.executeTurn({
        userMessage: { role: "user", content: "review this change" },
        signal: controller.signal,
      });
      expect(result.status).toBe("cancelled");
      expect(session.skills().skills[0]?.active).toBe(false);
      expect(events.find((event) => event.type === "skills.updated")).toMatchObject({
        data: { reason: "activation", activated: [] },
      });
      await session.dispose({ type: "oneshot_complete" });

      const rejected = await openSnapshot(fixture.workspace, fixture.sessionId);
      expect(rejected.activations).toMatchObject([
        {
          name: "review-code",
          state: "rejected",
          rejectionReason: "not_dispatched",
        },
      ]);
      expect(rejected.snapshot.surface.activeSkills).toEqual([]);
      expect(rejected.snapshot.activeOverrides[0]?.renderedContent).toContain(
        "status=not_dispatched",
      );
      const rejectedObservation = rejected.snapshot.canonical.messages.find(
        (message) => message.role === "tool" && message.name === "Skill",
      );
      expect(rejectedObservation?.role).toBe("tool");
      if (rejectedObservation?.role !== "tool") {
        throw new Error("Expected the rejected Skill activation observation.");
      }
      expect(toolResultDisplayText(rejectedObservation.content)).toContain(
        "Review every changed line.",
      );
    });
  });

  test("rebinds an active user skill to a new project winner", async () => {
    await withSessionFixture(async (fixture) => {
      await rm(fixture.skillDirectory, { recursive: true });
      const userSkillDirectory = path.join(
        fixture.home,
        ".agents",
        "skills",
        "review-code",
      );
      await mkdir(userSkillDirectory, { recursive: true });
      await writeFile(
        path.join(userSkillDirectory, "SKILL.md"),
        "---\nname: review-code\ndescription: User review\n---\nUse user rules.\n",
      );
      const initial = await createRuntimeSession(
        fixture.input(
          "new",
          new ActivateSkillModel(),
          await fixture.loadCatalog(),
          collectingEventSink(),
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );
      await initial.executeTurn({
        userMessage: { role: "user", content: "review this change" },
        signal: new AbortController().signal,
      });
      expect(initial.skills().skills[0]).toMatchObject({
        scope: "user",
        active: true,
      });
      await initial.dispose({ type: "oneshot_complete" });

      await fixture.writeSkill("Project review", "Use project rules.");
      const sink = collectingEventSink();
      const resumed = await createRuntimeSession(
        fixture.input(
          "resume",
          new UnexpectedRequestModel(),
          await fixture.loadCatalog(),
          sink,
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );
      expect(resumed.skills()).toEqual({
        skills: [
          {
            name: "review-code",
            description: "Project review",
            scope: "project",
            active: true,
          },
        ],
        shadowedNames: ["review-code"],
      });
      expect(
        sink.events.find((event) => event.type === "skills.updated"),
      ).toMatchObject({ data: { refreshed: ["review-code"] } });
      await resumed.dispose({ type: "tui_exit" });
    });
  });

  test("recovers a dispatched activation left unresolved by a turn event failure", async () => {
    await withSessionFixture(async (fixture) => {
      let failed = false;
      const failingSink: EventSink = {
        async append(event) {
          if (!failed && event.type === "turn.finished") {
            failed = true;
            throw new Error("required event sink failed");
          }
        },
      };
      const session = await createRuntimeSession(
        fixture.input(
          "new",
          new ActivateSkillModel(),
          await fixture.loadCatalog(),
          collectingEventSink(),
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
          createEventSink: () => failingSink,
        },
      );

      expect(
        session.executeTurn({
          userMessage: { role: "user", content: "review this change" },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("Failed to append runtime event turn.finished");
      await session
        .dispose({ type: "runner_failed", error: "required event sink failed" })
        .catch(() => undefined);

      const unresolved = await openSnapshot(fixture.workspace, fixture.sessionId);
      expect(unresolved.activations).toMatchObject([
        { name: "review-code", state: "dispatched" },
      ]);

      const sink = collectingEventSink();
      const resumed = await createRuntimeSession(
        fixture.input(
          "resume",
          new UnexpectedRequestModel(),
          await fixture.loadCatalog(),
          sink,
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );
      expect(resumed.skills().skills[0]?.active).toBe(true);
      expect(
        sink.events.find((event) => event.type === "skills.updated"),
      ).toMatchObject({
        data: {
          reason: "resume",
          activated: ["review-code"],
        },
      });
      await resumed.dispose({ type: "tui_exit" });

      const recovered = await openSnapshot(fixture.workspace, fixture.sessionId);
      expect(recovered.activations).toMatchObject([
        { name: "review-code", state: "promoted" },
      ]);
      expect(recovered.snapshot.revision.kind).toBe("skills_update");
    });
  });

  test("rejects a pending crash activation on resume without making it active", async () => {
    await withSessionFixture(async (fixture) => {
      let failed = false;
      const failingSink: EventSink = {
        async append(event) {
          if (
            !failed &&
            event.type === "model.request.started" &&
            event.iterationNumber === 2
          ) {
            failed = true;
            throw new Error("second dispatch event failed");
          }
        },
      };
      const session = await createRuntimeSession(
        fixture.input(
          "new",
          new ActivateSkillModel(),
          await fixture.loadCatalog(),
          collectingEventSink(),
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
          createEventSink: () => failingSink,
        },
      );

      const error = await session
        .executeTurn({
          userMessage: { role: "user", content: "review this change" },
          signal: new AbortController().signal,
        })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ eventType: "model.request.started" });
      await session
        .dispose({ type: "runner_failed", error: "second dispatch event failed" })
        .catch(() => undefined);
      const unresolved = await openSnapshot(fixture.workspace, fixture.sessionId);
      expect(unresolved.activations).toMatchObject([
        { name: "review-code", state: "pending" },
      ]);

      const resumed = await createRuntimeSession(
        fixture.input(
          "resume",
          new UnexpectedRequestModel(),
          await fixture.loadCatalog(),
          collectingEventSink(),
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );
      expect(resumed.skills().skills[0]?.active).toBe(false);
      await resumed.dispose({ type: "tui_exit" });

      const rejected = await openSnapshot(fixture.workspace, fixture.sessionId);
      expect(rejected.activations).toMatchObject([
        {
          name: "review-code",
          state: "rejected",
          rejectionReason: "not_dispatched",
        },
      ]);
      expect(rejected.snapshot.activeOverrides[0]?.renderedContent).toContain(
        "status=not_dispatched",
      );
    });
  });

  test("rejects a dispatched activation as unavailable when its skill disappeared", async () => {
    await withSessionFixture(async (fixture) => {
      let failed = false;
      const failingSink: EventSink = {
        async append(event) {
          if (!failed && event.type === "turn.finished") {
            failed = true;
            throw new Error("required event sink failed");
          }
        },
      };
      const session = await createRuntimeSession(
        fixture.input(
          "new",
          new ActivateSkillModel(),
          await fixture.loadCatalog(),
          collectingEventSink(),
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
          createEventSink: () => failingSink,
        },
      );

      expect(
        session.executeTurn({
          userMessage: { role: "user", content: "review this change" },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("Failed to append runtime event turn.finished");
      await session
        .dispose({ type: "runner_failed", error: "required event sink failed" })
        .catch(() => undefined);
      await rm(fixture.skillDirectory, { recursive: true });
      const anchored = await SessionStore.openExisting({
        workspaceRoot: fixture.workspace,
        sessionId: fixture.sessionId,
      });
      try {
        anchored.writeMeasuredContextAnchor({
          totalTokens: 30,
          promptTokens: 20,
          completionTokens: 10,
          segmentCount: 1,
          prefixHash: "1".repeat(64),
          requestConfigHash: "2".repeat(64),
          toolSchemaHash: "3".repeat(64),
        });
      } finally {
        await anchored.abandon();
      }

      const sink = collectingEventSink();
      const resumed = await createRuntimeSession(
        fixture.input(
          "resume",
          new UnexpectedRequestModel(),
          await fixture.loadCatalog(),
          sink,
        ),
        {
          idFactory: runtimeIdFactory,
          loadMcpConfig: async () => undefined,
        },
      );
      expect(resumed.skills()).toEqual({ skills: [], shadowedNames: [] });
      expect(
        sink.events.find((event) => event.type === "skills.updated"),
      ).toMatchObject({
        data: {
          reason: "resume",
          activated: [],
          refreshed: [],
          deactivated: [],
          unavailable: ["review-code"],
        },
      });
      await resumed.dispose({ type: "tui_exit" });

      const recovered = await openSnapshot(fixture.workspace, fixture.sessionId);
      expect(recovered.activations).toMatchObject([
        {
          name: "review-code",
          state: "rejected",
          rejectionReason: "unavailable",
        },
      ]);
      expect(recovered.snapshot.activeOverrides[0]?.renderedContent).toContain(
        "status=unavailable",
      );
      expect(recovered.measuredAnchor).toBeUndefined();
    });
  });
});

async function openSnapshot(workspaceRoot: string, sessionId: SessionId) {
  const store = await SessionStore.openExisting({ workspaceRoot, sessionId });
  try {
    return {
      snapshot: store.loadContextSnapshot(),
      activations: store.loadSkillActivations(),
      measuredAnchor: store.readActiveMeasuredContextAnchor(),
    };
  } finally {
    await store.abandon();
  }
}

async function withSessionFixture(
  callback: (fixture: {
    workspace: string;
    home: string;
    sessionId: SessionId;
    skillDirectory: string;
    writeSkill(description: string, body: string): Promise<void>;
    loadCatalog(): Promise<SkillCatalogSnapshot>;
    input(
      mode: "new" | "resume",
      model: TestModelClient,
      catalog: SkillCatalogSnapshot,
      sink: EventSink,
    ): CreateRuntimeSessionInput;
  }) => Promise<void>,
): Promise<void> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "tinker-skills-session-")),
  );
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const skillDirectory = path.join(workspace, ".agents", "skills", "review-code");
  const sessionId = runtimeIdFactory.createSessionId();
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(home);
  const writeSkill = async (description: string, body: string) => {
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      `---\nname: review-code\ndescription: ${description}\n---\n${body}\n`,
    );
  };
  await writeSkill("Review code for correctness", "Review every changed line.");
  try {
    await callback({
      workspace,
      home,
      sessionId,
      skillDirectory,
      writeSkill,
      loadCatalog: () => loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
      input: (mode, model, catalog, sink) => {
        const common = {
          workspaceRoot: workspace,
          modelName: "test-model",
          maxIterations: 4,
          includeReasoningContent: false,
          contextProfile: TEST_CONTEXT_PROFILE,
          contextBudget: TEST_CONTEXT_BUDGET,
          systemPrompt: "system",
          skillCatalog: catalog,
          modelClient: model,
          presentationSinks: [sink],
          persistence: false as const,
        };
        return mode === "new"
          ? { ...common, selection: { mode, sessionId } }
          : { ...common, selection: { mode, sessionId } };
      },
    });
  } finally {
    await rm(root, { recursive: true });
  }
}
