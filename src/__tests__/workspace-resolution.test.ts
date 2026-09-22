import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import {
  resolveServiceWorkspace,
  mergeWorkspaces,
} from "../remote/workspace-resolution";
import { RemoteServiceStore } from "../remote/service-store";
import { Database } from "bun:sqlite";
import { remoteFixture, RemoteTestModel } from "./helpers/remote-test-support";

test("workspace resolution uses canonical paths and the nearest registered ancestor, never a string prefix", async () => {
  const root = await realpath(await mkdtemp("/tmp/tinker-workspaces-"));
  try {
    const parent = path.join(root, "project");
    const nested = path.join(parent, "nested");
    const child = path.join(nested, "src");
    const outside = path.join(root, "project-other");
    await mkdir(child, { recursive: true });
    await mkdir(outside);
    const alias = path.join(root, "alias");
    await symlink(child, alias);
    const escape = path.join(parent, "escape");
    await symlink(outside, escape);
    const entries = [
      { id: "parent", name: "Parent", path: parent },
      { id: "nested", name: "Nested", path: nested },
    ];
    expect((await resolveServiceWorkspace(entries, parent)).id).toBe("parent");
    expect((await resolveServiceWorkspace(entries, alias)).id).toBe("nested");
    expect((await resolveServiceWorkspace([...entries].reverse(), child)).id).toBe(
      "nested",
    );
    expect(
      String(await resolveServiceWorkspace(entries, outside).catch((e: unknown) => e)),
    ).toContain("outside configured");
    expect(
      String(await resolveServiceWorkspace(entries, escape).catch((e: unknown) => e)),
    ).toContain("outside configured");
    expect(
      String(
        await resolveServiceWorkspace(entries, "relative").catch((e: unknown) => e),
      ),
    ).toContain("absolute path");
    expect(() =>
      mergeWorkspaces(entries, [{ ...entries[0], id: "different" }]),
    ).toThrow("conflicts");
    expect(mergeWorkspaces(entries, [entries[0]])).toEqual(entries);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace registry upgrades legacy service state without replacing sessions or receipts", async () => {
  const model = new RemoteTestModel();
  model.release();
  const f = await remoteFixture(model);
  let reopened: RemoteServiceStore | undefined;
  try {
    const completed = await f.terminal(await f.prompt("KEEP_CANONICAL"));
    const before = f.store.sessions();
    await f.service.close();
    const database = new Database(path.join(f.root, "service/remote.sqlite"));
    database.exec("DROP TABLE registered_workspaces; PRAGMA user_version=1;");
    database.close();
    reopened = await RemoteServiceStore.open(path.join(f.root, "service"));
    expect(reopened.sessions()).toEqual(before);
    expect(reopened.get(completed.requestId)).toEqual(completed);
    expect(reopened.workspaces()).toEqual([]);
    reopened.registerWorkspace({ id: "local-test", name: "Test", path: f.workspace });
    await reopened.close();
    reopened = await RemoteServiceStore.open(path.join(f.root, "service"));
    expect(reopened.workspaces()).toEqual([
      { id: "local-test", name: "Test", path: f.workspace },
    ]);
  } finally {
    await reopened?.close();
    await f.cleanup();
  }
});
