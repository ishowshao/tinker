import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeSession } from "../agent/runtime-session";
import type { AgentMessage } from "../agent/types";
import { runtimeIdFactory } from "../ids/runtime-id";
import type {
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../model/model-client";
import {
  collectingEventSink,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

describe("Recall historical/current integration", () => {
  test("returns Read v1 after Edit v2 and preserves the source across resume", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-recall-integration-"),
    );
    const filePath = path.join(workspace, "version.ts");
    const sessionId = runtimeIdFactory.createSessionId();
    const model = new HistoricalReadModel();
    try {
      await writeFile(filePath, 'export const value = "version-one-marker";\n', "utf8");
      let session = await createRuntimeSession(
        runtimeInput(workspace, sessionId, model, "new"),
        { loadMcpConfig: async () => undefined },
      );
      const first = await session.executeTurn({
        userPrompt: "exercise historical and current file state",
        signal: new AbortController().signal,
      });
      expect(first.status).toBe("completed");
      expect(await readFile(filePath, "utf8")).toBe(
        'export const value = "version-two-marker";\n',
      );
      expect(model.source).toMatch(/^ctx:\/\/message\//);
      expect(model.originalObservation).toContain("version-one-marker");
      await session.dispose({ type: "tui_exit" });

      session = await createRuntimeSession(
        runtimeInput(workspace, sessionId, model, "resume"),
        { loadMcpConfig: async () => undefined },
      );
      expect(session.recovery.recallIndexRebuilt).toBe(false);
      const resumed = await session.executeTurn({
        userPrompt: "resume and retrieve the exact historical source",
        signal: new AbortController().signal,
      });
      expect(resumed.status).toBe("completed");
      expect(model.resumedHash).toBe(model.originalHash);
      await session.dispose({ type: "tui_exit" });
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

class HistoricalReadModel extends TestModelClient {
  source?: string;
  originalHash?: string;
  originalObservation?: string;
  resumedHash?: string;

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    if (options.identity === undefined) {
      throw new Error("Expected runtime identity.");
    }
    const input = testModelRequestInput(prepared);
    const lastUserIndex = lastMessageIndex(input.messages, "user");
    const user = input.messages[lastUserIndex];
    if (user?.role !== "user") {
      throw new Error("Expected a current user message.");
    }
    const toolMessages = input.messages
      .slice(lastUserIndex + 1)
      .filter(
        (message): message is Extract<AgentMessage, { role: "tool" }> =>
          message.role === "tool",
      );
    const latestTool = toolMessages.at(-1);

    if (user.content.startsWith("resume")) {
      if (latestTool === undefined) {
        return this.toolCall(prepared, options, "Recall", {
          mode: "get",
          source: requireString(this.source, "historical source"),
        });
      }
      expectHistoricalGet(
        latestTool.content,
        requireString(this.originalObservation, "original observation"),
      );
      this.resumedHash = metadata(latestTool.content, "contentSha256");
      return testModelOutput(prepared, {
        role: "assistant",
        content: "resume historical get verified",
      });
    }

    switch (toolMessages.length) {
      case 0:
        return this.toolCall(prepared, options, "Read", {
          file_path: "version.ts",
        });
      case 1:
        if (!latestTool?.content.includes("version-one-marker")) {
          throw new Error("Initial Read did not return file v1.");
        }
        this.originalObservation = latestTool.content;
        return this.toolCall(prepared, options, "Edit", {
          file_path: "version.ts",
          old_string: "version-one-marker",
          new_string: "version-two-marker",
        });
      case 2:
        return this.toolCall(prepared, options, "Recall", {
          mode: "search",
          query: "version-one-marker",
          roles: ["tool"],
          tool_names: ["Read"],
        });
      case 3:
        this.source = metadata(latestTool!.content, "source");
        this.originalHash = metadata(latestTool!.content, "contentSha256");
        return this.toolCall(prepared, options, "Recall", {
          mode: "get",
          source: this.source,
        });
      case 4:
        expectHistoricalGet(
          latestTool!.content,
          requireString(this.originalObservation, "original observation"),
        );
        if (metadata(latestTool!.content, "contentSha256") !== this.originalHash) {
          throw new Error("Recall get hash changed from the search hit hash.");
        }
        return this.toolCall(prepared, options, "Read", {
          file_path: "version.ts",
        });
      case 5:
        if (
          !latestTool?.content.includes("version-two-marker") ||
          latestTool.content.includes("version-one-marker")
        ) {
          throw new Error("Current Read did not return file v2.");
        }
        return testModelOutput(prepared, {
          role: "assistant",
          content: "historical v1 and current v2 verified",
        });
      default:
        throw new Error("Unexpected integration model step.");
    }
  }

  private toolCall(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
    name: string,
    args: unknown,
  ): ModelRequestOutput {
    const identity = options.identity!;
    return testModelOutput(
      prepared,
      {
        role: "assistant",
        toolCalls: [
          {
            ...identity.runtimeSession.createToolCall(identity.iteration, 1),
            providerToolCallId: `integration-${name}-${identity.iteration.iterationNumber}`,
            name,
            args,
          },
        ],
      },
      "tool_calls",
    );
  }
}

function runtimeInput(
  workspaceRoot: string,
  sessionId: ReturnType<typeof runtimeIdFactory.createSessionId>,
  modelClient: HistoricalReadModel,
  mode: "new" | "resume",
) {
  return {
    selection: { mode, sessionId },
    workspaceRoot,
    modelName: "test-model",
    maxIterations: 8,
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    systemPrompt: "system",
    modelClient,
    presentationSinks: [collectingEventSink()],
    persistence: false as const,
  };
}

function metadata(content: string, name: string): string {
  const value = content.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1];
  return requireString(value, name);
}

function expectHistoricalGet(content: string, originalObservation: string): void {
  if (
    !content.startsWith("Recall retrieved historical session data.\nhistorical=true") ||
    !content.includes(originalObservation)
  ) {
    throw new Error("Recall get did not return the exact historical observation.");
  }
}

function requireString(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new Error(`Expected ${name}.`);
  }
  return value;
}

function lastMessageIndex(
  messages: AgentMessage[],
  role: AgentMessage["role"],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) {
      return index;
    }
  }
  return -1;
}
