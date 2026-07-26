import {
  Box,
  Text,
  useBoxMetrics,
  useInput,
  useWindowSize,
  type DOMElement,
} from "ink";
import { useRef, useState } from "react";
import type { StoredMemorySummary } from "../../memory/contracts";

const BROWSER_CHROME_ROWS = 3;

export type MemoryBrowserProps = {
  readonly memories: readonly StoredMemorySummary[];
  readonly onClose: () => void;
  readonly viewportRows?: number;
  readonly viewportColumns?: number;
};

export function MemoryBrowser(props: MemoryBrowserProps) {
  const windowSize = useWindowSize();
  const rows = Math.max(4, props.viewportRows ?? windowSize.rows);
  const columns = Math.max(20, props.viewportColumns ?? windowSize.columns);
  const bodyRows = Math.max(1, rows - BROWSER_CHROME_ROWS);
  const contentRef = useRef<DOMElement>(null);
  const { height: measuredContentRows, hasMeasured } = useBoxMetrics(contentRef);
  const totalLines = props.memories.length === 0 ? 0 : measuredContentRows;
  const maxTopLine = Math.max(0, totalLines - bodyRows);
  const [topLine, setTopLine] = useState(0);
  const visibleTopLine = clamp(topLine, 0, maxTopLine);
  const visibleEnd = Math.min(totalLines, visibleTopLine + bodyRows);

  useInput((input, key) => {
    if (key.escape) {
      props.onClose();
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
    const direction =
      key.upArrow || (input === "k" && !key.ctrl && !key.meta)
        ? -1
        : key.downArrow || (input === "j" && !key.ctrl && !key.meta)
          ? 1
          : 0;
    if (direction !== 0) {
      setTopLine((current) => clamp(current + direction, 0, maxTopLine));
    }
  });

  return (
    <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
      <Text bold>Global memory</Text>
      <Text dimColor wrap="truncate-end">
        ↑/↓ or j/k · PgUp/PgDn · Home/End · Esc close
      </Text>
      <Box
        height={bodyRows}
        width={columns}
        position="relative"
        overflow="hidden"
        flexDirection="column"
      >
        {props.memories.length === 0 ? (
          <Text dimColor>No stored memories.</Text>
        ) : (
          <Box
            ref={contentRef}
            position="absolute"
            top={-visibleTopLine}
            width={columns}
            flexDirection="column"
          >
            {props.memories.map((memory, index) => (
              <Box
                key={memory.memoryId}
                flexDirection="column"
                marginBottom={index === props.memories.length - 1 ? 0 : 1}
              >
                <Text dimColor wrap="truncate-middle">
                  {formatMemoryCreatedAt(memory.createdAt)} · {memory.sourceWorkspace}
                </Text>
                <Text>{normalizeMemoryDisplayText(memory.text)}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
      <Text dimColor wrap="truncate-end">
        {props.memories.length === 0
          ? "0 memories"
          : memoryBrowserStatus(
              visibleTopLine,
              visibleEnd,
              hasMeasured ? totalLines : 0,
              props.memories.length,
            )}
      </Text>
    </Box>
  );
}

export function normalizeMemoryDisplayText(text: string): string {
  return (
    text
      .replaceAll(/\r\n?/g, "\n")
      .replaceAll("\t", "    ")
      // eslint-disable-next-line no-control-regex
      .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "\uFFFD")
  );
}

export function formatMemoryCreatedAt(createdAt: string): string {
  const date = new Date(createdAt);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function memoryBrowserStatus(
  topLine: number,
  endLine: number,
  totalLines: number,
  memoryCount: number,
): string {
  if (totalLines === 0) {
    return `0 lines · ${memoryCount} ${memoryCount === 1 ? "memory" : "memories"}`;
  }
  return `${topLine + 1}–${endLine} / ${totalLines} lines · ${memoryCount} ${
    memoryCount === 1 ? "memory" : "memories"
  }`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
