import type { WebFetchRoute } from "./backend";

const privateHostnameSuffixes = [".localhost", ".local", ".internal"];

// Public hosts that the Exa backend handles poorly; always fetch them locally.
const forcedLocalHostnames = new Set(["mp.weixin.qq.com"]);

// Hosts that need JavaScript rendering; go straight to the headless browser.
const forcedBrowserHostnames = new Set<string>([]);

export type RouteContext = {
  hasExaBackend: boolean;
  hasBrowserBackend: boolean;
};

export function decideRoute(url: URL, context: RouteContext): WebFetchRoute {
  if (
    context.hasBrowserBackend &&
    forcedBrowserHostnames.has(url.hostname.toLowerCase())
  ) {
    return "local-browser";
  }

  if (isPrivateHost(url.hostname)) {
    return "local";
  }

  if (forcedLocalHostnames.has(url.hostname.toLowerCase())) {
    return "local";
  }

  return context.hasExaBackend ? "exa" : "local";
}

// Escalate a static-fetch miss to the headless browser: the page either
// could not be fetched (without a definitive HTTP status the browser would
// also receive) or rendered to nothing without JavaScript.
export function shouldEscalateToBrowser(result: {
  ok: boolean;
  redirectUrl?: string;
  markdown?: string;
  httpStatusCode?: number;
}): boolean {
  if (result.redirectUrl !== undefined) {
    return false;
  }

  if (!result.ok) {
    return result.httpStatusCode === undefined;
  }

  return (result.markdown ?? "").trim() === "";
}

export function isPrivateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  if (normalized === "localhost" || normalized === "::1" || normalized === "0.0.0.0") {
    return true;
  }

  if (privateHostnameSuffixes.some((suffix) => normalized.endsWith(suffix))) {
    return true;
  }

  const octets = parseIpv4(normalized);
  if (octets === undefined) {
    return false;
  }

  const [a, b] = octets;
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function parseIpv4(hostname: string): [number, number, number, number] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return undefined;
  }

  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) {
    return undefined;
  }

  return octets as [number, number, number, number];
}
