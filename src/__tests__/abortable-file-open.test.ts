import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { abortableFileOpen } from "../image/abortable-file-open";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("abortable image file open", () => {
  test("does not open a file when already cancelled", () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    expect(() =>
      abortableFileOpen(() => {
        throw new Error("opener must not run");
      }, controller.signal),
    ).toThrow(reason);
  });

  test("cancels a pending open immediately and closes its late real handle", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-open-cancel-"));
    const controller = new AbortController();
    const pending = deferred<FileHandle>();
    const started = deferred<void>();
    let continued = false;
    let handle: FileHandle | undefined;
    try {
      const operation = abortableFileOpen(() => {
        started.resolve();
        return pending.promise;
      }, controller.signal).then((value) => {
        continued = true;
        return value;
      });
      await started.promise;
      const reason = new Error("cancel while OS permission is pending");
      controller.abort(reason);
      // This must settle before the simulated OS open is allowed to finish.
      expect(await operation.catch((error: unknown) => error)).toBe(reason);
      expect(continued).toBe(false);

      handle = await open(path.join(directory, "fixture"), "w+");
      const closed = deferred<void>();
      const close = handle.close.bind(handle);
      spyOn(handle, "close").mockImplementation(async () => {
        await close();
        closed.resolve();
      });
      pending.resolve(handle);
      await closed.promise;
      expect(handle.fd).toBe(-1);
      expect(continued).toBe(false);
    } finally {
      if (handle !== undefined && handle.fd !== -1) await handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("consumes a late permission denial after cancellation", async () => {
    const controller = new AbortController();
    const pending = deferred<FileHandle>();
    const started = deferred<void>();
    const operation = abortableFileOpen(() => {
      started.resolve();
      return pending.promise;
    }, controller.signal);
    await started.promise;
    controller.abort(new Error("cancelled"));
    expect(await operation.catch((error: unknown) => error)).toEqual(
      new Error("cancelled"),
    );
    pending.reject(new Error("EACCES: permission denied"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("transfers a successful handle to its caller even if cancelled later", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-open-success-"));
    const controller = new AbortController();
    const handle = await abortableFileOpen(
      () => open(path.join(directory, "fixture"), "w+"),
      controller.signal,
    );
    try {
      controller.abort();
      expect(handle.fd).not.toBe(-1);
      await handle.writeFile("still owned by caller");
    } finally {
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves open failures before cancellation", async () => {
    const reason = new Error("open failed");
    const controller = new AbortController();
    expect(
      await abortableFileOpen(() => Promise.reject(reason), controller.signal).catch(
        (error: unknown) => error,
      ),
    ).toBe(reason);
    expect(
      await abortableFileOpen(() => {
        throw reason;
      }, controller.signal).catch((error: unknown) => error),
    ).toBe(reason);
  });
});
