import { Buffer } from "node:buffer";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TurnId } from "../ids/runtime-id";
import type { TurnIdentity } from "../agent/types";
import { sha256Bytes } from "./hash";
import type { FileSnapshotStore } from "./types";

const MEBIBYTE = 1024 * 1024;

export const TURN_UNDO_LIMITS = Object.freeze({
  maxFileBytes: 32 * MEBIBYTE,
  maxRuntimeBytes: 64 * MEBIBYTE,
  maxRecords: 20,
});

export type CapturedFileState =
  | { state: "absent" }
  | {
      state: "present";
      bytes: Buffer;
      sha256: string;
      byteLength: number;
    };

export type FileStateFingerprint =
  | { state: "absent" }
  | { state: "present"; sha256: string };

export type TurnUndoBarrierReason =
  | { kind: "file-too-large"; displayPath: string; byteLength: number }
  | { kind: "turn-too-large" }
  | { kind: "capture-unavailable"; displayPath: string; detail: string };

export type MutationCapture =
  | {
      kind: "tracked";
      turnId: TurnId;
      absolutePath: string;
      generation: number;
      beforeFingerprint: FileStateFingerprint;
    }
  | {
      kind: "untracked";
      turnId: TurnId;
      absolutePath: string;
      displayPath: string;
      reason: TurnUndoBarrierReason;
      beforeFingerprint?: FileStateFingerprint;
      beforeKnownPresent?: true;
    };

export type TurnUndoConflict = {
  readonly displayPath: string;
  readonly detail: string;
};

export type TurnUndoResult =
  | { readonly status: "nothing" }
  | {
      readonly status: "unavailable";
      readonly turnNumber: number;
      readonly reason: TurnUndoBarrierReason;
    }
  | {
      readonly status: "refused";
      readonly turnNumber: number;
      readonly conflicts: readonly TurnUndoConflict[];
    }
  | {
      readonly status: "restored";
      readonly turnNumber: number;
      readonly restoredFileCount: number;
      readonly deletedFileCount: number;
    }
  | {
      readonly status: "incomplete";
      readonly turnNumber: number;
      readonly restoredFileCount: number;
      readonly deletedFileCount: number;
      readonly failedPath: string;
      readonly detail: string;
    };

export type BeforeMutationFileState =
  | { state: "absent" }
  | { state: "present"; bytes: Uint8Array };

type TurnUndoEntry = {
  absolutePath: string;
  displayPath: string;
  before: CapturedFileState;
  expectedAfter?: FileStateFingerprint;
  mutationCount: number;
  generation: number;
};

type ActiveTurnUndo = {
  turnId: TurnId;
  turnNumber: number;
  entries: Map<string, TurnUndoEntry>;
  retainedBytes: number;
  unavailableReason?: TurnUndoBarrierReason;
};

type TurnUndoCheckpoint = {
  kind: "checkpoint";
  turnId: TurnId;
  turnNumber: number;
  entries: Map<string, TurnUndoEntry>;
  retainedBytes: number;
  completed: true;
};

type TurnUndoBarrier = {
  kind: "barrier";
  turnId: TurnId;
  turnNumber: number;
  reason: TurnUndoBarrierReason;
};

type TurnUndoRecord = TurnUndoCheckpoint | TurnUndoBarrier;

type CurrentFileState =
  | FileStateFingerprint
  | { state: "other"; kind: string }
  | { state: "unavailable"; detail: string };

type TurnUndoFileSystem = {
  lstat(filePath: string): Promise<{
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>;
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, bytes: Buffer): Promise<void>;
  unlink(filePath: string): Promise<void>;
};

type TurnUndoLimits = {
  maxFileBytes: number;
  maxRuntimeBytes: number;
  maxRecords: number;
};

export type TurnUndoManagerOptions = {
  snapshots: FileSnapshotStore;
  limits?: TurnUndoLimits;
  fileSystem?: TurnUndoFileSystem;
};

const DEFAULT_FILE_SYSTEM: TurnUndoFileSystem = {
  lstat: async (filePath) => lstat(filePath),
  readFile: async (filePath) => readFile(filePath),
  writeFile: async (filePath, bytes) => writeFile(filePath, bytes),
  unlink: async (filePath) => unlink(filePath),
};

export class TurnUndoManager {
  private readonly records: TurnUndoRecord[] = [];
  private readonly limits: TurnUndoLimits;
  private readonly fileSystem: TurnUndoFileSystem;
  private activeTurn?: ActiveTurnUndo;
  private retainedBytes = 0;
  private nextGeneration = 1;

