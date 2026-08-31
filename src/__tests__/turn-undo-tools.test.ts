import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultTooling } from "../tools/registry";
import type { ToolExecutionContext } from "../tools/types";
import {
  createTestHistoryReader,
  createTestRuntime,
  type TestToolCallInput,
} from "./test-runtime";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

const context: ToolExecutionContext = {
  signal: new AbortController().signal,
};

describe("turn undo file tool integration", () => {
  test("restores modified and deleted bytes and removes turn-created files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-undo-tools-"));
    const modifiedPath = path.join(workspace, "modified.txt");
    const createdPath = path.join(workspace, "nested", "created.txt");
    const deletedPath = path.join(workspace, "deleted.bin");
    const deletedBytes = Buffer.from([0xff, 0x00, 0x80, 0x61]);
    const fixture = createUndoTooling(workspace);

    try {
      await writeFile(modifiedPath, "before\n");
      await writeFile(deletedPath, deletedBytes);
      expect((await fixture.execute("Read", { file_path: "modified.txt" })).ok).toBe(
        true,
      );
      expect(
        (
          await fixture.execute("Write", {
            file_path: "modified.txt",
            content: "after\n",
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await fixture.execute("Write", {
            file_path: "nested/created.txt",
            content: "created\n",
          })
        ).ok,
      ).toBe(true);
      expect((await fixture.execute("Delete", { file_path: "deleted.bin" })).ok).toBe(
        true,
      );
      fixture.completeTurn();

      expect(await fixture.undo()).toEqual({
        status: "restored",
        turnNumber: 1,
        restoredFileCount: 2,
        deletedFileCount: 1,
      });
      expect(await readFile(modifiedPath, "utf8")).toBe("before\n");
      expect(await readFile(deletedPath)).toEqual(deletedBytes);
      expect(readFile(createdPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(path.dirname(createdPath))).isDirectory()).toBe(true);
      expect(fixture.tooling.snapshots.has(modifiedPath)).toBe(false);
      expect(fixture.tooling.snapshots.has(createdPath)).toBe(false);
      expect(await fixture.undo()).toEqual({ status: "nothing" });
    } finally {
      await fixture.tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("keeps one before state for Delete followed by Write in the same turn", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-undo-tools-"));
    const filePath = path.join(workspace, "mixed.bin");
    const original = Buffer.from([0xf0, 0x00, 0x9f, 0x92]);
    const fixture = createUndoTooling(workspace);

    try {
      await writeFile(filePath, original);
      expect((await fixture.execute("Delete", { file_path: "mixed.bin" })).ok).toBe(
        true,
      );
      expect(
        (
          await fixture.execute("Write", {
            file_path: "mixed.bin",
            content: "replacement\n",
          })
        ).ok,
      ).toBe(true);
      fixture.completeTurn();

      expect((await fixture.undo()).status).toBe("restored");
      expect(await readFile(filePath)).toEqual(original);
    } finally {
      await fixture.tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("does not create a checkpoint for a file-tool validation failure", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-undo-tools-"));
    const fixture = createUndoTooling(workspace);

    try {
      await writeFile(path.join(workspace, "unread.txt"), "before");
      const result = await fixture.execute("Write", {
        file_path: "unread.txt",
        content: "after",
      });
      expect(result.ok).toBe(false);
      fixture.completeTurn();
      expect(await fixture.undo()).toEqual({ status: "nothing" });
      expect(await readFile(path.join(workspace, "unread.txt"), "utf8")).toBe("before");
    } finally {
      await fixture.tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("deletes an oversized file and records an unavailable barrier", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-undo-tools-"));
    const filePath = path.join(workspace, "oversized.bin");
    const fixture = createUndoTooling(workspace);

    try {
      await writeFile(filePath, "");
      await truncate(filePath, 32 * 1024 * 1024 + 1);
      const result = await fixture.execute("Delete", {
        file_path: "oversized.bin",
      });
      expect(result.ok).toBe(true);
      expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      fixture.completeTurn();
      expect(await fixture.undo()).toEqual({
        status: "unavailable",
        turnNumber: 1,
        reason: {
          kind: "file-too-large",
          displayPath: "oversized.bin",
          byteLength: 32 * 1024 * 1024 + 1,
        },
      });
    } finally {
      await fixture.tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("deletes an unreadable file and records capture unavailable", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-undo-tools-"));
    const filePath = path.join(workspace, "unreadable.txt");
    const fixture = createUndoTooling(workspace);

    try {
      await writeFile(filePath, "delete despite capture failure");
      await chmod(filePath, 0o000);
      const result = await fixture.execute("Delete", {
        file_path: "unreadable.txt",
      });
      expect(result.ok).toBe(true);
      fixture.completeTurn();
      expect(await fixture.undo()).toMatchObject({
        status: "unavailable",
        turnNumber: 1,
        reason: {
          kind: "capture-unavailable",
          displayPath: "unreadable.txt",
        },
      });
    } finally {
      await fixture.tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });

  test("does not enable capture in default one-shot tooling", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-undo-tools-"));
    const runtime = createTestRuntime();
    const tooling = createDefaultTooling({
      workspaceRoot: workspace,
      runtimeSession: runtime.runtimeSession,
      historyReader: createTestHistoryReader(runtime.runtimeSession.sessionId),
    });

    try {
      expect(tooling.turnUndoManager).toBeUndefined();
    } finally {
      await tooling.dispose();
      await rm(workspace, { recursive: true });
    }
  });
});

function createUndoTooling(workspaceRoot: string) {
  const runtime = createTestRuntime();
  const tooling = createDefaultTooling({
    workspaceRoot,
    runtimeSession: runtime.runtimeSession,
    historyReader: createTestHistoryReader(runtime.runtimeSession.sessionId),
    enableTurnUndo: true,
  });
  const undoManager = tooling.turnUndoManager;
  if (undoManager === undefined) {
    throw new Error("Undo tooling was not enabled.");
  }
  return {
    tooling,
    execute(name: string, args: unknown) {
      return tooling.runtime.execute(
        runtime.toolCall({ name, args } satisfies TestToolCallInput),
        context,
      );
    },
    completeTurn() {
      undoManager.completeTurn(runtime.turn);
    },
    undo() {
      return undoManager.undoLatest();
    },
  };
}
