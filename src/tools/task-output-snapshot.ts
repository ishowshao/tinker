import { Buffer } from "node:buffer";
import { buildBoundedOutputPreview } from "./bounded-output-preview";
import type { TaskOutputSnapshot } from "./task-output";

export function buildOutputSnapshotFromText(bytes: Buffer): TaskOutputSnapshot {
  const text = bytes.toString("utf8");
  const lines = splitLines(text);
  const bounded = buildBoundedOutputPreview({
    outputLines: lines.length,
    lines,
  });

  return {
    outputBytes: bytes.byteLength,
    outputLines: lines.length,
    ...bounded,
  };
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.split(/\r\n|\n|\r/);
  if (text.endsWith("\n") || text.endsWith("\r")) {
    lines.pop();
  }

  return lines;
}