  constructor(private readonly options: TurnUndoManagerOptions) {
    this.limits = options.limits ?? TURN_UNDO_LIMITS;
    this.fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
  }

  async captureBeforeMutation(input: {
    turnId: TurnId;
    turnNumber: number;
    absolutePath: string;
    displayPath: string;
    knownByteLength?: number;
    loadBefore: () => Promise<BeforeMutationFileState>;
  }): Promise<MutationCapture> {
    const turn = this.ensureActiveTurn(input);
    const absolutePath = path.normalize(input.absolutePath);
    const existing = turn.entries.get(absolutePath);

    if (turn.unavailableReason !== undefined) {
      return {
        kind: "untracked",
        turnId: turn.turnId,
        absolutePath,
        displayPath: input.displayPath,
        reason: turn.unavailableReason,
      };
    }

    if (existing !== undefined && existing.mutationCount > 0) {
      if (existing.expectedAfter === undefined) {
        throw new Error("A recorded undo mutation is missing its resulting state.");
      }
      return {
        kind: "tracked",
        turnId: turn.turnId,
        absolutePath,
        generation: existing.generation,
        beforeFingerprint: existing.expectedAfter,
      };
    }

    if (existing !== undefined) {
      this.removeActiveEntry(turn, existing);
    }

    if (
      input.knownByteLength !== undefined &&
      input.knownByteLength > this.limits.maxFileBytes
    ) {
      return this.untrackedCapture(input, absolutePath, {
        kind: "file-too-large",
        displayPath: input.displayPath,
        byteLength: input.knownByteLength,
      });
    }

    let loaded: BeforeMutationFileState;
    try {
      loaded = await input.loadBefore();
    } catch (error) {
      return this.untrackedCapture(input, absolutePath, {
        kind: "capture-unavailable",
        displayPath: input.displayPath,
        detail: errorMessage(error),
      });
    }

    const loadedByteLength = loaded.state === "present" ? loaded.bytes.byteLength : 0;
    const loadedFingerprint =
      loaded.state === "present"
        ? { state: "present" as const, sha256: sha256Bytes(loaded.bytes) }
        : { state: "absent" as const };
    if (loadedByteLength > this.limits.maxFileBytes) {
      return this.untrackedCapture(
        input,
        absolutePath,
        {
          kind: "file-too-large",
          displayPath: input.displayPath,
          byteLength: loadedByteLength,
        },
        loadedFingerprint,
      );
    }

    const addedBytes = loadedByteLength;
    if (turn.retainedBytes + addedBytes > this.limits.maxRuntimeBytes) {
      return this.untrackedCapture(
        input,
        absolutePath,
        { kind: "turn-too-large" },
        loadedFingerprint,
      );
    }

    this.evictCheckpointsForBytes(addedBytes);
    const prepared = captureFileState(loaded, loadedFingerprint);
    const entry: TurnUndoEntry = {
      absolutePath,
      displayPath: input.displayPath,
      before: prepared,
      mutationCount: 0,
      generation: this.nextGeneration,
    };
    this.nextGeneration += 1;
    turn.entries.set(absolutePath, entry);
    turn.retainedBytes += addedBytes;
    this.retainedBytes += addedBytes;

    return {
      kind: "tracked",
      turnId: turn.turnId,
      absolutePath,
      generation: entry.generation,
      beforeFingerprint: fingerprint(prepared),
    };
  }

  recordMutationResult(capture: MutationCapture, after: FileStateFingerprint): void {
    const turn = this.requireCaptureTurn(capture);
    if (turn.unavailableReason !== undefined) {
      return;
    }

    if (capture.kind === "untracked") {
      if (
        capture.beforeFingerprint !== undefined &&
        sameFingerprint(capture.beforeFingerprint, after)
      ) {
        return;
      }
      this.markTurnUnavailable(turn, capture.reason);
      return;
    }

    const entry = turn.entries.get(capture.absolutePath);
    if (entry === undefined || entry.generation !== capture.generation) {
      throw new Error("Undo mutation capture is no longer current.");
    }
    entry.expectedAfter = after;
    entry.mutationCount += 1;
  }

