import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling } from "../tools/registry";
import { createWebFetchToolExecutor as createWebFetchToolExecutorBase } from "../tools/web-fetch";
import {
  decideRoute,
  isPrivateHost,
  shouldEscalateToBrowser,
} from "../tools/web-fetch/route";
import type { WebFetchBackend } from "../tools/web-fetch/backend";
import type { Refiner } from "../tools/web-fetch/refiner";
import type { ToolCall } from "../agent/types";
import { createTestHistoryReader, createTestRuntime } from "./test-runtime";
import { TurnCancelledError } from "../agent/turn-cancellation";
import type { ToolExecutionContext, WebFetchRawResult } from "../tools/types";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

const testToolContext: ToolExecutionContext = {
  signal: new AbortController().signal,
};

function createWebFetchToolExecutor(
  options?: Parameters<typeof createWebFetchToolExecutorBase>[0],
) {
  const tool = createWebFetchToolExecutorBase(options);
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
  body?: Record<string, unknown>;
};

type StubResponse = {
  status?: number;
  body?: string;
  contentType?: string;
  location?: string;
};

function createFetchStub(responder: (url: string, callIndex: number) => StubResponse): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];

  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    if (typeof init?.body === "string") {
      request.body = JSON.parse(init.body) as Record<string, unknown>;
    }
    requests.push(request);

    const stub = responder(String(url), requests.length - 1);
    const headers: Record<string, string> = {};
    if (stub.contentType !== undefined) {
      headers["content-type"] = stub.contentType;
    }
    if (stub.location !== undefined) {
      headers.location = stub.location;
    }

    return new Response(stub.body ?? null, {
      status: stub.status ?? 200,
      headers,
    });
  }) as typeof fetch;

  return { fetchImpl, requests };
}

function createFakeRefiner(answer = "refined answer"): {
  refiner: Refiner;
  calls: { url: string; prompt: string; content: string }[];
} {
  const calls: { url: string; prompt: string; content: string }[] = [];
  return {
    calls,
    refiner: {
      async refine(input) {
        calls.push(input);
        return answer;
      },
    },
  };
}

function toolCall(args: unknown): ToolCall {
  return createTestRuntime().toolCall({
    providerToolCallId: "call_1",
    name: "WebFetch",
    args,
  });
}

function createFakeBrowserBackend(
  result: { markdown?: string; error?: string } = { markdown: "browser markdown" },
): { backend: WebFetchBackend; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    backend: {
      route: "local-browser",
      async fetch(input) {
        calls.push(input.url);
        return result.error !== undefined
          ? { ok: false, error: result.error }
          : { ok: true, finalUrl: input.url, markdown: result.markdown };
      },
    },
  };
}

const smallHtml =
  "<html><head><title>Docs</title></head><body><h1>Install</h1><p>Run bun install.</p></body></html>";

const longParagraphs = Array.from(
  { length: 60 },
  (_, index) =>
    `<p>Section ${index}: this paragraph exists to push the converted markdown well past the refine threshold of two thousand characters.</p>`,
).join("");
const largeHtml = `<html><head><title>Big page</title></head><body>${longParagraphs}</body></html>`;

