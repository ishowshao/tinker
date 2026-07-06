import path from "node:path";
import { Box, Text } from "ink";

export type HeaderProps = {
  modelName: string;
  workspaceRoot: string;
  runId: string;
};

export function Header(props: HeaderProps) {
  return (
    <Box flexDirection="column">
      <Text bold>Tinker</Text>
      <Text color="gray">
        model={props.modelName} workspace={path.basename(props.workspaceRoot)} run=
        {props.runId}
      </Text>
    </Box>
  );
}
