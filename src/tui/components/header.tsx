import path from "node:path";
import { Box, Text } from "ink";
import type { SessionId } from "../../ids/runtime-id";

export type HeaderProps = {
  modelName: string;
  workspaceRoot: string;
  sessionId: SessionId;
};

export function Header(props: HeaderProps) {
  return (
    <Box flexDirection="column">
      <Text bold>Tinker</Text>
      <Text color="gray">
        model={props.modelName} workspace={path.basename(props.workspaceRoot)} session=
        {props.sessionId}
      </Text>
    </Box>
  );
}
