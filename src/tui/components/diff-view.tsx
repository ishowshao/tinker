import { Box, Text } from "ink";
import type { DiffHunk } from "../../tools/types";

export type DiffViewProps = {
  hunks: DiffHunk[];
  truncated?: boolean;
  maxLines?: number;
};

const DEFAULT_MAX_LINES = 20;

type DiffRow =
  | {
      kind: "add" | "remove" | "context";
      lineNumber: number;
      text: string;
    }
  | { kind: "separator" };

export function DiffView(props: DiffViewProps) {
  const maxLines = props.maxLines ?? DEFAULT_MAX_LINES;
  const rows = diffRows(props.hunks);
  const contentRowCount = rows.filter((row) => row.kind !== "separator").length;
  const visibleRows = takeContentRows(rows, maxLines);
  const hiddenLines = contentRowCount - maxLines;
  const gutterWidth = gutterWidthFor(props.hunks);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {visibleRows.map((row, index) => renderDiffRow(row, index, gutterWidth))}
      {hiddenLines > 0 ? (
        <Text color="gray">
          {" ".repeat(gutterWidth)} … +{hiddenLines} more line
          {hiddenLines === 1 ? "" : "s"}
        </Text>
      ) : null}
      {props.truncated === true && hiddenLines <= 0 ? (
        <Text color="gray">{" ".repeat(gutterWidth)} … diff truncated</Text>
      ) : null}
    </Box>
  );
}

function diffRows(hunks: DiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];

  hunks.forEach((hunk, hunkIndex) => {
    if (hunkIndex > 0) {
      rows.push({ kind: "separator" });
    }

    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const line of hunk.lines) {
      const text = expandTabs(line.slice(1));

      if (line.startsWith("+")) {
        rows.push({ kind: "add", lineNumber: newLine, text });
        newLine += 1;
      } else if (line.startsWith("-")) {
        rows.push({ kind: "remove", lineNumber: oldLine, text });
        oldLine += 1;
      } else {
        rows.push({ kind: "context", lineNumber: newLine, text });
        oldLine += 1;
        newLine += 1;
      }
    }
  });

  return rows;
}

function takeContentRows(rows: DiffRow[], maxLines: number): DiffRow[] {
  const visible: DiffRow[] = [];
  let shown = 0;

  for (const row of rows) {
    if (row.kind === "separator") {
      visible.push(row);
      continue;
    }

    if (shown >= maxLines) {
      break;
    }

    visible.push(row);
    shown += 1;
  }

  while (visible.length > 0 && visible[visible.length - 1]?.kind === "separator") {
    visible.pop();
  }

  return visible;
}

function renderDiffRow(row: DiffRow, index: number, gutterWidth: number) {
  if (row.kind === "separator") {
    return (
      <Text key={index} color="gray">
        {" ".repeat(gutterWidth)} ···
      </Text>
    );
  }

  const gutter = String(row.lineNumber).padStart(gutterWidth);
  const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
  const color = colorForRow(row.kind);

  return (
    <Text key={index} wrap="truncate-end">
      <Text color="gray">{gutter} </Text>
      <Text color={color}>
        {sign} {row.text}
      </Text>
    </Text>
  );
}

function colorForRow(kind: "add" | "remove" | "context"): string {
  if (kind === "add") {
    return "green";
  }

  if (kind === "remove") {
    return "red";
  }

  return "gray";
}

function gutterWidthFor(hunks: DiffHunk[]): number {
  let maxLineNumber = 1;

  for (const hunk of hunks) {
    maxLineNumber = Math.max(
      maxLineNumber,
      hunk.oldStart + hunk.oldLines,
      hunk.newStart + hunk.newLines,
    );
  }

  return String(maxLineNumber).length;
}

function expandTabs(text: string): string {
  return text.replaceAll("\t", "  ");
}
