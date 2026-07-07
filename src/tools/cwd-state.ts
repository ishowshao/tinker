import path from "node:path";
import { realpathSync } from "node:fs";

export type CwdState = {
  cwd: string;
};

export function createCwdState(workspaceRoot: string): CwdState {
  return {
    cwd: path.resolve(workspaceRoot),
  };
}

export function isWorkspaceLocalCwd(workspaceRoot: string, cwd: string): boolean {
  try {
    const root = realpathSync(path.resolve(workspaceRoot));
    const candidate = realpathSync(path.resolve(cwd));
    return candidate === root || candidate.startsWith(root + path.sep);
  } catch {
    return false;
  }
}
