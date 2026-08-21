import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { IterationIdentity, ToolCall, TurnIdentity } from "../agent/types";
import {
  textToolResultContent,
  toolResultDisplayText,
} from "../agent/tool-result-content";
import { formatMessageSource } from "../context/context-source";
import { runtimeIdFactory } from "../ids/runtime-id";
import { SessionError } from "../session/session-errors";
import {
  isRecallableMessage,
  RecallHistoryError,
} from "../session/session-history-reader";
import { SessionStore } from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import { finalizeTestSessionStore } from "./test-runtime";

describe("SessionHistoryReader", () => {
  test("excludes legacy and split Recall observations from the index allowlist", () => {
    for (const toolName of ["Recall", "RecallSearch", "RecallGet"]) {
      expect(
        isRecallableMessage({ role: "tool", content: "recursive", toolName }),
      ).toBe(false);
    }
    expect(
      isRecallableMessage({ role: "tool", content: "file", toolName: "Read" }),
    ).toBe(true);
  });

  test("gets exact allowlisted content with stable UTF-8 byte pages", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-history-get-"));
    let first: HistoryFixture | undefined;
    let second: HistoryFixture | undefined;
    try {
      first = await createHistoryFixture(workspace);
      const reader = first.store.historyReader();
      const toolMessage = first.store
        .loadProtocolView()
        .messages.find((message) => message.role === "tool" && message.name === "Read");
      if (toolMessage?.role !== "tool") {
        throw new Error("Expected a Read tool message.");
      }

      const source = formatMessageSource(toolMessage.messageId);
      const pages: string[] = [];
      let byteOffset = 0;
      let expectedHash: string | undefined;
      for (;;) {
        const page = reader.get({ source, byteOffset, byteLimit: 7 });
        pages.push(page.content);
        expectedHash ??= page.contentSha256;
        expect(page.contentSha256).toBe(expectedHash);
        expect(page.source).toBe(source);
        expect(page.role).toBe("tool");
        expect(page.toolName).toBe("Read");
        if (page.nextByteOffset === undefined) {
          expect(page.byteOffset + page.returnedBytes).toBe(page.totalBytes);
          break;
        }
        expect(page.nextByteOffset).toBe(page.byteOffset + page.returnedBytes);
        byteOffset = page.nextByteOffset;
      }
      const toolText = toolResultDisplayText(toolMessage.content);
      expect(pages.join("")).toBe(toolText);

      const systemMessage = first.store.loadProtocolView().messages[0];
      expectRecallError(
        () =>
          reader.get({
            source: formatMessageSource(systemMessage.messageId),
            byteOffset: 0,
            byteLimit: 256,
          }),
        "RECALL_SOURCE_NOT_FOUND",
      );
      expectRecallError(
        () =>
          reader.get({
            source: formatMessageSource(first!.recallToolMessageId),
            byteOffset: 0,
            byteLimit: 256,
          }),
        "RECALL_SOURCE_NOT_FOUND",
      );

      const chineseByte = Buffer.byteLength(
        toolText.slice(0, toolText.indexOf("历")),
        "utf8",
      );
      expectRecallError(
        () => reader.get({ source, byteOffset: chineseByte + 1, byteLimit: 256 }),
        "RECALL_PAGE_INVALID",
      );
      expectRecallError(
        () =>
          reader.get({
            source,
            byteOffset: Buffer.byteLength(toolText, "utf8"),
            byteLimit: 256,
          }),
        "RECALL_PAGE_INVALID",
      );

      second = await createHistoryFixture(workspace);
      expectRecallError(
        () =>
          reader.get({
            source: formatMessageSource(second!.userMessageId),
            byteOffset: 0,
            byteLimit: 256,
          }),
        "RECALL_SOURCE_NOT_FOUND",
      );
    } finally {
      await second?.store.close("tui_exit").catch(() => undefined);
      await first?.store.close("tui_exit").catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("searches literal history with filters, bounded excerpts, and stable snapshots", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-history-search-"));
    let fixture: HistoryFixture | undefined;
    try {
      fixture = await createHistoryFixture(workspace);
      const reader = fixture.store.historyReader();

      for (const query of [
        "中文路",
        "eacces",
        "src/foo.ts",
        "C++",
        "std::vector",
        "https://example.com/a?q=1",
        '"OR" * - % _',
      ]) {
        const page = reader.search({ query, limit: 20, offset: 0 });
        expect(page.strategy).toBe("fts5_trigram");
        expect(page.hits.length).toBeGreaterThan(0);
      }

      expect(reader.search({ query: "中", limit: 20, offset: 0 }).strategy).toBe(
        "substring",
      );
      expect(reader.search({ query: "中文", limit: 20, offset: 0 }).strategy).toBe(
        "substring",
      );
      expect(
        reader.search({
          query: "historical needle",
          roles: ["tool"],
          toolNames: ["Read"],
          turnFrom: 1,
          turnTo: 1,
          limit: 20,
          offset: 0,
        }).hits,
      ).toHaveLength(1);
      expect(
        reader.search({
          query: "historical needle",
          roles: ["user"],
          limit: 20,
          offset: 0,
        }).hits,
      ).toHaveLength(0);
      expect(
        reader.search({ query: "recursive-secret", limit: 20, offset: 0 }).hits,
      ).toHaveLength(0);

      const excerpt = reader.search({
        query: "historical needle",
        limit: 20,
        offset: 0,
      }).hits[0]?.excerpt;
      expect(excerpt).toBeDefined();
      expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(480);
      expect(excerpt).toContain("historical needle");
      expect(excerpt?.startsWith("…")).toBe(true);

      appendTextTurn(
        fixture.store,
        fixture.ledger,
        3,
        "snapshot-keyword alpha",
        "snapshot-keyword beta",
      );
      const firstPage = reader.search({
        query: "snapshot-keyword",
        limit: 1,
        offset: 0,
      });
      expect(firstPage.nextOffset).toBe(1);
      appendTextTurn(
        fixture.store,
        fixture.ledger,
        4,
        "snapshot-keyword newly-added-user",
        "snapshot-keyword newly-added-assistant",
      );
      const oldSnapshotAll = reader.search({
        query: "snapshot-keyword",
        limit: 20,
        offset: 0,
        snapshotThroughOrdinal: firstPage.snapshotThroughOrdinal,
      });
      expect(oldSnapshotAll.hits).toHaveLength(2);
      const newSnapshotAll = reader.search({
        query: "snapshot-keyword",
        limit: 20,
        offset: 0,
      });
      expect(newSnapshotAll.hits).toHaveLength(4);
      expectRecallError(
        () =>
          reader.search({
            query: "snapshot-keyword",
            limit: 20,
            offset: 0,
            snapshotThroughOrdinal: 999_999,
          }),
        "RECALL_SNAPSHOT_INVALID",
      );
    } finally {
      await fixture?.store.close("tui_exit").catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });

  test("fails closed on canonical hash drift and after store close", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-history-fault-"));
    let fixture: HistoryFixture | undefined;
    try {
      fixture = await createHistoryFixture(workspace);
      const reader = fixture.store.historyReader();
      const source = formatMessageSource(fixture.userMessageId);
      const toolMessage = fixture.store
        .loadProtocolView()
        .messages.find((message) => message.role === "tool" && message.name === "Read");
      if (toolMessage?.role !== "tool") {
        throw new Error("Expected Read tool message.");
      }
      const database = new Database(fixture.store.databasePath, { readwrite: true });
      database.exec("DROP TRIGGER tool_results_no_update");
      database
        .query(
          "UPDATE tool_results SET observation_sha256 = ? WHERE tool_message_id = ?",
        )
        .run("0".repeat(64), toolMessage.messageId);
      database.close();

      const observationError = catchError(() =>
        reader.get({
          source: formatMessageSource(toolMessage.messageId),
          byteOffset: 0,
          byteLimit: 256,
        }),
      );
      expect(observationError).toBeInstanceOf(SessionError);
      expect((observationError as SessionError).code).toBe("SESSION_READ_FAILED");

      const contentDatabase = new Database(fixture.store.databasePath, {
        readwrite: true,
      });
      contentDatabase.exec("DROP TRIGGER messages_no_update");
      contentDatabase
        .query("UPDATE messages SET content = ? WHERE message_id = ?")
        .run("tampered canonical content", fixture.userMessageId);
      contentDatabase.close();

      const integrityError = catchError(() =>
        reader.get({ source, byteOffset: 0, byteLimit: 256 }),
      );
      expect(integrityError).toBeInstanceOf(SessionError);
      expect((integrityError as SessionError).code).toBe("SESSION_READ_FAILED");

      await fixture.store.close("tui_exit");
      const closedError = catchError(() =>
        reader.search({ query: "anything", limit: 10, offset: 0 }),
      );
      expect(closedError).toBeInstanceOf(SessionError);
      expect((closedError as SessionError).code).toBe("SESSION_READ_FAILED");
    } finally {
      await fixture?.store.close("tui_exit").catch(() => undefined);
      await rm(workspace, { recursive: true });
    }
  });
});

type HistoryFixture = {
  store: SessionStore;
  ledger: SqliteSessionLedger;
  userMessageId: ReturnType<typeof runtimeIdFactory.createMessageId>;
  recallToolMessageId: ReturnType<typeof runtimeIdFactory.createMessageId>;
};

async function createHistoryFixture(workspaceRoot: string): Promise<HistoryFixture> {
  const sessionId = runtimeIdFactory.createSessionId();
  const store = await SessionStore.createNew({
    workspaceRoot,
    sessionId,
    modelName: "test-model",
    systemPrompt: "private system prompt",
    idFactory: runtimeIdFactory,
  });
  finalizeTestSessionStore(store, { systemPrompt: "private system prompt" });
  const ledger = new SqliteSessionLedger(store, runtimeIdFactory);

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
    args: { file_path: "src/foo.ts" },
  };
  const pending = ledger.beginTurn({
    turn,
    userMessage: {
      role: "user",
      content:
        '中文路径 src/foo.ts failed with EACCES in C++ std::vector; see https://example.com/a?q=1 and literal "OR" * - % _.',
    },
  });
  store.beginIteration(iteration);
  pending.agent.appendAssistant({
    iteration,
    message: {
      role: "assistant",
      content: "I will inspect src/foo.ts and preserve the historical result.",
      toolCalls: [call],
    },
    provider: "test",
    model: "test-model",
  });
  const observation = `${"前置历史内容".repeat(90)} historical needle 历史正文🙂\r\nRead v1 content`;
  pending.agent.commitToolCompletions([
    {
      call,
      kind: "returned",
      raw: {
        kind: "read",
        ok: true,
        filePath: "src/foo.ts",
        content: "v1",
      },
      observation: textToolResultContent(observation),
    },
  ]);
  store.finishIterationForContinuation(iteration);
  const finalIteration: IterationIdentity = {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 2,
  };
  store.beginIteration(finalIteration);
  pending.agent.appendAssistant({
    iteration: finalIteration,
    message: { role: "assistant", content: "Historical inspection completed." },
    provider: "test",
    model: "test-model",
  });
  pending.finish({
    status: "completed",
    finalText: "Historical inspection completed.",
    lastIteration: finalIteration,
  });

  const recallTurn: TurnIdentity = {
    sessionId,
    turnId: runtimeIdFactory.createTurnId(),
    turnNumber: 2,
  };
  const recallIteration: IterationIdentity = {
    ...recallTurn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 1,
  };
  const recallCall: ToolCall = {
    ...recallIteration,
    toolCallId: runtimeIdFactory.createToolCallId(),
    toolCallNumber: 1,
    providerToolCallId: "provider-recall",
    name: "RecallSearch",
    args: { query: "x" },
  };
  const recallPending = ledger.beginTurn({
    turn: recallTurn,
    userMessage: { role: "user", content: "recall it" },
  });
  store.beginIteration(recallIteration);
  recallPending.agent.appendAssistant({
    iteration: recallIteration,
    message: { role: "assistant", toolCalls: [recallCall] },
    provider: "test",
    model: "test-model",
  });
  recallPending.agent.commitToolCompletions([
    {
      call: recallCall,
      kind: "returned",
      raw: {
        kind: "generic",
        ok: false,
        toolName: "RecallSearch",
        error: "fixture",
      },
      observation: textToolResultContent("recursive-secret must never be indexed"),
    },
  ]);
  const recallToolMessage = store
    .loadProtocolView()
    .messages.find(
      (message) => message.role === "tool" && message.name === "RecallSearch",
    );
  if (recallToolMessage?.role !== "tool") {
    throw new Error("Expected Recall tool message.");
  }
  store.finishIterationForContinuation(recallIteration);
  const recallFinalIteration: IterationIdentity = {
    ...recallTurn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 2,
  };
  store.beginIteration(recallFinalIteration);
  recallPending.agent.appendAssistant({
    iteration: recallFinalIteration,
    message: { role: "assistant", content: "Recall turn complete." },
    provider: "test",
    model: "test-model",
  });
  recallPending.finish({
    status: "completed",
    finalText: "Recall turn complete.",
    lastIteration: recallFinalIteration,
  });

  const userMessage = store
    .loadProtocolView()
    .messages.find((message) => message.role === "user");
  if (userMessage?.role !== "user") {
    throw new Error("Expected user message.");
  }
  return {
    store,
    ledger,
    userMessageId: userMessage.messageId,
    recallToolMessageId: recallToolMessage.messageId,
  };
}

function appendTextTurn(
  store: SessionStore,
  ledger: SqliteSessionLedger,
  turnNumber: number,
  userPrompt: string,
  assistantText: string,
): void {
  const turn: TurnIdentity = {
    sessionId: store.sessionId,
    turnId: runtimeIdFactory.createTurnId(),
    turnNumber,
  };
  const iteration: IterationIdentity = {
    ...turn,
    iterationId: runtimeIdFactory.createIterationId(),
    iterationNumber: 1,
  };
  const pending = ledger.beginTurn({
    turn,
    userMessage: { role: "user", content: userPrompt },
  });
  store.beginIteration(iteration);
  pending.agent.appendAssistant({
    iteration,
    message: { role: "assistant", content: assistantText },
    provider: "test",
    model: "test-model",
  });
  pending.finish({
    status: "completed",
    finalText: assistantText,
    lastIteration: iteration,
  });
}

function expectRecallError(
  operation: () => unknown,
  code: RecallHistoryError["code"],
): void {
  const error = catchError(operation);
  expect(error).toBeInstanceOf(RecallHistoryError);
  expect((error as RecallHistoryError).code).toBe(code);
}

function catchError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw.");
}
