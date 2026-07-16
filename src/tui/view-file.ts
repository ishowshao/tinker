import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type ViewFile = {
  absolutePath: string;
  displayPath: string;
  lines: readonly string[];
  sizeBytes: number;
};

export async function loadViewFile(
  workspaceRoot: string,
  inputPath: string,
): Promise<ViewFile> {
  if (inputPath.trim() === "") {
    throw new Error("Path is required.");
  }

  const root = await realpath(workspaceRoot);
  const absoluteInput = path.isAbsolute(inputPath);
  const resolvedPath = absoluteInput
    ? path.resolve(inputPath)
    : path.resolve(root, inputPath);

  if (!absoluteInput && !isWithin(root, resolvedPath)) {
    throw new Error("Relative path escapes the workspace.");
  }

  let absolutePath: string;
  try {
    absolutePath = await realpath(resolvedPath);
  } catch (error) {
    throw viewFileSystemError(resolvedPath, error);
  }

  if (!absoluteInput && !isWithin(root, absolutePath)) {
    throw new Error("Relative path resolves outside the workspace.");
  }

  let info;
  try {
    info = await stat(absolutePath);
  } catch (error) {
    throw viewFileSystemError(absolutePath, error);
  }
  if (!info.isFile()) {
    throw new Error(`Path is not a regular file: ${absolutePath}`);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    throw viewFileSystemError(absolutePath, error);
  }

  const text = decodeText(bytes, absolutePath);
  return {
    absolutePath,
    displayPath: absoluteInput ? absolutePath : path.relative(root, absolutePath),
    lines: splitLines(text),
    sizeBytes: bytes.byteLength,
  };
}

function decodeText(bytes: Uint8Array, absolutePath: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`File is not valid UTF-8 text: ${absolutePath}`);
  }

  for (const character of text) {
    const codePoint = character.charCodeAt(0);
    const unsafeC0 =
      codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13;
    const unsafeC1 = codePoint >= 127 && codePoint <= 159;
    if (unsafeC0 || unsafeC1) {
      throw new Error(`File contains non-text control characters: ${absolutePath}`);
    }
  }

  return text;
}

function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }

  const lines = text.split(/\r\n|\n|\r/);
  if (text.endsWith("\n") || text.endsWith("\r")) {
    lines.pop();
  }
  return lines;
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function viewFileSystemError(filePath: string, error: unknown): Error {
  const code = fileSystemErrorCode(error);
  if (code === "ENOENT") {
    return new Error(`File does not exist: ${filePath}`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new Error(`File is not readable: ${filePath}`);
  }
  return new Error(`Unable to read file ${filePath}: ${errorMessage(error)}`);
}

function fileSystemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
