import path from "node:path";

export function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath.trim() === "") {
    throw new Error("Path is required.");
  }

  const root = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(root, inputPath);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Path escapes workspace.");
  }

  return resolved;
}

export function toWorkspaceRelativePath(
  workspaceRoot: string,
  absolutePath: string,
): string {
  const relative = path.relative(path.resolve(workspaceRoot), absolutePath);
  return relative === "" ? "." : relative;
}
