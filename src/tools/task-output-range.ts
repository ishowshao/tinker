import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_LINE_BYTES,
  takeUtf8Prefix,
} from "./bounded-output-preview";
import type { TaskOutputSnapshot } from "./task-output";

export type TaskOutputRangeRequest = { offset: number; limit: number };
export type TaskOutputRange = TaskOutputRangeRequest & {
  displayedStartLine?: number;
  displayedEndLine?: number;
};

// Read only the captured byte prefix, even if the process keeps appending output.
// Memory is bounded by one read chunk, one bounded line, and the returned preview.
export async function readTaskOutputRange(input: {
  filePath: string;
  snapshot: TaskOutputSnapshot;
  range: TaskOutputRangeRequest;
  ended: boolean;
  signal?: AbortSignal;
}): Promise<TaskOutputSnapshot> {
  const { snapshot, range } = input;
  const requestedLines = Math.min(
    range.limit,
    Math.max(0, snapshot.outputLines - range.offset + 1),
  );
  const lines: string[] = [];
  let previewBytes = 0;
  let lineNumber = 1;
  let linePrefix = "";
  let lineClipped = false;
  let truncated = false;
  let done = requestedLines === 0;
  const decoder = new StringDecoder("utf8");

  function append(text: string): void {
    if (lineNumber < range.offset || lineClipped) {
      return;
    }
    const combined = linePrefix + text;
    // Keep one extra byte until the newline is known, so a CRLF terminator
    // does not make an otherwise exactly-sized line appear truncated.
    if (Buffer.byteLength(combined) > MAX_PREVIEW_LINE_BYTES + 1) {
      linePrefix = takeUtf8Prefix(combined, MAX_PREVIEW_LINE_BYTES + 1);
      lineClipped = true;
    } else {
      linePrefix = combined;
    }
  }

  function finishLine(terminated: boolean): void {
    if (lineNumber >= range.offset) {
      let text = linePrefix;
      if (!lineClipped && terminated && text.endsWith("\r")) {
        text = text.slice(0, -1);
      }
      lineClipped ||= Buffer.byteLength(text) > MAX_PREVIEW_LINE_BYTES;
      if (lineClipped) {
        const marker = "... line truncated; full output at outputFilePath ...";
        text =
          takeUtf8Prefix(text, MAX_PREVIEW_LINE_BYTES - Buffer.byteLength(marker)) +
          marker;
      }
      const numbered = `${lineNumber}: ${text}`;
      const bytes = Buffer.byteLength(numbered) + (lines.length === 0 ? 0 : 1);
      if (previewBytes + bytes > MAX_PREVIEW_BYTES) {
        done = true;
        return;
      }
      lines.push(numbered);
      previewBytes += bytes;
      truncated ||= lineClipped;
      done = lines.length === requestedLines;
    }
    lineNumber += 1;
    linePrefix = "";
    lineClipped = false;
  }

  function consume(text: string): void {
    let start = 0;
    while (!done) {
      const end = text.indexOf("\n", start);
      if (end === -1) {
        append(text.slice(start));
        return;
      }
      append(text.slice(start, end));
      finishLine(true);
      start = end + 1;
    }
  }

  if (!done && snapshot.outputBytes > 0) {
    const stream = createReadStream(input.filePath, {
      start: 0,
      end: snapshot.outputBytes - 1,
      highWaterMark: 64 * 1024,
      signal: input.signal,
    });
    let bytesRead = 0;
    try {
      for await (const chunk of stream) {
        bytesRead += (chunk as Buffer).byteLength;
        consume(decoder.write(chunk as Buffer));
        if (done) {
          break;
        }
      }
      if (!done && bytesRead < snapshot.outputBytes) {
        throw new Error("Task output log ended before the captured byte boundary.");
      }
      // A running task may have captured only the first bytes of a UTF-8 code
      // point. Match TaskOutput's decoder: do not invent a replacement character.
      if (!done && input.ended) {
        consume(decoder.end());
      }
      if (!done && lineNumber <= snapshot.outputLines) {
        finishLine(false);
      }
    } finally {
      stream.destroy();
    }
  }

  const omittedLines = requestedLines - lines.length;
  return {
    outputBytes: snapshot.outputBytes,
    outputLines: snapshot.outputLines,
    preview: lines.join("\n"),
    truncated: truncated || omittedLines > 0,
    ...(omittedLines > 0 ? { omittedLines } : {}),
    range: {
      ...range,
      ...(lines.length === 0
        ? {}
        : {
            displayedStartLine: range.offset,
            displayedEndLine: range.offset + lines.length - 1,
          }),
    },
  };
}
