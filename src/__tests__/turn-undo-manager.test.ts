import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runtimeIdFactory, type TurnId } from "../ids/runtime-id";
import { sha256Bytes } from "../tools/hash";
import {
  TurnUndoManager,
  type BeforeMutationFileState,
  type FileStateFingerprint,
  type MutationCapture,
} from "../tools/turn-undo-manager";
import type { FileSnapshotStore } from "../tools/types";

describe("TurnUndoManager", () => {
  test("keeps the first successful before state across mixed mutations", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-turn-undo-"));
    const filePath = path.join(workspace, "mixed.bin");
    const original = Buffer.from([0xff, 0x00, 0x61]);
    const manager = new TurnUndoManager({ snapshots: new Map() });
    const turn = turnIdentity(1);
    let secondLoaderCalls = 0;

    try {
      await writeFile(filePath, original);
      const first = await captureCurrent(manager, turn, filePath, "mixed.bin");
      await writeFile(filePath, "middle");
      manager.recordMutationResult(first, present("middle"));

      const second = await manager.captureBeforeMutation({
        ...turn,
        absolutePath: filePath,
        displayPath: "mixed.bin",
        loadBefore: async () => {
          secondLoaderCalls += 1;
          return { state: "present", bytes: await readFile(filePath) };
        },
      });
      await unlink(filePath);
      manager.recordMutationResult(second, { state: "absent" });
      manager.completeTurn(turn);

      expect(secondLoaderCalls).toBe(0);
      expect(await manager.undoLatest()).toEqual({
        status: "restored",
        turnNumber: 1,
        restoredFileCount: 1,
        deletedFileCount: 0,
      });
      expect(await readFile(filePath)).toEqual(original);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("drops present and absent net no-op turns", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-turn-undo-"));
    const existingPath = path.join(workspace, "existing.txt");
    const createdPath = path.join(workspace, "created.txt");
    const manager = new TurnUndoManager({ snapshots: new Map() });

    try {
      await writeFile(existingPath, "same");
      const firstTurn = turnIdentity(1);
      const same = await captureCurrent(
        manager,
        firstTurn,
        existingPath,
        "existing.txt",
      );
      await writeFile(existingPath, "same");
      manager.recordMutationResult(same, present("same"));
      manager.completeTurn(firstTurn);

      const secondTurn = turnIdentity(2);
      const create = await captureCurrent(
        manager,
        secondTurn,
        createdPath,
        "created.txt",
      );
      await writeFile(createdPath, "temporary");
      manager.recordMutationResult(create, present("temporary"));
      const remove = await manager.captureBeforeMutation({
        ...secondTurn,
        absolutePath: createdPath,
        displayPath: "created.txt",
        loadBefore: async () => {
          throw new Error("loader must not run after a successful mutation");
        },
      });
      await unlink(createdPath);
      manager.recordMutationResult(remove, { state: "absent" });
      manager.completeTurn(secondTurn);

      expect(await manager.undoLatest()).toEqual({ status: "nothing" });
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("refuses all writes when any checkpoint path drifted", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-turn-undo-"));
    const firstPath = path.join(workspace, "a.txt");
    const secondPath = path.join(workspace, "b.txt");
    const manager = new TurnUndoManager({ snapshots: new Map() });
    const turn = turnIdentity(7);

    try {
      await writeFile(firstPath, "a-before");
      await writeFile(secondPath, "b-before");
      await mutateFile(manager, turn, firstPath, "a.txt", "a-after");
      await mutateFile(manager, turn, secondPath, "b.txt", "b-after");
      manager.completeTurn(turn);
      await writeFile(secondPath, "manual-drift");

      expect(await manager.undoLatest()).toEqual({
        status: "refused",
        turnNumber: 7,
        conflicts: [{ displayPath: "b.txt", detail: "content changed" }],
      });
      expect(await readFile(firstPath, "utf8")).toBe("a-after");
      expect(await readFile(secondPath, "utf8")).toBe("manual-drift");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("keeps an unavailable mutation as a non-crossable barrier", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-turn-undo-"));
    const snapshots: FileSnapshotStore = new Map();
    const manager = new TurnUndoManager({
      snapshots,
      limits: { maxFileBytes: 4, maxRuntimeBytes: 8, maxRecords: 20 },
    });
    const oldPath = path.join(workspace, "old.txt");
    const largePath = path.join(workspace, "large.txt");
    const newerPath = path.join(workspace, "newer.txt");

    try {
      await writeFile(oldPath, "old");
      const firstTurn = turnIdentity(1);
      await mutateFile(manager, firstTurn, oldPath, "old.txt", "new");
      manager.completeTurn(firstTurn);

      await writeFile(largePath, "12345");
      const barrierTurn = turnIdentity(2);
      const large = await captureCurrent(manager, barrierTurn, largePath, "large.txt");
      expect(large.kind).toBe("untracked");
      await writeFile(largePath, "abcde");
      manager.recordMutationResult(large, present("abcde"));
      manager.completeTurn(barrierTurn);

      await writeFile(newerPath, "a");
      const newerTurn = turnIdentity(3);
      await mutateFile(manager, newerTurn, newerPath, "newer.txt", "b");
      manager.completeTurn(newerTurn);

      expect((await manager.undoLatest()).status).toBe("restored");
      expect(await readFile(newerPath, "utf8")).toBe("a");
      expect(await manager.undoLatest()).toEqual({
        status: "unavailable",
        turnNumber: 2,
        reason: {
          kind: "file-too-large",
          displayPath: "large.txt",
          byteLength: 5,
        },
      });
      expect(await readFile(oldPath, "utf8")).toBe("new");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("does not create a barrier for an untracked call with no net change", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-turn-undo-"));
    const manager = new TurnUndoManager({
      snapshots: new Map(),
      limits: { maxFileBytes: 4, maxRuntimeBytes: 8, maxRecords: 20 },
    });
    const oldPath = path.join(workspace, "old.txt");
    const largePath = path.join(workspace, "large.txt");

    try {
      await writeFile(oldPath, "old");
      const firstTurn = turnIdentity(1);
      await mutateFile(manager, firstTurn, oldPath, "old.txt", "new");
      manager.completeTurn(firstTurn);

      await writeFile(largePath, "12345");
      const secondTurn = turnIdentity(2);
      const capture = await captureCurrent(manager, secondTurn, largePath, "large.txt");
      manager.recordMutationResult(capture, present("12345"));
      manager.completeTurn(secondTurn);

      expect((await manager.undoLatest()).status).toBe("restored");
      expect(await readFile(oldPath, "utf8")).toBe("old");
      expect(await manager.undoLatest()).toEqual({ status: "nothing" });
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("does not create a Delete barrier when an oversized path remains present", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-turn-undo-"));
    const filePath = path.join(workspace, "oversized.txt");
    const manager = new TurnUndoManager({
      snapshots: new Map(),
      limits: { maxFileBytes: 4, maxRuntimeBytes: 8, maxRecords: 20 },
    });
    const turn = turnIdentity(3);

    try {
      await writeFile(filePath, "12345");
      const capture = await manager.captureBeforeMutation({
        ...turn,
        absolutePath: filePath,
        displayPath: "oversized.txt",
        knownByteLength: 5,
        loadBefore: async () => {
          throw new Error("oversized Delete capture must stay lazy");
        },
      });
      await manager.recordMutationFailure(capture);
      manager.completeTurn(turn);

      expect(await manager.undoLatest()).toEqual({ status: "nothing" });
      expect(await readFile(filePath, "utf8")).toBe("12345");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("uses a turn-too-large barrier without blocking the mutations", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-turn-undo-"));
    const manager = new TurnUndoManager({
      snapshots: new Map(),
      limits: { maxFileBytes: 10, maxRuntimeBytes: 6, maxRecords: 20 },
    });
    const firstPath = path.join(workspace, "a.txt");
    const secondPath = path.join(workspace, "b.txt");
    const turn = turnIdentity(4);

    try {
      await writeFile(firstPath, "aaaa");
      await writeFile(secondPath, "bbbb");
      await mutateFile(manager, turn, firstPath, "a.txt", "1111");
      const second = await captureCurrent(manager, turn, secondPath, "b.txt");
      expect(second).toMatchObject({
        kind: "untracked",
        reason: { kind: "turn-too-large" },
      });
      await writeFile(secondPath, "2222");
      manager.recordMutationResult(second, present("2222"));
      manager.completeTurn(turn);

      expect(await manager.undoLatest()).toEqual({
        status: "unavailable",
        turnNumber: 4,
        reason: { kind: "turn-too-large" },
      });
      expect(await readFile(firstPath, "utf8")).toBe("1111");
      expect(await readFile(secondPath, "utf8")).toBe("2222");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("evicts old checkpoints for byte and record limits", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-turn-undo-"));
    const byteManager = new TurnUndoManager({
      snapshots: new Map(),
      limits: { maxFileBytes: 5, maxRuntimeBytes: 5, maxRecords: 20 },
    });
    const recordManager = new TurnUndoManager({
      snapshots: new Map(),
      limits: { maxFileBytes: 10, maxRuntimeBytes: 100, maxRecords: 2 },
    });

    try {
      const oldPath = path.join(workspace, "byte-old.txt");
      const newPath = path.join(workspace, "byte-new.txt");
      await writeFile(oldPath, "aaaa");
      await writeFile(newPath, "bbbb");
      const first = turnIdentity(1);
      await mutateFile(byteManager, first, oldPath, "byte-old.txt", "1111");
      byteManager.completeTurn(first);
      const second = turnIdentity(2);
      await mutateFile(byteManager, second, newPath, "byte-new.txt", "2222");
      byteManager.completeTurn(second);
      expect((await byteManager.undoLatest()).status).toBe("restored");
      expect(await byteManager.undoLatest()).toEqual({ status: "nothing" });
      expect(await readFile(oldPath, "utf8")).toBe("1111");

      const recordPaths: string[] = [];
      for (let index = 1; index <= 3; index += 1) {
        const filePath = path.join(workspace, `record-${index}.txt`);
        recordPaths.push(filePath);
        await writeFile(filePath, `a${index}`);
        const turn = turnIdentity(index);
        await mutateFile(
          recordManager,
          turn,
          filePath,
          path.basename(filePath),
          `b${index}`,
        );
        recordManager.completeTurn(turn);
      }
      expect((await recordManager.undoLatest()).status).toBe("restored");
      expect((await recordManager.undoLatest()).status).toBe("restored");
      expect(await recordManager.undoLatest()).toEqual({ status: "nothing" });
      expect(await readFile(recordPaths[0], "utf8")).toBe("b1");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("keeps a checkpoint after partial I/O failure and retries idempotently", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-turn-undo-"));
    const firstPath = path.join(workspace, "a.txt");
    const secondPath = path.join(workspace, "b.txt");
    const snapshots: FileSnapshotStore = new Map();
    let failSecondWrite = true;
    const manager = new TurnUndoManager({
      snapshots,
      fileSystem: {
        lstat: async (filePath) => lstat(filePath),
        readFile: async (filePath) => readFile(filePath),
        writeFile: async (filePath, bytes) => {
          if (filePath === secondPath && failSecondWrite) {
            failSecondWrite = false;
            throw new Error("simulated restore failure");
          }
          await writeFile(filePath, bytes);
        },
        unlink: async (filePath) => unlink(filePath),
      },
    });
    const turn = turnIdentity(9);

    try {
      await writeFile(firstPath, "a-before");
      await writeFile(secondPath, "b-before");
      await mutateFile(manager, turn, firstPath, "a.txt", "a-after");
      await mutateFile(manager, turn, secondPath, "b.txt", "b-after");
      manager.completeTurn(turn);
      snapshots.set(firstPath, { sha256: "a", mtimeMs: 1, source: "write" });
      snapshots.set(secondPath, { sha256: "b", mtimeMs: 1, source: "edit" });

      expect(await manager.undoLatest()).toEqual({
        status: "incomplete",
        turnNumber: 9,
        restoredFileCount: 1,
        deletedFileCount: 0,
        failedPath: "b.txt",
        detail: "simulated restore failure",
      });
      expect(await readFile(firstPath, "utf8")).toBe("a-before");
      expect(await readFile(secondPath, "utf8")).toBe("b-after");
      expect(snapshots.size).toBe(0);

      expect(await manager.undoLatest()).toEqual({
        status: "restored",
        turnNumber: 9,
        restoredFileCount: 2,
        deletedFileCount: 0,
      });
      expect(await readFile(secondPath, "utf8")).toBe("b-before");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("reconciles a mutation that changed the file before throwing", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-turn-undo-"));
    const filePath = path.join(workspace, "failed-write.txt");
    const manager = new TurnUndoManager({ snapshots: new Map() });
    const turn = turnIdentity(5);

    try {
      await writeFile(filePath, "before");
      const capture = await captureCurrent(manager, turn, filePath, "failed-write.txt");
      await writeFile(filePath, "changed-before-error");
      await manager.recordMutationFailure(capture);
      manager.completeTurn(turn);

      expect((await manager.undoLatest()).status).toBe("restored");
      expect(await readFile(filePath, "utf8")).toBe("before");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

type TestTurn = { turnId: TurnId; turnNumber: number };

function turnIdentity(turnNumber: number): TestTurn {
  return { turnId: runtimeIdFactory.createTurnId(), turnNumber };
}

async function captureCurrent(
  manager: TurnUndoManager,
  turn: TestTurn,
  absolutePath: string,
  displayPath: string,
): Promise<MutationCapture> {
  return manager.captureBeforeMutation({
    ...turn,
    absolutePath,
    displayPath,
    loadBefore: () => loadBefore(absolutePath),
  });
}

async function mutateFile(
  manager: TurnUndoManager,
  turn: TestTurn,
  absolutePath: string,
  displayPath: string,
  content: string,
): Promise<void> {
  const capture = await captureCurrent(manager, turn, absolutePath, displayPath);
  await writeFile(absolutePath, content);
  manager.recordMutationResult(capture, present(content));
}

async function loadBefore(absolutePath: string): Promise<BeforeMutationFileState> {
  try {
    return { state: "present", bytes: await readFile(absolutePath) };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { state: "absent" };
    }
    throw error;
  }
}

function present(content: string): FileStateFingerprint {
  return { state: "present", sha256: sha256Bytes(Buffer.from(content)) };
}