  async recordMutationFailure(capture: MutationCapture): Promise<void> {
    const turn = this.requireCaptureTurn(capture);
    if (turn.unavailableReason !== undefined) {
      return;
    }

    const current = await this.inspectCurrentState(capture.absolutePath);
    if (isFingerprint(current)) {
      if (
        capture.beforeFingerprint !== undefined &&
        sameFingerprint(capture.beforeFingerprint, current)
      ) {
        this.discardMutationCapture(capture);
        return;
      }
      if (capture.kind === "untracked" && capture.beforeKnownPresent === true) {
        if (current.state === "present") {
          return;
        }
      }
      if (capture.kind === "tracked") {
        this.recordMutationResult(capture, current);
        return;
      }
      this.markTurnUnavailable(turn, capture.reason);
      return;
    }

    this.markTurnUnavailable(
      turn,
      capture.kind === "untracked"
        ? capture.reason
        : {
            kind: "capture-unavailable",
            displayPath: this.displayPathForCapture(turn, capture),
            detail:
              current.state === "unavailable"
                ? `could not determine the file state after a failed mutation: ${current.detail}`
                : `path became ${current.kind} after a failed mutation`,
          },
    );
  }

  discardMutationCapture(capture: MutationCapture): void {
    if (capture.kind === "untracked") {
      return;
    }
    const turn = this.requireCaptureTurn(capture);
    const entry = turn.entries.get(capture.absolutePath);
    if (
      entry !== undefined &&
      entry.generation === capture.generation &&
      entry.mutationCount === 0
    ) {
      this.removeActiveEntry(turn, entry);
    }
  }

  completeTurn(turn: Pick<TurnIdentity, "turnId" | "turnNumber">): void {
    const active = this.activeTurn;
    if (active === undefined) {
      return;
    }
    if (active.turnId !== turn.turnId || active.turnNumber !== turn.turnNumber) {
      throw new Error("Cannot complete undo state for a different turn.");
    }
    this.activeTurn = undefined;

    if (active.unavailableReason !== undefined) {
      this.releaseActiveEntries(active);
      this.records.push({
        kind: "barrier",
        turnId: active.turnId,
        turnNumber: active.turnNumber,
        reason: active.unavailableReason,
      });
      this.enforceRecordLimit();
      return;
    }

    for (const entry of [...active.entries.values()]) {
      if (
        entry.mutationCount === 0 ||
        entry.expectedAfter === undefined ||
        sameFingerprint(fingerprint(entry.before), entry.expectedAfter)
      ) {
        this.removeActiveEntry(active, entry);
      }
    }

    if (active.entries.size === 0) {
      return;
    }

    this.records.push({
      kind: "checkpoint",
      turnId: active.turnId,
      turnNumber: active.turnNumber,
      entries: active.entries,
      retainedBytes: active.retainedBytes,
      completed: true,
    });
    this.enforceRecordLimit();
  }

  async undoLatest(): Promise<TurnUndoResult> {
    if (this.activeTurn !== undefined) {
      throw new Error("Cannot undo while a turn is active.");
    }
    const record = this.records.at(-1);
    if (record === undefined) {
      return { status: "nothing" };
    }
    if (record.kind === "barrier") {
      return {
        status: "unavailable",
        turnNumber: record.turnNumber,
        reason: record.reason,
      };
    }

    const orderedEntries = [...record.entries.values()].sort((left, right) =>
      left.absolutePath.localeCompare(right.absolutePath),
    );
    const pending: TurnUndoEntry[] = [];
    const alreadyRestored: TurnUndoEntry[] = [];
    const conflicts: TurnUndoConflict[] = [];
    let restoredFileCount = 0;
    let deletedFileCount = 0;

    for (const entry of orderedEntries) {
      if (entry.expectedAfter === undefined) {
        throw new Error("A completed undo entry is missing its resulting state.");
      }
      const current = await this.inspectCurrentState(entry.absolutePath);
      if (currentMatches(current, fingerprint(entry.before))) {
        alreadyRestored.push(entry);
        if (entry.before.state === "present") {
          restoredFileCount += 1;
        } else {
          deletedFileCount += 1;
        }
        continue;
      }
      if (currentMatches(current, entry.expectedAfter)) {
        pending.push(entry);
        continue;
      }
      conflicts.push({
        displayPath: entry.displayPath,
        detail: conflictDetail(entry.expectedAfter, current),
      });
    }

    if (conflicts.length > 0) {
      return {
        status: "refused",
        turnNumber: record.turnNumber,
        conflicts,
      };
    }

    for (const entry of alreadyRestored) {
      this.options.snapshots.delete(entry.absolutePath);
    }

    for (const entry of pending) {
      try {
        if (entry.before.state === "absent") {
          await this.fileSystem.unlink(entry.absolutePath);
        } else {
          await this.fileSystem.writeFile(entry.absolutePath, entry.before.bytes);
        }
        const verified = await this.inspectCurrentState(entry.absolutePath);
        if (!currentMatches(verified, fingerprint(entry.before))) {
          throw new Error(
            `restored state verification failed: ${describeCurrentState(verified)}`,
          );
        }
        if (entry.before.state === "present") {
          restoredFileCount += 1;
        } else {
          deletedFileCount += 1;
        }
      } catch (error) {
        return {
          status: "incomplete",
          turnNumber: record.turnNumber,
          restoredFileCount,
          deletedFileCount,
          failedPath: entry.displayPath,
          detail: errorMessage(error),
        };
      } finally {
        this.options.snapshots.delete(entry.absolutePath);
      }
    }

    for (const entry of orderedEntries) {
      const current = await this.inspectCurrentState(entry.absolutePath);
      if (!currentMatches(current, fingerprint(entry.before))) {
        return {
          status: "incomplete",
          turnNumber: record.turnNumber,
          restoredFileCount,
          deletedFileCount,
          failedPath: entry.displayPath,
          detail: `final restored state verification failed: ${describeCurrentState(current)}`,
        };
      }
    }

    const consumed = this.records.pop();
    if (consumed !== record) {
      throw new Error("Undo stack changed while a checkpoint was being restored.");
    }
    this.retainedBytes -= record.retainedBytes;
    return {
      status: "restored",
      turnNumber: record.turnNumber,
      restoredFileCount,
      deletedFileCount,
    };
  }

