import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemorySessionLedger } from "../agent/session-ledger";
import type { IterationIdentity, ToolCall, TurnIdentity } from "../agent/types";
import { ContextRevisionCompiler } from "../context/context-revision-compiler";
import { ContextSwapRenderer } from "../context/context-swap-renderer";
import { validateStoredContextSurface } from "../context/context-surface";
import {
  materializeAgentMessages,
  rawResultHash,
  type ToolResultRecord,
} from "../context/protocol-frame";
import { runtimeIdFactory, type ContextRevisionId } from "../ids/runtime-id";
import { CommittedPrefixAuditor } from "../model/committed-prefix-auditor";
import { promptPrefixFingerprint } from "../model/prompt-prefix-hash";
import { stableJsonStringify } from "../model/model-request-preflight";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import { SessionStore } from "../session/session-store";
import { SessionError } from "../session/session-errors";
import {
  finalizeTestSessionStore,
  TEST_CONTEXT_BUDGET,
  prepareTestModelRequest,
} from "./test-runtime";

describe("ContextRevisionCompiler", () => {
  test("is the byte-stable active rendering path and keeps candidate prompts outside it", () => {
    const tools = [
      {
        name: "Read",
        description: "read",
        parameters: { type: "object", properties: {} },
      },
    ];
    const fixture = completedReadFixture("x".repeat(9_000), tools);
    const built = fixture.ledger.buildCommittedModelRequest(tools);
    const legacyMessages = materializeAgentMessages(
      fixture.ledger.snapshot({ fullIntegrity: true }).messages,
    );
    expect(built.request.messages).toEqual(legacyMessages);
    expect(
      built.compiled.entries.every((entry) => entry.representation === "canonical"),
    ).toBe(true);
    expect(built.compiled.manifest).toMatchObject({
      canonicalFrameCount: built.canonical.frames.length,
      canonicalMessageCount: legacyMessages.length,
      activeFrameCount: built.canonical.frames.length,
      activeMessageCount: legacyMessages.length,
      keepFromOrdinal: 1,
    });

    const client = openAiSerializer();
    const activePrepared = client.prepare(built.request);
    const legacyPrepared = client.prepare({ messages: legacyMessages, tools });
    expect(stableJsonStringify(activePrepared.payload)).toBe(
      stableJsonStringify(legacyPrepared.payload),
    );
    expect(activePrepared.promptSegments).toEqual(legacyPrepared.promptSegments);
    expect(activePrepared.requestConfigHash).toBe(legacyPrepared.requestConfigHash);
    expect(activePrepared.toolSchemaHash).toBe(legacyPrepared.toolSchemaHash);

    const candidate = fixture.ledger.buildCandidateModelRequest(
      { role: "user", content: "next" },
      tools,
    );
    expect(candidate.compiled).toEqual(built.compiled);
    expect(candidate.candidateUserPromptIncluded).toBe(true);
    expect(candidate.request.messages).toEqual([
      ...built.request.messages,
      { role: "user", content: "next" },
    ]);
  });

  test("uses the same compiler for prospective swaps without changing frame skeleton", () => {
    const fixture = completedReadFixture(`secret-body-${"z".repeat(9_000)}`);
    const built = fixture.ledger.buildCommittedModelRequest([]);
    const message = built.canonical.messages.find(
      (candidate) => candidate.role === "tool",
    );
    const result = built.canonical.toolResults[0];
    if (message?.role !== "tool" || result === undefined) {
      throw new Error("Expected a canonical tool message fixture.");
    }
    const override = new ContextSwapRenderer().render({ message, result });
    const compiled = new ContextRevisionCompiler().compileProspective({
      active: built.compiled,
      canonical: built.canonical,
      activeOverrides: built.activeOverrides,
      addedOverrides: [override],
      activeSurface: built.surface,
    });

    expect(compiled.entries.map((entry) => [entry.frameId, entry.messageId])).toEqual(
      built.compiled.entries.map((entry) => [entry.frameId, entry.messageId]),
    );
    expect(compiled.entries).toHaveLength(built.compiled.entries.length);
    expect(
      compiled.entries.find((entry) => entry.messageId === message.messageId),
    ).toMatchObject({
      representation: "swapped",
      sourceContentSha256: message.contentSha256,
      message: {
        role: "tool",
        toolCallId: message.toolCallId,
        providerToolCallId: message.providerToolCallId,
        name: message.name,
        content: override.renderedContent,
      },
    });
    expect(override.renderedContent).not.toContain("secret-body");
    expect(() =>
      new ContextRevisionCompiler().compileProspective({
        active: built.compiled,
        canonical: built.canonical,
        activeOverrides: built.activeOverrides,
        activeSurface: built.surface,
        addedOverrides: [
          {
            ...override,
            renderedContentSha256: "0".repeat(64),
          },
        ],
      }),
    ).toThrow("Swap override metadata is invalid");
  });

  test("fast-fails an unsupported active revision instead of falling back", () => {
    const fixture = completedReadFixture("x".repeat(9_000));
    const built = fixture.ledger.buildCommittedModelRequest([]);
    const snapshot = {
      meta: {
        sessionId: built.canonical.sessionId,
        activeRevisionId: built.compiled.revisionId,
      },
      revision: {
        revisionId: built.compiled.revisionId,
        sessionId: built.canonical.sessionId,
        revisionNumber: 2,
        kind: "swap",
        keepFromOrdinal: 1,
        createdAt: "2026-07-16T00:00:00.000Z",
      },
      surface: built.surface,
      activeOverrides: built.activeOverrides,
      canonical: built.canonical,
    };
    expect(() =>
      new ContextRevisionCompiler().compileActive(snapshot as never),
    ).toThrow("Active context revision");
  });

  test("rejects an unknown stored Recall retirement contract version", () => {
    const fixture = completedReadFixture("x".repeat(9_000));
    const surface = fixture.ledger.buildCommittedModelRequest([]).surface;
    expect(() =>
      validateStoredContextSurface({
        ...surface,
        recallContractVersion: "recall-retirement-unknown",
      } as never),
    ).toThrow("Recall contract version is unsupported");
  });
});

