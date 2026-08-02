import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type {
  ConsoleMessage,
  Frame,
  HTTPRequest,
  HTTPResponse,
  Page,
} from "puppeteer-core";
import {
  MAX_DEBUG_OUTPUT_CODE_POINTS,
  MAX_DEBUG_TEXT_CODE_POINTS,
} from "../src/constants";
import {
  formatConsoleDetail,
  formatConsoleList,
  formatNetworkDetail,
  formatNetworkList,
} from "../extension/src/debug-formatters";
import {
  type CollectedItem,
  NetworkCollector,
  PageCollector,
} from "../extension/src/page-collector";

describe("Tinker Chrome debug collection", () => {
  test("assigns stable IDs and preserves only the latest three navigations", () => {
    const page = new FakePage();
    const collector = new TestCollector(page.asPage());
    collector.add("first");
    page.navigate();
    collector.add("second");
    page.navigate();
    collector.add("third");
    page.navigate();
    collector.add("fourth");

    expect(collector.getData(false).map((entry) => entry.item)).toEqual(["fourth"]);
    expect(collector.getData(true).map((entry) => entry.item)).toEqual([
      "second",
      "third",
      "fourth",
    ]);
    expect(collector.getById(1)).toBeUndefined();
    expect(collector.getById(4)?.item).toBe("fourth");
    collector.dispose();
  });

  test("moves the document request into the new navigation bucket", () => {
    const page = new FakePage();
    const collector = new NetworkCollector(page.asPage());
    const preload = fakeRequest({ url: "https://example.com/preload" });
    const document = fakeRequest({
      url: "https://example.com/next",
      navigation: true,
      frame: page.mainFrame(),
      resourceType: "document",
    });
    page.emit("request", preload);
    page.emit("request", document);
    page.navigate();

    expect(collector.getData(false).map((entry) => entry.item.url())).toEqual([
      "https://example.com/next",
    ]);
    expect(collector.getData(true).map((entry) => entry.item.url())).toEqual([
      "https://example.com/preload",
      "https://example.com/next",
    ]);
    collector.dispose();
  });

  test("bounds each navigation without reusing discarded IDs", () => {
    const page = new FakePage();
    const collector = new TestCollector(page.asPage(), 2);
    collector.add("first");
    collector.add("second");
    collector.add("third");

    expect(collector.getData(false)).toEqual([
      { id: 2, item: "second" },
      { id: 3, item: "third" },
    ]);
    expect(collector.getById(1)).toBeUndefined();
    collector.dispose();
  });
});

describe("Tinker Chrome debug formatting", () => {
  test("groups console summaries and resolves bounded details", async () => {
    const message = fakeConsoleMessage("ready", { answer: 42 });
    const entries: Array<CollectedItem<ConsoleMessage>> = [
      { id: 1, item: message },
      { id: 2, item: message },
    ];
    const list = formatConsoleList(entries, { pageIdx: 0, pageSize: 50 });
    expect(list.output).toContain("msgid=1 [log] ready (1 args) [2 times]");
    expect(list.totalItems).toBe(1);

    const detail = await formatConsoleDetail(entries[0]);
    expect(detail.output).toContain('Arg #0: {"answer":42}');
    expect(detail.output).toContain("at https://example.com/app.js:3:5");
  });

  test("formats network list/detail with redacted headers and bounded bodies", async () => {
    const request = fakeRequest({
      url: "https://example.com/api",
      resourceType: "fetch",
      requestHeaders: { authorization: "Bearer secret", accept: "application/json" },
      responseHeaders: {
        "set-cookie": "token=secret",
        "content-type": "application/json",
      },
      responseBody: '{"ok":true}',
      status: 200,
    });
    const entry = { id: 7, item: request };
    const list = formatNetworkList([entry], { pageIdx: 0, pageSize: 50 });
    expect(list.output).toContain(
      "reqid=7 GET https://example.com/api [200] type=fetch",
    );

    const detail = await formatNetworkDetail(entry, () => undefined);
    expect(detail.output).toContain("authorization: <redacted>");
    expect(detail.output).toContain("set-cookie: <redacted>");
    expect(detail.output).not.toContain("Bearer secret");
    expect(detail.output).toContain('{"ok":true}');
  });

  test("resets invalid pagination and bounds list and body observations", async () => {
    const body = "x".repeat(MAX_DEBUG_TEXT_CODE_POINTS + 100);
    const request = fakeRequest({
      url: `https://example.com/${"u".repeat(MAX_DEBUG_OUTPUT_CODE_POINTS)}`,
      status: 200,
    });
    const entry = { id: 1, item: request };

    const list = formatNetworkList([entry], { pageIdx: 99, pageSize: 1 });
    expect(list.pageIdx).toBe(0);
    expect(list.truncated).toBe(true);
    expect(Array.from(list.output)).toHaveLength(MAX_DEBUG_OUTPUT_CODE_POINTS);

    const detail = await formatNetworkDetail(
      {
        id: 2,
        item: fakeRequest({
          url: "https://example.com/large-response",
          responseBody: body,
          status: 200,
        }),
      },
      () => undefined,
    );
    expect(detail.output).toContain("... <truncated>");
    expect(Array.from(detail.output).length).toBeLessThanOrEqual(
      MAX_DEBUG_OUTPUT_CODE_POINTS,
    );
  });
});

class FakePage extends EventEmitter {
  private readonly frame = {} as Frame;

  asPage(): Page {
    return this as unknown as Page;
  }

  mainFrame(): Frame {
    return this.frame;
  }

  navigate(): void {
    this.emit("framenavigated", this.frame);
  }
}

class TestCollector extends PageCollector<string> {
  add(value: string): void {
    this.collect(value);
  }
}

function fakeConsoleMessage(text: string, argument: unknown): ConsoleMessage {
  return {
    type: () => "log",
    text: () => text,
    args: () => [{ jsonValue: () => Promise.resolve(argument) }],
    location: () => ({
      url: "https://example.com/app.js",
      lineNumber: 2,
      columnNumber: 4,
    }),
    stackTrace: () => [
      {
        url: "https://example.com/app.js",
        lineNumber: 2,
        columnNumber: 4,
      },
    ],
  } as unknown as ConsoleMessage;
}

function fakeRequest(options: {
  url: string;
  navigation?: boolean;
  frame?: Frame | null;
  resourceType?: ReturnType<HTTPRequest["resourceType"]>;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  status?: number;
}): HTTPRequest {
  const response =
    options.status === undefined
      ? null
      : ({
          status: () => options.status,
          headers: () => options.responseHeaders ?? {},
          content: () =>
            Promise.resolve(new TextEncoder().encode(options.responseBody ?? "")),
        } as unknown as HTTPResponse);
  return {
    url: () => options.url,
    method: () => "GET",
    resourceType: () => options.resourceType ?? "fetch",
    response: () => response,
    failure: () => null,
    headers: () => options.requestHeaders ?? {},
    hasPostData: () => false,
    fetchPostData: () => Promise.resolve(undefined),
    postData: () => undefined,
    redirectChain: () => [],
    frame: () => options.frame ?? null,
    isNavigationRequest: () => options.navigation ?? false,
  } as unknown as HTTPRequest;
}
