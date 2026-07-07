import { Buffer } from "node:buffer";
import type { TaskOutputSnapshot } from "./task-output";

const maxPreviewLines = 200;
const previewEdgeLines = 100;

export function buildOutputSnapshotFromText(bytes: Buffer): TaskOutputSnapshot {
  const text = bytes.toString("utf8");
  const lines = splitLines(text);

  if (lines.length <= maxPreviewLines) {
    return {
      outputBytes: bytes.byteLength,
      outputLines: lines.length,
      preview: lines.join("\n"),
      truncated: false,
    };
  }

  const omittedLines = lines.length - maxPreviewLines;
  return {
    outputBytes: bytes.byteLength,
    outputLines: lines.length,
    preview: [
      ...lines.slice(0, previewEdgeLines),
      `... output omitted: ${omittedLines} lines omitted. Full output is available at outputFilePath.`,
      ...lines.slice(-previewEdgeLines),
    ].join("\n"),
    truncated: true,
    omittedLines,
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
