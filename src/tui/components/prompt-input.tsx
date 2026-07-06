import { Box, Text } from "ink";
import { TextInput } from "@inkjs/ui";

export type PromptInputProps = {
  isDisabled?: boolean;
  placeholder?: string;
  onSubmit: (value: string) => void;
};

export function PromptInput(props: PromptInputProps) {
  return (
    <Box>
      <Text>Input: </Text>
      <TextInput
        isDisabled={props.isDisabled}
        placeholder={props.placeholder}
        onSubmit={props.onSubmit}
      />
    </Box>
  );
}
