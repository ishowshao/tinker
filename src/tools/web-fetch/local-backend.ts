import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { WebFetchBackend, WebFetchBackendResult } from "./backend";

export type LocalBackendOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

// Some sites (e.g. mp.weixin.qq.com) serve an anti-bot page to non-browser
// user agents; present a regular Chrome UA instead of Bun's default.
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

export function createLocalWebFetchBackend(
  options: LocalBackendOptions = {},
): WebFetchBackend {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  return {
    route: "local",
    async fetch(input): Promise<WebFetchBackendResult> {
      let currentUrl = new URL(input.url);
      let response: Response;

      for (let redirects = 0; ; redirects += 1) {
        try {
          response = await fetchImpl(currentUrl.toString(), {
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              accept: "text/html, text/markdown;q=0.9, */*;q=0.8",
              "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
              "user-agent": CHROME_USER_AGENT,
            },
          });
        } catch (error) {
          return { ok: false, error: requestErrorMessage(error, timeoutMs) };
        }

        if (!isRedirectStatus(response.status)) {
          break;
        }

        const location = response.headers.get("location");
        if (location === null || location === "") {
          return {
            ok: false,
            httpStatusCode: response.status,
            error: `Redirect response (HTTP ${response.status}) is missing a location header.`,
          };
        }

        const nextUrl = new URL(location, currentUrl);
        if (nextUrl.hostname !== currentUrl.hostname) {
          return { ok: true, redirectUrl: nextUrl.toString() };
        }

        if (redirects + 1 > maxRedirects) {
          return {
            ok: false,
            error: `Too many redirects (more than ${maxRedirects}).`,
          };
        }

        currentUrl = nextUrl;
      }

      if (!response.ok) {
        return {
          ok: false,
          httpStatusCode: response.status,
          error: `Request failed with HTTP ${response.status}.`,
        };
      }

      const declaredLength = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        return {
          ok: false,
          error: `Response body exceeds the ${maxBodyBytes} byte limit.`,
        };
      }

      let bodyBytes: ArrayBuffer;
      try {
        bodyBytes = await response.arrayBuffer();
      } catch (error) {
        return {
          ok: false,
          error: `Failed to read response body: ${errorMessage(error)}`,
        };
      }

      if (bodyBytes.byteLength > maxBodyBytes) {
        return {
          ok: false,
          error: `Response body exceeds the ${maxBodyBytes} byte limit.`,
        };
      }

      const body = new TextDecoder().decode(bodyBytes);
      const contentType = mimeType(response.headers.get("content-type"));
      const finalUrl = currentUrl.toString();

      if (contentType === "text/html" || contentType === "application/xhtml+xml") {
        const extracted = extractMarkdownFromHtml(body);
        return {
          ok: true,
          finalUrl,
          title: extracted.title,
          markdown: extracted.markdown,
        };
      }

      if (
        contentType === "" ||
        contentType.startsWith("text/") ||
        contentType === "application/xml"
      ) {
        return { ok: true, finalUrl, markdown: body };
      }

      if (contentType === "application/json" || contentType.endsWith("+json")) {
        return { ok: true, finalUrl, markdown: prettyPrintJson(body) };
      }

      return {
        ok: false,
        error: `Unsupported content type: ${contentType}. WebFetch supports HTML, text, markdown, and JSON.`,
      };
    },
  };
}

// Accept the Readability extraction only if it keeps at least this share of
// the page text; below that it likely dropped the real content.
const READABILITY_MIN_KEEP_RATIO = 0.2;

// Article extraction only pays off on text-heavy pages. On small pages
// (app UIs, dashboards) Readability tends to pick one region and drop
// sidebars and controls, so convert the whole body instead.
const READABILITY_MIN_TEXT_CHARS = 4000;

export function extractMarkdownFromHtml(html: string): {
  title?: string;
  markdown: string;
} {
  const { document } = parseHTML(html);

  for (const node of document.querySelectorAll("script, style, noscript, template")) {
    node.remove();
  }

  revealJsHiddenContent(document);

  let title = document.querySelector("title")?.textContent?.trim() || undefined;
  const fallbackHtml = document.body?.innerHTML ?? html;
  const bodyTextLength = document.body?.textContent?.trim().length ?? 0;
  let contentHtml: string | undefined;

  if (bodyTextLength >= READABILITY_MIN_TEXT_CHARS) {
    try {
      // Readability mutates the document; fallbackHtml is captured above.
      const article = new Readability(document).parse();
      const articleTextLength = article?.textContent?.trim().length ?? 0;
      if (
        article?.content !== undefined &&
        article.content !== null &&
        articleTextLength >= bodyTextLength * READABILITY_MIN_KEEP_RATIO
      ) {
        contentHtml = article.content;
        title = article.title?.trim() || title;
      }
    } catch {
      // Readability can fail on non-article pages; fall back to the full body.
    }
  }

  contentHtml ??= fallbackHtml;

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });

  return { title, markdown: turndown.turndown(contentHtml).trim() };
}

// Pages like mp.weixin.qq.com ship the article hidden behind
// visibility:hidden/opacity:0 until their JavaScript reveals it. A static
// fetch never runs that JavaScript, so undo the hiding before extraction.
function revealJsHiddenContent(document: Document): void {
  for (const node of document.querySelectorAll(
    '[style*="visibility"], [style*="opacity"]',
  )) {
    const style = node.getAttribute("style");
    if (style === null) {
      continue;
    }

    const revealed = style.replace(
      /(?:visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d]))\s*;?/gi,
      "",
    );
    if (revealed !== style) {
      node.setAttribute("style", revealed);
    }
  }
}

function prettyPrintJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function mimeType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function requestErrorMessage(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `Request timed out after ${timeoutMs}ms.`;
  }

  return `Request failed: ${errorMessage(error)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
