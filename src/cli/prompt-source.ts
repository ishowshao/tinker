import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { formatDiagnosticPath } from "./output";

export const MAX_ONESHOT_PROMPT_BYTES = 1 * 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;
const USER_CORRECTABLE_FILE_ERRORS = new Set([
  "EACCES",
  "EISDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOTDIR",
  "ENXIO",
  "EPERM",
]);

export type PromptSource =
  | { readonly kind: "argument"; readonly value: string }
  | { readonly kind: "stdin" }
  | { readonly kind: "file"; readonly filePath: string };

export type ResolvedPrompt = {
  readonly text: string;
  readonly byteLength: number;
};

export type PromptReadable = AsyncIterable<unknown>;

export class PromptInputError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message);
    this.name = "PromptInputError";
  }
}

export async function resolvePromptSource(
  source: PromptSource,
  input: {
    readonly stdin: PromptReadable;
    readonly cwd: string;
  },
  dependencies: {
    readonly openFile?: typeof open;
  } = {},
): Promise<ResolvedPrompt> {
  if (source.kind === "argument") {
    return validateArgumentPrompt(source.value);
  }
  if (source.kind === "stdin") {
    return validatePromptBytes(await readStdinBytes(input.stdin), "standard input");
  }
  if (source.filePath.length === 0) {
    throw new PromptInputError("--file requires a non-empty path.", 2);
  }

  const filePath = source.filePath;
  const resolvedPath = path.resolve(input.cwd, filePath);
  const displayPath = formatDiagnosticPath(filePath);
  const openFile = dependencies.openFile ?? open;
  let handle: FileHandle;
  try {
    handle = await openFile(resolvedPath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw fileOperationError(error, displayPath, "open");
  }

  let bytes: Buffer | undefined;
  let readError: PromptInputError | undefined;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new PromptInputError(
        `Prompt file ${displayPath} must be a regular file.`,
        2,
      );
    }
    if (stats.size > MAX_ONESHOT_PROMPT_BYTES) {
      throw promptTooLarge("file", stats.size, displayPath);
    }
    bytes = await readFileBytes(handle, displayPath);
  } catch (error) {
    readError =
      error instanceof PromptInputError
        ? error
        : fileOperationError(error, displayPath, "read");
  }

  try {
    await handle.close();
  } catch {
    throw new PromptInputError(`Could not close prompt file ${displayPath}.`, 1);
  }

  if (readError !== undefined) {
    throw readError;
  }
  if (bytes === undefined) {
    throw new PromptInputError(`Could not read prompt file ${displayPath}.`, 1);
  }
  return validatePromptBytes(bytes, `file ${displayPath}`);
}

function validateArgumentPrompt(text: string): ResolvedPrompt {
  const byteLength = Buffer.byteLength(text);
  if (byteLength > MAX_ONESHOT_PROMPT_BYTES) {
    throw promptTooLarge("argument", byteLength);
  }
  validatePromptText(text, "argument");
  return Object.freeze({ text, byteLength });
}

async function readStdinBytes(stdin: PromptReadable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    for await (const rawChunk of stdin) {
      const chunk = toBuffer(rawChunk);
      const nextLength = byteLength + chunk.byteLength;
      if (nextLength > MAX_ONESHOT_PROMPT_BYTES) {
        throw promptTooLarge("standard input", nextLength);
      }
      chunks.push(chunk);
      byteLength = nextLength;
    }
  } catch (error) {
    if (error instanceof PromptInputError) {
      throw error;
    }
    throw new PromptInputError("Could not read prompt from standard input.", 1);
  }
  return Buffer.concat(chunks, byteLength);
}

async function readFileBytes(handle: FileHandle, displayPath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  while (true) {
    const remaining = MAX_ONESHOT_PROMPT_BYTES + 1 - byteLength;
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) {
      break;
    }
    byteLength += bytesRead;
    if (byteLength > MAX_ONESHOT_PROMPT_BYTES) {
      throw promptTooLarge("file", byteLength, displayPath);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, byteLength);
}

function validatePromptBytes(bytes: Buffer, source: string): ResolvedPrompt {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PromptInputError(`Prompt from ${source} is not valid UTF-8.`, 2);
  }
  validatePromptText(text, source);
  return Object.freeze({ text, byteLength: bytes.byteLength });
}

function validatePromptText(text: string, source: string): void {
  if (text.includes("\0")) {
    throw new PromptInputError(`Prompt from ${source} contains a NUL byte.`, 2);
  }
  if (text.trim().length === 0) {
    throw new PromptInputError(`Prompt from ${source} must not be empty.`, 2);
  }
}

function promptTooLarge(
  source: string,
  actualBytes: number,
  displayPath?: string,
): PromptInputError {
  const location = displayPath === undefined ? source : `${source} ${displayPath}`;
  return new PromptInputError(
    `Prompt from ${location} is ${actualBytes} bytes; the limit is ${MAX_ONESHOT_PROMPT_BYTES} bytes.`,
    2,
  );
}

function fileOperationError(
  error: unknown,
  displayPath: string,
  operation: "open" | "read",
): PromptInputError {
  const code = errorCode(error);
  if (code !== undefined && USER_CORRECTABLE_FILE_ERRORS.has(code)) {
    return new PromptInputError(
      `Prompt file ${displayPath} is not available (${code}).`,
      2,
    );
  }
  return new PromptInputError(
    `Could not ${operation} prompt file ${displayPath}${code === undefined ? "." : ` (${code}).`}`,
    1,
  );
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function toBuffer(chunk: unknown): Buffer {
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError("Prompt stdin produced a non-byte chunk.");
}
