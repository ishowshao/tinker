export type SlashCommand = {
  name: string;
  description: string;
};

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "status", description: "Show session and context details" },
  { name: "quit", description: "Exit the TUI" },
];

export function matchSlashCommands(
  input: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  if (!input.startsWith("/")) {
    return [];
  }

  const query = input.slice(1);
  if (/\s/.test(query)) {
    return [];
  }

  return commands.filter((command) => command.name.startsWith(query));
}

export function findSlashCommand(
  input: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand | undefined {
  if (!input.startsWith("/")) {
    return undefined;
  }

  const [name = ""] = input.slice(1).split(/\s+/, 1);
  return commands.find((command) => command.name === name);
}
