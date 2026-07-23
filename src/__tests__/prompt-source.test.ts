import { describe, expect, test } from "bun:test";
import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  MAX_ONESHOT_PROMPT_BYTES,
  PromptInputError,
  resolvePromptSource,
} from "../cli/prompt-source";

describe("one-shot prompt sources", () => {
  test("preserves argument whitespace, quoting characters, slashes, and emoji", async () => {
    const text = ' \tfirst\r\n`$HOME` "quoted" \\ 😀\n ';
    const resolved = await resolvePromptSource(
      { kind: "argument", value: text },
      input(),
    );

    expect(resolved).toEqual({ text, byteLength: Buffer.byteLength(text) });
  });

  test("decodes stdin across UTF-8 chunk boundaries and preserves BOM and CRLF", async () => {
    const bytes = Buffer.from("\uFEFFfirst\r\n😀\n");
    const resolved = await resolvePromptSource(
      { kind: "stdin" },
      input(
        Readable.from([
          bytes.subarray(0, 14),
          bytes.subarray(14, 16),
          bytes.subarray(16),
        ]),
      ),
    );

    expect(resolved.text).toBe("\uFEFFfirst\r\n😀\n");
    expect(resolved.byteLength).toBe(bytes.byteLength);
  });

  test("resolves relative file paths from the captured cwd and reads through one handle", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-prompt-file-"));
    try {
      await writeFile(path.join(directory, "prompt.md"), "  review this\r\n");
      let openedPath = "";
      let handleCount = 0;
      const resolved = await resolvePromptSource(
        { kind: "file", filePath: "prompt.md" },
        input(undefined, directory),
        {
          openFile: async (...args: Parameters<typeof open>) => {
            openedPath = String(args[0]);
            handleCount += 1;
            return open(...args);
          },
        },
      );

      expect(openedPath).toBe(path.join(directory, "prompt.md"));
      expect(handleCount).toBe(1);
      expect(resolved.text).toBe("  review this\r\n");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("accepts exactly 1 MiB and rejects the next byte for every source kind", async () => {
    const exact = "x".repeat(MAX_ONESHOT_PROMPT_BYTES);
    expect(
      await resolvePromptSource({ kind: "argument", value: exact }, input()),
    ).toMatchObject({ byteLength: MAX_ONESHOT_PROMPT_BYTES });

    await expectPromptError(
      () => resolvePromptSource({ kind: "argument", value: `${exact}x` }, input()),
      2,
      "limit",
    );
    await expectPromptError(
      () =>
        resolvePromptSource(
          { kind: "stdin" },
          input(Readable.from([Buffer.alloc(MAX_ONESHOT_PROMPT_BYTES + 1, 120)])),
        ),
      2,
      "limit",
    );

    const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-prompt-limit-"));
    try {
      await writeFile(
        path.join(directory, "too-large.txt"),
        Buffer.alloc(MAX_ONESHOT_PROMPT_BYTES + 1, 120),
      );
      await expectPromptError(
        () =>
          resolvePromptSource(
            { kind: "file", filePath: "too-large.txt" },
            input(undefined, directory),
          ),
        2,
        "limit",
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("rejects invalid UTF-8, NUL, empty, and whitespace-only content", async () => {
    await expectPromptError(
      () =>
        resolvePromptSource(
          { kind: "stdin" },
          input(Readable.from([Buffer.from([0xc3, 0x28])])),
        ),
      2,
      "valid UTF-8",
    );
    for (const value of ["", " \t\r\n", "before\0after"]) {
      await expectPromptError(
        () => resolvePromptSource({ kind: "argument", value }, input()),
        2,
        value.includes("\0") ? "NUL" : "empty",
      );
    }
  });

  test("classifies missing, directory, symlink-loop, permission, and long-path failures as usage errors", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-prompt-kind-"));
    try {
      await symlink("loop-b", path.join(directory, "loop-a"));
      await symlink("loop-a", path.join(directory, "loop-b"));
      for (const filePath of ["missing.txt", ".", "loop-a"]) {
        await expectPromptError(
          () =>
            resolvePromptSource(
              { kind: "file", filePath },
              input(undefined, directory),
            ),
          2,
          filePath === "." ? "regular file" : "not available",
        );
      }
      for (const code of ["EACCES", "EPERM", "ENAMETOOLONG"]) {
        await expectPromptError(
          () =>
            resolvePromptSource(
              { kind: "file", filePath: "blocked" },
              input(undefined, directory),
              { openFile: rejectingOpen(code) },
            ),
          2,
          code,
        );
      }
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("rejects a FIFO without blocking for a writer", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-prompt-fifo-"));
    const fifoPath = path.join(directory, "prompt.fifo");
    try {
      const child = Bun.spawnSync(["mkfifo", fifoPath]);
      expect(child.exitCode).toBe(0);
      await expectPromptError(
        () =>
          resolvePromptSource(
            { kind: "file", filePath: fifoPath },
            input(undefined, directory),
          ),
        2,
        "regular file",
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("classifies resource, read, and close faults as local I/O failures", async () => {
    for (const code of ["EMFILE", "ENFILE", "ENOMEM", "EIO"]) {
      await expectPromptError(
        () =>
          resolvePromptSource({ kind: "file", filePath: "resource.txt" }, input(), {
            openFile: rejectingOpen(code),
          }),
        1,
        code,
      );
    }

    await expectPromptError(
      () =>
        resolvePromptSource({ kind: "file", filePath: "read.txt" }, input(), {
          openFile: fakeOpen({ readError: systemError("EIO") }),
        }),
      1,
      "EIO",
    );
    await expectPromptError(
      () =>
        resolvePromptSource({ kind: "file", filePath: "close.txt" }, input(), {
          openFile: fakeOpen({ text: "hello", closeError: new Error("secret") }),
        }),
      1,
      "Could not close",
    );
  });

  test("keeps reading bounded when a file grows after stat", async () => {
    await expectPromptError(
      () =>
        resolvePromptSource({ kind: "file", filePath: "growing.txt" }, input(), {
          openFile: fakeOpen({ text: "x".repeat(MAX_ONESHOT_PROMPT_BYTES + 1) }),
        }),
      2,
      "limit",
    );
  });

  test("stops an oversized stdin iterator and calls return for cleanup", async () => {
    let returned = false;
    const iterator: AsyncIterator<Buffer> & AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => ({
        done: false,
        value: Buffer.alloc(MAX_ONESHOT_PROMPT_BYTES + 1, 120),
      }),
      return: async () => {
        returned = true;
        return { done: true, value: undefined };
      },
    };

    await expectPromptError(
      () => resolvePromptSource({ kind: "stdin" }, input(iterator)),
      2,
      "limit",
    );
    expect(returned).toBe(true);
  });

  test("does not expose file-path control characters as terminal controls", async () => {
    const filePath = `missing\n${String.fromCharCode(27)}[31msecret`;
    const error = await capturePromptError(() =>
      resolvePromptSource({ kind: "file", filePath }, input()),
    );
    expect(error.message).not.toContain("\n");
    expect(error.message).not.toContain(String.fromCharCode(27));
    expect(error.message).toContain("\\n");
  });
});

function input(stdin: AsyncIterable<unknown> = Readable.from([]), cwd = process.cwd()) {
  return { stdin, cwd };
}

async function capturePromptError(
  action: () => Promise<unknown>,
): Promise<PromptInputError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof PromptInputError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a prompt input error.");
}

async function expectPromptError(
  action: () => Promise<unknown>,
  exitCode: 1 | 2,
  message: string,
): Promise<void> {
  const error = await capturePromptError(action);
  expect(error.exitCode).toBe(exitCode);
  expect(error.message).toContain(message);
}

function rejectingOpen(code: string): typeof open {
  return async () => {
    throw systemError(code);
  };
}

function fakeOpen(options: {
  text?: string;
  readError?: Error;
  closeError?: Error;
}): typeof open {
  return (async () => {
    const bytes = Buffer.from(options.text ?? "hello");
    let offset = 0;
    return {
      stat: async () => ({ size: 0, isFile: () => true }),
      read: async (buffer: Buffer, bufferOffset: number, length: number) => {
        if (options.readError !== undefined) {
          throw options.readError;
        }
        const bytesRead = Math.min(length, bytes.byteLength - offset);
        bytes.copy(buffer, bufferOffset, offset, offset + bytesRead);
        offset += bytesRead;
        return { bytesRead, buffer };
      },
      close: async () => {
        if (options.closeError !== undefined) {
          throw options.closeError;
        }
      },
    };
  }) as unknown as typeof open;
}

function systemError(code: string): Error & { code: string } {
  return Object.assign(new Error(`system failure ${code}`), { code });
}
