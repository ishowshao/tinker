import { Buffer } from "node:buffer";

export const MAX_PREVIEW_LINES = 200;
export const PREVIEW_EDGE_LINES = 100;
export const MAX_PREVIEW_BYTES = 32 * 1024;
export const MAX_PREVIEW_LINE_BYTES = 8 * 1024;

export type BoundedOutputPreview = {
  preview: string;
  truncated: boolean;
  omittedLines?: number;
};

export type OutputPreviewSource =
  | {
      outputLines: number;
      lines: readonly string[];
    }
  | {
      outputLines: number;
      firstLines: readonly string[];
      lastLines: readonly string[];
    };

type LineWindow = {
  leadingLines: readonly string[];
  trailingLines: readonly string[];
  omittedLines: number;
};

type BoundedLine = {
  text: string;
  truncated: boolean;
};

export function buildBoundedOutputPreview(
  source: OutputPreviewSource,
): BoundedOutputPreview {
  const window = selectLineWindow(source);
  const leadingLines = window.leadingLines.map(boundLine);
  const trailingLines = window.trailingLines.map(boundLine);
  const lineContentTruncated = [...leadingLines, ...trailingLines].some(
    (line) => line.truncated,
  );
  const lineWindowPreview = renderLineWindow({
    leadingLines: leadingLines.map((line) => line.text),
    trailingLines: trailingLines.map((line) => line.text),
    outputLines: source.outputLines,
    omittedLines: window.omittedLines,
  });

  if (utf8Bytes(lineWindowPreview) <= MAX_PREVIEW_BYTES) {
    return {
      preview: lineWindowPreview,
      truncated: lineContentTruncated || window.omittedLines > 0,
      ...(window.omittedLines > 0 ? { omittedLines: window.omittedLines } : {}),
    };
  }

  const candidates = [...leadingLines, ...trailingLines].map((line) => line.text);
  const totalWindow = renderTotalByteWindow(candidates);
  const omittedLines = source.outputLines - totalWindow.retainedLines;

  if (utf8Bytes(totalWindow.preview) > MAX_PREVIEW_BYTES) {
    throw new Error("Bounded output preview exceeded its UTF-8 byte limit.");
  }
  if (omittedLines < 1) {
    throw new Error("Bounded output preview byte truncation omitted no lines.");
  }

  return {
    preview: totalWindow.preview,
    truncated: true,
    omittedLines,
  };
}

export function takeUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  let end = 0;
  let bytes = 0;
  for (const character of text) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    end += character.length;
  }
  return text.slice(0, end);
}

export function takeUtf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  let start = text.length;
  let bytes = 0;
  while (start > 0) {
    let characterStart = start - 1;
    const lastCodeUnit = text.charCodeAt(characterStart);
    if (
      isLowSurrogate(lastCodeUnit) &&
      characterStart > 0 &&
      isHighSurrogate(text.charCodeAt(characterStart - 1))
    ) {
      characterStart -= 1;
    }

    const character = text.slice(characterStart, start);
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    start = characterStart;
  }
  return text.slice(start);
}

function selectLineWindow(source: OutputPreviewSource): LineWindow {
  if ("lines" in source) {
    if (source.lines.length !== source.outputLines) {
      throw new Error("Complete output preview source has inconsistent line counts.");
    }
    if (source.outputLines <= MAX_PREVIEW_LINES) {
      return {
        leadingLines: source.lines,
        trailingLines: [],
        omittedLines: 0,
      };
    }

    return {
      leadingLines: source.lines.slice(0, PREVIEW_EDGE_LINES),
      trailingLines: source.lines.slice(-PREVIEW_EDGE_LINES),
      omittedLines: source.outputLines - MAX_PREVIEW_LINES,
    };
  }

  if (
    source.outputLines <= MAX_PREVIEW_LINES ||
    source.firstLines.length !== PREVIEW_EDGE_LINES ||
    source.lastLines.length !== PREVIEW_EDGE_LINES
  ) {
    throw new Error("Windowed output preview source has inconsistent line counts.");
  }

  return {
    leadingLines: source.firstLines,
    trailingLines: source.lastLines,
    omittedLines: source.outputLines - MAX_PREVIEW_LINES,
  };
}

