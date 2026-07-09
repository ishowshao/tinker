import { structuredPatch } from "diff";
import type { DiffHunk } from "./types";

export const MAX_PATCH_LINES = 400;

export type FilePatch = {
  hunks: DiffHunk[];
  truncated: boolean;
};

export function computeFilePatch(input: {
  filePath: string;
  oldContent: string;
  newContent: string;
}): FilePatch {
  const patch = structuredPatch(
    input.filePath,
    input.filePath,
    input.oldContent,
    input.newContent,
    undefined,
    undefined,
    { context: 3 },
  );

  const hunks: DiffHunk[] = [];
  let remainingLines = MAX_PATCH_LINES;
  let truncated = false;

  for (const hunk of patch.hunks) {
    if (remainingLines <= 0) {
      truncated = true;
      break;
    }

    if (hunk.lines.length <= remainingLines) {
      hunks.push({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines: hunk.lines,
      });
      remainingLines -= hunk.lines.length;
      continue;
    }

    hunks.push({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: hunk.lines.slice(0, remainingLines),
    });
    truncated = true;
    break;
  }

  return { hunks, truncated };
}

export function parseDiffHunks(value: unknown): DiffHunk[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const hunks: DiffHunk[] = [];

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }

    const hunk = entry as Record<string, unknown>;
    const oldStart = hunk.oldStart;
    const oldLines = hunk.oldLines;
    const newStart = hunk.newStart;
    const newLines = hunk.newLines;
    const lines = hunk.lines;

    if (
      typeof oldStart !== "number" ||
      typeof oldLines !== "number" ||
      typeof newStart !== "number" ||
      typeof newLines !== "number" ||
      !Array.isArray(lines) ||
      !lines.every((line): line is string => typeof line === "string")
    ) {
      return undefined;
    }

    hunks.push({ oldStart, oldLines, newStart, newLines, lines });
  }

  return hunks;
}

export function countPatchChanges(hunks: DiffHunk[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        additions += 1;
      } else if (line.startsWith("-")) {
        deletions += 1;
      }
    }
  }

  return { additions, deletions };
}
