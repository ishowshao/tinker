import type { FileHandle } from "node:fs/promises";

// An OS permission prompt can leave open() pending without accepting a signal.
// Cancellation releases the caller; ownership of a late handle stays here.
export function abortableFileOpen(
  openFile: () => Promise<FileHandle>,
  signal?: AbortSignal,
  onWarning?: (message: string) => void,
): Promise<FileHandle> {
  signal?.throwIfAborted();
  if (signal === undefined) return openFile();

  return new Promise<FileHandle>((resolve, reject) => {
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      signal.removeEventListener("abort", onAbort);
      reject(asError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // Also handle a synchronous failure from the opener without leaking a listener.
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return openFile();
      })
      .then(async (handle) => {
        signal.removeEventListener("abort", onAbort);
        if (cancelled) {
          try {
            await handle.close();
          } catch (error) {
            onWarning?.(
              `Failed to close cancelled image file: ${error instanceof Error ? error.message : String(error)}.`,
            );
          }
        } else {
          resolve(handle);
        }
      })
      .catch((error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (cancelled) {
          // Late open failures must not become unhandled rejections.
          return;
        }
        reject(asError(error));
      });
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error), { cause: error });
}
