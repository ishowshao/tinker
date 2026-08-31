import { afterAll, beforeAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveWorkspaceStorageRoot,
  TINKER_HOME_ENV,
} from "../../session/workspace-storage";

/** Creates an isolated Tinker home directory for tests. */
export async function createTempHomeRoot(
  prefix = "tinker-test-home-",
): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Points the process-wide Tinker home default at a temporary directory for the
 * duration of the current test file, then restores and removes it. Returns a
 * getter for the active home root.
 */
export function isolateTinkerHome(prefix?: string): () => string {
  let previous: string | undefined;
  let root = "";
  beforeAll(async () => {
    previous = process.env[TINKER_HOME_ENV];
    root = await createTempHomeRoot(prefix);
    process.env[TINKER_HOME_ENV] = root;
  });
  afterAll(async () => {
    if (previous === undefined) {
      delete process.env[TINKER_HOME_ENV];
    } else {
      process.env[TINKER_HOME_ENV] = previous;
    }
    await rm(root, { recursive: true, force: true });
  });
  return () => root;
}

/** Resolves the per-workspace sessions root inside a test home directory. */
export async function workspaceSessionsRoot(
  workspace: string,
  homeRoot: string,
): Promise<string> {
  return path.join(await resolveWorkspaceStorageRoot(workspace, homeRoot), "sessions");
}

/** Resolves one session directory inside a test home directory. */
export async function workspaceSessionDirectory(
  workspace: string,
  homeRoot: string,
  sessionId: string,
): Promise<string> {
  return path.join(await workspaceSessionsRoot(workspace, homeRoot), sessionId);
}
