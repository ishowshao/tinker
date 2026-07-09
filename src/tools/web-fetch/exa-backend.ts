import type { WebFetchBackend, WebFetchBackendResult } from "./backend";

export type ExaBackendOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_BASE_URL = "https://api.exa.ai";
const DEFAULT_TIMEOUT_MS = 30_000;
const TEXT_MAX_CHARACTERS = 20_000;
const LIVECRAWL_TIMEOUT_MS = 10_000;

export function createExaWebFetchBackend(options: ExaBackendOptions): WebFetchBackend {
  if (options.apiKey.trim() === "") {
    throw new Error("Exa WebFetch backend requires a non-empty API key.");
  }

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    route: "exa",
    async fetch(input): Promise<WebFetchBackendResult> {
      let response: Response;

      try {
        response = await fetchImpl(`${baseUrl}/contents`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
          },
          body: JSON.stringify({
            urls: [input.url],
            text: { maxCharacters: TEXT_MAX_CHARACTERS },
            summary: { query: input.prompt },
            highlights: { query: input.prompt },
            livecrawlTimeout: LIVECRAWL_TIMEOUT_MS,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return { ok: false, error: requestErrorMessage(error, timeoutMs) };
      }

      const responseText = await response.text();

      if (!response.ok) {
        return {
          ok: false,
          httpStatusCode: response.status,
          error: `Exa /contents returned HTTP ${response.status}: ${extractApiError(responseText)}`,
        };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(responseText);
      } catch {
        return { ok: false, error: "Exa /contents returned a non-JSON response body." };
      }

      if (!isRecord(payload)) {
        return { ok: false, error: "Exa /contents returned an unexpected response." };
      }

      const status = Array.isArray(payload.statuses)
        ? asRecord(payload.statuses[0])
        : undefined;
      const statusError = asRecord(status?.error);

      if (status?.status === "error") {
        const tag =
          typeof statusError?.tag === "string" ? statusError.tag : "CRAWL_FAILED";
        const httpStatusCode =
          typeof statusError?.httpStatusCode === "number"
            ? statusError.httpStatusCode
            : undefined;

        return {
          ok: false,
          errorTag: tag,
          httpStatusCode,
          error: `Exa could not fetch the page: ${tag}${httpStatusCode === undefined ? "" : ` (HTTP ${httpStatusCode})`}.`,
        };
      }

      const result = Array.isArray(payload.results)
        ? asRecord(payload.results[0])
        : undefined;

      if (result === undefined) {
        return { ok: false, error: "Exa /contents response contains no results." };
      }

      return {
        ok: true,
        finalUrl: typeof result.url === "string" ? result.url : undefined,
        title: typeof result.title === "string" ? result.title : undefined,
        publishedDate:
          typeof result.publishedDate === "string" ? result.publishedDate : undefined,
        markdown: typeof result.text === "string" ? result.text : undefined,
        refined: typeof result.summary === "string" ? result.summary : undefined,
        highlights: Array.isArray(result.highlights)
          ? result.highlights.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : undefined,
        source: status?.source === "cached" ? "cached" : "crawled",
        costDollars: extractTotalCost(payload.costDollars),
      };
    },
  };
}

function extractTotalCost(value: unknown): number | undefined {
  const record = asRecord(value);
  return typeof record?.total === "number" ? record.total : undefined;
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
    return `Exa /contents request timed out after ${timeoutMs}ms.`;
  }

  return `Exa /contents request failed: ${error instanceof Error ? error.message : String(error)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
