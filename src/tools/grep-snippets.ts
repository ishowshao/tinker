const maxLineCodePoints = 500;
const matchContextCodePoints = 100;

type MatchRange = { start: number; end: number };

/** rg submatch offsets address the original bytes of the entire JSON event. */
export function excerptGrepLines(bytes: Buffer, submatches: unknown): string[] {
  const matches = parseSubmatches(submatches, bytes.length);
  const lines: string[] = [];
  let start = 0;
  let matchIndex = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    const end = newline === -1 ? bytes.length : newline;
    const textEnd = end > start && bytes[end - 1] === 13 ? end - 1 : end;
    while (matchIndex < matches.length && matches[matchIndex].end < start) {
      matchIndex++;
    }
    lines.push(excerptLine(bytes.subarray(start, textEnd), matches, matchIndex, start));
    start = end + 1;
  }
  return lines;
}

function excerptLine(
  bytes: Buffer,
  matches: MatchRange[],
  matchIndex: number,
  lineStart: number,
): string {
  const points = [...bytes.toString("utf8")];
  if (points.length <= maxLineCodePoints) return points.join("");

  const windows: MatchRange[] = [];
  const codePointOffset = createCodePointOffsetReader(bytes);
  let remaining = maxLineCodePoints;
  for (let index = matchIndex; index < matches.length && remaining > 0; index++) {
    const match = matches[index];
    if (match.start > lineStart + bytes.length) break;
    if (match.end === lineStart && match.start < lineStart) continue;
    const matchStart = codePointOffset(match.start - lineStart);
    const matchEnd = codePointOffset(match.end - lineStart);
    const previous = windows.at(-1);
    // Reserve room for the match even when earlier windows used most of the budget.
    const before = Math.min(matchContextCodePoints, Math.floor(remaining / 2));
    const start = Math.max(0, matchStart - before);
    const end = Math.min(points.length, matchEnd + matchContextCodePoints);
    if (previous !== undefined && start <= previous.end) {
      const extension = Math.min(remaining, Math.max(0, end - previous.end));
      previous.end += extension;
      remaining -= extension;
    } else {
      const keptEnd = Math.min(end, start + remaining);
      windows.push({ start, end: keptEnd });
      remaining -= keptEnd - start;
    }
  }
  // Context events (and legacy fixtures without submatches) still retain useful text.
  if (windows.length === 0) windows.push({ start: 0, end: maxLineCodePoints });

  const parts: string[] = [];
  let cursor = 0;
  for (const window of windows) {
    if (window.start > cursor) parts.push(omission(window.start - cursor));
    parts.push(points.slice(window.start, window.end).join(""));
    cursor = window.end;
  }
  if (cursor < points.length) parts.push(omission(points.length - cursor));
  return parts.join("");
}

function createCodePointOffsetReader(bytes: Buffer): (offset: number) => number {
  let byteCursor = 0;
  let pointCursor = 0;
  // Submatches are ordered and non-overlapping; scan each prefix only once.
  return (offset) => {
    const end = Math.max(0, Math.min(offset, bytes.length));
    pointCursor += [...bytes.subarray(byteCursor, end).toString("utf8")].length;
    byteCursor = end;
    return pointCursor;
  };
}

function omission(count: number): string {
  return `[... ${count} code points omitted ...]`;
}

function parseSubmatches(value: unknown, byteLength: number): MatchRange[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid ripgrep submatches.");
  let previousEnd = 0;
  return value.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("start" in item) ||
      !("end" in item) ||
      typeof item.start !== "number" ||
      typeof item.end !== "number" ||
      !Number.isSafeInteger(item.start) ||
      !Number.isSafeInteger(item.end) ||
      item.start < previousEnd ||
      item.end < item.start ||
      item.end > byteLength
    ) {
      throw new Error("Invalid ripgrep submatch offsets.");
    }
    previousEnd = item.end;
    return { start: item.start, end: item.end };
  });
}
