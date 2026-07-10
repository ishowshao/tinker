import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling, ToolRegistry, ToolRuntime } from "../tools/registry";
import { createWebSearchToolExecutor as createWebSearchToolExecutorBase } from "../tools/web-search";
import type { ToolExecutionContext, WebSearchRawResult } from "../tools/types";
import type { ToolCall } from "../agent/types";
import { TurnCancelledError } from "../agent/turn-cancellation";

const testToolContext: ToolExecutionContext = {
  signal: new AbortController().signal,
};

function createWebSearchToolExecutor(
  options: Parameters<typeof createWebSearchToolExecutorBase>[0],
) {
  const tool = createWebSearchToolExecutorBase(options);
  return {
    ...tool,
    execute: (
      args: unknown,
      call: ToolCall,
      context: ToolExecutionContext = testToolContext,
    ) => tool.execute(args, call, context),
  };
}

type CapturedRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

function createFetchStub(input: {
  status?: number;
  payload?: unknown;
  rawBody?: string;
  error?: Error;
}): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];

  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
    });

    if (input.error !== undefined) {
      throw input.error;
    }

    const body = input.rawBody ?? JSON.stringify(input.payload);
    return new Response(body, { status: input.status ?? 200 });
  }) as typeof fetch;

  return { fetchImpl, requests };
}

const samplePayload = {
  requestId: "req_1",
  searchType: "auto",
  results: [
    {
      title: "Bun 2.0 released",
      url: "https://bun.sh/blog/bun-v2",
      publishedDate: "2026-06-01T00:00:00.000Z",
      author: "Bun team",
      highlights: ["Bun 2.0 ships a\nfaster runtime.", "New bundler features."],
      highlightScores: [0.9, 0.7],
    },
    {
      title: "",
      url: "https://example.com/untitled",
    },
  ],
  costDollars: { total: 0.007 },
};

