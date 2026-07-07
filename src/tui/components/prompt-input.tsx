import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useState } from "react";

export type PromptInputProps = {
  isDisabled?: boolean;
  placeholder?: string;
  onSubmit: (value: string) => void;
};

export function PromptInput(props: PromptInputProps) {
  const [value, setValue] = useState("");
  const [inputVersion, setInputVersion] = useState(0);

  useInput(
    (input, key) => {
      if (key.return) {
        return;
      }

      const lineBreakIndex = firstLineBreakIndex(input);
      if (lineBreakIndex !== undefined) {
        const submittedValue = value + input.slice(0, lineBreakIndex);
        props.onSubmit(submittedValue);
        setValue("");
        setInputVersion((current) => current + 1);
      }
    },
    { isActive: !props.isDisabled },
  );

  return (
    <Box>
      <Text>Input: </Text>
      <TextInput
        key={inputVersion}
        isDisabled={props.isDisabled}
        placeholder={props.placeholder}
        onChange={setValue}
        onSubmit={(submittedValue) => {
          props.onSubmit(submittedValue);
          setValue("");
          setInputVersion((current) => current + 1);
        }}
      />
    </Box>
  );
}

function firstLineBreakIndex(value: string): number | undefined {
  const carriageReturn = value.indexOf("\r");
  const lineFeed = value.indexOf("\n");

  if (carriageReturn === -1) {
    return lineFeed === -1 ? undefined : lineFeed;
  }

  if (lineFeed === -1) {
    return carriageReturn;
  }

  return Math.min(carriageReturn, lineFeed);
}
