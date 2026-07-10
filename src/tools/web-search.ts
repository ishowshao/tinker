import { cancellationError, throwIfTurnCancelled } from "../agent/turn-cancellation";
import type {
  ToolExecutionContext,
  ToolExecutor,
  WebSearchRawResult,
  WebSearchResultItem,
} from "./types";

type WebSearchArgs = {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
};

export type WebSearchToolOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  numResults?: number;
  timeoutMs?: number;
};

export const WEB_SEARCH_DEFAULT_BASE_URL = "https://api.exa.ai";
export const WEB_SEARCH_DEFAULT_NUM_RESULTS = 10;
export const WEB_SEARCH_DEFAULT_TIMEOUT_MS = 30_000;

export function createWebSearchToolExecutor(
  options: WebSearchToolOptions,
): ToolExecutor {
  if (options.apiKey.trim() === "") {
    throw new Error("WebSearch requires a non-empty Exa API key.");
  }

  const baseUrl = options.baseUrl ?? WEB_SEARCH_DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const numResults = options.numResults ?? WEB_SEARCH_DEFAULT_NUM_RESULTS;
  const timeoutMs = options.timeoutMs ?? WEB_SEARCH_DEFAULT_TIMEOUT_MS;

  return {
    definition: {
      name: "WebSearch",
      description: [
        "Search the web and use the results to inform responses.",
        "- Provides up-to-date information for current events, recent releases, and documentation",
        "- Returns result links with publication dates and query-relevant excerpts",
        "- Use it when the local workspace cannot answer the question or the answer may be stale",
      ].join("\n"),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            minLength: 2,
            description: "The search query to use",
          },
          allowed_domains: {
            type: "array",
            items: { type: "string" },
            description: "Only include search results from these domains",
          },
          blocked_domains: {
            type: "array",
            items: { type: "string" },
            description: "Never include search results from these domains",
          },
        },
        required: ["query"],
      },
    },
    async execute(
      args,
      _call,
      context: ToolExecutionContext,
    ): Promise<WebSearchRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseWebSearchArgs(args);

      if (!parsed.ok) {
        return { ok: false, query: "", error: parsed.error };
      }

      const input = parsed.value;
      const requestBody: Record<string, unknown> = {
        query: input.query,
        type: "auto",
        numResults,
        contents: { highlights: true },
      };

      if (input.allowed_domains !== undefined) {
        requestBody.includeDomains = input.allowed_domains;
      }

      if (input.blocked_domains !== undefined) {
        requestBody.excludeDomains = input.blocked_domains;
      }

      const startedAt = Date.now();
      let response: Response;
      const requestSignal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(timeoutMs),
      ]);

      try {
        response = await fetchImpl(`${baseUrl}/search`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
          },
          body: JSON.stringify(requestBody),
          signal: requestSignal,
        });
      } catch (error) {
        if (context.signal.aborted) {
          throw cancellationError(context.signal, error);
        }

        return {
          ok: false,
          query: input.query,
          error: requestErrorMessage(error, timeoutMs),
        };
      }

      let responseText: string;
      try {
        responseText = await response.text();
      } catch (error) {
        if (context.signal.aborted) {
          throw cancellationError(context.signal, error);
        }

        return {
          ok: false,
          query: input.query,
          error: requestErrorMessage(error, timeoutMs),
        };
      }

      throwIfTurnCancelled(context.signal);

      if (!response.ok) {
        return {
          ok: false,
          query: input.query,
          error: `Exa /search returned HTTP ${response.status}: ${extractApiError(responseText)}`,
        };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(responseText);
      } catch {
        return {
          ok: false,
          query: input.query,
          error: "Exa /search returned a non-JSON response body.",
        };
      }

      if (!isRecord(payload) || !Array.isArray(payload.results)) {
        return {
          ok: false,
          query: input.query,
          error: "Exa /search response is missing a results array.",
        };
      }

      const results = payload.results
        .map(toResultItem)
        .filter((item): item is WebSearchResultItem => item !== undefined);

      return {
        ok: true,
        query: input.query,
        searchType:
          typeof payload.searchType === "string" ? payload.searchType : undefined,
        requestId:
          typeof payload.requestId === "string" ? payload.requestId : undefined,
        results,
        resultCount: results.length,
        allowedDomains: input.allowed_domains,
        blockedDomains: input.blocked_domains,
        costDollars: extractTotalCost(payload.costDollars),
        durationMs: Date.now() - startedAt,
      };
    },
  };
}

function parseWebSearchArgs(
  args: unknown,
): { ok: true; value: WebSearchArgs } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "WebSearch arguments must be an object." };
  }

  if (typeof args.query !== "string" || args.query.trim().length < 2) {
    return {
      ok: false,
      error: "WebSearch.query must be a string with at least 2 characters.",
    };
  }

  const allowedDomains = parseDomainList(args.allowed_domains, "allowed_domains");
  if (!allowedDomains.ok) {
    return allowedDomains;
  }

  const blockedDomains = parseDomainList(args.blocked_domains, "blocked_domains");
  if (!blockedDomains.ok) {
    return blockedDomains;
  }

  return {
    ok: true,
    value: {
      query: args.query.trim(),
      allowed_domains: allowedDomains.value,
      blocked_domains: blockedDomains.value,
    },
  };
}

function parseDomainList(
  value: unknown,
  name: string,
): { ok: true; value: string[] | undefined } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  const entries: unknown[] | undefined = Array.isArray(value) ? value : undefined;

  if (
    entries === undefined ||
    !entries.every(
      (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
    )
  ) {
    return {
      ok: false,
      error: `WebSearch.${name} must be an array of non-empty strings.`,
    };
  }

  return entries.length === 0
    ? { ok: true, value: undefined }
    : { ok: true, value: entries.map((entry) => entry.trim()) };
}

function toResultItem(value: unknown): WebSearchResultItem | undefined {
  if (!isRecord(value) || typeof value.url !== "string" || value.url === "") {
    return undefined;
  }

  return {
    title: typeof value.title === "string" ? value.title : "",
    url: value.url,
    publishedDate:
      typeof value.publishedDate === "string" ? value.publishedDate : undefined,
    author: typeof value.author === "string" ? value.author : undefined,
    highlights: Array.isArray(value.highlights)
      ? value.highlights.filter((entry): entry is string => typeof entry === "string")
      : undefined,
  };
}

function extractTotalCost(value: unknown): number | undefined {
  return isRecord(value) && typeof value.total === "number" ? value.total : undefined;
}

function extractApiError(responseText: string): string {
  try {
    const payload: unknown = JSON.parse(responseText);
    if (isRecord(payload) && typeof payload.error === "string") {
      return payload.error;
    }
  } catch {
    // Fall through to the raw body.
  }

  return responseText === "" ? "(empty response body)" : responseText;
}

function requestErrorMessage(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `Exa /search request timed out after ${timeoutMs}ms.`;
  }

  return `Exa /search request failed: ${error instanceof Error ? error.message : String(error)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
