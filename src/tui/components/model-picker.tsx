import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ModelProfile } from "../../cli/model-profiles";

export type ModelPickerProps = {
  profiles: readonly ModelProfile[];
  currentProfileName?: string;
  isSwitching?: boolean;
  error?: string;
  onCancel: () => void;
  onSelect: (profile: ModelProfile) => void;
};

export function ModelPicker(props: ModelPickerProps) {
  if (props.profiles.length === 0) {
    throw new Error("ModelPicker requires at least one profile.");
  }

  return <ModelPickerContent {...props} />;
}

function ModelPickerContent(props: ModelPickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(() =>
    initialSelectedIndex(props.profiles, props.currentProfileName),
  );

  useInput(
    (input, key) => {
      if (props.isSwitching === true) {
        return;
      }

      if (key.escape) {
        props.onCancel();
        return;
      }

      if (key.return) {
        const selected = props.profiles[selectedIndex];
        if (selected !== undefined) {
          props.onSelect(selected);
        }
        return;
      }

      const direction =
        key.upArrow || (input === "k" && !key.ctrl && !key.meta)
          ? -1
          : key.downArrow || (input === "j" && !key.ctrl && !key.meta)
            ? 1
            : 0;
      if (direction === 0) {
        return;
      }

      setSelectedIndex((current) =>
        clamp(current + direction, 0, props.profiles.length - 1),
      );
    },
    { isActive: props.isSwitching !== true },
  );

  return (
    <Box flexDirection="column">
      <Text bold>Switch model profile</Text>
      <Text dimColor>
        {props.isSwitching === true
          ? "Switching…"
          : "↑/↓ or j/k to move · Enter to select · Esc to cancel"}
      </Text>
      {props.profiles.map((profile, index) => (
        <ProfileOption
          key={profile.name}
          profile={profile}
          isSelected={index === selectedIndex}
          isCurrent={profile.name === props.currentProfileName}
        />
      ))}
      {props.error === undefined ? null : (
        <Text color="red" wrap="truncate-end">
          Switch failed: {props.error}
        </Text>
      )}
      <Text dimColor>
        Switching creates a new session; the current session is preserved.
      </Text>
    </Box>
  );
}

function ProfileOption(props: {
  profile: ModelProfile;
  isSelected: boolean;
  isCurrent: boolean;
}) {
  const marker = props.isSelected ? "❯ " : "  ";

  return (
    <Box flexDirection="column">
      <Text
        color={props.isSelected ? "cyan" : undefined}
        bold={props.isSelected}
        wrap="truncate-end"
      >
        {marker}
        {props.profile.name}
        {props.isCurrent ? " (current)" : ""}
      </Text>
      <Box marginLeft={2} overflow="hidden">
        <Text dimColor wrap="truncate-end">
          {props.profile.model} · {formatTokenCount(props.profile.contextWindowTokens)}{" "}
          context · {formatTokenCount(props.profile.maxSupportedOutputTokens)} output
        </Text>
      </Box>
    </Box>
  );
}

function initialSelectedIndex(
  profiles: readonly ModelProfile[],
  currentProfileName?: string,
): number {
  if (currentProfileName === undefined) {
    return 0;
  }
  const index = profiles.findIndex((p) => p.name === currentProfileName);
  return index === -1 ? 0 : index;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_048_576) {
    return `${(tokens / 1_048_576).toFixed(0)}M`;
  }
  if (tokens >= 1_024) {
    return `${(tokens / 1_024).toFixed(0)}K`;
  }
  return String(tokens);
}