describe("WebSearch tool", () => {
  test("propagates turn cancellation instead of returning a network failure", async () => {
    const controller = new AbortController();
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("request aborted")),
          { once: true },
        );
      })) as typeof fetch;
    const tool = createWebSearchToolExecutor({
      apiKey: "exa-key",
      fetchImpl,
    });

    const pending = tool.execute(
      { query: "latest bun release" },
      { id: "call_1", name: "WebSearch", args: {} },
      { signal: controller.signal },
    );
    controller.abort(new TurnCancelledError());

    expect(pending).rejects.toBeInstanceOf(TurnCancelledError);
  });

  test("sends a Claude Code-aligned request mapped to the Exa /search API", async () => {
    const { fetchImpl, requests } = createFetchStub({ payload: samplePayload });
    const tool = createWebSearchToolExecutor({ apiKey: "exa-key", fetchImpl });

    const raw = (await tool.execute(
      {
        query: "bun 2.0 release notes",
        allowed_domains: ["bun.sh"],
        blocked_domains: ["pinterest.com"],
      },
      { id: "call_1", name: "WebSearch", args: {} },
    )) as WebSearchRawResult;

    expect(raw.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.exa.ai/search");
    expect(requests[0]?.headers["x-api-key"]).toBe("exa-key");
    expect(requests[0]?.body).toEqual({
      query: "bun 2.0 release notes",
      type: "auto",
      numResults: 10,
      contents: { highlights: true },
      includeDomains: ["bun.sh"],
      excludeDomains: ["pinterest.com"],
    });
  });

  test("maps the Exa response to a raw result", async () => {
    const { fetchImpl } = createFetchStub({ payload: samplePayload });
    const tool = createWebSearchToolExecutor({ apiKey: "exa-key", fetchImpl });

    const raw = (await tool.execute(
      { query: "bun 2.0 release notes" },
      { id: "call_1", name: "WebSearch", args: {} },
    )) as WebSearchRawResult;

    expect(raw.ok).toBe(true);
    expect(raw.searchType).toBe("auto");
    expect(raw.requestId).toBe("req_1");
    expect(raw.resultCount).toBe(2);
    expect(raw.costDollars).toBe(0.007);
    expect(raw.results?.[0]).toEqual({
      title: "Bun 2.0 released",
      url: "https://bun.sh/blog/bun-v2",
      publishedDate: "2026-06-01T00:00:00.000Z",
      author: "Bun team",
      highlights: ["Bun 2.0 ships a\nfaster runtime.", "New bundler features."],
    });
    expect(raw.results?.[1]?.title).toBe("");
    expect(raw.results?.[1]?.highlights).toBeUndefined();
  });

  test("rejects a missing or too-short query", async () => {
    const { fetchImpl, requests } = createFetchStub({ payload: samplePayload });
    const tool = createWebSearchToolExecutor({ apiKey: "exa-key", fetchImpl });

    const missing = (await tool.execute(
      {},
      { id: "call_1", name: "WebSearch", args: {} },
    )) as WebSearchRawResult;
    const tooShort = (await tool.execute(
      { query: "a" },
      { id: "call_2", name: "WebSearch", args: {} },
    )) as WebSearchRawResult;

    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("WebSearch.query");
    expect(tooShort.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  test("rejects invalid domain filters", async () => {
    const { fetchImpl } = createFetchStub({ payload: samplePayload });
    const tool = createWebSearchToolExecutor({ apiKey: "exa-key", fetchImpl });

    const raw = (await tool.execute(
      { query: "bun release", allowed_domains: ["bun.sh", 42] },
      { id: "call_1", name: "WebSearch", args: {} },
    )) as WebSearchRawResult;

    expect(raw.ok).toBe(false);
    expect(raw.error).toContain("WebSearch.allowed_domains");
  });

  test("reports API errors with status and message", async () => {
    const { fetchImpl } = createFetchStub({
      status: 401,
      payload: { error: "Invalid API key" },
    });
    const tool = createWebSearchToolExecutor({ apiKey: "bad-key", fetchImpl });

    const raw = (await tool.execute(
      { query: "bun release" },
      { id: "call_1", name: "WebSearch", args: {} },
    )) as WebSearchRawResult;

    expect(raw.ok).toBe(false);
    expect(raw.error).toContain("HTTP 401");
    expect(raw.error).toContain("Invalid API key");
  });

  test("reports network failures", async () => {
    const { fetchImpl } = createFetchStub({ error: new Error("connect ECONNREFUSED") });
    const tool = createWebSearchToolExecutor({ apiKey: "exa-key", fetchImpl });

    const raw = (await tool.execute(
      { query: "bun release" },
      { id: "call_1", name: "WebSearch", args: {} },
    )) as WebSearchRawResult;

    expect(raw.ok).toBe(false);
    expect(raw.error).toContain("connect ECONNREFUSED");
  });

  test("rejects a malformed response body", async () => {
    const { fetchImpl } = createFetchStub({ rawBody: "not json" });
    const tool = createWebSearchToolExecutor({ apiKey: "exa-key", fetchImpl });

    const raw = (await tool.execute(
      { query: "bun release" },
      { id: "call_1", name: "WebSearch", args: {} },
    )) as WebSearchRawResult;

    expect(raw.ok).toBe(false);
    expect(raw.error).toContain("non-JSON");
  });

  test("requires a non-empty API key at creation time", () => {
    expect(() => createWebSearchToolExecutor({ apiKey: "  " })).toThrow(
      "non-empty Exa API key",
    );
  });

  test("is executable through the tool registry", async () => {
    const { fetchImpl } = createFetchStub({ payload: samplePayload });
    const registry = new ToolRegistry();
    registry.register(createWebSearchToolExecutor({ apiKey: "exa-key", fetchImpl }));
    const runtime = new ToolRuntime(registry);

    const raw = await runtime.execute(
      {
        id: "call_1",
        name: "WebSearch",
        args: { query: "bun release" },
      },
      testToolContext,
    );

    expect(raw.ok).toBe(true);
    expect(registry.definitions().map((definition) => definition.name)).toContain(
      "WebSearch",
    );
  });
  test("default tooling registers WebSearch only when an API key is configured", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-websearch-"));

    try {
      const withKey = createDefaultTooling({
        workspaceRoot: workspace,
        exaApiKey: "exa-key",
      });
      const withoutKey = createDefaultTooling({
        workspaceRoot: workspace,
        exaApiKey: "",
      });

      const toolNames = (tooling: typeof withKey) =>
        tooling.registry.definitions().map((definition) => definition.name);

      expect(toolNames(withKey)).toContain("WebSearch");
      expect(toolNames(withoutKey)).not.toContain("WebSearch");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("WebSearch observation", () => {
  test("renders numbered results with highlights collapsed to one line", async () => {
    const { fetchImpl } = createFetchStub({ payload: samplePayload });
    const tool = createWebSearchToolExecutor({ apiKey: "exa-key", fetchImpl });
    const call = {
      id: "call_1",
      name: "WebSearch",
      args: { query: "bun 2.0 release notes" },
    };
    const raw = await tool.execute(call.args, call);

    const observation = new ObservationBuilder().build({ call, raw });

    expect(observation.content).toContain(
      'Web search results for query "bun 2.0 release notes" (2 results):',
    );
    expect(observation.content).toContain("1. Bun 2.0 released");
    expect(observation.content).toContain("   URL: https://bun.sh/blog/bun-v2");
    expect(observation.content).toContain("   Published: 2026-06-01T00:00:00.000Z");
    expect(observation.content).toContain("   - Bun 2.0 ships a faster runtime.");
    expect(observation.content).toContain("2. https://example.com/untitled");
  });

  test("renders empty results and failures", async () => {
    const { fetchImpl } = createFetchStub({ payload: { results: [] } });
    const tool = createWebSearchToolExecutor({ apiKey: "exa-key", fetchImpl });
    const call = { id: "call_1", name: "WebSearch", args: { query: "no hits" } };
    const raw = await tool.execute(call.args, call);
    const builder = new ObservationBuilder();

    expect(builder.build({ call, raw }).content).toContain("(no results)");

    const failure = builder.build({
      call,
      raw: { ok: false, query: "no hits", error: "Exa /search returned HTTP 429" },
    });
    expect(failure.content).toBe(
      'WebSearch failed for query="no hits": Exa /search returned HTTP 429',
    );
  });
});
