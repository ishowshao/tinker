import path from "node:path";
import { toDisplayPath } from "./path-safety";
import type { GrepOutputMode } from "./types";
import { excerptGrepLines } from "./grep-snippets";

export type GrepContentRecord = {
  kind: "match" | "context";
  filePath: string;
  lineNumber: number;
  /** Keep each JSON event intact so pagination cannot split a multiline match. */
  lines: string[];
};

export type GrepRecord =
  | { kind: "file"; filePath: string }
  | { kind: "count"; filePath: string; count: number }
  | GrepContentRecord;

/** Decode complete protocol records only. A truncated tail is never a record. */
export function parseGrepOutput(
  stdout: string,
  mode: GrepOutputMode,
  workspaceRoot: string,
  truncated: boolean,
  searchCwd: string = workspaceRoot,
): GrepRecord[] {
  if (mode === "content") {
    return parseJsonOutput(stdout, workspaceRoot, truncated, searchCwd);
  }
  const records: GrepRecord[] = [];
  let start = 0;
  while (start < stdout.length) {
    const nul = stdout.indexOf("\0", start);
    if (nul === -1) {
      if (truncated) break;
      throw new Error("Missing NUL path delimiter.");
    }
    const reportedPath = stdout.slice(start, nul);
    if (reportedPath === "") throw new Error("Empty path in ripgrep output.");
    const filePath = toDisplayPath(
      workspaceRoot,
      path.resolve(searchCwd, reportedPath),
    );
    if (mode === "files_with_matches") {
      records.push({ kind: "file", filePath });
      start = nul + 1;
      continue;
    }
    const end = stdout.indexOf("\n", nul + 1);
    if (end === -1) {
      if (truncated) break;
      throw new Error("Unterminated count record.");
    }
    const value = stdout.slice(nul + 1, end);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error("Invalid count in ripgrep output.");
    }
    records.push({ kind: "count", filePath, count: Number(value) });
    start = end + 1;
  }
  return records;
}

function parseJsonOutput(
  stdout: string,
  workspaceRoot: string,
  truncated: boolean,
  searchCwd: string,
): GrepRecord[] {
  const records: GrepRecord[] = [];
  let start = 0;
  while (start < stdout.length) {
    const end = stdout.indexOf("\n", start);
    if (end === -1) {
      if (truncated) break;
      throw new Error("Unterminated JSON event.");
    }
    const event: unknown = JSON.parse(stdout.slice(start, end));
    start = end + 1;
    if (!isRecord(event) || typeof event.type !== "string" || !isRecord(event.data)) {
      throw new Error("Invalid ripgrep JSON event.");
    }
    if (["begin", "end", "summary"].includes(event.type)) continue;
    if (event.type !== "match" && event.type !== "context") {
      throw new Error("Unexpected ripgrep JSON event type.");
    }
    const data = event.data;
    const reportedPath = decodeText(data.path, true);
    if (reportedPath === "") throw new Error("Empty path in ripgrep JSON event.");
    if (
      typeof data.line_number !== "number" ||
      !Number.isSafeInteger(data.line_number) ||
      data.line_number < 1
    ) {
      throw new Error("Invalid line number in ripgrep JSON event.");
    }
    const filePath = toDisplayPath(
      workspaceRoot,
      path.resolve(searchCwd, reportedPath),
    );
    records.push({
      kind: event.type,
      filePath,
      lineNumber: data.line_number,
      lines: excerptGrepLines(decodeBytes(data.lines), data.submatches),
    });
  }
  return records;
}

function decodeText(value: unknown, isPath: boolean): string {
  if (isRecord(value) && typeof value.text === "string") return value.text;
  return new TextDecoder("utf-8", { fatal: isPath }).decode(decodeBytes(value));
}

function decodeBytes(value: unknown): Buffer {
  if (!isRecord(value)) throw new Error("Invalid text field in ripgrep JSON event.");
  if (typeof value.text === "string") return Buffer.from(value.text, "utf8");
  if (
    typeof value.bytes === "string" &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bytes)
  ) {
    return Buffer.from(value.bytes, "base64");
  }
  throw new Error("Invalid text encoding in ripgrep JSON event.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
