import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";

export type AskUserProps = {
  question: string;
  title?: string;
  dismissLabel?: string;
  options: readonly { readonly description: string }[];
  onSelect(selectedIndex: number): void;
  onDismiss(): void;
};

export function AskUser(props: AskUserProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selection = useRef(0);
  const moveSelection = (offset: number) => {
    selection.current =
      (selection.current + offset + props.options.length) % props.options.length;
    setSelectedIndex(selection.current);
  };

  useInput((input, key) => {
    if (key.escape) {
      props.onDismiss();
      return;
    }
    if (key.upArrow) {
      moveSelection(-1);
      return;
    }
    if (key.downArrow) {
      moveSelection(1);
      return;
    }
    if (key.return) {
      props.onSelect(selection.current);
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
        {props.title ?? "Tinker asks"}
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
        ↑/↓ select · 1-{props.options.length} choose · Enter confirm · Esc{" "}
        {props.dismissLabel ?? "skip"}
      </Text>
    </Box>
  );
}
