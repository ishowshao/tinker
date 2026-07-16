import { Box, Text, useInput, useStdout, useWindowSize } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { ViewFile } from "../view-file";

const VIEWER_CHROME_ROWS = 3;
const HORIZONTAL_SCROLL_COLUMNS = 8;
const MOUSE_SCROLL_LINES = 3;
const ENABLE_MOUSE = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1000l";

export type FileViewerProps = {
  file: ViewFile;
  onClose: () => void;
  viewportRows?: number;
  viewportColumns?: number;
};

export function FileViewer(props: FileViewerProps) {
  const windowSize = useWindowSize();
  const { stdout } = useStdout();
  const rows = Math.max(4, props.viewportRows ?? windowSize.rows);
  const columns = Math.max(20, props.viewportColumns ?? windowSize.columns);
  const bodyRows = Math.max(1, rows - VIEWER_CHROME_ROWS);
  const normalizedLines = useMemo(
    () => props.file.lines.map((line) => line.replaceAll("\t", "    ")),
    [props.file.lines],
  );
  const totalLines = normalizedLines.length;
  const lineNumberWidth = String(Math.max(1, totalLines)).length;
  const contentWidth = Math.max(1, columns - lineNumberWidth - 3);
  const maxLineWidth = useMemo(
    () =>
      normalizedLines.reduce(
        (maximum, line) => Math.max(maximum, Bun.stringWidth(line)),
        0,
      ),
    [normalizedLines],
  );
  const maxTopLine = Math.max(0, totalLines - bodyRows);
  const maxHorizontalOffset = Math.max(0, maxLineWidth - contentWidth);
  const [topLine, setTopLine] = useState(0);
  const [horizontalOffset, setHorizontalOffset] = useState(0);
  const visibleTopLine = clamp(topLine, 0, maxTopLine);
  const visibleHorizontalOffset = clamp(horizontalOffset, 0, maxHorizontalOffset);
  const visibleEnd = Math.min(totalLines, visibleTopLine + bodyRows);

  useEffect(() => {
    if (!stdout.isTTY) {
      return;
    }
    stdout.write(ENABLE_MOUSE);
    return () => {
      stdout.write(DISABLE_MOUSE);
    };
  }, [stdout]);

  useInput((input, key) => {
    if (key.escape) {
      props.onClose();
      return;
    }

    const mouseDirection = parseMouseWheelInput(input);
    if (mouseDirection !== 0) {
      setTopLine((current) =>
        clamp(current + mouseDirection * MOUSE_SCROLL_LINES, 0, maxTopLine),
      );
      return;
    }

    if (key.home) {
      setTopLine(0);
      return;
    }
    if (key.end) {
      setTopLine(maxTopLine);
      return;
    }
    if (key.pageUp || key.pageDown) {
      const direction = key.pageUp ? -1 : 1;
      setTopLine((current) => clamp(current + direction * bodyRows, 0, maxTopLine));
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const direction = key.leftArrow ? -1 : 1;
      setHorizontalOffset((current) =>
        clamp(current + direction * HORIZONTAL_SCROLL_COLUMNS, 0, maxHorizontalOffset),
      );
      return;
    }

    const verticalDirection =
      key.upArrow || (input === "k" && !key.ctrl && !key.meta)
        ? -1
        : key.downArrow || (input === "j" && !key.ctrl && !key.meta)
          ? 1
          : 0;
    if (verticalDirection !== 0) {
      setTopLine((current) => clamp(current + verticalDirection, 0, maxTopLine));
    }
  });

  return (
    <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
      <Text bold wrap="truncate-middle">
        View: {props.file.displayPath}
      </Text>
      <Text dimColor wrap="truncate-end">
        ↑/↓ or j/k · PgUp/PgDn · Home/End · ←/→ · mouse wheel · Esc close
      </Text>
      <Box height={bodyRows} flexDirection="column" overflow="hidden">
        {totalLines === 0 ? (
          <Text dimColor>(empty file)</Text>
        ) : (
          normalizedLines.slice(visibleTopLine, visibleEnd).map((line, index) => {
            const lineNumber = visibleTopLine + index + 1;
            return (
              <Box key={lineNumber} width={columns} overflow="hidden">
                <Text
                  dimColor
                >{`${String(lineNumber).padStart(lineNumberWidth)} │ `}</Text>
                <Text wrap="truncate-end">
                  {sliceByColumns(line, visibleHorizontalOffset, contentWidth)}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
      <Text dimColor wrap="truncate-end">
        {viewerStatus(visibleTopLine, visibleEnd, totalLines, visibleHorizontalOffset)}
      </Text>
    </Box>
  );
}

export function FileViewerLoading(props: {
  filePath: string;
  onCancel: () => void;
  viewportRows?: number;
  viewportColumns?: number;
}) {
  const windowSize = useWindowSize();
  const rows = Math.max(4, props.viewportRows ?? windowSize.rows);
  const columns = Math.max(20, props.viewportColumns ?? windowSize.columns);

  useInput((_input, key) => {
    if (key.escape) {
      props.onCancel();
    }
  });

  return (
    <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
      <Text bold wrap="truncate-middle">
        View: {props.filePath}
      </Text>
      <Text dimColor>Loading and validating UTF-8 text… · Esc cancel</Text>
    </Box>
  );
}

export function parseMouseWheelInput(input: string): -1 | 0 | 1 {
  const normalized = input.startsWith("\u001b") ? input.slice(1) : input;
  const match = /^\[<(\d+);\d+;\d+M$/.exec(normalized);
  if (match === null) {
    return 0;
  }

  const button = Number(match[1]);
  if ((button & 64) === 0) {
    return 0;
  }
  return (button & 1) === 0 ? -1 : 1;
}

function viewerStatus(
  topLine: number,
  endLine: number,
  totalLines: number,
  horizontalOffset: number,
): string {
  if (totalLines === 0) {
    return "0 lines · 0 bytes";
  }
  const percentage = Math.floor((endLine / totalLines) * 100);
  const horizontal = horizontalOffset === 0 ? "" : ` · column ${horizontalOffset + 1}`;
  return `${topLine + 1}–${endLine} / ${totalLines} · ${percentage}%${horizontal}`;
}

function sliceByColumns(value: string, start: number, width: number): string {
  let currentColumn = 0;
  let result = "";

  for (const character of value) {
    const characterWidth = Bun.stringWidth(character);
    const nextColumn = currentColumn + characterWidth;
    if (nextColumn > start && currentColumn < start + width) {
      result += character;
    }
    currentColumn = nextColumn;
    if (currentColumn >= start + width) {
      break;
    }
  }

  return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
