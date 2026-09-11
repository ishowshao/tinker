import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { MemoryTextSearchResult, MemorySearchLine } from "../tools/types";

export type MemorySearchInput = {
  keywords: string[];
  context: number;
  limit: number;
  offset: number;
};

export async function searchMemoryFiles(
  directory: string,
  input: MemorySearchInput,
  signal: AbortSignal,
): Promise<MemoryTextSearchResult> {
  const paths = await markdownFiles(directory, signal);
  const keywords = input.keywords.map((word) => word.toLowerCase());
  const files: MemoryTextSearchResult["files"][number][] = [];
  let seen = 0;
  let returnedResults = 0;
  let hasMore = false;
  for (const filePath of paths) {
    signal.throwIfAborted();
    const stream = createReadStream(filePath, { encoding: "utf8", signal });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    const before: MemorySearchLine[] = [];
    const selected = new Map<number, MemorySearchLine>();
    let lineNumber = 0;
    let through = 0;
    try {
      for await (const text of reader) {
        signal.throwIfAborted();
        lineNumber++;
        const folded = text.toLowerCase();
        let matchAt = -1;
        for (const keyword of keywords) {
          const position = folded.indexOf(keyword);
          if (position >= 0 && (matchAt < 0 || position < matchAt)) matchAt = position;
        }
        const match = matchAt >= 0;
        const line = { lineNumber, match, text: excerpt(text, matchAt) };
        if (match) {
          if (seen >= input.offset && returnedResults < input.limit) {
            returnedResults++;
            for (const previous of before) selected.set(previous.lineNumber, previous);
            through = lineNumber + input.context;
          } else if (returnedResults === input.limit) {
            hasMore = true;
          }
          seen++;
        }
        if (lineNumber <= through) selected.set(lineNumber, line);
        if (hasMore && lineNumber >= through) break;
        if (input.context > 0) {
          before.push(line);
          if (before.length > input.context) before.shift();
        }
      }
    } finally {
      reader.close();
      stream.destroy();
    }
    if (selected.size > 0)
      files.push({
        filePath,
        lines: [...selected.values()].sort((a, b) => a.lineNumber - b.lineNumber),
      });
    if (hasMore) break;
  }
  signal.throwIfAborted();
  return {
    ok: true,
    format: "text",
    files,
    returnedResults,
    hasMore,
    ...(hasMore ? { nextOffset: input.offset + returnedResults } : {}),
  };
}

async function markdownFiles(
  directory: string,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    signal.throwIfAborted();
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(filePath, signal)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      files.push(filePath);
  }
  return files.sort();
}

/** Keep up to 500 original code points around the earliest literal match. */
function excerpt(text: string, foldedMatchOffset: number): string {
  const points = [...text];
  if (points.length <= 500) return text;
  let matchPoint = 0;
  let foldedOffset = 0;
  if (foldedMatchOffset >= 0) {
    while (matchPoint < points.length && foldedOffset < foldedMatchOffset) {
      foldedOffset += points[matchPoint].toLowerCase().length;
      matchPoint++;
    }
  }
  const start = Math.max(0, matchPoint - 100);
  const end = Math.min(points.length, start + 500);
  return `${start > 0 ? `[... ${start} code points omitted ...]` : ""}${points.slice(start, end).join("")}${end < points.length ? `[... ${points.length - end} code points omitted ...]` : ""}`;
}
