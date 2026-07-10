import { extractMarkdownFromHtml } from "./local-backend";
import type { WebFetchBackend, WebFetchBackendResult } from "./backend";
import { cancellationError, throwIfTurnCancelled } from "../../agent/turn-cancellation";

export type BrowserBackendOptions = {
  timeoutMs?: number;
  settleDelayMs?: number;
  maxHtmlChars?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
// Give page JavaScript time to render after the load event fires; JS-driven
// pages are the whole reason this backend exists.
const DEFAULT_SETTLE_DELAY_MS = 1000;
const DEFAULT_MAX_HTML_CHARS = 5 * 1024 * 1024;

export function isBrowserBackendAvailable(): boolean {
  return typeof Bun !== "undefined" && typeof Bun.WebView === "function";
}

export function createBrowserWebFetchBackend(
  options: BrowserBackendOptions = {},
): WebFetchBackend {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settleDelayMs = options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
  const maxHtmlChars = options.maxHtmlChars ?? DEFAULT_MAX_HTML_CHARS;

  return {
    route: "local-browser",
    async fetch(input, context): Promise<WebFetchBackendResult> {
      throwIfTurnCancelled(context.signal);
      if (!isBrowserBackendAvailable()) {
        return {
          ok: false,
          error: "Bun.WebView is not available in this Bun version.",
        };
      }

      const view = new Bun.WebView({ width: 1280, height: 800 });

      try {
        await withTimeout(
          view.navigate(input.url),
          timeoutMs,
          `Browser navigation timed out after ${timeoutMs}ms.`,
          context.signal,
        );
        await withTimeout(
          Bun.sleep(settleDelayMs),
          timeoutMs,
          `Browser settle delay timed out after ${timeoutMs}ms.`,
          context.signal,
        );

        const html = await withTimeout(
          view.evaluate<string>("document.documentElement.outerHTML"),
          timeoutMs,
          `Reading the rendered page timed out after ${timeoutMs}ms.`,
          context.signal,
        );

        if (typeof html !== "string" || html.trim() === "") {
          return { ok: false, error: "The browser returned an empty document." };
        }

        if (html.length > maxHtmlChars) {
          return {
            ok: false,
            error: `The rendered page exceeds the ${maxHtmlChars} character limit.`,
          };
        }

        const extracted = extractMarkdownFromHtml(html);

        return {
          ok: true,
          finalUrl: view.url || input.url,
          title: extracted.title ?? (view.title || undefined),
          markdown: extracted.markdown,
        };
      } catch (error) {
        if (context.signal.aborted) {
          throw cancellationError(context.signal, error);
        }

        return {
          ok: false,
          error: `Browser rendering failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        view.close();
      }
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancellationError(signal));
    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, timeout, cancellation]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
