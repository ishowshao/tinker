import { describe, expect, test } from "bun:test";
import { formatTurnUndoNotice } from "../tui/app";

describe("formatTurnUndoNotice", () => {
  test("formats empty, success, and capacity results", () => {
    expect(formatTurnUndoNotice({ status: "nothing" })).toBe(
      "Nothing to undo in this active session.",
    );
    expect(
      formatTurnUndoNotice({
        status: "restored",
        turnNumber: 7,
        restoredFileCount: 2,
        deletedFileCount: 1,
      }),
    ).toBe("Restored workspace to before turn 7: 2 files restored, 1 file deleted.");
    expect(
      formatTurnUndoNotice({
        status: "unavailable",
        turnNumber: 8,
        reason: { kind: "turn-too-large" },
      }),
    ).toBe("Cannot undo turn 8: undo snapshot capacity was exceeded.");
  });

  test("formats every drift conflict without hiding later paths", () => {
    expect(
      formatTurnUndoNotice({
        status: "refused",
        turnNumber: 7,
        conflicts: [
          { displayPath: "src/a.ts", detail: "content changed" },
          {
            displayPath: "src/b.ts",
            detail: "expected file, found missing",
          },
        ],
      }),
    ).toBe(
      "Undo refused: 2 files changed after turn 7.\n- src/a.ts: content changed\n- src/b.ts: expected file, found missing",
    );
  });

  test("formats capture and partial I/O failures with retry guidance", () => {
    expect(
      formatTurnUndoNotice({
        status: "unavailable",
        turnNumber: 4,
        reason: {
          kind: "capture-unavailable",
          displayPath: "locked.txt",
          detail: "permission denied",
        },
      }),
    ).toBe(
      "Cannot undo turn 4: undo snapshot could not be captured for locked.txt: permission denied.",
    );
    expect(
      formatTurnUndoNotice({
        status: "incomplete",
        turnNumber: 9,
        restoredFileCount: 1,
        deletedFileCount: 1,
        failedPath: "src/b.ts",
        detail: "disk full",
      }),
    ).toBe(
      "Undo incomplete for turn 9: 1 file restored and 1 file deleted before src/b.ts failed: disk full.\nRun /undo again to retry.",
    );
  });
});