describe("WebFetch router", () => {
  test("routes private hosts to local and public hosts to exa", () => {
    const hasExa = { hasExaBackend: true, hasBrowserBackend: false };

    expect(decideRoute(new URL("http://localhost:3000/"), hasExa)).toBe("local");
    expect(decideRoute(new URL("http://app.local/"), hasExa)).toBe("local");
    expect(decideRoute(new URL("http://service.internal/"), hasExa)).toBe("local");
    expect(decideRoute(new URL("http://127.0.0.1:8080/"), hasExa)).toBe("local");
    expect(decideRoute(new URL("http://10.1.2.3/"), hasExa)).toBe("local");
    expect(decideRoute(new URL("http://172.20.0.1/"), hasExa)).toBe("local");
    expect(decideRoute(new URL("http://192.168.1.10/"), hasExa)).toBe("local");
    expect(decideRoute(new URL("http://169.254.1.1/"), hasExa)).toBe("local");
    expect(decideRoute(new URL("https://bun.sh/docs"), hasExa)).toBe("exa");
  });

  test("routes forced-local hosts to local even with an Exa backend", () => {
    expect(
      decideRoute(new URL("https://mp.weixin.qq.com/s/abc123"), {
        hasExaBackend: true,
        hasBrowserBackend: false,
      }),
    ).toBe("local");
  });

  test("falls back to local when no Exa backend is configured", () => {
    expect(
      decideRoute(new URL("https://bun.sh/docs"), {
        hasExaBackend: false,
        hasBrowserBackend: false,
      }),
    ).toBe("local");
  });

  test("does not treat public hosts and IPs as private", () => {
    expect(isPrivateHost("bun.sh")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("172.15.0.1")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
    expect(isPrivateHost("mylocal.host.example.com")).toBe(false);
  });
});

describe("WebFetch local backend", () => {
  test("converts HTML to markdown and returns small pages unrefined", async () => {
    const { fetchImpl } = createFetchStub(() => ({
      body: smallHtml,
      contentType: "text/html; charset=utf-8",
    }));
    const { refiner, calls } = createFakeRefiner();
    const tool = createWebFetchToolExecutor({
      browserBackend: false,
      fetchImpl,
      refiner,
    });

    const raw = (await tool.execute(
      { url: "http://localhost:3000/docs", prompt: "how to install" },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(raw.ok).toBe(true);
    expect(raw.route).toBe("local");
    expect(raw.refined).toBe(false);
    expect(raw.title).toBe("Docs");
    expect(raw.content).toContain("# Install");
    expect(raw.content).toContain("Run bun install.");
    expect(calls).toHaveLength(0);
  });

  test("extracts content hidden behind visibility:hidden until JavaScript runs", async () => {
    const hiddenBody = Array.from(
      { length: 40 },
      (_, index) =>
        `<p>Hidden section ${index}: the page reveals this text with JavaScript after load.</p>`,
    ).join("");
    const html = `<html><head><title>Article</title></head><body><div id="teaser"><p>Teaser only.</p></div><div id="js_content" style="visibility: hidden; opacity: 0;">${hiddenBody}</div></body></html>`;
    const { fetchImpl } = createFetchStub(() => ({
      body: html,
      contentType: "text/html",
    }));
    const { refiner, calls } = createFakeRefiner("hidden sections summary");
    const tool = createWebFetchToolExecutor({
      browserBackend: false,
      fetchImpl,
      refiner,
    });

    const raw = (await tool.execute(
      { url: "http://localhost:3000/article", prompt: "summarize" },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(raw.ok).toBe(true);
    expect(raw.refined).toBe(true);
    expect(calls[0]?.content).toContain("Hidden section 39");
  });

  test("keeps sidebars and controls on small app-like pages", async () => {
    const appHtml = `<html><head><title>国际跳棋 · 人机对战</title></head><body>
      <header><h1>国际跳棋</h1><p>International Draughts · 人机对战</p></header>
      <main><div class="board">${Array.from({ length: 10 }, (_, i) => `<div>${i + 1}</div>`).join("")}</div></main>
      <aside>
        <p>你的回合（白方）</p>
        <p>你（白方）：20 子</p>
        <button>简单</button><button>中等</button><button>困难</button>
        <button>新游戏</button>
        <p>跳吃为强制，且必须选择吃子最多的走法</p>
      </aside>
    </body></html>`;
    const { fetchImpl } = createFetchStub(() => ({
      body: appHtml,
      contentType: "text/html",
    }));
    const tool = createWebFetchToolExecutor({ browserBackend: false, fetchImpl });

    const raw = (await tool.execute(
      { url: "http://localhost:5174/", prompt: "这个页面是什么" },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(raw.ok).toBe(true);
    expect(raw.content).toContain("新游戏");
    expect(raw.content).toContain("你的回合（白方）");
    expect(raw.content).toContain("跳吃为强制");
  });

  test("sends a regular Chrome user agent", async () => {
    const { fetchImpl, requests } = createFetchStub(() => ({
      body: smallHtml,
      contentType: "text/html",
    }));
    const tool = createWebFetchToolExecutor({ browserBackend: false, fetchImpl });

    await tool.execute(
      { url: "http://localhost:3000/docs", prompt: "install" },
      toolCall({}),
    );

    expect(requests[0]?.headers["user-agent"]).toContain("Chrome/");
    expect(requests[0]?.headers["accept-language"]).toContain("zh-CN");
  });

  test("does not upgrade localhost http URLs to https", async () => {
    const { fetchImpl, requests } = createFetchStub(() => ({
      body: smallHtml,
      contentType: "text/html",
    }));
    const tool = createWebFetchToolExecutor({ browserBackend: false, fetchImpl });

    await tool.execute(
      { url: "http://localhost:3000/docs", prompt: "install" },
      toolCall({}),
    );

    expect(requests[0]?.url).toBe("http://localhost:3000/docs");
  });

  test("upgrades public http URLs to https", async () => {
    const { fetchImpl, requests } = createFetchStub(() => ({
      body: smallHtml,
      contentType: "text/html",
    }));
    const tool = createWebFetchToolExecutor({ browserBackend: false, fetchImpl });

    await tool.execute(
      { url: "http://example.com/docs", prompt: "install" },
      toolCall({}),
    );

    expect(requests[0]?.url).toBe("https://example.com/docs");
  });

  test("follows same-host redirects and returns cross-host redirects", async () => {
    const sameHost = createFetchStub((url) =>
      url.endsWith("/old")
        ? { status: 302, location: "http://localhost:3000/new" }
        : { body: smallHtml, contentType: "text/html" },
    );
    const crossHost = createFetchStub(() => ({
      status: 302,
      location: "https://other.example.com/page",
    }));
    const tool = createWebFetchToolExecutor({
      browserBackend: false,
      fetchImpl: sameHost.fetchImpl,
    });
    const crossTool = createWebFetchToolExecutor({
      browserBackend: false,
      fetchImpl: crossHost.fetchImpl,
    });

    const followed = (await tool.execute(
      { url: "http://localhost:3000/old", prompt: "install" },
      toolCall({}),
    )) as WebFetchRawResult;
    const redirected = (await crossTool.execute(
      { url: "http://localhost:3000/old", prompt: "install" },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(followed.ok).toBe(true);
    expect(followed.content).toContain("Run bun install.");
    expect(sameHost.requests).toHaveLength(2);

    expect(redirected.ok).toBe(true);
    expect(redirected.redirectUrl).toBe("https://other.example.com/page");
    expect(crossHost.requests).toHaveLength(1);
  });

  test("passes through JSON and rejects unsupported content types", async () => {
    const json = createFetchStub(() => ({
      body: '{"status":"ok","port":3000}',
      contentType: "application/json",
    }));
    const image = createFetchStub(() => ({
      body: "binary",
      contentType: "image/png",
    }));
    const jsonTool = createWebFetchToolExecutor({
      browserBackend: false,
      fetchImpl: json.fetchImpl,
    });
    const imageTool = createWebFetchToolExecutor({
      browserBackend: false,
      fetchImpl: image.fetchImpl,
    });

    const jsonRaw = (await jsonTool.execute(
      { url: "http://localhost:3000/health", prompt: "status" },
      toolCall({}),
    )) as WebFetchRawResult;
    const imageRaw = (await imageTool.execute(
      { url: "http://localhost:3000/logo.png", prompt: "what is this" },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(jsonRaw.ok).toBe(true);
    expect(jsonRaw.content).toContain('"status": "ok"');
    expect(imageRaw.ok).toBe(false);
    expect(imageRaw.error).toContain("Unsupported content type: image/png");
  });

  test("reports HTTP errors with the status code", async () => {
    const { fetchImpl } = createFetchStub(() => ({ status: 404, body: "not found" }));
    const tool = createWebFetchToolExecutor({ browserBackend: false, fetchImpl });

    const raw = (await tool.execute(
      { url: "http://localhost:3000/missing", prompt: "content" },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(raw.ok).toBe(false);
    expect(raw.httpStatusCode).toBe(404);
    expect(raw.error).toContain("HTTP 404");
  });

  test("refines large pages with the injected refiner", async () => {
    const { fetchImpl } = createFetchStub(() => ({
      body: largeHtml,
      contentType: "text/html",
    }));
    const { refiner, calls } = createFakeRefiner("The page lists 60 sections.");
    const tool = createWebFetchToolExecutor({
      browserBackend: false,
      fetchImpl,
      refiner,
    });

    const raw = (await tool.execute(
      { url: "http://localhost:3000/big", prompt: "summarize the sections" },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(raw.ok).toBe(true);
    expect(raw.refined).toBe(true);
    expect(raw.content).toBe("The page lists 60 sections.");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("summarize the sections");
    expect(calls[0]?.content.length).toBeGreaterThan(2000);
  });

  test("fails clearly on large pages when no refiner is configured", async () => {
    const { fetchImpl } = createFetchStub(() => ({
      body: largeHtml,
      contentType: "text/html",
    }));
    const tool = createWebFetchToolExecutor({ browserBackend: false, fetchImpl });

    const raw = (await tool.execute(
      { url: "http://localhost:3000/big", prompt: "summarize" },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(raw.ok).toBe(false);
    expect(raw.error).toContain("no refiner is configured");
  });
});

describe("WebFetch exa backend", () => {
  const exaPayload = (text: string) => ({
    requestId: "req_1",
    results: [
      {
        url: "https://bun.sh/docs",
        title: "Bun Docs",
        publishedDate: "2026-01-01T00:00:00.000Z",
        text,
        summary: "Install bun with the install script.",
        highlights: ["curl -fsSL https://bun.sh/install | bash"],
      },
    ],
    statuses: [{ id: "https://bun.sh/docs", status: "success", source: "crawled" }],
    costDollars: { total: 0.002 },
  });

  test("maps the request to Exa /contents with text, summary, and highlights", async () => {
    const { fetchImpl, requests } = createFetchStub(() => ({
      body: JSON.stringify(exaPayload("short text")),
      contentType: "application/json",
    }));
    const tool = createWebFetchToolExecutor({
      browserBackend: false,
      exaApiKey: "exa-key",
      fetchImpl,
    });

    await tool.execute(
      { url: "https://bun.sh/docs", prompt: "how to install bun" },
      toolCall({}),
    );

    expect(requests[0]?.url).toBe("https://api.exa.ai/contents");
    expect(requests[0]?.headers["x-api-key"]).toBe("exa-key");
    expect(requests[0]?.body).toEqual({
      urls: ["https://bun.sh/docs"],
      text: { maxCharacters: 20000 },
      summary: { query: "how to install bun" },
      highlights: { query: "how to install bun" },
      livecrawlTimeout: 10000,
    });
  });

  test("returns raw text for small pages and the summary for large pages", async () => {
    const small = createFetchStub(() => ({
      body: JSON.stringify(exaPayload("Install bun via curl.")),
      contentType: "application/json",
    }));
    const large = createFetchStub(() => ({
      body: JSON.stringify(exaPayload("long ".repeat(600))),
      contentType: "application/json",
    }));
    const smallTool = createWebFetchToolExecutor({
      browserBackend: false,
      exaApiKey: "exa-key",
      fetchImpl: small.fetchImpl,
    });
    const largeTool = createWebFetchToolExecutor({
      browserBackend: false,
      exaApiKey: "exa-key",
      fetchImpl: large.fetchImpl,
    });

    const smallRaw = (await smallTool.execute(
      { url: "https://bun.sh/docs", prompt: "install" },
      toolCall({}),
    )) as WebFetchRawResult;
    const largeRaw = (await largeTool.execute(
      { url: "https://bun.sh/docs", prompt: "install" },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(smallRaw.ok).toBe(true);
    expect(smallRaw.route).toBe("exa");
    expect(smallRaw.refined).toBe(false);
    expect(smallRaw.content).toBe("Install bun via curl.");
    expect(smallRaw.source).toBe("crawled");
    expect(smallRaw.costDollars).toBe(0.002);

    expect(largeRaw.ok).toBe(true);
    expect(largeRaw.refined).toBe(true);
    expect(largeRaw.content).toBe("Install bun with the install script.");
    expect(largeRaw.highlights).toEqual(["curl -fsSL https://bun.sh/install | bash"]);
  });

  test("maps per-URL crawl errors from the statuses array", async () => {
    const { fetchImpl } = createFetchStub(() => ({
      body: JSON.stringify({
        requestId: "req_1",
        results: [],
        statuses: [
          {
            id: "https://bun.sh/gone",
            status: "error",
            error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 },
          },
        ],
      }),
      contentType: "application/json",
    }));
    const tool = createWebFetchToolExecutor({
      browserBackend: false,
      exaApiKey: "exa-key",
      fetchImpl,
    });

    const raw = (await tool.execute(
      { url: "https://bun.sh/gone", prompt: "content" },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(raw.ok).toBe(false);
    expect(raw.errorTag).toBe("CRAWL_NOT_FOUND");
    expect(raw.httpStatusCode).toBe(404);
    expect(raw.error).toContain("CRAWL_NOT_FOUND (HTTP 404)");
  });
});

describe("WebFetch browser escalation", () => {
  test("shouldEscalateToBrowser matches empty content and status-less failures", () => {
    expect(shouldEscalateToBrowser({ ok: true, markdown: "" })).toBe(true);
    expect(shouldEscalateToBrowser({ ok: false })).toBe(true);
    expect(shouldEscalateToBrowser({ ok: true, markdown: "content" })).toBe(false);
    expect(shouldEscalateToBrowser({ ok: false, httpStatusCode: 404 })).toBe(false);
    expect(
      shouldEscalateToBrowser({ ok: true, redirectUrl: "https://a.example.com" }),
    ).toBe(false);
  });

  test("escalates to the browser when static fetch yields no content", async () => {
    const emptyHtml = "<html><head><title>SPA</title></head><body></body></html>";
    const { fetchImpl } = createFetchStub(() => ({
      body: emptyHtml,
      contentType: "text/html",
    }));
    const { backend, calls } = createFakeBrowserBackend({
      markdown: "# Rendered by JavaScript",
    });
    const tool = createWebFetchToolExecutor({ fetchImpl, browserBackend: backend });

    const raw = (await tool.execute(
      { url: "http://localhost:3000/spa", prompt: "what does the app show" },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(raw.ok).toBe(true);
    expect(raw.route).toBe("local-browser");
    expect(raw.content).toBe("# Rendered by JavaScript");
    expect(calls).toEqual(["http://localhost:3000/spa"]);
  });

  test("does not escalate on definitive HTTP errors", async () => {
    const { fetchImpl } = createFetchStub(() => ({ status: 404, body: "not found" }));
    const { backend, calls } = createFakeBrowserBackend();
    const tool = createWebFetchToolExecutor({ fetchImpl, browserBackend: backend });

    const raw = (await tool.execute(
      { url: "http://localhost:3000/missing", prompt: "content" },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(raw.ok).toBe(false);
    expect(raw.route).toBe("local");
    expect(calls).toHaveLength(0);
  });

  test("keeps the local result when the browser also fails", async () => {
    const emptyHtml = "<html><body></body></html>";
    const { fetchImpl } = createFetchStub(() => ({
      body: emptyHtml,
      contentType: "text/html",
    }));
    const { backend } = createFakeBrowserBackend({ error: "browser crashed" });
    const tool = createWebFetchToolExecutor({ fetchImpl, browserBackend: backend });

    const raw = (await tool.execute(
      { url: "http://localhost:3000/spa", prompt: "content" },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(raw.ok).toBe(false);
    expect(raw.route).toBe("local");
    expect(raw.error).toContain("no readable content");
  });
});

describe("WebFetch pipeline", () => {
  test("does not cache a cancelled request", async () => {
    let fetchCalls = 0;
    const fetchImpl = ((_url: unknown, init?: RequestInit) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("request aborted")),
            { once: true },
          );
        });
      }

      return Promise.resolve(
        new Response(smallHtml, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
    }) as typeof fetch;
    const tool = createWebFetchToolExecutor({ browserBackend: false, fetchImpl });
    const call = toolCall({
      url: "http://localhost:3000/docs",
      prompt: "install",
    });
    const controller = new AbortController();

    const cancelled = tool.execute(call.args, call, {
      signal: controller.signal,
    });
    controller.abort(new TurnCancelledError("user"));
    expect(cancelled).rejects.toBeInstanceOf(TurnCancelledError);

    const retried = (await tool.execute(
      call.args,
      call,
      testToolContext,
    )) as WebFetchRawResult;
    expect(retried.ok).toBe(true);
    expect(retried.cacheHit).toBeUndefined();
    expect(fetchCalls).toBe(2);
  });

  test("caches successful results for repeated url+prompt", async () => {
    const { fetchImpl, requests } = createFetchStub(() => ({
      body: smallHtml,
      contentType: "text/html",
    }));
    const tool = createWebFetchToolExecutor({ browserBackend: false, fetchImpl });
    const args = { url: "http://localhost:3000/docs", prompt: "install" };

    const first = (await tool.execute(args, toolCall({}))) as WebFetchRawResult;
    const second = (await tool.execute(args, toolCall({}))) as WebFetchRawResult;

    expect(requests).toHaveLength(1);
    expect(first.cacheHit).toBeUndefined();
    expect(second.cacheHit).toBe(true);
    expect(second.content).toBe(first.content);
  });

  test("a different prompt for the same url bypasses the cache", async () => {
    const { fetchImpl, requests } = createFetchStub(() => ({
      body: smallHtml,
      contentType: "text/html",
    }));
    const tool = createWebFetchToolExecutor({ browserBackend: false, fetchImpl });

    await tool.execute(
      { url: "http://localhost:3000/docs", prompt: "install" },
      toolCall({}),
    );
    await tool.execute(
      { url: "http://localhost:3000/docs", prompt: "uninstall" },
      toolCall({}),
    );

    expect(requests).toHaveLength(2);
  });

  test("validates arguments", async () => {
    const { fetchImpl, requests } = createFetchStub(() => ({ body: smallHtml }));
    const tool = createWebFetchToolExecutor({ browserBackend: false, fetchImpl });

    const missingUrl = (await tool.execute(
      { prompt: "content" },
      toolCall({}),
    )) as WebFetchRawResult;
    const badScheme = (await tool.execute(
      { url: "ftp://example.com/file", prompt: "content" },
      toolCall({}),
    )) as WebFetchRawResult;
    const invalidUrl = (await tool.execute(
      { url: "not a url", prompt: "content" },
      toolCall({}),
    )) as WebFetchRawResult;
    const emptyPrompt = (await tool.execute(
      { url: "https://example.com", prompt: " " },
      toolCall({}),
    )) as WebFetchRawResult;

    expect(missingUrl.ok).toBe(false);
    expect(missingUrl.error).toContain("WebFetch.url");
    expect(badScheme.ok).toBe(false);
    expect(badScheme.error).toContain("http or https");
    expect(invalidUrl.ok).toBe(false);
    expect(invalidUrl.error).toContain("not a valid URL");
    expect(emptyPrompt.ok).toBe(false);
    expect(emptyPrompt.error).toContain("WebFetch.prompt");
    expect(requests).toHaveLength(0);
  });

  test("default tooling always registers WebFetch", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-webfetch-"));

    try {
      const withKeyRuntime = createTestRuntime().runtimeSession;
      const withKey = createDefaultTooling({
        workspaceRoot: workspace,
        exaApiKey: "exa-key",
        runtimeSession: withKeyRuntime,
        historyReader: createTestHistoryReader(withKeyRuntime.sessionId),
      });
      const withoutKeyRuntime = createTestRuntime().runtimeSession;
      const withoutKey = createDefaultTooling({
        workspaceRoot: workspace,
        exaApiKey: "",
        runtimeSession: withoutKeyRuntime,
        historyReader: createTestHistoryReader(withoutKeyRuntime.sessionId),
      });

      const toolNames = (tooling: typeof withKey) =>
        tooling.registry.definitions().map((definition) => definition.name);

      expect(toolNames(withKey)).toContain("WebFetch");
      expect(toolNames(withoutKey)).toContain("WebFetch");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("WebFetch observation", () => {
  test("renders content, redirects, and failures", async () => {
    const { fetchImpl } = createFetchStub(() => ({
      body: smallHtml,
      contentType: "text/html",
    }));
    const tool = createWebFetchToolExecutor({ browserBackend: false, fetchImpl });
    const call = toolCall({ url: "http://localhost:3000/docs", prompt: "install" });
    const raw = await tool.execute(call.args, call);
    const builder = new ObservationBuilder();

    const success = builder.build({ call, raw });
    expect(success.displayText).toContain(
      "Web fetch result for http://localhost:3000/docs (route=local, refined=false):",
    );
    expect(success.displayText).toContain("Title: Docs");
    expect(success.displayText).toContain("# Install");

    const redirect = builder.build({
      call,
      raw: {
        kind: "web_fetch",
        ok: true,
        url: "http://localhost:3000/docs",
        route: "local",
        redirectUrl: "https://other.example.com/page",
      },
    });
    expect(redirect.displayText).toContain(
      "WebFetch was redirected to https://other.example.com/page.",
    );
    expect(redirect.displayText).toContain("Call WebFetch again");

    const failure = builder.build({
      call,
      raw: {
        kind: "web_fetch",
        ok: false,
        url: "https://bun.sh/gone",
        error: "Exa could not fetch the page: CRAWL_NOT_FOUND (HTTP 404).",
      },
    });
    expect(failure.displayText).toBe(
      "WebFetch failed for https://bun.sh/gone: Exa could not fetch the page: CRAWL_NOT_FOUND (HTTP 404).",
    );
  });
});