  private ensureActiveTurn(input: {
    turnId: TurnId;
    turnNumber: number;
  }): ActiveTurnUndo {
    if (this.activeTurn === undefined) {
      this.activeTurn = {
        turnId: input.turnId,
        turnNumber: input.turnNumber,
        entries: new Map(),
        retainedBytes: 0,
      };
      return this.activeTurn;
    }
    if (
      this.activeTurn.turnId !== input.turnId ||
      this.activeTurn.turnNumber !== input.turnNumber
    ) {
      throw new Error("Concurrent turns cannot share one TurnUndoManager.");
    }
    return this.activeTurn;
  }

  private requireCaptureTurn(capture: MutationCapture): ActiveTurnUndo {
    const turn = this.activeTurn;
    if (turn === undefined || turn.turnId !== capture.turnId) {
      throw new Error("Undo mutation capture does not belong to the active turn.");
    }
    return turn;
  }

  private untrackedCapture(
    input: {
      turnId: TurnId;
      displayPath: string;
      knownByteLength?: number;
    },
    absolutePath: string,
    reason: TurnUndoBarrierReason,
    beforeFingerprint?: FileStateFingerprint,
  ): MutationCapture {
    return {
      kind: "untracked",
      turnId: input.turnId,
      absolutePath,
      displayPath: input.displayPath,
      reason,
      ...(beforeFingerprint === undefined ? {} : { beforeFingerprint }),
      ...(input.knownByteLength === undefined ? {} : { beforeKnownPresent: true }),
    };
  }

  private markTurnUnavailable(
    turn: ActiveTurnUndo,
    reason: TurnUndoBarrierReason,
  ): void {
    if (turn.unavailableReason !== undefined) {
      return;
    }
    turn.unavailableReason = reason;
    this.releaseActiveEntries(turn);
    this.releaseAllRecords();
  }

  private removeActiveEntry(turn: ActiveTurnUndo, entry: TurnUndoEntry): void {
    if (!turn.entries.delete(entry.absolutePath)) {
      return;
    }
    const bytes = retainedByteLength(entry.before);
    turn.retainedBytes -= bytes;
    this.retainedBytes -= bytes;
  }

  private releaseActiveEntries(turn: ActiveTurnUndo): void {
    for (const entry of turn.entries.values()) {
      const bytes = retainedByteLength(entry.before);
      turn.retainedBytes -= bytes;
      this.retainedBytes -= bytes;
    }
    turn.entries.clear();
  }

  private releaseAllRecords(): void {
    for (const record of this.records) {
      if (record.kind === "checkpoint") {
        this.retainedBytes -= record.retainedBytes;
      }
    }
    this.records.length = 0;
  }

