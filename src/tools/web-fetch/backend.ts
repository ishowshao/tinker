export type WebFetchRoute = "local" | "exa" | "local-browser";

export type WebFetchBackendResult = {
  ok: boolean;
  finalUrl?: string;
  redirectUrl?: string;
  title?: string;
  publishedDate?: string;
  markdown?: string;
  refined?: string;
  highlights?: string[];
  source?: "cached" | "crawled";
  errorTag?: string;
  httpStatusCode?: number;
  costDollars?: number;
  error?: string;
};

export type WebFetchBackend = {
  route: WebFetchRoute;
  fetch(input: { url: string; prompt: string }): Promise<WebFetchBackendResult>;
};
