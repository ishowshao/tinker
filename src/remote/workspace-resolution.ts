import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RemoteWorkspaceConfig } from "./config";
import { RemoteError } from "./protocol";

/** Only resolves configured roots; selecting a child directory does not change execution scope. */
export async function resolveServiceWorkspace(
  workspaces: readonly RemoteWorkspaceConfig[],
  directory: string,
): Promise<RemoteWorkspaceConfig> {
  if (!path.isAbsolute(directory))
    throw new RemoteError(
      400,
      "INVALID_DIRECTORY",
      "Workspace directory must be an absolute path on the service host.",
    );
  let canonical: string;
  try {
    canonical = await realpath(directory);
    if (!(await stat(canonical)).isDirectory()) throw new Error("Not a directory.");
  } catch {
    throw new RemoteError(
      404,
      "DIRECTORY_NOT_FOUND",
      "Workspace directory does not exist on the service host.",
    );
  }
  const match = findContainingWorkspace(workspaces, canonical);
  if (!match)
    throw new RemoteError(
      404,
      "WORKSPACE_NOT_CONFIGURED",
      "Current directory is outside configured workspaces. Use --service-config <path> from a local terminal to register it, or select --workspace <id> explicitly.",
    );
  return match;
}

export function findContainingWorkspace(
  workspaces: readonly RemoteWorkspaceConfig[],
  canonical: string,
): RemoteWorkspaceConfig | undefined {
  const matches = workspaces
    .filter((workspace) => {
      const relative = path.relative(workspace.path, canonical);
      return (
        relative === "" ||
        (!path.isAbsolute(relative) &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`))
      );
    })
    .sort((a, b) => b.path.length - a.path.length);
  return matches[0];
}

export function localWorkspaceRecord(canonical: string): RemoteWorkspaceConfig {
  return {
    id: `local-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`,
    name: path.basename(canonical) || canonical,
    path: canonical,
  };
}

export function mergeWorkspaces(
  configured: readonly RemoteWorkspaceConfig[],
  registered: readonly RemoteWorkspaceConfig[],
): RemoteWorkspaceConfig[] {
  const result = [...configured];
  for (const workspace of registered) {
    const match = result.find(
      (entry) => entry.id === workspace.id || entry.path === workspace.path,
    );
    if (match) {
      if (match.id !== workspace.id || match.path !== workspace.path)
        throw new Error(
          "Configured workspace conflicts with a locally registered workspace identity. Preserve its ID and canonical path.",
        );
    } else result.push(workspace);
  }
  return result;
}
