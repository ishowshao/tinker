import type { GrepContentRecord, GrepRecord } from "./grep-output";

const defaultHeadLimit = 250;

export function applyHeadLimit<T>(items: T[], limit: number | undefined, offset = 0) {
  const effectiveLimit = limit ?? defaultHeadLimit;
  const selected =
    effectiveLimit === 0
      ? items.slice(offset)
      : items.slice(offset, offset + effectiveLimit);
  const hasMore = offset + selected.length < items.length;
  return {
    items: selected,
    totalResults: items.length,
    returnedResults: selected.length,
    hasMore,
    nextOffset: hasMore ? offset + selected.length : undefined,
    appliedLimit: hasMore ? effectiveLimit : undefined,
  };
}

/** Match events select windows; matches encountered inside a window never expand it. */
export function applyContentHeadLimit(
  records: GrepRecord[],
  limit: number | undefined,
  offset: number,
  context: { before: number; after: number },
) {
  const matches = records.filter(
    (record): record is GrepContentRecord => record.kind === "match",
  );
  const page = applyHeadLimit(matches, limit, offset);
  const windows = new Map<string, { start: number; end: number }[]>();
  for (const match of page.items) {
    const ranges = windows.get(match.filePath) ?? [];
    const start = Math.max(1, match.lineNumber - context.before);
    const end = match.lineNumber + match.lines.length - 1 + context.after;
    const last = ranges.at(-1);
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
    windows.set(match.filePath, ranges);
  }

  const items: GrepContentRecord[] = [];
  // rg emits each physical line once, in file/line order. Walk merged windows
  // linearly rather than rescanning all records for every selected match.
  const cursors = new Map<string, number>();
  for (const record of records) {
    if (record.kind !== "match" && record.kind !== "context") continue;
    const ranges = windows.get(record.filePath);
    if (ranges === undefined) continue;
    let cursor = cursors.get(record.filePath) ?? 0;
    for (const [index, text] of record.lines.entries()) {
      const lineNumber = record.lineNumber + index;
      while (cursor < ranges.length && ranges[cursor].end < lineNumber) cursor++;
      const range = ranges[cursor];
      if (range === undefined) break;
      if (lineNumber >= range.start) {
        items.push({
          kind: record.kind,
          filePath: record.filePath,
          lineNumber,
          lines: [text],
        });
      }
    }
    cursors.set(record.filePath, cursor);
  }
  return { ...page, items };
}
