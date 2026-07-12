import { describe, expect, test } from "bun:test";
import { ObservationBuilder } from "../observation/observation-builder";
import { formatMessageSource } from "../context/context-source";
import { runtimeIdFactory } from "../ids/runtime-id";
import { SessionError } from "../session/session-errors";
import {
  RecallHistoryError,
  type SessionHistoryReader,
} from "../session/session-history-reader";
import { createRecallToolExecutor } from "../tools/recall";
import { ToolRegistry, ToolRuntime } from "../tools/registry";
import { ToolExecutionFatalError } from "../tools/types";
import { createTestRuntime } from "./test-runtime";

const context = { signal: new AbortController().signal };

describe("Recall tool", () => {
  test("uses a flat schema and maps search/get success", async () => {
    const fixture = historyReaderFixture();
    const registry = new ToolRegistry();
    registry.register(createRecallToolExecutor({ historyReader: fixture.reader }));
    const runtime = new ToolRuntime(registry);
    const identity = createTestRuntime();
    const definition = registry.definitions()[0];

    expect(definition.name).toBe("Recall");
    expect(definition.parameters).not.toHaveProperty("oneOf");
    expect(definition.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["mode"],
    });

    const search = await runtime.execute(
      identity.toolCall({
        name: "Recall",
        args: {
          mode: "search",
          query: "EACCES",
          roles: ["tool"],
          tool_names: ["Read"],
          turn_from: 1,
          turn_to: 3,
        },
      }),
      context,
    );
    expect(search).toMatchObject({
      kind: "recall",
      ok: true,
      mode: "search",
      historical: true,
      query: "EACCES",
      filters: {
        roles: ["tool"],
        toolNames: ["Read"],
        turnFrom: 1,
        turnTo: 3,
      },
      page: { limit: 10, offset: 0 },
    });
    expect(fixture.searchInputs).toEqual([
      {
        query: "EACCES",
        roles: ["tool"],
        toolNames: ["Read"],
        turnFrom: 1,
        turnTo: 3,
        limit: 10,
        offset: 0,
      },
    ]);

    const get = await runtime.execute(
      identity.toolCall({
        name: "Recall",
        args: { mode: "get", source: fixture.source },
      }),
      context,
    );
    expect(get).toMatchObject({
      kind: "recall",
      ok: true,
      mode: "get",
      historical: true,
      page: { source: fixture.source, byteOffset: 0 },
    });
    expect(fixture.getInputs).toEqual([
      { source: fixture.source, byteOffset: 0, byteLimit: 12_000 },
    ]);
  });

  test("returns stable ordinary errors without faulting the runtime", async () => {
    const fixture = historyReaderFixture();
    fixture.reader.get = () => {
      throw new RecallHistoryError(
        "RECALL_SOURCE_NOT_FOUND",
        "No recallable source in this session.",
      );
    };
    const registry = new ToolRegistry();
    registry.register(createRecallToolExecutor({ historyReader: fixture.reader }));
    const runtime = new ToolRuntime(registry);
    const identity = createTestRuntime();

    const invalidArgs = await runtime.execute(
      identity.toolCall({
        name: "Recall",
        args: { mode: "search", query: "", source: fixture.source },
      }),
      context,
    );
    expect(invalidArgs).toMatchObject({
      kind: "recall",
      ok: false,
      mode: "search",
      errorCode: "RECALL_ARGS_INVALID",
    });

    const invalidSource = await runtime.execute(
      identity.toolCall({
        name: "Recall",
        args: { mode: "get", source: "ctx://message/not-a-uuid" },
      }),
      context,
    );
    expect(invalidSource).toMatchObject({
      kind: "recall",
      ok: false,
      mode: "get",
      errorCode: "RECALL_SOURCE_INVALID",
    });

    const missing = await runtime.execute(
      identity.toolCall({
        name: "Recall",
        args: { mode: "get", source: fixture.source },
      }),
      context,
    );
    expect(missing).toMatchObject({
      kind: "recall",
      ok: false,
      mode: "get",
      errorCode: "RECALL_SOURCE_NOT_FOUND",
    });
  });

  test("rethrows required history failures through the fatal tool boundary", async () => {
    const fixture = historyReaderFixture();
    fixture.reader.search = () => {
      throw new SessionError("SESSION_READ_FAILED", "recall_search", "storage failed");
    };
    const registry = new ToolRegistry();
    registry.register(createRecallToolExecutor({ historyReader: fixture.reader }));
    const runtime = new ToolRuntime(registry);
    const identity = createTestRuntime();

    expect(
      runtime.execute(
        identity.toolCall({
          name: "Recall",
          args: { mode: "search", query: "history" },
        }),
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionFatalError);
  });

  test("renders deterministic historical observations and honest empty results", () => {
    const fixture = historyReaderFixture();
    const identity = createTestRuntime();
    const call = identity.toolCall({
      name: "Recall",
      args: { mode: "search", query: "EACCES" },
    });
    const builder = new ObservationBuilder();
    const search = builder.build({
      call,
      raw: {
        kind: "recall",
        ok: true,
        mode: "search",
        historical: true,
        query: "EACCES",
        filters: {},
        page: fixture.searchPage,
      },
    }).content;
    expect(search).toContain(
      "Recall searched historical session data.\nhistorical=true",
    );
    expect(search).toContain(`source=${fixture.source}`);
    expect(search).toContain("toolName=Read");
    expect(search).toContain("excerpt:\nerror: EACCES");

    const get = builder.build({
      call,
      raw: {
        kind: "recall",
        ok: true,
        mode: "get",
        historical: true,
        page: fixture.getPage,
      },
    }).content;
    expect(get).toBe(
      [
        "Recall retrieved historical session data.",
        "historical=true",
        `source=${fixture.source}`,
        "role=tool",
        "toolName=Read",
        "turnNumber=3",
        "ordinal=17",
        "createdAt=2026-07-12T00:00:00.000Z",
        `contentSha256=${"a".repeat(64)}`,
        "totalBytes=15",
        "byteOffset=0",
        "returnedBytes=15",
        "nextByteOffset=null",
        "currentWorkspaceGuidance=Use Read/Grep to verify current files; this content is historical.",
        "content:",
        "historical body",
      ].join("\n"),
    );

    const empty = builder.build({
      call,
      raw: {
        kind: "recall",
        ok: true,
        mode: "search",
        historical: true,
        query: "missing",
        filters: {},
        page: { ...fixture.searchPage, hits: [] },
      },
    }).content;
    expect(empty).toContain(
      "No matches were found in the current session for the supplied query, filters, and search snapshot. This does not prove that the information does not exist.",
    );
  });
});

function historyReaderFixture() {
  const sessionId = runtimeIdFactory.createSessionId();
  const messageId = runtimeIdFactory.createMessageId();
  const source = formatMessageSource(messageId);
  const hit = {
    source,
    messageId,
    ordinal: 17,
    role: "tool" as const,
    origin: "tool" as const,
    toolName: "Read",
    turnNumber: 3,
    iterationNumber: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    contentSha256: "a".repeat(64),
    excerpt: "error: EACCES",
  };
  const searchPage = {
    strategy: "fts5_trigram" as const,
    snapshotThroughOrdinal: 20,
    offset: 0,
    limit: 10,
    hits: [hit],
  };
  const getPage = {
    ...hit,
    totalBytes: 15,
    byteOffset: 0,
    returnedBytes: 15,
    content: "historical body",
  };
  const searchInputs: unknown[] = [];
  const getInputs: unknown[] = [];
  const reader: SessionHistoryReader = {
    sessionId,
    search(input) {
      searchInputs.push(input);
      return searchPage;
    },
    get(input) {
      getInputs.push(input);
      return getPage;
    },
  };
  return {
    reader,
    source,
    searchPage,
    getPage,
    searchInputs,
    getInputs,
  };
}
