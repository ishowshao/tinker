import { Box, Text } from "ink";
import type { BashDisplayDetail } from "../../events/bash-result-detail";

export type BashResultViewProps = {
  detail: BashDisplayDetail;
  maxCommandLines?: number;
};

const DEFAULT_MAX_COMMAND_LINES = 2;

export function BashResultView(props: BashResultViewProps) {
  const maxCommandLines = props.maxCommandLines ?? DEFAULT_MAX_COMMAND_LINES;
  const commandLines = props.detail.command.split("\n");
  const visibleCommandLines = commandLines.slice(0, maxCommandLines);
  const hiddenCommandLines = commandLines.length - visibleCommandLines.length;
  const outputLines = props.detail.outputPreview ?? [];
  const omittedLines = props.detail.omittedOutputLines ?? 0;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {visibleCommandLines.map((line, index) => (
        <Text key={`command-${index}`} color="cyan" wrap="truncate-end">
          {index === 0 ? "$ " : "  "}
          {line}
        </Text>
      ))}
      {hiddenCommandLines > 0 ? (
        <Text color="cyan">
          {"  "}… +{hiddenCommandLines} more line{hiddenCommandLines === 1 ? "" : "s"}
        </Text>
      ) : null}
      {outputLines.map((line, index) => (
        <Text key={`output-${index}`} color="gray" wrap="truncate-end">
          {line === "" ? " " : line}
        </Text>
      ))}
      {omittedLines > 0 ? (
        <Text color="gray">
          … +{omittedLines} line{omittedLines === 1 ? "" : "s"}
          {props.detail.outputFilePath === undefined
            ? ""
            : ` (full output: ${props.detail.outputFilePath})`}
        </Text>
      ) : null}
    </Box>
  );
}
