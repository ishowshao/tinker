import path from "node:path";

export function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath.trim() === "") {
    throw new Error("Path is required.");
  }

  if (path.isAbsolute(inputPath)) {
    return path.resolve(inputPath);
  }

  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, inputPath);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Path escapes workspace.");
  }

  return resolved;
}

export function toDisplayPath(workspaceRoot: string, absolutePath: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(absolutePath);

  if (resolved === root) {
    return ".";
  }

  return resolved.startsWith(root + path.sep)
    ? path.relative(root, resolved)
    : resolved;
}
