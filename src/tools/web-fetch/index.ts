import type { ToolExecutor, WebFetchRawResult } from "../types";
import type { WebFetchBackend, WebFetchBackendResult, WebFetchRoute } from "./backend";
import {
  createBrowserWebFetchBackend,
  isBrowserBackendAvailable,
} from "./browser-backend";
import { createExaWebFetchBackend } from "./exa-backend";
import { createLocalWebFetchBackend } from "./local-backend";
import type { Refiner } from "./refiner";
import { decideRoute, isPrivateHost, shouldEscalateToBrowser } from "./route";

type WebFetchArgs = {
  url: string;
  prompt: string;
};

export type WebFetchToolOptions = {
  exaApiKey?: string;
  refiner?: Refiner;
  fetchImpl?: typeof fetch;
  refineThreshold?: number;
  cacheTtlMs?: number;
  browserBackend?: WebFetchBackend | false;
};

export const WEB_FETCH_DEFAULT_REFINE_THRESHOLD = 2000;
export const WEB_FETCH_DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;

type CacheEntry = {
  expiresAt: number;
  result: WebFetchRawResult;
};

export function createWebFetchToolExecutor(
  options: WebFetchToolOptions = {},
): ToolExecutor {
  const localBackend = createLocalWebFetchBackend({ fetchImpl: options.fetchImpl });
  const exaBackend: WebFetchBackend | undefined =
    options.exaApiKey !== undefined && options.exaApiKey.trim() !== ""
      ? createExaWebFetchBackend({
          apiKey: options.exaApiKey,
          fetchImpl: options.fetchImpl,
        })
      : undefined;
  const browserBackend: WebFetchBackend | undefined =
    options.browserBackend === false
      ? undefined
      : (options.browserBackend ??
        (isBrowserBackendAvailable() ? createBrowserWebFetchBackend() : undefined));
  const refineThreshold =
    options.refineThreshold ??
    parsePositiveInteger(
      process.env.TINKER_WEBFETCH_REFINE_THRESHOLD,
      WEB_FETCH_DEFAULT_REFINE_THRESHOLD,
    );
  const cacheTtlMs = options.cacheTtlMs ?? WEB_FETCH_DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  return {
    definition: {
      name: "WebFetch",
      description: [
        "Fetch content from a URL and process it according to the prompt.",
        "- Small pages are returned as markdown; large pages are condensed into an answer to the prompt",
        "- Supports public web pages as well as localhost and private-network URLs",
        "- HTTP URLs on the public web are upgraded to HTTPS",
        "- If the page redirects to a different host, the redirect URL is returned; call WebFetch again with that URL",
        "- Use it to read documentation, pages found via WebSearch, or local dev server responses",
      ].join("\n"),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            format: "uri",
            description: "The URL to fetch content from",
          },
          prompt: {
            type: "string",
            minLength: 1,
            description: "The prompt to run on the fetched content",
          },
        },
        required: ["url", "prompt"],
      },
    },
    async execute(args): Promise<WebFetchRawResult> {
      const parsed = parseWebFetchArgs(args);

      if (!parsed.ok) {
        return { ok: false, url: "", error: parsed.error };
      }

      const input = parsed.value;
      const url = normalizeUrl(input.url);
      const cacheKey = `${url.toString()}\n${input.prompt}`;
      pruneCache(cache);

      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        return { ...cached.result, cacheHit: true };
      }

      let route = decideRoute(url, {
        hasExaBackend: exaBackend !== undefined,
        hasBrowserBackend: browserBackend !== undefined,
      });
      const backends: Record<WebFetchRoute, WebFetchBackend | undefined> = {
        local: localBackend,
        exa: exaBackend,
        "local-browser": browserBackend,
      };

      const startedAt = Date.now();
      let backendResult: WebFetchBackendResult = await (
        backends[route] ?? localBackend
      ).fetch({
        url: url.toString(),
        prompt: input.prompt,
      });

      if (
        route === "local" &&
        browserBackend !== undefined &&
        shouldEscalateToBrowser(backendResult)
      ) {
        const browserResult = await browserBackend.fetch({
          url: url.toString(),
          prompt: input.prompt,
        });
        if (browserResult.ok && (browserResult.markdown ?? "").trim() !== "") {
          backendResult = browserResult;
          route = "local-browser";
        }
      }

      const durationMs = Date.now() - startedAt;

      const base: WebFetchRawResult = {
        ok: false,
        url: url.toString(),
        route,
        durationMs,
        finalUrl: backendResult.finalUrl,
        title: backendResult.title,
        publishedDate: backendResult.publishedDate,
        source: backendResult.source,
        costDollars: backendResult.costDollars,
        errorTag: backendResult.errorTag,
        httpStatusCode: backendResult.httpStatusCode,
      };

      if (!backendResult.ok) {
        return { ...base, error: backendResult.error ?? "Unknown error." };
      }

      if (backendResult.redirectUrl !== undefined) {
        return { ...base, ok: true, redirectUrl: backendResult.redirectUrl };
      }

      const markdown = backendResult.markdown ?? "";
      if (markdown.trim() === "") {
        return { ...base, error: "The page returned no readable content." };
      }

      let result: WebFetchRawResult;

      if (markdown.length <= refineThreshold) {
        result = { ...base, ok: true, refined: false, content: markdown };
      } else if (backendResult.refined !== undefined) {
        result = {
          ...base,
          ok: true,
          refined: true,
          content: backendResult.refined,
          highlights: backendResult.highlights,
        };
      } else if (options.refiner === undefined) {
        return {
          ...base,
          error: `The page content is ${markdown.length} characters and no refiner is configured to condense it.`,
        };
      } else {
        try {
          const refined = await options.refiner.refine({
            url: url.toString(),
            prompt: input.prompt,
            content: markdown,
          });
          result = { ...base, ok: true, refined: true, content: refined };
        } catch (error) {
          return {
            ...base,
            error: `Failed to refine the page content: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      result.durationMs = Date.now() - startedAt;
      cache.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, result });
      return result;
    },
  };
}

function parseWebFetchArgs(
  args: unknown,
): { ok: true; value: WebFetchArgs } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "WebFetch arguments must be an object." };
  }

  if (typeof args.url !== "string" || args.url.trim() === "") {
    return { ok: false, error: "WebFetch.url must be a non-empty string." };
  }

  let url: URL;
  try {
    url = new URL(args.url.trim());
  } catch {
    return { ok: false, error: `WebFetch.url is not a valid URL: ${args.url}` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      error: `WebFetch.url must use http or https, received ${url.protocol.replace(":", "")}.`,
    };
  }

  if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
    return { ok: false, error: "WebFetch.prompt must be a non-empty string." };
  }

  return {
    ok: true,
    value: { url: url.toString(), prompt: args.prompt.trim() },
  };
}

function normalizeUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);

  if (url.protocol === "http:" && url.port === "" && !isPrivateHost(url.hostname)) {
    url.protocol = "https:";
  }

  return url;
}

function pruneCache(cache: Map<string, CacheEntry>): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
