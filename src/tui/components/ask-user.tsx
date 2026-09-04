import { Box, Text, useInput } from "ink";
import { useState } from "react";

export type AskUserProps = {
  question: string;
  options: readonly { readonly description: string }[];
  onSelect(selectedIndex: number): void;
  onDismiss(): void;
};

export function AskUser(props: AskUserProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      props.onDismiss();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((current) =>
        current === 0 ? props.options.length - 1 : current - 1,
      );
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((current) => (current + 1) % props.options.length);
      return;
    }
    if (key.return) {
      props.onSelect(selectedIndex);
      return;
    }
    if (/^[1-6]$/.test(input)) {
      const index = Number(input) - 1;
      if (index < props.options.length) {
        props.onSelect(index);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        Tinker asks
      </Text>
      <Text>{props.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {props.options.map((option, index) => (
          <Text key={`${index}:${option.description}`}>
            <Text color={index === selectedIndex ? "cyan" : undefined}>
              {index === selectedIndex ? "❯" : " "} {index + 1}. {option.description}
            </Text>
          </Text>
        ))}
      </Box>
      <Text dimColor>
        ↑/↓ select · 1-{props.options.length} choose · Enter confirm · Esc skip
      </Text>
    </Box>
  );
}