describe("SessionStore context snapshot", () => {
  test("decodes the initial v8 revision without changing durable state", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-revision-"));
    const sessionId = runtimeIdFactory.createSessionId();
    try {
      const store = await SessionStore.createNew({
        workspaceRoot: workspace,
        sessionId,
        modelName: "test-model",
        systemPrompt: "system",
        idFactory: runtimeIdFactory,
      });
      finalizeTestSessionStore(store, { systemPrompt: "system" });
      const before = store.loadContextSnapshot();
      const after = store.loadContextSnapshot();
      expect(before).toEqual(after);
      expect(before.meta).toEqual({
        sessionId,
        activeRevisionId: before.revision.revisionId,
      });
      expect(before.revision).toMatchObject({
        sessionId,
        revisionNumber: 1,
        kind: "initial_full",
        keepFromOrdinal: 1,
      });
      expect(before.canonical.messages).toHaveLength(1);
      expect(store.readMeta().schemaVersion).toBe(9);
      await store.close("tui_exit");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("fast-fails when active revision metadata no longer matches v8", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-revision-bad-"));
    const sessionId = runtimeIdFactory.createSessionId();
    let store: SessionStore | undefined;
    try {
      store = await SessionStore.createNew({
        workspaceRoot: workspace,
        sessionId,
        modelName: "test-model",
        systemPrompt: "system",
        idFactory: runtimeIdFactory,
      });
      finalizeTestSessionStore(store, { systemPrompt: "system" });
      const database = new Database(store.databasePath, { readwrite: true });
      database.exec("DROP TRIGGER session_meta_monotonic_update");
      database
        .query("UPDATE session_meta SET active_revision_id = ? WHERE singleton = 1")
        .run(runtimeIdFactory.createContextRevisionId());
      database.close();

      const error = catchError(() => store!.loadContextSnapshot());
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("SESSION_INTEGRITY_FAILED");
    } finally {
      await store?.close("runner_failed").catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });
});

describe("CommittedPrefixAuditor", () => {
  test("accepts append-only committed requests and rejects every stable-prefix drift", () => {
    const revisionId = "revision-a" as ContextRevisionId;
    const auditor = new CommittedPrefixAuditor();
    const first = prepareTestModelRequest({
      messages: [
        { role: "system", content: "kernel" },
        { role: "user", content: "first" },
      ],
      tools: [],
    });
    const firstAnchor = auditor.audit(revisionId, first);
    expect(firstAnchor).toEqual({
      revisionId,
      ...promptPrefixFingerprint(first),
    });

    const candidateOnly = prepareTestModelRequest({
      messages: [
        { role: "system", content: "kernel" },
        { role: "user", content: "first" },
        { role: "user", content: "not committed" },
      ],
      tools: [],
    });
    void candidateOnly;
    expect(auditor.current()).toEqual(firstAnchor);

    const appendedMessages = [
      { role: "system" as const, content: "kernel" },
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "answer" },
      { role: "user" as const, content: "second" },
    ];
    const appended = prepareTestModelRequest({
      messages: appendedMessages,
      tools: [],
    });
    expect(() => auditor.audit(revisionId, appended)).not.toThrow();

    const changedOldMessage = prepareTestModelRequest({
      messages: [
        { role: "system", content: "changed" },
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second" },
      ],
      tools: [],
    });
    expect(() => auditor.audit(revisionId, changedOldMessage)).toThrow(
      "Committed prompt prefix changed",
    );

    const toolSchemaChanged = prepareTestModelRequest({
      messages: appendedMessages,
      tools: [
        {
          name: "Tool",
          description: "changed",
          parameters: { type: "object" },
        },
      ],
    });
    expect(() => auditor.audit(revisionId, toolSchemaChanged)).toThrow(
      "Committed tool schema changed",
    );

    const requestConfigChanged = {
      ...appended,
      requestConfigHash: "changed-request-config",
    };
    expect(() => auditor.audit(revisionId, requestConfigChanged)).toThrow(
      "Committed request config changed",
    );
  });
});

function completedReadFixture(
  observation: string,
  tools: readonly {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }[] = [],
) {
  const sessionId = runtimeIdFactory.createSessionId();
  const ledger = new InMemorySessionLedger({
    sessionId,
    systemPrompt: "system",
    idFactory: runtimeIdFactory,
    initialToolDefinitions: tools,
    clock: () => "2026-07-16T00:00:00.000Z",
  });
  const turn: TurnIdentity = {
    sessionId,
    turnId: runtimeIdFactory.createTurnId(),
    turnNumber: 1,
  };
  const iteration: IterationIdentity = {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 1,
  };
  const call: ToolCall = {
    ...iteration,
    toolCallId: runtimeIdFactory.createToolCallId(),
    toolCallNumber: 1,
    providerToolCallId: "provider-read",
    name: "Read",
    args: { file_path: "README.md" },
  };
  const pending = ledger.beginTurn({
    turn,
    userMessage: { role: "user", content: "read" },
  });
  pending.agent.appendAssistant({
    iteration,
    message: { role: "assistant", toolCalls: [call] },
    provider: "test",
    model: "test-model",
  });
  const raw = {
    kind: "read" as const,
    ok: true,
    filePath: "README.md",
    startLine: 1,
    endLine: 10,
    sha256: "a".repeat(64),
    sizeBytes: 9_000,
    content: "raw-secret",
  };
  pending.agent.commitToolCompletions([{ call, kind: "returned", raw, observation }]);
  const finalIteration: IterationIdentity = {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 2,
  };
  pending.agent.appendAssistant({
    iteration: finalIteration,
    message: { role: "assistant", content: "done" },
    provider: "test",
    model: "test-model",
  });
  pending.finish({
    status: "completed",
    finalText: "done",
    lastIteration: finalIteration,
  });
  const result: ToolResultRecord | undefined = ledger.snapshot().toolResults[0];
  if (
    result?.completion.kind === "returned" &&
    result.completion.rawSha256 !== rawResultHash(raw)
  ) {
    throw new Error("Fixture raw result hash drifted.");
  }
  return { ledger };
}

function openAiSerializer(): OpenAIChatModelClient {
  return new OpenAIChatModelClient({
    apiKey: "test-no-network",
    baseURL: "https://example.invalid/v1",
    model: "test-model",
    contextBudget: TEST_CONTEXT_BUDGET,
  });
}

function catchError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw.");
}
