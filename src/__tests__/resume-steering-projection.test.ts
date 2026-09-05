import { Database } from "bun:sqlite";
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
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import { ResumeProjectionReader } from "../session/resume-projection";
import { visibleTimelineItems, type TimelineItem } from "../tui/event-store";
import { TuiProjectionStore } from "../tui/tui-projection-store";
import { defaultTuiProjectionPolicy } from "../tui/tui-projection-policy";
import {
  isolateTinkerHome,
  workspaceSessionDirectory,
} from "./helpers/workspace-storage-test-support";
import {
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

const tinkerHome = isolateTinkerHome();
const prompts = [
  "initial request",
  "first follow-up",
  "second follow-up",
  "third follow-up",
];

class SteeringProjectionModel extends TestModelClient {
  queueFollowUp: (content: string) => void = () => {
    throw new Error("Follow-up callback was not installed.");
  };
  readonly receivedUsers: string[][] = [];

  constructor(private readonly failFinalRequest: boolean) {
    super();
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.receivedUsers.push(
      testModelRequestInput(prepared)
        .messages.filter((message) => message.role === "user")
        .map((message) => message.content),
    );
    const requestNumber = this.receivedUsers.length;
    if (requestNumber <= 2) {
      const batch = requestNumber === 1 ? prompts.slice(1, 3) : prompts.slice(3);
      for (const content of batch) this.queueFollowUp(content);
      if (options.identity === undefined) throw new Error("Missing request identity.");
      return testModelOutput(prepared, {
        role: "assistant",
        content: `progress ${requestNumber}`,
        toolCalls: [
          {
            ...options.identity.runtimeSession.createToolCall(
              options.identity.iteration,
              1,
            ),
            providerToolCallId: `provider-steering-${requestNumber}`,
            name: "ContextStatus",
            args: {},
          },
        ],
      });
    }
    if (this.failFinalRequest) throw new Error("fixture model failure");
    return testModelOutput(prepared, { role: "assistant", content: "stored answer" });
  }
}

describe("resume projection with active-turn steering", () => {
  for (const outcome of ["completed", "failed"] as const) {
    test(`restores ordered follow-ups for a ${outcome} turn`, async () => {
      const fixture = await createSteeredSession(outcome);
      try {
        const { projectionInput, live, model, runtimeInput } = fixture;
        const resumed = await ResumeProjectionReader.read(projectionInput);
        const items = visibleTimelineItems(resumed);
        expect(resumed.recentTurns).toHaveLength(1);
        expect(resumed.recentTurns[0]?.status).toBe(
          outcome === "completed" ? "completed" : "failed",
        );
        const liveItems = visibleTimelineItems(live.getSnapshot());
        if (outcome === "completed") {
          expect(items.map(displayShape)).toEqual(liveItems.map(displayShape));
        } else {
          // Resume adds an outcome suffix to unanswered model requests; compare
          // the shared history and assert that terminal request separately.
          expect(items.slice(0, -2).map(displayShape)).toEqual(
            liveItems.slice(0, -2).map(displayShape),
          );
          expect(items.at(-2)).toMatchObject({
            text: "model iteration 3 -> failed",
            status: "failed",
          });
          expect(items.at(-1)).toMatchObject({
            label: "error",
            text: "fixture model failure",
          });
        }
        expect(items.map((item) => item.label ?? "model")).toEqual([
          "prompt",
          "model",
          "assistant",
          "model",
          "follow-up",
          "follow-up",
          "model",
          "assistant",
          "model",
          "follow-up",
          "model",
          outcome === "completed" ? "assistant" : "error",
        ]);
        expect(
          items
            .filter((item) => item.userPrompt !== undefined)
            .map((item) => item.text),
        ).toEqual(prompts);
        expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
        expect(model.receivedUsers[1]).toEqual(prompts.slice(0, 3));

        const bounded = await ResumeProjectionReader.read({
          ...projectionInput,
          policy: { ...defaultTuiProjectionPolicy, itemLimitPerTurn: 4 },
        });
        expect(bounded.recentTurns[0]?.items.map(displayShape)).toEqual([
          displayShape(items[0]),
          ...items.slice(-3).map(displayShape),
        ]);
        expect(bounded.recentTurns[0]?.omittedItemCount).toBe(items.length - 4);

        // Exercise canonical runtime recovery too, then continue with a new turn.
        const continuedModel = new (class extends TestModelClient {
          async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
            expect(
              testModelRequestInput(prepared)
                .messages.filter((message) => message.role === "user")
                .map((message) => message.content),
            ).toEqual([...prompts, "continue"]);
            return testModelOutput(prepared, {
              role: "assistant",
              content: "continued answer",
            });
          }
        })();
        const session = await createRuntimeSession(
          {
            ...runtimeInput,
            selection: { mode: "resume", sessionId: projectionInput.sessionId },
            modelClient: continuedModel,
            presentationSinks: [],
          },
          { loadMcpConfig: async () => undefined },
        );
        try {
          expect(
            (
              await session.executeTurn({
                userMessage: { role: "user", content: "continue" },
                signal: new AbortController().signal,
              })
            ).status,
          ).toBe("completed");
        } finally {
          await session.dispose({ type: "tui_exit" });
        }
        expect(
          (await ResumeProjectionReader.read(projectionInput)).recentTurns,
        ).toHaveLength(2);
      } finally {
        await rm(fixture.workspace, { recursive: true });
      }
    });
  }

  test("still verifies the integrity of follow-ups even when omitted by the item limit", async () => {
    const fixture = await createSteeredSession("completed");
    try {
      const directory = await workspaceSessionDirectory(
        fixture.workspace,
        tinkerHome(),
        fixture.projectionInput.sessionId,
      );
      const database = new Database(path.join(directory, "session.sqlite"));
      try {
        const trigger = database
          .query("SELECT sql FROM sqlite_master WHERE name = 'messages_no_update'")
          .get() as { sql: string };
        database.exec("DROP TRIGGER messages_no_update");
        database
          .query("UPDATE messages SET content = 'tampered follow-up' WHERE content = ?")
          .run(prompts[1]);
        database.exec(trigger.sql);
      } finally {
        database.close();
      }
      const error = await ResumeProjectionReader.read({
        ...fixture.projectionInput,
        policy: { ...defaultTuiProjectionPolicy, itemLimitPerTurn: 2 },
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("failed its integrity check");
    } finally {
      await rm(fixture.workspace, { recursive: true });
    }
  });
});

async function createSteeredSession(outcome: "completed" | "failed") {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "tinker-steering-projection-"),
  );
  const sessionId = runtimeIdFactory.createSessionId();
  const model = new SteeringProjectionModel(outcome === "failed");
  const projectionInput = {
    workspaceRoot: workspace,
    sessionId,
    modelName: "test-model",
  };
  const live = new TuiProjectionStore(projectionInput);
  const runtimeInput: CreateRuntimeSessionInput = {
    ...projectionInput,
    selection: { mode: "new", sessionId },
    profileName: "test-profile",
    maxIterations: 3,
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    systemPrompt: "system",
    modelClient: model,
    presentationSinks: [live],
    persistence: false,
  };
  try {
    const session = await createRuntimeSession(runtimeInput, {
      loadMcpConfig: async () => undefined,
    });
    try {
      model.queueFollowUp = (content) => {
        session.queueFollowUp({ role: "user", content });
      };
      await session.executeTurn({
        userMessage: { role: "user", content: prompts[0] },
        signal: new AbortController().signal,
      });
    } finally {
      await session.dispose({ type: "tui_exit" });
    }
    return { workspace, projectionInput, live, model, runtimeInput };
  } catch (error) {
    await rm(workspace, { recursive: true });
    throw error;
  }
}

function displayShape(item: TimelineItem) {
  return {
    label: item.label,
    text: item.text,
    status: item.status,
    userPrompt: item.userPrompt,
  };
}