function boundLine(text: string): BoundedLine {
  const originalBytes = utf8Bytes(text);
  if (originalBytes <= MAX_PREVIEW_LINE_BYTES) {
    return { text, truncated: false };
  }

  let omittedBytes = originalBytes;
  while (true) {
    const marker = lineByteOmissionMarker(omittedBytes);
    const remainingBytes = MAX_PREVIEW_LINE_BYTES - utf8Bytes(marker);
    const prefix = takeUtf8Prefix(text, Math.floor(remainingBytes / 2));
    const suffix = takeUtf8Suffix(
      text,
      remainingBytes - Math.floor(remainingBytes / 2),
    );
    const nextOmittedBytes = originalBytes - utf8Bytes(prefix) - utf8Bytes(suffix);

    if (nextOmittedBytes !== omittedBytes) {
      omittedBytes = nextOmittedBytes;
      continue;
    }

    const bounded = `${prefix}${marker}${suffix}`;
    if (utf8Bytes(bounded) > MAX_PREVIEW_LINE_BYTES) {
      throw new Error("Bounded output line exceeded its UTF-8 byte limit.");
    }
    return { text: bounded, truncated: true };
  }
}

function renderLineWindow(input: {
  leadingLines: readonly string[];
  trailingLines: readonly string[];
  outputLines: number;
  omittedLines: number;
}): string {
  if (input.omittedLines === 0) {
    return input.leadingLines.join("\n");
  }

  const omittedStartLine = input.leadingLines.length + 1;
  const omittedEndLine = input.outputLines - input.trailingLines.length;
  return [
    ...input.leadingLines,
    `... output omitted: lines ${omittedStartLine}-${omittedEndLine} (${input.omittedLines} ${input.omittedLines === 1 ? "line" : "lines"}). Full output is available at outputFilePath.`,
    ...input.trailingLines,
  ].join("\n");
}

function renderTotalByteWindow(lines: readonly string[]): {
  preview: string;
  retainedLines: number;
} {
  const marker = `... output omitted to fit the ${MAX_PREVIEW_BYTES}-byte preview limit. Full output is available at outputFilePath.`;
  const contentBudget = MAX_PREVIEW_BYTES - utf8Bytes(marker) - 2;
  const leadingBudget = Math.floor(contentBudget / 2);
  const trailingBudget = contentBudget - leadingBudget;
  const leadingCount = countLeadingLinesWithin(lines, leadingBudget);
  const trailingCount = countTrailingLinesWithin(lines, trailingBudget, leadingCount);

  return {
    preview: [
      ...lines.slice(0, leadingCount),
      marker,
      ...lines.slice(lines.length - trailingCount),
    ].join("\n"),
    retainedLines: leadingCount + trailingCount,
  };
}

function countLeadingLinesWithin(lines: readonly string[], maxBytes: number): number {
  let count = 0;
  let bytes = 0;
  for (const line of lines) {
    const nextBytes = utf8Bytes(line) + (count === 0 ? 0 : 1);
    if (bytes + nextBytes > maxBytes) {
      break;
    }
    bytes += nextBytes;
    count += 1;
  }
  return count;
}

function countTrailingLinesWithin(
  lines: readonly string[],
  maxBytes: number,
  leadingCount: number,
): number {
  let count = 0;
  let bytes = 0;
  for (let index = lines.length - 1; index >= leadingCount; index -= 1) {
    const nextBytes = utf8Bytes(lines[index] ?? "") + (count === 0 ? 0 : 1);
    if (bytes + nextBytes > maxBytes) {
      break;
    }
    bytes += nextBytes;
    count += 1;
  }
  return count;
}

function lineByteOmissionMarker(omittedBytes: number): string {
  return `... ${omittedBytes} UTF-8 bytes omitted from this line ...`;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
