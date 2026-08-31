import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { runtimeIdFactory } from "../ids/runtime-id";
import { SessionCatalog } from "../session/session-catalog";
import { SessionStore } from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import {
  defaultHomeRoot,
  resolveWorkspaceStorageRoot,
  TINKER_HOME_ENV,
  workspaceStorageDirectoryName,
} from "../session/workspace-storage";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";
import { finalizeTestSessionStore } from "./test-runtime";

describe("workspace storage directory name", () => {
  test("combines a readable slug with a stable hash", () => {
    const name = workspaceStorageDirectoryName("/users/demo/htdocs/tinker");
    expect(name).toMatch(/^tinker-[0-9a-f]{8}$/u);
    expect(workspaceStorageDirectoryName("/users/demo/htdocs/tinker")).toBe(name);
    expect(workspaceStorageDirectoryName("/other/tinker")).not.toBe(name);
  });

  test("sanitizes punctuation, truncation, and empty basenames", () => {
    expect(workspaceStorageDirectoryName("/x/Foo Bar_Baz.Qux")).toMatch(
      /^foo-bar-baz-qux-[0-9a-f]{8}$/u,
    );
    expect(workspaceStorageDirectoryName(`/x/${"a".repeat(64)}`)).toMatch(
      /^a{24}-[0-9a-f]{8}$/u,
    );
    expect(workspaceStorageDirectoryName("/")).toMatch(/^project-[0-9a-f]{8}$/u);
    expect(workspaceStorageDirectoryName("/x/我的项目")).toMatch(
      /^project-[0-9a-f]{8}$/u,
    );
  });
});

describe("workspace storage root resolution", () => {
  const homeRoot = isolateTinkerHome("tinker-storage-test-home-");

  test("resolves symlinked workspace paths to one storage directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-storage-link-"));
    try {
      const realWorkspace = path.join(root, "real-project");
      await mkdir(realWorkspace);
      const linkWorkspace = path.join(root, "linked-project");
      await symlink(realWorkspace, linkWorkspace);

      const direct = await resolveWorkspaceStorageRoot(realWorkspace);
      const linked = await resolveWorkspaceStorageRoot(linkWorkspace);
      expect(linked).toBe(direct);
      expect(direct.startsWith(`${await realpath(homeRoot())}/`)).toBe(true);
      expect(path.basename(direct)).toMatch(/^real-project-[0-9a-f]{8}$/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("prefers TINKER_HOME over the OS home directory", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-storage-env-"));
    try {
      const resolved = await resolveWorkspaceStorageRoot(workspace);
      expect(resolved.startsWith(`${await realpath(homeRoot())}/`)).toBe(true);
      expect(defaultHomeRoot({})).toBe(os.homedir());
      expect(defaultHomeRoot({ [TINKER_HOME_ENV]: "  " })).toBe(os.homedir());
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("stores sessions under the global home instead of the workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-storage-session-"));
    try {
      const sessionId = runtimeIdFactory.createSessionId();
      const store = await SessionStore.createNew({
        workspaceRoot: workspace,
        sessionId,
        modelName: "test-model",
        systemPrompt: "system",
        idFactory: runtimeIdFactory,
      });
      finalizeTestSessionStore(store, { systemPrompt: "system" });
      const storageRoot = await resolveWorkspaceStorageRoot(workspace);
      expect(store.sessionDirectory).toBe(
        path.join(storageRoot, "sessions", sessionId),
      );
      new SqliteSessionLedger(store, runtimeIdFactory).beginTurn({
        turn: {
          sessionId,
          turnId: runtimeIdFactory.createTurnId(),
          turnNumber: 1,
        },
        userMessage: { role: "user", content: "catalog visibility" },
      });
      await store.abandon();

      const entries = await readdirSafe(workspace);
      expect(entries).not.toContain(".tinker");
      expect(
        (await new SessionCatalog({ workspaceRoot: workspace }).listAll()).map(
          (summary) => summary.sessionId,
        ),
      ).toEqual([sessionId]);

      const database = new Database(store.databasePath, { readonly: true });
      try {
        const row = database.query("SELECT workspace_root FROM session_meta").get() as {
          workspace_root: string;
        };
        expect(row.workspace_root).toBe(await realpath(workspace));
      } finally {
        database.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

async function readdirSafe(directory: string): Promise<readonly string[]> {
  return readdir(directory).catch(() => []);
}
