import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TINKER_HOME_DIR = ".tinker";
const PROJECTS_DIR = "projects";
const SLUG_MAX_LENGTH = 24;
const HASH_HEX_LENGTH = 8;
const FALLBACK_SLUG = "project";

export const TINKER_HOME_ENV = "TINKER_HOME";

/**
 * Base directory for global Tinker state. TINKER_HOME overrides the OS home
 * directory; tests and the PTY harness use it to isolate state.
 */
export function defaultHomeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[TINKER_HOME_ENV]?.trim();
  return override === undefined || override === "" ? os.homedir() : override;
}

/**
 * Stable directory name for one workspace inside the global Tinker home, e.g.
 * "tinker-a1b2c3d4". The slug is decorative; the hash suffix over the
 * canonical workspace path provides uniqueness.
 */
export function workspaceStorageDirectoryName(canonicalWorkspaceRoot: string): string {
  const slug = slugify(path.basename(canonicalWorkspaceRoot));
  const hash = createHash("sha256")
    .update(canonicalWorkspaceRoot)
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
  return `${slug}-${hash}`;
}

/**
 * Storage root for one canonical workspace root under a canonical home root:
 * <home>/.tinker/projects/<slug-hash>. Both inputs must already be canonical
 * (see resolveWorkspaceStorageRoot for the resolving variant).
 */
export function workspaceStorageRoot(
  canonicalWorkspaceRoot: string,
  canonicalHomeRoot: string,
): string {
  return path.join(
    canonicalHomeRoot,
    TINKER_HOME_DIR,
    PROJECTS_DIR,
    workspaceStorageDirectoryName(canonicalWorkspaceRoot),
  );
}

/** Canonical (symlink-resolved) home root used for global Tinker state. */
export async function canonicalHomeRoot(
  homeRoot: string = defaultHomeRoot(),
): Promise<string> {
  return realpath(homeRoot);
}

/**
 * Resolves the per-workspace storage root under the global Tinker home. Both
 * the workspace and the home root are canonicalized so a project reached
 * through different symlinked paths maps to a single storage directory.
 */
export async function resolveWorkspaceStorageRoot(
  workspaceRoot: string,
  homeRoot: string = defaultHomeRoot(),
): Promise<string> {
  return workspaceStorageRoot(
    await realpath(workspaceRoot),
    await canonicalHomeRoot(homeRoot),
  );
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
  return slug === "" ? FALLBACK_SLUG : slug;
}
