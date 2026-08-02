import { realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChromeBridgeError } from "./errors";

export async function resolveUploadFilePath(
  filePath: string,
  rootUris: readonly string[],
): Promise<string> {
  if (!path.isAbsolute(filePath)) {
    throw fileAccessDenied("Upload filePath must be absolute.");
  }

  let resolvedFile: string;
  try {
    resolvedFile = await realpath(filePath);
    if (!(await stat(resolvedFile)).isFile()) {
      throw new Error("not a regular file");
    }
  } catch (error) {
    throw new ChromeBridgeError({
      code: "FILE_NOT_FOUND",
      message: "Upload filePath must identify an existing regular file.",
      retryable: false,
      outcome: "not_started",
      cause: error,
    });
  }

  const allowedRoots = await Promise.all([
    canonicalDirectory(tmpdir()),
    ...rootUris.map((uri) => canonicalFileRoot(uri)),
  ]);
  if (
    !allowedRoots.some(
      (root): root is string => root !== null && isWithinRoot(resolvedFile, root),
    )
  ) {
    throw fileAccessDenied(
      "Upload filePath must be inside an MCP workspace root or the system temporary directory.",
    );
  }
  return resolvedFile;
}

async function canonicalFileRoot(uri: string): Promise<string | null> {
  const url = new URL(uri);
  if (url.protocol !== "file:") {
    return null;
  }
  return canonicalDirectory(fileURLToPath(url));
}

async function canonicalDirectory(directory: string): Promise<string | null> {
  try {
    const resolved = await realpath(directory);
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function isWithinRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function fileAccessDenied(message: string): ChromeBridgeError {
  return new ChromeBridgeError({
    code: "FILE_ACCESS_DENIED",
    message,
    retryable: false,
    outcome: "not_started",
  });
}