  private evictCheckpointsForBytes(addedBytes: number): void {
    while (this.retainedBytes + addedBytes > this.limits.maxRuntimeBytes) {
      const index = this.records.findIndex((record) => record.kind === "checkpoint");
      if (index === -1) {
        throw new Error("Undo byte accounting cannot satisfy the runtime limit.");
      }
      const [removed] = this.records.splice(index, 1);
      if (removed?.kind === "checkpoint") {
        this.retainedBytes -= removed.retainedBytes;
      }
    }
  }

  private enforceRecordLimit(): void {
    while (this.records.length > this.limits.maxRecords) {
      const removed = this.records.shift();
      if (removed?.kind === "checkpoint") {
        this.retainedBytes -= removed.retainedBytes;
      }
    }
  }

  private displayPathForCapture(
    turn: ActiveTurnUndo,
    capture: Extract<MutationCapture, { kind: "tracked" }>,
  ): string {
    return turn.entries.get(capture.absolutePath)?.displayPath ?? capture.absolutePath;
  }

  private async inspectCurrentState(absolutePath: string): Promise<CurrentFileState> {
    let info: Awaited<ReturnType<TurnUndoFileSystem["lstat"]>>;
    try {
      info = await this.fileSystem.lstat(absolutePath);
    } catch (error) {
      return isNotFound(error)
        ? { state: "absent" }
        : { state: "unavailable", detail: errorMessage(error) };
    }

    if (!info.isFile()) {
      return { state: "other", kind: fileKind(info) };
    }

    let bytes: Buffer;
    try {
      bytes = await this.fileSystem.readFile(absolutePath);
    } catch (error) {
      return isNotFound(error)
        ? { state: "absent" }
        : { state: "unavailable", detail: errorMessage(error) };
    }

    try {
      const verified = await this.fileSystem.lstat(absolutePath);
      if (!verified.isFile()) {
        return { state: "other", kind: fileKind(verified) };
      }
    } catch (error) {
      return isNotFound(error)
        ? { state: "absent" }
        : { state: "unavailable", detail: errorMessage(error) };
    }

    return { state: "present", sha256: sha256Bytes(bytes) };
  }
}

function captureFileState(
  state: BeforeMutationFileState,
  preparedFingerprint: FileStateFingerprint,
): CapturedFileState {
  if (state.state === "absent") {
    return state;
  }
  const bytes = Buffer.from(state.bytes);
  if (preparedFingerprint.state !== "present") {
    throw new Error("Present undo bytes are missing their fingerprint.");
  }
  return {
    state: "present",
    bytes,
    sha256: preparedFingerprint.sha256,
    byteLength: bytes.byteLength,
  };
}

function retainedByteLength(state: CapturedFileState): number {
  return state.state === "present" ? state.byteLength : 0;
}

function fingerprint(state: CapturedFileState): FileStateFingerprint {
  return state.state === "absent"
    ? { state: "absent" }
    : { state: "present", sha256: state.sha256 };
}

function sameFingerprint(
  left: FileStateFingerprint,
  right: FileStateFingerprint,
): boolean {
  return (
    left.state === right.state &&
    (left.state === "absent" ||
      (right.state === "present" && left.sha256 === right.sha256))
  );
}

function isFingerprint(state: CurrentFileState): state is FileStateFingerprint {
  return state.state === "absent" || state.state === "present";
}

function currentMatches(
  current: CurrentFileState,
  expected: FileStateFingerprint,
): boolean {
  return isFingerprint(current) && sameFingerprint(current, expected);
}

function conflictDetail(
  expected: FileStateFingerprint,
  current: CurrentFileState,
): string {
  if (current.state === "unavailable") {
    return `could not inspect file: ${current.detail}`;
  }
  if (current.state === "other") {
    return `expected ${expected.state === "present" ? "file" : "missing"}, found ${current.kind}`;
  }
  if (expected.state === "present") {
    return current.state === "absent"
      ? "expected file, found missing"
      : "content changed";
  }
  return "expected missing, found file";
}

function describeCurrentState(current: CurrentFileState): string {
  if (current.state === "absent") {
    return "found missing";
  }
  if (current.state === "present") {
    return "content changed";
  }
  if (current.state === "other") {
    return `found ${current.kind}`;
  }
  return `could not inspect file: ${current.detail}`;
}

function fileKind(info: { isDirectory(): boolean; isSymbolicLink(): boolean }): string {
  if (info.isSymbolicLink()) {
    return "symbolic link";
  }
  if (info.isDirectory()) {
    return "directory";
  }
  return "non-regular path";
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
