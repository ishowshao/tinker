import { Box, Text, useInput } from "ink";

export type BashConfirmationProps = {
  command: string;
  reason: string;
  onDecision(decision: "allow" | "deny"): void;
};

export function BashConfirmation(props: BashConfirmationProps) {
  useInput((input) => {
    const normalized = input.toLowerCase();
    if (normalized === "y") {
      props.onDecision("allow");
    } else if (normalized === "n") {
      props.onDecision("deny");
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">Dangerous Bash command</Text>
      <Text>{props.command}</Text>
      <Text dimColor>{props.reason}</Text>
      <Text>y allow / n deny / Esc cancel turn</Text>
    </Box>
  );
}
